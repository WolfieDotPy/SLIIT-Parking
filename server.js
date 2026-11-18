'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const IS_POSTGRES = Boolean(process.env.DATABASE_URL);
const IS_VERCEL = Boolean(process.env.VERCEL);
const PORT = Number(process.env.PORT || 3000);
const PUB = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SECRET = process.env.JWT_SECRET || (IS_VERCEL ? '' : 'change-this-secret');
const MAX_SLIP_BYTES = 5 * 1024 * 1024;

if (IS_VERCEL && !IS_POSTGRES) {
  throw new Error('DATABASE_URL is required on Vercel; production must not fall back to local SQLite.');
}
if (IS_VERCEL && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required on Vercel.');
}
if (!SECRET) {
  throw new Error('JWT_SECRET must be configured before the server can start.');
}

let pool = null;
let sqlite = null;
let supabaseStorage = null;

if (IS_POSTGRES) {
  const { Pool, types } = require('pg');
  // Keep BIGINT identifiers usable by the existing browser UI, which compares ids numerically.
  types.setTypeParser(20, value => Number(value));
  types.setTypeParser(1700, value => Number(value));
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_SIZE || (IS_VERCEL ? 1 : 5)),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseStorage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    }).storage.from(process.env.SUPABASE_STORAGE_BUCKET || 'payment-slips');
  }
} else {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = process.env.SQLITE_PATH || path.join(__dirname, 'sliit-parking.db');
  sqlite = new DatabaseSync(dbFile);
  sqlite.exec('PRAGMA foreign_keys = ON');
}

function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function get(sql, params = [], conn = null) {
  if (IS_POSTGRES) {
    const result = await (conn || pool).query(toPgSql(sql), params);
    return result.rows[0] || null;
  }
  return (conn || sqlite).prepare(sql).get(...params) || null;
}

async function all(sql, params = [], conn = null) {
  if (IS_POSTGRES) {
    const result = await (conn || pool).query(toPgSql(sql), params);
    return result.rows;
  }
  return (conn || sqlite).prepare(sql).all(...params);
}

async function run(sql, params = [], conn = null) {
  if (IS_POSTGRES) {
    const result = await (conn || pool).query(toPgSql(sql), params);
    return { changes: result.rowCount || 0, rows: result.rows || [] };
  }
  const result = (conn || sqlite).prepare(sql).run(...params);
  return { changes: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid };
}

async function insert(sql, params = [], conn = null) {
  if (IS_POSTGRES) {
    const statement = /\bRETURNING\b/i.test(sql) ? sql : `${sql} RETURNING id`;
    const result = await (conn || pool).query(toPgSql(statement), params);
    return result.rows[0]?.id ?? null;
  }
  const result = sqlite.prepare(sql).run(...params);
  return Number(result.lastInsertRowid);
}

async function transaction(callback) {
  if (IS_POSTGRES) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await callback(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('[db] rollback failed', rollbackError); }
      throw error;
    } finally {
      client.release();
    }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const value = await callback(sqlite);
    sqlite.exec('COMMIT');
    return value;
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch (rollbackError) { console.error('[db] rollback failed', rollbackError); }
    throw error;
  }
}

async function initializeDatabase() {
  if (!IS_POSTGRES) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        role TEXT NOT NULL CHECK(role IN ('student','admin','enforcer')),
        code TEXT UNIQUE,
        name TEXT,
        contact TEXT,
        password_hash TEXT,
        qr_token TEXT UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS vehicles (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        reg_number TEXT NOT NULL UNIQUE,
        type TEXT
      );
      CREATE TABLE IF NOT EXISTS fees (
        id INTEGER PRIMARY KEY,
        vehicle_reg TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        enforcer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        start_time TEXT,
        end_time TEXT,
        hours INTEGER,
        amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('draft','unpaid','pending','paid')),
        reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('pass','fee')),
        fee_id INTEGER REFERENCES fees(id) ON DELETE SET NULL,
        vehicle_reg TEXT,
        vehicle_type TEXT,
        amount REAL NOT NULL,
        slip_file TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        reject_reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS passes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        start_date TEXT,
        end_date TEXT,
        payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS idx_fees_user_status ON fees(user_id,status);
      CREATE INDEX IF NOT EXISTS idx_fees_enforcer_status ON fees(enforcer_id,status);
      CREATE INDEX IF NOT EXISTS idx_payments_user_status ON payments(user_id,status);
      CREATE INDEX IF NOT EXISTS idx_passes_user_end ON passes(user_id,end_date);
    `);
  } else {
    // The production project already has these six tables. CREATE IF NOT EXISTS also makes
    // a fresh Supabase project bootable without changing existing tables or their data.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.users (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('student','admin','enforcer')),
        code TEXT UNIQUE, name TEXT, contact TEXT, password_hash TEXT,
        qr_token UUID UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.vehicles (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
        reg_number TEXT NOT NULL UNIQUE, type TEXT
      );
      CREATE TABLE IF NOT EXISTS public.fees (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        vehicle_reg TEXT NOT NULL,
        user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
        enforcer_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
        start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, hours INTEGER,
        amount NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('draft','unpaid','pending','paid')),
        reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.payments (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('pass','fee')),
        fee_id BIGINT REFERENCES public.fees(id) ON DELETE SET NULL,
        vehicle_reg TEXT, vehicle_type TEXT, amount NUMERIC NOT NULL,
        slip_file TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        reject_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS public.passes (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        start_date TIMESTAMPTZ, end_date TIMESTAMPTZ,
        payment_id BIGINT REFERENCES public.payments(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS public.settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS idx_fees_user_status ON public.fees(user_id,status);
      CREATE INDEX IF NOT EXISTS idx_fees_enforcer_status ON public.fees(enforcer_id,status);
      CREATE INDEX IF NOT EXISTS idx_payments_user_status ON public.payments(user_id,status);
      CREATE INDEX IF NOT EXISTS idx_passes_user_end ON public.passes(user_id,end_date);
    `);
  }

  const defaults = [
    ['hourly_rate', '100'],
    ['pass_price', '5000'],
    ['grace_minutes', '15'],
    ['plan_days', '365'],
    ['bank_info', 'Bank details not set yet - admin can add them in Settings.']
  ];
  for (const [key, value] of defaults) {
    await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING', [key, value]);
  }

  const admin = await get("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD || (IS_POSTGRES ? '' : 'admin123');
    if (!password) throw new Error('ADMIN_PASSWORD must be set before the first production deployment.');
    await insert(
      "INSERT INTO users(role,code,name,password_hash) VALUES('admin','ADMIN','Admin',?) ON CONFLICT(code) DO NOTHING",
      [bcrypt.hashSync(password, 10)]
    );
  }
}

