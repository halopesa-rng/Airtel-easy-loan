require("dotenv").config();
const express=require("express");
const cors=require("cors");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");
const path=require("path");
const fs=require("fs");
const crypto=require("crypto");
const {AsyncLocalStorage}=require("async_hooks");
const {createPlatform}=require("./platform");

const app=express();
const PORT=process.env.PORT||10000;
const NODE_ENV=String(process.env.NODE_ENV||"development").toLowerCase();
const JWT_SECRET=process.env.JWT_SECRET||process.env.DEVELOPER_JWT_SECRET||"green-star-change-this";
if(NODE_ENV==='production' && JWT_SECRET.length<32){
  console.error('FATAL: JWT_SECRET (or DEVELOPER_JWT_SECRET) must be set to a random secret of at least 32 characters in production.');
  process.exit(1);
}
const SCHOOL_NAME=process.env.SCHOOL_NAME||"School Management System";
const SCHOOL_ADDRESS=process.env.SCHOOL_ADDRESS||"";
const SCHOOL_LOGO_URL=process.env.SCHOOL_LOGO_URL||"/logo.png";
const DEVELOPER_NAME=process.env.OLIVE_TECH_NAME||"O'LIVE TECH";
const DEVELOPER_NUMBER=process.env.OLIVE_TECH_PHONE||"";
const DEVELOPER_EMAIL=process.env.OLIVE_TECH_EMAIL||"";
const DEVELOPER_WEBSITE=process.env.OLIVE_TECH_WEBSITE||"";
const SCHOOL_PAYMENT_NUMBER=process.env.SCHOOL_PAYMENT_NUMBER||"";
const SUBSCRIPTION_TILL_NUMBER=process.env.OLIVE_TECH_MPESA_PAYBILL||"";
const APP_VERSION="2.0.0-olive-multischool";
const LICENSE_CONFIG_PATH=process.env.LICENSE_CONFIG_PATH||path.join(__dirname,"deployment","licensing","config.json");
function readLicenseConfig(){
  let file={};
  try{if(fs.existsSync(LICENSE_CONFIG_PATH))file=JSON.parse(fs.readFileSync(LICENSE_CONFIG_PATH,"utf8"))||{}}catch(e){console.warn("License config read warning:",e.message)}
  return {
    enforcement: file.enforcement!==undefined ? Boolean(file.enforcement) : String(process.env.LICENSE_ENFORCEMENT||"false").toLowerCase()==="true",
    server_url: String(file.server_url||process.env.LICENSE_SERVER_URL||"").replace(/\/$/,""),
    key: String(file.license_key||process.env.LICENSE_KEY||"").trim(),
    install_secret: String(file.install_secret||process.env.LICENSE_INSTALL_SECRET||"").trim()
  };
}
function writeLicenseConfig(c){
  fs.mkdirSync(path.dirname(LICENSE_CONFIG_PATH),{recursive:true});
  const safe={enforcement:Boolean(c.enforcement),server_url:String(c.server_url||"").replace(/\/$/,""),license_key:String(c.license_key||"").trim(),install_secret:String(c.install_secret||"").trim(),updated_at:new Date().toISOString()};
  fs.writeFileSync(LICENSE_CONFIG_PATH,JSON.stringify(safe,null,2),{mode:0o600});
  return safe;
}
let LICENSE_CFG=readLicenseConfig();
let LICENSE_ENFORCEMENT=LICENSE_CFG.enforcement;
let LICENSE_SERVER_URL=LICENSE_CFG.server_url;
let LICENSE_KEY=LICENSE_CFG.key;
let LICENSE_INSTALL_SECRET=LICENSE_CFG.install_secret;
const LICENSE_PUBLIC_KEY_PATH=process.env.LICENSE_PUBLIC_KEY_PATH||path.join(__dirname,"deployment","licensing","license-public.pem");
let LICENSE_PUBLIC_KEY="";try{if(fs.existsSync(LICENSE_PUBLIC_KEY_PATH))LICENSE_PUBLIC_KEY=fs.readFileSync(LICENSE_PUBLIC_KEY_PATH,"utf8")}catch{}
let cachedLicense=null;

const JITSI_BASE_URL=String(process.env.JITSI_BASE_URL||"").replace(/\/$/,"");
const JITSI_APP_ID=process.env.JITSI_APP_ID||"olivetech";
const JITSI_APP_SECRET=process.env.JITSI_APP_SECRET||"";
const JITSI_DOMAIN=process.env.JITSI_DOMAIN||(() => { try { return new URL(JITSI_BASE_URL).hostname; } catch { return ""; } })();
const SCHOOL_LOGO_DATA_URI="";
const tenantALS=new AsyncLocalStorage();
const defaultPool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
const tenantPoolCache=new Map();
const pool={
  query:(...args)=>(tenantALS.getStore()?.pool||defaultPool).query(...args),
  connect:(...args)=>(tenantALS.getStore()?.pool||defaultPool).connect(...args),
  end:(...args)=>defaultPool.end(...args)
};
let tenantAdminPool=null;
async function makeTenantPool(databaseName){
  if(tenantPoolCache.has(databaseName))return tenantPoolCache.get(databaseName);
  const adminUrl=process.env.TENANT_DATABASE_ADMIN_URL;
  if(!adminUrl)throw new Error('TENANT_DATABASE_ADMIN_URL is required to create a separate database for each school.');
  if(!tenantAdminPool)tenantAdminPool=new Pool({connectionString:adminUrl,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false,max:2});
  const safeName=String(databaseName||'').replace(/[^a-zA-Z0-9_]/g,'');
  if(!/^olive_school_[a-z0-9]+$/i.test(safeName))throw new Error('Invalid tenant database name.');
  try{await tenantAdminPool.query('CREATE DATABASE "'+safeName+'"')}catch(e){if(e.code!=='42P04')throw new Error('Could not create school database. Ensure TENANT_DATABASE_ADMIN_URL uses a PostgreSQL role with CREATEDB permission. '+e.message)}
  const u=new URL(adminUrl);u.pathname='/'+safeName;u.searchParams.delete('options');
  const tenantPool=new Pool({connectionString:u.toString(),ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false,max:10});
  tenantPoolCache.set(databaseName,tenantPool);return tenantPool;
}
function currentSchool(){return tenantALS.getStore()?.school||null;}
function currentSchoolName(){return currentSchool()?.school_name||SCHOOL_NAME;}
function currentSchoolAddress(){const s=currentSchool();return [s?.address,s?.phone,s?.email].filter(Boolean).join(" | ")||SCHOOL_ADDRESS;}
function currentSchoolMotto(){return currentSchool()?.motto||"";}
function currentSchoolPaymentNumber(){return currentSchool()?.school_payment_number||SCHOOL_PAYMENT_NUMBER;}
function tenantBrandText(value){return String(value??"").replace(/Green Star Integrated School|Green Star School Management|Green Star|Greenstar/gi,currentSchoolName());}
function currentSchoolLogo(){return currentSchool()?.logo_url||"/olive-tech-logo.svg";}
// Compatibility bootstrap runs only after the PostgreSQL pool exists.
// These statements repair older deployments before the main schema/index pass.
async function ensureLegacyCompatibility(){
  if(!process.env.DATABASE_URL)return;
  const timestampCompatibility=[
    ["users",["created_at"]],["students",["created_at","updated_at"]],["subjects",["created_at","updated_at"]],
    ["exams",["created_at","updated_at"]],["announcements",["created_at","updated_at"]],["audit_logs",["created_at"]],
    ["tafhid_assessments",["created_at","updated_at"]],["student_subject_reports",["created_at","updated_at"]],
    ["exam_resources",["created_at","updated_at"]],["resource_purchases",["created_at","updated_at"]],
    ["leave_requests",["created_at","updated_at"]],["marks",["created_at","updated_at"]],
    ["communications",["created_at","updated_at"]],["online_chat",["created_at","updated_at"]],
    ["online_recordings",["created_at","updated_at"]],["payroll_periods",["created_at","updated_at"]],
    ["payroll_entries",["created_at","updated_at"]],["teacher_assignments",["created_at","updated_at"]]
  ];
  for(const [table,cols] of timestampCompatibility){for(const col of cols){try{await pool.query(`ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS ${col} TIMESTAMP DEFAULT NOW()`)}catch(e){console.warn(`Timestamp compatibility warning (${table}.${col}):`,e.message)}}}
  const sql=[
    "CREATE TABLE IF NOT EXISTS expenditure_requests(id SERIAL PRIMARY KEY,category TEXT NOT NULL DEFAULT 'General',description TEXT NOT NULL,amount NUMERIC(12,2) NOT NULL,payment_method TEXT NOT NULL DEFAULT 'Cash',requested_date DATE DEFAULT CURRENT_DATE,requested_by INT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'pending',reviewed_by INT REFERENCES users(id),reviewed_at TIMESTAMP,review_note TEXT,paid_at TIMESTAMP,payment_reference TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
    "CREATE TABLE IF NOT EXISTS fee_settings(setting_key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
    "ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS setting_key TEXT",
    "ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS value TEXT NOT NULL DEFAULT ''",
    "UPDATE fee_settings SET setting_key=COALESCE(setting_key,'legacy_'||ctid::text) WHERE setting_key IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_settings_setting_key ON fee_settings(setting_key)",
    "ALTER TABLE communications ADD COLUMN IF NOT EXISTS title TEXT",
    "ALTER TABLE communications ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'all'",
    "ALTER TABLE communications ADD COLUMN IF NOT EXISTS audience_value TEXT",
    "ALTER TABLE communications ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL",
    "UPDATE communications SET title=COALESCE(NULLIF(title,''),'School Communication') WHERE title IS NULL OR title=''",
    "ALTER TABLE communications ALTER COLUMN title SET DEFAULT 'School Communication'",
    "ALTER TABLE communications ALTER COLUMN title SET NOT NULL",
    "ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()",
    "ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS period_type TEXT DEFAULT 'monthly'",
    "ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS fee_month TEXT",
    "ALTER TABLE expenditures ADD COLUMN IF NOT EXISTS expenditure_request_id INT REFERENCES expenditure_requests(id) ON DELETE SET NULL",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS class_name TEXT",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS topic TEXT",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS term TEXT",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS question_type TEXT DEFAULT 'Short Answer'",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS question_text TEXT",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS marks NUMERIC DEFAULT 1",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id)",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected'))",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS reviewed_by INT REFERENCES users(id)",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP",
    "ALTER TABLE exam_bank ADD COLUMN IF NOT EXISTS review_note TEXT",
    "ALTER TABLE teacher_assignments ADD COLUMN IF NOT EXISTS class_name TEXT",
    "ALTER TABLE teacher_assignments ADD COLUMN IF NOT EXISTS assignment_type TEXT DEFAULT 'subject'",
    "ALTER TABLE marks ADD COLUMN IF NOT EXISTS grade TEXT",
    "ALTER TABLE marks ADD COLUMN IF NOT EXISTS teacher_comment TEXT",
    "CREATE TABLE IF NOT EXISTS school_calendar(id SERIAL PRIMARY KEY,title TEXT NOT NULL,event_date DATE NOT NULL,start_time TIME,end_time TIME,category TEXT NOT NULL DEFAULT 'School Activity',location TEXT,description TEXT,created_by INT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_school_calendar_date ON school_calendar(event_date)",
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check",
    "ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','director','principal','secretary','teacher','ustadh','patron','student','parent','worker')) NOT VALID",
    "CREATE TABLE IF NOT EXISTS boarding_profiles(id SERIAL PRIMARY KEY,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,boarding_status TEXT NOT NULL DEFAULT 'active' CHECK(boarding_status IN ('active','inactive')),house TEXT,hostel TEXT,room TEXT,bed_no TEXT,admitted_on DATE,notes TEXT,created_by INT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),UNIQUE(student_id))",
    "CREATE INDEX IF NOT EXISTS idx_boarding_profiles_status ON boarding_profiles(boarding_status)",
    "CREATE INDEX IF NOT EXISTS idx_boarding_profiles_house ON boarding_profiles(house,hostel,room)",
    "CREATE TABLE IF NOT EXISTS boarding_attendance(id SERIAL PRIMARY KEY,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,attendance_date DATE NOT NULL,status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','absent','late','excused')),check_in TIME,check_out TIME,notes TEXT,marked_by INT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),UNIQUE(student_id,attendance_date))",
    "CREATE INDEX IF NOT EXISTS idx_boarding_attendance_date ON boarding_attendance(attendance_date,status)",
    "CREATE TABLE IF NOT EXISTS boarding_incidents(id SERIAL PRIMARY KEY,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,incident_date DATE NOT NULL DEFAULT CURRENT_DATE,category TEXT NOT NULL DEFAULT 'General',description TEXT NOT NULL,action_taken TEXT,follow_up TEXT,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','follow_up')),created_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_boarding_incidents_date ON boarding_incidents(incident_date,status)",
    "CREATE TABLE IF NOT EXISTS whatsapp_pending_notifications(id SERIAL PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,event_type TEXT NOT NULL,student_id INT REFERENCES students(id) ON DELETE CASCADE,recipient_name TEXT,recipient_phone TEXT,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','dismissed')),source_id TEXT,created_at TIMESTAMP DEFAULT NOW(),sent_at TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS whatsapp_communication_settings(event_type TEXT PRIMARY KEY,enabled BOOLEAN NOT NULL DEFAULT TRUE,mode TEXT NOT NULL DEFAULT 'approval' CHECK(mode IN ('approval','automatic')),updated_at TIMESTAMP DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS approval_notifications(id SERIAL PRIMARY KEY,recipient_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,notification_type TEXT NOT NULL,message TEXT NOT NULL,source_id TEXT,action_url TEXT,read_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(recipient_user_id,notification_type,source_id))",
"CREATE INDEX IF NOT EXISTS idx_approval_notifications_recipient ON approval_notifications(recipient_user_id,read_at,created_at DESC)",
    "CREATE TABLE IF NOT EXISTS whatsapp_delivery_log(id SERIAL PRIMARY KEY,recipient_name TEXT,recipient_phone TEXT,event_type TEXT,message TEXT,status TEXT,provider_message_id TEXT,error TEXT,created_by INT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMP DEFAULT NOW())",
    "INSERT INTO whatsapp_communication_settings(event_type,enabled,mode) VALUES ('fees',TRUE,'automatic'),('results',TRUE,'automatic'),('tafhid',TRUE,'automatic'),('announcement',TRUE,'automatic'),('exam-resource',TRUE,'automatic'),('payroll',TRUE,'automatic'),('expenditure',TRUE,'automatic'),('leave',TRUE,'automatic'),('resource-payment',TRUE,'automatic'),('student-subject-report',TRUE,'automatic') ON CONFLICT(event_type) DO NOTHING"
  ];
  for(const q of sql){try{await pool.query(q)}catch(e){console.warn('Compatibility migration warning:',e.message)}}
}

app.use(cors());
app.use((req,res,next)=>{if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');next()});
app.use(express.json({limit:"10mb"}));app.use(express.urlencoded({extended:true}));
const platform=createPlatform({app,express,bcrypt,jwt,tenantALS,makeTenantPool,publicDir:path.join(__dirname,"public"),initializeTenant:async(tenantPool,school)=>init({tenantPool,createAdmin:false,throwOnError:true,schoolId:school.school_id,school})});
app.use(platform.middleware);
app.use(subscriptionWriteGuard);
function resolveProjectPath(name){
  const candidates=[
    path.join(__dirname,name),
    path.join(process.cwd(),name),
    path.join(__dirname,"Green-Star-School-Management",name),
    path.join(process.cwd(),"Green-Star-School-Management",name)
  ];
  return candidates.find(p=>fs.existsSync(p))||candidates[0];
}
const PUBLIC_DIR=resolveProjectPath("public");
const DATABASE_DIR=resolveProjectPath("database");
app.use(express.static(PUBLIC_DIR));

const ROLE_PAGES=["admin","director","principal","secretary","teacher","ustadh","patron","student","parent","worker"];
const CBC_LEVELS=[
 {code:"EE",label:"Exceeding Expectations",min:80,max:100},
 {code:"ME",label:"Meeting Expectations",min:60,max:79.999},
 {code:"AE",label:"Approaching Expectations",min:40,max:59.999},
 {code:"BE",label:"Below Expectations",min:0,max:39.999}
];
function cbcLevel(mark){const m=Number(mark);if(!Number.isFinite(m))return "BE";if(m>=80)return "EE";if(m>=60)return "ME";if(m>=40)return "AE";return "BE";}
function cbcDescriptor(code){return (CBC_LEVELS.find(x=>x.code===code)||CBC_LEVELS[3]).label;}
function classOrderSql(a="s"){return `CASE WHEN LOWER(TRIM(${a}.class_name)) IN ('pp1','pp 1','pre-primary 1') THEN 1 WHEN LOWER(TRIM(${a}.class_name)) IN ('pp2','pp 2','pre-primary 2') THEN 2 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 1','grade1') THEN 3 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 2','grade2') THEN 4 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 3','grade3') THEN 5 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 4','grade4') THEN 6 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 5','grade5') THEN 7 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 6','grade6') THEN 8 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 7','grade7') THEN 9 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 8','grade8') THEN 10 WHEN LOWER(TRIM(${a}.class_name)) IN ('grade 9','grade9') THEN 11 ELSE 99 END`}
function licensePayloadValid(payload){
  if(!payload||payload.product!=='olive-tech-school-management')return false;
  if(payload.school_license_key&&LICENSE_KEY&&payload.school_license_key!==LICENSE_KEY)return false;
  if(payload.status!=='active')return false;
  const until=Date.parse(payload.valid_until||'');
  if(!Number.isFinite(until))return false;
  return until>Date.now();
}
function loadCachedLicense(){
  if(!cachedLicense)return null;
  return cachedLicense;
}
function subscriptionWriteGuard(req,res,next){
  if(!LICENSE_ENFORCEMENT)return next();
  const p=req.path||'';
  if(req.method==='GET'||req.method==='HEAD'||req.method==='OPTIONS')return next();
  if(['/api/auth/login','/api/auth/logout','/api/school-config','/api/license/status','/api/license/sync','/api/subscription/payment','/api/developer-setup/configure','/api/developer-setup/create-admin'].includes(p))return next();
  const lic=loadCachedLicense();
  if(lic&&licensePayloadValid(lic))return next();
  const graceUntil=Date.parse(lic?.grace_until||'');
  if(Number.isFinite(graceUntil)&&graceUntil>Date.now())return next();
  return res.status(402).json({error:'School subscription is inactive or expired. Please contact the developer to renew the subscription.',code:'SUBSCRIPTION_REQUIRED',subscription:lic?{status:lic.status,valid_until:lic.valid_until,grace_until:lic.grace_until}:null});
}
async function syncLicense(){
  if(!LICENSE_ENFORCEMENT||!LICENSE_SERVER_URL||!LICENSE_KEY||!LICENSE_INSTALL_SECRET)return;
  try{
    const r=await fetch(`${LICENSE_SERVER_URL}/api/v1/license/sync`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({license_key:LICENSE_KEY,install_secret:LICENSE_INSTALL_SECRET,school_name:currentSchoolName(),app_version:APP_VERSION}),signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw new Error(`license server ${r.status}`);
    const data=await r.json();
    if(data.token&&LICENSE_PUBLIC_KEY){
      const parts=String(data.token).split('.');
      if(parts.length!==3)throw new Error('Invalid license token');
      const input=parts[0]+'.'+parts[1],sig=Buffer.from(parts[2].replace(/-/g,'+').replace(/_/g,'/'),'base64');
      const ok=crypto.verify('RSA-SHA256',Buffer.from(input),LICENSE_PUBLIC_KEY,sig);
      if(!ok)throw new Error('Invalid license signature');
      const payload=JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));
      cachedLicense=payload;
    }else if(data.entitlement){cachedLicense=data.entitlement;}
  }catch(e){console.warn('License sync warning:',e.message)}
}
function subscriptionStatus(){
  const lic=loadCachedLicense();
  return {enforced:LICENSE_ENFORCEMENT,configured:!!(LICENSE_SERVER_URL&&LICENSE_KEY&&LICENSE_INSTALL_SECRET),license:lic?{status:lic.status,plan:lic.plan,valid_until:lic.valid_until,grace_until:lic.grace_until,features:lic.features||{}}:null};
}

function auth(roles=[]){return async(req,res,next)=>{try{const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"")||String(req.query.download_token||"");if(!token)return res.status(401).json({error:"Authentication required"});const p=jwt.verify(token,JWT_SECRET);const r=await pool.query("SELECT id,username,full_name,role,phone,email,active FROM users WHERE id=$1",[p.id]);const u=r.rows[0];if(!u||!u.active)return res.status(401).json({error:"Account inactive"});if(roles.length&&!roles.includes(u.role))return res.status(403).json({error:"Access denied"});req.user=u;next()}catch(e){res.status(401).json({error:"Invalid or expired token"})}}}
function adminOnly(req,res,next){return auth(["admin"])(req,res,next)}
function normalizeRole(v){return String(v||"").trim().toLowerCase()}
async function isClassTeacher(userId,className){
  const r=await pool.query("SELECT 1 FROM teacher_assignments WHERE teacher_id=$1 AND assignment_type='class_teacher' AND LOWER(TRIM(class_name))=LOWER(TRIM($2)) LIMIT 1",[userId,className]);
  return !!r.rows[0];
}
async function hasSubjectAssignment(userId,subjectId,className){
  const r=await pool.query("SELECT 1 FROM teacher_assignments WHERE teacher_id=$1 AND subject_id=$2 AND assignment_type='subject' AND LOWER(TRIM(class_name))=LOWER(TRIM($3)) LIMIT 1",[userId,subjectId,className]);
  return !!r.rows[0];
}
function normalizeClass(v){return String(v||'').trim()}
const STAFF_ROLES=['teacher','ustadh','patron','worker','secretary','admin','director','principal'];
function staffAuth(roles=STAFF_ROLES){return auth(roles)}


async function audit(userId,action,details=""){try{await pool.query("INSERT INTO audit_logs(user_id,action,details) VALUES($1,$2,$3)",[userId,action,details])}catch{}}
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]))}
function docHeader(title){
  const addressLines=String(currentSchoolAddress()).split('|').map(x=>x.trim()).filter(Boolean);
  return `<header class="school-head"><div class="brand"><img src="${esc(SCHOOL_LOGO_DATA_URI||currentSchoolLogo()||'/olive-tech-logo.svg')}" alt="School logo"><div><h1>${esc(currentSchoolName())}</h1><div class="motto">${esc(currentSchoolMotto())}</div><div class="address">${addressLines.map(x=>`<span>${esc(x)}</span>`).join('')}</div></div></div><h2>${esc(title)}</h2></header>`
}

// Lightweight dependency-free A4 PDF renderer used for official downloadable reports.
// It intentionally uses only PDF primitives so production deployments do not need a browser/PDF service.
function pdfSafe(v){return String(v??'').replace(/[^\x20-\x7E]/g,' ').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')}
function pdfWrap(text,maxChars){const words=String(text??'').replace(/\s+/g,' ').trim().split(' ');const out=[];let line='';for(const w of words){if(!w)continue;if((line+' '+w).trim().length>maxChars&&line){out.push(line);line=w}else line=(line+' '+w).trim()}if(line)out.push(line);return out}
class SimplePdf{
  constructor(){this.pages=[];this.page=null;this.newPage()}
  newPage(){this.page={c:[],used:0};this.pages.push(this.page)}
  cmd(x){this.page.c.push(x)}
  text(x,y,txt,size=9,bold=false){this.cmd(`0 0 0 rg BT /${bold?'F2':'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfSafe(txt)}) Tj ET`)}
  line(x1,y1,x2,y2,w=.6){this.cmd(`${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`)}
  rect(x,y,w,h,fill=false){this.cmd(`${fill?'0.96 0.98 0.97 rg':'0.65 0.72 0.69 RG'} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill?'f':'S'}`)}
  fillRect(x,y,w,h,gray=.85){this.cmd(`${gray} ${gray} ${gray} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`)}
  strokePath(points,w=1){if(!points.length)return;this.cmd(`${w} w ${points.map((p,i)=>`${p[0].toFixed(2)} ${p[1].toFixed(2)} ${i?'l':'m'}`).join(' ')} S`)}
  circle(x,y,r,fill=true){this.cmd(`0.15 0.39 0.78 ${fill?'rg':'RG'} ${(x-r).toFixed(2)} ${(y-r).toFixed(2)} ${(r*2).toFixed(2)} ${(r*2).toFixed(2)} re ${fill?'f':'S'}`)}
  addPageIfNeeded(h=20){if(this.page.used+h>785){this.newPage();return true}return false}
  finalize(){const objs=[];const offsets=[];const add=(body)=>{offsets.push(0);objs.push(body);return objs.length};const catalog=add('');const pages=add('');const font1=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');const font2=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');const pageNums=[];for(const p of this.pages){const stream=p.c.join('\n');const content=add(`<< /Length ${Buffer.byteLength(stream,'binary')} >>\nstream\n${stream}\nendstream`);pageNums.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${content} 0 R >>`))}objs[catalog-1]=`<< /Type /Catalog /Pages ${pages} 0 R >>`;objs[pages-1]=`<< /Type /Pages /Kids [${pageNums.map(n=>n+' 0 R').join(' ')}] /Count ${pageNums.length} >>`;let pdf='%PDF-1.4\n';for(let i=0;i<objs.length;i++){offsets[i]=Buffer.byteLength(pdf,'binary');pdf+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`}const xref=Buffer.byteLength(pdf,'binary');pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;for(let i=0;i<objs.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objs.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(pdf,'binary')}
}
function pdfHeader(p,title){p.text(42,808,currentSchoolName(),18,true);p.text(42,789,currentSchoolMotto(),9,true);p.text(42,773,String(currentSchoolAddress()).replace(/\|/g,'  |  '),7);p.line(42,760,553,760,1.2);p.text(42,738,title,14,true);p.used=112}
function pdfMeta(p,items){let x=42,y=716;for(let i=0;i<items.length;i++){const col=i%2,row=Math.floor(i/2);x=42+col*256;y=716-row*26;p.text(x,y,`${items[i][0]}: ${items[i][1]}`,8)}p.used+=Math.ceil(items.length/2)*26+10}
function pdfTable(p,x,y,w,headers,rows,colWidths){const rowH=20;const widths=colWidths||headers.map(()=>w/headers.length);let cy=y;p.rect(x,cy-rowH,w,rowH,true);let cx=x;headers.forEach((h,i)=>{p.text(cx+4,cy-14,h,7,true);cx+=widths[i]});cy-=rowH;for(const row of rows){if(p.addPageIfNeeded(rowH+10)){cy=790;p.text(x,cy,'(continued)',8,true);cy-=10}p.line(x,cy,x+w,cy,.45);cx=x;row.forEach((v,i)=>{p.text(cx+4,cy-14,String(v??'').slice(0,Math.max(8,Math.floor(widths[i]/4.6))),7);cx+=widths[i]});cy-=rowH}p.line(x,cy,x+w,cy,.45);return cy}
function pdfGroupedBars(p,x,y,w,h,subjects,exams){const left=34,bottom=28,top=10,plotW=w-left-6,plotH=h-bottom-top;for(let k=0;k<=4;k++){const yy=y+bottom+(plotH*k/4);p.line(x+left,yy,x+w,yy,.35);p.text(x+2,yy-3,String(k*25),6)}const groupW=subjects.length?plotW/subjects.length:plotW,barGap=2,barsPer=exams.length||1,barW=Math.max(3,Math.min(12,(groupW-8-(barsPer-1)*barGap)/barsPer));subjects.forEach((sub,si)=>{const gx=x+left+si*groupW+(groupW-(barsPer*barW+(barsPer-1)*barGap))/2;exams.forEach((e,ei)=>{const v=Number(sub.values?.[e.id]||0),bh=plotH*Math.max(0,Math.min(100,v))/100;p.fillRect(gx+ei*(barW+barGap),y+bottom,barW,bh,0.72-0.08*ei);p.text(gx+ei*(barW+barGap),y+bottom+bh+3,String(Math.round(v)),5)});p.text(gx,y+8,String(sub.name||'').slice(0,10),5)});p.line(x+left,y+bottom,x+w,y+bottom,.8);p.line(x+left,y+bottom,x+left,y+bottom+plotH,.8);let lx=x+w-125,ly=y+h-8;exams.forEach((e,i)=>{p.fillRect(lx+i*55,ly,7,7,0.72-0.08*i);p.text(lx+10+i*55,ly+1,String(e.name||'').slice(0,9),6)})}
function pdfLineChart(p,x,y,w,h,values){const left=34,bottom=28,top=10,plotW=w-left-6,plotH=h-bottom-top;p.line(x+left,y+bottom,x+w,y+bottom,.8);p.line(x+left,y+bottom,x+left,y+bottom+plotH,.8);for(let k=0;k<=4;k++){const yy=y+bottom+(plotH*k/4);p.line(x+left,yy,x+w,yy,.35);p.text(x+2,yy-3,String(k*25),6)}if(!values.length)return;const pts=values.map((v,i)=>[x+left+(values.length===1?plotW/2:i*plotW/(values.length-1)),y+bottom+plotH*Math.max(0,Math.min(100,Number(v.value||0)))/100]);p.strokePath(pts,1.8);pts.forEach((pt,i)=>{p.circle(pt[0],pt[1],2.5,true);p.text(pt[0]-10,pt[1]+6,String(Math.round(Number(values[i].value||0))),5);p.text(pt[0]-16,y+8,String(values[i].label||'').slice(0,10),5)})}
function buildTermReportPdf(data){
  const p=new SimplePdf();
  const title=`TERM REPORT — ${String(data.term).toUpperCase()} ${data.year}`;
  pdfHeader(p,title);
  pdfMeta(p,[['Learner',data.student.full_name],['Admission No.',data.student.admission_no],['Class',data.student.class_name],['Academic Year',data.year],['Term',data.term],['Class Teacher',data.classTeacher||'________________']]);
  let y=635;
  p.text(42,y,'TERM ASSESSMENT REPORT',10,true);y-=12;
  const headers=['LEARNING AREA',...data.exams.map(e=>data.examLabels[e.id]||e.name),'AVERAGE'];
  const tableRows=data.subjects.map(s=>[s.name,...data.exams.map(e=>s.values[e.id]===undefined?'—':Number(s.values[e.id]).toFixed(0)),Number(s.average||0).toFixed(1)+'%']);
  const examWidth=Math.max(42,Math.min(105,(511-135-65)/Math.max(1,data.exams.length)));
  const widths=[135,...data.exams.map(()=>examWidth),65];
  y=pdfTable(p,42,y,511,headers,tableRows,widths)-24;
  if(y<255){p.newPage();pdfHeader(p,title+' — continued');y=710;}
  p.text(42,y,'PERFORMANCE & PROGRESS',10,true);y-=14;
  p.text(42,y,'Subject performance by assessment',8,true);
  const chartH=205;
  pdfGroupedBars(p,42,y-chartH-8,511,chartH,data.subjects,data.exams);
  p.newPage();pdfHeader(p,title+' — continued');y=710;
  p.text(42,y,'OVERALL PROGRESS ACROSS ASSESSMENTS',10,true);y-=12;
  pdfLineChart(p,42,y-175,511,175,data.averages);y-=205;
  p.text(42,y,`Overall recorded average: ${Number(data.overallAvg||0).toFixed(1)}%    Assessments: ${data.exams.length}`,8,true);y-=28;
  p.text(42,y,'COMMENTS & REMARKS',10,true);y-=16;
  const comments=data.comments||[];
  if(comments.length){
    for(const c of comments){
      for(const line of pdfWrap(c,95)){
        if(y<90){p.newPage();pdfHeader(p,title+' — continued');y=710;p.text(42,y,'COMMENTS & REMARKS — CONTINUED',10,true);y-=16;}
        p.text(42,y,line,8);y-=12;
      }
    }
  }else{
    for(const label of ['Class Teacher comment:','Head Teacher remarks:','Parent/Guardian comment:']){p.text(42,y,label+' _________________________________________________',8);y-=28;}
  }
  y=Math.max(55,y-8);p.line(42,y,553,y,.6);y-=22;
  p.text(55,y,'Class Teacher: ____________________',8);p.text(240,y,'School Stamp',8);p.text(430,y,'Principal / Director',8);
  return p.finalize();
}
function docPage(title,content){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(currentSchoolName())} - ${esc(title)}</title><style>*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f4f7f6;color:#172033;line-height:1.35}.page{max-width:1100px;margin:22px auto;background:#fff;padding:30px 34px;border:3px double #4d625b;box-shadow:0 12px 32px rgba(17,45,35,.08)}.school-head{text-align:center;border:0;padding:18px 18px 14px;margin-bottom:22px}.brand{display:flex;align-items:center;justify-content:center;gap:18px}.brand img{width:88px;height:88px;object-fit:contain}.brand h1{margin:0 0 5px;color:#0b4ea2;font-size:26px;letter-spacing:.3px}.motto{font-weight:800;color:#a87900;letter-spacing:1px;margin:2px 0 7px}.address{color:#5f6c73;font-size:13px;display:flex;flex-wrap:wrap;justify-content:center;gap:3px 12px}.address span{white-space:nowrap}.school-head h2{margin:15px 0 0;color:#27343b;font-size:19px;letter-spacing:.5px}h3{color:#0b4ea2;margin:0 0 10px}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0 18px}.meta .item{border-bottom:1px dotted #7f8b8e;padding:5px 3px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.box{background:#f5faf7;border:1px solid #cfe1d9;border-radius:10px;padding:12px;min-height:72px}.box b{font-size:18px;color:#0b4ea2}.section{border:1px solid #d8e4df;border-radius:12px;padding:16px;margin:18px 0;background:#fff}.section-title{font-size:15px;font-weight:700;color:#0b4ea2;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th,td{border:1px solid #aebdb8;padding:7px 6px;vertical-align:middle}th{background:#e8f3ee;color:#0b4ea2;font-weight:700}tbody tr:nth-child(even){background:#fbfcfc}.center{text-align:center}.right{text-align:right}.muted{color:#69777b}.bar{height:10px;background:#e6ece9;border-radius:99px;overflow:hidden}.bar>span{display:block;height:100%;background:#2563eb;border-radius:99px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}.chart{width:100%;overflow:hidden}.sign{margin-top:34px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.sign span{border-top:1px solid #555;padding-top:7px;text-align:center}.note{font-size:11px;color:#687478}.developer-credit{margin-top:10px;text-align:center;font-size:10px;color:#687478;display:flex;flex-direction:column;gap:2px}.developer-number{font-weight:800;color:#0b4ea2;letter-spacing:.3px}.footerline{margin-top:24px;border-top:1px solid #ccd7d3;padding-top:10px;font-size:11px;color:#6a7778;display:flex;justify-content:space-between;gap:20px}@media(max-width:700px){.page{margin:0;padding:15px}.meta,.summary,.grid2,.sign{grid-template-columns:1fr 1fr}.brand{flex-direction:column}.brand h1{font-size:21px}table{font-size:10px}th,td{padding:5px 3px}}@page{size:A4 portrait;margin:0}.result-slip{font-size:8.5px;line-height:1.12}.result-slip .meta{gap:3px;margin:3px 0 5px}.result-slip .meta .item{padding:2px}.result-slip .section{padding:5px;margin:5px 0;border-radius:4px}.result-slip .section-title{font-size:10px;margin-bottom:3px}.result-slip .summary{gap:3px;margin:4px 0}.result-slip .box{padding:4px;min-height:34px;border-radius:3px}.result-slip .box b{font-size:11px}.result-slip table{font-size:7.5px;margin:4px 0}.result-slip th,.result-slip td{padding:2.5px 2px}.result-slip .note{font-size:6.5px}.result-slip .grid2{gap:4px}.result-slip .chart{height:90px}.result-slip .chart svg{height:90px!important}.result-slip .sign{margin-top:8px;gap:7px}.result-slip .sign span{padding-top:3px}.result-slip p{margin:2px 0}.result-slip .section:nth-of-type(3) table{font-size:7px}.result-slip .section:nth-of-type(3) .chart{display:block;height:165px}.result-slip .section:nth-of-type(3) .grid2{display:block}.result-slip .section:nth-of-type(4){break-before:page;page-break-before:always}.result-slip .section:nth-of-type(4) .chart{height:175px}.result-slip .section:nth-of-type(4) table{font-size:7px}.result-slip .section:nth-of-type(5){padding-top:5px;padding-bottom:5px}.result-slip~.footerline,.result-slip~.developer-credit,.result-slip~.no-print{display:none!important}@media print{html,body{background:#fff;margin:0;padding:0}body::before{content:"";position:fixed;inset:5mm;border:2px double #4d625b;pointer-events:none;z-index:9999}.page{margin:0;box-shadow:none;border:0;max-width:none;padding:11mm 12mm 10mm}.no-print{display:none!important}.section{break-inside:avoid}.chart{break-inside:avoid}.compact-report{padding:5px;margin:5px 0}.compact-report table{font-size:8px;margin:4px 0}.compact-report th,.compact-report td{padding:2.5px 2px}.compact-report .section-title{margin-bottom:3px}.compact-report .chart{height:165px}.compact-report p{margin:3px 0}.result-slip~.footerline,.result-slip~.developer-credit{display:none!important}}button{padding:10px 15px;background:#0b63ce;color:#fff;border:0;border-radius:7px}</style></head><body><main class="page">${docHeader(title)}${content}<div class="footerline"><span>Prepared by: ____________________</span><span>Date: ${new Date().toLocaleDateString()}</span></div><div class="developer-credit">${DEVELOPER_NUMBER?`<span class="developer-number">${esc(DEVELOPER_NUMBER)}</span>`:""}<span>Platform provider: ${esc(DEVELOPER_NAME)}${DEVELOPER_EMAIL?` | ${esc(DEVELOPER_EMAIL)}`:""}${DEVELOPER_WEBSITE?` | ${esc(DEVELOPER_WEBSITE)}`:""}</span></div><div class="no-print" style="display:flex;gap:8px;margin-top:16px"><button onclick="history.back()">← Back</button><button onclick="window.print()">Print / Save as PDF</button></div></main></body></html>`}
function svgBarChart(items,width=760,height=250){const max=Math.max(1,...items.map(x=>Number(x.value)||0));const pad={l:44,r:15,t:22,b:48},iw=width-pad.l-pad.r,ih=height-pad.t-pad.b;const bw=Math.max(18,iw/Math.max(1,items.length)*.62);const gap=iw/Math.max(1,items.length);const bars=items.map((x,i)=>{const v=Number(x.value)||0,h=(v/max)*ih,y=pad.t+ih-h,xx=pad.l+i*gap+(gap-bw)/2;return `<rect x="${xx.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="#2563eb"/><text x="${(xx+bw/2).toFixed(1)}" y="${Math.max(13,y-5).toFixed(1)}" text-anchor="middle" font-size="11" fill="#33423d">${esc(String(x.value))}</text><text x="${(xx+bw/2).toFixed(1)}" y="${height-26}" text-anchor="middle" font-size="10" fill="#4f5d59">${esc(x.label)}</text>`}).join('');return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bar chart"><line x1="${pad.l}" y1="${pad.t+ih}" x2="${width-pad.r}" y2="${pad.t+ih}" stroke="#9aa8a3"/><line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t+ih}" stroke="#9aa8a3"/>${bars}</svg>`}
function svgGroupedBarChart(subjects,exams,width=760,height=270){const pad={l:48,r:18,t:28,b:58},iw=width-pad.l-pad.r,ih=height-pad.t-pad.b,max=100,groupW=iw/Math.max(1,subjects.length),bars=exams.length||1,barW=Math.max(6,Math.min(22,(groupW-14-(bars-1)*3)/bars));const grid=[0,25,50,75,100].map(v=>{const y=pad.t+ih-(v/max)*ih;return `<line x1="${pad.l}" y1="${y}" x2="${width-pad.r}" y2="${y}" stroke="#d8e2de"/><text x="${pad.l-8}" y="${y+4}" text-anchor="end" font-size="10" fill="#5f6c73">${v}</text>`}).join('');const groups=subjects.map((sub,si)=>{const total=bars*barW+(bars-1)*3,gx=pad.l+si*groupW+(groupW-total)/2;const rects=exams.map((e,ei)=>{const v=Number(sub.values?.[e.id]||0),bh=(v/max)*ih,y=pad.t+ih-bh,x=gx+ei*(barW+3);return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="#2563eb" opacity="${(0.55+0.12*ei).toFixed(2)}"/><text x="${(x+barW/2).toFixed(1)}" y="${Math.max(16,y-4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#33423d">${Math.round(v)}</text>`}).join('');return rects+`<text x="${(pad.l+si*groupW+groupW/2).toFixed(1)}" y="${height-27}" text-anchor="middle" font-size="10" fill="#4f5d59">${esc(learningAreaShortName(sub.name)||sub.name.slice(0,10))}</text>`}).join('');const legend=exams.map((e,i)=>`<rect x="${width-170+i*55}" y="8" width="9" height="9" fill="#2563eb" opacity="${(0.55+0.12*i).toFixed(2)}"/><text x="${width-157+i*55}" y="16" font-size="9" fill="#4f5d59">${esc(e.name)}</text>`).join('');return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Subject performance grouped bar chart">${grid}<line x1="${pad.l}" y1="${pad.t+ih}" x2="${width-pad.r}" y2="${pad.t+ih}" stroke="#9aa8a3"/>${groups}${legend}</svg>`}
function svgLineChart(items,width=760,height=250){const vals=items.map(x=>Number(x.value)||0),max=Math.max(1,...vals),min=Math.min(0,...vals),pad={l:42,r:18,t:22,b:48},iw=width-pad.l-pad.r,ih=height-pad.t-pad.b,step=iw/Math.max(1,items.length-1);const pts=items.map((x,i)=>{const xx=pad.l+(items.length===1?iw/2:i*step),yy=pad.t+ih-((Number(x.value)-min)/(max-min||1))*ih;return {x:xx,y:yy,label:x.label,value:x.value}});const path=pts.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');const nodes=pts.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" fill="#2563eb"/><text x="${p.x}" y="${p.y-9}" text-anchor="middle" font-size="10" fill="#33423d">${Number(p.value).toFixed(1)}%</text><text x="${p.x}" y="${height-26}" text-anchor="middle" font-size="10" fill="#4f5d59">${esc(p.label)}</text>`).join('');return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Progress line chart"><line x1="${pad.l}" y1="${pad.t+ih}" x2="${width-pad.r}" y2="${pad.t+ih}" stroke="#9aa8a3"/><line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t+ih}" stroke="#9aa8a3"/><path d="${path}" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${nodes}</svg>`}
function learningAreaShortName(name){
  const n=String(name||'').trim().toLowerCase().replace(/\s+/g,' ');
  const exact={
    'mathematics':'MAT',
    'math':'MAT',
    'english':'ENG',
    'kiswahili':'KSW',
    'swahili':'KSW',
    'creative arts':'C/A',
    'creative arts and sports':'C/A',
    'integrated science':'I/SCI',
    'science and technology':'SCI',
    'science':'SCI',
    'social studies':'SST',
    'agriculture':'AGR',
    'business studies':'B/ST',
    'computer studies':'C/S',
    'computer science':'C/S',
    'christian religious education':'CRE',
    'christian religious studies':'CRE',
    'islamic religious education':'IRE',
    'islamic religious studies':'IRE',
    'religious education':'R/E',
    'life skills education':'LSE',
    'life skills':'LSE',
    'pre-technical studies':'P/TECH',
    'pre technical studies':'P/TECH',
    'home science':'H/S',
    'music':'MUS',
    'physical education':'P.E.'
  };
  if(exact[n]) return exact[n];
  const words=n.split(/[^a-z0-9]+/).filter(Boolean);
  if(!words.length) return '';
  if(words.length===1) return words[0].slice(0,4).toUpperCase();
  const initials=words.map(w=>w[0]).join('').toUpperCase();
  return initials.slice(0,5);
}

function gradeStats(rows){const out={EE:0,ME:0,AE:0,BE:0};for(const r of rows){if(out[r.grade]!==undefined)out[r.grade]++}return out}
function gradeCards(stats,total){return `<div class="summary">${CBC_LEVELS.map(x=>{const n=stats[x.code]||0,p=total?((n/total)*100):0;return `<div class="box"><b>${x.code}</b><br><span>${x.label}</span><br><strong>${n}</strong> entries <span class="muted">(${p.toFixed(1)}%)</span><div class="bar"><span style="width:${p.toFixed(1)}%"></span></div></div>`}).join('')}</div>`}
function subjectAnalysisTable(rows){return `<table><tr><th>Learning Area</th><th>Entries</th><th>Mean %</th><th>EE</th><th>ME</th><th>AE</th><th>BE</th><th>Performance</th></tr>${rows.map(x=>{const mean=Number(x.average)||0;return `<tr><td>${esc(x.name)}</td><td class="center">${x.entries}</td><td class="center"><b>${mean.toFixed(1)}</b></td><td class="center">${x.ee}</td><td class="center">${x.me}</td><td class="center">${x.ae}</td><td class="center">${x.be}</td><td><div class="bar"><span style="width:${Math.min(100,Math.max(0,mean)).toFixed(1)}%"></span></div></td></tr>`}).join('')}</table>`}


app.get("/api/health",async(req,res)=>{try{await platform.ready;res.json({ok:true,provider:"O'LIVE TECH",version:APP_VERSION})}catch(e){res.status(500).json({ok:false,error:e.message})}});
app.get("/api/school-config",(req,res)=>res.json({school:currentSchoolName(),address:SCHOOL_ADDRESS,payment_number:currentSchoolPaymentNumber(),subscription_till:SUBSCRIPTION_TILL_NUMBER}));

app.get("/api/developer-setup/status",adminOnly,async(req,res)=>{
  res.json({configured:!!(LICENSE_SERVER_URL&&LICENSE_KEY&&LICENSE_INSTALL_SECRET),enforcement:LICENSE_ENFORCEMENT,server_url:LICENSE_SERVER_URL,license_key:LICENSE_KEY,has_install_secret:!!LICENSE_INSTALL_SECRET});
});
app.post("/api/developer-setup/configure",adminOnly,async(req,res)=>{
  try{
    const x=req.body||{},url=String(x.server_url||"").trim().replace(/\/$/,""),key=String(x.license_key||"").trim(),secret=String(x.install_secret||"").trim();
    if(!/^https?:\/\//i.test(url))return res.status(400).json({error:"Licensing server URL must start with http:// or https://"});
    if(!key||!secret)return res.status(400).json({error:"License key and installation secret are required"});
    const cfg=writeLicenseConfig({server_url:url,license_key:key,install_secret:secret,enforcement:x.enforcement!==false});
    LICENSE_CFG=cfg;LICENSE_SERVER_URL=cfg.server_url;LICENSE_KEY=cfg.license_key;LICENSE_INSTALL_SECRET=cfg.install_secret;LICENSE_ENFORCEMENT=cfg.enforcement;
    cachedLicense=null;await syncLicense();
    res.json({ok:true,configured:true,enforcement:LICENSE_ENFORCEMENT,server_url:LICENSE_SERVER_URL,license_key:LICENSE_KEY,license:subscriptionStatus().license});
  }catch(e){res.status(400).json({error:e.message})}
});
app.post("/api/developer-setup/create-admin",adminOnly,async(req,res)=>{
  try{
    if(!LICENSE_SERVER_URL)return res.status(400).json({error:"Configure the licensing server URL first"});
    const x=req.body||{},username=String(x.username||"").trim(),password=String(x.password||""),full_name=String(x.full_name||"").trim();
    if(!username||!full_name||password.length<12)return res.status(400).json({error:"Developer username, full name and a password of at least 12 characters are required"});
    const r=await fetch(`${LICENSE_SERVER_URL}/api/setup/first-admin`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username,password,full_name}),signal:AbortSignal.timeout(15000)});
    const d=await r.json().catch(()=>({}));if(!r.ok)return res.status(r.status).json(d);res.status(201).json(d);
  }catch(e){res.status(502).json({error:"Unable to contact the developer licensing server: "+e.message})}
});
app.get("/api/config",(req,res)=>res.json({school_name:currentSchoolName(),developer_name:DEVELOPER_NAME,developer_number:DEVELOPER_NUMBER,developer_email:DEVELOPER_EMAIL,developer_website:DEVELOPER_WEBSITE}));

// Login verifies both credentials and the account type selected on the login screen.
const loginAttempts=new Map();
function loginRateLimit(req,res,next){
  const key=String(req.ip||req.socket.remoteAddress||'unknown'); const now=Date.now(); const windowMs=15*60*1000, max=10;
  let x=loginAttempts.get(key); if(!x||now-x.started>windowMs)x={started:now,count:0}; x.count++; loginAttempts.set(key,x);
  if(x.count>max)return res.status(429).json({error:'Too many login attempts. Please wait 15 minutes and try again.'});
  next();
}
app.post("/api/auth/login",loginRateLimit,async(req,res)=>{try{const username=String(req.body.username||"").trim(),password=String(req.body.password||""),selectedRole=normalizeRole(req.body.role);if(!username||!password)return res.status(400).json({error:"Username and password are required"});const r=await pool.query("SELECT * FROM users WHERE username=$1",[username]);const u=r.rows[0];if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:"Invalid username or password"});if(selectedRole&&normalizeRole(u.role)!==selectedRole)return res.status(403).json({error:`Selected account is ${selectedRole}, but this username belongs to ${normalizeRole(u.role)}. Please use Change and select the correct account.`});const token=jwt.sign({id:u.id,role:u.role,school_id:req.platformSchool?.school_id},JWT_SECRET,{expiresIn:"24h"});await audit(u.id,"LOGIN",`role=${u.role}`);loginAttempts.delete(String(req.ip||req.socket.remoteAddress||'unknown'));res.json({token,school_id:req.platformSchool?.school_id,user:{id:u.id,username:u.username,full_name:u.full_name,role:u.role,phone:u.phone,email:u.email}})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/me",auth(),(req,res)=>res.json(req.user));

// Dashboard summary / analytics
app.get("/api/dashboard",auth(),async(req,res)=>{try{const [u,s,e,p,a]=await Promise.all([pool.query("SELECT COUNT(*)::int n FROM users"),pool.query("SELECT COUNT(*)::int n FROM students"),pool.query("SELECT COUNT(*)::int n FROM exams"),pool.query("SELECT COALESCE(SUM(amount),0) n FROM fee_records"),pool.query("SELECT COUNT(*)::int n FROM assets")]);res.json({users:u.rows[0].n,students:s.rows[0].n,exams:e.rows[0].n,fees_received:Number(p.rows[0].n),assets:a.rows[0].n})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/analytics/overview",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const [fees,charges,exp,marks,students]=await Promise.all([pool.query("SELECT COALESCE(SUM(amount),0) n FROM fee_records"),pool.query("SELECT COALESCE(SUM(amount),0) n FROM fee_charges"),pool.query("SELECT COALESCE(SUM(amount),0) n FROM expenditures"),pool.query("SELECT COUNT(*)::int n,COALESCE(AVG(marks),0) avg FROM marks"),pool.query("SELECT COUNT(*)::int n FROM students")]);res.json({students:students.rows[0].n,feesPaid:Number(fees.rows[0].n),feesCharged:Number(charges.rows[0].n),balance:Number(charges.rows[0].n)-Number(fees.rows[0].n),expenditure:Number(exp.rows[0].n),marksEntered:marks.rows[0].n,averageMarks:Number(marks.rows[0].avg||0)})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/analytics/fees",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const rows=(await pool.query(`SELECT s.class_name,COUNT(DISTINCT s.id)::int students,COALESCE(SUM(c.charged),0) charged,COALESCE(SUM(p.paid),0) paid FROM students s LEFT JOIN (SELECT student_id,SUM(amount) charged FROM fee_charges GROUP BY student_id)c ON c.student_id=s.id LEFT JOIN (SELECT student_id,SUM(amount) paid FROM fee_records GROUP BY student_id)p ON p.student_id=s.id GROUP BY s.class_name ORDER BY ${classOrderSql("s")}`)).rows;res.json(rows.map(x=>({...x,charged:Number(x.charged),paid:Number(x.paid),balance:Number(x.charged)-Number(x.paid)})))}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/analytics/exams/:examId",auth(["admin","director","principal","teacher","secretary"]),async(req,res)=>{try{
  const examId=Number(req.params.examId);
  if(!examId)return res.status(400).json({error:"Exam is required"});
  let byClass,bySubject;
  if(req.user.role==='teacher'){
    byClass=(await pool.query(`SELECT s.class_name,COUNT(DISTINCT s.id)::int students,COUNT(m.id)::int marks,ROUND(COALESCE(AVG(m.marks),0),2) average,COUNT(*) FILTER(WHERE m.grade='EE')::int ee,COUNT(*) FILTER(WHERE m.grade='ME')::int me,COUNT(*) FILTER(WHERE m.grade='AE')::int ae,COUNT(*) FILTER(WHERE m.grade='BE')::int be FROM students s LEFT JOIN marks m ON m.student_id=s.id AND m.exam_id=$2 WHERE EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$1 AND LOWER(TRIM(ta.class_name))=LOWER(TRIM(s.class_name))) GROUP BY s.class_name ORDER BY ${classOrderSql("s")}`,[req.user.id,examId])).rows;
    bySubject=(await pool.query(`SELECT sub.name,COUNT(m.id)::int entries,ROUND(COALESCE(AVG(m.marks),0),2) average,COUNT(*) FILTER(WHERE m.grade='EE')::int ee,COUNT(*) FILTER(WHERE m.grade='ME')::int me,COUNT(*) FILTER(WHERE m.grade='AE')::int ae,COUNT(*) FILTER(WHERE m.grade='BE')::int be FROM subjects sub LEFT JOIN marks m ON m.subject_id=sub.id AND m.exam_id=$2 LEFT JOIN students sm ON sm.id=m.student_id WHERE EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$1 AND ta.subject_id=sub.id AND (ta.assignment_type='subject' OR (ta.assignment_type='class_teacher' AND (sm.id IS NULL OR LOWER(TRIM(sm.class_name))=LOWER(TRIM(ta.class_name)))))) GROUP BY sub.id,sub.name ORDER BY sub.name`,[req.user.id,examId])).rows;
  } else {
    byClass=(await pool.query(`SELECT s.class_name,COUNT(DISTINCT s.id)::int students,COUNT(m.id)::int marks,ROUND(COALESCE(AVG(m.marks),0),2) average,COUNT(*) FILTER(WHERE m.grade='EE')::int ee,COUNT(*) FILTER(WHERE m.grade='ME')::int me,COUNT(*) FILTER(WHERE m.grade='AE')::int ae,COUNT(*) FILTER(WHERE m.grade='BE')::int be FROM students s LEFT JOIN marks m ON m.student_id=s.id AND m.exam_id=$1 GROUP BY s.class_name ORDER BY ${classOrderSql("s")}`,[examId])).rows;
    bySubject=(await pool.query(`SELECT sub.name,COUNT(m.id)::int entries,ROUND(COALESCE(AVG(m.marks),0),2) average,COUNT(*) FILTER(WHERE m.grade='EE')::int ee,COUNT(*) FILTER(WHERE m.grade='ME')::int me,COUNT(*) FILTER(WHERE m.grade='AE')::int ae,COUNT(*) FILTER(WHERE m.grade='BE')::int be FROM subjects sub LEFT JOIN marks m ON m.subject_id=sub.id AND m.exam_id=$1 GROUP BY sub.id,sub.name ORDER BY sub.name`,[examId])).rows;
  }
  res.json({byClass,bySubject});
}catch(e){res.status(500).json({error:e.message})}});

// User administration - Admin is the school's full management role.
app.get("/api/users",adminOnly,async(req,res)=>res.json((await pool.query("SELECT id,username,full_name,role,phone,email,active,created_at FROM users ORDER BY role,full_name")).rows));
app.post("/api/users",adminOnly,async(req,res)=>{try{const username=String(req.body.username||"").trim(),password=String(req.body.password||""),full_name=String(req.body.full_name||"").trim(),role=normalizeRole(req.body.role),phone=String(req.body.phone||"").trim(),email=String(req.body.email||"").trim();if(!username||!password||!full_name||!role)return res.status(400).json({error:"Username, password, full name and account role are required."});if(!ROLE_PAGES.includes(role))return res.status(400).json({error:`Invalid account role. Supported roles: ${ROLE_PAGES.join(", ")}.`});if(password.length<6)return res.status(400).json({error:"Password must be at least 6 characters."});const existing=await pool.query("SELECT id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1",[username]);if(existing.rows[0])return res.status(409).json({error:"That username is already in use. Choose another username."});const hash=await bcrypt.hash(password,12);const r=await pool.query("INSERT INTO users(username,password_hash,full_name,role,phone,email) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,username,full_name,role,phone,email,active",[username,hash,full_name,role,phone||null,email||null]);await audit(req.user.id,"CREATE_USER",`${username} role=${role}`);res.status(201).json(r.rows[0])}catch(e){if(e.code==='23505')return res.status(409).json({error:"That username or email is already in use."});res.status(400).json({error:e.message})}});
app.patch("/api/users/:id",adminOnly,async(req,res)=>{try{const id=req.params.id;if(String(req.user.id)===String(id)&&req.body.active===false)return res.status(400).json({error:"Admin cannot deactivate the current account"});const fields=[],vals=[];for(const key of ["full_name","role","phone","email","active"]){if(req.body[key]!==undefined){
  if(key==='role'){
    const normalized=normalizeRole(req.body[key]);
    if(!ROLE_PAGES.includes(normalized))return res.status(400).json({error:`Invalid account role. Supported roles: ${ROLE_PAGES.join(", ")}.`});
    fields.push(`${key}=$${vals.length+1}`);vals.push(normalized);
  }else{fields.push(`${key}=$${vals.length+1}`);vals.push(req.body[key])}
}}if(req.body.password){fields.push(`password_hash=$${vals.length+1}`);vals.push(await bcrypt.hash(req.body.password,12))}if(!fields.length)return res.status(400).json({error:"Nothing to update"});vals.push(id);const r=await pool.query(`UPDATE users SET ${fields.join(",")} WHERE id=$${vals.length} RETURNING id,username,full_name,role,phone,email,active`,vals);if(!r.rows[0])return res.status(404).json({error:"User not found"});res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/users/:id",adminOnly,async(req,res)=>{try{if(String(req.user.id)===String(req.params.id))return res.status(400).json({error:"You cannot delete your current account"});await pool.query("DELETE FROM users WHERE id=$1",[req.params.id]);res.json({message:"User deleted"})}catch(e){res.status(400).json({error:e.message})}});

// Students - Administration can manage the whole school. A class teacher can manage only the learners in assigned class(es).
app.get("/api/my/class-teacher-classes",auth(["teacher"]),async(req,res)=>{const r=await pool.query("SELECT DISTINCT class_name FROM teacher_assignments WHERE teacher_id=$1 AND assignment_type='class_teacher' AND class_name IS NOT NULL ORDER BY class_name",[req.user.id]);res.json(r.rows.map(x=>x.class_name))});
app.get("/api/students",auth(["admin","teacher","worker","secretary","director","principal"]),async(req,res)=>{const q=req.query.q?`%${req.query.q}%`:"%";let vals=[q],where=`(s.full_name ILIKE $1 OR s.admission_no ILIKE $1)`;if(req.user.role==='teacher'){vals.push(req.user.id);if(req.query.subject_id){vals.push(Number(req.query.subject_id));where+=` AND EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$${vals.length-1} AND ta.subject_id=$${vals.length} AND ta.assignment_type='subject' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM(s.class_name)))`}else{where+=` AND EXISTS (SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$${vals.length} AND ta.assignment_type='class_teacher' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM(s.class_name)))`}if(req.query.class_name){vals.push(req.query.class_name);where+=` AND LOWER(TRIM(s.class_name))=LOWER(TRIM($${vals.length}))`}}const rows=await pool.query(`SELECT s.*,${classOrderSql("s")} class_order FROM students s WHERE ${where} ORDER BY class_order,s.full_name`,vals);res.json(rows.rows)});
app.get("/api/students/:id",auth(),async(req,res)=>{const r=await pool.query("SELECT * FROM students WHERE id=$1",[req.params.id]);const student=r.rows[0];if(!student)return res.status(404).json({error:"Student not found"});if(req.user.role==='parent'&&String(student.parent_phone||'')!==String(req.user.phone||'')&&String(student.parent_name||'')!==String(req.user.full_name||''))return res.status(403).json({error:"This learner is not linked to your parent account."});if(req.user.role==='student'&&Number(student.user_id||0)!==Number(req.user.id))return res.status(403).json({error:"This learner is not linked to your student account."});if(req.user.role==='teacher'&&!(await isClassTeacher(req.user.id,student.class_name)))return res.status(403).json({error:"You can only access learners in your assigned class."});if(!['admin','director','principal','secretary','worker','teacher','parent','student'].includes(req.user.role))return res.status(403).json({error:"Access denied"});res.json(student)});
app.post("/api/students",auth(["admin","secretary","worker","teacher"]),async(req,res)=>{try{const x=req.body;const className=normalizeClass(x.class_name);if(req.user.role==='teacher'&&!(await isClassTeacher(req.user.id,className)))return res.status(403).json({error:"Only the class teacher can register learners for this class."});if(!x.admission_no||!x.full_name||!className)return res.status(400).json({error:"Admission number, student name and class are required."});const r=await pool.query(`INSERT INTO students(admission_no,full_name,gender,date_of_birth,class_name,stream,parent_name,parent_phone,user_id,birth_certificate_number,assessment_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[String(x.admission_no).trim(),String(x.full_name).trim(),x.gender||null,x.date_of_birth||null,className,x.stream||null,x.parent_name||null,x.parent_phone||null,x.user_id||null,x.birth_certificate_number||null,x.assessment_number||null]);await audit(req.user.id,"CREATE_STUDENT",`${x.admission_no} (${className})`);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/students/:id",auth(["admin","secretary","worker","teacher"]),async(req,res)=>{try{const current=(await pool.query("SELECT * FROM students WHERE id=$1",[req.params.id])).rows[0];if(!current)return res.status(404).json({error:"Student not found"});if(req.user.role==='teacher'&&!(await isClassTeacher(req.user.id,current.class_name)))return res.status(403).json({error:"Only the assigned class teacher can edit this learner."});const keys=["admission_no","full_name","gender","date_of_birth","class_name","stream","parent_name","parent_phone","user_id","birth_certificate_number","assessment_number"],f=[],v=[];for(const k of keys)if(req.body[k]!==undefined){let val=req.body[k];if(k==='class_name')val=normalizeClass(val);if(k==='class_name'&&req.user.role==='teacher'&&!(await isClassTeacher(req.user.id,val)))return res.status(403).json({error:"You can only keep the learner in a class assigned to you."});f.push(`${k}=$${v.length+1}`);v.push(val===''?null:val)}if(!f.length)return res.status(400).json({error:"Nothing to update"});v.push(req.params.id);const r=await pool.query(`UPDATE students SET ${f.join(",")} WHERE id=$${v.length} RETURNING *`,v);await audit(req.user.id,"UPDATE_STUDENT",r.rows[0].admission_no);res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/students/:id",auth(["admin","teacher"]),async(req,res)=>{try{const current=(await pool.query("SELECT * FROM students WHERE id=$1",[req.params.id])).rows[0];if(!current)return res.status(404).json({error:"Student not found"});if(req.user.role==='teacher'&&!(await isClassTeacher(req.user.id,current.class_name)))return res.status(403).json({error:"Only the assigned class teacher can delete this learner."});await pool.query("DELETE FROM students WHERE id=$1",[req.params.id]);await audit(req.user.id,"DELETE_STUDENT",current.admission_no);res.json({message:"Student deleted"})}catch(e){res.status(400).json({error:e.message})}});

// Learning areas / subjects. Administration can maintain the master list; teachers only consume it.
const SUBJECT_MANAGER_ROLES=["admin","principal","secretary"];
app.get("/api/subjects",auth(),async(req,res)=>{try{res.set("Cache-Control","private, max-age=30");res.json((await pool.query("SELECT * FROM subjects ORDER BY name")).rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/subjects",auth(SUBJECT_MANAGER_ROLES),async(req,res)=>{try{
  const code=String(req.body.code||"").trim().toUpperCase(),name=String(req.body.name||"").trim(),levels=String(req.body.levels||"").trim(),max=Number(req.body.max_marks||100);
  if(!code||!name)return res.status(400).json({error:"Learning area name and code are required."});
  if(!Number.isFinite(max)||max<=0)return res.status(400).json({error:"Maximum marks must be a positive number."});
  const dup=await pool.query("SELECT id FROM subjects WHERE UPPER(TRIM(code))=$1 OR LOWER(TRIM(name))=LOWER(TRIM($2)) LIMIT 1",[code,name]);
  if(dup.rows[0])return res.status(409).json({error:"A learning area with this code or name already exists."});
  const r=await pool.query("INSERT INTO subjects(code,name,max_marks,levels) VALUES($1,$2,$3,$4) RETURNING *",[code,name,max,levels||null]);
  await audit(req.user.id,"CREATE_LEARNING_AREA",`${code}: ${name}`);res.status(201).json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/subjects/:id",auth(SUBJECT_MANAGER_ROLES),async(req,res)=>{try{
  const id=Number(req.params.id),cur=(await pool.query("SELECT * FROM subjects WHERE id=$1",[id])).rows[0];if(!cur)return res.status(404).json({error:"Learning area not found."});
  const code=req.body.code!==undefined?String(req.body.code||"").trim().toUpperCase():cur.code,name=req.body.name!==undefined?String(req.body.name||"").trim():cur.name,levels=req.body.levels!==undefined?String(req.body.levels||"").trim():cur.levels,max=req.body.max_marks!==undefined?Number(req.body.max_marks):Number(cur.max_marks||100);
  if(!code||!name)return res.status(400).json({error:"Learning area name and code are required."});
  if(!Number.isFinite(max)||max<=0)return res.status(400).json({error:"Maximum marks must be a positive number."});
  const dup=await pool.query("SELECT id FROM subjects WHERE id<>$1 AND (UPPER(TRIM(code))=$2 OR LOWER(TRIM(name))=LOWER(TRIM($3))) LIMIT 1",[id,code,name]);if(dup.rows[0])return res.status(409).json({error:"Another learning area already uses this code or name."});
  const r=await pool.query("UPDATE subjects SET code=$1,name=$2,max_marks=$3,levels=$4 WHERE id=$5 RETURNING *",[code,name,max,levels||null,id]);await audit(req.user.id,"UPDATE_LEARNING_AREA",`${id}: ${code}: ${name}`);res.json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/subjects/:id",auth(["admin"]),async(req,res)=>{try{const r=await pool.query("DELETE FROM subjects WHERE id=$1 RETURNING id,name",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:"Learning area not found."});await audit(req.user.id,"DELETE_LEARNING_AREA",`${r.rows[0].id}: ${r.rows[0].name}`);res.json({message:"Learning area deleted"})}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/exams",auth(),async(req,res)=>res.json((await pool.query("SELECT * FROM exams ORDER BY academic_year DESC,created_at DESC")).rows));
app.post("/api/exams",auth(["admin","teacher","principal","director"]),async(req,res)=>{try{const name=String(req.body.name||"").trim(),term=String(req.body.term||"").trim(),year=Number(req.body.academic_year),date=req.body.exam_date||null;if(!name||!term||!year)return res.status(400).json({error:"Exam name, term and academic year are required"});const r=await pool.query("INSERT INTO exams(name,term,academic_year,exam_date) VALUES($1,$2,$3,$4) RETURNING *",[name,term,year,date]);await audit(req.user.id,"CREATE_EXAM",`${name} ${term} ${year}`);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/exams/:id",auth(["admin","principal","director"]),async(req,res)=>{try{const id=Number(req.params.id),current=(await pool.query("SELECT * FROM exams WHERE id=$1",[id])).rows[0];if(!current)return res.status(404).json({error:"Exam not found"});const name=req.body.name!==undefined?String(req.body.name).trim():current.name,term=req.body.term!==undefined?String(req.body.term).trim():current.term,year=req.body.academic_year!==undefined?Number(req.body.academic_year):current.academic_year,date=req.body.exam_date!==undefined?(req.body.exam_date||null):current.exam_date;if(!name||!term||!year)return res.status(400).json({error:"Exam name, term and academic year are required"});const r=await pool.query("UPDATE exams SET name=$1,term=$2,academic_year=$3,exam_date=$4 WHERE id=$5 RETURNING *",[name,term,year,date,id]);await audit(req.user.id,"UPDATE_EXAM",`${id}: ${name} ${term} ${year}`);res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/exams/:id",auth(["admin","principal","director"]),async(req,res)=>{try{const r=await pool.query("DELETE FROM exams WHERE id=$1 RETURNING id,name",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:"Exam not found"});await audit(req.user.id,"DELETE_EXAM",`${r.rows[0].id}: ${r.rows[0].name}`);res.json({message:"Exam deleted"})}catch(e){res.status(400).json({error:e.message})}});
app.post("/api/marks/bulk",auth(["admin","teacher"]),async(req,res)=>{
  const c=await pool.connect();
  try{
    const examId=Number(req.body.exam_id), subjectId=Number(req.body.subject_id), className=normalizeClass(req.body.class_name);
    if(!examId||!subjectId||!className)return res.status(400).json({error:"Exam, learning area and class are required"});
    const exam=await c.query("SELECT id FROM exams WHERE id=$1",[examId]);
    const subject=await c.query("SELECT id FROM subjects WHERE id=$1",[subjectId]);
    if(!exam.rows[0]||!subject.rows[0])return res.status(404).json({error:"Exam or learning area not found"});
    if(req.user.role==='teacher' && !(await hasSubjectAssignment(req.user.id,subjectId,className)))return res.status(403).json({error:"You are not assigned to this learning area and class"});
    const entries=req.body.entries||[];
    if(!entries.length)return res.status(400).json({error:"No marks supplied"});
    await c.query("BEGIN");
    for(const x of entries){
      const m=Number(x.marks); if(!Number.isFinite(m)||m<0||m>100)continue;
      const st=await c.query("SELECT id,class_name FROM students WHERE id=$1",[x.student_id]);
      if(!st.rows[0])continue;
      if(String(st.rows[0].class_name||'').trim().toLowerCase()!==className.toLowerCase())continue;
      const level=cbcLevel(m);
      await c.query(`INSERT INTO marks(exam_id,student_id,subject_id,marks,grade,teacher_comment) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(exam_id,student_id,subject_id) DO UPDATE SET marks=EXCLUDED.marks,grade=EXCLUDED.grade,teacher_comment=EXCLUDED.teacher_comment`,[examId,x.student_id,subjectId,m,level,x.teacher_comment||null]);
    }
    await c.query("COMMIT");
    await audit(req.user.id,"UPLOAD_MARKS",`exam=${examId},subject=${subjectId},class=${className}`);
    res.json({message:"CBC marks saved successfully",class_name:className});
  }catch(e){await c.query("ROLLBACK");res.status(400).json({error:e.message})}finally{c.release()}
});
app.get("/api/marks",auth(["admin","teacher","director","principal","secretary"]),async(req,res)=>{const {exam_id,subject_id}=req.query;let sql=`SELECT m.*,s.admission_no,s.full_name,s.class_name,sub.name subject FROM marks m JOIN students s ON s.id=m.student_id JOIN subjects sub ON sub.id=m.subject_id WHERE 1=1`,v=[];if(exam_id){v.push(exam_id);sql+=` AND m.exam_id=$${v.length}`}if(subject_id){v.push(subject_id);sql+=` AND m.subject_id=$${v.length}`}if(req.user.role==='teacher'){v.push(req.user.id);sql+=` AND EXISTS(SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$${v.length} AND ta.subject_id=m.subject_id AND ta.assignment_type='subject' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM(s.class_name)))`}sql+=` ORDER BY ${classOrderSql("s")},s.full_name,sub.name`;res.json((await pool.query(sql,v)).rows)});
app.get("/api/results/:examId",auth(["admin","director","principal","secretary","teacher"]),async(req,res)=>{const rows=(await pool.query(`SELECT s.id,s.admission_no,s.full_name,s.class_name,s.stream,COALESCE(SUM(m.marks),0) total,COUNT(m.id)::int subjects,ROUND(COALESCE(AVG(m.marks),0),2) average FROM students s LEFT JOIN marks m ON m.student_id=s.id AND m.exam_id=$1 GROUP BY s.id ORDER BY average DESC,total DESC,full_name`,[req.params.examId])).rows;res.json(rows.map((x,i)=>({...x,position:i+1})))});
app.get("/api/results/:examId/class/:className",auth(["admin","teacher","secretary","principal","director"]),async(req,res)=>{const className=normalizeClass(req.params.className);if(req.user.role==='teacher'&&!(await isClassTeacher(req.user.id,className)))return res.status(403).json({error:"Only the assigned class teacher can view this class result list"});const rows=(await pool.query(`SELECT s.id,s.admission_no,s.full_name,s.class_name,s.stream,COALESCE(SUM(m.marks),0) total,COUNT(m.id)::int subjects,ROUND(COALESCE(AVG(m.marks),0),2) average FROM students s LEFT JOIN marks m ON m.student_id=s.id AND m.exam_id=$1 WHERE LOWER(TRIM(s.class_name))=LOWER(TRIM($2)) GROUP BY s.id ORDER BY average DESC,total DESC,full_name`,[req.params.examId,className])).rows;res.json(rows.map((x,i)=>({...x,position:i+1})))});
app.get("/api/classes",auth(),async(req,res)=>{const rows=(await pool.query(`SELECT class_name FROM students WHERE class_name IS NOT NULL AND TRIM(class_name)<>'' GROUP BY class_name ORDER BY ${classOrderSql('students')},class_name`)).rows;res.json(rows.map(x=>x.class_name))});


// Fees: admin fully manages; secretary records and analyzes; director/principal read.
app.get("/api/fees/:id",auth(),async(req,res)=>{
  if(req.user.role==='parent'){const linked=await pool.query("SELECT 1 FROM students WHERE id=$1 AND (parent_phone=$2 OR parent_name=$3 OR admission_no=$4) LIMIT 1",[req.params.id,req.user.phone,req.user.full_name,req.user.username]);if(!linked.rows[0])return res.status(403).json({error:"This learner is not linked to your parent account."});}
  if(req.user.role==='student'){const linked=await pool.query("SELECT 1 FROM students WHERE id=$1 AND user_id=$2 LIMIT 1",[req.params.id,req.user.id]);if(!linked.rows[0])return res.status(403).json({error:"This learner is not linked to your student account."});}
  const charges=(await pool.query("SELECT * FROM fee_charges WHERE student_id=$1 ORDER BY id",[req.params.id])).rows;
  const payments=(await pool.query("SELECT * FROM fee_records WHERE student_id=$1 ORDER BY transaction_date DESC,id DESC",[req.params.id])).rows;
  const charged=charges.reduce((a,x)=>a+Number(x.amount),0),paid=payments.reduce((a,x)=>a+Number(x.amount),0);res.json({charges,payments,total_charged:charged,total_paid:paid,balance:charged-paid});
});
app.get("/api/fees/summary",auth(["secretary","director","principal","admin"]),async(req,res)=>{try{const r=await pool.query(`WITH c AS (SELECT COALESCE(SUM(amount),0) total FROM fee_charges), p AS (SELECT COALESCE(SUM(amount),0) total FROM fee_records) SELECT (SELECT COUNT(*)::int FROM students) students,c.total charged,p.total paid FROM c,p`);const charged=Number(r.rows[0].charged||0),paid=Number(r.rows[0].paid||0);res.json({students:r.rows[0].students,charged,paid,balance:charged-paid});}catch(e){res.status(500).json({error:e.message})}});
async function applyMonthlyFeeCharges(amount){
  const monthly=Number(amount);
  if(!Number.isFinite(monthly)||monthly<=0)return {amount:0,created:0};
  const now=new Date();
  const term=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const academicYear=now.getFullYear();
  const r=await pool.query(`INSERT INTO fee_charges(student_id,academic_year,term,description,amount)
    SELECT s.id,$1,$2,$3,$4 FROM students s
    WHERE NOT EXISTS (SELECT 1 FROM fee_charges c WHERE c.student_id=s.id AND c.term=$2 AND LOWER(COALESCE(c.description,'')) LIKE 'monthly school fee%')
    RETURNING id`,[academicYear,term,`Monthly school fee - ${term}`,monthly]);
  return {amount:monthly,created:r.rowCount||0,term};
}

app.get("/api/secretary/monthly-fee-settings",auth(["admin","secretary"]),async(req,res)=>{try{const r=await pool.query("SELECT value FROM fee_settings WHERE setting_key='monthly_fee_amount' LIMIT 1");res.json({monthly_amount:Number(r.rows[0]?.value||0)});}catch(e){res.status(500).json({error:e.message})}});
app.put("/api/secretary/monthly-fee-settings",auth(["admin","secretary"]),async(req,res)=>{try{const amount=Number(req.body.monthly_amount);if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:"Enter a valid monthly fee amount greater than zero"});await pool.query("INSERT INTO fee_settings(setting_key,value) VALUES('monthly_fee_amount',$1) ON CONFLICT(setting_key) DO UPDATE SET value=EXCLUDED.value",[String(amount)]);const result=await applyMonthlyFeeCharges(amount);res.json(result);}catch(e){res.status(400).json({error:e.message})}});
app.post("/api/secretary/monthly-fees/run",auth(["admin","secretary"]),async(req,res)=>{try{const r=await pool.query("SELECT value FROM fee_settings WHERE setting_key='monthly_fee_amount' LIMIT 1");const amount=Number(r.rows[0]?.value||0);if(!amount)return res.json({amount:0,created:0});res.json(await applyMonthlyFeeCharges(amount));}catch(e){res.status(400).json({error:e.message})}});

app.post("/api/fees/charges",auth(["secretary"]),async(req,res)=>{try{const x=req.body;const studentId=Number(x.student_id),amount=Number(x.amount);if(!studentId||!Number.isFinite(amount)||amount<=0)return res.status(400).json({error:"Student and a valid amount are required"});const now=new Date(),periodType=String(x.period_type||"monthly").toLowerCase()==="termly"?"termly":"monthly";const feeMonth=periodType==="monthly"?(String(x.fee_month||`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`)):null;const term=periodType==="termly"?String(x.term||"Term 1"):String(x.term||feeMonth);const academicYear=Number(x.academic_year)||now.getFullYear();const description=x.description||`School fees ${periodType}`;const r=await pool.query("INSERT INTO fee_charges(student_id,academic_year,term,description,amount,period_type,fee_month) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[studentId,academicYear,term,description,amount,periodType,feeMonth]);await audit(req.user.id,"CHARGE_STUDENT_FEE",`student_id=${studentId};amount=${amount};term=${term}`);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/fees/charges/:id",auth(["secretary"]),async(req,res)=>{try{const x=req.body,fields=[],vals=[];for(const k of ["student_id","academic_year","term","description","amount","period_type","fee_month"]){if(x[k]!==undefined){fields.push(`${k}=$${vals.length+1}`);vals.push(["student_id","academic_year","amount"].includes(k)?Number(x[k]):x[k])}}if(!fields.length)return res.status(400).json({error:"Nothing to update"});vals.push(req.params.id);const r=await pool.query(`UPDATE fee_charges SET ${fields.join(",")} WHERE id=$${vals.length} RETURNING *`,vals);if(!r.rows[0])return res.status(404).json({error:"Fee charge not found"});await audit(req.user.id,"EDIT_FEE_CHARGE",`id=${req.params.id}`);res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/fees/charges/:id",auth(["secretary"]),async(req,res)=>{try{const r=await pool.query("DELETE FROM fee_charges WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:"Fee charge not found"});await audit(req.user.id,"DELETE_FEE_CHARGE",`id=${req.params.id}`);res.json({message:"Fee charge deleted"})}catch(e){res.status(400).json({error:e.message})}});
app.post("/api/fees/payments",auth(["secretary"]),async(req,res)=>{try{const x=req.body;const receipt=x.receipt_no||`GS-${Date.now()}`;const r=await pool.query("INSERT INTO fee_records(student_id,receipt_no,description,amount,payment_method,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[x.student_id,receipt,x.description||"School fees payment",Number(x.amount),x.payment_method||"Cash",x.reference||null,req.user.id]);await audit(req.user.id,"RECORD_FEE_PAYMENT",receipt);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/fees/records",auth(["admin","secretary","director","principal"]),async(req,res)=>{res.json((await pool.query(`SELECT f.*,s.admission_no,s.full_name,s.class_name,u.full_name creator FROM fee_records f JOIN students s ON s.id=f.student_id LEFT JOIN users u ON u.id=f.created_by ORDER BY f.transaction_date DESC,f.id DESC`)).rows)});
app.patch("/api/fees/records/:id",auth(["secretary"]),async(req,res)=>{try{const keys=['receipt_no','description','amount','payment_method','reference','student_id'],f=[],v=[];for(const k of keys)if(req.body[k]!==undefined){f.push(`${k}=$${v.length+1}`);v.push(k==='amount'||k==='student_id'?Number(req.body[k]):req.body[k])}if(!f.length)return res.status(400).json({error:"Nothing to update"});v.push(req.params.id);const r=await pool.query(`UPDATE fee_records SET ${f.join(',')} WHERE id=$${v.length} RETURNING *`,v);if(!r.rows[0])return res.status(404).json({error:"Fee record not found"});await audit(req.user.id,"EDIT_FEE_RECORD",`id=${req.params.id}`);res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/fees/records/:id",auth(["secretary"]),async(req,res)=>{try{const r=await pool.query("DELETE FROM fee_records WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:"Fee record not found"});await audit(req.user.id,"DELETE_FEE_RECORD",`id=${req.params.id}`);res.json({message:"Fee record deleted"});}catch(e){res.status(400).json({error:e.message})}});


// Secretary office
app.get("/api/secretary/summary",auth(["secretary","admin"]),async(req,res)=>{const [s,f,e]=await Promise.all([pool.query("SELECT COUNT(*)::int n FROM students"),pool.query("SELECT COALESCE(SUM(amount),0) n FROM fee_records"),pool.query("SELECT COALESCE(SUM(amount),0) n FROM expenditures")]);res.json({students:s.rows[0].n,fees_received:Number(f.rows[0].n),expenditure:Number(e.rows[0].n)})});
app.get("/api/secretary/students",auth(["secretary","admin"]),async(req,res)=>{const q=req.query.q?`%${req.query.q}%`:"%";res.json((await pool.query(`SELECT *,${classOrderSql("students")} class_order FROM students WHERE full_name ILIKE $1 OR admission_no ILIKE $1 ORDER BY class_order,full_name`,[q])).rows)});
app.get("/api/whatsapp/contacts",auth(["secretary","admin","director","principal"]),async(req,res)=>{try{const q=String(req.query.q||"").trim();const like=`%${q}%`;const rows=(await pool.query(`SELECT s.id,s.admission_no,s.full_name,s.class_name,s.stream,s.parent_name,s.parent_phone,u.full_name parent_account_name,u.phone parent_account_phone FROM students s LEFT JOIN users u ON u.id=s.user_id AND u.role='parent' WHERE ($1='' OR s.full_name ILIKE $2 OR s.admission_no ILIKE $2 OR COALESCE(s.parent_name,'') ILIKE $2 OR COALESCE(s.parent_phone,'') ILIKE $2) ORDER BY ${classOrderSql('s')},s.full_name`,[q,like])).rows;const seen=new Set(),out=[];for(const x of rows){const phone=String(x.parent_phone||x.parent_account_phone||'').replace(/\D/g,'');const key=phone||`student:${x.id}`;if(!seen.has(key)){seen.add(key);out.push({...x,whatsapp_phone:phone||null})}}res.set('Cache-Control','no-store');res.json(out)}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/secretary/fees",auth(["admin","secretary","director","principal"]),async(req,res)=>{res.json((await pool.query(`SELECT s.id,s.admission_no,s.full_name,s.class_name,COALESCE((SELECT SUM(amount) FROM fee_charges c WHERE c.student_id=s.id),0) charged,COALESCE((SELECT SUM(amount) FROM fee_records p WHERE p.student_id=s.id),0) paid FROM students s ORDER BY ${classOrderSql("s")},s.full_name`)).rows.map(x=>({...x,charged:Number(x.charged),paid:Number(x.paid),balance:Number(x.charged)-Number(x.paid)}))) });
app.get("/api/secretary/fees-entries",auth(["secretary"]),async(req,res)=>{try{const charges=(await pool.query(`SELECT c.id,c.created_at transaction_date,c.student_id,c.academic_year,c.term,c.period_type,c.fee_month,c.description,c.amount,s.admission_no,s.full_name,s.class_name,'charge' entry_type FROM fee_charges c JOIN students s ON s.id=c.student_id ORDER BY c.created_at DESC,c.id DESC`)).rows;const payments=(await pool.query(`SELECT p.id,p.transaction_date,p.student_id,p.receipt_no,p.description,p.amount,p.payment_method,p.reference,s.admission_no,s.full_name,s.class_name,'payment' entry_type FROM fee_records p JOIN students s ON s.id=p.student_id ORDER BY p.transaction_date DESC,p.id DESC`)).rows;res.json([...charges,...payments].sort((a,b)=>new Date(b.transaction_date)-new Date(a.transaction_date)));}catch(e){res.status(500).json({error:e.message})}});

app.get("/api/secretary/expenditures",auth(["secretary","admin"]),async(req,res)=>res.json((await pool.query("SELECT e.*,u.full_name creator FROM expenditures e LEFT JOIN users u ON u.id=e.created_by ORDER BY e.expenditure_date DESC,e.id DESC")).rows));
app.post("/api/secretary/expenditures",auth(["secretary","admin"]),async(req,res)=>{try{const x=req.body;if(!x.description||!x.amount)return res.status(400).json({error:"Description and amount are required"});const r=await pool.query("INSERT INTO expenditures(expenditure_date,category,description,amount,payment_method,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[x.expenditure_date||new Date(),x.category||"General",x.description,Number(x.amount),x.payment_method||"Cash",x.reference||null,req.user.id]);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/secretary/expenditures/:id",auth(["admin"]),async(req,res)=>{await pool.query("DELETE FROM expenditures WHERE id=$1",[req.params.id]);res.json({message:"Expenditure deleted"})});

// Teacher assignments: Admin controls which teacher can enter marks for which class/learning area.
app.get("/api/teacher-assignments",auth(["admin","teacher"]),async(req,res)=>{
  try{
    const where=req.user.role==='teacher'?"WHERE ta.teacher_id=$1":"";
    const vals=req.user.role==='teacher'?[req.user.id]:[];
    const r=await pool.query(`SELECT ta.id,ta.teacher_id,ta.subject_id,ta.class_name,ta.assignment_type,u.full_name teacher_name,s.code subject_code,s.name subject_name FROM teacher_assignments ta JOIN users u ON u.id=ta.teacher_id LEFT JOIN subjects s ON s.id=ta.subject_id ${where} ORDER BY ta.assignment_type,ta.class_name,s.name,u.full_name`,vals);
    res.json(r.rows);
  }catch(e){res.status(500).json({error:e.message})}
});
app.post("/api/teacher-assignments",adminOnly,async(req,res)=>{try{
  const teacherId=Number(req.body.teacher_id), subjectId=req.body.subject_id?Number(req.body.subject_id):null, className=normalizeClass(req.body.class_name), type=req.body.assignment_type==='class_teacher'?'class_teacher':'subject';
  if(!teacherId||!className)return res.status(400).json({error:"Teacher and class are required"});
  if(type==='subject'&&!subjectId)return res.status(400).json({error:"Learning area is required for a subject assignment"});
  const r=await pool.query("INSERT INTO teacher_assignments(teacher_id,subject_id,class_name,assignment_type) VALUES($1,$2,$3,$4) RETURNING *",[teacherId,type==='subject'?subjectId:null,className,type]);
  await audit(req.user.id,"ASSIGN_TEACHER",`teacher=${teacherId},class=${className},subject=${subjectId||''},type=${type}`);res.status(201).json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/teacher-assignments/:id",adminOnly,async(req,res)=>{try{await pool.query("DELETE FROM teacher_assignments WHERE id=$1",[req.params.id]);res.json({message:"Assignment removed"})}catch(e){res.status(400).json({error:e.message})}});

// Exam bank: reusable CBC assessment questions.
app.get("/api/exam-bank",auth(["admin","teacher","principal","director","secretary"]),async(req,res)=>{try{const vals=[],where=[];if(req.query.class_name){vals.push(normalizeClass(req.query.class_name));where.push(`LOWER(TRIM(eb.class_name))=LOWER(TRIM($${vals.length}))`)}if(req.query.subject_id){vals.push(Number(req.query.subject_id));where.push(`eb.subject_id=$${vals.length}`)}if(req.user.role==='teacher'){vals.push(req.user.id);where.push(`(eb.created_by=$${vals.length} OR EXISTS(SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$${vals.length} AND ta.subject_id=eb.subject_id AND ta.assignment_type='subject' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM(eb.class_name))))`)}const r=await pool.query(`SELECT eb.*,s.code subject_code,s.name subject_name,u.full_name creator,rv.full_name reviewer_name FROM exam_bank eb JOIN subjects s ON s.id=eb.subject_id LEFT JOIN users u ON u.id=eb.created_by LEFT JOIN users rv ON rv.id=eb.reviewed_by ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE eb.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,eb.created_at DESC,eb.id DESC`,vals);res.set('Cache-Control','no-store');res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/exam-bank",auth(["admin","teacher"]),async(req,res)=>{try{
  const subjectId=Number(req.body.subject_id),className=normalizeClass(req.body.class_name),questionText=String(req.body.question_text||'').trim();
  if(!subjectId||!className||!questionText)return res.status(400).json({error:"Learning area, class and question are required"});
  if(req.user.role==='teacher' && !(await hasSubjectAssignment(req.user.id,subjectId,className)))return res.status(403).json({error:"You are not assigned to this learning area and class"});
  const r=await pool.query(`INSERT INTO exam_bank(subject_id,class_name,term,topic,question_type,question_text,option_a,option_b,option_c,option_d,answer,marks,created_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending') RETURNING *`,[subjectId,className,req.body.term||null,req.body.topic||null,req.body.question_type||'Short Answer',questionText,req.body.option_a||null,req.body.option_b||null,req.body.option_c||null,req.body.option_d||null,req.body.answer||null,Number(req.body.marks||1),req.user.id]);await notifyApprovalRoles({title:'Exam Bank approval required',type:'exam-bank-request',message:`Teacher ${req.user.full_name} submitted an exam-bank question for ${className}. Please review and approve or reject it.`,sourceId:r.rows[0].id,actionUrl:'/review-centre.html#exam-bank'});res.status(201).json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/exam-bank/:id",auth(["admin","teacher","principal","director"]),async(req,res)=>{try{const id=Number(req.params.id),existing=(await pool.query("SELECT * FROM exam_bank WHERE id=$1",[id])).rows[0];if(!existing)return res.status(404).json({error:"Question not found"});if(["admin","director","principal"].includes(req.user.role)){const status=String(req.body.status||"").toLowerCase();if(!["approved","rejected"].includes(status))return res.status(400).json({error:"Management review requires approved or rejected status"});const note=String(req.body.review_note||"").trim();if(status==="rejected"&&!note)return res.status(400).json({error:"A rejection reason is required"});const r=await pool.query("UPDATE exam_bank SET status=$1,reviewed_by=$2,reviewed_at=NOW(),review_note=$3,updated_at=NOW() WHERE id=$4 RETURNING *",[status,req.user.id,note||null,id]);await audit(req.user.id,status.toUpperCase()+"_EXAM_BANK",`question=${id}`);if(existing.created_by)await notifyUser(existing.created_by,{title:`Exam Bank question ${status}`,type:"exam-bank-decision",message:`Your exam-bank question #${id} was ${status} by ${req.user.full_name}.${note?' Note: '+note:''}`,sourceId:id,actionUrl:"/review-centre.html#exam-bank"});return res.json(r.rows[0])}if(Number(existing.created_by)!==Number(req.user.id))return res.status(403).json({error:"Teachers can edit only their own questions"});if(existing.status==='approved')return res.status(400).json({error:"Approved questions cannot be edited"});const keys=['subject_id','class_name','term','topic','question_type','question_text','option_a','option_b','option_c','option_d','answer','marks'],f=[],v=[];for(const k of keys)if(req.body[k]!==undefined){f.push(`${k}=$${v.length+1}`);v.push(k==='subject_id'||k==='marks'?Number(req.body[k]):req.body[k])}if(!f.length)return res.status(400).json({error:"Nothing to update"});f.push("status='pending'","reviewed_by=NULL","reviewed_at=NULL","review_note=NULL","updated_at=NOW()");v.push(id);const r=await pool.query(`UPDATE exam_bank SET ${f.join(',')} WHERE id=$${v.length} RETURNING *`,v);await notifyApprovalRoles({title:'Exam Bank approval required',type:'exam-bank-request',message:`Teacher ${req.user.full_name} updated exam-bank question #${id}; review is required again.`,sourceId:id,actionUrl:'/review-centre.html#exam-bank'});res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/exam-bank/:id",auth(["admin","teacher","principal","director"]),async(req,res)=>{try{const existing=(await pool.query("SELECT * FROM exam_bank WHERE id=$1",[req.params.id])).rows[0];if(!existing)return res.status(404).json({error:"Question not found"});if(req.user.role==='teacher'&&Number(existing.created_by)!==Number(req.user.id))return res.status(403).json({error:"Teachers can delete only their own questions"});await pool.query("DELETE FROM exam_bank WHERE id=$1",[req.params.id]);await audit(req.user.id,'DELETE_EXAM_BANK_QUESTION',`question=${req.params.id}`);res.json({message:"Question deleted"});}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/documents/exam-bank",auth(["admin","secretary","director","principal"]),async(req,res)=>{try{const rows=(await pool.query(`SELECT eb.*,s.code subject_code,s.name subject_name,u.full_name creator,rv.full_name reviewer_name FROM exam_bank eb JOIN subjects s ON s.id=eb.subject_id LEFT JOIN users u ON u.id=eb.created_by LEFT JOIN users rv ON rv.id=eb.reviewed_by ORDER BY eb.class_name,s.name,eb.topic,eb.id DESC`)).rows;const p=new SimplePdf();pdfHeader(p,'EXAM BANK REPORT');pdfMeta(p,[['Questions',rows.length],['Generated',new Date().toLocaleString()]]);pdfTable(p,42,660,511,['No.','Class','Learning Area','Topic','Type','Question','Marks','Status','Submitted By'],rows.map((x,i)=>[i+1,x.class_name,x.subject_name,x.topic||'—',x.question_type,x.question_text,x.marks,x.status,x.creator]),[24,50,70,52,45,125,32,48,65]);const pdf=p.finalize();res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="GreenStar_Exam_Bank.pdf"');res.setHeader('Cache-Control','no-store');res.send(pdf)}catch(e){res.status(500).send(e.message)}});

// Student/parent study-question access: live, class-matched exam-bank questions. Answers are never exposed.
app.get("/api/my/student/exam-bank",auth(["student"]),async(req,res)=>{try{ res.set("Cache-Control","no-store");const st=(await pool.query("SELECT id,class_name FROM students WHERE user_id=$1",[req.user.id])).rows[0];if(!st)return res.status(404).json({error:'Student profile not linked'});const r=await pool.query(`SELECT eb.id,eb.subject_id,eb.class_name,eb.term,eb.topic,eb.question_type,eb.question_text,eb.option_a,eb.option_b,eb.option_c,eb.option_d,eb.marks,s.code subject_code,s.name subject_name FROM exam_bank eb JOIN subjects s ON s.id=eb.subject_id WHERE eb.status='approved' AND LOWER(TRIM(eb.class_name))=LOWER(TRIM($1)) ORDER BY s.name,eb.topic,eb.id DESC`,[st.class_name]);res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/my/children/:id/exam-bank",auth(["parent"]),async(req,res)=>{try{ res.set("Cache-Control","no-store");const id=Number(req.params.id);const st=(await pool.query("SELECT id,class_name FROM students WHERE id=$1 AND (parent_phone=$2 OR parent_name=$3 OR admission_no=$4)",[id,req.user.phone,req.user.full_name,req.user.username])).rows[0];if(!st)return res.status(403).json({error:'This learner is not linked to your parent account.'});const r=await pool.query(`SELECT eb.id,eb.subject_id,eb.class_name,eb.term,eb.topic,eb.question_type,eb.question_text,eb.option_a,eb.option_b,eb.option_c,eb.option_d,eb.marks,s.code subject_code,s.name subject_name FROM exam_bank eb JOIN subjects s ON s.id=eb.subject_id WHERE eb.status='approved' AND LOWER(TRIM(eb.class_name))=LOWER(TRIM($1)) ORDER BY s.name,eb.topic,eb.id DESC`,[st.class_name]);res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});

// Exam resource bank: teacher-uploaded exam papers/files with approval workflow.
app.get("/api/exam-resources",auth(["admin","teacher","director","secretary","student","parent"]),async(req,res)=>{try{
  // Student queries deliberately use ONE bind parameter (user id). This avoids PostgreSQL
  // bind-count errors caused by dynamically adding the purchase JOIN parameter.
  if(req.user.role==='parent'){
    const child=(await pool.query("SELECT id,class_name FROM students WHERE id=COALESCE($1,id) AND (parent_phone=$2 OR parent_name=$3 OR admission_no=$4) ORDER BY id LIMIT 1",[req.query.student_id?Number(req.query.student_id):null,req.user.phone,req.user.full_name,req.user.username])).rows[0];
    if(!child)return res.status(404).json({error:"No linked learner found"});
    const q=`SELECT er.id,er.title,er.description,er.subject_id,er.class_name,er.term,er.academic_year,er.original_filename,er.mime_type,er.file_size,er.status,er.price,er.uploaded_by,er.reviewed_by,er.reviewed_at,er.review_note,er.created_at,s.code subject_code,s.name subject_name,u.full_name uploader,ru.full_name reviewer,rp.status purchase_status,rp.reference purchase_reference,rp.paid_at purchase_paid_at
      FROM exam_resources er JOIN subjects s ON s.id=er.subject_id JOIN users u ON u.id=er.uploaded_by LEFT JOIN users ru ON ru.id=er.reviewed_by
      LEFT JOIN resource_purchases rp ON rp.resource_id=er.id AND rp.student_id=$1
      WHERE er.status='approved' AND LOWER(TRIM(er.class_name))=LOWER(TRIM($2)) ORDER BY er.created_at DESC`;
    return res.json((await pool.query(q,[child.id,child.class_name])).rows);
  }
  if(req.user.role==='student'){
    const q=`SELECT er.id,er.title,er.description,er.subject_id,er.class_name,er.term,er.academic_year,er.original_filename,er.mime_type,er.file_size,er.status,er.price,er.uploaded_by,er.reviewed_by,er.reviewed_at,er.review_note,er.created_at,s.code subject_code,s.name subject_name,u.full_name uploader,ru.full_name reviewer,rp.status purchase_status,rp.reference purchase_reference,rp.paid_at purchase_paid_at
      FROM exam_resources er
      JOIN subjects s ON s.id=er.subject_id
      JOIN users u ON u.id=er.uploaded_by
      LEFT JOIN users ru ON ru.id=er.reviewed_by
      LEFT JOIN resource_purchases rp ON rp.resource_id=er.id AND rp.student_id=(SELECT id FROM students WHERE user_id=$1)
      WHERE er.status='approved'
        AND LOWER(TRIM(er.class_name))=LOWER(TRIM((SELECT class_name FROM students WHERE user_id=$1)))
      ORDER BY er.created_at DESC`;
    const r=await pool.query(q,[req.user.id]);
    const linked=(await pool.query("SELECT id FROM students WHERE user_id=$1",[req.user.id])).rows[0];
    if(!linked)return res.status(404).json({error:"Student profile not linked"});
    return res.json(r.rows);
  }
  const vals=[],where=[];
  if(req.query.status){vals.push(String(req.query.status));where.push(`er.status=$${vals.length}`)}
  if(req.query.subject_id){vals.push(Number(req.query.subject_id));where.push(`er.subject_id=$${vals.length}`)}
  if(req.query.class_name){vals.push(normalizeClass(req.query.class_name));where.push(`LOWER(TRIM(er.class_name))=LOWER(TRIM($${vals.length}))`)}
  if(req.user.role==='teacher'){vals.push(req.user.id);where.push(`(er.uploaded_by=$${vals.length} OR EXISTS(SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$${vals.length} AND ta.subject_id=er.subject_id AND ta.assignment_type='subject' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM(er.class_name))))`)}
  const q=`SELECT er.id,er.title,er.description,er.subject_id,er.class_name,er.term,er.academic_year,er.original_filename,er.mime_type,er.file_size,er.status,er.price,er.uploaded_by,er.reviewed_by,er.reviewed_at,er.review_note,er.created_at,s.code subject_code,s.name subject_name,u.full_name uploader,ru.full_name reviewer FROM exam_resources er JOIN subjects s ON s.id=er.subject_id JOIN users u ON u.id=er.uploaded_by LEFT JOIN users ru ON ru.id=er.reviewed_by ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY er.created_at DESC`;
  res.json((await pool.query(q,vals)).rows);
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/exam-resources",auth(["teacher"]),async(req,res)=>{try{const subjectId=Number(req.body.subject_id),className=normalizeClass(req.body.class_name);if(!subjectId||!className)return res.status(400).json({error:"Assigned learning area and class are required"});if(!(await hasSubjectAssignment(req.user.id,subjectId,className)))return res.status(403).json({error:"You can upload exams only for your assigned learning area and class"});const file=String(req.body.file_base64||'');if(!file||file.length>14*1024*1024)return res.status(400).json({error:"Exam file is required and must be 10 MB or smaller"});const filename=String(req.body.original_filename||'exam-resource').trim();const ext=(filename.match(/\.([^.]+)$/)||[])[1]?.toLowerCase()||'';const mime=String(req.body.mime_type||'').toLowerCase()||({pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',zip:'application/zip'}[ext]||'');const allowed=['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/zip','application/x-zip-compressed'];if(!allowed.includes(mime))return res.status(400).json({error:"Only PDF, Word, PowerPoint, Excel or ZIP exam files are allowed"});const buffer=Buffer.from(file,'base64');if(buffer.length>10*1024*1024)return res.status(400).json({error:"Exam file must be 10 MB or smaller"});const title=String(req.body.title||filename).trim();if(!title)return res.status(400).json({error:"Exam title is required"});const r=await pool.query(`INSERT INTO exam_resources(title,description,subject_id,class_name,term,academic_year,original_filename,mime_type,file_data,file_size,uploaded_by,status,price) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',100) RETURNING id,title,status,price`,[title,req.body.description||null,subjectId,className,req.body.term||null,req.body.academic_year?Number(req.body.academic_year):null,filename,mime,buffer,buffer.length,req.user.id]);await audit(req.user.id,'UPLOAD_EXAM_RESOURCE',`resource=${r.rows[0].id},subject=${subjectId},class=${className}`);await notifyApprovalRoles({title:'Exam resource approval required',type:'exam-resource-request',message:`Teacher ${req.user.full_name} uploaded exam resource "${title}" for ${className}. Review and approve/reject it.`,sourceId:r.rows[0].id,actionUrl:'/exam-resources.html'});await notifyApprovalRolesWhatsApp({eventType:'exam-resource',sourceId:r.rows[0].id,message:`Green Star approval required: Teacher ${req.user.full_name} uploaded exam resource "${title}" for ${className}. Please review it in the school system.`});res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/exam-resources/:id",auth(["admin","director","secretary"]),async(req,res)=>{try{const status=String(req.body.status||'').toLowerCase();if(!['approved','rejected'].includes(status))return res.status(400).json({error:'Status must be approved or rejected'});const r=await pool.query(`UPDATE exam_resources SET status=$1,reviewed_by=$2,reviewed_at=NOW(),review_note=$3,updated_at=NOW() WHERE id=$4 RETURNING id,status,review_note`,[status,req.user.id,req.body.review_note||null,req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Exam resource not found'});await audit(req.user.id,status.toUpperCase()+'_EXAM_RESOURCE',`resource=${req.params.id}`);const erOwner=(await pool.query('SELECT uploaded_by,title FROM exam_resources WHERE id=$1',[req.params.id])).rows[0];if(erOwner)await notifyUserWhatsApp(erOwner.uploaded_by,{eventType:'exam-resource',sourceId:r.rows[0].id,message:`Green Star: Your exam resource "${erOwner.title}" was ${status} by ${req.user.full_name}.${req.body.review_note?' Note: '+req.body.review_note:''}`});res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/exam-resources/:id",auth(["admin","director","secretary"]),async(req,res)=>{try{const r=await pool.query("DELETE FROM exam_resources WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Exam resource not found'});await audit(req.user.id,'DELETE_EXAM_RESOURCE',`resource=${req.params.id}`);res.json({message:'Exam resource deleted'})}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/exam-resources/:id/download",auth(["admin","teacher","director","secretary","student","parent"]),async(req,res)=>{try{const id=Number(req.params.id),r=(await pool.query("SELECT er.*,s.name subject_name FROM exam_resources er JOIN subjects s ON s.id=er.subject_id WHERE er.id=$1",[id])).rows[0];if(!r)return res.status(404).send('Exam resource not found');if(req.user.role==='teacher' && !(Number(r.uploaded_by)===Number(req.user.id) || await hasSubjectAssignment(req.user.id,r.subject_id,r.class_name)))return res.status(403).send('Not allowed');if(req.user.role==='student'){const st=(await pool.query("SELECT id,class_name FROM students WHERE user_id=$1",[req.user.id])).rows[0];if(!st||String(st.class_name||'').trim().toLowerCase()!==String(r.class_name||'').trim().toLowerCase()||r.status!=='approved')return res.status(403).send('This resource is not available to you');const purchase=(await pool.query("SELECT status FROM resource_purchases WHERE resource_id=$1 AND student_id=$2",[id,st.id])).rows[0];if(!purchase||purchase.status!=='paid')return res.status(402).send('Payment of KSh 100 must be approved before download')}if(req.user.role==='parent'){const st=(await pool.query("SELECT id,class_name FROM students WHERE id=$1 AND (parent_phone=$2 OR parent_name=$3)",[Number(req.query.student_id),req.user.phone,req.user.full_name])).rows[0];if(!st||String(st.class_name||'').trim().toLowerCase()!==String(r.class_name||'').trim().toLowerCase()||r.status!=='approved')return res.status(403).send('This resource is not available to this learner');const purchase=(await pool.query("SELECT status FROM resource_purchases WHERE resource_id=$1 AND student_id=$2",[id,st.id])).rows[0];if(!purchase||purchase.status!=='paid')return res.status(402).send('Payment of KSh 100 must be approved before download')}res.setHeader('Content-Type',r.mime_type||'application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${String(r.original_filename).replace(/[^a-zA-Z0-9._ -]/g,'_')}"`);res.setHeader('Content-Length',r.file_size);res.send(r.file_data);}catch(e){res.status(500).send(e.message)}});
app.get("/api/exam-resources/purchases",auth(["admin","director","secretary"]),async(req,res)=>{try{res.json((await pool.query(`SELECT rp.*,er.title,er.price,s.full_name student_name,s.admission_no,u.full_name reviewer FROM resource_purchases rp JOIN exam_resources er ON er.id=rp.resource_id JOIN students s ON s.id=rp.student_id LEFT JOIN users u ON u.id=rp.reviewed_by ORDER BY rp.created_at DESC`)).rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/exam-resources/:id/purchase",auth(["student","parent"]),async(req,res)=>{try{const st=(req.user.role==='student'?await pool.query("SELECT id,class_name,parent_phone FROM students WHERE user_id=$1",[req.user.id]):await pool.query("SELECT id,class_name,parent_phone FROM students WHERE id=$1 AND (parent_phone=$2 OR parent_name=$3 OR admission_no=$4)",[Number(req.body.student_id),req.user.phone,req.user.full_name,req.user.username])).rows[0];if(!st)return res.status(404).json({error:req.user.role==='parent'?'Linked learner not found':'Student profile not linked'});const er=(await pool.query("SELECT id,price,status,class_name FROM exam_resources WHERE id=$1",[req.params.id])).rows[0];if(!er||er.status!=='approved')return res.status(404).json({error:'Exam resource is not available'});if(String(st.class_name||'').trim().toLowerCase()!==String(er.class_name||'').trim().toLowerCase())return res.status(403).json({error:'This resource is for another class'});const payerPhone=String(req.body.payer_phone||'').trim();const reference=String(req.body.reference||'').trim();const paymentDetails=String(req.body.payment_details||'').trim();if(!payerPhone)return res.status(400).json({error:'Phone number used for the M-Pesa payment is required'});if(!reference&&!paymentDetails)return res.status(400).json({error:'M-Pesa transaction reference or payment details are required'});const r=await pool.query(`INSERT INTO resource_purchases(resource_id,student_id,amount,payment_method,reference,payer_phone,payment_details,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT(resource_id,student_id) DO UPDATE SET amount=EXCLUDED.amount,payment_method=EXCLUDED.payment_method,reference=EXCLUDED.reference,payer_phone=EXCLUDED.payer_phone,payment_details=EXCLUDED.payment_details,status='pending',reviewed_by=NULL,reviewed_at=NULL,review_note=NULL,paid_at=NULL,created_at=NOW() RETURNING *`,[er.id,st.id,Number(er.price||100),req.body.payment_method||'M-Pesa',reference||null,payerPhone,paymentDetails||null]);await audit(req.user.id,'REQUEST_EXAM_RESOURCE_PAYMENT',`resource=${er.id},student=${st.id},payer_phone=${payerPhone}`);await notifyApprovalRoles({title:'Exam resource payment verification',type:'resource-payment-request',message:`A payment request for exam resource "${er.id}" was submitted for learner ${st.id}. Verify the payment and approve/reject the download.`,sourceId:r.rows[0].id,actionUrl:'/exam-resources.html'});await notifyApprovalRolesWhatsApp({eventType:'resource-payment',sourceId:r.rows[0].id,message:`Green Star payment verification required: exam resource #${er.id}, learner #${st.id}, payment KSh ${Number(er.price||100).toLocaleString()}. Please verify and approve/reject.`});res.status(201).json({message:'Payment details submitted. A school finance officer will verify the M-Pesa payment and approve the download.',purchase:r.rows[0]});}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/exam-resources/purchases/:id",auth(["admin","director","secretary"]),async(req,res)=>{try{const status=String(req.body.status||'').toLowerCase();if(!['paid','rejected'].includes(status))return res.status(400).json({error:'Status must be paid or rejected'});const r=await pool.query("UPDATE resource_purchases SET status=$1,reviewed_by=$2,reviewed_at=NOW(),review_note=$3,paid_at=CASE WHEN $1='paid' THEN NOW() ELSE NULL END WHERE id=$4 RETURNING *",[status,req.user.id,req.body.review_note||null,req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Purchase not found'});const pu=(await pool.query(`SELECT rp.student_id,er.title,s.full_name student_name,s.user_id student_user_id,s.parent_phone FROM resource_purchases rp JOIN exam_resources er ON er.id=rp.resource_id JOIN students s ON s.id=rp.student_id WHERE rp.id=$1`,[req.params.id])).rows[0];if(pu){const msg=`Green Star: Payment for exam resource "${pu.title}" for ${pu.student_name} was ${status} by ${req.user.full_name}.${req.body.review_note?' Note: '+req.body.review_note:''}`;if(pu.student_user_id)await notifyUserWhatsApp(pu.student_user_id,{eventType:'resource-payment',sourceId:r.rows[0].id,message:msg});if(pu.parent_phone)await queueWhatsAppNotification(`resource-payment:${r.rows[0].id}:parent`,'resource-payment',pu.student_id,'Parent/Guardian',pu.parent_phone,msg,r.rows[0].id);}res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});

// Assets
app.get("/api/assets",auth(["admin","worker","secretary","director","principal"]),async(req,res)=>res.json((await pool.query("SELECT * FROM assets ORDER BY name")).rows));
app.post("/api/assets",auth(["admin","worker","secretary"]),async(req,res)=>{try{const x=req.body;const r=await pool.query(`INSERT INTO assets(asset_code,name,category,quantity,condition,location,purchase_date,purchase_value,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[x.asset_code,x.name,x.category||null,x.quantity||1,x.condition||"Good",x.location||null,x.purchase_date||null,Number(x.purchase_value||0),x.status||"Active",x.notes||null]);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/assets/:id",adminOnly,async(req,res)=>{await pool.query("DELETE FROM assets WHERE id=$1",[req.params.id]);res.json({message:"Asset deleted"})});

// Announcements
app.get("/api/announcements",auth(),async(req,res)=>res.json((await pool.query("SELECT a.*,u.full_name creator FROM announcements a LEFT JOIN users u ON u.id=a.created_by ORDER BY a.created_at DESC")).rows));
app.post("/api/announcements",auth(["admin","teacher","secretary","principal","director"]),async(req,res)=>{try{const r=await pool.query("INSERT INTO announcements(title,message,audience,created_by) VALUES($1,$2,$3,$4) RETURNING *",[req.body.title,req.body.message,req.body.audience||"all",req.user.id]);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});

// Communication Centre — administration can send targeted messages to relevant learners, parents and staff.

// WhatsApp Business Platform integration (optional). The module remains usable with click-to-chat
// even when Cloud API credentials are not configured. Secrets must stay server-side in environment variables.
// WhatsApp Phase 3 — live event message preparation. This reads the existing records only;
// it does not alter fees, results, attendance, Tahfidh, exams or communications data.
app.get("/api/whatsapp/live-message/:type/:studentId",auth(["admin","director","principal","secretary"]),async(req,res)=>{
  try{
    res.set("Cache-Control","no-store");
    const type=String(req.params.type||"").toLowerCase();
    const studentId=Number(req.params.studentId);
    if(!studentId)return res.status(400).json({error:"Select a learner first."});
    const s=(await pool.query("SELECT id,admission_no,full_name,class_name,parent_name,parent_phone FROM students WHERE id=$1",[studentId])).rows[0];
    if(!s)return res.status(404).json({error:"Student not found."});
    const parent=s.parent_name||"Parent/Guardian";
    const n=s.full_name;
    const cls=s.class_name||"the learner's class";
    let message="";
    let detail={};
    if(type==='fees'){
      const r=(await pool.query(`SELECT COALESCE((SELECT SUM(amount) FROM fee_charges WHERE student_id=$1),0) charged,COALESCE((SELECT SUM(amount) FROM fee_records WHERE student_id=$1),0) paid`,[studentId])).rows[0];
      const charged=Number(r.charged||0),paid=Number(r.paid||0),balance=charged-paid;
      message=`Dear ${parent}, this is a live fees update for ${n}. Total charged: KSh ${charged.toLocaleString()}. Paid: KSh ${paid.toLocaleString()}. Outstanding balance: KSh ${balance.toLocaleString()}. Please log in to the Green Star Parent Portal for the full statement.`;
      detail={charged,paid,balance};
    } else if(type==='results'){
      const e=(await pool.query(`SELECT e.id,e.name,e.term,e.academic_year,COUNT(m.id)::int subjects,COALESCE(SUM(m.marks),0) total,ROUND(COALESCE(AVG(m.marks),0),2) average FROM exams e LEFT JOIN marks m ON m.exam_id=e.id AND m.student_id=$1 GROUP BY e.id ORDER BY e.academic_year DESC,e.id DESC LIMIT 1`,[studentId])).rows[0];
      if(!e)return res.status(404).json({error:"No examination result is available for this learner yet."});
      message=`Dear ${parent}, ${n}'s latest examination result is now available. Exam: ${e.name} (${e.term}, ${e.academic_year}). Average: ${Number(e.average||0).toFixed(2)}. Please log in to the Green Star Parent Portal to view the detailed result slip.`;
      detail=e;
    } else if(type==='tafhid'){
      const a=(await pool.query(`SELECT a.assessment_type,a.period_label,a.academic_year,a.juzu,a.total,a.teacher_comment FROM tafhid_assessments a WHERE a.student_id=$1 ORDER BY a.academic_year DESC,a.created_at DESC LIMIT 1`,[studentId])).rows[0];
      if(!a)return res.status(404).json({error:"No Tahfidh assessment is available for this learner yet."});
      message=`Dear ${parent}, ${n}'s latest Tahfidh assessment is now available. Period: ${a.period_label} (${a.academic_year}). Total: ${Number(a.total||0).toFixed(2)}. Please log in to the Green Star Parent Portal to view the assessment details.`;
      detail=a;
    } else if(type==='exam'){
      const e=(await pool.query(`SELECT e.name,e.term,e.academic_year,e.exam_date FROM exams e WHERE LOWER(TRIM(COALESCE(e.term,'')))<>'' ORDER BY e.academic_year DESC,e.exam_date DESC NULLS LAST,e.id DESC LIMIT 1`)).rows[0];
      if(!e)return res.status(404).json({error:"No examination notice is available yet."});
      message=`Dear ${parent}, an examination notice for ${cls} is available from Green Star Integrated School. ${e.name} — ${e.term}, ${e.academic_year}${e.exam_date?`, date: ${e.exam_date}`:""}. Please check the Green Star Parent Portal for the latest details.`;
      detail=e;
    } else if(type==='announcement'){
      const a=(await pool.query(`SELECT title,message,created_at FROM announcements WHERE audience='all' OR LOWER(TRIM(audience)) IN ('parents','parent','students') ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0];
      if(!a)return res.status(404).json({error:"No relevant school announcement is available yet."});
      message=`Dear ${parent}, Green Star Integrated School has a new school announcement: ${a.title}. ${String(a.message||'').trim()} Please check the Green Star Parent Portal for updates.`;
      detail=a;
    } else if(type==='exam-bank'){
      const q=(await pool.query(`SELECT COUNT(*)::int count FROM exam_bank WHERE LOWER(TRIM(class_name))=LOWER(TRIM($1))`,[cls])).rows[0];
      message=`Dear ${parent}, Green Star Integrated School currently has ${Number(q.count||0)} exam-bank question(s) available for ${n}'s class, ${cls}. Please log in to the Parent Portal to access the relevant questions.`;
      detail=q;
    } else {
      return res.status(400).json({error:"Unsupported live notification type."});
    }
    res.json({student:{id:s.id,full_name:n,class_name:cls,parent_name:s.parent_name,parent_phone:s.parent_phone},type,message,detail});
  }catch(e){console.error("WhatsApp live message failed:",e);res.status(500).json({error:"Unable to prepare the live school message."});}
});

async function getWhatsAppRule(eventType){
  const r=await pool.query("SELECT enabled,mode FROM whatsapp_communication_settings WHERE event_type=$1",[eventType]);
  return r.rows[0]||{enabled:true,mode:"approval"};
}
function normalizeWhatsAppPhone(v){
  let p=String(v||"").replace(/\D/g,"");
  if(p.startsWith("0"))p="254"+p.slice(1);
  else if(p.startsWith("7")||p.startsWith("1"))p="254"+p;
  return p;
}
async function notifyApprovalRoles({title,type,message,sourceId,actionUrl}){
  title=tenantBrandText(title);message=tenantBrandText(message);
  try{
    const users=(await pool.query("SELECT id FROM users WHERE active=true AND role IN ('director','admin','principal','secretary')")).rows;
    for(const u of users){
      await pool.query("INSERT INTO approval_notifications(recipient_user_id,title,notification_type,message,source_id,action_url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(recipient_user_id,notification_type,source_id) DO NOTHING",[u.id,title,type,message,sourceId==null?null:String(sourceId),actionUrl||null]);
    }
  }catch(e){ console.error('Approval notification failed:',e.message); }
}
async function notifyUser(userId,{title,type,message,sourceId,actionUrl}){
  title=tenantBrandText(title);message=tenantBrandText(message);
  if(!userId)return;
  try{await pool.query("INSERT INTO approval_notifications(recipient_user_id,title,notification_type,message,source_id,action_url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(recipient_user_id,notification_type,source_id) DO NOTHING",[userId,title,type,message,sourceId==null?null:String(sourceId),actionUrl||null]);}
  catch(e){console.error('User notification failed:',e.message);}
}

async function notifyUserWhatsApp(userId,{eventType='management',message,sourceId=null}){
  message=tenantBrandText(message);if(!userId||!message)return;
  try{
    const u=(await pool.query("SELECT full_name,phone FROM users WHERE id=$1 AND active=true",[userId])).rows[0];
    if(u?.phone) await queueWhatsAppNotification(`management:${eventType}:${sourceId||Date.now()}`,eventType,null,u.full_name,u.phone,message,sourceId);
  }catch(e){console.error('User WhatsApp notification failed:',e.message);}
}
async function notifyApprovalRolesWhatsApp({eventType='management',message,sourceId=null}){
  message=tenantBrandText(message);try{
    const users=(await pool.query("SELECT id,full_name,phone FROM users WHERE active=true AND role IN ('director','principal','admin') AND phone IS NOT NULL AND TRIM(phone)<>''")).rows;
    for(const u of users) await queueWhatsAppNotification(`approval:${eventType}:${sourceId}:user:${u.id}`,eventType,null,u.full_name,u.phone,message,sourceId);
  }catch(e){console.error('Management WhatsApp notification failed:',e.message);}
}

async function sendWhatsAppCloud(to,message){
  message=tenantBrandText(message);
  const token=process.env.WHATSAPP_ACCESS_TOKEN,phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version=process.env.WHATSAPP_GRAPH_VERSION||"v23.0";
  if(!token||!phoneId)return {ok:false,configured:false,error:"WhatsApp Cloud API is not configured."};
  const r=await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({messaging_product:"whatsapp",recipient_type:"individual",to,type:"text",text:{preview_url:false,body:message}})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)return {ok:false,configured:true,error:d?.error?.message||"WhatsApp message failed",details:d};
  return {ok:true,configured:true,message_id:d?.messages?.[0]?.id||null};
}
async function queueWhatsAppNotification(eventKey,eventType,studentId,recipientName,recipientPhone,message,sourceId){
  message=tenantBrandText(message);
  const phone=normalizeWhatsAppPhone(recipientPhone);
  if(!phone||!message)return;
  const rule=await getWhatsAppRule(eventType);
  if(!rule.enabled)return;
  const ins=await pool.query(`INSERT INTO whatsapp_pending_notifications(event_key,event_type,student_id,recipient_name,recipient_phone,message,source_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT(event_key) DO NOTHING RETURNING *`,[eventKey,eventType,studentId||null,recipientName||"User",phone,message,sourceId==null?null:String(sourceId)]);
  const item=ins.rows[0];
  if(!item||rule.mode!=="automatic")return;
  const result=await sendWhatsAppCloud(phone,message);
  if(result.ok){
    await pool.query("UPDATE whatsapp_pending_notifications SET status='sent',sent_at=NOW() WHERE id=$1",[item.id]);
    await pool.query("INSERT INTO whatsapp_delivery_log(recipient_name,recipient_phone,event_type,message,status,provider_message_id) VALUES($1,$2,$3,$4,'sent',$5)",[recipientName||"User",phone,eventType,message,result.message_id]);
  }else{
    await pool.query("INSERT INTO whatsapp_delivery_log(recipient_name,recipient_phone,event_type,message,status,error) VALUES($1,$2,$3,$4,'failed',$5)",[recipientName||"User",phone,eventType,message,result.error||"Send failed"]);
  }
}
async function scanWhatsAppEvents(){
  try{
    const fees=(await pool.query(`SELECT fr.id,fr.amount,fr.receipt_no,s.id student_id,s.full_name,s.parent_name,s.parent_phone,pu.full_name student_account_name,pu.phone student_account_phone
      FROM fee_records fr JOIN students s ON s.id=fr.student_id LEFT JOIN users pu ON pu.id=s.user_id
      WHERE fr.transaction_date >= NOW()-INTERVAL '48 hours' ORDER BY fr.transaction_date DESC LIMIT 200`)).rows;
    for(const x of fees){
      if(x.parent_phone)await queueWhatsAppNotification(`fee:${x.id}:parent`,'fees',x.student_id,x.parent_name||'Parent/Guardian',x.parent_phone,`Dear ${x.parent_name||'Parent/Guardian'}, Green Star Integrated School has recorded a fee payment of KSh ${Number(x.amount||0).toLocaleString()} for ${x.full_name}. Receipt: ${x.receipt_no||'—'}. Please log in to the Parent Portal for the live fees statement.`,x.id);
      if(x.student_account_phone)await queueWhatsAppNotification(`fee:${x.id}:student`,'fees',x.student_id,x.student_account_name||x.full_name,x.student_account_phone,`Hello ${x.student_account_name||x.full_name}, a fee payment of KSh ${Number(x.amount||0).toLocaleString()} has been recorded for your school account. Receipt: ${x.receipt_no||'—'}.`,x.id);
    }
    const results=(await pool.query(`SELECT e.id exam_id,e.name exam_name,e.created_at,s.id student_id,s.full_name,s.parent_name,s.parent_phone,pu.full_name student_account_name,pu.phone student_account_phone,ROUND(COALESCE(AVG(m.marks),0),1) average
      FROM exams e JOIN marks m ON m.exam_id=e.id JOIN students s ON s.id=m.student_id LEFT JOIN users pu ON pu.id=s.user_id
      WHERE e.created_at >= NOW()-INTERVAL '7 days' GROUP BY e.id,e.name,e.created_at,s.id,s.full_name,s.parent_name,s.parent_phone,pu.full_name,pu.phone LIMIT 500`)).rows;
    for(const x of results){
      if(x.parent_phone)await queueWhatsAppNotification(`results:${x.exam_id}:${x.student_id}:parent`,'results',x.student_id,x.parent_name||'Parent/Guardian',x.parent_phone,`Dear ${x.parent_name||'Parent/Guardian'}, ${x.full_name}'s ${x.exam_name} result is now available. Current average: ${Number(x.average||0).toFixed(1)}%. Please log in to the Parent Portal to view the detailed result slip.`,`${x.exam_id}:${x.student_id}`);
      if(x.student_account_phone)await queueWhatsAppNotification(`results:${x.exam_id}:${x.student_id}:student`,'results',x.student_id,x.student_account_name||x.full_name,x.student_account_phone,`Hello ${x.student_account_name||x.full_name}, your ${x.exam_name} result is now available. Current average: ${Number(x.average||0).toFixed(1)}%. Please log in to the Student Portal to view your detailed results.`,`${x.exam_id}:${x.student_id}`);
    }
    const tah=(await pool.query(`SELECT ta.id,ta.updated_at,ta.period_label,ta.total,s.id student_id,s.full_name,s.parent_name,s.parent_phone,pu.full_name student_account_name,pu.phone student_account_phone
      FROM tafhid_assessments ta JOIN students s ON s.id=ta.student_id LEFT JOIN users pu ON pu.id=s.user_id
      WHERE ta.updated_at >= NOW()-INTERVAL '48 hours' ORDER BY ta.updated_at DESC LIMIT 200`)).rows;
    for(const x of tah){
      if(x.parent_phone)await queueWhatsAppNotification(`tafhid:${x.id}:parent`,'tafhid',x.student_id,x.parent_name||'Parent/Guardian',x.parent_phone,`Dear ${x.parent_name||'Parent/Guardian'}, ${x.full_name}'s Tahfidh assessment for ${x.period_label||'the latest period'} is now available. Total: ${Number(x.total||0).toFixed(1)}. Please log in to the Parent Portal to view the details.`,x.id);
      if(x.student_account_phone)await queueWhatsAppNotification(`tafhid:${x.id}:student`,'tafhid',x.student_id,x.student_account_name||x.full_name,x.student_account_phone,`Hello ${x.student_account_name||x.full_name}, your latest Tahfidh assessment for ${x.period_label||'the latest period'} is now available. Total: ${Number(x.total||0).toFixed(1)}. Please log in to the Student Portal to view the details.`,x.id);
    }
    const users=(await pool.query(`SELECT id,full_name,role,phone,email FROM users WHERE active=TRUE AND phone IS NOT NULL AND TRIM(phone)<>'' ORDER BY full_name LIMIT 5000`)).rows;
    const ann=(await pool.query(`SELECT a.id,a.title,a.message,a.audience,a.created_at FROM announcements a WHERE a.created_at >= NOW()-INTERVAL '48 hours' ORDER BY a.created_at DESC LIMIT 20`)).rows;
    for(const a of ann){
      const audience=String(a.audience||'all').trim().toLowerCase();
      let targets=users;
      if(['parents','parent'].includes(audience))targets=users.filter(u=>u.role==='parent');
      else if(['students','student'].includes(audience))targets=users.filter(u=>u.role==='student');
      else if(['staff','teachers','teacher'].includes(audience))targets=users.filter(u=>['teacher','ustadh','patron','secretary','principal','director','admin','worker'].includes(u.role));
      for(const u of targets)await queueWhatsAppNotification(`announcement:${a.id}:user:${u.id}`,'announcement',null,u.full_name,u.phone,`Dear ${u.full_name}, Green Star Integrated School has a new announcement: ${a.title}. ${String(a.message||'').slice(0,700)} Please check the school portal for more information.`,a.id);
    }
    const resources=(await pool.query(`SELECT er.id,er.title,er.class_name,er.updated_at FROM exam_resources er WHERE er.status='approved' AND er.updated_at >= NOW()-INTERVAL '48 hours' ORDER BY er.updated_at DESC LIMIT 100`)).rows;
    for(const r of resources){
      const teachers=(await pool.query(`SELECT DISTINCT u.id,u.full_name,u.phone FROM teacher_assignments ta JOIN users u ON u.id=ta.teacher_id WHERE ta.assignment_type='subject' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM($1)) AND u.active=TRUE AND u.phone IS NOT NULL AND TRIM(u.phone)<>''`,[r.class_name])).rows;
      for(const t of teachers)await queueWhatsAppNotification(`resource:${r.id}:teacher:${t.id}`,'exam-resource',null,t.full_name,t.phone,`Hello ${t.full_name}, the exam resource "${r.title}" for ${r.class_name||'your assigned class'} has been approved and is now available in the school portal.`,r.id);
    }
  }catch(e){console.warn('WhatsApp event scan warning:',e.message)}
}
app.get("/api/approval-notifications",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const rows=(await pool.query("SELECT * FROM approval_notifications WHERE recipient_user_id=$1 ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END,created_at DESC LIMIT 100",[req.user.id])).rows;res.set('Cache-Control','no-store');res.json(rows)}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/approval-notifications/:id/read",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const r=await pool.query("UPDATE approval_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND recipient_user_id=$2 RETURNING *",[req.params.id,req.user.id]);if(!r.rows[0])return res.status(404).json({error:'Notification not found'});res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});

app.get("/api/whatsapp/pending",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{await scanWhatsAppEvents();res.set('Cache-Control','no-store');res.json((await pool.query(`SELECT * FROM whatsapp_pending_notifications WHERE status='pending' ORDER BY created_at DESC`)).rows)}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/whatsapp/pending/:id",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const status=String(req.body.status||'').toLowerCase();if(!['dismissed','pending'].includes(status))return res.status(400).json({error:'Status must be dismissed or pending'});const r=await pool.query("UPDATE whatsapp_pending_notifications SET status=$1 WHERE id=$2 RETURNING *",[status,req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Pending notification not found'});res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/whatsapp/status",auth(["admin","director","principal","secretary"]),async(req,res)=>{
  res.set("Cache-Control","no-store");
  const rules=(await pool.query("SELECT * FROM whatsapp_communication_settings ORDER BY event_type")).rows;
  res.json({configured:!!(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID),provider:"WhatsApp Business Platform",phone_number_id:process.env.WHATSAPP_PHONE_NUMBER_ID||null,rules});
});
app.get("/api/whatsapp/recipients",auth(["admin","director","principal","secretary"]),async(req,res)=>{
  try{
    const q=String(req.query.q||'').trim(),like=`%${q}%`;
    const users=(await pool.query(`SELECT id,full_name,role,phone,email FROM users WHERE active=TRUE AND phone IS NOT NULL AND TRIM(phone)<>'' AND ($1='' OR full_name ILIKE $2 OR role ILIKE $2 OR phone ILIKE $2) ORDER BY full_name LIMIT 500`,[q,like])).rows;
    const students=(await pool.query(`SELECT s.id,s.full_name,s.admission_no,s.class_name,s.parent_name,s.parent_phone,u.phone student_phone FROM students s LEFT JOIN users u ON u.id=s.user_id WHERE ($1='' OR s.full_name ILIKE $2 OR s.admission_no ILIKE $2 OR s.class_name ILIKE $2 OR COALESCE(s.parent_name,'') ILIKE $2) ORDER BY ${classOrderSql('s')},s.full_name LIMIT 1000`,[q,like])).rows;
    const parents=[];const seen=new Set();
    for(const s of students){const p=normalizeWhatsAppPhone(s.parent_phone);if(p&&!seen.has(p)){seen.add(p);parents.push({key:`parent:${s.id}`,name:s.parent_name||'Parent/Guardian',role:'parent',phone:p,student_id:s.id,student_name:s.full_name,class_name:s.class_name})}}
    res.json({users,parents,students});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/whatsapp/rules",auth(["admin","director","principal","secretary"]),async(req,res)=>{res.json((await pool.query("SELECT * FROM whatsapp_communication_settings ORDER BY event_type")).rows)});
app.patch("/api/whatsapp/rules/:eventType",auth(["admin","director","principal","secretary"]),async(req,res)=>{
  try{
    const eventType=String(req.params.eventType||'').trim().toLowerCase();
    if(!['fees','results','tafhid','announcement','exam-resource'].includes(eventType))return res.status(400).json({error:'Unsupported communication event.'});
    const enabled=req.body.enabled!==false,mode=String(req.body.mode||'approval').toLowerCase();
    if(!['approval','automatic'].includes(mode))return res.status(400).json({error:'Mode must be approval or automatic.'});
    const r=await pool.query(`INSERT INTO whatsapp_communication_settings(event_type,enabled,mode,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(event_type) DO UPDATE SET enabled=EXCLUDED.enabled,mode=EXCLUDED.mode,updated_at=NOW() RETURNING *`,[eventType,enabled,mode]);
    await audit(req.user.id,'WHATSAPP_RULE_UPDATED',`${eventType}:${enabled?'enabled':'disabled'}:${mode}`);res.json(r.rows[0]);
  }catch(e){res.status(400).json({error:e.message})}
});
app.post("/api/whatsapp/send-bulk",auth(["admin","director","principal","secretary"]),async(req,res)=>{
  try{
    const recipients=Array.isArray(req.body.recipients)?req.body.recipients.slice(0,100):[];
    const message=String(req.body.message||'').trim();
    if(!recipients.length)return res.status(400).json({error:'Select at least one recipient.'});
    if(!message)return res.status(400).json({error:'Message is required.'});
    const results=[];
    for(const x of recipients){
      const to=normalizeWhatsAppPhone(x.phone);
      if(!to){results.push({name:x.name||'User',ok:false,error:'No valid phone'});continue}
      const r=await sendWhatsAppCloud(to,message);
      await pool.query(`INSERT INTO whatsapp_delivery_log(recipient_name,recipient_phone,event_type,message,status,provider_message_id,error,created_by) VALUES($1,$2,'manual',$3,$4,$5,$6,$7)`,[x.name||'User',to,message,r.ok?'sent':'failed',r.message_id||null,r.error||null,req.user.id]);
      results.push({name:x.name||'User',phone:to,ok:r.ok,error:r.error||null});
    }
    await audit(req.user.id,'WHATSAPP_BULK_SENT',`recipients=${recipients.length}`);
    const sent=results.filter(x=>x.ok).length;
    res.json({ok:sent>0,results,sent,total:results.length});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post("/api/whatsapp/send",auth(["admin","director","principal","secretary"]),async(req,res)=>{
  try{
    const to=normalizeWhatsAppPhone(req.body.to),message=String(req.body.message||"").trim();
    if(!to||to.length<8)return res.status(400).json({error:"Enter a valid WhatsApp number in international format."});
    if(!message)return res.status(400).json({error:"Message is required."});
    const result=await sendWhatsAppCloud(to,message);
    if(!result.configured)return res.status(503).json({error:"WhatsApp Cloud API is not configured. Use the WhatsApp button for click-to-chat, or configure WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID on the server."});
    if(!result.ok)return res.status(502).json({error:result.error||"WhatsApp message failed",details:result.details});
    if(req.body.queue_id)await pool.query("UPDATE whatsapp_pending_notifications SET status='sent',sent_at=NOW() WHERE id=$1",[req.body.queue_id]);
    await pool.query(`INSERT INTO whatsapp_delivery_log(recipient_name,recipient_phone,event_type,message,status,provider_message_id,created_by) VALUES($1,$2,$3,$4,'sent',$5,$6)`,[String(req.body.recipient_name||'User'),to,String(req.body.event_type||'manual'),message,result.message_id,req.user.id]);
    await audit(req.user.id,"WHATSAPP_SENT",`to=${to}`);
    res.json({ok:true,message_id:result.message_id});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/communications",auth(),async(req,res)=>{try{res.set("Cache-Control","no-store");
  const role=req.user.role;
  const vals=[]; const clauses=["(c.audience_type='all')"];
  if(role==='student'){
    vals.push(req.user.id); clauses.push(`(c.audience_type='user' AND c.audience_value=$${vals.length})`);
    const st=(await pool.query("SELECT id,class_name FROM students WHERE user_id=$1",[req.user.id])).rows[0];
    if(st){ vals.push(st.id); clauses.push(`(c.audience_type='student' AND c.audience_value=$${vals.length})`); vals.push(st.class_name||''); clauses.push(`(c.audience_type='class' AND LOWER(TRIM(c.audience_value))=LOWER(TRIM($${vals.length})))`); }
    clauses.push("c.audience_type='students'");
  } else if(role==='parent'){
    vals.push(req.user.id); clauses.push(`(c.audience_type='user' AND c.audience_value=$${vals.length})`);
    const children=(await pool.query("SELECT DISTINCT class_name FROM students WHERE parent_phone=$1 OR parent_name=$2 OR admission_no=$3",[req.user.phone,req.user.full_name,req.user.username])).rows;
    if(children.length){ vals.push(...children.map(x=>x.class_name||'')); const start=vals.length-children.length+1; clauses.push(`(c.audience_type='class' AND LOWER(TRIM(c.audience_value)) IN (${children.map((_,i)=>`LOWER(TRIM($${start+i}))`).join(',')}))`); }
    clauses.push("c.audience_type='parents'");
  } else {
    vals.push(role); clauses.push(`(c.audience_type='role' AND LOWER(c.audience_value)=LOWER($${vals.length}))`);
    clauses.push("c.audience_type='staff'");
    if(role==='teacher') clauses.push("c.audience_type='teachers'");
    if(['worker','ustadh'].includes(role)) clauses.push("c.audience_type='support'");
  }
  const q=`SELECT c.*,u.full_name sender FROM communications c LEFT JOIN users u ON u.id=c.created_by WHERE ${clauses.join(' OR ')} ORDER BY c.created_at DESC LIMIT 100`;
  res.json((await pool.query(q,vals)).rows);
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/communications",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{
  const title=String(req.body.title||'').trim(),message=String(req.body.message||'').trim();
  const allowed=['all','students','parents','staff','teachers','support','role','class','student','user'];
  const audienceType=String(req.body.audience_type||'all').trim().toLowerCase(), audienceValue=req.body.audience_value==null?'':String(req.body.audience_value).trim();
  if(!title||!message)return res.status(400).json({error:'Title and message are required.'});
  if(!allowed.includes(audienceType))return res.status(400).json({error:'Invalid communication audience.'});
  if(['role','class','student','user'].includes(audienceType)&&!audienceValue)return res.status(400).json({error:'Select a specific recipient or audience.'});
  const r=await pool.query(`INSERT INTO communications(title,message,audience_type,audience_value,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[title,message,audienceType,audienceValue||null,req.user.id]);
  await audit(req.user.id,'SEND_COMMUNICATION',`${audienceType}:${audienceValue||'all'} — ${title}`); res.status(201).json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/communications/:id",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const r=await pool.query("DELETE FROM communications WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Communication not found'});await audit(req.user.id,'DELETE_COMMUNICATION',`id=${req.params.id}`);res.json({message:'Communication deleted'});}catch(e){res.status(400).json({error:e.message})}});

// Boarding / Patron workspace. Patron is the Boarding Master role.
const PATRON_VIEW_ROLES=['patron','admin','director','principal','secretary'];
const PATRON_MANAGE_ROLES=['patron','admin','director','principal'];
app.get('/api/patron/overview',auth(PATRON_VIEW_ROLES),async(req,res)=>{try{
  const [b,a,i]=await Promise.all([
    pool.query("SELECT COUNT(*)::int n FROM boarding_profiles WHERE boarding_status='active'"),
    pool.query("SELECT COUNT(*)::int n FROM boarding_attendance WHERE attendance_date=CURRENT_DATE AND status='present'"),
    pool.query("SELECT COUNT(*)::int n FROM boarding_incidents WHERE status IN ('open','follow_up')")
  ]);
  res.json({boarders:b.rows[0].n,present_today:a.rows[0].n,open_incidents:i.rows[0].n});
}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/patron/boarders',auth(PATRON_VIEW_ROLES),async(req,res)=>{try{
  const q=String(req.query.q||'').trim(),vals=[];let where="bp.boarding_status='active'";
  if(q){vals.push('%'+q+'%');where+=" AND (s.full_name ILIKE $1 OR s.admission_no ILIKE $1 OR COALESCE(bp.house,'') ILIKE $1 OR COALESCE(bp.hostel,'') ILIKE $1 OR COALESCE(bp.room,'') ILIKE $1)";}
  const r=await pool.query(`SELECT bp.*,s.admission_no,s.full_name,s.class_name,s.stream,s.parent_name,s.parent_phone FROM boarding_profiles bp JOIN students s ON s.id=bp.student_id WHERE ${where} ORDER BY s.class_name,s.full_name`,vals);res.json(r.rows);
}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/patron/boarders',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{
  const studentId=Number(req.body.student_id);if(!studentId)return res.status(400).json({error:'Student is required'});
  const st=(await pool.query('SELECT id FROM students WHERE id=$1',[studentId])).rows[0];if(!st)return res.status(404).json({error:'Student not found'});
  const r=await pool.query(`INSERT INTO boarding_profiles(student_id,boarding_status,house,hostel,room,bed_no,admitted_on,notes,created_by) VALUES($1,'active',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(student_id) DO UPDATE SET boarding_status='active',house=EXCLUDED.house,hostel=EXCLUDED.hostel,room=EXCLUDED.room,bed_no=EXCLUDED.bed_no,admitted_on=EXCLUDED.admitted_on,notes=EXCLUDED.notes,updated_at=NOW() RETURNING *`,[studentId,req.body.house||null,req.body.hostel||null,req.body.room||null,req.body.bed_no||null,req.body.admitted_on||null,req.body.notes||null,req.user.id]);await audit(req.user.id,'ADD_BOARDER',`student=${studentId}`);res.status(201).json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.patch('/api/patron/boarders/:id',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{
  const keys=['boarding_status','house','hostel','room','bed_no','admitted_on','notes'],f=[],v=[];for(const k of keys)if(req.body[k]!==undefined){f.push(`${k}=$${v.length+1}`);v.push(req.body[k]===''?null:req.body[k]);}if(!f.length)return res.status(400).json({error:'Nothing to update'});f.push('updated_at=NOW()');v.push(req.params.id);const r=await pool.query(`UPDATE boarding_profiles SET ${f.join(',')} WHERE id=$${v.length} RETURNING *`,v);if(!r.rows[0])return res.status(404).json({error:'Boarding record not found'});await audit(req.user.id,'UPDATE_BOARDER',`boarding=${req.params.id}`);res.json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/patron/boarders/:id',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{const r=await pool.query("UPDATE boarding_profiles SET boarding_status='inactive',updated_at=NOW() WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Boarding record not found'});await audit(req.user.id,'REMOVE_BOARDER',`boarding=${req.params.id}`);res.json({message:'Boarder removed from active boarding'});}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/patron/students',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{const r=await pool.query(`SELECT s.id,s.admission_no,s.full_name,s.class_name,s.stream FROM students s WHERE NOT EXISTS(SELECT 1 FROM boarding_profiles bp WHERE bp.student_id=s.id AND bp.boarding_status='active') ORDER BY ${classOrderSql('s')},s.full_name`);res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/patron/attendance',auth(PATRON_VIEW_ROLES),async(req,res)=>{try{const d=req.query.date||new Date().toISOString().slice(0,10);const r=await pool.query(`SELECT bp.id boarding_id,bp.house,bp.hostel,bp.room,s.id student_id,s.admission_no,s.full_name,s.class_name,COALESCE(ba.status,'present') status,ba.check_in,ba.check_out,ba.notes FROM boarding_profiles bp JOIN students s ON s.id=bp.student_id LEFT JOIN boarding_attendance ba ON ba.student_id=s.id AND ba.attendance_date=$1 WHERE bp.boarding_status='active' ORDER BY s.class_name,s.full_name`,[d]);res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/patron/attendance',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{const date=req.body.attendance_date||new Date().toISOString().slice(0,10),rows=Array.isArray(req.body.rows)?req.body.rows:[];if(!rows.length)return res.status(400).json({error:'No attendance rows supplied'});const c=await pool.connect();try{await c.query('BEGIN');for(const x of rows){const studentId=Number(x.student_id),status=['present','absent','late','excused'].includes(x.status)?x.status:'present';await c.query(`INSERT INTO boarding_attendance(student_id,attendance_date,status,check_in,check_out,notes,marked_by) SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM boarding_profiles WHERE student_id=$1 AND boarding_status='active') ON CONFLICT(student_id,attendance_date) DO UPDATE SET status=EXCLUDED.status,check_in=EXCLUDED.check_in,check_out=EXCLUDED.check_out,notes=EXCLUDED.notes,marked_by=EXCLUDED.marked_by,updated_at=NOW()`,[studentId,date,status,x.check_in||null,x.check_out||null,x.notes||null,req.user.id]);}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}await audit(req.user.id,'BOARDING_ATTENDANCE',date);await notifyApprovalRoles({title:'Patron boarding attendance report received',type:'patron-attendance-report',message:`Patron ${req.user.full_name} submitted boarding attendance for ${date}. It is available for management and secretary review/download.`,sourceId:`${date}:${req.user.id}`,actionUrl:'/review-centre.html#patron-reports'});res.json({message:'Boarding attendance saved'});}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/patron/incidents',auth(PATRON_VIEW_ROLES),async(req,res)=>{try{const r=await pool.query(`SELECT bi.*,s.admission_no,s.full_name,s.class_name,u.full_name creator FROM boarding_incidents bi JOIN students s ON s.id=bi.student_id JOIN users u ON u.id=bi.created_by ORDER BY bi.incident_date DESC,bi.id DESC LIMIT 200`);res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/patron/incidents',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{const studentId=Number(req.body.student_id),description=String(req.body.description||'').trim();if(!studentId||!description)return res.status(400).json({error:'Boarder and incident description are required'});const linked=(await pool.query("SELECT 1 FROM boarding_profiles WHERE student_id=$1 AND boarding_status='active'",[studentId])).rows[0];if(!linked)return res.status(400).json({error:'Select an active boarder'});const r=await pool.query(`INSERT INTO boarding_incidents(student_id,incident_date,category,description,action_taken,follow_up,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[studentId,req.body.incident_date||new Date().toISOString().slice(0,10),req.body.category||'General',description,req.body.action_taken||null,req.body.follow_up||null,['open','resolved','follow_up'].includes(req.body.status)?req.body.status:'open',req.user.id]);await audit(req.user.id,'CREATE_BOARDING_INCIDENT',`student=${studentId}`);await notifyApprovalRoles({title:'Patron welfare report received',type:'patron-welfare-report',message:`Patron ${req.user.full_name} submitted a boarding welfare/incident report for learner #${studentId}. It is available for management and secretary review/download.`,sourceId:r.rows[0].id,actionUrl:'/review-centre.html#patron-reports'});res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.patch('/api/patron/incidents/:id',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{const fields=[],vals=[];for(const k of ['category','description','action_taken','follow_up','status','incident_date'])if(req.body[k]!==undefined){fields.push(`${k}=$${vals.length+1}`);vals.push(req.body[k]);}if(!fields.length)return res.status(400).json({error:'Nothing to update'});fields.push('updated_at=NOW()');vals.push(req.params.id);const r=await pool.query(`UPDATE boarding_incidents SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING *`,vals);if(!r.rows[0])return res.status(404).json({error:'Incident not found'});res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/patron/incidents/:id',auth(PATRON_MANAGE_ROLES),async(req,res)=>{try{const r=await pool.query('DELETE FROM boarding_incidents WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Incident not found'});await audit(req.user.id,'DELETE_BOARDING_INCIDENT',`incident=${req.params.id}`);res.json({message:'Incident deleted'});}catch(e){res.status(400).json({error:e.message})}});

// Boarding reports: summary, attendance and welfare reports. Viewable by Patron/Boarding Master and school management.
function boardingReportDate(v,fallback){const x=String(v||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(x)?x:fallback}
function boardingReportDoc(title,meta,content){return docPage(title,`<div class="meta">${meta}</div>${content}`)}
app.get('/api/patron/reports/summary',auth(PATRON_VIEW_ROLES),async(req,res)=>{try{
  const from=boardingReportDate(req.query.from,'2000-01-01'),to=boardingReportDate(req.query.to,new Date().toISOString().slice(0,10));
  const [counts,houses,attendance,welfare]=await Promise.all([
    pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE boarding_status='active')::int active,COUNT(*) FILTER(WHERE boarding_status='inactive')::int inactive FROM boarding_profiles"),
    pool.query("SELECT COALESCE(NULLIF(house,''),'Unassigned') house,COALESCE(NULLIF(hostel,''),'Unassigned') hostel,COUNT(*)::int boarders FROM boarding_profiles WHERE boarding_status='active' GROUP BY 1,2 ORDER BY 1,2"),
    pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='present')::int present,COUNT(*) FILTER(WHERE status='absent')::int absent,COUNT(*) FILTER(WHERE status='late')::int late,COUNT(*) FILTER(WHERE status='excused')::int excused FROM boarding_attendance WHERE attendance_date BETWEEN $1 AND $2`,[from,to]),
    pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='open')::int open,COUNT(*) FILTER(WHERE status='follow_up')::int follow_up,COUNT(*) FILTER(WHERE status='resolved')::int resolved FROM boarding_incidents WHERE incident_date BETWEEN $1 AND $2`,[from,to])
  ]);
  res.json({from,to,boarders:counts.rows[0],houses:houses.rows,attendance:attendance.rows[0],welfare:welfare.rows[0]});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/patron/reports/attendance',auth(PATRON_VIEW_ROLES),async(req,res)=>{try{
 const from=boardingReportDate(req.query.from,new Date().toISOString().slice(0,10)),to=boardingReportDate(req.query.to,from),className=String(req.query.class_name||'').trim(),house=String(req.query.house||'').trim(),status=String(req.query.status||'').trim();
 const where=['ba.attendance_date BETWEEN $1 AND $2'],vals=[from,to];if(className){vals.push(className);where.push(`s.class_name=$${vals.length}`)}if(house){vals.push(house);where.push(`COALESCE(bp.house,'')=$${vals.length}`)}if(['present','absent','late','excused'].includes(status)){vals.push(status);where.push(`ba.status=$${vals.length}`)}
 const r=await pool.query(`SELECT ba.attendance_date,s.admission_no,s.full_name,s.class_name,COALESCE(bp.house,'—') house,COALESCE(bp.hostel,'—') hostel,COALESCE(bp.room,'—') room,ba.status,ba.check_in,ba.check_out,ba.notes FROM boarding_attendance ba JOIN students s ON s.id=ba.student_id LEFT JOIN boarding_profiles bp ON bp.student_id=s.id WHERE ${where.join(' AND ')} ORDER BY ba.attendance_date DESC,s.class_name,s.full_name`,vals);
 const summary=(await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE ba.status='present')::int present,COUNT(*) FILTER(WHERE ba.status='absent')::int absent,COUNT(*) FILTER(WHERE ba.status='late')::int late,COUNT(*) FILTER(WHERE ba.status='excused')::int excused FROM boarding_attendance ba JOIN students s ON s.id=ba.student_id LEFT JOIN boarding_profiles bp ON bp.student_id=s.id WHERE ${where.join(' AND ')}`,vals)).rows[0];
 if(String(req.query.download||'')==='1'){const pdf=new SimplePdf();pdfHeader(pdf,'BOARDING ATTENDANCE REPORT');pdfMeta(pdf,[['Period',`${from} to ${to}`],['Class',className||'All'],['House',house||'All'],['Status',status||'All']]);pdfTable(pdf,42,650,511,['Date','Adm','Student','Class','House','Hostel','Room','Status','In','Out','Notes'],r.rows.map(x=>[x.attendance_date,x.admission_no,x.full_name,x.class_name||'',x.house,x.hostel,x.room,x.status,x.check_in||'—',x.check_out||'—',x.notes||'']),[45,38,70,48,45,50,35,48,38,38,56]);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="boarding-attendance-${from}-to-${to}.pdf"`);return res.send(pdf.finalize())}
 res.json({from,to,filters:{class_name:className,house,status},summary,rows:r.rows});
}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/patron/reports/welfare',auth(PATRON_VIEW_ROLES),async(req,res)=>{try{
 const from=boardingReportDate(req.query.from,new Date().toISOString().slice(0,10)),to=boardingReportDate(req.query.to,from),category=String(req.query.category||'').trim(),status=String(req.query.status||'').trim();
 const where=['bi.incident_date BETWEEN $1 AND $2'],vals=[from,to];if(category){vals.push(category);where.push(`bi.category=$${vals.length}`)}if(['open','follow_up','resolved'].includes(status)){vals.push(status);where.push(`bi.status=$${vals.length}`)}
 const r=await pool.query(`SELECT bi.incident_date,s.admission_no,s.full_name,s.class_name,COALESCE(bp.house,'—') house,bi.category,bi.status,bi.description,bi.action_taken,bi.follow_up,u.full_name creator FROM boarding_incidents bi JOIN students s ON s.id=bi.student_id LEFT JOIN boarding_profiles bp ON bp.student_id=s.id LEFT JOIN users u ON u.id=bi.created_by WHERE ${where.join(' AND ')} ORDER BY bi.incident_date DESC,bi.id DESC`,vals);
 const summary=(await pool.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE bi.status='open')::int open,COUNT(*) FILTER(WHERE bi.status='follow_up')::int follow_up,COUNT(*) FILTER(WHERE bi.status='resolved')::int resolved FROM boarding_incidents bi WHERE ${where.join(' AND ')}`,vals)).rows[0];
 if(String(req.query.download||'')==='1'){const pdf=new SimplePdf();pdfHeader(pdf,'BOARDING WELFARE / INCIDENT REPORT');pdfMeta(pdf,[['Period',`${from} to ${to}`],['Category',category||'All'],['Status',status||'All']]);pdfTable(pdf,42,650,511,['Date','Adm','Student','Class','House','Category','Status','Description','Action','Follow-up','By'],r.rows.map(x=>[x.incident_date,x.admission_no,x.full_name,x.class_name||'',x.house,x.category,x.status,x.description||'',x.action_taken||'—',x.follow_up||'—',x.creator||'']),[45,38,68,45,42,52,42,80,55,55,34]);res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="boarding-welfare-${from}-to-${to}.pdf"`);return res.send(pdf.finalize())}
 res.json({from,to,filters:{category,status},summary,rows:r.rows});
}catch(e){res.status(500).json({error:e.message})}});

// Role-specific profiles
app.get("/api/my/student/results",auth(["student"]),async(req,res)=>{try{ res.set("Cache-Control","no-store");
 const st=(await pool.query("SELECT * FROM students WHERE user_id=$1",[req.user.id])).rows[0]; if(!st)return res.status(404).json({error:'Student profile not linked'});
 const exams=(await pool.query(`SELECT e.id,e.name,e.term,e.academic_year,e.exam_date,COUNT(m.id)::int subjects,COALESCE(SUM(m.marks),0) total,ROUND(COALESCE(AVG(m.marks),0),2) average FROM exams e LEFT JOIN marks m ON m.exam_id=e.id AND m.student_id=$1 GROUP BY e.id ORDER BY e.academic_year DESC,e.id DESC`,[st.id])).rows;
 const marks=(await pool.query(`SELECT m.exam_id,m.marks,m.grade,m.teacher_comment,sub.code,sub.name subject FROM marks m JOIN subjects sub ON sub.id=m.subject_id WHERE m.student_id=$1 ORDER BY m.exam_id DESC,sub.name`,[st.id])).rows;
 const grouped=new Map(); for(const x of marks){if(!grouped.has(x.exam_id))grouped.set(x.exam_id,[]);grouped.get(x.exam_id).push(x)}
 res.json({student:st,exams:exams.map(e=>({...e,total:Number(e.total||0),average:Number(e.average||0),marks:grouped.get(e.id)||[]}))});
}catch(e){res.status(500).json({error:'Unable to load live results. Please refresh and try again.'})}});
app.get("/api/my/student",auth(["student"]),async(req,res)=>{ res.set("Cache-Control","no-store");const r=await pool.query("SELECT s.*,u.phone AS account_phone,u.email AS account_email FROM students s LEFT JOIN users u ON u.id=s.user_id WHERE s.user_id=$1",[req.user.id]);if(!r.rows[0])return res.status(404).json({error:"Student profile not linked"});res.json(r.rows[0])});
app.get("/api/my/children",auth(["parent"]),async(req,res)=>{try{ res.set("Cache-Control","no-store");
  let monthly=0;
  try{const setting=(await pool.query("SELECT value FROM fee_settings WHERE setting_key='monthly_fee_amount' LIMIT 1")).rows[0];monthly=Number(setting?.value||0);if(monthly>0)await applyMonthlyFeeCharges(monthly);}catch(e){console.warn("Parent monthly fee check warning:",e.message)}
  const rows=(await pool.query(`SELECT s.*,
    COALESCE((SELECT SUM(c.amount) FROM fee_charges c WHERE c.student_id=s.id),0) charged,
    COALESCE((SELECT SUM(p.amount) FROM fee_records p WHERE p.student_id=s.id),0) paid
    FROM students s WHERE s.parent_phone=$1 OR s.parent_name=$2 OR s.admission_no=$3 ORDER BY full_name`,[req.user.phone,req.user.full_name,req.user.username])).rows;
  res.json(rows.map(x=>({...x,charged:Number(x.charged),paid:Number(x.paid),balance:Number(x.charged)-Number(x.paid),monthly_fee:monthly})));
}catch(e){console.error("Parent children query failed:",e);res.status(500).json({error:"Unable to load live child information. Please refresh and try again."})}});

app.get("/api/my/children/:id/results",auth(["parent"]),async(req,res)=>{try{ res.set("Cache-Control","no-store");
  const studentId=Number(req.params.id);
  const s=(await pool.query(`SELECT s.id,s.admission_no,s.full_name,s.class_name,s.stream FROM students s WHERE s.id=$1 AND (s.parent_phone=$2 OR s.parent_name=$3 OR s.admission_no=$4)`,[studentId,req.user.phone,req.user.full_name,req.user.username])).rows[0];
  if(!s)return res.status(403).json({error:"This learner is not linked to your parent account."});
  const exams=(await pool.query(`SELECT e.id,e.name,e.term,e.academic_year,e.exam_date,COUNT(m.id)::int subjects,COALESCE(SUM(m.marks),0) total,ROUND(COALESCE(AVG(m.marks),0),2) average FROM exams e LEFT JOIN marks m ON m.exam_id=e.id AND m.student_id=$1 GROUP BY e.id ORDER BY e.academic_year DESC,e.id DESC`,[studentId])).rows;
  const marks=(await pool.query(`SELECT m.exam_id,m.marks,m.grade,m.teacher_comment,sub.code,sub.name subject FROM marks m JOIN subjects sub ON sub.id=m.subject_id WHERE m.student_id=$1 ORDER BY m.exam_id DESC,sub.name`,[studentId])).rows;
  const grouped=new Map(); for(const x of marks){if(!grouped.has(x.exam_id))grouped.set(x.exam_id,[]);grouped.get(x.exam_id).push(x)}
  res.json({student:s,exams:exams.map(e=>({...e,total:Number(e.total||0),average:Number(e.average||0),marks:grouped.get(e.id)||[]}))});
}catch(e){console.error("Parent results query failed:",e);res.status(500).json({error:"Unable to load learner results. Please refresh and try again."})}});

// Parent/Student live document center — derived from current records on every request.
app.get("/api/my/documents",auth(["parent","student"]),async(req,res)=>{
  try{
    res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    const docs=[];
    const students=[];
    if(req.user.role==='student'){
      const st=(await pool.query("SELECT id,full_name,admission_no,class_name FROM students WHERE user_id=$1",[req.user.id])).rows[0];
      if(!st)return res.status(404).json({error:'Student profile not linked'});
      students.push(st);
    }else{
      const rows=(await pool.query(`SELECT id,full_name,admission_no,class_name FROM students WHERE parent_phone=$1 OR parent_name=$2 ORDER BY full_name`,[req.user.phone,req.user.full_name])).rows;
      students.push(...rows);
    }
    for(const st of students){
      const feeRows=await pool.query(`SELECT COUNT(*)::int n,COALESCE(SUM(amount),0) total FROM fee_charges WHERE student_id=$1`,[st.id]);
      const payRows=await pool.query(`SELECT COUNT(*)::int n,COALESCE(SUM(amount),0) total FROM fee_records WHERE student_id=$1`,[st.id]);
      if(Number(feeRows.rows[0].n)||Number(payRows.rows[0].n)) docs.push({type:'fees',student_id:st.id,student_name:st.full_name,title:'Fees Statement',description:'Current charges, payments and balance',updated_at:new Date().toISOString(),url:`/api/documents/student/${st.id}`,download_name:`${st.full_name}-fees-statement.html`});
      const exams=(await pool.query(`SELECT e.id,e.name,e.term,e.academic_year,e.exam_date,COUNT(m.id)::int marks_count,MAX(m.updated_at) marks_updated_at,MAX(m.id) last_mark_id FROM exams e JOIN marks m ON m.exam_id=e.id AND m.student_id=$1 GROUP BY e.id ORDER BY e.academic_year DESC,e.id DESC`,[st.id])).rows;
      for(const e of exams) docs.push({type:'result',student_id:st.id,student_name:st.full_name,exam_id:e.id,title:`${e.name} Result`,description:`${e.term||''} ${e.academic_year||''}`.trim(),updated_at:e.marks_updated_at||null,url:`/api/documents/result/${e.id}/${st.id}`,download_name:`${st.full_name}-${e.name}-result.html`});
      const reports=(await pool.query(`SELECT id,subject_name,term,academic_year,updated_at,created_at FROM (SELECT r.id,sub.name subject_name,r.term,r.academic_year,r.updated_at,r.created_at FROM student_subject_reports r JOIN subjects sub ON sub.id=r.subject_id WHERE r.student_id=$1 AND r.status='approved') q ORDER BY academic_year DESC,updated_at DESC NULLS LAST,created_at DESC`,[st.id])).rows;
      for(const r of reports) docs.push({type:'subject-report',student_id:st.id,student_name:st.full_name,report_id:r.id,title:`${r.subject_name} Subject Report`,description:`Approved ${r.term||''} ${r.academic_year||''}`.trim(),updated_at:r.updated_at||r.created_at,url:`/api/documents/student-subject-report/${r.id}`,download_name:`${st.full_name}-${r.subject_name}-subject-report.html`});
      const taf=(await pool.query(`SELECT id,assessment_type,period_label,academic_year,updated_at,created_at FROM tafhid_assessments WHERE student_id=$1 ORDER BY academic_year DESC,created_at DESC`,[st.id])).rows;
      for(const r of taf) docs.push({type:'tafhid',student_id:st.id,student_name:st.full_name,assessment_id:r.id,title:`Tahfidh ${r.assessment_type==='end_term'?'End-Term':'Monthly'} Record`,description:`${r.period_label||''} ${r.academic_year||''}`.trim(),updated_at:r.updated_at||r.created_at,url:`/api/documents/tafhid-assessment/${r.id}`,download_name:`${st.full_name}-Tahfidh-${r.period_label||'record'}.html`});
      const resources=(await pool.query(`SELECT id,title,subject_id,class_name,term,academic_year,created_at FROM exam_resources WHERE status='approved' AND LOWER(TRIM(class_name))=LOWER(TRIM($1)) ORDER BY created_at DESC`,[st.class_name])).rows;
      for(const r of resources) docs.push({type:'exam-resource',student_id:st.id,student_name:st.full_name,resource_id:r.id,title:r.title,description:`Exam resource · ${r.term||''} ${r.academic_year||''}`.trim(),updated_at:r.created_at,url:`/api/exam-resources/${r.id}/download?student_id=${st.id}`,download_name:r.title});
    }
    docs.sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0));
    res.json({generated_at:new Date().toISOString(),students,documents:docs});
  }catch(e){console.error('Live document center failed:',e);res.status(500).json({error:'Unable to load live documents. Please refresh.'})}
});

// Student Subject Reports — assignment/learner helpers. These routes only support the report module.
app.get("/api/student-subject-reports/assignments",auth(["teacher"]),async(req,res)=>{try{
  const rows=(await pool.query(`SELECT ta.id,ta.subject_id,ta.class_name,sub.code subject_code,sub.name subject_name
    FROM teacher_assignments ta JOIN subjects sub ON sub.id=ta.subject_id
    WHERE ta.teacher_id=$1 AND ta.assignment_type='subject' ORDER BY sub.name,ta.class_name,ta.id`,[req.user.id])).rows;
  res.json(rows);
}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/student-subject-reports/learners",auth(["teacher"]),async(req,res)=>{try{
  const assignmentId=Number(req.query.assignment_id);
  const a=(await pool.query(`SELECT id,subject_id,class_name FROM teacher_assignments WHERE id=$1 AND teacher_id=$2 AND assignment_type='subject'`,[assignmentId,req.user.id])).rows[0];
  if(!a)return res.status(404).json({error:'Assigned subject/class not found'});
  const rows=(await pool.query(`SELECT id,admission_no,full_name,class_name FROM students WHERE LOWER(TRIM(class_name))=LOWER(TRIM($1)) ORDER BY full_name`,[a.class_name])).rows;
  res.json({assignment:a,learners:rows});
}catch(e){res.status(500).json({error:e.message})}});

// Syllabus Coverage & Teaching Plans: subject teachers report progress for their assigned learning areas/classes.
app.get("/api/syllabus-coverage/assignments",auth(["teacher"]),async(req,res)=>{try{
  const rows=(await pool.query(`SELECT ta.id,ta.subject_id,ta.class_name,s.code subject_code,s.name subject_name
    FROM teacher_assignments ta JOIN subjects s ON s.id=ta.subject_id
    WHERE ta.teacher_id=$1 AND ta.assignment_type='subject' ORDER BY ta.class_name,s.name`,[req.user.id])).rows;
  res.json(rows);
}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/syllabus-coverage",auth(["teacher","admin","secretary","director","principal"]),async(req,res)=>{try{
  const vals=[],where=[];
  if(req.query.status){vals.push(String(req.query.status));where.push(`r.status=$${vals.length}`)}
  if(req.query.class_name){vals.push(normalizeClass(req.query.class_name));where.push(`LOWER(TRIM(r.class_name))=LOWER(TRIM($${vals.length}))`)}
  if(req.query.subject_id){vals.push(Number(req.query.subject_id));where.push(`r.subject_id=$${vals.length}`)}
  if(req.user.role==='teacher'){vals.push(req.user.id);where.push(`r.created_by=$${vals.length}`)}
  const q=`SELECT r.*,s.code subject_code,s.name subject_name,u.full_name teacher_name,rv.full_name reviewer_name
    FROM syllabus_coverage_reports r JOIN subjects s ON s.id=r.subject_id JOIN users u ON u.id=r.created_by
    LEFT JOIN users rv ON rv.id=r.reviewed_by ${where.length?'WHERE '+where.join(' AND '):''}
    ORDER BY r.academic_year DESC,r.term DESC,r.created_at DESC`;
  res.json((await pool.query(q,vals)).rows);
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/syllabus-coverage",auth(["teacher"]),async(req,res)=>{try{
  const assignmentId=Number(req.body.assignment_id),term=String(req.body.term||'').trim(),year=Number(req.body.academic_year||new Date().getFullYear());
  const coverage=Number(req.body.coverage_percent);
  if(!assignmentId||!term||!year)return res.status(400).json({error:'Assigned learning area/class, term and academic year are required'});
  if(!Number.isFinite(coverage)||coverage<0||coverage>100)return res.status(400).json({error:'Syllabus coverage must be between 0 and 100%'});
  const a=(await pool.query(`SELECT id,subject_id,class_name FROM teacher_assignments WHERE id=$1 AND teacher_id=$2 AND assignment_type='subject'`,[assignmentId,req.user.id])).rows[0];
  if(!a)return res.status(403).json({error:'You can report only for your assigned learning area and class'});
  const existing=(await pool.query(`SELECT id,status FROM syllabus_coverage_reports WHERE created_by=$1 AND subject_id=$2 AND LOWER(TRIM(class_name))=LOWER(TRIM($3)) AND term=$4 AND academic_year=$5`,[req.user.id,a.subject_id,a.class_name,term,year])).rows[0];
  if(existing?.status==='approved')return res.status(409).json({error:'This syllabus coverage report is already approved. Start a new term or academic year report.'});
  const fields=[String(req.body.topics_covered||'').trim(),String(req.body.topics_pending||'').trim(),String(req.body.challenges||'').trim(),String(req.body.plans||'').trim(),String(req.body.resources_needed||'').trim(),req.body.target_completion_date||null,String(req.body.teacher_comment||'').trim()];
  const r=await pool.query(`INSERT INTO syllabus_coverage_reports(subject_id,class_name,term,academic_year,coverage_percent,topics_covered,topics_pending,challenges,plans,resources_needed,target_completion_date,teacher_comment,created_by,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
    ON CONFLICT(created_by,subject_id,class_name,term,academic_year) DO UPDATE SET coverage_percent=EXCLUDED.coverage_percent,topics_covered=EXCLUDED.topics_covered,topics_pending=EXCLUDED.topics_pending,challenges=EXCLUDED.challenges,plans=EXCLUDED.plans,resources_needed=EXCLUDED.resources_needed,target_completion_date=EXCLUDED.target_completion_date,teacher_comment=EXCLUDED.teacher_comment,status='pending',reviewed_by=NULL,reviewed_at=NULL,review_note=NULL,updated_at=NOW()
    RETURNING *`,[a.subject_id,normalizeClass(a.class_name),term,year,coverage,...fields,req.user.id]);
  await audit(req.user.id,'SUBMIT_SYLLABUS_COVERAGE_REPORT',`report=${r.rows[0].id},subject=${a.subject_id},class=${a.class_name}`);await notifyApprovalRoles({title:'Syllabus coverage approval required',type:'syllabus-coverage-request',message:`Teacher ${req.user.full_name} submitted syllabus coverage for ${a.class_name}. Please review and approve or reject it.`,sourceId:r.rows[0].id,actionUrl:'/review-centre.html#syllabus'});res.status(201).json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/syllabus-coverage/:id",auth(["admin","director","principal","teacher"]),async(req,res)=>{try{
  const id=Number(req.params.id),cur=(await pool.query('SELECT * FROM syllabus_coverage_reports WHERE id=$1',[id])).rows[0];if(!cur)return res.status(404).json({error:'Syllabus coverage report not found'});
  if(req.user.role==='teacher'){
    if(Number(cur.created_by)!==Number(req.user.id))return res.status(403).json({error:'You can edit only your own report'});
    if(['approved'].includes(cur.status))return res.status(400).json({error:'Approved reports cannot be edited'});
    const coverage=req.body.coverage_percent!==undefined?Number(req.body.coverage_percent):Number(cur.coverage_percent);if(!Number.isFinite(coverage)||coverage<0||coverage>100)return res.status(400).json({error:'Syllabus coverage must be between 0 and 100%'});
    const r=await pool.query(`UPDATE syllabus_coverage_reports SET coverage_percent=$1,topics_covered=$2,topics_pending=$3,challenges=$4,plans=$5,resources_needed=$6,target_completion_date=$7,teacher_comment=$8,status='pending',reviewed_by=NULL,reviewed_at=NULL,review_note=NULL,updated_at=NOW() WHERE id=$9 RETURNING *`,[coverage,String((req.body.topics_covered!==undefined?req.body.topics_covered:cur.topics_covered)||'').trim(),String((req.body.topics_pending!==undefined?req.body.topics_pending:cur.topics_pending)||'').trim(),String((req.body.challenges!==undefined?req.body.challenges:cur.challenges)||'').trim(),String((req.body.plans!==undefined?req.body.plans:cur.plans)||'').trim(),String((req.body.resources_needed!==undefined?req.body.resources_needed:cur.resources_needed)||'').trim(),req.body.target_completion_date!==undefined?req.body.target_completion_date:(cur.target_completion_date||null),String((req.body.teacher_comment!==undefined?req.body.teacher_comment:cur.teacher_comment)||'').trim(),id]);return res.json(r.rows[0]);
  }
  const status=['approved','rejected'].includes(req.body.status)?req.body.status:null;if(!status)return res.status(400).json({error:'Status must be approved or rejected'});const note=String(req.body.review_note||'').trim();if(status==='rejected'&&!note)return res.status(400).json({error:'A rejection reason is required'});
  const r=await pool.query(`UPDATE syllabus_coverage_reports SET status=$1,reviewed_by=$2,reviewed_at=NOW(),review_note=$3,updated_at=NOW() WHERE id=$4 RETURNING *`,[status,req.user.id,note||null,id]);await audit(req.user.id,status==='approved'?'APPROVE_SYLLABUS_COVERAGE_REPORT':'REJECT_SYLLABUS_COVERAGE_REPORT',`report=${id}`);res.json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/syllabus-coverage/:id",auth(["admin","director","principal"]),async(req,res)=>{try{const r=await pool.query('DELETE FROM syllabus_coverage_reports WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Report not found'});await audit(req.user.id,'DELETE_SYLLABUS_COVERAGE_REPORT',`report=${req.params.id}`);res.json({message:'Report deleted'})}catch(e){res.status(400).json({error:e.message})}});

// Student Subject Reports / Strand Analysis: teacher observations with administration workflow.
app.get("/api/student-subject-reports",auth(["teacher","ustadh","admin","secretary","director","principal"]),async(req,res)=>{try{
  const vals=[],where=[];
  if(req.query.student_id){vals.push(Number(req.query.student_id));where.push(`r.student_id=$${vals.length}`)}
  if(req.query.status){vals.push(String(req.query.status));where.push(`r.status=$${vals.length}`)}
  if(req.user.role==='teacher'){vals.push(req.user.id);where.push(`(r.created_by=$${vals.length} OR EXISTS(SELECT 1 FROM teacher_assignments ta WHERE ta.teacher_id=$${vals.length} AND ta.subject_id=r.subject_id AND ta.assignment_type='subject' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM(r.class_name))))`)}
  const q=`SELECT r.*,s.admission_no,s.full_name student_name,s.class_name,sub.code subject_code,sub.name subject_name,u.full_name teacher_name,rv.full_name reviewer_name,
    COALESCE((SELECT json_agg(json_build_object('id',x.id,'strand',x.strand,'rating',x.rating,'observation',x.observation) ORDER BY x.id) FROM student_subject_report_strands x WHERE x.report_id=r.id),'[]'::json) strands
    FROM student_subject_reports r JOIN students s ON s.id=r.student_id JOIN subjects sub ON sub.id=r.subject_id JOIN users u ON u.id=r.created_by LEFT JOIN users rv ON rv.id=r.reviewed_by
    ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY r.created_at DESC`;
  res.json((await pool.query(q,vals)).rows);
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/student-subject-reports",auth(["teacher"]),async(req,res)=>{const c=await pool.connect();try{
  const studentId=Number(req.body.student_id),assignmentId=Number(req.body.assignment_id),term=String(req.body.term||'').trim(),year=Number(req.body.academic_year||new Date().getFullYear());
  if(!studentId||!assignmentId||!term)return res.status(400).json({error:'Learner, assigned subject/class, term and academic year are required'});
  const assignment=(await pool.query(`SELECT id,subject_id,class_name FROM teacher_assignments WHERE id=$1 AND teacher_id=$2 AND assignment_type='subject'`,[assignmentId,req.user.id])).rows[0];
  if(!assignment)return res.status(403).json({error:'You can report only for your assigned subject and class'});
  const subjectId=Number(assignment.subject_id),className=normalizeClass(assignment.class_name);
  const st=(await pool.query('SELECT id,class_name FROM students WHERE id=$1',[studentId])).rows[0]; if(!st)return res.status(404).json({error:'Learner not found'});
  if(normalizeClass(st.class_name)!==className)return res.status(400).json({error:'Selected learner is not in the assigned class'});
  const strands=Array.isArray(req.body.strands)?req.body.strands.filter(x=>String(x.strand||'').trim()).slice(0,30):[];
  if(!strands.length)return res.status(400).json({error:'Add at least one strand observation'});
  await c.query('BEGIN');
  const rr=await c.query(`INSERT INTO student_subject_reports(student_id,subject_id,class_name,term,academic_year,strengths,weaknesses,recommended_intervention,general_comment,created_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,[studentId,subjectId,className,term,year,String(req.body.strengths||'').trim(),String(req.body.weaknesses||'').trim(),String(req.body.recommended_intervention||'').trim(),String(req.body.general_comment||'').trim(),req.user.id]);
  for(const x of strands){await c.query('INSERT INTO student_subject_report_strands(report_id,strand,rating,observation) VALUES($1,$2,$3,$4)',[rr.rows[0].id,String(x.strand).trim(),['strength','developing','needs_support'].includes(x.rating)?x.rating:'developing',String(x.observation||'').trim()])}
  await c.query('COMMIT');await audit(req.user.id,'SUBMIT_STUDENT_SUBJECT_REPORT',`report=${rr.rows[0].id},student=${studentId},subject=${subjectId}`);await notifyApprovalRoles({title:'Student subject report approval required',type:'student-subject-report-request',message:`Teacher ${req.user.full_name} submitted a learner subject report for student #${studentId}. Please review and approve or reject it.`,sourceId:rr.rows[0].id,actionUrl:'/review-centre.html#subject-reports'});res.status(201).json({id:rr.rows[0].id,status:'pending'});
}catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(400).json({error:e.message})}finally{c.release()}});
app.patch("/api/student-subject-reports/:id",auth(["admin","director","principal"]),async(req,res)=>{try{
  const id=Number(req.params.id),status=['approved','rejected'].includes(req.body.status)?req.body.status:null;if(!status)return res.status(400).json({error:'Status must be approved or rejected'});
  const note=String(req.body.review_note||'').trim();if(status==='rejected'&&!note)return res.status(400).json({error:'A rejection reason is required'});
  const r=await pool.query(`UPDATE student_subject_reports SET status=$1,reviewed_by=$2,reviewed_at=NOW(),review_note=$3,updated_at=NOW() WHERE id=$4 RETURNING *`,[status,req.user.id,note||null,id]);if(!r.rows[0])return res.status(404).json({error:'Report not found'});await audit(req.user.id,status==='approved'?'APPROVE_STUDENT_SUBJECT_REPORT':'REJECT_STUDENT_SUBJECT_REPORT',`report=${id}`);await notifyUserWhatsApp(r.rows[0].created_by,{eventType:'student-subject-report',sourceId:id,message:`Green Star: Your student subject report #${id} was ${status} by ${req.user.full_name}.${note?' Note: '+note:''}`});res.json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/student-subject-reports/:id",auth(["admin","director","principal"]),async(req,res)=>{try{const r=await pool.query('DELETE FROM student_subject_reports WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Report not found'});await audit(req.user.id,'DELETE_STUDENT_SUBJECT_REPORT',`report=${req.params.id}`);res.json({message:'Report deleted'})}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/my/subject-reports",auth(["parent","student"]),async(req,res)=>{try{
  const linked=req.user.role==='student'?`s.user_id=$1`:`(s.parent_phone=$1 OR s.parent_name=$2)`;const vals=req.user.role==='student'?[req.user.id]:[req.user.phone,req.user.full_name];
  const q=`SELECT r.*,s.admission_no,s.full_name student_name,s.class_name,sub.code subject_code,sub.name subject_name,u.full_name teacher_name,rv.full_name reviewer_name,COALESCE((SELECT json_agg(json_build_object('strand',x.strand,'rating',x.rating,'observation',x.observation) ORDER BY x.id) FROM student_subject_report_strands x WHERE x.report_id=r.id),'[]'::json) strands FROM student_subject_reports r JOIN students s ON s.id=r.student_id JOIN subjects sub ON sub.id=r.subject_id JOIN users u ON u.id=r.created_by LEFT JOIN users rv ON rv.id=r.reviewed_by WHERE r.status='approved' AND ${linked} ORDER BY r.academic_year DESC,r.created_at DESC`;
  res.json((await pool.query(q,vals)).rows);
}catch(e){res.status(500).json({error:e.message})}});


app.get("/api/documents/syllabus-coverage/:id",auth(["teacher","admin","secretary","director","principal"]),async(req,res)=>{try{
 const r=(await pool.query(`SELECT r.*,s.code subject_code,s.name subject_name,u.full_name teacher_name,rv.full_name reviewer_name FROM syllabus_coverage_reports r JOIN subjects s ON s.id=r.subject_id JOIN users u ON u.id=r.created_by LEFT JOIN users rv ON rv.id=r.reviewed_by WHERE r.id=$1`,[req.params.id])).rows[0];
 if(!r)return res.status(404).send('Syllabus coverage report not found');if(r.status!=='approved')return res.status(400).send('This syllabus coverage report has not been approved.');
 if(req.user.role==='teacher'&&Number(r.created_by)!==Number(req.user.id))return res.status(403).send('Only the subject teacher who wrote this report can download it.');
 const h=docPage('SYLLABUS COVERAGE & TEACHING PLAN',`<div class="section"><p><b>Learning Area:</b> ${esc(r.subject_name)} (${esc(r.subject_code||'')}) &nbsp; <b>Class:</b> ${esc(r.class_name)}</p><p><b>Term:</b> ${esc(r.term)} &nbsp; <b>Academic Year:</b> ${esc(r.academic_year)} &nbsp; <b>Coverage:</b> ${Number(r.coverage_percent||0).toFixed(0)}%</p><p><b>Subject Teacher:</b> ${esc(r.teacher_name)}</p><h3>Syllabus Covered</h3><p>${esc(r.topics_covered||'—').replace(/\n/g,'<br>')}</p><h3>Pending / Not Yet Covered</h3><p>${esc(r.topics_pending||'—').replace(/\n/g,'<br>')}</p><h3>Challenges / Gaps</h3><p>${esc(r.challenges||'—').replace(/\n/g,'<br>')}</p><h3>Teaching Plan / Next Steps</h3><p>${esc(r.plans||'—').replace(/\n/g,'<br>')}</p><h3>Resources Needed</h3><p>${esc(r.resources_needed||'—').replace(/\n/g,'<br>')}</p><p><b>Target Completion Date:</b> ${esc(r.target_completion_date||'—')}</p><h3>Teacher Comment</h3><p>${esc(r.teacher_comment||'—').replace(/\n/g,'<br>')}</p><p><b>Approval:</b> Approved by ${esc(r.reviewer_name||'School Administration')} on ${r.reviewed_at?new Date(r.reviewed_at).toLocaleString():''}.</p></div>`);
 if(String(req.query.download||'')==='1'){const p=new SimplePdf();pdfHeader(p,'SYLLABUS COVERAGE & TEACHING PLAN');pdfMeta(p,[['Learning Area',r.subject_name],['Class',r.class_name],['Term',r.term],['Academic Year',r.academic_year],['Coverage',Number(r.coverage_percent||0).toFixed(0)+'%'],['Teacher',r.teacher_name]]);let y=620;for(const pair of [['Syllabus Covered',r.topics_covered],['Pending / Not Yet Covered',r.topics_pending],['Challenges / Gaps',r.challenges],['Teaching Plan / Next Steps',r.plans],['Resources Needed',r.resources_needed],['Teacher Comment',r.teacher_comment],['Approval',`Approved by ${r.reviewer_name||'School Administration'} on ${r.reviewed_at?new Date(r.reviewed_at).toLocaleString():''}`]]){if(y<80){p.newPage();pdfHeader(p,'SYLLABUS COVERAGE — CONTINUED');y=720}p.text(42,y,pair[0],9,true);y-=15;for(const line of pdfWrap(pair[1]||'—',95)){if(y<70){p.newPage();pdfHeader(p,'SYLLABUS COVERAGE — CONTINUED');y=720}p.text(42,y,line,8);y-=12}y-=10}const pdf=p.finalize();res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="syllabus-coverage-${r.class_name}-${r.term}-${r.academic_year}.pdf"`.replace(/[^a-zA-Z0-9._ -]/g,'_'));res.setHeader('Cache-Control','no-store');return res.send(pdf)}res.type('html').send(h);
}catch(e){res.status(500).send(e.message)}});
app.get("/api/documents/student-subject-report/:id",auth(["teacher","admin","secretary","director","principal","student","parent"]),async(req,res)=>{try{
 const r=(await pool.query(`SELECT r.*,s.admission_no,s.full_name student_name,s.class_name,s.stream,sub.code subject_code,sub.name subject_name,u.full_name teacher_name,rv.full_name reviewer_name,
 COALESCE((SELECT json_agg(json_build_object('strand',x.strand,'rating',x.rating,'observation',x.observation) ORDER BY x.id) FROM student_subject_report_strands x WHERE x.report_id=r.id),'[]'::json) strands
 FROM student_subject_reports r JOIN students s ON s.id=r.student_id JOIN subjects sub ON sub.id=r.subject_id JOIN users u ON u.id=r.created_by LEFT JOIN users rv ON rv.id=r.reviewed_by WHERE r.id=$1`,[req.params.id])).rows[0];
 if(!r)return res.status(404).send('Subject report not found');
 if(r.status!=='approved')return res.status(400).send('This subject report has not been approved.');
 if(req.user.role==='teacher'&&Number(r.created_by)!==Number(req.user.id))return res.status(403).send('Only the subject teacher who wrote this report can download it.');
 if(req.user.role==='parent'){const linked=await pool.query("SELECT 1 FROM students WHERE id=$1 AND (parent_phone=$2 OR parent_name=$3) LIMIT 1",[r.student_id,req.user.phone,req.user.full_name]);if(!linked.rows[0])return res.status(403).send('This learner is not linked to your parent account.');}
 if(req.user.role==='student'){const linked=await pool.query("SELECT 1 FROM students WHERE id=$1 AND user_id=$2 LIMIT 1",[r.student_id,req.user.id]);if(!linked.rows[0])return res.status(403).send('This report is not linked to your student account.');}
 const labels={strength:'Strength',developing:'Developing',needs_support:'Needs Support'};
 const rows=(r.strands||[]).map(x=>`<tr><td>${esc(x.strand)}</td><td>${esc(labels[x.rating]||x.rating)}</td><td>${esc(x.observation||'')}</td></tr>`).join('');
 if(String(req.query.download||'')==='1'){const p=new SimplePdf();pdfHeader(p,'STUDENT SUBJECT REPORT');pdfMeta(p,[['Learner',r.student_name],['Admission No.',r.admission_no],['Class',r.class_name],['Learning Area',r.subject_name],['Term',r.term],['Academic Year',r.academic_year],['Teacher',r.teacher_name]]);let y=610;p.text(42,y,'STRAND OBSERVATIONS',10,true);y-=16;const labels={strength:'Strength',developing:'Developing',needs_support:'Needs Support'};y=pdfTable(p,42,y,511,['Strand','Level','Observation'],(r.strands||[]).map(x=>[x.strand,labels[x.rating]||x.rating,x.observation||'']),[125,80,306])-18;for(const pair of [['Strengths',r.strengths],['Areas needing support',r.weaknesses],['Recommended intervention',r.recommended_intervention],['Overall teacher comment',r.general_comment],['Approval',`Approved by ${r.reviewer_name||'School Administration'} on ${r.reviewed_at?new Date(r.reviewed_at).toLocaleString():''}`]]){if(y<80){p.newPage();pdfHeader(p,'STUDENT SUBJECT REPORT — CONTINUED');y=720}p.text(42,y,pair[0],9,true);y-=14;for(const line of pdfWrap(pair[1]||'—',95)){if(y<70){p.newPage();pdfHeader(p,'STUDENT SUBJECT REPORT — CONTINUED');y=720}p.text(42,y,line,8);y-=12}y-=9}const pdf=p.finalize();res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`attachment; filename="${r.student_name}-${r.subject_name}-subject-report.pdf"`.replace(/[^a-zA-Z0-9._ -]/g,'_'));res.setHeader('Cache-Control','no-store');return res.send(pdf)}res.type('html').send(docPage('STUDENT SUBJECT REPORT',`<div class="summary"><div class="box"><b>Learner</b><br>${esc(r.student_name)}</div><div class="box"><b>Admission</b><br>${esc(r.admission_no)}</div><div class="box"><b>Class</b><br>${esc(r.class_name)}</div></div><p><b>Learning Area:</b> ${esc(r.subject_name)} (${esc(r.subject_code||'')}) &nbsp; <b>Term:</b> ${esc(r.term)} &nbsp; <b>Year:</b> ${esc(r.academic_year)}</p><p><b>Subject Teacher:</b> ${esc(r.teacher_name)}</p><table><tr><th>Strand</th><th>Level</th><th>Teacher Observation</th></tr>${rows}</table><div class="section"><p><b>Strengths:</b> ${esc(r.strengths||'—')}</p><p><b>Areas needing support:</b> ${esc(r.weaknesses||'—')}</p><p><b>Recommended intervention:</b> ${esc(r.recommended_intervention||'—')}</p><p><b>Overall teacher comment:</b> ${esc(r.general_comment||'—')}</p><p><b>Approval:</b> Approved by ${esc(r.reviewer_name||'School Administration')} on ${r.reviewed_at?new Date(r.reviewed_at).toLocaleString():''}.</p></div>`));
}catch(e){res.status(500).send(e.message)}});
// Mobile-safe direct downloads: when download=1 is present, generated school documents are sent as attachments.
app.use("/api/documents",(req,res,next)=>{if(String(req.query.download||"") === "1"){const n=String(req.query.download_name||"greenstar-document.html").replace(/[^a-zA-Z0-9._ -]/g,"_").slice(0,120)||"greenstar-document.html";res.setHeader("Content-Disposition",`attachment; filename="${n}"`);res.setHeader("Cache-Control","no-store");}next()});

// Professional downloadable/printable documents
app.get("/api/documents/students",auth(["admin","secretary","director","principal","worker"]),async(req,res)=>{const rows=(await pool.query(`SELECT admission_no,full_name,class_name,stream,gender,assessment_number,birth_certificate_number,parent_phone FROM students ORDER BY ${classOrderSql("students")},full_name`)).rows;const tr=rows.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.full_name)}</td><td>${esc(x.admission_no)}</td><td>${esc(x.assessment_number||"")}</td><td>${esc(x.birth_certificate_number||"")}</td><td>${esc(x.class_name||"")}</td><td>${esc(x.stream||"")}</td><td>${esc(x.parent_phone||"")}</td></tr>`).join("");res.type("html").send(docPage("STUDENT REGISTER",`<table><tr><th>NO.</th><th>NAME</th><th>ADM NO.</th><th>ASS. NO.</th><th>BIRTH CERT. NO.</th><th>CLASS</th><th>STREAM</th><th>CONTACT</th></tr>${tr||'<tr><td colspan="8">No students registered</td></tr>'}</table>`))});
app.get("/api/documents/class-register",auth(["admin","teacher","secretary","director","principal"]),async(req,res)=>{const className=normalizeClass(req.query.class_name);if(!className)return res.status(400).send("Class is required");if(req.user.role==='teacher'&&!(await isClassTeacher(req.user.id,className)))return res.status(403).send("Only the assigned class teacher can download this class register.");const rows=(await pool.query(`SELECT admission_no,full_name,class_name,stream,assessment_number,birth_certificate_number,parent_name,parent_phone FROM students WHERE LOWER(TRIM(class_name))=LOWER(TRIM($1)) ORDER BY full_name`,[className])).rows;const tr=rows.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.full_name)}</td><td>${esc(x.admission_no)}</td><td>${esc(x.assessment_number||"")}</td><td>${esc(x.birth_certificate_number||"")}</td><td>${esc(x.parent_name||"")}</td><td>${esc(x.parent_phone||"")}</td></tr>`).join("");res.type("html").send(docPage(`${esc(className).toUpperCase()} CLASS REGISTER`, `<p><b>Class:</b> ${esc(className)} &nbsp; <b>Total Learners:</b> ${rows.length}</p><table><tr><th>NO.</th><th>NAME</th><th>ADM NO.</th><th>ASS. NO.</th><th>BIRTH CERT. NO.</th><th>PARENT/GUARDIAN</th><th>PARENT PHONE / LINK ID</th></tr>${tr||'<tr><td colspan="7">No students registered</td></tr>'}</table>`))});
app.get("/api/documents/assets",auth(["secretary","admin","director","principal"]),async(req,res)=>{try{const rows=(await pool.query("SELECT * FROM assets ORDER BY name")).rows;const tr=rows.map(x=>`<tr><td>${esc(x.asset_code)}</td><td>${esc(x.name)}</td><td>${esc(x.category||'')}</td><td>${x.quantity}</td><td>${esc(x.condition||'')}</td><td>${esc(x.location||'')}</td><td>KSh ${Number(x.purchase_value||0).toLocaleString()}</td><td>${esc(x.status||'')}</td></tr>`).join('');res.type('html').send(docPage('SCHOOL ASSETS REGISTER',`<p><b>Total assets:</b> ${rows.length}</p><table><tr><th>CODE</th><th>ASSET</th><th>CATEGORY</th><th>QTY</th><th>CONDITION</th><th>LOCATION</th><th>VALUE</th><th>STATUS</th></tr>${tr||'<tr><td colspan="8">No assets recorded</td></tr>'}</table>`))}catch(e){res.status(500).send(e.message)}});
app.get("/api/documents/fees",auth(["admin","secretary","director","principal"]),async(req,res)=>{try{const period=String(req.query.period||"all").toLowerCase();let chargeWhere="",paymentWhere="",params=[];let label="ALL TIME";if(period==="monthly"){const m=String(req.query.month||"");if(!/^\d{4}-\d{2}$/.test(m))return res.status(400).send("Select a valid month (YYYY-MM).");params=[m];chargeWhere="AND to_char(COALESCE(c.created_at,NOW()),'YYYY-MM')=$1";paymentWhere="AND to_char(p.transaction_date,'YYYY-MM')=$1";label=`MONTHLY FEES — ${m}`;}else if(period==="termly"){const year=Number(req.query.academic_year),term=String(req.query.term||"");if(!year||!term)return res.status(400).send("Select academic year and term.");const ranges={"Term 1":[`${year}-01-01`,`${year}-04-30 23:59:59`],"Term 2":[`${year}-05-01`,`${year}-08-31 23:59:59`],"Term 3":[`${year}-09-01`,`${year}-12-31 23:59:59`]};if(!ranges[term])return res.status(400).send("Term must be Term 1, Term 2 or Term 3.");params=[year,term,ranges[term][0],ranges[term][1]];chargeWhere="AND c.academic_year=$1 AND LOWER(TRIM(c.term))=LOWER(TRIM($2))";paymentWhere="AND p.transaction_date >= $3::timestamp AND p.transaction_date <= $4::timestamp";label=`TERMLY FEES — ${term}, ${year}`;}const q=`SELECT s.admission_no,s.full_name,s.class_name,COALESCE((SELECT SUM(c.amount) FROM fee_charges c WHERE c.student_id=s.id ${chargeWhere}),0) charged,COALESCE((SELECT SUM(p.amount) FROM fee_records p WHERE p.student_id=s.id ${paymentWhere}),0) paid FROM students s ORDER BY ${classOrderSql("s")},s.full_name`;const rows=(await pool.query(q,params)).rows;const tc=rows.reduce((a,x)=>a+Number(x.charged),0),tp=rows.reduce((a,x)=>a+Number(x.paid),0);const tr=rows.map(x=>`<tr><td>${esc(x.admission_no)}</td><td>${esc(x.full_name)}</td><td>${esc(x.class_name)}</td><td>KSh ${Number(x.charged).toLocaleString()}</td><td>KSh ${Number(x.paid).toLocaleString()}</td><td>KSh ${Math.max(0,Number(x.charged)-Number(x.paid)).toLocaleString()}</td></tr>`).join("");res.type("html").send(docPage(`SCHOOL FEES ANALYSIS — ${label}`,`<p><b>Report period:</b> ${esc(label)}</p><div class="summary"><div class="box">Total Charged<br><b>KSh ${tc.toLocaleString()}</b></div><div class="box">Total Paid<br><b>KSh ${tp.toLocaleString()}</b></div><div class="box">Outstanding<br><b>KSh ${Math.max(0,tc-tp).toLocaleString()}</b></div></div><table><tr><th>Admission</th><th>Student</th><th>Class</th><th>Charged</th><th>Paid</th><th>Outstanding</th></tr>${tr||'<tr><td colspan="6">No fee records found for the selected period.</td></tr>'}</table>`));}catch(e){res.status(500).send(e.message)}});
app.get("/api/documents/expenditures",auth(["admin","secretary","director","principal"]),async(req,res)=>{let where="",vals=[];const p=String(req.query.period||"all").toLowerCase();if(p==="daily"&&/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date||""))){vals=[req.query.date];where="WHERE e.expenditure_date::date=$1::date"}else if(p==="monthly"&&/^\d{4}-\d{2}$/.test(String(req.query.month||""))){vals=[req.query.month];where="WHERE to_char(e.expenditure_date,'YYYY-MM')=$1"}else if(p==="termly"){const y=Number(req.query.academic_year),t=String(req.query.term||"");const ranges={"Term 1":[`${y}-01-01`,`${y}-04-30 23:59:59`],"Term 2":[`${y}-05-01`,`${y}-08-31 23:59:59`],"Term 3":[`${y}-09-01`,`${y}-12-31 23:59:59`]};if(y&&ranges[t]){vals=[ranges[t][0],ranges[t][1]];where="WHERE e.expenditure_date >= $1::timestamp AND e.expenditure_date <= $2::timestamp"}}const rows=(await pool.query(`SELECT e.*,u.full_name creator FROM expenditures e LEFT JOIN users u ON u.id=e.created_by ${where} ORDER BY e.expenditure_date DESC,e.id DESC`,vals)).rows;const total=rows.reduce((a,x)=>a+Number(x.amount),0);const tr=rows.map(x=>`<tr><td>${esc(x.expenditure_date)}</td><td>${esc(x.category)}</td><td>${esc(x.description)}</td><td>${esc(x.payment_method)}</td><td>${esc(x.reference)}</td><td>KSh ${Number(x.amount).toLocaleString()}</td></tr>`).join("");res.type("html").send(docPage("SCHOOL EXPENDITURE REPORT",`<div class="box"><b>Total Expenditure: KSh ${total.toLocaleString()}</b></div><table><tr><th>Date</th><th>Category</th><th>Description</th><th>Method</th><th>Reference</th><th>Amount</th></tr>${tr}</table>`))});
app.get("/api/documents/student/:id",auth(["admin","secretary","director","principal","student","parent"]),async(req,res)=>{const s=(await pool.query("SELECT * FROM students WHERE id=$1",[req.params.id])).rows[0];if(!s)return res.status(404).send("Student not found");if(req.user.role==="parent"&&String(s.parent_phone||"")!==String(req.user.phone||"")&&String(s.parent_name||"")!==String(req.user.full_name||""))return res.status(403).send("This learner is not linked to your parent account.");if(req.user.role==="student"&&Number(s.user_id||0)!==Number(req.user.id))return res.status(403).send("This learner is not linked to your student account.");const ch=(await pool.query("SELECT * FROM fee_charges WHERE student_id=$1 ORDER BY id",[s.id])).rows;const pay=(await pool.query("SELECT * FROM fee_records WHERE student_id=$1 ORDER BY transaction_date DESC,id DESC",[s.id])).rows;const charged=ch.reduce((a,x)=>a+Number(x.amount),0),paid=pay.reduce((a,x)=>a+Number(x.amount),0);const tr=pay.map(x=>`<tr><td>${esc(x.transaction_date)}</td><td>${esc(x.receipt_no)}</td><td>${esc(x.description)}</td><td>${esc(x.payment_method)}</td><td>KSh ${Number(x.amount).toLocaleString()}</td></tr>`).join("");res.type("html").send(docPage("STUDENT FEES STATEMENT",`<p><b>Student:</b> ${esc(s.full_name)} &nbsp; <b>Admission:</b> ${esc(s.admission_no)} &nbsp; <b>Assessment No.:</b> ${esc(s.assessment_number||'—')} &nbsp; <b>Birth Cert. No.:</b> ${esc(s.birth_certificate_number||'—')} &nbsp; <b>Class:</b> ${esc(s.class_name)}</p><div class="summary"><div class="box">Charged<br><b>KSh ${charged.toLocaleString()}</b></div><div class="box">Paid<br><b>KSh ${paid.toLocaleString()}</b></div><div class="box">Balance<br><b>KSh ${(charged-paid).toLocaleString()}</b></div></div><table><tr><th>Date</th><th>Receipt</th><th>Description</th><th>Method</th><th>Amount</th></tr>${tr||`<tr><td colspan="5">No payments recorded</td></tr>`}</table>`))});
app.get("/api/documents/term-report/:studentId",auth(["admin","secretary","teacher","director","principal","student","parent"]),async(req,res)=>{
  try{
    const s=(await pool.query("SELECT * FROM students WHERE id=$1",[req.params.studentId])).rows[0];
    if(!s)return res.status(404).send("Student not found");
    if(req.user.role==="parent"&&String(s.parent_phone||"")!==String(req.user.phone||"")&&String(s.parent_name||"")!==String(req.user.full_name||""))return res.status(403).send("This learner is not linked to your parent account.");
    if(req.user.role==='student' && Number(s.user_id||0)!==Number(req.user.id))return res.status(403).send("This report is not linked to your student account.");
    if(req.user.role==='teacher' && !(await isClassTeacher(req.user.id,s.class_name)))return res.status(403).send("Only the assigned class teacher can download this report");
    const year=Number(req.query.academic_year||new Date().getFullYear()),term=String(req.query.term||'').trim();
    if(!year||!term)return res.status(400).send("Academic year and term are required");
    const exams=(await pool.query("SELECT * FROM exams WHERE academic_year=$1 AND LOWER(TRIM(term))=LOWER(TRIM($2)) ORDER BY created_at ASC,id ASC",[year,term])).rows;
    if(!exams.length)return res.status(404).send("No examinations found for the selected term and academic year");
    const ids=exams.map(x=>x.id);
    const marks=(await pool.query(`SELECT m.exam_id,sub.id subject_id,sub.code,sub.name,m.marks,m.grade,m.teacher_comment FROM marks m JOIN subjects sub ON sub.id=m.subject_id WHERE m.student_id=$1 AND m.exam_id=ANY($2::int[]) ORDER BY sub.name,m.exam_id`,[s.id,ids])).rows;
    const byExam=new Map(exams.map(e=>[e.id,{...e,marks:marks.filter(m=>Number(m.exam_id)===Number(e.id))}]));
    const subjects=[...new Map(marks.map(m=>[m.subject_id,{id:m.subject_id,code:m.code,name:m.name}])).values()];
    // Keep the familiar report-form labels where possible, while supporting any number of term assessments.
    const examLabel=(e,i)=>{const n=String(e.name||'').toLowerCase();if(/open/.test(n))return 'OPENER';if(/mid/.test(n))return 'MID';if(/end|final|closing/.test(n))return 'END';return `EXAM ${i+1}`};
    const cols=exams.map(examLabel);
    const cell=(examId,subjectId)=>{const x=byExam.get(examId)?.marks.find(m=>Number(m.subject_id)===Number(subjectId));return x?`${Number(x.marks).toFixed(0)}${x.grade?` <span class="muted">(${esc(x.grade)})</span>`:''}`:'—'};
    const rows=subjects.map(sub=>`<tr><td><b>${esc(sub.name)}</b></td>${exams.map(e=>`<td class="center">${cell(e.id,sub.id)}</td>`).join('')}</tr>`).join('');
    const averages=exams.map((e,i)=>{const a=byExam.get(e.id)?.marks||[];return {label:examLabel(e,i),value:a.length?a.reduce((x,m)=>x+Number(m.marks||0),0)/a.length:0}});
    const overallMarks=marks.length?marks.reduce((a,x)=>a+Number(x.marks||0),0):0,overallAvg=marks.length?overallMarks/marks.length:0;
    const subjectSeries=subjects.map(sub=>{const values={};let total=0,count=0;for(const e of exams){const x=byExam.get(e.id)?.marks.find(m=>Number(m.subject_id)===Number(sub.id));if(x){values[e.id]=Number(x.marks||0);total+=Number(x.marks||0);count++}}return {...sub,values,average:count?total/count:0}});
    const graph=averages.length>1?svgLineChart(averages,760,220):'<p class="muted">Progress graph will appear after more than one assessment is recorded.</p>';
    const subjectGraph=subjectSeries.length?svgGroupedBarChart(subjectSeries,exams,760,260):'<p class="muted">Subject performance graph will appear after marks are recorded.</p>';
    const comments=exams.map((e,i)=>{const cm=(byExam.get(e.id)?.marks||[]).map(m=>m.teacher_comment).filter(Boolean);return cm.length?`<p><b>${esc(cols[i])} teacher notes:</b> ${esc(cm.join(' • '))}</p>`:''}).join('');
    const classTeacher=(await pool.query(`SELECT u.full_name FROM teacher_assignments ta JOIN users u ON u.id=ta.teacher_id WHERE ta.assignment_type='class_teacher' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM($1)) ORDER BY ta.id LIMIT 1`,[s.class_name])).rows[0]?.full_name||'';
    const examHeaders=exams.map((e,i)=>`<th class="center">${esc(cols[i])}<br><span class="muted">${esc(e.name)}</span></th>`).join('');
    const analysis=`<div class="result-slip compact-report"><div class="meta"><div class="item"><b>Name:</b> ${esc(s.full_name)}</div><div class="item"><b>Class:</b> ${esc(s.class_name)}</div><div class="item"><b>Academic Year:</b> ${year}</div><div class="item"><b>Admission No.:</b> ${esc(s.admission_no)}</div><div class="item"><b>Term:</b> ${esc(term)}</div><div class="item"><b>Class Teacher:</b> ${esc(classTeacher||'________________')}</div></div>
      <div class="section compact-report"><div class="section-title">Term assessment report</div><table><tr><th>LEARNING AREAS</th>${examHeaders}</tr>${rows||`<tr><td colspan="${exams.length+1}" class="center">No marks recorded for this term.</td></tr>`}<tr><th>AVERAGE</th>${averages.map(x=>`<td class="center"><b>${x.value.toFixed(1)}%</b><br><span class="muted">${x.value?esc(cbcLevel(x.value)):'—'}</span></td>`).join('')}</tr><tr><th>LEVEL</th>${averages.map(x=>`<td class="center"><b>${x.value?esc(cbcDescriptor(cbcLevel(x.value))):'—'}</b></td>`).join('')}</tr></table><div class="note">EE = Exceeding Expectations (80–100), ME = Meeting Expectations (60–79), AE = Approaching Expectations (40–59), BE = Below Expectations (0–39).</div></div>
      <div class="section compact-report"><div class="section-title">Performance & progress</div><div class="grid2"><div><div class="note"><b>Subject performance by assessment</b></div>${subjectGraph}</div><div><div class="note"><b>Overall progress across assessments</b></div>${graph}</div></div><p class="note"><b>Overall recorded average:</b> ${overallAvg.toFixed(1)}% &nbsp; <b>Assessments:</b> ${exams.length}</p></div>
      <div class="section compact-report"><div class="section-title">Comments</div>${comments||'<p>Class teacher\'s comment: __________________________________________________________________________</p><p>Head teacher\'s remarks: _________________________________________________________________________</p>'}<p>Class teacher\'s comment: __________________________________________________________________________</p><p>Head teacher\'s remarks: __________________________________________________________________________</p><p>Parent/Guardian comment: __________________________________________________________________________</p></div>
      <div class="sign"><span>Class Teacher: ${esc(classTeacher||'________________')}</span><span>School Stamp</span><span>Principal / Director</span></div>`;
    const pdfData={student:s,year,term,classTeacher,exams,examLabels:Object.fromEntries(exams.map((e,i)=>[e.id,cols[i]])),subjects:subjectSeries,averages,overallAvg,comments:comments.replace(/<[^>]+>/g,'').split('\n').map(x=>x.trim()).filter(Boolean)};
    if(String(req.query.download||'')==='html' || String(req.query.download||'')==='1'){const html=docPage(`TERM REPORT — ${String(term).toUpperCase()} ${year}`,analysis);const safe=String(req.query.download_name||`GreenStar-${s.admission_no||s.id}-${term}-${year}-Term-Report.html`).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,120)||'GreenStar-Term-Report.html';res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${safe.endsWith('.html')?safe:safe+'.html'}"`);res.setHeader('Cache-Control','no-store');return res.send(html);}
    res.type("html").send(docPage(`TERM REPORT — ${String(term).toUpperCase()} ${year}`,analysis));
  }catch(e){res.status(500).send(e.message)}
});

app.get("/api/documents/result/:examId/:studentId",auth(["admin","secretary","teacher","director","principal","student","parent"]),async(req,res)=>{
  const s=(await pool.query("SELECT * FROM students WHERE id=$1",[req.params.studentId])).rows[0];
  const e=(await pool.query("SELECT * FROM exams WHERE id=$1",[req.params.examId])).rows[0];
  if(!s||!e)return res.status(404).send("Record not found");
  if(req.user.role==="parent"&&String(s.parent_phone||"")!==String(req.user.phone||"")&&String(s.parent_name||"")!==String(req.user.full_name||""))return res.status(403).send("This learner is not linked to your parent account.");
  if(req.user.role==='student' && Number(s.user_id||0)!==Number(req.user.id))return res.status(403).send("This result is not linked to your student account.");
  if(req.user.role==='teacher' && !(await isClassTeacher(req.user.id,s.class_name)))return res.status(403).send("Only the assigned class teacher can download this result slip");
  const marks=(await pool.query("SELECT sub.id,sub.code,sub.name,m.marks,m.grade,m.teacher_comment FROM marks m JOIN subjects sub ON sub.id=m.subject_id WHERE m.exam_id=$1 AND m.student_id=$2 ORDER BY sub.name",[e.id,s.id])).rows;
  const total=marks.reduce((a,x)=>a+Number(x.marks),0),avg=marks.length?total/marks.length:0;
  const stats=gradeStats(marks), gradeTotal=marks.length;
  const classRows=(await pool.query(`SELECT s.id,COALESCE(SUM(m.marks),0) total,ROUND(COALESCE(AVG(m.marks),0),2) average FROM students s LEFT JOIN marks m ON m.student_id=s.id AND m.exam_id=$1 WHERE LOWER(TRIM(s.class_name))=LOWER(TRIM($2)) GROUP BY s.id ORDER BY average DESC,total DESC,s.full_name`,[e.id,s.class_name])).rows;
  const position=Math.max(1,classRows.findIndex(x=>Number(x.id)===Number(s.id))+1), classAvg=classRows.length?classRows.reduce((a,x)=>a+Number(x.average||0),0)/classRows.length:0;
  const progress=(await pool.query(`SELECT e.id,e.name,e.term,e.academic_year,ROUND(COALESCE(AVG(m.marks),0),2) average FROM exams e LEFT JOIN marks m ON m.exam_id=e.id AND m.student_id=$1 GROUP BY e.id ORDER BY e.academic_year DESC,e.created_at DESC LIMIT 6`,[s.id])).rows.reverse();
  const classTeacher=(await pool.query(`SELECT u.full_name FROM teacher_assignments ta JOIN users u ON u.id=ta.teacher_id WHERE ta.assignment_type='class_teacher' AND LOWER(TRIM(ta.class_name))=LOWER(TRIM($1)) ORDER BY ta.id LIMIT 1`,[s.class_name])).rows[0]?.full_name||'';
  const best=[...marks].sort((a,b)=>Number(b.marks)-Number(a.marks)).slice(0,3),focus=[...marks].sort((a,b)=>Number(a.marks)-Number(b.marks)).slice(0,3);
  const tr=marks.map(x=>`<tr><td>${esc(x.name)}</td><td class="center"><b>${Number(x.marks).toFixed(0)}%</b></td>${CBC_LEVELS.map(g=>`<td class="center ${x.grade===g.code?'rating-'+g.code.toLowerCase():''}">${x.grade===g.code?'●':''}</td>`).join('')}</tr>`).join('');
  const subjectRows=marks.map(x=>({name:x.name,entries:1,average:Number(x.marks),ee:x.grade==='EE'?1:0,me:x.grade==='ME'?1:0,ae:x.grade==='AE'?1:0,be:x.grade==='BE'?1:0}));
  const subjectChart=svgBarChart(marks.map(x=>({label:x.code||x.name.slice(0,8),value:Number(x.marks).toFixed(0)})),760,260);
  const progressChart=svgLineChart(progress.map(x=>({label:`${x.academic_year} ${String(x.term||'').slice(0,6)}`,value:Number(x.average||0)})),760,260);
  const analysis=`<div class="meta"><div class="item"><b>Name:</b> ${esc(s.full_name)}</div><div class="item"><b>Grade:</b> ${esc(s.class_name)}</div><div class="item"><b>Year:</b> ${esc(e.academic_year)}</div><div class="item"><b>Admission No.:</b> ${esc(s.admission_no)}</div><div class="item"><b>Examination:</b> ${esc(e.name)}</div><div class="item"><b>Class Teacher:</b> ${esc(classTeacher||'________________')}</div></div>
    <div class="section"><div class="section-title">Assessment report</div><table><tr><th>LEARNING AREAS</th><th>%</th><th>EE</th><th>ME</th><th>AE</th><th>BE</th></tr>${tr}<tr><th>TOTAL / AVERAGE</th><th class="center">${avg.toFixed(1)}%</th><td colspan="4" class="center"><b>${marks.length?cbcLevel(avg):'—'} — ${marks.length?cbcDescriptor(cbcLevel(avg)):'No marks'}</b></td></tr></table><div class="note">CBC performance levels: EE = Exceeding Expectations (80–100), ME = Meeting Expectations (60–79), AE = Approaching Expectations (40–59), BE = Below Expectations (0–39).</div></div>
    <div class="section"><div class="section-title">Performance snapshot</div><div class="summary"><div class="box"><span class="muted">Total marks</span><br><b>${total.toFixed(0)}</b> / ${marks.length*100}</div><div class="box"><span class="muted">Average</span><br><b>${avg.toFixed(1)}%</b></div><div class="box"><span class="muted">Class position</span><br><b>${position}</b> / ${classRows.length}</div><div class="box"><span class="muted">Vs class mean</span><br><b>${(avg-classAvg>=0?'+':'')}${(avg-classAvg).toFixed(1)}%</b></div></div>${gradeCards(stats,gradeTotal)}</div>
    <div class="section"><div class="section-title">Subject breakdown</div><div class="grid2"><div>${subjectAnalysisTable(subjectRows)}</div><div>${subjectChart}</div></div><p class="note"><b>Strongest:</b> ${best.length?best.map(x=>`${esc(x.name)} (${Number(x.marks).toFixed(0)}%)`).join(', '):'—'}<br><b>Priority for support:</b> ${focus.length?focus.map(x=>`${esc(x.name)} (${Number(x.marks).toFixed(0)}%)`).join(', '):'—'}</p></div>
    <div class="section"><div class="section-title">Progress record</div>${progress.length>1?progressChart:'<p class="muted">Progress graph will appear after more than one assessment is recorded.</p>'}<table><tr><th>Assessment</th><th>Term</th><th>Year</th><th>Average</th></tr>${progress.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.term)}</td><td>${x.academic_year}</td><td class="center"><b>${Number(x.average||0).toFixed(1)}%</b></td></tr>`).join('')}</table></div>
    <div class="section"><div class="section-title">Teacher observations</div><p>Class teacher's comment: __________________________________________________________________________________</p><p>Head teacher's comment: ___________________________________________________________________________________</p><p>Parent/Guardian comment: _________________________________________________________________________________</p></div>
    <div class="sign"><span>Class Teacher: ${esc(classTeacher||'________________')}</span><span>School Stamp</span><span>Principal / Director</span></div></div>`;
  res.type("html").send(docPage(`MID TERM / END TERM ASSESSMENT REPORT — ${String(e.term||'').toUpperCase()}`,analysis));
});

app.get("/api/documents/merit/:examId",auth(["admin","secretary","teacher","director","principal"]),async(req,res)=>{
  const className=normalizeClass(req.query.class_name);if(!className)return res.status(400).send("A class is required for the merit list");
  if(req.user.role==='teacher' && !(await isClassTeacher(req.user.id,className)))return res.status(403).send("Only the assigned class teacher can download this class merit list");
  const exam=(await pool.query("SELECT * FROM exams WHERE id=$1",[req.params.examId])).rows[0];if(!exam)return res.status(404).send("Exam not found");
  const subjects=(await pool.query(`SELECT DISTINCT sub.id,sub.code,sub.name,sub.max_marks FROM marks m JOIN subjects sub ON sub.id=m.subject_id JOIN students s ON s.id=m.student_id WHERE m.exam_id=$1 AND LOWER(TRIM(s.class_name))=LOWER(TRIM($2)) ORDER BY sub.name`,[req.params.examId,className])).rows;
  const students=(await pool.query(`SELECT id,admission_no,full_name,class_name,stream FROM students WHERE LOWER(TRIM(class_name))=LOWER(TRIM($1)) ORDER BY full_name`,[className])).rows;
  const marks=(await pool.query(`SELECT m.student_id,m.subject_id,m.marks,m.grade FROM marks m JOIN students s ON s.id=m.student_id WHERE m.exam_id=$1 AND LOWER(TRIM(s.class_name))=LOWER(TRIM($2))`,[req.params.examId,className])).rows;
  const by=new Map();for(const m of marks){if(!by.has(m.student_id))by.set(m.student_id,new Map());by.get(m.student_id).set(m.subject_id,m)}
  const ranked=students.map(st=>{const sm=by.get(st.id)||new Map();const total=subjects.reduce((a,sub)=>a+Number(sm.get(sub.id)?.marks||0),0);const average=subjects.length?total/subjects.length:0;return {...st,total,average,subjects:sm}}).sort((a,b)=>b.average-a.average||b.total-a.total||a.full_name.localeCompare(b.full_name));
  const posMap=new Map();ranked.forEach((x,i)=>posMap.set(x.id,i+1));
  const totalOut=subjects.reduce((a,x)=>a+Number(x.max_marks||100),0);
  const header=`<div class="meta"><div class="item"><b>Class:</b> ${esc(className)}</div><div class="item"><b>Assessment:</b> ${esc(exam.name)}</div><div class="item"><b>Term:</b> ${esc(exam.term)} ${esc(exam.academic_year)}</div></div>`;
  const outRow=`<tr><th>OUT OF</th>${subjects.map(x=>`<th class="center">${Number(x.max_marks||100)}</th>`).join('')}<th>${totalOut}</th><th>—</th></tr>`;
  const studentRows=ranked.map(x=>`<tr><td>${esc(x.full_name)}</td>${subjects.map(sub=>`<td class="center">${x.subjects.get(sub.id)?Number(x.subjects.get(sub.id).marks).toFixed(0):'—'}</td>`).join('')}<td class="center"><b>${x.total.toFixed(0)}</b></td><td class="center"><b>${posMap.get(x.id)}</b></td></tr>`).join('');
  const totalRow=`<tr><th>TOTAL</th>${subjects.map(sub=>{const v=ranked.reduce((a,x)=>a+Number(x.subjects.get(sub.id)?.marks||0),0);return `<th class="center">${v.toFixed(0)}</th>`}).join('')}<th class="center">${ranked.reduce((a,x)=>a+x.total,0).toFixed(0)}</th><th></th></tr>`;
  const meanRow=`<tr><th>MEAN</th>${subjects.map(sub=>{const vals=ranked.map(x=>Number(x.subjects.get(sub.id)?.marks||0));const v=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;return `<th class="center">${v.toFixed(1)}</th>`}).join('')}<th class="center">${ranked.length?(ranked.reduce((a,x)=>a+x.average,0)/ranked.length).toFixed(1):'0.0'}</th><th></th></tr>`;
  // Subject position is based on each subject's class mean (highest mean = 1st), not on the top individual learner.
  const subjectPositions=[...subjects].map(sub=>{
    const vals=ranked.map(x=>Number(x.subjects.get(sub.id)?.marks||0));
    const mean=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;
    return {id:Number(sub.id),mean};
  }).sort((a,b)=>b.mean-a.mean||a.id-b.id);
  const subjectPosMap=new Map(); let subjectLastMean=null,subjectLastPos=0;
  subjectPositions.forEach((x,i)=>{if(subjectLastMean===null||Math.abs(x.mean-subjectLastMean)>1e-9){subjectLastPos=i+1;subjectLastMean=x.mean}subjectPosMap.set(x.id,subjectLastPos)});
  const positionRow=`<tr><th>POSITION</th>${subjects.map(sub=>{const vals=ranked.map(x=>Number(x.subjects.get(sub.id)?.marks||0));const mean=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;const pos=subjectPosMap.get(Number(sub.id))||'—';return `<td class="center"><b>${pos}${pos===1?'st':pos===2?'nd':pos===3?'rd':'th'}</b><br><small>Mean ${mean.toFixed(1)}</small></td>`}).join('')}<td></td><td></td></tr>`;
  const classGradeRows=gradeStats(marks), gradeTotal=marks.length;
  const subjectSummary=subjects.map(sub=>{const vals=marks.filter(x=>Number(x.subject_id)===Number(sub.id));const average=vals.length?vals.reduce((a,x)=>a+Number(x.marks),0)/vals.length:0;return {name:sub.name,entries:vals.length,average,ee:vals.filter(x=>x.grade==='EE').length,me:vals.filter(x=>x.grade==='ME').length,ae:vals.filter(x=>x.grade==='AE').length,be:vals.filter(x=>x.grade==='BE').length}});
  const progress=(await pool.query(`SELECT e.id,e.name,e.term,e.academic_year,ROUND(COALESCE(AVG(m.marks),0),2) average FROM exams e LEFT JOIN marks m ON m.exam_id=e.id JOIN students s ON s.id=m.student_id WHERE LOWER(TRIM(s.class_name))=LOWER(TRIM($1)) GROUP BY e.id ORDER BY e.academic_year DESC,e.created_at DESC LIMIT 6`,[className])).rows.reverse();
  const classProgress=svgLineChart(progress.map(x=>({label:`${x.academic_year} ${String(x.term||'').slice(0,6)}`,value:Number(x.average||0)})),760,250);
  const subjectChart=svgBarChart(subjectSummary.map(x=>({label:x.name.length>11?x.name.slice(0,11)+'…':x.name,value:Number(x.average).toFixed(1)})),760,260);
  const content=`${header}<div class="section"><div class="section-title">Class assessment mark list</div><table><tr><th>STUDENT NAME</th>${subjects.map(x=>`<th class="center" title="${esc(x.name)}">${esc(learningAreaShortName(x.name))}</th>`).join('')}<th>TOTAL</th><th>POS</th></tr>${outRow}${studentRows}${totalRow}${meanRow}${positionRow}</table><div class="note">Positions are calculated within ${esc(className)} for this assessment. Subject position notes identify the highest recorded mark in each learning area.</div></div>
  <div class="section"><div class="section-title">Grade breakdown</div>${gradeCards(classGradeRows,gradeTotal)}${svgBarChart(CBC_LEVELS.map(x=>({label:x.code,value:classGradeRows[x.code]||0})),760,230)}</div>
  <div class="section"><div class="section-title">Subject breakdown</div><div class="grid2"><div>${subjectAnalysisTable(subjectSummary)}</div><div>${subjectChart}</div></div></div>
  <div class="section"><div class="section-title">Class progress record</div>${progress.length>1?classProgress:'<p class="muted">Progress graph will appear after more assessments are recorded.</p>'}<table><tr><th>Assessment</th><th>Term</th><th>Year</th><th>Class Mean</th></tr>${progress.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.term)}</td><td>${x.academic_year}</td><td class="center"><b>${Number(x.average||0).toFixed(1)}%</b></td></tr>`).join('')}</table></div>
  <div class="sign"><span>Compiled by: __________________</span><span>Class Teacher: __________________</span><span>Date: __________________</span></div>`;
  res.type("html").send(docPage(`GRADE ${String(className).replace(/^grade\s*/i,'').toUpperCase()} — ${String(exam.name).toUpperCase()} MARK LIST ${exam.academic_year}`,content));
});

// Audit log for Admin management
app.get("/api/audit",adminOnly,async(req,res)=>res.json((await pool.query("SELECT a.*,u.full_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 500")).rows));


// Secretary fees records: view, search and print/download the official fees report.
app.get("/api/secretary/fees-records", auth(["secretary","admin"]), async (req,res)=>{
  try {
    const r=await pool.query(`SELECT fr.id,fr.transaction_date,fr.receipt_no,fr.description,fr.amount,
      fr.payment_method,fr.reference,s.admission_no,s.full_name,s.class_name,s.stream
      FROM fee_records fr JOIN students s ON s.id=fr.student_id
      ORDER BY fr.transaction_date DESC,fr.id DESC`);
    res.json(r.rows);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/secretary/fees-summary", auth(["secretary","admin"]), async (req,res)=>{
  try {
    const r=await pool.query(`SELECT s.admission_no,s.full_name,s.class_name,s.stream,
      COALESCE((SELECT SUM(amount) FROM fee_charges c WHERE c.student_id=s.id),0) charged,
      COALESCE((SELECT SUM(amount) FROM fee_records p WHERE p.student_id=s.id),0) paid
      FROM students s ORDER BY s.class_name,s.full_name`);
    res.json(r.rows.map(x=>({...x,charged:Number(x.charged),paid:Number(x.paid),balance:Number(x.charged)-Number(x.paid)})));
  } catch(e){res.status(500).json({error:e.message});}
});

app.get("/api/secretary/fees-document", auth(["secretary","admin"]), async (req,res)=>{
  try {
    const r=await pool.query(`SELECT fr.transaction_date,fr.receipt_no,fr.description,fr.amount,
      fr.payment_method,fr.reference,s.admission_no,s.full_name,s.class_name,s.stream
      FROM fee_records fr JOIN students s ON s.id=fr.student_id
      ORDER BY fr.transaction_date DESC,fr.id DESC`);
    const total=r.rows.reduce((a,x)=>a+Number(x.amount||0),0);
    const school=currentSchoolName();
    const address=currentSchoolAddress();
    const logo=SCHOOL_LOGO_DATA_URI||currentSchoolLogo();
    const rows=r.rows.map(x=>`<tr><td>${x.transaction_date?new Date(x.transaction_date).toLocaleDateString():""}</td><td>${x.receipt_no||""}</td><td>${x.admission_no||""}</td><td>${x.full_name||""}</td><td>${x.class_name||""}</td><td>${x.description||""}</td><td>KSh ${Number(x.amount||0).toLocaleString()}</td><td>${x.payment_method||""}</td><td>${x.reference||""}</td></tr>`).join("");
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Fees Payment Records</title><style>body{font-family:Arial;margin:30px;color:#172033}.header{text-align:center;border-bottom:3px solid #0b63ce;padding-bottom:15px}.logo{max-height:80px;max-width:120px}h1{color:#0b63ce;margin:6px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #cbd5e1;padding:6px}th{background:#0b63ce;color:white}.total{text-align:right;font-weight:bold;font-size:16px;margin-top:15px}.footer{margin-top:35px;display:flex;justify-content:space-between}@media print{button{display:none}}</style></head><body><div class="header">${logo?`<img class="logo" src="${logo}">`:""}<h1>${school}</h1><div>${address}</div><h2>FEES PAYMENT RECORDS</h2><div>Official Secretary's Financial Record</div></div><p>Generated: ${new Date().toLocaleString()} &nbsp; | &nbsp; Transactions: ${r.rows.length}</p><table><thead><tr><th>Date</th><th>Receipt</th><th>Admission</th><th>Student</th><th>Class</th><th>Description</th><th>Amount</th><th>Method</th><th>Reference</th></tr></thead><tbody>${rows}</tbody></table><div class="total">Total Fees Received: KSh ${total.toLocaleString()}</div><div class="footer"><span>Prepared by: Secretary</span><span>Signature: __________________</span></div><script>window.onload=()=>setTimeout(()=>window.print(),500)</script></body></html>`);
  } catch(e){res.status(500).json({error:e.message});}
});



// Professional payroll: available to administration, management and the secretary.
const PAYROLL_VIEW_ROLES=["admin","director","principal","secretary","teacher","worker","ustadh","patron"];
const PAYROLL_MANAGE_ROLES=["principal","secretary"];
const PAYROLL_APPROVE_ROLES=["director"];
app.get("/api/payroll/my",auth(["admin","director","principal","secretary","teacher","worker","ustadh"]),async(req,res)=>{try{const staffView=['teacher','worker','ustadh'].includes(req.user.role);const sql=`SELECT pe.id,pe.period_id,pe.basic_salary,pe.house_allowance,pe.transport_allowance,pe.other_allowance,pe.gross_pay,pe.tax_deduction,pe.pension_deduction,pe.other_deduction,pe.total_deductions,pe.net_pay,pe.status,pe.notes,pp.payroll_year,pp.payroll_month,pp.status period_status,pp.paid_at FROM payroll_entries pe JOIN payroll_periods pp ON pp.id=pe.period_id WHERE pe.staff_id=$1 ${staffView?"AND pp.status IN ('approved','paid')":""} ORDER BY pp.payroll_year DESC,pp.payroll_month DESC`,constVals=[req.user.id];const r=await pool.query(sql,constVals);res.json({staff:req.user,entries:r.rows})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/payroll/staff",auth(PAYROLL_VIEW_ROLES),async(req,res)=>{try{
 const r=await pool.query(`SELECT u.id,u.full_name,u.username,u.role,u.staff_category,u.phone,u.email,u.active,
 COALESCE(pp.basic_salary,0) basic_salary,COALESCE(pp.house_allowance,0) house_allowance,COALESCE(pp.transport_allowance,0) transport_allowance,
 COALESCE(pp.other_allowance,0) other_allowance,COALESCE(pp.tax_deduction,0) tax_deduction,COALESCE(pp.pension_deduction,0) pension_deduction,
 COALESCE(pp.other_deduction,0) other_deduction,COALESCE(pp.bank_name,'') bank_name,COALESCE(pp.account_number,'') account_number
 FROM users u LEFT JOIN payroll_profiles pp ON pp.staff_id=u.id
 WHERE u.role IN ('teacher','ustadh','patron','worker','secretary','admin','director','principal') ORDER BY u.active DESC,u.full_name`);res.json(r.rows)
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/payroll/staff",auth(PAYROLL_MANAGE_ROLES),async(req,res)=>{try{
 const staffId=Number(req.body.staff_id);if(!staffId)return res.status(400).json({error:"Staff member is required"});
 const check=await pool.query("SELECT id FROM users WHERE id=$1 AND role IN ('teacher','ustadh','worker','secretary','admin','director','principal')",[staffId]);if(!check.rows[0])return res.status(404).json({error:"Staff member not found"});
 const nums=['basic_salary','house_allowance','transport_allowance','other_allowance','tax_deduction','pension_deduction','other_deduction'].map(k=>Number(req.body[k]||0));
 if(nums.some(n=>!Number.isFinite(n)||n<0))return res.status(400).json({error:"Salary and deduction values must be zero or positive numbers"});
 const vals=[staffId,...nums,String(req.body.bank_name||'').trim()||null,String(req.body.account_number||'').trim()||null];
 const r=await pool.query(`INSERT INTO payroll_profiles(staff_id,basic_salary,house_allowance,transport_allowance,other_allowance,tax_deduction,pension_deduction,other_deduction,bank_name,account_number)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(staff_id) DO UPDATE SET basic_salary=EXCLUDED.basic_salary,house_allowance=EXCLUDED.house_allowance,transport_allowance=EXCLUDED.transport_allowance,other_allowance=EXCLUDED.other_allowance,tax_deduction=EXCLUDED.tax_deduction,pension_deduction=EXCLUDED.pension_deduction,other_deduction=EXCLUDED.other_deduction,bank_name=EXCLUDED.bank_name,account_number=EXCLUDED.account_number,updated_at=NOW() RETURNING *`,vals);
 await audit(req.user.id,'UPDATE_PAYROLL_PROFILE',`staff=${staffId}`);res.json(r.rows[0])
}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/payroll/periods",auth(PAYROLL_VIEW_ROLES),async(req,res)=>{try{res.json((await pool.query("SELECT * FROM payroll_periods ORDER BY payroll_year DESC,payroll_month DESC")).rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/payroll/run",auth(PAYROLL_MANAGE_ROLES),async(req,res)=>{try{
 const year=Number(req.body.year),month=Number(req.body.month);if(!year||month<1||month>12)return res.status(400).json({error:"Valid payroll year and month are required"});
 const period=(await pool.query("INSERT INTO payroll_periods(payroll_year,payroll_month,status,processed_by) VALUES($1,$2,'draft',$3) ON CONFLICT(payroll_year,payroll_month) DO UPDATE SET updated_at=NOW() RETURNING *",[year,month,req.user.id])).rows[0];
 if(period.status==='paid'||period.status==='approved')return res.status(400).json({error:`Payroll for ${year}-${String(month).padStart(2,'0')} is already ${period.status}. Create the next payroll period or cancel it before regenerating.`});
 const staff=(await pool.query("SELECT u.id,COALESCE(pp.basic_salary,0) basic_salary,COALESCE(pp.house_allowance,0) house_allowance,COALESCE(pp.transport_allowance,0) transport_allowance,COALESCE(pp.other_allowance,0) other_allowance,COALESCE(pp.tax_deduction,0) tax_deduction,COALESCE(pp.pension_deduction,0) pension_deduction,COALESCE(pp.other_deduction,0) other_deduction FROM users u LEFT JOIN payroll_profiles pp ON pp.staff_id=u.id WHERE u.active=true AND u.role IN ('teacher','ustadh','patron','worker','secretary','admin','director','principal') ORDER BY u.full_name")).rows;
 for(const x of staff){const gross=Number(x.basic_salary)+Number(x.house_allowance)+Number(x.transport_allowance)+Number(x.other_allowance),ded=Number(x.tax_deduction)+Number(x.pension_deduction)+Number(x.other_deduction);await pool.query(`INSERT INTO payroll_entries(period_id,staff_id,basic_salary,house_allowance,transport_allowance,other_allowance,tax_deduction,pension_deduction,other_deduction,gross_pay,total_deductions,net_pay,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft') ON CONFLICT(period_id,staff_id) DO UPDATE SET basic_salary=EXCLUDED.basic_salary,house_allowance=EXCLUDED.house_allowance,transport_allowance=EXCLUDED.transport_allowance,other_allowance=EXCLUDED.other_allowance,tax_deduction=EXCLUDED.tax_deduction,pension_deduction=EXCLUDED.pension_deduction,other_deduction=EXCLUDED.other_deduction,gross_pay=EXCLUDED.gross_pay,total_deductions=EXCLUDED.total_deductions,net_pay=EXCLUDED.net_pay,updated_at=NOW()`,[period.id,x.id,x.basic_salary,x.house_allowance,x.transport_allowance,x.other_allowance,x.tax_deduction,x.pension_deduction,x.other_deduction,gross,ded,gross-ded])}
 await audit(req.user.id,'GENERATE_PAYROLL',`${year}-${String(month).padStart(2,'0')}, staff=${staff.length}`);res.json({period,staff_count:staff.length})
}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/payroll/periods/:id",auth(PAYROLL_VIEW_ROLES),async(req,res)=>{try{const period=(await pool.query("SELECT * FROM payroll_periods WHERE id=$1",[req.params.id])).rows[0];if(!period)return res.status(404).json({error:"Payroll period not found"});const entries=(await pool.query(`SELECT pe.*,u.full_name,u.role,u.staff_category,u.phone FROM payroll_entries pe JOIN users u ON u.id=pe.staff_id WHERE pe.period_id=$1 ORDER BY u.full_name`,[req.params.id])).rows;res.json({period,entries})}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/payroll/entries/:id",auth(PAYROLL_MANAGE_ROLES),async(req,res)=>{try{const id=Number(req.params.id);const old=(await pool.query("SELECT * FROM payroll_entries WHERE id=$1",[id])).rows[0];if(!old)return res.status(404).json({error:"Payroll entry not found"});if(old.status==='paid')return res.status(400).json({error:"Paid payroll entries cannot be edited"});const fields=['basic_salary','house_allowance','transport_allowance','other_allowance','tax_deduction','pension_deduction','other_deduction'];const v=fields.map(k=>req.body[k]===undefined?Number(old[k]||0):Number(req.body[k]||0));if(v.some(n=>!Number.isFinite(n)||n<0))return res.status(400).json({error:"Payroll values must be zero or positive numbers"});const gross=v[0]+v[1]+v[2]+v[3],ded=v[4]+v[5]+v[6];const r=await pool.query(`UPDATE payroll_entries SET basic_salary=$1,house_allowance=$2,transport_allowance=$3,other_allowance=$4,tax_deduction=$5,pension_deduction=$6,other_deduction=$7,gross_pay=$8,total_deductions=$9,net_pay=$10,notes=$11,updated_at=NOW() WHERE id=$12 RETURNING *`,[...v,gross,ded,gross-ded,req.body.notes||null,id]);await audit(req.user.id,'UPDATE_PAYROLL_ENTRY',`entry=${id}`);res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/payroll/periods/:id/status",auth(PAYROLL_VIEW_ROLES),async(req,res)=>{try{const status=String(req.body.status||'draft').toLowerCase();if(!['draft','submitted','approved','rejected','paid','cancelled'].includes(status))return res.status(400).json({error:'Invalid payroll status'});if(['approved','rejected','paid'].includes(status)&&req.user.role!=='director')return res.status(403).json({error:'Only the Director can approve, reject or mark payroll as paid.'});if(status==='submitted'&&!['secretary','principal'].includes(req.user.role))return res.status(403).json({error:'Only the Secretary or Principal can submit payroll for Director approval.'});if(['draft','cancelled'].includes(status)&&!['secretary','principal'].includes(req.user.role))return res.status(403).json({error:'Only the Secretary or Principal can return payroll to draft/cancelled.'});const r=await pool.query("UPDATE payroll_periods SET status=$1,approved_by=CASE WHEN $1='approved' THEN $2 ELSE approved_by END,approved_at=CASE WHEN $1='approved' THEN NOW() ELSE approved_at END,paid_at=CASE WHEN $1='paid' THEN NOW() ELSE paid_at END,director_note=CASE WHEN $1='rejected' THEN $4 ELSE director_note END,updated_at=NOW() WHERE id=$3 RETURNING *",[status,req.user.id,req.params.id,req.body.director_note||null]);if(!r.rows[0])return res.status(404).json({error:'Payroll period not found'});if(['approved','paid','rejected'].includes(status))await pool.query("UPDATE payroll_entries SET status=$1,updated_at=NOW() WHERE period_id=$2",[status,req.params.id]);if(['draft','submitted','cancelled'].includes(status))await pool.query("UPDATE payroll_entries SET status=$1,updated_at=NOW() WHERE period_id=$2",[status,req.params.id]);await audit(req.user.id,'PAYROLL_STATUS',`period=${req.params.id},status=${status}`);if(status==='submitted'){await notifyApprovalRoles({title:'Payroll approval required',type:'payroll-request',message:`Payroll for ${r.rows[0].payroll_year}-${String(r.rows[0].payroll_month).padStart(2,'0')} was submitted by ${req.user.full_name} and is awaiting Director approval.`,sourceId:r.rows[0].id,actionUrl:'/payroll.html'});await notifyApprovalRolesWhatsApp({eventType:'payroll',sourceId:r.rows[0].id,message:`Green Star payroll approval required: ${r.rows[0].payroll_year}-${String(r.rows[0].payroll_month).padStart(2,'0')} was submitted by ${req.user.full_name}. Please review and approve/reject.`});}if(['approved','rejected'].includes(status)&&r.rows[0].processed_by&&Number(r.rows[0].processed_by)!==Number(req.user.id)){await notifyUser(r.rows[0].processed_by,{title:`Payroll ${status}`,type:'payroll-decision',message:`Payroll for ${r.rows[0].payroll_year}-${String(r.rows[0].payroll_month).padStart(2,'0')} was ${status} by ${req.user.full_name}.${req.body.director_note?' Note: '+req.body.director_note:''}`,sourceId:r.rows[0].id,actionUrl:'/payroll.html'});await notifyUserWhatsApp(r.rows[0].processed_by,{eventType:'payroll',sourceId:r.rows[0].id,message:`Green Star: Payroll for ${r.rows[0].payroll_year}-${String(r.rows[0].payroll_month).padStart(2,'0')} was ${status} by ${req.user.full_name}.${req.body.director_note?' Note: '+req.body.director_note:''}`});}if(status==='approved'||status==='paid'){const staff=(await pool.query(`SELECT u.id,u.full_name,u.phone,pe.net_pay FROM payroll_entries pe JOIN users u ON u.id=pe.staff_id WHERE pe.period_id=$1 AND u.active=true AND u.phone IS NOT NULL AND TRIM(u.phone)<>''`,[r.rows[0].id])).rows;for(const st of staff){await queueWhatsAppNotification(`payroll:${r.rows[0].id}:staff:${st.id}:${status}`,'payroll',null,st.full_name,st.phone,`Green Star: Your payroll for ${r.rows[0].payroll_year}-${String(r.rows[0].payroll_month).padStart(2,'0')} has been ${status}.${status==='paid'?` Net pay: KSh ${Number(st.net_pay||0).toLocaleString()}. Payment has been recorded.`:''}`,r.rows[0].id);}}res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/my/payroll",staffAuth(['teacher','ustadh','patron','worker','secretary','admin','director','principal']),async(req,res)=>{try{
 const rows=(await pool.query(`SELECT pe.*,pr.payroll_year,pr.payroll_month,pr.status period_status FROM payroll_entries pe JOIN payroll_periods pr ON pr.id=pe.period_id WHERE pe.staff_id=$1 ORDER BY pr.payroll_year DESC,pr.payroll_month DESC LIMIT 24`,[req.user.id])).rows;
 res.json(rows);
}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/documents/payroll/:periodId",auth(PAYROLL_VIEW_ROLES),async(req,res)=>{try{const p=(await pool.query("SELECT pp.*,u.full_name processed_by_name FROM payroll_periods pp LEFT JOIN users u ON u.id=pp.processed_by WHERE pp.id=$1",[req.params.periodId])).rows[0];if(!p)return res.status(404).send('Payroll period not found');const rows=(await pool.query(`SELECT pe.*,u.full_name,u.role,u.staff_category FROM payroll_entries pe JOIN users u ON u.id=pe.staff_id WHERE pe.period_id=$1 ORDER BY u.full_name`,[req.params.periodId])).rows;const totalGross=rows.reduce((a,x)=>a+Number(x.gross_pay),0),totalDed=rows.reduce((a,x)=>a+Number(x.total_deductions),0),totalNet=rows.reduce((a,x)=>a+Number(x.net_pay),0);const tr=rows.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.full_name)}</td><td>${esc(x.role)}</td><td>${esc(x.staff_category||'')}</td><td>KSh ${Number(x.gross_pay).toLocaleString()}</td><td>KSh ${Number(x.total_deductions).toLocaleString()}</td><td>KSh ${Number(x.net_pay).toLocaleString()}</td><td>${esc(x.status)}</td></tr>`).join('');res.type('html').send(docPage(`STAFF PAYROLL — ${p.payroll_year}-${String(p.payroll_month).padStart(2,'0')}`,`<p><b>Payroll status:</b> ${esc(p.status)} &nbsp; <b>Staff:</b> ${rows.length}</p><div class="summary"><div class="box">Gross Pay<br><b>KSh ${totalGross.toLocaleString()}</b></div><div class="box">Deductions<br><b>KSh ${totalDed.toLocaleString()}</b></div><div class="box">Net Payroll<br><b>KSh ${totalNet.toLocaleString()}</b></div></div><table><tr><th>NO.</th><th>STAFF</th><th>ROLE</th><th>WORK CATEGORY</th><th>GROSS</th><th>DEDUCTIONS</th><th>NET</th><th>STATUS</th></tr>${tr||'<tr><td colspan="8">No payroll entries</td></tr>'}</table>`))}catch(e){res.status(500).send(e.message)}});
app.get("/api/documents/payslip/:entryId",auth(PAYROLL_VIEW_ROLES),async(req,res)=>{try{const x=(await pool.query(`SELECT pe.*,u.full_name,u.role,u.staff_category,u.phone,u.email,pp.bank_name,pp.account_number,pr.payroll_year,pr.payroll_month FROM payroll_entries pe JOIN users u ON u.id=pe.staff_id LEFT JOIN payroll_profiles pp ON pp.staff_id=u.id JOIN payroll_periods pr ON pr.id=pe.period_id WHERE pe.id=$1`,[req.params.entryId])).rows[0];if(!x)return res.status(404).send('Payslip not found');if(['teacher','worker','ustadh','patron'].includes(req.user.role)&&Number(x.staff_id)===Number(req.user.id)&&!['approved','paid'].includes(String(x.status)))return res.status(403).send('This payslip has not yet been published by the Director.');if(!['admin','director','principal','secretary'].includes(req.user.role)&&Number(x.staff_id)!==Number(req.user.id))return res.status(403).send('You may only view your own payslip.');const payslipHtml=docPage('STAFF PAYSLIP',`<div class="meta"><div class="item"><b>Staff:</b> ${esc(x.full_name)}</div><div class="item"><b>Role:</b> ${esc(x.role)}</div><div class="item"><b>Payroll Month:</b> ${x.payroll_year}-${String(x.payroll_month).padStart(2,'0')}</div><div class="item"><b>Work Category:</b> ${esc(x.staff_category||'')}</div><div class="item"><b>Phone:</b> ${esc(x.phone||'')}</div><div class="item"><b>Bank:</b> ${esc(x.bank_name||'')} ${x.account_number?'• '+esc(x.account_number):''}</div></div><table><tr><th>EARNINGS</th><th>AMOUNT</th></tr><tr><td>Basic Salary</td><td>KSh ${Number(x.basic_salary).toLocaleString()}</td></tr><tr><td>House Allowance</td><td>KSh ${Number(x.house_allowance).toLocaleString()}</td></tr><tr><td>Transport Allowance</td><td>KSh ${Number(x.transport_allowance).toLocaleString()}</td></tr><tr><td>Other Allowance</td><td>KSh ${Number(x.other_allowance).toLocaleString()}</td></tr><tr><th>Gross Pay</th><th>KSh ${Number(x.gross_pay).toLocaleString()}</th></tr></table><table><tr><th>DEDUCTIONS</th><th>AMOUNT</th></tr><tr><td>Tax / PAYE</td><td>KSh ${Number(x.tax_deduction).toLocaleString()}</td></tr><tr><td>Pension / NSSF</td><td>KSh ${Number(x.pension_deduction).toLocaleString()}</td></tr><tr><td>Other Deductions</td><td>KSh ${Number(x.other_deduction).toLocaleString()}</td></tr><tr><th>Total Deductions</th><th>KSh ${Number(x.total_deductions).toLocaleString()}</th></tr><tr><th>NET PAY</th><th>KSh ${Number(x.net_pay).toLocaleString()}</th></tr></table>`);if(String(req.query.download||'')==='1'){const safe=String(req.query.download_name||`payslip-${x.payroll_year}-${String(x.payroll_month).padStart(2,'0')}.html`).replace(/[^a-zA-Z0-9._-]/g,'_');res.setHeader('Content-Disposition',`attachment; filename="${safe}"`);res.type('html').send(payslipHtml)}else{res.type('html').send(payslipHtml)}}catch(e){res.status(500).send(e.message)}});

// Production readiness and safety controls.
app.get("/api/system/status",adminOnly,async(req,res)=>{try{
 const mode=(await pool.query("SELECT value FROM system_settings WHERE setting_key='operation_mode'")).rows[0]?.value||'demo';
 const counts={};
 for(const [k,t] of Object.entries({users:'users',students:'students',exams:'exams',marks:'marks',fees:'fee_records',charges:'fee_charges',attendance:'staff_attendance',payroll:'payroll_entries',communications:'communications',tafhid:'tafhid_assessments'})){const r=await pool.query(`SELECT COUNT(*)::int n FROM ${t}`);counts[k]=r.rows[0].n}
 res.json({version:APP_VERSION,mode,counts,payment_number:currentSchoolPaymentNumber(),subscription_till:SUBSCRIPTION_TILL_NUMBER,developer_number:DEVELOPER_NUMBER,developer_email:DEVELOPER_EMAIL,developer_website:DEVELOPER_WEBSITE});
}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/system/mode",adminOnly,async(req,res)=>{try{const mode=String(req.body.mode||'').toLowerCase();if(!['demo','production'].includes(mode))return res.status(400).json({error:'Mode must be demo or production'});await pool.query("INSERT INTO system_settings(setting_key,value) VALUES('operation_mode',$1) ON CONFLICT(setting_key) DO UPDATE SET value=EXCLUDED.value",[mode]);await audit(req.user.id,'SYSTEM_MODE',mode);res.json({mode,message:mode==='production'?'Production lock enabled. Test-data deletion is disabled.':'Demo/Test mode enabled. Test-data cleanup is available to Admin.'})}catch(e){res.status(400).json({error:e.message})}});

// Admin-only test-data cleanup. Accounts are deliberately preserved.
app.post("/api/system/clear-test-data",adminOnly,async(req,res)=>{const client=await pool.connect();try{const mode=(await client.query("SELECT value FROM system_settings WHERE setting_key='operation_mode'")).rows[0]?.value||'demo';if(mode==='production')return res.status(403).json({error:'Test-data cleanup is disabled in Production Mode. Switch the system to Demo/Test Mode first.'});if(String(req.body.confirmation||'')!=='DELETE TEST DATA')return res.status(400).json({error:'Type DELETE TEST DATA exactly to confirm'});const requested=Array.isArray(req.body.tables)?req.body.tables:[];const allowed={students:'students',marks:'marks',fees:'fee_records',charges:'fee_charges',exams:'exams',attendance:'staff_attendance',expenditures:'expenditures',leave:'leave_requests',exam_bank:'exam_bank',exam_resources:'exam_resources',purchases:'resource_purchases',announcements:'announcements',assets:'assets',payroll:'payroll_entries,payroll_periods,payroll_profiles',reports:'student_subject_report_strands,student_subject_reports',assignments:'teacher_assignments',tafhid:'tafhid_assessments,tafhid_group_learners,tafhid_groups'};const chosen=requested.filter(x=>allowed[x]);if(!chosen.length)return res.status(400).json({error:'Select at least one data category'});const order=['purchases','exam_resources','marks','reports','tafhid','assignments','charges','fees','attendance','expenditures','leave','exam_bank','announcements','assets','payroll','exams','students'];const done=[];await client.query('BEGIN');for(const key of order){if(!chosen.includes(key))continue;const tables=allowed[key].split(',');await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);done.push(...tables)}await client.query('COMMIT');await audit(req.user.id,'CLEAR_TEST_DATA',done.join(','));res.json({message:'Selected test data removed. User accounts were preserved.',cleared:done})}catch(e){try{await client.query('ROLLBACK')}catch{}res.status(400).json({error:e.message})}finally{client.release()}});

// Staff management: leave requests, staff directory, daily attendance and expenditure approvals.
app.get("/api/staff/directory",auth(["director","admin"]),async(req,res)=>{try{
 const r=await pool.query(`SELECT id,username,full_name,role,staff_category,phone,email,active,created_at,
 CASE role WHEN 'teacher' THEN 'Teachers' WHEN 'ustadh' THEN 'Ustadh' WHEN 'patron' THEN 'Patron / Boarding Master' WHEN 'worker' THEN COALESCE(NULLIF(staff_category,''),'Support Staff') WHEN 'secretary' THEN 'Secretaries' WHEN 'admin' THEN 'Administration' WHEN 'director' THEN 'Directors' WHEN 'principal' THEN 'Principals' ELSE 'Other' END category
 FROM users WHERE role IN ('teacher','ustadh','patron','worker','secretary','admin','director','principal') ORDER BY category,full_name`);res.json(r.rows)
}catch(e){res.status(500).json({error:e.message})}});
app.patch("/api/staff/directory/:id",auth(["director","admin"]),async(req,res)=>{try{const r=await pool.query("UPDATE users SET staff_category=$1,phone=COALESCE($2,phone),email=COALESCE($3,email) WHERE id=$4 AND role IN ('teacher','ustadh','patron','worker','secretary','admin','director','principal') RETURNING id,username,full_name,role,staff_category,phone,email,active",[req.body.staff_category||null,req.body.phone||null,req.body.email||null,req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Staff member not found'});await audit(req.user.id,'UPDATE_STAFF_CATEGORY',`staff=${req.params.id},category=${req.body.staff_category||''}`);res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});

app.get("/api/leave-requests",staffAuth(),async(req,res)=>{try{
 const isManager=['director','admin'].includes(req.user.role); const q=isManager?`SELECT lr.*,u.full_name requester,u.role requester_role,ru.full_name approver FROM leave_requests lr JOIN users u ON u.id=lr.user_id LEFT JOIN users ru ON ru.id=lr.approved_by ORDER BY CASE lr.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,lr.start_date DESC`: `SELECT lr.*,u.full_name requester,u.role requester_role,ru.full_name approver FROM leave_requests lr JOIN users u ON u.id=lr.user_id LEFT JOIN users ru ON ru.id=lr.approved_by WHERE lr.user_id=$1 ORDER BY lr.created_at DESC`;
 const r=await pool.query(q,isManager?[]:[req.user.id]);res.json(r.rows)
}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/leave-requests",staffAuth(),async(req,res)=>{try{const start=req.body.start_date,end=req.body.end_date||start,reason=String(req.body.reason||'').trim(),type=String(req.body.leave_type||'Annual Leave').trim();if(!start||!reason)return res.status(400).json({error:'Leave type, start date and reason are required'});if(new Date(end)<new Date(start))return res.status(400).json({error:'End date cannot be before start date'});const r=await pool.query(`INSERT INTO leave_requests(user_id,leave_type,start_date,end_date,reason,status) VALUES($1,$2,$3,$4,$5,'pending') RETURNING *`,[req.user.id,type,start,end,reason]);await audit(req.user.id,'SUBMIT_LEAVE_REQUEST',`leave=${r.rows[0].id},${start} to ${end}`);await notifyApprovalRoles({title:'Leave-out approval required',type:'leave-request',message:`${req.user.full_name} submitted a ${type} leave request for ${start} to ${end}. Review and approve/reject the request.`,sourceId:r.rows[0].id,actionUrl:'/staff.html'});await notifyApprovalRolesWhatsApp({eventType:'leave',sourceId:r.rows[0].id,message:`Green Star approval required: ${req.user.full_name} submitted ${type} leave from ${start} to ${end}. Please review and approve/reject.`});res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/leave-requests/:id",auth(["director"]),async(req,res)=>{try{const status=req.body.status==='approved'?'approved':req.body.status==='rejected'?'rejected':null;if(!status)return res.status(400).json({error:'Status must be approved or rejected'});const r=await pool.query(`UPDATE leave_requests SET status=$1,approved_by=$2,approved_at=NOW(),director_note=$3,updated_at=NOW() WHERE id=$4 RETURNING *`,[status,req.user.id,req.body.director_note||null,req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Leave request not found'});await audit(req.user.id,status==='approved'?'APPROVE_LEAVE':'REJECT_LEAVE',`leave=${req.params.id}`);await notifyUserWhatsApp(r.rows[0].user_id,{eventType:'leave',sourceId:r.rows[0].id,message:`Green Star: Your leave-out request #${r.rows[0].id} was ${status} by ${req.user.full_name}.${req.body.director_note?' Note: '+req.body.director_note:''}`});res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/documents/leave/:id",staffAuth(),async(req,res)=>{try{const r=await pool.query(`SELECT lr.*,u.full_name requester,u.role requester_role,u.phone requester_phone,ru.full_name approver FROM leave_requests lr JOIN users u ON u.id=lr.user_id LEFT JOIN users ru ON ru.id=lr.approved_by WHERE lr.id=$1`,[req.params.id]);const x=r.rows[0];if(!x)return res.status(404).send('Leave request not found');if(!['director','admin'].includes(req.user.role)&&Number(x.user_id)!==Number(req.user.id))return res.status(403).send('Access denied');if(x.status!=='approved')return res.status(400).send('This leave request has not been approved by the Director.');const days=Math.floor((new Date(x.end_date)-new Date(x.start_date))/86400000)+1;res.type('html').send(docPage('STAFF LEAVE-OUT APPROVAL LETTER',`<div class="section"><div class="section-title">Leave approval</div><p>This is to confirm that <b>${esc(x.requester)}</b>, serving as <b>${esc(x.requester_role)}</b>, has been granted <b>${esc(x.leave_type)}</b> leave.</p><div class="meta"><div class="item"><b>Start:</b> ${esc(x.start_date)}</div><div class="item"><b>End:</b> ${esc(x.end_date)}</div><div class="item"><b>Days:</b> ${days}</div></div><p><b>Reason:</b> ${esc(x.reason)}</p><p><b>Director's approval:</b> Approved by ${esc(x.approver||'Director')} on ${x.approved_at?new Date(x.approved_at).toLocaleString():''}.</p>${x.director_note?`<p><b>Director's note:</b> ${esc(x.director_note)}</p>`:''}<div class="sign"><span>Staff signature</span><span>Director approval</span><span>School stamp</span></div></div>`))}catch(e){res.status(500).send(e.message)}});

app.post("/api/staff-attendance/check-in",staffAuth(),async(req,res)=>{try{const d=new Date().toISOString().slice(0,10),existing=(await pool.query("SELECT * FROM staff_attendance WHERE staff_id=$1 AND attendance_date=$2",[req.user.id,d])).rows[0];if(existing?.check_in)return res.status(400).json({error:'You have already signed in today',attendance:existing});const r=existing?await pool.query("UPDATE staff_attendance SET check_in=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[existing.id]):await pool.query("INSERT INTO staff_attendance(staff_id,attendance_date,check_in) VALUES($1,$2,NOW()) RETURNING *",[req.user.id,d]);await audit(req.user.id,'STAFF_CHECK_IN',d);res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.post("/api/staff-attendance/check-out",staffAuth(),async(req,res)=>{try{const d=new Date().toISOString().slice(0,10),existing=(await pool.query("SELECT * FROM staff_attendance WHERE staff_id=$1 AND attendance_date=$2",[req.user.id,d])).rows[0];if(!existing||!existing.check_in)return res.status(400).json({error:'Please sign in before signing out'});if(existing.check_out)return res.status(400).json({error:'You have already signed out today',attendance:existing});const r=await pool.query("UPDATE staff_attendance SET check_out=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[existing.id]);await audit(req.user.id,'STAFF_CHECK_OUT',d);res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.get("/api/staff-attendance/my",staffAuth(),async(req,res)=>{try{res.json((await pool.query("SELECT * FROM staff_attendance WHERE staff_id=$1 ORDER BY attendance_date DESC LIMIT 60",[req.user.id])).rows)}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/staff-attendance",auth(["director","admin","secretary"]),async(req,res)=>{try{const d=req.query.date||new Date().toISOString().slice(0,10);res.json((await pool.query(`SELECT sa.*,u.full_name,u.role,u.staff_category,u.phone FROM staff_attendance sa JOIN users u ON u.id=sa.staff_id WHERE sa.attendance_date=$1 ORDER BY CASE u.role WHEN 'teacher' THEN 1 WHEN 'worker' THEN 2 WHEN 'secretary' THEN 3 ELSE 9 END,u.full_name`,[d])).rows)}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/documents/staff-attendance",auth(["director","admin","secretary"]),async(req,res)=>{try{const p=String(req.query.period||"daily").toLowerCase();let where="",vals=[],label="ALL";if(p==="daily"){const d=req.query.date||new Date().toISOString().slice(0,10);vals=[d];where="WHERE sa.attendance_date=$1";label=d}else if(p==="monthly"){const m=String(req.query.month||"");vals=[m];where="WHERE to_char(sa.attendance_date,'YYYY-MM')=$1";label=m}else if(p==="termly"){const y=Number(req.query.academic_year),t=String(req.query.term||"");const ranges={"Term 1":[`${y}-01-01`,`${y}-04-30`],"Term 2":[`${y}-05-01`,`${y}-08-31`],"Term 3":[`${y}-09-01`,`${y}-12-31`]};if(!y||!ranges[t])return res.status(400).send('Select a valid academic year and term.');vals=ranges[t];where="WHERE sa.attendance_date BETWEEN $1::date AND $2::date";label=`${t}, ${y}`}const rows=(await pool.query(`SELECT sa.*,u.full_name,u.role,u.staff_category,u.phone FROM staff_attendance sa JOIN users u ON u.id=sa.staff_id ${where} ORDER BY sa.attendance_date DESC,u.full_name`,vals)).rows;const tr=rows.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.attendance_date)}</td><td>${esc(x.full_name)}</td><td>${esc(x.role)}</td><td>${esc(x.staff_category||'')}</td><td>${x.check_in?new Date(x.check_in).toLocaleTimeString():''}</td><td>${x.check_out?new Date(x.check_out).toLocaleTimeString():''}</td><td>${x.check_in?(x.check_out?'Present':'Signed in'):'Absent / No sign-in'}</td></tr>`).join('');res.type('html').send(docPage(`STAFF ATTENDANCE REGISTER — ${esc(label)}`,`<p><b>Report period:</b> ${esc(label)} &nbsp; <b>Total records:</b> ${rows.length}</p><table><tr><th>NO.</th><th>DATE</th><th>STAFF NAME</th><th>ROLE</th><th>CATEGORY</th><th>CHECK IN</th><th>CHECK OUT</th><th>STATUS</th></tr>${tr||'<tr><td colspan="8">No attendance records for the selected period</td></tr>'}</table>`))}catch(e){res.status(500).send(e.message)}});

app.get('/api/subscription/status',async(req,res)=>{res.set('Cache-Control','no-store');res.json(subscriptionStatus())});
app.get('/api/subscription/payment-info',auth(['admin','director','principal','secretary']),async(req,res)=>{if(!LICENSE_SERVER_URL||!LICENSE_KEY||!LICENSE_INSTALL_SECRET)return res.status(503).json({error:'Developer licensing is not configured on this school installation'});try{const r=await fetch(`${LICENSE_SERVER_URL}/api/v1/subscription-info?license_key=${encodeURIComponent(LICENSE_KEY)}&install_secret=${encodeURIComponent(LICENSE_INSTALL_SECRET)}`,{headers:{'cache-control':'no-store'},signal:AbortSignal.timeout(15000)});const d=await r.json();if(!r.ok)return res.status(r.status).json(d);res.json(d)}catch(e){res.status(502).json({error:'Unable to contact developer licensing service'})}});

app.post('/api/subscription/payment',auth(['admin','director','principal','secretary']),async(req,res)=>{if(!LICENSE_SERVER_URL||!LICENSE_KEY||!LICENSE_INSTALL_SECRET)return res.status(503).json({error:'Developer licensing is not configured on this school installation'});try{const r=await fetch(`${LICENSE_SERVER_URL}${req.body?.mode==='stkpush'?'/api/v1/payments/stkpush':'/api/v1/payments/submit'}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...req.body,license_key:LICENSE_KEY,install_secret:LICENSE_INSTALL_SECRET}),signal:AbortSignal.timeout(20000)});const d=await r.json();if(!r.ok)return res.status(r.status).json(d);res.status(201).json(d)}catch(e){res.status(502).json({error:'Unable to contact developer payment service'})}});

app.get('/api/license/status',async(req,res)=>{res.set('Cache-Control','no-store');res.json(subscriptionStatus())});
app.post('/api/license/sync',adminOnly,async(req,res)=>{await syncLicense();res.json(subscriptionStatus())});

app.get("/api/expenditure-requests",auth(["secretary","admin","director"]),async(req,res)=>{try{const manager=req.user.role==='director';const q=manager?`SELECT er.*,u.full_name requester,ru.full_name reviewer FROM expenditure_requests er JOIN users u ON u.id=er.requested_by LEFT JOIN users ru ON ru.id=er.reviewed_by ORDER BY CASE er.status WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,er.created_at DESC`:`SELECT er.*,u.full_name requester,ru.full_name reviewer FROM expenditure_requests er JOIN users u ON u.id=er.requested_by LEFT JOIN users ru ON ru.id=er.reviewed_by WHERE er.requested_by=$1 ORDER BY er.created_at DESC`;res.json((await pool.query(q,manager?[]:[req.user.id])).rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/expenditure-requests",auth(["secretary","admin"]),async(req,res)=>{try{const x=req.body;if(!x.description||!Number(x.amount))return res.status(400).json({error:'Description and amount are required'});const r=await pool.query(`INSERT INTO expenditure_requests(category,description,amount,payment_method,requested_date,requested_by,status) VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,[x.category||'General',x.description,Number(x.amount),x.payment_method||'Cash',x.requested_date||new Date(),req.user.id]);await audit(req.user.id,'SUBMIT_EXPENDITURE_REQUEST',`request=${r.rows[0].id},amount=${x.amount}`);await notifyApprovalRoles({title:'Expenditure approval required',type:'expenditure-request',message:`${req.user.full_name} submitted an expenditure request of KSh ${Number(x.amount).toLocaleString()} for ${x.description}. Review and approve/reject the request.`,sourceId:r.rows[0].id,actionUrl:'/secretary.html'});await notifyApprovalRolesWhatsApp({eventType:'expenditure',sourceId:r.rows[0].id,message:`Green Star approval required: ${req.user.full_name} submitted expenditure request #${r.rows[0].id} for KSh ${Number(x.amount).toLocaleString()} — ${x.description}. Please review and approve/reject.`});res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/expenditure-requests/:id",auth(["secretary","director"]),async(req,res,next)=>{try{if(req.user?.role==="director"){const status=req.body.status==='approved'?'approved':req.body.status==='rejected'?'rejected':null;if(!status)return res.status(400).json({error:'Status must be approved or rejected'});const r=await pool.query(`UPDATE expenditure_requests SET status=$1,reviewed_by=$2,reviewed_at=NOW(),review_note=$3,updated_at=NOW() WHERE id=$4 AND status='pending' RETURNING *`,[status,req.user.id,req.body.review_note||null,req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Pending expenditure request not found'});await audit(req.user.id,status==='approved'?'APPROVE_EXPENDITURE':'REJECT_EXPENDITURE',`request=${req.params.id}`);await notifyUser(r.rows[0].requested_by,{title:`Expenditure request ${status}`,type:'expenditure-decision',message:`Your expenditure request #${r.rows[0].id} was ${status} by ${req.user.full_name}.${req.body.review_note?' Note: '+req.body.review_note:''}`,sourceId:r.rows[0].id,actionUrl:'/secretary.html'});await notifyUserWhatsApp(r.rows[0].requested_by,{eventType:'expenditure',sourceId:r.rows[0].id,message:`Green Star: Your expenditure request #${r.rows[0].id} was ${status} by ${req.user.full_name}.${req.body.review_note?' Note: '+req.body.review_note:''}`});return res.json(r.rows[0]);}if(req.user?.role!=="secretary")return res.status(403).json({error:"Not allowed"});const x=req.body;const old=(await pool.query("SELECT * FROM expenditure_requests WHERE id=$1 AND requested_by=$2",[req.params.id,req.user.id])).rows[0];if(!old)return res.status(404).json({error:"Expenditure request not found"});if(old.status==='paid')return res.status(400).json({error:"Paid expenditure cannot be edited"});const fields=[],vals=[];for(const k of ["category","description","amount","payment_method","requested_date"]){if(x[k]!==undefined){fields.push(`${k}=$${vals.length+1}`);vals.push(k==='amount'?Number(x[k]):x[k])}}if(!fields.length)return res.status(400).json({error:"Nothing to update"});fields.push(`status=$${vals.length+1}`);vals.push('pending');fields.push(`reviewed_by=NULL`);fields.push(`reviewed_at=NULL`);fields.push(`review_note=NULL`);vals.push(req.params.id);const r=await pool.query(`UPDATE expenditure_requests SET ${fields.join(',')},updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,vals);await audit(req.user.id,'EDIT_EXPENDITURE_REQUEST',`request=${req.params.id};director reapproval required`);res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/expenditure-requests/:id",auth(["secretary"]),async(req,res)=>{try{const old=(await pool.query("SELECT * FROM expenditure_requests WHERE id=$1 AND requested_by=$2",[req.params.id,req.user.id])).rows[0];if(!old)return res.status(404).json({error:"Expenditure request not found"});if(old.status==='paid')return res.status(400).json({error:"Paid expenditure cannot be deleted"});await pool.query("DELETE FROM expenditure_requests WHERE id=$1",[req.params.id]);await audit(req.user.id,'DELETE_EXPENDITURE_REQUEST',`request=${req.params.id}`);res.json({message:'Expenditure request deleted'})}catch(e){res.status(400).json({error:e.message})}});
app.post("/api/expenditure-requests/:id/pay",auth(["secretary","admin"]),async(req,res)=>{try{const r=await pool.query("SELECT * FROM expenditure_requests WHERE id=$1",[req.params.id]);const x=r.rows[0];if(!x)return res.status(404).json({error:'Request not found'});if(x.status!=='approved')return res.status(400).json({error:'Director approval is required before payment'});if(Number(x.requested_by)!==Number(req.user.id)&&req.user.role!=='admin')return res.status(403).json({error:'Only the requester or admin can record this payment'});const ex=await pool.query(`INSERT INTO expenditures(expenditure_date,category,description,amount,payment_method,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[x.requested_date,x.category,x.description,x.amount,x.payment_method,req.body.reference||null,req.user.id]);await pool.query("UPDATE expenditure_requests SET status='paid',paid_at=NOW(),payment_reference=$1,updated_at=NOW() WHERE id=$2",[req.body.reference||null,x.id]);await audit(req.user.id,'PAY_APPROVED_EXPENDITURE',`request=${x.id},expenditure=${ex.rows[0].id}`);res.json(ex.rows[0])}catch(e){res.status(400).json({error:e.message})}});


// Tahfidh Programme — parallel Quran/Tafhid programme. Additive module; existing school modules are untouched.
const tafhidStaffRoles=["admin","secretary","director","principal"];
async function tafhidGroupAccess(user,groupId){
  const g=(await pool.query("SELECT * FROM tafhid_groups WHERE id=$1 AND active=true",[Number(groupId)])).rows[0];
  if(!g)return null;
  if(user.role==="ustadh" && Number(g.teacher_id)!==Number(user.id))return null;
  return g;
}

app.get("/api/tafhid/ustadhs",auth(["admin"]),async(req,res)=>{
  try{res.json((await pool.query("SELECT id,full_name,username FROM users WHERE role='ustadh' AND active=true ORDER BY full_name")).rows)}
  catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/tafhid/groups",auth(["ustadh","admin","secretary","director","principal"]),async(req,res)=>{
  try{
    const vals=[],where=["g.active=true"];
    if(req.user.role==="ustadh"){vals.push(req.user.id);where.push(`g.teacher_id=$${vals.length}`)}
    if(req.query.teacher_id && req.user.role==="admin"){vals.push(Number(req.query.teacher_id));where.push(`g.teacher_id=$${vals.length}`)}
    const q=`SELECT g.id,g.group_name,g.teacher_id,g.class_name,g.active,g.created_at,u.full_name teacher_name,
      COUNT(m.student_id)::int learner_count
      FROM tafhid_groups g JOIN users u ON u.id=g.teacher_id
      LEFT JOIN tafhid_group_learners m ON m.group_id=g.id
      WHERE ${where.join(" AND ")}
      GROUP BY g.id,u.full_name ORDER BY g.group_name`;
    res.json((await pool.query(q,vals)).rows);
  }catch(e){res.status(500).json({error:e.message})}
});

app.patch("/api/tafhid/groups/:id",auth(["admin"]),async(req,res)=>{
  try{
    const groupId=Number(req.params.id),ustadhId=Number(req.body.ustadh_id);
    if(!groupId||!ustadhId)return res.status(400).json({error:"Halaqah and Ustadh are required"});
    const u=(await pool.query("SELECT id FROM users WHERE id=$1 AND role='ustadh' AND active=true",[ustadhId])).rows[0];
    if(!u)return res.status(400).json({error:"Selected Ustadh account was not found or is inactive"});
    const r=await pool.query("UPDATE tafhid_groups SET teacher_id=$1 WHERE id=$2 RETURNING *",[ustadhId,groupId]);
    if(!r.rows[0])return res.status(404).json({error:"Tahfidh Halaqah not found"});
    await audit(req.user.id,"ASSIGN_TAHFIDH_USTADH",`group=${groupId},ustadh=${ustadhId}`);
    res.json(r.rows[0]);
  }catch(e){res.status(400).json({error:e.message})}
});

app.post("/api/tafhid/groups",auth(["admin"]),async(req,res)=>{
  try{
    const teacherId=Number(req.body.teacher_id), name=String(req.body.group_name||"").trim();
    if(!teacherId||!name)return res.status(400).json({error:"Tafhid group name and teacher are required"});
    const t=(await pool.query("SELECT id FROM users WHERE id=$1 AND role='ustadh' AND active=true",[teacherId])).rows[0];
    if(!t)return res.status(400).json({error:"Selected teacher account was not found or is inactive"});
    const r=await pool.query("INSERT INTO tafhid_groups(group_name,teacher_id) VALUES($1,$2) RETURNING *",[name,teacherId]);
    await audit(req.user.id,"CREATE_TAFHID_GROUP",`group=${r.rows[0].id},teacher=${teacherId}`);
    res.status(201).json(r.rows[0]);
  }catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/tafhid/groups/:id/members",auth(["ustadh","admin","secretary","director","principal"]),async(req,res)=>{
  try{
    const g=await tafhidGroupAccess(req.user,req.params.id); if(!g)return res.status(403).json({error:"Tahfidh group access denied"});
    const rows=(await pool.query(`SELECT s.id,s.admission_no,s.full_name
      FROM tafhid_group_learners m JOIN students s ON s.id=m.student_id
      WHERE m.group_id=$1 ORDER BY s.full_name`,[g.id])).rows;
    res.json({group:g,learners:rows});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/tafhid/groups/:id/members",auth(["admin"]),async(req,res)=>{
  try{
    const groupId=Number(req.params.id), studentId=Number(req.body.student_id);
    if(!studentId)return res.status(400).json({error:"Learner is required"});
    const g=(await pool.query("SELECT id FROM tafhid_groups WHERE id=$1",[groupId])).rows[0];
    if(!g)return res.status(404).json({error:"Tahfidh group not found"});
    const st=(await pool.query("SELECT id FROM students WHERE id=$1",[studentId])).rows[0];
    if(!st)return res.status(404).json({error:"Learner not found"});
    await pool.query("INSERT INTO tafhid_group_learners(group_id,student_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[groupId,studentId]);
    await audit(req.user.id,"ADD_TAFHID_LEARNER",`group=${groupId},student=${studentId}`);
    res.status(201).json({message:"Learner added to Tafhid group"});
  }catch(e){res.status(400).json({error:e.message})}
});

app.delete("/api/tafhid/groups/:groupId/members/:studentId",auth(["admin"]),async(req,res)=>{
  try{
    const r=await pool.query("DELETE FROM tafhid_group_learners WHERE group_id=$1 AND student_id=$2 RETURNING id",[req.params.groupId,req.params.studentId]);
    if(!r.rows[0])return res.status(404).json({error:"Learner is not in this Tafhid group"});
    await audit(req.user.id,"REMOVE_TAFHID_LEARNER",`group=${req.params.groupId},student=${req.params.studentId}`);
    res.json({message:"Learner removed"});
  }catch(e){res.status(400).json({error:e.message})}
});

app.get("/api/tafhid/assessments",auth(["ustadh","admin","secretary","director","principal"]),async(req,res)=>{
  try{
    const vals=[],where=[];
    if(req.query.group_id){vals.push(Number(req.query.group_id));where.push(`a.group_id=$${vals.length}`)}
    if(req.query.student_id){vals.push(Number(req.query.student_id));where.push(`a.student_id=$${vals.length}`)}
    if(req.query.assessment_type){vals.push(String(req.query.assessment_type));where.push(`a.assessment_type=$${vals.length}`)}
    if(req.query.academic_year){vals.push(Number(req.query.academic_year));where.push(`a.academic_year=$${vals.length}`)}
    if(req.user.role==="ustadh"){vals.push(req.user.id);where.push(`g.teacher_id=$${vals.length}`)}
    const q=`SELECT a.*,g.group_name,g.teacher_id,u.full_name teacher_name,s.admission_no,s.full_name student_name
      FROM tafhid_assessments a JOIN tafhid_groups g ON g.id=a.group_id
      JOIN users u ON u.id=g.teacher_id JOIN students s ON s.id=a.student_id
      ${where.length?"WHERE "+where.join(" AND "):""}
      ORDER BY a.academic_year DESC,a.created_at DESC,s.full_name`;
    res.json((await pool.query(q,vals)).rows);
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/tafhid/assessments/bulk",auth(["ustadh","admin"]),async(req,res)=>{
  const c=await pool.connect();
  try{
    const groupId=Number(req.body.group_id), type=String(req.body.assessment_type||"monthly"), period=String(req.body.period_label||"").trim(), year=Number(req.body.academic_year||new Date().getFullYear());
    if(!groupId||!["monthly","end_term"].includes(type)||!period||!year)return res.status(400).json({error:"Group, assessment type, period and academic year are required"});
    const g=(await c.query("SELECT * FROM tafhid_groups WHERE id=$1 AND active=true",[groupId])).rows[0];
    if(!g)return res.status(404).json({error:"Tahfidh group not found"});
    if(req.user.role==="ustadh"&&Number(g.teacher_id)!==Number(req.user.id))return res.status(403).json({error:"You can enter marks only for your assigned Tahfidh Halaqah"});
    const entries=Array.isArray(req.body.entries)?req.body.entries:[];
    if(!entries.length)return res.status(400).json({error:"No Tahfidh marks supplied"});
    await c.query("BEGIN");
    for(const x of entries){
      const studentId=Number(x.student_id);
      const member=(await c.query("SELECT 1 FROM tafhid_group_learners WHERE group_id=$1 AND student_id=$2",[groupId,studentId])).rows[0];
      if(!member)continue;
      // Tahfidh uses four components only. Each component is out of 25; total is out of 100.
      const q1=Math.max(0,Math.min(25,Number(x.q1||0)));
      const q2=Math.max(0,Math.min(25,Number(x.q2||0)));
      const q3=Math.max(0,Math.min(25,Number(x.q3||0)));
      const tajweed=Math.max(0,Math.min(25,Number(x.tajweed||0)));
      const total=q1+q2+q3+tajweed;
      await c.query(`INSERT INTO tafhid_assessments(group_id,student_id,assessment_type,period_label,academic_year,juzu,q1,q2,q3,q4,q5,tajweed,total,teacher_comment,entered_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12,$13)
        ON CONFLICT(group_id,student_id,assessment_type,period_label,academic_year)
        DO UPDATE SET juzu=EXCLUDED.juzu,q1=EXCLUDED.q1,q2=EXCLUDED.q2,q3=EXCLUDED.q3,q4=0,q5=0,tajweed=EXCLUDED.tajweed,total=EXCLUDED.total,teacher_comment=EXCLUDED.teacher_comment,entered_by=EXCLUDED.entered_by,updated_at=NOW()`,
        [groupId,studentId,type,period,year,String(x.juzu||"").trim(),q1,q2,q3,tajweed,total,String(x.teacher_comment||"").trim(),req.user.id]);
    }
    await c.query("COMMIT");
    await audit(req.user.id,"SAVE_TAFHID_MARKS",`group=${groupId},type=${type},period=${period},year=${year}`);
    res.json({message:"Tahfidh marks saved successfully"});
  }catch(e){await c.query("ROLLBACK").catch(()=>{});res.status(400).json({error:e.message})}finally{c.release()}
});

app.get("/api/my/tafhid",auth(["parent","student"]),async(req,res)=>{
  try{
    const requested=req.query.student_id?Number(req.query.student_id):null;
    const vals=[],where=[];
    if(req.user.role==="student"){
      vals.push(req.user.id);where.push(`s.user_id=$${vals.length}`);
      if(requested)where.push(`s.id=${requested}`);
    }else{
      vals.push(req.user.phone,req.user.full_name);
      where.push(`(s.parent_phone=$1 OR s.parent_name=$2)`);
      if(requested){vals.push(requested);where.push(`s.id=$${vals.length}`)}
    }
    const q=`SELECT a.*,g.group_name,g.teacher_id,u.full_name teacher_name,s.admission_no,s.full_name student_name
      FROM tafhid_assessments a JOIN tafhid_groups g ON g.id=a.group_id JOIN users u ON u.id=g.teacher_id
      JOIN students s ON s.id=a.student_id WHERE ${where.join(" AND ")}
      ORDER BY a.academic_year DESC,a.assessment_type,a.period_label DESC,a.created_at DESC`;
    res.json((await pool.query(q,vals)).rows);
  }catch(e){res.status(500).json({error:e.message})}
});


app.get("/api/tafhid/merit",auth(["ustadh","admin","secretary","director","principal"]),async(req,res)=>{
  try{
    const groupId=Number(req.query.group_id);
    if(!groupId)return res.status(400).json({error:"Tafhid group is required"});
    const g=await tafhidGroupAccess(req.user,groupId);
    if(!g)return res.status(403).json({error:"Tahfidh group access denied"});
    const type=String(req.query.assessment_type||"").trim();
    const period=String(req.query.period_label||"").trim();
    const year=req.query.academic_year?Number(req.query.academic_year):null;
    if(!["monthly","end_term"].includes(type)||!period||!Number.isFinite(year))return res.status(400).json({error:"Assessment type, period and academic year are required"});
    const rows=(await pool.query(`SELECT s.id,s.admission_no,s.full_name,
      a.id assessment_id,a.juzu,a.q1,a.q2,a.q3,a.tajweed,
      CASE WHEN a.id IS NULL THEN NULL ELSE COALESCE(a.q1,0)+COALESCE(a.q2,0)+COALESCE(a.q3,0)+COALESCE(a.tajweed,0) END AS computed_total,
      a.teacher_comment
      FROM tafhid_group_learners m JOIN students s ON s.id=m.student_id
      LEFT JOIN tafhid_assessments a ON a.group_id=m.group_id AND a.student_id=m.student_id
        AND a.assessment_type=$2 AND a.period_label=$3 AND a.academic_year=$4
      WHERE m.group_id=$1 ORDER BY s.full_name`,[groupId,type,period,year])).rows;
    const assessed=rows.filter(x=>x.assessment_id).sort((a,b)=>Number(b.computed_total||0)-Number(a.computed_total||0)||String(a.full_name).localeCompare(String(b.full_name)));
    let lastTotal=null,lastPosition=0;
    const ranked=assessed.map((x,i)=>{const total=Number(x.computed_total||0);if(lastTotal===null||total!==lastTotal){lastPosition=i+1;lastTotal=total}return {...x,total,average:total,position:lastPosition,assessed:true}});
    const byId=new Map(ranked.map(x=>[Number(x.id),x]));
    const result=rows.map(x=>byId.get(Number(x.id))||{...x,total:0,average:0,position:null,assessed:false});
    result.sort((a,b)=>{
      if(a.assessed && !b.assessed)return -1;
      if(!a.assessed && b.assessed)return 1;
      if(a.assessed && b.assessed)return Number(b.total||0)-Number(a.total||0)||String(a.full_name).localeCompare(String(b.full_name));
      return String(a.full_name).localeCompare(String(b.full_name));
    });
    res.json({group:g,assessment_type:type,period_label:period,academic_year:year,learners:result});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/documents/tafhid-merit",auth(["ustadh","admin","secretary","director","principal"]),async(req,res)=>{
  try{
    const groupId=Number(req.query.group_id);
    if(!groupId)return res.status(400).send("Tahfidh Halaqah is required");
    const g=await tafhidGroupAccess(req.user,groupId);
    if(!g)return res.status(403).send("Tahfidh Halaqah access denied");
    const type=String(req.query.assessment_type||"").trim();
    const period=String(req.query.period_label||"").trim();
    const year=Number(req.query.academic_year);
    if(!["monthly","end_term"].includes(type)||!period||!Number.isFinite(year))return res.status(400).send("Assessment type, period and academic year are required");
    const rows=(await pool.query(`SELECT s.id,s.full_name,a.juzu,a.q1,a.q2,a.q3,a.tajweed,
      CASE WHEN a.id IS NULL THEN NULL ELSE COALESCE(a.q1,0)+COALESCE(a.q2,0)+COALESCE(a.q3,0)+COALESCE(a.tajweed,0) END AS computed_total
      FROM tafhid_group_learners m JOIN students s ON s.id=m.student_id
      LEFT JOIN tafhid_assessments a ON a.group_id=m.group_id AND a.student_id=m.student_id
        AND a.assessment_type=$2 AND a.period_label=$3 AND a.academic_year=$4
      WHERE m.group_id=$1`,[groupId,type,period,year])).rows;
    const assessed=rows.filter(x=>x.computed_total!==null).sort((a,b)=>Number(b.computed_total)-Number(a.computed_total)||String(a.full_name).localeCompare(String(b.full_name)));
    const unassessed=rows.filter(x=>x.computed_total===null).sort((a,b)=>String(a.full_name).localeCompare(String(b.full_name)));
    const ordered=[...assessed,...unassessed];
    const tr=ordered.map((x,i)=>{const has=x.computed_total!==null,total=Number(x.computed_total||0);return `<tr><td class="center">${i+1}.</td><td>${esc(x.full_name)}</td><td>${esc(x.juzu||"—")}</td><td class="center">${has?Number(x.q1).toFixed(0):"—"}</td><td class="center">${has?Number(x.q2).toFixed(0):"—"}</td><td class="center">${has?Number(x.q3).toFixed(0):"—"}</td><td class="center">${has?Number(x.tajweed).toFixed(0):"—"}</td><td class="center"><b>${has?total.toFixed(0):"—"}</b></td></tr>`}).join('');
    const assessedCount=assessed.length;
    const avg=assessedCount?assessed.reduce((sum,x)=>sum+Number(x.computed_total||0),0)/assessedCount:0;
    const teacher=(await pool.query("SELECT full_name FROM users WHERE id=$1",[g.teacher_id])).rows[0]?.full_name||"—";
    const title=`TAHFIDH PROGRAMME`;
    const content=`<div class="halaqah-line"><b>HALAQAH:</b> ${esc(g.group_name)}</div>
      <div class="program-line"><b>TAHFIDH PROGRAMME</b></div>
      <div class="period-line"><b>${esc(type==="end_term"?"END TERM":"MONTHLY")}</b> — ${esc(period)} ${year}</div>
      <div class="marks-note">Q1, Q2, Q3 and TAJWEED are each out of 25 marks. TOTAL is out of 100.</div>
      <table class="tafhid-template"><thead><tr><th>NO.</th><th>NAME</th><th>JUZU</th><th>Q1</th><th>Q2</th><th>Q3</th><th>TAJWEED</th><th>TOTAL</th></tr></thead><tbody>${tr||`<tr><td colspan="8">No learners assigned to this Halaqah.</td></tr>`}</tbody></table>
      <div class="tafhid-footer"><span><b>Ustadh ${esc(teacher)}</b></span><span><b>Average: ${avg.toFixed(0)}</b></span></div>`;
    const filename=`${String(g.group_name).replace(/[^a-zA-Z0-9_-]+/g,"-")}-Tahfidh-Programme-${String(period).replace(/[^a-zA-Z0-9_-]+/g,"-")}.html`;
    if(String(req.query.download||"")==="1")res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
    const page=docPage(title,content).replace('</style></head>',' .halaqah-line{font-size:17px;margin:4px 0 3px;text-align:left}.program-line{text-align:center;font-size:18px;margin:6px 0}.period-line{text-align:center;font-size:12px;margin:4px 0 12px}.marks-note{text-align:center;font-size:10px;color:#687478;margin:2px 0 8px}.tafhid-template{font-size:12px;margin-top:8px}.tafhid-template th,.tafhid-template td{padding:6px 7px}.tafhid-template th{background:#fff;color:#172033;text-align:center}.tafhid-template td:nth-child(1),.tafhid-template td:nth-child(4),.tafhid-template td:nth-child(5),.tafhid-template td:nth-child(6),.tafhid-template td:nth-child(7),.tafhid-template td:nth-child(8){text-align:center}.tafhid-footer{display:flex;justify-content:space-between;margin-top:22px;padding:0 12px;font-size:12px} </style></head>');
    res.type("html").send(page);
  }catch(e){res.status(500).send(e.message)}
});

app.get("/api/documents/tafhid-halaqah-report",auth(["ustadh","admin","secretary","director","principal"]),async(req,res)=>{
  try{
    const groupId=Number(req.query.group_id); if(!groupId)return res.status(400).send("Halaqah is required");
    const g=await tafhidGroupAccess(req.user,groupId); if(!g)return res.status(403).send("Halaqah access denied");
    const type=String(req.query.assessment_type||"").trim(),period=String(req.query.period_label||"").trim(),year=Number(req.query.academic_year);
    if(!["monthly","end_term"].includes(type)||!period||!Number.isFinite(year))return res.status(400).send("Assessment type, period and academic year are required");
    const rows=(await pool.query(`SELECT s.full_name,s.admission_no,a.juzu,a.q1,a.q2,a.q3,a.tajweed,COALESCE(a.q1,0)+COALESCE(a.q2,0)+COALESCE(a.q3,0)+COALESCE(a.tajweed,0) total
      FROM tafhid_group_learners m JOIN students s ON s.id=m.student_id
      LEFT JOIN tafhid_assessments a ON a.group_id=m.group_id AND a.student_id=m.student_id AND a.assessment_type=$2 AND a.period_label=$3 AND a.academic_year=$4
      WHERE m.group_id=$1 ORDER BY CASE WHEN a.id IS NULL THEN 1 ELSE 0 END,total DESC,s.full_name`,[groupId,type,period,year])).rows;
    const assessed=rows.filter(x=>x.juzu!==null || x.q1!==null || x.q2!==null || x.q3!==null || x.tajweed!==null).filter(x=>x.q1!==null || x.q2!==null || x.q3!==null || x.tajweed!==null);
    const avg=assessed.length?assessed.reduce((n,x)=>n+Number(x.total||0),0)/assessed.length:0;
    const tr=rows.map((x,i)=>{const has=x.q1!==null||x.q2!==null||x.q3!==null||x.tajweed!==null;return `<tr><td class="center">${i+1}</td><td>${esc(x.full_name)}</td><td>${esc(x.admission_no||"—")}</td><td>${esc(x.juzu||"—")}</td><td class="center">${has?Number(x.q1||0).toFixed(0):"—"}</td><td class="center">${has?Number(x.q2||0).toFixed(0):"—"}</td><td class="center">${has?Number(x.q3||0).toFixed(0):"—"}</td><td class="center">${has?Number(x.tajweed||0).toFixed(0):"—"}</td><td class="center"><b>${has?Number(x.total||0).toFixed(0):"—"}</b></td></tr>`}).join("");
    const teacher=(await pool.query("SELECT full_name FROM users WHERE id=$1",[g.teacher_id])).rows[0]?.full_name||"—";
    const content=`<div class="summary"><div class="box"><b>Halaqah</b><br>${esc(g.group_name)}</div><div class="box"><b>Ustadh</b><br>${esc(teacher)}</div><div class="box"><b>Assessment</b><br>${esc(type==="end_term"?"End-Term":"Monthly")} — ${esc(period)}</div><div class="box"><b>Academic Year</b><br>${year}</div></div>
      <p><b>Programme:</b> Tahfidh &nbsp; <b>Assessed learners:</b> ${assessed.length} / ${rows.length} &nbsp; <b>Halaqah average:</b> ${avg.toFixed(0)} / 100</p>
      <p class="note">Q1, Q2, Q3 and Tajweed are each out of 25 marks. Total is out of 100.</p>
      <table><tr><th>No.</th><th>Learner</th><th>Admission</th><th>Juzu</th><th>Q1 / 25</th><th>Q2 / 25</th><th>Q3 / 25</th><th>Tajweed / 25</th><th>Total / 100</th></tr>${tr||`<tr><td colspan="9">No learners assigned to this Halaqah.</td></tr>`}</table>
      <div class="section"><div class="section-title">Ustadh's Halaqah Record</div><p>This report summarises the recorded Tahfidh assessment for the selected Halaqah and period.</p></div>`;
    const filename=`${String(g.group_name).replace(/[^a-zA-Z0-9_-]+/g,"-")}-Halaqah-Report-${String(period).replace(/[^a-zA-Z0-9_-]+/g,"-")}.html`;
    if(String(req.query.download||"")==="1")res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
    res.type("html").send(docPage("HALAQAH REPORT",content));
  }catch(e){res.status(500).send(e.message)}
});

app.get("/api/documents/tafhid-assessment/:id",auth(["ustadh","admin","secretary","director","principal","student","parent"]),async(req,res)=>{
  try{
    const r=(await pool.query(`SELECT a.*,g.group_name,g.teacher_id,u.full_name teacher_name,s.admission_no,s.full_name student_name,s.class_name,s.stream,s.parent_phone,s.parent_name,
      COALESCE(a.q1,0)+COALESCE(a.q2,0)+COALESCE(a.q3,0)+COALESCE(a.tajweed,0) AS computed_total
      FROM tafhid_assessments a JOIN tafhid_groups g ON g.id=a.group_id JOIN users u ON u.id=g.teacher_id JOIN students s ON s.id=a.student_id
      WHERE a.id=$1`,[req.params.id])).rows[0];
    if(!r)return res.status(404).send("Tahfidh assessment not found");
    if(req.user.role==="ustadh"&&Number(r.teacher_id)!==Number(req.user.id))return res.status(403).send("Only the assigned Tahfidh Ustadh can download this record.");
    if(req.user.role==="parent"){
      const ok=(await pool.query("SELECT 1 FROM students WHERE id=$1 AND (parent_phone=$2 OR parent_name=$3)",[r.student_id,req.user.phone,req.user.full_name])).rows[0];
      if(!ok)return res.status(403).send("This learner is not linked to your parent account.");
    }
    if(req.user.role==="student"){
      const ok=(await pool.query("SELECT 1 FROM students WHERE id=$1 AND user_id=$2",[r.student_id,req.user.id])).rows[0];
      if(!ok)return res.status(403).send("This record is not linked to your student account.");
    }
    const filename=`${String(r.student_name).replace(/[^a-zA-Z0-9_-]+/g,"-")}-Tahfidh-${String(r.period_label).replace(/[^a-zA-Z0-9_-]+/g,"-")}.html`;
    if(String(req.query.download||"")==="1")res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
    const content=`<div class="program-line"><b>TAHFIDH PROGRAMME</b></div><div class="halaqah-line"><b>HALAQAH:</b> ${esc(r.group_name)}</div>
      <div class="summary"><div class="box"><b>Learner</b><br>${esc(r.student_name)}</div><div class="box"><b>Juzu</b><br>${esc(r.juzu||"—")}</div><div class="box"><b>Teacher</b><br>${esc(r.teacher_name)}</div><div class="box"><b>Assessment</b><br>${esc(r.assessment_type==="end_term"?"End-Term":"Monthly")} — ${esc(r.period_label)} ${r.academic_year}</div></div>
      <table><tr><th>Q1 / 25</th><th>Q2 / 25</th><th>Q3 / 25</th><th>TAJWEED / 25</th><th>TOTAL / 100</th></tr>
      <tr><td class="center">${r.q1}</td><td class="center">${r.q2}</td><td class="center">${r.q3}</td><td class="center">${r.tajweed}</td><td class="center"><b>${Number(r.computed_total||0).toFixed(0)}</b></td></tr></table>
      <div class="section"><b>Teacher Comment</b><p>${esc(r.teacher_comment||"—")}</p></div>`;
    res.type("html").send(docPage("TAHFIDH PROGRAMME ASSESSMENT",content));
  }catch(e){res.status(500).send(e.message)}
});


// School calendar — all authenticated school users can view; administration can manage.
app.get("/calendar",(req,res)=>res.sendFile(path.join(PUBLIC_DIR,"calendar.html")));
app.get("/api/calendar",auth(),async(req,res)=>{try{res.set("Cache-Control","no-store");const r=await pool.query(`SELECT c.*,u.full_name creator FROM school_calendar c LEFT JOIN users u ON u.id=c.created_by ORDER BY c.event_date,c.start_time NULLS LAST,c.id`);res.set("Cache-Control","no-store");res.json(r.rows)}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/calendar",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const title=String(req.body.title||"").trim(),date=req.body.event_date;if(!title||!date)return res.status(400).json({error:"Title and date are required."});const r=await pool.query(`INSERT INTO school_calendar(title,event_date,start_time,end_time,category,location,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[title,date,req.body.start_time||null,req.body.end_time||null,String(req.body.category||"School Activity"),req.body.location||null,req.body.description||null,req.user.id]);await audit(req.user.id,"CREATE_CALENDAR_EVENT",`${title} ${date}`);res.status(201).json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.patch("/api/calendar/:id",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const r=await pool.query(`UPDATE school_calendar SET title=COALESCE($1,title),event_date=COALESCE($2,event_date),start_time=$3,end_time=$4,category=COALESCE($5,category),location=$6,description=$7,updated_at=NOW() WHERE id=$8 RETURNING *`,[req.body.title||null,req.body.event_date||null,req.body.start_time||null,req.body.end_time||null,req.body.category||null,req.body.location||null,req.body.description||null,req.params.id]);if(!r.rows[0])return res.status(404).json({error:"Calendar event not found"});res.json(r.rows[0])}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/calendar/:id",auth(["admin","director","principal","secretary"]),async(req,res)=>{try{const r=await pool.query("DELETE FROM school_calendar WHERE id=$1 RETURNING id",[req.params.id]);if(!r.rows[0])return res.status(404).json({error:"Calendar event not found"});await audit(req.user.id,"DELETE_CALENDAR_EVENT",`id=${req.params.id}`);res.json({message:"Calendar event deleted"})}catch(e){res.status(400).json({error:e.message})}});
function pdfSafe(value){
  return String(value??'').split('').map(ch=>{const c=ch.charCodeAt(0);if(c<32||c>126)return '?';if(ch==='\\'||ch==='('||ch===')')return '\\'+ch;return ch}).join('');
}
function calendarPdfBuffer(rows){
  const W=595,H=842,margin=42,lines=[];
  lines.push([18,800,'GREEN STAR INTEGRATED SCHOOL']);
  lines.push([14,778,'OFFICIAL SCHOOL CALENDAR']);
  lines.push([9,758,'Live school calendar']);
  let y=730;
  const addWrapped=(text,size=9)=>{const words=pdfSafe(text).split(/\s+/);let line='';for(const w of words){if((line+' '+w).length>88){lines.push([size,y,line.trim()]);y-=13;line=w}else line+=(line?' ':'')+w}if(line){lines.push([size,y,line.trim()]);y-=13}};
  if(!rows.length)addWrapped('No calendar events have been published.');
  rows.forEach((x,i)=>{if(y<70){lines.push([8,y,'Continued on next page']);y=730;lines.push([9,y,'GREEN STAR INTEGRATED SCHOOL - SCHOOL CALENDAR (CONT.)']);y-=22}addWrapped(`${i+1}. ${x.event_date||''} | ${x.title||''} | ${x.category||'School Activity'} | ${x.start_time||''}${x.end_time?' - '+x.end_time:''} | ${x.location||''}`);if(x.description)addWrapped(`Description: ${x.description}`,8);y-=4});
  const streamParts=['BT'];lines.forEach(([size,yy,text])=>{streamParts.push(`/F1 ${size} Tf 1 0 0 1 ${margin} ${yy} Tm (${pdfSafe(text)}) Tj`)});streamParts.push('ET');const content=streamParts.join('\n');
  const objs=[];objs.push('<< /Type /Catalog /Pages 2 0 R >>');objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`);objs.push(`<< /Length ${Buffer.byteLength(content,'latin1')} >>\nstream\n${content}\nendstream`);objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objs.length;i++){offsets.push(Buffer.byteLength(pdf,'latin1'));pdf+=`${i+1} 0 obj\n${objs[i]}\nendobj\n`}const xref=Buffer.byteLength(pdf,'latin1');pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;for(let i=1;i<offsets.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';pdf+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(pdf,'latin1');
}
app.get("/api/calendar/pdf",auth(),async(req,res)=>{try{const rows=(await pool.query("SELECT * FROM school_calendar ORDER BY event_date,start_time NULLS LAST,id")).rows;const pdf=calendarPdfBuffer(rows);res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`attachment; filename="Green-Star-School-Calendar.pdf"`);res.setHeader("Content-Length",pdf.length);res.setHeader("Cache-Control","no-store");res.send(pdf)}catch(e){res.status(500).json({error:e.message})}});


// ================= ONLINE CLASSES & MEETINGS (additive module) =================
const ONLINE_CREATOR_ROLES=['admin','director','principal','teacher','ustadh'];
const ONLINE_MANAGER_ROLES=['admin','director','principal'];
function onlineRoomCode(){return 'GS-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,8).toUpperCase()}
async function onlineCanAccessMeeting(meetingId,user){
  const r=await pool.query(`SELECT m.*,u.full_name host_name,s.name subject_name FROM online_meetings m JOIN users u ON u.id=m.host_user_id LEFT JOIN subjects s ON s.id=m.subject_id WHERE m.id=$1`,[meetingId]);
  const m=r.rows[0]; if(!m)return null;
  if(ONLINE_MANAGER_ROLES.includes(user.role)||Number(m.host_user_id)===Number(user.id))return m;
  const p=await pool.query(`SELECT 1 FROM online_participants WHERE meeting_id=$1 AND user_id=$2`,[meetingId,user.id]);
  return p.rows[0]?m:null;
}
async function onlineSeedAttendance(meetingId){
  await pool.query(`INSERT INTO online_attendance(meeting_id,student_id)
    SELECT $1,s.id FROM students s JOIN online_participants op ON op.user_id=s.user_id
    WHERE op.meeting_id=$1 AND s.user_id IS NOT NULL ON CONFLICT(meeting_id,student_id) DO NOTHING`,[meetingId]);
}
app.get('/online',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'online.html')));
app.get('/api/online/config',auth(),async(req,res)=>{
  if(!JITSI_BASE_URL||!JITSI_APP_SECRET||!JITSI_DOMAIN) return res.status(503).json({error:'Integrated meeting service is not configured. Set JITSI_BASE_URL, JITSI_DOMAIN and JITSI_APP_SECRET on the server.'});
  res.json({baseUrl:JITSI_BASE_URL,domain:JITSI_DOMAIN,appId:JITSI_APP_ID});
});
app.get('/api/online/meetings/:id/token',auth(),async(req,res)=>{try{
  if(!JITSI_BASE_URL||!JITSI_APP_SECRET||!JITSI_DOMAIN) return res.status(503).json({error:'Integrated meeting service is not configured on the server.'});
  const m=await onlineCanAccessMeeting(req.params.id,req.user);
  if(!m)return res.status(403).json({error:'You are not authorized for this meeting'});
  if(['cancelled','completed'].includes(m.status))return res.status(400).json({error:'This meeting is no longer live'});
  const now=Math.floor(Date.now()/1000);
  const token=jwt.sign({
    aud:JITSI_APP_ID,
    iss:JITSI_APP_ID,
    sub:JITSI_DOMAIN,
    room:m.room_code,
    iat:now-5,
    exp:now+5*60,
    context:{user:{id:String(req.user.id),name:req.user.full_name,email:req.user.email||undefined,role:req.user.role}}
  },JITSI_APP_SECRET,{algorithm:'HS256'});
  res.json({baseUrl:JITSI_BASE_URL,domain:JITSI_DOMAIN,roomCode:m.room_code,token,user:{id:req.user.id,name:req.user.full_name,email:req.user.email||''},isHost:Number(m.host_user_id)===Number(req.user.id)||ONLINE_MANAGER_ROLES.includes(req.user.role)});
}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/online/lookup',auth(),async(req,res)=>{try{
  const classes=(await pool.query(`SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL AND TRIM(class_name)<>'' ORDER BY class_name`)).rows.map(x=>x.class_name);
  const subjects=(await pool.query(`SELECT id,name FROM subjects ORDER BY name`)).rows;
  const users=(await pool.query(`SELECT id,full_name,role FROM users WHERE active=true AND role IN ('teacher','ustadh','patron','admin','director','principal','secretary','worker','parent','student') ORDER BY full_name`)).rows;
  res.set('Cache-Control','no-store');res.json({classes,subjects,users});
}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/online/meetings',auth(),async(req,res)=>{try{
  const u=req.user; let rows;
  if(ONLINE_MANAGER_ROLES.includes(u.role)) rows=(await pool.query(`SELECT m.*,u.full_name host_name,s.name subject_name,COUNT(op.id)::int participant_count FROM online_meetings m JOIN users u ON u.id=m.host_user_id LEFT JOIN subjects s ON s.id=m.subject_id LEFT JOIN online_participants op ON op.meeting_id=m.id GROUP BY m.id,u.full_name,s.name ORDER BY m.scheduled_start DESC`)).rows;
  else rows=(await pool.query(`SELECT m.*,u.full_name host_name,s.name subject_name,COUNT(op2.id)::int participant_count FROM online_meetings m JOIN users u ON u.id=m.host_user_id LEFT JOIN subjects s ON s.id=m.subject_id JOIN online_participants mine ON mine.meeting_id=m.id AND mine.user_id=$1 LEFT JOIN online_participants op2 ON op2.meeting_id=m.id GROUP BY m.id,u.full_name,s.name ORDER BY m.scheduled_start DESC`,[u.id])).rows;
  res.set('Cache-Control','no-store');res.json(rows);
}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/online/meetings/:id',auth(),async(req,res)=>{try{
  const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m)return res.status(403).json({error:'You are not authorized for this meeting'});
  const participants=(await pool.query(`SELECT op.*,u.full_name,u.role,u.email FROM online_participants op JOIN users u ON u.id=op.user_id WHERE op.meeting_id=$1 ORDER BY u.full_name`,[req.params.id])).rows;
  const chat=(await pool.query(`SELECT c.*,u.full_name sender_name FROM online_chat c JOIN users u ON u.id=c.sender_user_id WHERE c.meeting_id=$1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 100`,[req.params.id])).rows.reverse();
  const attendance=(await pool.query(`SELECT oa.*,s.full_name student_name,s.admission_no FROM online_attendance oa JOIN students s ON s.id=oa.student_id WHERE oa.meeting_id=$1 ORDER BY s.full_name`,[req.params.id])).rows;
  const recordings=(await pool.query(`SELECT * FROM online_recordings WHERE meeting_id=$1 ORDER BY created_at DESC`,[req.params.id])).rows;
  res.set('Cache-Control','no-store');res.json({meeting:m,participants,chat,attendance,recordings});
}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/online/meetings/instant',auth(ONLINE_CREATOR_ROLES),async(req,res)=>{try{
  const b=req.body||{};
  const title=String(b.title||`Instant Meeting - ${req.user.full_name}`).trim();
  const kind=String(b.meeting_kind||'meeting').toLowerCase()==='class'?'class':'meeting';
  const className=b.class_name?String(b.class_name).trim():null;
  const subjectId=b.subject_id?Number(b.subject_id):null;
  if(req.user.role==='teacher'||req.user.role==='ustadh'){
    if(kind==='class' && className && subjectId && !(await hasSubjectAssignment(req.user.id,subjectId,className)))return res.status(403).json({error:'You can only teach an assigned subject and class'});
  }
  const room=onlineRoomCode();
  const r=await pool.query(`INSERT INTO online_meetings(title,description,meeting_kind,host_user_id,subject_id,class_name,scheduled_start,actual_start,status,room_code,provider,recording_enabled,chat_enabled,waiting_room_enabled) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW(),'live',$7,'jitsi',$8,TRUE,FALSE) RETURNING *`,[title,b.description||'Instant school meeting',kind,req.user.id,subjectId,className,room,!!b.recording_enabled]);
  const meeting=r.rows[0];
  await pool.query(`INSERT INTO online_participants(meeting_id,user_id,role,invitation_status) VALUES($1,$2,'host','accepted') ON CONFLICT DO NOTHING`,[meeting.id,req.user.id]);
  if(className) await pool.query(`INSERT INTO online_participants(meeting_id,user_id,role) SELECT $1,user_id,'student' FROM students WHERE user_id IS NOT NULL AND LOWER(TRIM(class_name))=LOWER(TRIM($2)) ON CONFLICT DO NOTHING`,[meeting.id,className]);
  await onlineSeedAttendance(meeting.id);
  await audit(req.user.id,'START_INSTANT_ONLINE_MEETING',`meeting=${meeting.id};room=${room}`);
  res.status(201).json(meeting);
}catch(e){res.status(400).json({error:e.message})}});

app.post('/api/online/meetings',auth(ONLINE_CREATOR_ROLES),async(req,res)=>{try{
  const b=req.body||{}, title=String(b.title||'').trim(), kind=String(b.meeting_kind||'class').toLowerCase();
  if(!title||!b.scheduled_start)return res.status(400).json({error:'Title and start time are required'});
  if(!['class','meeting'].includes(kind))return res.status(400).json({error:'Invalid meeting type'});
  let className=b.class_name?String(b.class_name).trim():null, subjectId=b.subject_id?Number(b.subject_id):null;
  if(req.user.role==='teacher'||req.user.role==='ustadh'){
    if(kind==='class' && (!className||!subjectId))return res.status(400).json({error:'Select the assigned class and subject'});
    if(kind==='class' && !(await hasSubjectAssignment(req.user.id,subjectId,className)))return res.status(403).json({error:'You can only teach an assigned subject and class'});
  }
  const room=onlineRoomCode();
  const r=await pool.query(`INSERT INTO online_meetings(title,description,meeting_kind,host_user_id,subject_id,class_name,scheduled_start,scheduled_end,status,room_code,provider,recording_enabled,chat_enabled,waiting_room_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9,'jitsi',$10,$11,$12) RETURNING *`,[title,b.description||null,kind,req.user.id,subjectId,className,b.scheduled_start,b.scheduled_end||null,room,!!b.recording_enabled,b.chat_enabled!==false,!!b.waiting_room_enabled]);
  const meeting=r.rows[0];
  // Host is always a participant. For classes, all learners in the class are invited.
  await pool.query(`INSERT INTO online_participants(meeting_id,user_id,role,invitation_status) VALUES($1,$2,'host','accepted') ON CONFLICT DO NOTHING`,[meeting.id,req.user.id]);
  if(className) await pool.query(`INSERT INTO online_participants(meeting_id,user_id,role) SELECT $1,user_id,'student' FROM students WHERE user_id IS NOT NULL AND LOWER(TRIM(class_name))=LOWER(TRIM($2)) ON CONFLICT DO NOTHING`,[meeting.id,className]);
  const ids=Array.isArray(b.participant_user_ids)?b.participant_user_ids.map(Number).filter(Number.isInteger):[];
  if(ids.length) await pool.query(`INSERT INTO online_participants(meeting_id,user_id,role) SELECT $1,id,role FROM users WHERE id=ANY($2::int[]) ON CONFLICT DO NOTHING`,[meeting.id,ids]);
  if(b.audience_role && ['teacher','ustadh','patron','student','parent','worker','secretary'].includes(String(b.audience_role))) await pool.query(`INSERT INTO online_participants(meeting_id,user_id,role) SELECT $1,id,role FROM users WHERE active=true AND role=$2 ON CONFLICT DO NOTHING`,[meeting.id,String(b.audience_role)]);
  await onlineSeedAttendance(meeting.id); await audit(req.user.id,'CREATE_ONLINE_MEETING',`meeting=${meeting.id};room=${room}`);
  res.status(201).json(meeting);
}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/online/meetings/:id/start',auth(ONLINE_CREATOR_ROLES),async(req,res)=>{try{
  const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m||Number(m.host_user_id)!==Number(req.user.id)&&!ONLINE_MANAGER_ROLES.includes(req.user.role))return res.status(403).json({error:'Only the host or management can start this meeting'});
  const r=await pool.query(`UPDATE online_meetings SET status='live',actual_start=COALESCE(actual_start,NOW()),updated_at=NOW() WHERE id=$1 AND status IN ('scheduled','live') RETURNING *`,[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Meeting not found or already closed'});await audit(req.user.id,'START_ONLINE_MEETING',`meeting=${req.params.id}`);res.json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/online/meetings/:id/end',auth(ONLINE_CREATOR_ROLES),async(req,res)=>{try{
  const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m||Number(m.host_user_id)!==Number(req.user.id)&&!ONLINE_MANAGER_ROLES.includes(req.user.role))return res.status(403).json({error:'Only the host or management can end this meeting'});
  const r=await pool.query(`UPDATE online_meetings SET status='completed',actual_end=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('scheduled','live') RETURNING *`,[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Meeting not found or already closed'});await pool.query(`UPDATE online_sessions SET left_at=COALESCE(left_at,NOW()),connection_status='closed' WHERE meeting_id=$1 AND left_at IS NULL`,[req.params.id]);await audit(req.user.id,'END_ONLINE_MEETING',`meeting=${req.params.id}`);res.json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/online/meetings/:id/cancel',auth(ONLINE_CREATOR_ROLES),async(req,res)=>{try{
  const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m||Number(m.host_user_id)!==Number(req.user.id)&&!ONLINE_MANAGER_ROLES.includes(req.user.role))return res.status(403).json({error:'Only the host or management can cancel this meeting'});
  const r=await pool.query(`UPDATE online_meetings SET status='cancelled',updated_at=NOW() WHERE id=$1 AND status='scheduled' RETURNING *`,[req.params.id]);if(!r.rows[0])return res.status(404).json({error:'Only scheduled meetings can be cancelled'});res.json(r.rows[0]);
}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/online/meetings/:id/join',auth(),async(req,res)=>{try{
  const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m)return res.status(403).json({error:'You are not invited to this meeting'});
  if(m.status==='cancelled'||m.status==='completed')return res.status(400).json({error:'This meeting is no longer live'});
  if(m.status==='scheduled' && Number(m.host_user_id)===Number(req.user.id)) await pool.query(`UPDATE online_meetings SET status='live',actual_start=COALESCE(actual_start,NOW()),updated_at=NOW() WHERE id=$1`,[m.id]);
  await pool.query(`UPDATE online_participants SET joined_at=COALESCE(joined_at,NOW()),left_at=NULL,invitation_status='accepted' WHERE meeting_id=$1 AND user_id=$2`,[m.id,req.user.id]);
  const s=await pool.query(`INSERT INTO online_sessions(meeting_id,user_id) VALUES($1,$2) RETURNING id,joined_at`,[m.id,req.user.id]);
  if(req.user.role==='student'){const st=(await pool.query(`SELECT id FROM students WHERE user_id=$1`,[req.user.id])).rows[0];if(st)await pool.query(`UPDATE online_attendance SET status='present',first_joined_at=COALESCE(first_joined_at,NOW()),marked_at=NOW() WHERE meeting_id=$1 AND student_id=$2`,[m.id,st.id]);}
  res.json({meetingId:m.id,roomCode:m.room_code,provider:m.provider,sessionId:s.rows[0].id});
}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/online/meetings/:id/leave',auth(),async(req,res)=>{try{
  const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m)return res.status(403).json({error:'Not authorized'});const sessionId=req.body?.session_id?Number(req.body.session_id):null;
  let r;if(sessionId) r=await pool.query(`UPDATE online_sessions SET left_at=COALESCE(left_at,NOW()),connection_status='closed' WHERE id=$1 AND meeting_id=$2 AND user_id=$3 RETURNING *`,[sessionId,m.id,req.user.id]); else r=await pool.query(`UPDATE online_sessions SET left_at=COALESCE(left_at,NOW()),connection_status='closed' WHERE meeting_id=$1 AND user_id=$2 AND left_at IS NULL RETURNING *`,[m.id,req.user.id]);
  await pool.query(`UPDATE online_participants SET left_at=NOW() WHERE meeting_id=$1 AND user_id=$2`,[m.id,req.user.id]);
  if(req.user.role==='student'){const st=(await pool.query(`SELECT id FROM students WHERE user_id=$1`,[req.user.id])).rows[0];if(st){const a=(await pool.query(`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(left_at,NOW())-joined_at)),0)::int seconds FROM online_sessions WHERE meeting_id=$1 AND user_id=$2`,[m.id,req.user.id])).rows[0];await pool.query(`UPDATE online_attendance SET last_left_at=NOW(),total_duration_seconds=$3,status=CASE WHEN $3>=1800 THEN 'present' WHEN $3>0 THEN 'partial' ELSE status END WHERE meeting_id=$1 AND student_id=$2`,[m.id,st.id,Number(a.seconds||0)]);}}
  res.json({ok:true});
}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/online/meetings/:id/chat',auth(),async(req,res)=>{try{const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m)return res.status(403).json({error:'Not authorized'});const message=String(req.body?.message||'').trim();if(!message)return res.status(400).json({error:'Message is required'});if(m.chat_enabled===false)return res.status(400).json({error:'Chat is disabled'});const r=await pool.query(`INSERT INTO online_chat(meeting_id,sender_user_id,message) VALUES($1,$2,$3) RETURNING id,created_at`,[m.id,req.user.id,message]);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.patch('/api/online/meetings/:id/attendance/:studentId',auth(ONLINE_CREATOR_ROLES),async(req,res)=>{try{const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m||Number(m.host_user_id)!==Number(req.user.id)&&!ONLINE_MANAGER_ROLES.includes(req.user.role))return res.status(403).json({error:'Not authorized'});const status=['present','late','partial','absent'].includes(req.body?.status)?req.body.status:'absent';const r=await pool.query(`UPDATE online_attendance SET status=$1,marked_by=$2,marked_at=NOW(),notes=$3 WHERE meeting_id=$4 AND student_id=$5 RETURNING *`,[status,req.user.id,req.body?.notes||null,m.id,req.params.studentId]);if(!r.rows[0])return res.status(404).json({error:'Attendance record not found'});res.json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});
app.post('/api/online/meetings/:id/recordings',auth(ONLINE_CREATOR_ROLES),async(req,res)=>{try{const m=await onlineCanAccessMeeting(req.params.id,req.user);if(!m||Number(m.host_user_id)!==Number(req.user.id)&&!ONLINE_MANAGER_ROLES.includes(req.user.role))return res.status(403).json({error:'Not authorized'});const url=String(req.body?.recording_url||'').trim();if(!url)return res.status(400).json({error:'Recording URL is required'});const r=await pool.query(`INSERT INTO online_recordings(meeting_id,recording_url,provider,duration_seconds,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[m.id,url,req.body?.provider||m.provider,Number(req.body?.duration_seconds||0)||null,req.user.id]);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({error:e.message})}});

app.get("*",(req,res)=>{if(req.path.startsWith("/api/"))return res.status(404).json({error:"API endpoint not found"});const indexPath=path.join(PUBLIC_DIR,"index.html");if(!fs.existsSync(indexPath))return res.status(500).send("Application files are incomplete: public/index.html was not found. Deploy the project root containing public/ and database/.");res.sendFile(indexPath)});

async function ensureLegacyTimestampCompatibility(){
  // Surgical legacy migration: only add timestamp columns that the current schema/application expects.
  // Existing rows are preserved; PostgreSQL fills newly-added timestamp columns from their DEFAULT.
  const tablesWithCreatedAt=['users','students','subjects','exams','marks','fee_records','fee_charges','announcements','assets','expenditures','system_settings','fee_settings','audit_logs','teacher_assignments','communications','boarding_profiles','boarding_attendance','boarding_incidents','whatsapp_pending_notifications','whatsapp_communication_settings','approval_notifications','whatsapp_delivery_log','online_meetings','online_participants','online_sessions','online_chat','online_recordings','local_subscription_status','payroll_profiles','payroll_periods','payroll_entries','expenditure_requests','exam_bank','exam_resources','resource_purchases','leave_requests','staff_attendance','syllabus_coverage_reports','student_subject_reports','student_subject_report_strands','tafhid_groups','tafhid_group_learners','tafhid_assessments'];
  for(const table of tablesWithCreatedAt){
    try{
      await pool.query(`DO $migration$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(); END IF; END $migration$;`);
    }catch(e){console.warn(`Legacy timestamp migration warning (${table}):`,e.message)}
  }
  // Only these tables have updated_at in the current schema and application.
  const tablesWithUpdatedAt=['users','students','subjects','exams','marks','assets','system_settings','fee_settings','communications','boarding_profiles','boarding_attendance','boarding_incidents','online_meetings','online_chat','local_subscription_status','payroll_profiles','payroll_periods','payroll_entries','expenditure_requests','exam_bank','exam_resources','resource_purchases','leave_requests','staff_attendance','syllabus_coverage_reports','student_subject_reports','tafhid_assessments'];
  for(const table of tablesWithUpdatedAt){
    try{
      await pool.query(`DO $migration$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW(); END IF; END $migration$;`);
    }catch(e){console.warn(`Legacy updated_at migration warning (${table}):`,e.message)}
  }
}

async function init(options={}){const tenantPool=options.tenantPool||defaultPool;const createAdmin=options.createAdmin!==false;return tenantALS.run({pool:tenantPool,schoolId:options.schoolId||null,school:options.school||null},async()=>{if(!process.env.DATABASE_URL){console.warn("DATABASE_URL is not set");if(options.throwOnError)throw new Error("DATABASE_URL is required");return}try{await ensureLegacyTimestampCompatibility();await ensureLegacyCompatibility();const schemaPath=fs.existsSync(path.join(DATABASE_DIR,"schema.sql"))?path.join(DATABASE_DIR,"schema.sql"):path.join(__dirname,"schema.sql");let schema=fs.readFileSync(schemaPath,"utf8");
// Run schema statements independently so one legacy index/constraint cannot prevent later compatibility upgrades.
for(const statement of schema.split(/;\s*(?=\n|$)/).map(x=>x.trim()).filter(Boolean)){try{await pool.query(statement)}catch(e){console.warn("Schema statement warning:",e.message)}}
const migrations=[
"ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_category TEXT",
// Legacy databases may still have the old users_role_check constraint which rejects the new Ustadh role.
"ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check",
"ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','director','principal','secretary','teacher','ustadh','patron','student','parent','worker')) NOT VALID",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS class_name TEXT",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS stream TEXT",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_name TEXT",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_phone TEXT",
"ALTER TABLE resource_purchases ADD COLUMN IF NOT EXISTS payer_phone TEXT",
"ALTER TABLE resource_purchases ADD COLUMN IF NOT EXISTS payment_details TEXT",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS user_id INT",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS gender TEXT",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS date_of_birth DATE",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS birth_certificate_number TEXT",
"ALTER TABLE students ADD COLUMN IF NOT EXISTS assessment_number TEXT",
"CREATE TABLE IF NOT EXISTS online_meetings(id SERIAL PRIMARY KEY,title TEXT NOT NULL,description TEXT,meeting_kind TEXT NOT NULL DEFAULT 'class' CHECK(meeting_kind IN ('class','meeting')),host_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,subject_id INT REFERENCES subjects(id) ON DELETE SET NULL,class_name TEXT,scheduled_start TIMESTAMP NOT NULL,scheduled_end TIMESTAMP,actual_start TIMESTAMP,actual_end TIMESTAMP,status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','completed','cancelled')),room_code TEXT NOT NULL UNIQUE,provider TEXT NOT NULL DEFAULT 'jitsi',recording_enabled BOOLEAN NOT NULL DEFAULT FALSE,chat_enabled BOOLEAN NOT NULL DEFAULT TRUE,waiting_room_enabled BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS idx_online_meetings_start ON online_meetings(scheduled_start,status)",
"CREATE INDEX IF NOT EXISTS idx_online_meetings_host ON online_meetings(host_user_id,scheduled_start)",
"CREATE TABLE IF NOT EXISTS online_participants(id SERIAL PRIMARY KEY,meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'participant',invitation_status TEXT NOT NULL DEFAULT 'invited' CHECK(invitation_status IN ('invited','accepted','declined')),joined_at TIMESTAMP,left_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(meeting_id,user_id))",
"CREATE INDEX IF NOT EXISTS idx_online_participants_user ON online_participants(user_id,meeting_id)",
"CREATE TABLE IF NOT EXISTS online_sessions(id SERIAL PRIMARY KEY,meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,joined_at TIMESTAMP NOT NULL DEFAULT NOW(),left_at TIMESTAMP,connection_status TEXT NOT NULL DEFAULT 'connected')",
"CREATE INDEX IF NOT EXISTS idx_online_sessions_meeting ON online_sessions(meeting_id,joined_at)",
"CREATE TABLE IF NOT EXISTS online_chat(id SERIAL PRIMARY KEY,meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,sender_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,message TEXT NOT NULL,created_at TIMESTAMP DEFAULT NOW(),deleted_at TIMESTAMP)",
"CREATE INDEX IF NOT EXISTS idx_online_chat_meeting ON online_chat(meeting_id,created_at)",
"CREATE TABLE IF NOT EXISTS online_attendance(id SERIAL PRIMARY KEY,meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'absent' CHECK(status IN ('present','late','partial','absent')),first_joined_at TIMESTAMP,last_left_at TIMESTAMP,total_duration_seconds INT NOT NULL DEFAULT 0,marked_by INT REFERENCES users(id) ON DELETE SET NULL,marked_at TIMESTAMP,notes TEXT,UNIQUE(meeting_id,student_id))",
"CREATE INDEX IF NOT EXISTS idx_online_attendance_meeting ON online_attendance(meeting_id)",
"CREATE TABLE IF NOT EXISTS online_recordings(id SERIAL PRIMARY KEY,meeting_id INT NOT NULL REFERENCES online_meetings(id) ON DELETE CASCADE,recording_url TEXT NOT NULL,provider TEXT NOT NULL DEFAULT 'jitsi',duration_seconds INT,created_by INT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMP DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS idx_online_recordings_meeting ON online_recordings(meeting_id)",
"CREATE TABLE IF NOT EXISTS local_subscription_status(id INT PRIMARY KEY DEFAULT 1,status TEXT NOT NULL DEFAULT 'unconfigured',plan TEXT,valid_until TIMESTAMP,grace_until TIMESTAMP,features JSONB NOT NULL DEFAULT '{}'::jsonb,last_sync TIMESTAMP,updated_at TIMESTAMP DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_local_subscription_valid_until ON local_subscription_status(valid_until)",
"CREATE TABLE IF NOT EXISTS system_settings(setting_key TEXT PRIMARY KEY,value TEXT NOT NULL)","CREATE TABLE IF NOT EXISTS school_calendar(id SERIAL PRIMARY KEY,title TEXT NOT NULL,event_date DATE NOT NULL,start_time TIME,end_time TIME,category TEXT NOT NULL DEFAULT 'School Activity',location TEXT,description TEXT,created_by INT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())","CREATE INDEX IF NOT EXISTS idx_school_calendar_date ON school_calendar(event_date)","INSERT INTO system_settings(setting_key,value) VALUES('operation_mode','demo') ON CONFLICT(setting_key) DO NOTHING","CREATE TABLE IF NOT EXISTS audit_logs(id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id),action TEXT NOT NULL,details TEXT,created_at TIMESTAMP DEFAULT NOW())","CREATE TABLE IF NOT EXISTS payroll_profiles(staff_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,house_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,transport_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,other_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,tax_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,pension_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,other_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,bank_name TEXT,account_number TEXT,updated_at TIMESTAMP DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS payroll_periods(id SERIAL PRIMARY KEY,payroll_year INT NOT NULL,payroll_month INT NOT NULL CHECK(payroll_month BETWEEN 1 AND 12),status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','paid','cancelled')),processed_by INT REFERENCES users(id),approved_by INT REFERENCES users(id),approved_at TIMESTAMP,paid_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),director_note TEXT,UNIQUE(payroll_year,payroll_month))",
"ALTER TABLE payroll_periods DROP CONSTRAINT IF EXISTS payroll_periods_status_check",
"ALTER TABLE payroll_periods ADD CONSTRAINT payroll_periods_status_check CHECK(status IN ('draft','submitted','approved','rejected','paid','cancelled'))","ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS director_note TEXT",
"CREATE TABLE IF NOT EXISTS payroll_entries(id SERIAL PRIMARY KEY,period_id INT NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,staff_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,basic_salary NUMERIC(12,2) NOT NULL DEFAULT 0,house_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,transport_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,other_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,tax_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,pension_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,other_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,gross_pay NUMERIC(12,2) NOT NULL DEFAULT 0,total_deductions NUMERIC(12,2) NOT NULL DEFAULT 0,net_pay NUMERIC(12,2) NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','paid')),notes TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),UNIQUE(period_id,staff_id))",
"CREATE TABLE IF NOT EXISTS communications(id SERIAL PRIMARY KEY,title TEXT NOT NULL,message TEXT NOT NULL,audience_type TEXT NOT NULL DEFAULT 'all',audience_value TEXT,created_by INT REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMP DEFAULT NOW())",
"ALTER TABLE communications ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'all'",
"ALTER TABLE communications ADD COLUMN IF NOT EXISTS audience_value TEXT","ALTER TABLE communications ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL","ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS period_type TEXT DEFAULT 'monthly'","ALTER TABLE fee_charges ADD COLUMN IF NOT EXISTS fee_month TEXT","ALTER TABLE expenditures ADD COLUMN IF NOT EXISTS expenditure_request_id INT REFERENCES expenditure_requests(id) ON DELETE SET NULL",
"CREATE INDEX IF NOT EXISTS idx_payroll_entries_period ON payroll_entries(period_id)",
"CREATE TABLE IF NOT EXISTS fee_settings(setting_key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '')",
"ALTER TABLE fee_settings ADD COLUMN IF NOT EXISTS value TEXT NOT NULL DEFAULT ''",
"CREATE TABLE IF NOT EXISTS teacher_assignments(id SERIAL PRIMARY KEY,teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,subject_id INT REFERENCES subjects(id) ON DELETE CASCADE,class_name TEXT NOT NULL,assignment_type TEXT NOT NULL DEFAULT 'subject' CHECK (assignment_type IN ('subject','class_teacher')),created_at TIMESTAMP DEFAULT NOW(),UNIQUE(teacher_id,subject_id,class_name,assignment_type))",
"ALTER TABLE teacher_assignments ADD COLUMN IF NOT EXISTS teacher_id INT",
"ALTER TABLE teacher_assignments ADD COLUMN IF NOT EXISTS subject_id INT",
"ALTER TABLE teacher_assignments ADD COLUMN IF NOT EXISTS class_name TEXT",
"ALTER TABLE teacher_assignments ADD COLUMN IF NOT EXISTS assignment_type TEXT DEFAULT 'subject'",
"UPDATE teacher_assignments SET assignment_type=CASE WHEN subject_id IS NULL THEN 'class_teacher' ELSE 'subject' END WHERE assignment_type IS NULL OR TRIM(assignment_type)=''",
"ALTER TABLE teacher_assignments ALTER COLUMN assignment_type SET DEFAULT 'subject'",
"UPDATE teacher_assignments SET assignment_type='subject' WHERE assignment_type IS NULL",
"CREATE TABLE IF NOT EXISTS exam_bank(id SERIAL PRIMARY KEY,subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,class_name TEXT NOT NULL,term TEXT,topic TEXT,question_type TEXT NOT NULL DEFAULT 'Short Answer',question_text TEXT NOT NULL,option_a TEXT,option_b TEXT,option_c TEXT,option_d TEXT,answer TEXT,marks NUMERIC DEFAULT 1,created_by INT REFERENCES users(id),created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS exam_resources(id SERIAL PRIMARY KEY,title TEXT NOT NULL,description TEXT,subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,class_name TEXT NOT NULL,term TEXT,academic_year INT,original_filename TEXT NOT NULL,mime_type TEXT NOT NULL,file_data BYTEA NOT NULL,file_size INT NOT NULL,uploaded_by INT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),reviewed_by INT REFERENCES users(id),reviewed_at TIMESTAMP,review_note TEXT,price NUMERIC(10,2) NOT NULL DEFAULT 100,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS idx_exam_resources_scope ON exam_resources(subject_id,class_name,status)",
"CREATE TABLE IF NOT EXISTS resource_purchases(id SERIAL PRIMARY KEY,resource_id INT NOT NULL REFERENCES exam_resources(id) ON DELETE CASCADE,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,amount NUMERIC(10,2) NOT NULL DEFAULT 100,payment_method TEXT,reference TEXT,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','rejected')),reviewed_by INT REFERENCES users(id),reviewed_at TIMESTAMP,review_note TEXT,paid_at TIMESTAMP,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(resource_id,student_id))",
"CREATE INDEX IF NOT EXISTS idx_resource_purchases_status ON resource_purchases(status)",

"CREATE TABLE IF NOT EXISTS leave_requests(id SERIAL PRIMARY KEY,user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,leave_type TEXT NOT NULL DEFAULT 'Annual Leave',start_date DATE NOT NULL,end_date DATE NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),approved_by INT REFERENCES users(id),approved_at TIMESTAMP,director_note TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status)",
"CREATE TABLE IF NOT EXISTS staff_attendance(id SERIAL PRIMARY KEY,staff_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,attendance_date DATE NOT NULL,check_in TIMESTAMP,check_out TIMESTAMP,updated_at TIMESTAMP DEFAULT NOW(),UNIQUE(staff_id,attendance_date))",
"CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance(attendance_date)",
"CREATE TABLE IF NOT EXISTS expenditure_requests(id SERIAL PRIMARY KEY,category TEXT NOT NULL DEFAULT 'General',description TEXT NOT NULL,amount NUMERIC(12,2) NOT NULL,payment_method TEXT NOT NULL DEFAULT 'Cash',requested_date DATE DEFAULT CURRENT_DATE,requested_by INT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),reviewed_by INT REFERENCES users(id),reviewed_at TIMESTAMP,review_note TEXT,paid_at TIMESTAMP,payment_reference TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
"CREATE INDEX IF NOT EXISTS idx_expenditure_requests_status ON expenditure_requests(status)",
"CREATE TABLE IF NOT EXISTS syllabus_coverage_reports(id SERIAL PRIMARY KEY,subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,class_name TEXT NOT NULL,term TEXT NOT NULL,academic_year INT NOT NULL,coverage_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK(coverage_percent>=0 AND coverage_percent<=100),topics_covered TEXT,topics_pending TEXT,challenges TEXT,plans TEXT,resources_needed TEXT,target_completion_date DATE,teacher_comment TEXT,created_by INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),reviewed_by INT REFERENCES users(id),reviewed_at TIMESTAMP,review_note TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),UNIQUE(created_by,subject_id,class_name,term,academic_year))",
"CREATE INDEX IF NOT EXISTS idx_syllabus_coverage_reports_scope ON syllabus_coverage_reports(subject_id,class_name,academic_year,term)",
"CREATE INDEX IF NOT EXISTS idx_syllabus_coverage_reports_status ON syllabus_coverage_reports(status)",
"CREATE TABLE IF NOT EXISTS student_subject_reports(id SERIAL PRIMARY KEY,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,subject_id INT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,class_name TEXT NOT NULL,term TEXT NOT NULL,academic_year INT NOT NULL,strengths TEXT,weaknesses TEXT,recommended_intervention TEXT,general_comment TEXT,created_by INT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),reviewed_by INT REFERENCES users(id),reviewed_at TIMESTAMP,review_note TEXT,created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())",
"CREATE TABLE IF NOT EXISTS student_subject_report_strands(id SERIAL PRIMARY KEY,report_id INT NOT NULL REFERENCES student_subject_reports(id) ON DELETE CASCADE,strand TEXT NOT NULL,rating TEXT NOT NULL DEFAULT 'developing' CHECK(rating IN ('strength','developing','needs_support')),observation TEXT)",
"CREATE INDEX IF NOT EXISTS idx_student_subject_reports_student ON student_subject_reports(student_id,academic_year,term)",
"CREATE TABLE IF NOT EXISTS tafhid_groups(id SERIAL PRIMARY KEY,group_name TEXT NOT NULL,teacher_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,class_name TEXT,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(group_name,teacher_id))",
"CREATE TABLE IF NOT EXISTS tafhid_group_learners(id SERIAL PRIMARY KEY,group_id INT NOT NULL REFERENCES tafhid_groups(id) ON DELETE CASCADE,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,created_at TIMESTAMP DEFAULT NOW(),UNIQUE(group_id,student_id))",
"CREATE TABLE IF NOT EXISTS tafhid_assessments(id SERIAL PRIMARY KEY,group_id INT NOT NULL REFERENCES tafhid_groups(id) ON DELETE CASCADE,student_id INT NOT NULL REFERENCES students(id) ON DELETE CASCADE,assessment_type TEXT NOT NULL CHECK(assessment_type IN ('monthly','end_term')),period_label TEXT NOT NULL,academic_year INT NOT NULL,juzu TEXT,q1 NUMERIC(6,2) DEFAULT 0,q2 NUMERIC(6,2) DEFAULT 0,q3 NUMERIC(6,2) DEFAULT 0,q4 NUMERIC(6,2) DEFAULT 0,q5 NUMERIC(6,2) DEFAULT 0,tajweed NUMERIC(6,2) DEFAULT 0,total NUMERIC(8,2) DEFAULT 0,teacher_comment TEXT,entered_by INT NOT NULL REFERENCES users(id),created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW(),UNIQUE(group_id,student_id,assessment_type,period_label,academic_year))",
"CREATE INDEX IF NOT EXISTS idx_tafhid_groups_teacher ON tafhid_groups(teacher_id)",
"CREATE INDEX IF NOT EXISTS idx_tafhid_members_group ON tafhid_group_learners(group_id)",
"CREATE INDEX IF NOT EXISTS idx_tafhid_assessments_student ON tafhid_assessments(student_id,academic_year,assessment_type)",
"CREATE INDEX IF NOT EXISTS idx_tafhid_assessments_group ON tafhid_assessments(group_id,academic_year,assessment_type)"
];for(const sql of migrations){try{await pool.query(sql)}catch(e){console.warn("Migration warning:",e.message)}}const count=(await pool.query("SELECT COUNT(*)::int n FROM users")).rows[0].n;
if(count===0 && createAdmin){
  const initialPassword=process.env.INITIAL_ADMIN_PASSWORD;
  if(NODE_ENV==='production' && (!initialPassword || initialPassword.length<12))throw new Error('INITIAL_ADMIN_PASSWORD must be set to a strong password (12+ characters) before first production startup.');
  const password=initialPassword||'admin123';
  const hash=await bcrypt.hash(password,12);
  await pool.query("INSERT INTO users(username,password_hash,full_name,role) VALUES($1,$2,$3,$4)",[process.env.INITIAL_ADMIN_USERNAME||'admin',hash,process.env.INITIAL_ADMIN_NAME||'System Administrator','admin']);
  console.log('Initial admin created. Change the password immediately after first login.');
}
console.log("Database ready")}catch(e){console.error("Database initialization failed:",e.message);if(options.throwOnError)throw e}})}
async function runActiveTenantJobs(communicationsOnly=false){
  try{
    const schools=await platform.listActiveSchools();
    for(const school of schools){
      try{
        const tenantPool=await platform.getTenantPool(school);
        await tenantALS.run({pool:tenantPool,schoolId:school.school_id,school},async()=>{
          if(!communicationsOnly){try{const r=await pool.query("SELECT value FROM fee_settings WHERE setting_key='monthly_fee_amount' LIMIT 1");const amount=Number(r.rows[0]?.value||0);if(amount>0){const result=await applyMonthlyFeeCharges(amount);if(result.created)console.log(`${school.school_id}: ${result.created} monthly fee charge(s) for ${result.term}`)}}catch(e){console.warn(`Monthly fee check warning (${school.school_id}):`,e.message)}}
          try{await scanWhatsAppEvents()}catch(e){console.warn(`Communication scheduler warning (${school.school_id}):`,e.message)}
        });
      }catch(e){console.warn(`Tenant background job warning (${school.school_id}):`,e.message)}
    }
  }catch(e){console.warn('Tenant scheduler warning:',e.message)}
}
platform.ready.then(async()=>{
  app.listen(PORT,()=>console.log(`O'LIVE TECH School Platform running on port ${PORT}`));
  await runActiveTenantJobs();
  setInterval(runActiveTenantJobs,60*60*1000).unref?.();
  setInterval(()=>runActiveTenantJobs(true),60000).unref?.();
}).catch(e=>{console.error('Fatal platform database initialization error:',e.message);process.exit(1)});
