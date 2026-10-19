'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

function createPlatform({ app, express, bcrypt, jwt, tenantALS, makeTenantPool, initializeTenant, publicDir }) {
  const controlUrl = process.env.CONTROL_DATABASE_URL;
  if (!controlUrl) throw new Error('CONTROL_DATABASE_URL is required for the O\'LIVE TECH multi-school platform.');
  const controlPool = new Pool({ connectionString: controlUrl, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 5 });
  const tenantPools = new Map();
  const provisioning = new Set();
  const BRAND = "O'LIVE TECH";
  const support = { name: BRAND, phone: process.env.OLIVE_TECH_PHONE || '', email: process.env.OLIVE_TECH_EMAIL || '', website: process.env.OLIVE_TECH_WEBSITE || '' };

  const sql = `
    CREATE TABLE IF NOT EXISTS platform_schools (
      id BIGSERIAL PRIMARY KEY, school_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
      school_name TEXT NOT NULL, school_type TEXT, address TEXT, phone TEXT, email TEXT, motto TEXT, school_payment_number TEXT,
      logo_url TEXT, principal_name TEXT, admin_username TEXT NOT NULL, admin_password_hash TEXT NOT NULL,
      database_name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pending_payment','active','suspended','rejected')),
      subscription_expires_at TIMESTAMPTZ, approved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), suspended_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS platform_payments (
      id BIGSERIAL PRIMARY KEY, school_id TEXT NOT NULL REFERENCES platform_schools(school_id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL, payer_phone TEXT NOT NULL, mpesa_receipt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ, reviewed_by TEXT, review_note TEXT,
      UNIQUE(mpesa_receipt)
    );
    CREATE TABLE IF NOT EXISTS platform_admin_audit (
      id BIGSERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, school_id TEXT, details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE platform_schools ADD COLUMN IF NOT EXISTS school_payment_number TEXT;
    CREATE INDEX IF NOT EXISTS idx_platform_schools_status ON platform_schools(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_payments_status ON platform_payments(status, submitted_at DESC);
  `;
  const ready = (async () => { for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await controlPool.query(statement); })();

  function cleanSlug(v) {
    return String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'school';
  }
  function makeSchoolId() { return 'OLV-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
  function adminTelegramAllowed() {
    return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.SUPER_ADMIN_TELEGRAM_ID && /^\d+$/.test(String(process.env.SUPER_ADMIN_TELEGRAM_ID)));
  }
  async function audit(actor, action, schoolId, details='') {
    await controlPool.query('INSERT INTO platform_admin_audit(actor,action,school_id,details) VALUES($1,$2,$3,$4)', [String(actor), action, schoolId || null, String(details).slice(0,1000)]);
  }
  async function getSchool(schoolId) {
    if (!schoolId) return null;
    return (await controlPool.query('SELECT * FROM platform_schools WHERE UPPER(school_id)=UPPER($1) OR LOWER(slug)=LOWER($1) LIMIT 1', [String(schoolId).trim()])).rows[0] || null;
  }
  async function getTenantPool(school) {
    if (tenantPools.has(school.school_id)) return tenantPools.get(school.school_id);
    const p = await getTenantPoolFromServer(school);
    tenantPools.set(school.school_id, p);
    return p;
  }
  async function getTenantPoolFromServer(school) {
    const p = await makeTenantPool(school.database_name, school);
    return p;
  }
  async function provisionSchool(school) {
    if (provisioning.has(school.school_id)) throw new Error('Provisioning is already in progress for this school.');
    provisioning.add(school.school_id);
    try {
      const tenantPool = await getTenantPoolFromServer(school);
      await initializeTenant(tenantPool, school);
      const exists = await tenantPool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1', [school.admin_username]);
      if (!exists.rows[0]) {
        await tenantPool.query('INSERT INTO users(username,password_hash,full_name,role,phone,email) VALUES($1,$2,$3,$4,$5,$6)',
          [school.admin_username, school.admin_password_hash, school.principal_name || (school.school_name + ' Administrator'), 'admin', school.phone || null, school.email || null]);
      }
      return true;
    } finally { provisioning.delete(school.school_id); }
  }
  async function activate(schoolId, days, actor='telegram') {
    const school = await getSchool(schoolId);
    if (!school) throw new Error('School ID not found.');
    if (school.status === 'pending' || school.status === 'rejected') throw new Error('Approve the school first using /approve ' + school.school_id);
    const duration = Math.max(1, Math.min(3650, Number(days) || 30));
    const base = school.subscription_expires_at && new Date(school.subscription_expires_at) > new Date() ? new Date(school.subscription_expires_at) : new Date();
    base.setDate(base.getDate() + duration);
    await controlPool.query("UPDATE platform_schools SET status='active',subscription_expires_at=$2,updated_at=NOW(),suspended_reason=NULL WHERE school_id=$1", [school.school_id, base.toISOString()]);
    await controlPool.query("UPDATE platform_payments SET status='confirmed',reviewed_at=NOW(),reviewed_by=$2 WHERE school_id=$1 AND status='pending'", [school.school_id, actor]);
    await audit(actor, 'ACTIVATE_OR_RENEW', school.school_id, `days=${duration}; until=${base.toISOString()}`);
    return { ...school, status: 'active', subscription_expires_at: base.toISOString() };
  }
  async function approve(schoolId, actor='telegram') {
    let school = await getSchool(schoolId);
    if (!school) throw new Error('School ID not found.');
    if (school.status === 'rejected') throw new Error('This school was rejected. Contact support before reopening it.');
    if (school.status === 'pending') {
      await provisionSchool(school);
      const r = await controlPool.query("UPDATE platform_schools SET status='pending_payment',approved_at=NOW(),updated_at=NOW() WHERE school_id=$1 RETURNING *", [school.school_id]);
      school = r.rows[0];
    }
    await audit(actor, 'APPROVE_SCHOOL', school.school_id, 'Database provisioned; waiting for manual M-Pesa confirmation and activation.');
    return school;
  }
  async function suspend(schoolId, reason='Subscription suspended by O\'LIVE TECH Super Admin', actor='telegram') {
    const school = await getSchool(schoolId); if (!school) throw new Error('School ID not found.');
    await controlPool.query("UPDATE platform_schools SET status='suspended',suspended_reason=$2,updated_at=NOW() WHERE school_id=$1", [school.school_id, String(reason).slice(0,500)]);
    await audit(actor, 'SUSPEND_SCHOOL', school.school_id, reason); return school;
  }
  async function schoolSummary(s) {
    return { school_id:s.school_id, school_name:s.school_name, status:s.status, phone:s.phone, email:s.email, created_at:s.created_at, subscription_expires_at:s.subscription_expires_at, database_name:s.database_name };
  }
  async function telegram(method, body={}) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    const data = await response.json(); if (!data.ok) throw new Error(data.description || 'Telegram API error'); return data.result;
  }
  async function sendTelegram(chatId, text) { return telegram('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }); }
  async function handleTelegramCommand(message) {
    const chatId = message.chat?.id;
    const fromId = String(message.from?.id || '');
    if (fromId !== String(process.env.SUPER_ADMIN_TELEGRAM_ID || '') || String(chatId) !== String(process.env.SUPER_ADMIN_TELEGRAM_ID || '')) {
      if (chatId) await sendTelegram(chatId, 'Access denied. This bot is restricted to the authorized O\'LIVE TECH Super Admin.');
      return;
    }
    const raw = String(message.text || '').trim(); if (!raw.startsWith('/')) return;
    const [command, ...args] = raw.split(/\s+/); const cmd = command.split('@')[0].toLowerCase();
    try {
      if (cmd === '/start' || cmd === '/help') return sendTelegram(chatId,
        "O'LIVE TECH — School Platform Control\n\n/schools — list schools\n/approve SCHOOLID — approve and provision database\n/activate SCHOOLID DAYS — activate/renew after M-Pesa confirmation\n/suspend SCHOOLID reason — suspend school\n/reject SCHOOLID reason — reject pending registration\n/schoolinfo SCHOOLID — school details\n/admins SCHOOLID — list school administrators\n/assignadmin SCHOOLID username|Full Name|phone — create admin\n/deactivateadmin SCHOOLID username — disable admin\n/activateadmin SCHOOLID username — re-enable admin\n/payments — pending M-Pesa receipts\n/confirm SCHOOLID RECEIPT DAYS — confirm receipt and activate/renew\n\nRegistration is pending until you approve it. Manual M-Pesa verification is required before activation.");
      if (cmd === '/schools') {
        const rows = (await controlPool.query('SELECT school_id,school_name,status,subscription_expires_at FROM platform_schools ORDER BY created_at DESC LIMIT 80')).rows;
        return sendTelegram(chatId, rows.length ? rows.map(s => `${s.school_id} | ${s.school_name} | ${s.status}${s.subscription_expires_at ? ' | expires '+new Date(s.subscription_expires_at).toLocaleDateString('en-GB') : ''}`).join('\n') : 'No school registrations yet.');
      }
      if (cmd === '/approve') { if (!args[0]) return sendTelegram(chatId,'Usage: /approve SCHOOLID'); const s=await approve(args[0],fromId); return sendTelegram(chatId,`Approved ${s.school_name} (${s.school_id}). Its separate database is provisioned. Status: pending_payment. Verify the M-Pesa receipt, then use /activate ${s.school_id} 30 or /confirm.`); }
      if (cmd === '/activate') { if (!args[0]) return sendTelegram(chatId,'Usage: /activate SCHOOLID DAYS'); const s=await activate(args[0],args[1]||30,fromId); return sendTelegram(chatId,`Activated ${s.school_name} (${s.school_id}) until ${new Date(s.subscription_expires_at).toLocaleString('en-GB')}.`); }
      if (cmd === '/suspend') { if (!args[0]) return sendTelegram(chatId,'Usage: /suspend SCHOOLID reason'); const s=await suspend(args[0],args.slice(1).join(' ')||'Unpaid subscription',fromId); return sendTelegram(chatId,`Suspended ${s.school_name} (${s.school_id}).`); }
      if (cmd === '/reject') { if (!args[0]) return sendTelegram(chatId,'Usage: /reject SCHOOLID reason'); const s=await getSchool(args[0]); if(!s)throw new Error('School ID not found.'); await controlPool.query("UPDATE platform_schools SET status='rejected',updated_at=NOW() WHERE school_id=$1",[s.school_id]); await audit(fromId,'REJECT_SCHOOL',s.school_id,args.slice(1).join(' ')); return sendTelegram(chatId,`Rejected registration ${s.school_name} (${s.school_id}).`); }
      if (cmd === '/schoolinfo') { const s=await getSchool(args[0]); if(!s)throw new Error('School ID not found.'); return sendTelegram(chatId,`School: ${s.school_name}\nID: ${s.school_id}\nStatus: ${s.status}\nAdmin: ${s.admin_username}\nPhone: ${s.phone||'-'}\nEmail: ${s.email||'-'}\nDB: ${s.database_name}\nExpiry: ${s.subscription_expires_at||'not active'}`); }
      if (cmd === '/payments') { const rows=(await controlPool.query("SELECT p.school_id,s.school_name,p.amount,p.payer_phone,p.mpesa_receipt,p.submitted_at FROM platform_payments p JOIN platform_schools s USING(school_id) WHERE p.status='pending' ORDER BY p.submitted_at DESC LIMIT 30")).rows; return sendTelegram(chatId, rows.length?rows.map(p=>`${p.school_id} | ${p.school_name} | KSh ${p.amount} | ${p.payer_phone} | ${p.mpesa_receipt}`).join('\n'):'No pending M-Pesa receipts.'); }
      if (cmd === '/confirm') { if(args.length<3) return sendTelegram(chatId,'Usage: /confirm SCHOOLID M-PESA-RECEIPT DAYS'); const s=await getSchool(args[0]); if(!s)throw new Error('School ID not found.'); const p=(await controlPool.query("UPDATE platform_payments SET status='confirmed',reviewed_at=NOW(),reviewed_by=$3 WHERE school_id=$1 AND mpesa_receipt=$2 AND status='pending' RETURNING id",[s.school_id,args[1],fromId])).rows[0]; if(!p)throw new Error('Pending receipt not found for this school. Check the receipt before activation.'); const a=await activate(s.school_id,args[2],fromId); return sendTelegram(chatId,`Receipt ${args[1]} marked confirmed. ${a.school_name} active until ${new Date(a.subscription_expires_at).toLocaleString('en-GB')}.`); }
      if (cmd === '/admins') {
        if(!args[0])return sendTelegram(chatId,'Usage: /admins SCHOOLID');
        const s=await getSchool(args[0]);if(!s)throw new Error('School ID not found.');if(s.status==='pending')throw new Error('Approve the school first.');
        const tp=await getTenantPool(s);const rows=(await tp.query("SELECT username,full_name,phone,active,created_at FROM users WHERE role='admin' ORDER BY full_name")).rows;
        return sendTelegram(chatId,rows.length?rows.map(u=>`${u.username} | ${u.full_name} | ${u.active?'active':'disabled'} | ${u.phone||'-'}`).join('\n'):'No school administrators found.');
      }
      if (cmd === '/deactivateadmin' || cmd === '/activateadmin') {
        if(args.length<2)return sendTelegram(chatId,`Usage: ${cmd} SCHOOLID username`);
        const s=await getSchool(args[0]);if(!s)throw new Error('School ID not found.');if(s.status==='pending')throw new Error('Approve the school first.');
        const tp=await getTenantPool(s);const user=(await tp.query("SELECT id,username,full_name,active FROM users WHERE LOWER(username)=LOWER($1) AND role='admin' LIMIT 1",[args[1]])).rows[0];if(!user)throw new Error('School administrator not found.');
        if(cmd==='/deactivateadmin'&&user.active){const count=Number((await tp.query("SELECT COUNT(*)::int n FROM users WHERE role='admin' AND active=true")).rows[0].n);if(count<=1)throw new Error('Cannot disable the last active administrator. Create another administrator first.');}
        const active=cmd==='/activateadmin';await tp.query('UPDATE users SET active=$2,updated_at=NOW() WHERE id=$1',[user.id,active]);await audit(fromId,active?'ACTIVATE_ADMIN':'DEACTIVATE_ADMIN',s.school_id,`username=${user.username}`);
        return sendTelegram(chatId,`${user.full_name} (${user.username}) is now ${active?'active':'disabled'} for ${s.school_name}.`);
      }
      if (cmd === '/assignadmin') {
        if (args.length < 2) return sendTelegram(chatId,'Usage: /assignadmin SCHOOLID username|Full Name|phone');
        const s=await getSchool(args[0]); if(!s)throw new Error('School ID not found.'); if(!['active','pending_payment'].includes(s.status))throw new Error('Approve the school first.');
        const parts=args.slice(1).join(' ').split('|').map(x=>x.trim()); if(parts.length<2||!parts[0]||!parts[1])throw new Error('Provide username|Full Name|phone.');
        const password=crypto.randomBytes(9).toString('base64url')+'A7!'; const hash=await bcrypt.hash(password,12); const tp=await getTenantPool(s);
        await tp.query('INSERT INTO users(username,password_hash,full_name,role,phone,email) VALUES($1,$2,$3,$4,$5,$6)',[parts[0],hash,parts[1],'admin',parts[2]||null,null]); await audit(fromId,'ASSIGN_ADMIN',s.school_id,`username=${parts[0]}`);
        return sendTelegram(chatId,`Administrator created for ${s.school_name} (${s.school_id}).\nUsername: ${parts[0]}\nTemporary password: ${password}\nShare securely; do not post in groups.`);
      }
      return sendTelegram(chatId,'Unknown command. Use /help.');
    } catch (e) { return sendTelegram(chatId, 'Action failed: ' + e.message); }
  }
  let telegramOffset = 0, telegramBusy = false;
  async function pollTelegram() {
    if (!adminTelegramAllowed() || telegramBusy) return;
    telegramBusy = true;
    try {
      const updates = await telegram('getUpdates', { offset: telegramOffset, timeout: 20, allowed_updates:['message'] });
      for (const u of updates || []) { telegramOffset = Math.max(telegramOffset, u.update_id + 1); if (u.message) await handleTelegramCommand(u.message); }
    } catch (e) { console.warn('Telegram bot polling warning:', e.message); }
    finally { telegramBusy = false; setTimeout(pollTelegram, 1500).unref?.(); }
  }

  function tenantMiddleware() {
    return async (req, res, next) => {
      if (!req.path.startsWith('/api/') || req.path.startsWith('/api/platform/') || ['/api/health','/api/config'].includes(req.path)) return next();
      try {
        await ready;
        const suppliedSchoolId = req.body?.school_id || req.query?.school_id || req.headers['x-school-id'] || '';
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'') || String(req.query.download_token || '');
        let tokenSchoolId='';
        if(token){try{tokenSchoolId=String(jwt.verify(token,process.env.JWT_SECRET||process.env.DEVELOPER_JWT_SECRET||'green-star-change-this').school_id||'')}catch{}}
        if(tokenSchoolId && suppliedSchoolId && String(suppliedSchoolId).toUpperCase()!==tokenSchoolId.toUpperCase())return res.status(403).json({error:'Your session is assigned to a different school. Sign out and use the correct School ID.',code:'TENANT_MISMATCH'});
        const schoolId = tokenSchoolId || suppliedSchoolId;
        if (!schoolId) return res.status(400).json({ error:'School ID is required. Enter the School ID provided by O\'LIVE TECH.', code:'SCHOOL_ID_REQUIRED' });
        const school = await getSchool(schoolId);
        if (!school) return res.status(404).json({ error:'School ID was not found. Check the ID or register your school.', code:'SCHOOL_NOT_FOUND' });
        if (school.status === 'pending') return res.status(403).json({ error:'Registration is waiting for O\'LIVE TECH Super Admin approval.', code:'SCHOOL_PENDING' });
        if (school.status === 'rejected') return res.status(403).json({ error:'This school registration was rejected. Contact O\'LIVE TECH support.', code:'SCHOOL_REJECTED' });
        if (school.status === 'suspended') return res.status(402).json({ error:'This school is suspended. Contact O\'LIVE TECH to verify payment and reactivate service.', code:'SCHOOL_SUSPENDED', support });
        if (school.status === 'active' && school.subscription_expires_at && new Date(school.subscription_expires_at) <= new Date()) {
          await controlPool.query("UPDATE platform_schools SET status='suspended',suspended_reason='Subscription expired',updated_at=NOW() WHERE school_id=$1",[school.school_id]);
          return res.status(402).json({ error:'Subscription expired. Contact O\'LIVE TECH to renew.', code:'SUBSCRIPTION_EXPIRED', support });
        }
        if (school.status === 'pending_payment' && !['/api/auth/login','/api/school-config','/api/platform/payment'].includes(req.path)) return res.status(402).json({ error:'School approved. Submit M-Pesa payment and wait for activation by O\'LIVE TECH.', code:'PAYMENT_REQUIRED', school_id:school.school_id });
        req.platformSchool = school;
        const tenantPool = await getTenantPool(school);
        return tenantALS.run({ pool: tenantPool, schoolId: school.school_id, school }, next);
      } catch (e) { return res.status(503).json({ error:'Platform database is not ready: ' + e.message }); }
    };
  }

  app.get('/register', (req,res)=>res.sendFile(path.join(publicDir,'register.html')));
  app.get('/platform-admin', (req,res)=>res.sendFile(path.join(publicDir,'platform-admin.html')));
  app.get('/api/platform/health', async(req,res)=>{try{await ready;res.json({ok:true,brand:BRAND,telegramConfigured:adminTelegramAllowed()})}catch(e){res.status(503).json({ok:false,error:e.message})}});
  app.get('/api/platform/brand', (req,res)=>res.json({brand:BRAND,phone:support.phone,email:support.email,website:support.website,mpesa_paybill:process.env.OLIVE_TECH_MPESA_PAYBILL||''}));
  app.post('/api/platform/register', async(req,res)=>{
    try {
      await ready;
      const x=req.body||{}; const schoolName=String(x.school_name||'').trim(), username=String(x.admin_username||'').trim(), password=String(x.admin_password||'');
      if(!schoolName||!username||password.length<12||!String(x.phone||'').trim()) return res.status(400).json({error:'School name, contact phone, administrator username and a password of at least 12 characters are required.'});
      const logoUrl=String(x.logo_url||'').trim();if(logoUrl&&!/^https?:\/\//i.test(logoUrl))return res.status(400).json({error:'School logo URL must begin with https:// or http://.'});
      if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return res.status(400).json({error:'Admin username must be 3–40 characters using letters, numbers, dots, underscores or hyphens.'});
      const schoolId=makeSchoolId(), slug=cleanSlug(schoolName)+'-'+schoolId.slice(-4).toLowerCase(), databaseName='olive_school_'+schoolId.toLowerCase().replace(/[^a-z0-9]/g,'');
      const hash=await bcrypt.hash(password,12);
      const r=await controlPool.query(`INSERT INTO platform_schools(school_id,slug,school_name,school_type,address,phone,email,motto,school_payment_number,logo_url,principal_name,admin_username,admin_password_hash,database_name,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending') RETURNING school_id,slug,school_name,status,created_at`,[schoolId,slug,schoolName,String(x.school_type||'').trim()||null,String(x.address||'').trim()||null,String(x.phone).trim(),String(x.email||'').trim()||null,String(x.motto||'').trim()||null,String(x.school_payment_number||'').trim()||null,String(x.logo_url||'').trim()||null,String(x.principal_name||'').trim()||null,username,hash,databaseName]);
      await audit('school-registration','REGISTER_SCHOOL',schoolId,`name=${schoolName}`);
      if(adminTelegramAllowed()) { try { await sendTelegram(process.env.SUPER_ADMIN_TELEGRAM_ID, `New school registration awaiting approval\n${schoolName}\nSchool ID: ${schoolId}\nContact: ${x.phone}\nAdmin username: ${username}\nApprove: /approve ${schoolId}\nReject: /reject ${schoolId} reason`); } catch(e) { console.warn('Telegram notification failed:',e.message); } }
      res.status(201).json({message:'Registration submitted. Your school must be approved by O\'LIVE TECH before it can access the system.',school:r.rows[0],brand:BRAND});
    } catch(e) { res.status(400).json({error:e.code==='23505'?'A registration with those details already exists.':e.message}); }
  });
  app.post('/api/platform/payment', async(req,res)=>{
    try {
      await ready;
      const school=await getSchool(req.body?.school_id); if(!school)return res.status(404).json({error:'School ID not found.'});
      if(!['pending_payment','active','suspended'].includes(school.status))return res.status(403).json({error:'School must be approved before submitting subscription payment.'});
      const amount=Number(req.body.amount), phone=String(req.body.payer_phone||'').trim(), receipt=String(req.body.mpesa_receipt||'').trim().toUpperCase();
      if(!Number.isFinite(amount)||amount<=0||!phone||!receipt)return res.status(400).json({error:'Amount, payer phone and M-Pesa receipt are required.'});
      const r=await controlPool.query('INSERT INTO platform_payments(school_id,amount,payer_phone,mpesa_receipt) VALUES($1,$2,$3,$4) RETURNING id,school_id,amount,payer_phone,mpesa_receipt,status,submitted_at',[school.school_id,amount,phone,receipt]);
      if(adminTelegramAllowed()) { try { await sendTelegram(process.env.SUPER_ADMIN_TELEGRAM_ID,`M-Pesa receipt submitted\nSchool: ${school.school_name} (${school.school_id})\nAmount: KSh ${amount}\nPayer: ${phone}\nReceipt: ${receipt}\nVerify against your M-Pesa records, then use /confirm ${school.school_id} ${receipt} 30`); } catch(e){} }
      res.status(201).json({message:'Payment receipt submitted for manual verification. Access is not activated until O\'LIVE TECH confirms the receipt.',payment:r.rows[0]});
    } catch(e) { res.status(400).json({error:e.code==='23505'?'This M-Pesa receipt has already been submitted.':e.message}); }
  });
  app.get('/api/platform/registration-status/:schoolId', async(req,res)=>{try{await ready;const s=await getSchool(req.params.schoolId);if(!s)return res.status(404).json({error:'School not found'});res.json({school_id:s.school_id,school_name:s.school_name,status:s.status,subscription_expires_at:s.subscription_expires_at,reason:s.suspended_reason||null});}catch(e){res.status(500).json({error:e.message})}});
  app.get('/api/platform/admin/schools', async(req,res)=>{if(!adminTelegramAllowed())return res.status(503).json({error:'Configure TELEGRAM_BOT_TOKEN and SUPER_ADMIN_TELEGRAM_ID first.'});const key=String(req.headers['x-platform-admin-key']||'');if(!process.env.PLATFORM_ADMIN_KEY||key!==process.env.PLATFORM_ADMIN_KEY)return res.status(401).json({error:'Platform admin key required. Telegram remains the authoritative control channel.'});try{await ready;const rows=(await controlPool.query('SELECT school_id,school_name,phone,email,status,created_at,subscription_expires_at,suspended_reason FROM platform_schools ORDER BY created_at DESC')).rows;res.json(rows)}catch(e){res.status(500).json({error:e.message})}});
  app.get('/api/school-config', async (req,res,next)=>{
    try {
      const id=req.query.school_id||req.headers['x-school-id']||'';
      const s=await getSchool(id);
      if(!s) return res.status(404).json({error:'School ID not found. Enter the School ID provided by O\'LIVE TECH.'});
      res.json({school:s.school_name,address:s.address||'',phone:s.phone||'',email:s.email||'',motto:s.motto||'',logo_url:s.logo_url||'/olive-tech-logo.svg',payment_number:s.school_payment_number||'',school_id:s.school_id,status:s.status,subscription_expires_at:s.subscription_expires_at,provider:support,payment_number:process.env.OLIVE_TECH_MPESA_PAYBILL||''});
    } catch(e) { res.status(500).json({error:e.message}); }
  });
  app.get('/api/platform/payment-status/:schoolId', async(req,res)=>{try{await ready;const s=await getSchool(req.params.schoolId);if(!s)return res.status(404).json({error:'School not found'});const p=(await controlPool.query('SELECT amount,payer_phone,mpesa_receipt,status,submitted_at,reviewed_at FROM platform_payments WHERE school_id=$1 ORDER BY submitted_at DESC LIMIT 10',[s.school_id])).rows;res.json({school_id:s.school_id,status:s.status,payments:p,expires_at:s.subscription_expires_at});}catch(e){res.status(500).json({error:e.message})}});

  if (adminTelegramAllowed()) setTimeout(pollTelegram, 2000).unref?.();
  return { controlPool, ready, middleware:tenantMiddleware(), getSchool, getTenantPool, listActiveSchools:async()=>{await ready;await controlPool.query("UPDATE platform_schools SET status='suspended',suspended_reason='Subscription expired',updated_at=NOW() WHERE status='active' AND subscription_expires_at IS NOT NULL AND subscription_expires_at<=NOW()");return (await controlPool.query("SELECT * FROM platform_schools WHERE status='active' ORDER BY school_id")).rows;}, support, close:()=>Promise.all([controlPool.end(),...tenantPools.values()].map(p=>p.end())) };
}
module.exports = { createPlatform };