const fail = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};

const ID_RE = /^[A-Z]{2}\d{8}$/;
const ID_MSG = 'Student ID must be 10 characters: 2 letters followed by 8 digits (e.g. IT26123567)';
const REG_RE = /^[A-Z0-9]{2,3}-\d{4}$/;
const REG_MSG = 'Vehicle number must be 2 or 3 letters/numbers, a dash, then 4 digits (e.g. CAB-1234 or KS-9467)';
const normReg = value => {
  const text = String(value || '').toUpperCase().replace(/\s/g, '');
  const match = text.match(/^([A-Z0-9]{2,3})-?(\d{4})$/);
  return match ? `${match[1]}-${match[2]}` : text;
};
const normalCode = value => String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
const dateOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail('Invalid date');
  return date.toISOString();
};

async function settings(conn = null) {
  const rows = await all('SELECT key,value FROM settings', [], conn);
  return {
    hourly_rate: '100', pass_price: '5000', grace_minutes: '15', plan_days: '365',
    bank_info: 'Bank details not set yet - admin can add them in Settings.',
    ...Object.fromEntries(rows.map(row => [row.key, row.value]))
  };
}

async function passOf(userId, conn = null) {
  const row = await get('SELECT MAX(end_date) AS expiry FROM passes WHERE user_id=?', [userId], conn);
  const expiry = row?.expiry || null;
  return expiry
    ? { status: new Date(expiry) >= new Date() ? 'ACTIVE' : 'EXPIRED', expiry }
    : { status: 'NONE', expiry: null };
}

async function profile(userId, conn = null) {
  const user = await get('SELECT code,name,contact FROM users WHERE id=?', [userId], conn);
  if (!user) return null;
  const vehicle = await get('SELECT reg_number AS reg,type FROM vehicles WHERE user_id=?', [userId], conn) || {};
  const overdue = await get(
    "SELECT COUNT(*)::int AS n,COALESCE(SUM(amount),0) AS total FROM fees WHERE user_id=? AND status='unpaid'".replace('COUNT(*)::int', IS_POSTGRES ? 'COUNT(*)::int' : 'COUNT(*)'),
    [userId], conn
  );
  return {
    code: user.code, name: user.name, contact: user.contact,
    reg: vehicle.reg || null, type: vehicle.type || null,
    ...await passOf(userId, conn),
    overdue: { n: Number(overdue?.n || 0), total: Number(overdue?.total || 0) }
  };
}

async function enforcerInfo(userId, conn = null) {
  const user = await get('SELECT code,name,contact FROM users WHERE id=?', [userId], conn);
  if (!user) return null;
  const row = await get("SELECT COUNT(*) AS n FROM fees WHERE enforcer_id=? AND status<>'draft'", [userId], conn);
  return { ...user, count: Number(row?.n || 0) };
}

const allowedMimes = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const fileExt = mime => mime === 'application/pdf' ? '.pdf' : mime === 'image/png' ? '.png' : '.jpg';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SLIP_BYTES },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimes.has(file.mimetype)) return callback(new Error('Only JPG, PNG and PDF files are accepted.'));
    callback(null, true);
  }
});

async function storeSlip(file) {
  if (!file) fail('Please upload your payment slip (JPG, PNG or PDF, max 5MB)');
  const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${fileExt(file.mimetype)}`;
  if (IS_POSTGRES) {
    if (!supabaseStorage) fail('Payment storage is not configured', 503);
    const { error } = await supabaseStorage.upload(key, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });
    if (error) {
      console.error('[storage] payment slip upload failed', error.message);
      fail('Could not save the payment slip. Please try again.', 503);
    }
    return key;
  }
  const localName = `${crypto.randomUUID()}${fileExt(file.mimetype)}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, localName), file.buffer, { flag: 'wx' });
  return localName;
}

async function removeSlip(key) {
  if (!key) return;
  try {
    if (IS_POSTGRES && supabaseStorage) await supabaseStorage.remove([key]);
    else if (!IS_POSTGRES) await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(key)));
  } catch (error) {
    console.warn('[storage] could not remove unused slip', error.message);
  }
}

async function sendSlip(req, res, role) {
  const payment = await get('SELECT slip_file,user_id FROM payments WHERE id=?', [req.params.id]);
  if (!payment || (role === 'student' && Number(payment.user_id) !== Number(req.user.id))) fail('Not found', 404);
  if (IS_POSTGRES) {
    if (!supabaseStorage || !payment.slip_file) fail('File not found', 404);
    const { data, error } = await supabaseStorage.download(payment.slip_file);
    if (error || !data) fail('File not found', 404);
    const buffer = Buffer.from(await data.arrayBuffer());
    const ext = path.extname(payment.slip_file).toLowerCase();
    res.setHeader('Content-Type', ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="payment-slip${ext}"`);
    return res.send(buffer);
  }
  const filePath = path.join(UPLOAD_DIR, path.basename(payment.slip_file || ''));
  if (!filePath.startsWith(`${UPLOAD_DIR}${path.sep}`) || !fs.existsSync(filePath)) fail('File not found', 404);
  return res.sendFile(filePath);
}

const wrap = handler => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    if (req._storedSlip) await removeSlip(req._storedSlip);
    if (res.headersSent) return next(error);
    const status = Number(error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500));
    if (status >= 500) console.error('[request]', req.method, req.path, error);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
  }
};

const auth = role => (req, res, next) => {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    req.user = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Please log in' });
  }
  if (req.user.role !== role) return res.status(403).json({ error: 'This account cannot use this portal' });
  next();
};
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// Shared initialization promise for warm Vercel Function instances.
let serverlessReady = null;

const parseHostList = (name, defaults) => new Set([
  ...defaults,
  ...String(process.env[name] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
]);
const STUDENT_HOSTS = parseHostList('STUDENT_PORTAL_HOSTS', [
  'sliit-parking-beta.vercel.app',
  'localhost', '127.0.0.1'
]);
const ADMIN_HOSTS = parseHostList('ADMIN_PORTAL_HOSTS', ['sliit-parking-admin.vercel.app']);
const ENFORCER_HOSTS = parseHostList('ENFORCER_PORTAL_HOSTS', ['sliit-parking-enforcer.vercel.app']);
if (process.env.VERCEL_URL) STUDENT_HOSTS.add(String(process.env.VERCEL_URL).split('://').pop().split('/')[0].toLowerCase());

function portalForHost(hostname) {
  const host = String(hostname || '').toLowerCase().split(':')[0];
  if (ADMIN_HOSTS.has(host)) return 'admin';
  if (ENFORCER_HOSTS.has(host)) return 'enforcer';
  if (STUDENT_HOSTS.has(host)) return 'student';
  return null;
}

const sharedPaths = new Set([
  '/style.css', '/common.js', '/logo.png', '/logo-uni.webp', '/favicon.ico', '/api/health', '/robots.txt'
]);
app.use((req, res, next) => {
  const requestPath = req.path || '/';
  const host = String(req.hostname || '').toLowerCase();

  // Local SQLite development keeps the original path-based three-portal workflow.
  // Hostname isolation is enforced on Vercel, where each portal has its own domain.
  if (!IS_VERCEL && (host === 'localhost' || host === '127.0.0.1')) {
    req.portal = requestPath.startsWith('/admin') || requestPath.startsWith('/api/admin/')
      ? 'admin'
      : requestPath.startsWith('/enforcer') || requestPath.startsWith('/api/enforcer/')
        ? 'enforcer'
        : 'student';
    if (requestPath === '/') return res.redirect(308, '/student/');
    return next();
  }

  const vercelPreviewHost = String(process.env.VERCEL_URL || '').split('://').pop().split('/')[0].toLowerCase();
  const isPreviewHost = Boolean(vercelPreviewHost && host === vercelPreviewHost);
  // On the unique Vercel preview hostname, expose each portal by its path so all three
  // can be reviewed before promotion. Production aliases remain strictly isolated by host.
  const portal = isPreviewHost
    ? (requestPath.startsWith('/admin') || requestPath.startsWith('/api/admin/') ? 'admin'
      : requestPath.startsWith('/enforcer') || requestPath.startsWith('/api/enforcer/') ? 'enforcer'
      : 'student')
    : portalForHost(host);
  if (!portal) return res.status(404).json({ error: 'Unknown portal domain' });
  req.portal = portal;
  if (requestPath === '/') return res.redirect(308, `/${portal}/`);
  if (sharedPaths.has(requestPath)) return next();
  const pageAllowed = requestPath === `/${portal}` || requestPath.startsWith(`/${portal}/`);
  const apiAllowed = requestPath === `/api/${portal}` || requestPath.startsWith(`/api/${portal}/`);
  if (!pageAllowed && !apiAllowed) return res.status(404).json({ error: 'This portal is not available on this domain' });
  next();
});

// Initialize once on the first API request in a Vercel Function instance. Host isolation
// runs first, so disallowed cross-portal requests never touch the database.
if (require.main !== module) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (!serverlessReady) {
      serverlessReady = initializeDatabase().catch(error => {
        serverlessReady = null; // allow a fresh attempt after a transient cold-start DB failure
        throw error;
      });
    }
    serverlessReady.then(() => next()).catch(next);
  });
}

// Vercel serves static files from public/ through its CDN; this middleware is also needed for local SQLite development.
app.use(express.static(PUB, { index: false, maxAge: IS_POSTGRES ? '1h' : 0 }));

// Vercel serves files under public/ directly through its CDN. Portal HTML deliberately lives
// outside public/ so this hostname gate also protects the page itself, not just its APIs.
const pages = {
  student: fs.readFileSync(path.join(__dirname, 'portal-pages', 'student.html'), 'utf8'),
  admin: fs.readFileSync(path.join(__dirname, 'portal-pages', 'admin.html'), 'utf8'),
  enforcer: fs.readFileSync(path.join(__dirname, 'portal-pages', 'enforcer.html'), 'utf8')
};
app.get('/student', (_req, res) => res.type('html').send(pages.student));
app.get('/admin', (_req, res) => res.type('html').send(pages.admin));
app.get('/enforcer', (_req, res) => res.type('html').send(pages.enforcer));
app.get('/student/', (_req, res) => res.type('html').send(pages.student));
app.get('/admin/', (_req, res) => res.type('html').send(pages.admin));
app.get('/enforcer/', (_req, res) => res.type('html').send(pages.enforcer));
app.get('/api/health', wrap(async (_req, res) => {
  await get('SELECT 1 AS ok');
  res.json({ ok: true, database: IS_POSTGRES ? 'connected' : 'sqlite-connected', storage: IS_POSTGRES ? (supabaseStorage ? 'configured' : 'missing') : 'local-filesystem' });
}));

// ---------- Login (each endpoint only authenticates its own account role)
const login = role => wrap(async (req, res) => {
  const code = role === 'admin' ? 'ADMIN' : normalCode(req.body.code);
  const user = await get('SELECT * FROM users WHERE role=? AND code=?', [role, code]);
  if (!user || !await bcrypt.compare(String(req.body.password || ''), user.password_hash || '')) {
    fail(role === 'admin' ? 'Wrong password' : 'Wrong ID or password', 401);
  }
  res.json({ token: jwt.sign({ id: user.id, role }, SECRET, { expiresIn: '12h' }), name: user.name });
});
['student', 'admin', 'enforcer'].forEach(role => app.post(`/api/${role}/login`, login(role)));

// ---------- Student
app.get('/api/student/info', wrap(async (_req, res) => {
  const current = await settings();
  res.json({ pass_price: current.pass_price, bank_info: current.bank_info, plan_days: current.plan_days });
}));

app.post('/api/student/register', upload.single('slip'), wrap(async (req, res) => {
  const body = req.body || {};
  const code = normalCode(body.code);
  const reg = normReg(body.vehicle_reg);
  if (!ID_RE.test(code)) fail(ID_MSG);
  if (!String(body.name || '').trim() || !String(body.contact || '').trim() || !reg || !body.vehicle_type) fail('Please fill in every field');
  if (!REG_RE.test(reg)) fail(REG_MSG);
  if (String(body.password || '').length < 6) fail('Password must be at least 6 characters');
  if (body.password !== body.confirm) fail('Passwords do not match');

  const slipKey = req.file ? await storeSlip(req.file) : null;
  req._storedSlip = slipKey;
  await transaction(async conn => {
    if (await get('SELECT 1 FROM users WHERE code=?', [code], conn)) fail('This student number is already registered');
    if (await get('SELECT 1 FROM vehicles WHERE reg_number=?', [reg], conn)) fail('This vehicle number is already registered');
    const userId = await insert(
      "INSERT INTO users(role,code,name,contact,password_hash,qr_token) VALUES('student',?,?,?,?,?)",
      [code, String(body.name).trim(), String(body.contact).trim(), bcrypt.hashSync(body.password, 10), crypto.randomUUID()], conn
    );
    await insert('INSERT INTO vehicles(user_id,reg_number,type) VALUES(?,?,?)', [userId, reg, body.vehicle_type], conn);
    if (slipKey) {
      const current = await settings(conn);
      await insert(
        "INSERT INTO payments(user_id,kind,vehicle_reg,vehicle_type,amount,slip_file) VALUES(?,'pass',?,?,?,?)",
        [userId, reg, body.vehicle_type, Number(current.pass_price), slipKey], conn
      );
    }
  });
  req._storedSlip = null;
  res.json({ ok: true });
}));
app.get('/api/student/me', auth('student'), wrap(async (req, res) => {
  const data = await profile(req.user.id);
  const pending = await get("SELECT 1 FROM payments WHERE user_id=? AND kind='pass' AND status='pending' LIMIT 1", [req.user.id]);
  const lastPass = await get("SELECT status,reject_reason FROM payments WHERE user_id=? AND kind='pass' ORDER BY id DESC LIMIT 1", [req.user.id]);
  res.json({ ...data, pendingPass: Boolean(pending), lastPass: lastPass || null });
}));

app.get('/api/student/qr', auth('student'), wrap(async (req, res) => {
  const user = await get('SELECT qr_token FROM users WHERE id=? AND role=\'student\'', [req.user.id]);
  if (!user?.qr_token) fail('QR code is not available', 404);
  const qr = await QRCode.toDataURL(String(user.qr_token), {
    width: 900, margin: 0, errorCorrectionLevel: 'H',
    color: { dark: '#1a1f3a', light: '#00000000' }
  });
  res.json({ qr });
}));

app.get('/api/student/payments', auth('student'), wrap(async (req, res) => {
  res.json(await all('SELECT id,kind,vehicle_reg,amount,status,reject_reason,created_at FROM payments WHERE user_id=? ORDER BY id DESC', [req.user.id]));
}));
app.get('/api/student/fees', auth('student'), wrap(async (req, res) => {
  res.json(await all("SELECT id,vehicle_reg,amount,end_time FROM fees WHERE user_id=? AND status='unpaid' ORDER BY id DESC", [req.user.id]));
}));
app.get('/api/student/fees/lookup', auth('student'), wrap(async (req, res) => {
  res.json(await all(
    "SELECT id,vehicle_reg,amount,end_time FROM fees WHERE vehicle_reg=? AND status='unpaid' AND (user_id IS NULL OR user_id=?) ORDER BY id DESC",
    [normReg(req.query.reg), req.user.id]
  ));
}));

app.post('/api/student/pay', auth('student'), upload.single('slip'), wrap(async (req, res) => {
  const body = req.body || {};
  const slipKey = await storeSlip(req.file);
  req._storedSlip = slipKey;
  await transaction(async conn => {
    if (body.kind === 'fee') {
      const fee = await get("SELECT * FROM fees WHERE id=? AND status='unpaid'", [body.fee_id], conn);
      if (!fee || (fee.user_id && Number(fee.user_id) !== Number(req.user.id))) fail('Fee not found or already paid');
      await insert(
        "INSERT INTO payments(user_id,kind,fee_id,vehicle_reg,amount,slip_file) VALUES(?,'fee',?,?,?,?)",
        [req.user.id, fee.id, fee.vehicle_reg, fee.amount, slipKey], conn
      );
      await run("UPDATE fees SET status='pending' WHERE id=?", [fee.id], conn);
    } else if (body.kind === 'pass') {
      const reg = normReg(body.vehicle_reg);
      if (!reg || !body.vehicle_type) fail('Vehicle number and type are required');
      if (!REG_RE.test(reg)) fail(REG_MSG);
      if (await get("SELECT 1 FROM payments WHERE user_id=? AND kind='pass' AND status='pending' LIMIT 1", [req.user.id], conn)) {
        fail('Your previous pass payment is still awaiting verification');
      }
      if (await get('SELECT 1 FROM vehicles WHERE reg_number=? AND user_id<>?', [reg, req.user.id], conn)) {
        fail('That vehicle number belongs to another student');
      }
      const current = await settings(conn);
      await insert(
        "INSERT INTO payments(user_id,kind,vehicle_reg,vehicle_type,amount,slip_file) VALUES(?,'pass',?,?,?,?)",
        [req.user.id, reg, body.vehicle_type, Number(current.pass_price), slipKey], conn
      );
    } else {
      fail('Invalid payment type');
    }
  });
  req._storedSlip = null;
  res.json({ ok: true });
}));
app.get('/api/student/slip/:id', auth('student'), wrap((req, res) => sendSlip(req, res, 'student')));

// ---------- Admin: payment verification and management
async function paymentRow(payment, conn = null) {
  const fee = payment.fee_id ? await get('SELECT enforcer_id FROM fees WHERE id=?', [payment.fee_id], conn) : null;
  return {
    ...payment,
    slip_file: undefined,
    student: await profile(payment.user_id, conn),
    enforcer: fee?.enforcer_id ? await enforcerInfo(fee.enforcer_id, conn) : null
  };
}

app.get('/api/admin/payments', auth('admin'), wrap(async (req, res) => {
  const history = req.query.view === 'history';
  const kind = ['fee', 'pass'].includes(req.query.kind) ? req.query.kind : null;
  let sql = `SELECT * FROM payments WHERE status ${history ? '<>' : '='} 'pending'`;
  const args = [];
  if (kind) { sql += ' AND kind=?'; args.push(kind); }
  const rows = await all(`${sql} ORDER BY id DESC`, args);
  res.json(await Promise.all(rows.map(row => paymentRow(row))));
}));

app.patch('/api/admin/payments/:id/approve', auth('admin'), wrap(async (req, res) => {
  await transaction(async conn => {
    const lock = IS_POSTGRES ? ' FOR UPDATE' : '';
    const payment = await get(`SELECT * FROM payments WHERE id=? AND status='pending'${lock}`, [req.params.id], conn);
    if (!payment) fail('Payment is not pending', 404);
    const now = new Date();
    if (payment.kind === 'pass') {
      const currentPass = await passOf(payment.user_id, conn);
      const nowBase = currentPass.expiry && new Date(currentPass.expiry) > now ? new Date(currentPass.expiry) : now;
      const currentSettings = await settings(conn);
      const end = new Date(nowBase.getTime() + Number(currentSettings.plan_days) * 864e5);
      const vehicle = await get('SELECT id FROM vehicles WHERE user_id=?', [payment.user_id], conn);
      if (vehicle) {
        await run('UPDATE vehicles SET reg_number=?,type=? WHERE user_id=?', [payment.vehicle_reg, payment.vehicle_type, payment.user_id], conn);
      } else {
        await insert('INSERT INTO vehicles(user_id,reg_number,type) VALUES(?,?,?)', [payment.user_id, payment.vehicle_reg, payment.vehicle_type], conn);
      }
      await insert('INSERT INTO passes(user_id,start_date,end_date,payment_id) VALUES(?,?,?,?)', [payment.user_id, nowBase.toISOString(), end.toISOString(), payment.id], conn);
    } else if (payment.kind === 'fee' && payment.fee_id) {
      await run("UPDATE fees SET status='paid' WHERE id=?", [payment.fee_id], conn);
    }
    await run("UPDATE payments SET status='approved',reviewed_at=? WHERE id=?", [now.toISOString(), payment.id], conn);
  });
  res.json({ ok: true });
}));

app.patch('/api/admin/payments/:id/reject', auth('admin'), wrap(async (req, res) => {
  await transaction(async conn => {
    const lock = IS_POSTGRES ? ' FOR UPDATE' : '';
    const payment = await get(`SELECT * FROM payments WHERE id=? AND status='pending'${lock}`, [req.params.id], conn);
    if (!payment) fail('Payment is not pending', 404);
    await run("UPDATE payments SET status='rejected',reject_reason=?,reviewed_at=? WHERE id=?", [req.body.reason || 'Rejected', new Date().toISOString(), payment.id], conn);
    if (payment.fee_id) await run("UPDATE fees SET status='unpaid' WHERE id=?", [payment.fee_id], conn);
  });
  res.json({ ok: true });
}));
app.get('/api/admin/slip/:id', auth('admin'), wrap((req, res) => sendSlip(req, res, 'admin')));
function nextEnforcerCode(existing) {
  const maximum = Math.max(0, ...existing.map(row => parseInt(String(row.code).replace(/\D/g, ''), 10) || 0));
  return `EN${String(maximum + 1).padStart(3, '0')}`;
}
app.post('/api/admin/enforcers', auth('admin'), wrap(async (req, res) => {
  const body = req.body || {};
  if (!String(body.name || '').trim() || !String(body.contact || '').trim()) fail('Name and contact details are required');
  if (String(body.password || '').length < 6) fail('Password must be at least 6 characters');
  if (body.password !== body.confirm) fail('Passwords do not match');
  const code = await transaction(async conn => {
    const existing = await all("SELECT code FROM users WHERE role='enforcer'", [], conn);
    const next = nextEnforcerCode(existing);
    await insert("INSERT INTO users(role,code,name,contact,password_hash) VALUES('enforcer',?,?,?,?)", [next, body.name.trim(), body.contact.trim(), bcrypt.hashSync(body.password, 10)], conn);
    return next;
  });
  res.json({ code });
}));

app.get('/api/admin/settings', auth('admin'), wrap(async (_req, res) => res.json(await settings())));
app.put('/api/admin/settings', auth('admin'), wrap(async (req, res) => {
  const body = req.body || {};
  await transaction(async conn => {
    for (const key of ['hourly_rate', 'pass_price', 'grace_minutes', 'plan_days']) {
      if (body[key] === undefined) continue;
      if (body[key] === '' || !Number.isFinite(Number(body[key])) || Number(body[key]) < 0) fail(`Invalid value for ${key}`);
      await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(body[key])], conn);
    }
    if (body.bank_info !== undefined) {
      await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['bank_info', String(body.bank_info)], conn);
    }
    if (body.new_password) {
      if (body.new_password.length < 6) fail('New admin password must be at least 6 characters');
      await run("UPDATE users SET password_hash=? WHERE role='admin'", [bcrypt.hashSync(body.new_password, 10)], conn);
    }
  });
  res.json(await settings());
}));

const TABLES = {
  students: { student: true, table: 'users', where: "role='student'", editable: ['code', 'name', 'contact'], select: 'id,code,name,contact,created_at' },
  enforcers: { table: 'users', where: "role='enforcer'", editable: ['code', 'name', 'contact'], select: 'id,code,name,contact,created_at' },
  vehicles: { table: 'vehicles', where: '', editable: ['reg_number', 'type'], select: 'id,user_id,reg_number,type' },
  passes: { table: 'passes', where: '', editable: ['start_date', 'end_date'], select: 'id,user_id,start_date,end_date,payment_id' },
  fees: { table: 'fees', where: '', editable: ['vehicle_reg', 'start_time', 'end_time', 'hours', 'amount', 'status', 'reason'], select: 'id,vehicle_reg,user_id,enforcer_id,start_time,end_time,hours,amount,status,reason,created_at' },
  payments: { table: 'payments', where: '', editable: ['kind', 'vehicle_reg', 'vehicle_type', 'amount', 'status', 'reject_reason'], select: 'id,user_id,kind,fee_id,vehicle_reg,vehicle_type,amount,status,reject_reason,created_at' }
};
const getTable = name => TABLES[name] || fail('Unknown table', 404);
const DATE_COLUMNS = new Set(['start_date', 'end_date', 'start_time', 'end_time']);
const NUMBER_COLUMNS = new Set(['hours', 'amount']);

async function updateRow(table, id, body, conn = null) {
  const assignments = [];
  const values = [];
  for (const column of table.editable) {
    if (body[column] === undefined) continue;
    let value = body[column];
    if (value === '' || value === null) {
      if (column === 'code' && table.student) fail(ID_MSG);
      value = null;
    } else if (DATE_COLUMNS.has(column)) {
      value = dateOrNull(value);
    } else if (NUMBER_COLUMNS.has(column)) {
      if (!Number.isFinite(Number(value))) fail(`${column} must be a number`);
      value = Number(value);
    } else if (column === 'code') {
      value = normalCode(value);
      if (table.student && !ID_RE.test(value)) {
        const current = await get(`SELECT ${column} AS value FROM ${table.table} WHERE id=?`, [id], conn);
        if (!current || current.value !== value) fail(ID_MSG);
      }
    } else if (column === 'reg_number' || column === 'vehicle_reg') {
      value = normReg(value);
      if (!REG_RE.test(value)) {
        const current = await get(`SELECT ${column} AS value FROM ${table.table} WHERE id=?`, [id], conn);
        if (!current || current.value !== value) fail(REG_MSG);
      }
    }
    assignments.push(`${column}=?`);
    values.push(value);
  }
  if (table.table === 'users' && body.new_password) {
    if (body.new_password.length < 6) fail('Password must be at least 6 characters');
    assignments.push('password_hash=?');
    values.push(bcrypt.hashSync(body.new_password, 10));
  }
  if (!assignments.length) fail('Nothing to change');
  values.push(id);
  let where = 'id=?';
  if (table.where) where += ` AND ${table.where}`;
  let result;
  try {
    result = await run(`UPDATE ${table.table} SET ${assignments.join(',')} WHERE ${where}`, values, conn);
  } catch (error) {
    console.error('[admin] update row failed', error.message);
    fail('Could not save - a value is invalid or already in use');
  }
  if (!result.changes) fail('Row not found', 404);
}

app.get('/api/admin/table/:name', auth('admin'), wrap(async (req, res) => {
  const table = getTable(req.params.name);
  const where = table.where ? ` WHERE ${table.where}` : '';
  const rows = await all(`SELECT ${table.select} FROM ${table.table}${where} ORDER BY id DESC`);
  res.json({ cols: table.select.split(','), editable: table.editable, rows });
}));
app.put('/api/admin/table/:name/:id', auth('admin'), wrap(async (req, res) => {
  await updateRow(getTable(req.params.name), req.params.id, req.body || {});
  res.json({ ok: true });
}));

async function studentId(code, conn = null) {
  const user = await get("SELECT id FROM users WHERE role='student' AND code=?", [normalCode(code)], conn);
  if (!user) fail(`student "${code || ''}" not found - add the student first`);
  return user.id;
}

async function addStudent(row, conn) {
  const code = normalCode(row.code);
  const reg = normReg(row.vehicle);
  if (!ID_RE.test(code)) fail(`${ID_MSG} - got "${String(row.code || '')}"`);
  if (reg && !REG_RE.test(reg)) fail(`${REG_MSG} - got "${String(row.vehicle || '')}"`);
  if (!String(row.name || '').trim()) fail('name is required');
  const suppliedPassword = String(row.password || '').trim();
  const password = suppliedPassword || code;
  if (suppliedPassword && suppliedPassword.length < 6) fail('password must be at least 6 characters');
  if (await get('SELECT 1 FROM users WHERE code=?', [code], conn)) fail(`student ${code} already exists`);
  if (reg && await get('SELECT 1 FROM vehicles WHERE reg_number=?', [reg], conn)) fail(`vehicle ${reg} is already registered`);
  let passEnd = null;
  if (row.pass_end) {
    passEnd = new Date(row.pass_end);
    if (Number.isNaN(passEnd.getTime())) fail('pass_end is not a valid date (use YYYY-MM-DD)');
  }
  const userId = await insert(
    "INSERT INTO users(role,code,name,contact,password_hash,qr_token) VALUES('student',?,?,?,?,?)",
    [code, String(row.name).trim(), String(row.contact || '').trim() || null, bcrypt.hashSync(password, 10), crypto.randomUUID()], conn
  );
  if (reg) await insert('INSERT INTO vehicles(user_id,reg_number,type) VALUES(?,?,?)', [userId, reg, row.vehicle_type || 'Car'], conn);
  if (passEnd) {
    const current = await settings(conn);
    await insert('INSERT INTO passes(user_id,start_date,end_date) VALUES(?,?,?)', [userId, new Date(passEnd.getTime() - Number(current.plan_days) * 864e5).toISOString(), passEnd.toISOString()], conn);
  }
  return !suppliedPassword;
}

async function addEnforcer(row, conn) {
  if (!String(row.name || '').trim()) fail('name is required');
  const password = String(row.password || '').trim();
  if (password.length < 6) fail('password (at least 6 characters) is required');
  const code = normalCode(row.code) || nextEnforcerCode(await all("SELECT code FROM users WHERE role='enforcer'", [], conn));
  if (await get('SELECT 1 FROM users WHERE code=?', [code], conn)) fail(`code ${code} is already used`);
  await insert("INSERT INTO users(role,code,name,contact,password_hash) VALUES('enforcer',?,?,?,?)", [code, String(row.name).trim(), String(row.contact || '').trim() || null, bcrypt.hashSync(password, 10)], conn);
  return false;
}

async function addVehicle(row, conn) {
  const userId = await studentId(row.student, conn);
  const reg = normReg(row.reg_number);
  if (!reg) fail('reg_number is required');
  if (!REG_RE.test(reg)) fail(REG_MSG);
  if (await get('SELECT 1 FROM vehicles WHERE user_id=?', [userId], conn)) fail('that student already has a vehicle - edit the existing row instead');
  if (await get('SELECT 1 FROM vehicles WHERE reg_number=?', [reg], conn)) fail(`vehicle ${reg} is already registered`);
  await insert('INSERT INTO vehicles(user_id,reg_number,type) VALUES(?,?,?)', [userId, reg, row.type || 'Car'], conn);
  return false;
}

async function addPass(row, conn) {
  const userId = await studentId(row.student, conn);
  const end = new Date(row.end_date);
  if (!row.end_date || Number.isNaN(end.getTime())) fail('end_date is required (YYYY-MM-DD)');
  const start = row.start_date ? new Date(row.start_date) : new Date(end.getTime() - Number((await settings(conn)).plan_days) * 864e5);
  if (Number.isNaN(start.getTime()) || end <= start) fail('start_date must be a valid date before end_date');
  await insert('INSERT INTO passes(user_id,start_date,end_date) VALUES(?,?,?)', [userId, start.toISOString(), end.toISOString()], conn);
  return false;
}

async function addFee(row, conn) {
  const reg = normReg(row.vehicle_reg);
  if (!reg) fail('vehicle_reg is required');
  if (!REG_RE.test(reg)) fail(REG_MSG);
  const status = String(row.status || 'unpaid').toLowerCase();
  if (!['unpaid', 'paid'].includes(status)) fail('status must be unpaid or paid');
  const start = row.start_time ? new Date(row.start_time) : null;
  const end = row.end_time ? new Date(row.end_time) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) fail('start_time / end_time is not a valid date');
  let hours = row.hours === '' || row.hours == null ? null : Number(row.hours);
  let amount = row.amount === '' || row.amount == null ? null : Number(row.amount);
  if ((hours !== null && !Number.isFinite(hours)) || (amount !== null && !Number.isFinite(amount))) fail('hours and amount must be numbers');
  if (amount === null) {
    if (!start || !end || end <= start) fail('amount is required (or give start_time and end_time so it can be calculated)');
    const current = await settings(conn);
    const minutes = (end - start) / 60000;
    hours = minutes <= Number(current.grace_minutes) ? 0 : Math.ceil(minutes / 60);
    amount = hours * Number(current.hourly_rate);
  }
  const vehicle = await get('SELECT user_id FROM vehicles WHERE reg_number=?', [reg], conn);
  let enforcerId = null;
  if (String(row.enforcer || '').trim()) {
    const enforcer = await get("SELECT id FROM users WHERE role='enforcer' AND code=?", [normalCode(row.enforcer)], conn);
    if (!enforcer) fail(`enforcer ${row.enforcer} not found`);
    enforcerId = enforcer.id;
  }
  const reason = row.reason || (vehicle ? (await passOf(vehicle.user_id, conn)).status : 'UNREGISTERED');
  await insert(
    'INSERT INTO fees(vehicle_reg,user_id,enforcer_id,start_time,end_time,hours,amount,status,reason) VALUES(?,?,?,?,?,?,?,?,?)',
    [reg, vehicle?.user_id || null, enforcerId, start?.toISOString() || null, end?.toISOString() || null, hours, amount, status, reason], conn
  );
  return false;
}

const ADDERS = { students: addStudent, enforcers: addEnforcer, vehicles: addVehicle, passes: addPass, fees: addFee };
app.post('/api/admin/table/:name/import', auth('admin'), wrap(async (req, res) => {
  const table = getTable(req.params.name);
  const rows = req.body?.rows;
  const add = ADDERS[req.params.name];
  if (!Array.isArray(rows) || !rows.length) fail('No rows found in the file');
  let updated = 0, added = 0, defaulted = 0;
  try {
    await transaction(async conn => {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const hasId = row.id !== undefined && String(row.id).trim() !== '';
        try {
          const exists = hasId ? await get(`SELECT 1 FROM ${table.table} WHERE id=?${table.where ? ` AND ${table.where}` : ''}`, [row.id], conn) : null;
          if (exists) {
            if (table.table === 'users' && row.password) row.new_password = row.password;
            if (!table.editable.some(column => column in row) && !row.new_password) continue;
            await updateRow(table, row.id, row, conn);
            updated++;
          } else if (add) {
            if (await add(row, conn)) defaulted++;
            added++;
          } else {
            fail(hasId ? `id ${row.id} does not exist in this table` : 'new rows cannot be added to this table (only existing rows can be updated)');
          }
        } catch (error) {
          error.message = `Row ${row._row || index + 2}: ${error.message}`;
          throw error;
        }
      }
    });
  } catch (error) {
    fail(`${error.message} - nothing was changed`);
  }
  res.json({ updated, added, defaulted });
}));

app.delete('/api/admin/table/:name/:id', auth('admin'), wrap(async (req, res) => {
  const table = getTable(req.params.name);
  const id = req.params.id;
  const row = await get(`SELECT * FROM ${table.table} WHERE id=?${table.where ? ` AND ${table.where}` : ''}`, [id]);
  if (!row) fail('Row not found', 404);
  await transaction(async conn => {
    if (table.table === 'users' && row.role === 'student') {
      await run("UPDATE fees SET status='unpaid' WHERE id IN (SELECT fee_id FROM payments WHERE user_id=? AND status='pending' AND fee_id IS NOT NULL)", [id], conn);
      await run('DELETE FROM vehicles WHERE user_id=?', [id], conn);
      await run('DELETE FROM passes WHERE user_id=?', [id], conn);
      await run('DELETE FROM payments WHERE user_id=?', [id], conn);
      await run('UPDATE fees SET user_id=NULL WHERE user_id=?', [id], conn);
    }
    if (table.table === 'payments' && row.status === 'pending' && row.fee_id) {
      await run("UPDATE fees SET status='unpaid' WHERE id=?", [row.fee_id], conn);
    }
    await run(`DELETE FROM ${table.table} WHERE id=?`, [id], conn);
  });
  res.json({ ok: true });
}));

app.post('/api/admin/passes', auth('admin'), wrap(async (req, res) => {
  const user = await get("SELECT id FROM users WHERE role='student' AND code=?", [normalCode(req.body.code)]);
  if (!user) fail('Student not found');
  const start = new Date(req.body.start_date || Date.now());
  const end = new Date(req.body.end_date);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) fail('Enter a valid start date and an end date after it');
  await insert('INSERT INTO passes(user_id,start_date,end_date) VALUES(?,?,?)', [user.id, start.toISOString(), end.toISOString()]);
  res.json({ ok: true });
}));

app.get('/api/admin/search', auth('admin'), wrap(async (req, res) => {
  const type = req.query.type;
  const term = String(req.query.q || '').trim().replace(/[%_]/g, '');
  if (!term) return res.json([]);
  const like = `%${term}%`;
  const reg = `%${normReg(term).replace(/-/g, '')}%`;
  if (type === 'enforcer') {
    const rows = await all("SELECT id FROM users WHERE role='enforcer' AND (code LIKE ? OR name LIKE ? OR contact LIKE ?) ORDER BY code LIMIT 8", [like, like, like]);
    return res.json(await Promise.all(rows.map(row => enforcerInfo(row.id))));
  }
  const rows = await all(
    "SELECT u.id FROM users u LEFT JOIN vehicles v ON v.user_id=u.id WHERE u.role='student' AND (u.code LIKE ? OR u.name LIKE ? OR u.contact LIKE ? OR REPLACE(v.reg_number,'-','') LIKE ?) GROUP BY u.id ORDER BY u.code LIMIT 8",
    [like, like, like, reg]
  );
  res.json(await Promise.all(rows.map(row => profile(row.id))));
}));

app.get('/api/admin/backup', auth('admin'), wrap(async (_req, res) => {
  if (!IS_POSTGRES) return res.download(process.env.SQLITE_PATH || path.join(__dirname, 'sliit-parking.db'), 'sliit-parking-backup.db');
  const backup = { format: 'sliit-parking-json-backup-v1', exported_at: new Date().toISOString(), tables: {} };
  for (const table of ['users', 'vehicles', 'passes', 'payments', 'fees', 'settings']) {
    backup.tables[table] = await all(`SELECT * FROM ${table} ORDER BY 1`);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sliit-parking-backup.json"');
  res.send(JSON.stringify(backup, null, 2));
}));

// ---------- Enforcer
app.get('/api/enforcer/me', auth('enforcer'), wrap(async (req, res) => {
  res.json(await get('SELECT code,name FROM users WHERE id=? AND role=\'enforcer\'', [req.user.id]) || {});
}));
app.get('/api/enforcer/lookup', auth('enforcer'), wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) fail('Enter a student ID or vehicle number');
  let user = await get("SELECT id FROM users WHERE role='student' AND (qr_token::text=? OR code=?)".replace('qr_token::text', IS_POSTGRES ? 'qr_token::text' : 'qr_token'), [term, normalCode(term)]);
  if (!user) user = await get('SELECT user_id AS id FROM vehicles WHERE reg_number=?', [normReg(term)]);
  if (!user) return res.json({ found: false, reg: normReg(term) });
  res.json({ found: true, ...await profile(user.id) });
}));
app.post('/api/enforcer/drafts', auth('enforcer'), wrap(async (req, res) => {
  const reg = normReg(req.body.vehicle_reg);
  const start = new Date(req.body.start_time);
  if (!reg || Number.isNaN(start.getTime())) fail('Vehicle number and start time are required');
  if (!REG_RE.test(reg)) fail(REG_MSG);
  await transaction(async conn => {
    const vehicle = await get('SELECT user_id FROM vehicles WHERE reg_number=?', [reg], conn);
    if (vehicle && (await passOf(vehicle.user_id, conn)).status === 'ACTIVE') fail('This vehicle has an active pass - no fee can be added');
    if (await get("SELECT 1 FROM fees WHERE vehicle_reg=? AND status='draft' LIMIT 1", [reg], conn)) fail('A draft already exists for this vehicle');
    await insert("INSERT INTO fees(vehicle_reg,user_id,enforcer_id,start_time,status) VALUES(?,?,?,?,'draft')", [reg, vehicle?.user_id || null, req.user.id, start.toISOString()], conn);
  });
  res.json({ ok: true });
}));
app.get('/api/enforcer/fees', auth('enforcer'), wrap(async (req, res) => {
  const view = req.query.view;
  let sql = 'SELECT id,vehicle_reg,start_time,end_time,hours,amount,status,created_at FROM fees WHERE enforcer_id=?';
  const args = [req.user.id];
  if (view === 'draft') sql += " AND status='draft'";
  else {
    sql += " AND status<>'draft'";
    if (view === 'pending' || view === 'unpaid') { sql += ' AND status=?'; args.push(view); }
  }
  res.json(await all(`${sql} ORDER BY id DESC`, args));
}));
app.patch('/api/enforcer/fees/:id/finish', auth('enforcer'), wrap(async (req, res) => {
  const result = await transaction(async conn => {
    const lock = IS_POSTGRES ? ' FOR UPDATE' : '';
    const fee = await get(`SELECT * FROM fees WHERE id=? AND enforcer_id=? AND status='draft'${lock}`, [req.params.id, req.user.id], conn);
    if (!fee) fail('Draft not found', 404);
    const start = new Date(fee.start_time);
    const end = new Date(req.body.end_time);
    if (Number.isNaN(end.getTime()) || end <= start) fail('Leave time must be after the start time');
    const current = await settings(conn);
    const minutes = (end - start) / 60000;
    const hours = minutes <= Number(current.grace_minutes) ? 0 : Math.ceil(minutes / 60);
    const amount = hours * Number(current.hourly_rate);
    if (!amount) {
      await run('DELETE FROM fees WHERE id=?', [fee.id], conn);
      return { hours: 0, amount: 0 };
    }
    const vehicle = await get('SELECT user_id FROM vehicles WHERE reg_number=?', [fee.vehicle_reg], conn);
    const reason = vehicle ? (await passOf(vehicle.user_id, conn)).status : 'UNREGISTERED';
    await run("UPDATE fees SET end_time=?,hours=?,amount=?,status='unpaid',reason=? WHERE id=?", [end.toISOString(), hours, amount, reason, fee.id], conn);
    return { hours, amount };
  });
  res.json(result);
}));

// Normalize Multer/body-parser and other middleware failures to JSON as well.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : error.message?.startsWith('Only JPG, PNG') ? 415 : 500));
  if (status >= 500) console.error('[middleware]', req.method, req.path, error);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
});

// Vercel routes this Express app as one Function; exporting the instance also supports `node server.js` locally.
module.exports = app;
if (require.main === module) {
  initializeDatabase().then(() => {
    app.listen(PORT, () => console.log(`SLIIT Parking running at http://localhost:${PORT} (${IS_POSTGRES ? 'PostgreSQL' : 'SQLite'})`));
  }).catch(error => {
    console.error('[startup] database initialization failed', error);
    process.exitCode = 1;
  });
}
