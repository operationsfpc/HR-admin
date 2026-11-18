import express from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, createJar, parseContestSlug, fetchAllLeaderboard, buildMatrix } from './lib/hackerrank.js';
import { buildMockDashboard } from './lib/mock.js';
import * as db from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const MOCK = process.env.MOCK === '1';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const HR_EMAIL = process.env.HR_EMAIL || '';
const HR_PASS = process.env.HR_PASS || '';
const AUTO_SYNC = process.env.AUTO_SYNC === '1';
const AUTO_TIMES = (process.env.AUTO_SYNC_TIMES || '06:00,18:00').split(',').map((s) => s.trim()).filter(Boolean);

app.use(express.json({ limit: '12mb' }));

// Gzip JSON API responses. The scrape payloads are multi-MB; gzip cuts them
// ~10x over the wire. SSE is excluded so live progress isn't buffered.
app.use((req, res, next) => {
  if (req.path.endsWith('-stream') || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
  const _json = res.json.bind(res);
  res.json = (body) => {
    let buf; try { buf = Buffer.from(JSON.stringify(body)); } catch { return _json(body); }
    if (buf.length < 1024) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.send(buf); }
    zlib.gzip(buf, (err, zipped) => {
      if (err) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.send(buf); }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      res.end(zipped);
    });
    return res;
  };
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory cache for the heavy scrape reads (latest snapshot + daily series),
// keyed by slug. Invalidated whenever a new scrape is saved. This avoids
// re-pulling multi-MB payloads from Supabase on every page load.
const scrapeCache = new Map();
async function cachedLatestScrape(slug) {
  if (!slug) return null;
  const k = 'latest:' + slug;
  if (scrapeCache.has(k)) return scrapeCache.get(k);
  const v = await db.getLatestScrape(slug); scrapeCache.set(k, v); return v;
}
async function cachedScrapeSeries(slug) {
  if (!slug) return [];
  const k = 'series:' + slug;
  if (scrapeCache.has(k)) return scrapeCache.get(k);
  const v = await db.getScrapeSeries(slug); scrapeCache.set(k, v); return v;
}
function invalidateScrapeCache(slug) { scrapeCache.delete('latest:' + slug); scrapeCache.delete('series:' + slug); }
// Trim old scrapes for a course after each save (keep latest-per-day, last 20 days).
// Fire-and-forget; a prune failure must never break a sync. Works for sync + async backends.
function pruneScrapesFor(slug) {
  Promise.resolve(db.pruneScrapes(slug, 20))
    .then((r) => { if (r && r.deleted) console.log(`[prune] ${slug}: removed ${r.deleted} old scrape(s)`); })
    .catch((e) => console.warn('[prune] failed for', slug, e.message));
}

// ---------------- Admin auth (stateless HMAC-signed tokens) ----------------
const AUTH_SECRET = process.env.ADMIN_SECRET || process.env.SUPABASE_DB_URL || `${ADMIN_USER}:${ADMIN_PASS}`;

function generateAdminToken() {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // valid for 30 days
  const payload = `${ADMIN_USER}:${expiresAt}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length !== 3) return false;
    const [user, expStr, sig] = parts;
    if (user !== ADMIN_USER) return false;
    const expiresAt = Number(expStr);
    if (!expiresAt || Date.now() > expiresAt) return false;
    const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(`${user}:${expStr}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

const adminTokens = new Set();
const hrSessions = new Map(); // hr login sessions for scraping: token -> {jar,csrfToken}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = (username || ADMIN_USER).trim();
  if (user === ADMIN_USER && password === ADMIN_PASS) {
    const token = generateAdminToken();
    adminTokens.add(token);
    return res.json({ ok: true, token, defaultCreds: ADMIN_USER === 'admin' && ADMIN_PASS === 'admin' });
  }
  res.status(401).json({ error: 'Invalid admin username or password.' });
});
app.get('/api/admin/verify', (req, res) => {
  const t = req.get('x-admin-token') || req.query.adminToken;
  if (verifyAdminToken(t) || (t && adminTokens.has(t))) return res.json({ ok: true });
  res.status(401).json({ error: 'Admin authentication required.' });
});
function requireAdmin(req, res, next) {
  const t = req.get('x-admin-token') || req.query.adminToken;
  if (verifyAdminToken(t) || (t && adminTokens.has(t))) return next();
  res.status(401).json({ error: 'Admin authentication required.' });
}

function slugFromUrl(url) { const u = String(url || '').trim(); if (!u) return ''; try { return parseContestSlug(u); } catch { return ''; } }

// ---------------- Colleges ----------------
app.get('/api/colleges', requireAdmin, async (_req, res) => {
  try {
    res.json({ colleges: await db.listColleges() });
  } catch (e) {
    console.error('[api /api/colleges]', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/colleges', requireAdmin, async (req, res) => {
  try {
    const { name, accessCode, contestUrl } = req.body || {};
    const c = await db.addCollege({ name, accessCode: accessCode || '', contestUrl: contestUrl || '', slug: slugFromUrl(contestUrl) });
    res.json({ ok: true, college: c });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/colleges/:id', requireAdmin, async (req, res) => {
  try {
    const { accessCode, contestUrl } = req.body || {};
    const fields = {};
    if (accessCode !== undefined) fields.accessCode = accessCode;
    if (contestUrl !== undefined) { fields.contestUrl = contestUrl; fields.slug = slugFromUrl(contestUrl); }
    const c = await db.updateCollege(req.params.id, fields);
    if (!c) return res.status(404).json({ error: 'College not found.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/colleges/:id', requireAdmin, async (req, res) => { try { res.json({ ok: await db.deleteCollege(req.params.id) }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ---------------- Contests (many per college) ----------------
app.get('/api/contests', requireAdmin, async (req, res) => {
  try {
    let college;
    if (req.query.collegeId) { const c = (await db.listColleges()).find((x) => String(x.id) === String(req.query.collegeId)); college = c?.name; }
    else if (req.query.college) college = String(req.query.college);
    res.json({ contests: await db.listContests(college) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/contests', requireAdmin, async (req, res) => {
  try {
    const { collegeId, name, contestUrl } = req.body || {};
    const col = (await db.listColleges()).find((x) => String(x.id) === String(collegeId));
    if (!col) return res.status(400).json({ error: 'College not found.' });
    const c = await db.addContest({ college: col.name, name, contestUrl: contestUrl || '', slug: slugFromUrl(contestUrl) });
    res.json({ ok: true, contest: c });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/contests/:id', requireAdmin, async (req, res) => {
  try {
    const { name, contestUrl } = req.body || {};
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (contestUrl !== undefined) { fields.contestUrl = contestUrl; fields.slug = slugFromUrl(contestUrl); }
    const c = await db.updateContest(req.params.id, fields);
    if (!c) return res.status(404).json({ error: 'Course not found.' });
    res.json({ ok: true, contest: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/contests/:id', requireAdmin, async (req, res) => { try { res.json({ ok: await db.deleteContest(req.params.id) }); } catch (e) { res.status(500).json({ error: e.message }); } });
// Create (or return existing) a read-only share link for a contest.
app.post('/api/contests/:id/share', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.id);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    let token = contest.shareToken;
    if (!token) { token = crypto.randomBytes(9).toString('hex'); await db.setContestShareToken(contest.id, token); }
    res.json({ ok: true, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Attendance (Google Sheet — all tabs) ----------------
// Convert a Google Sheets link into its XLSX-export URL (the whole workbook, so
// every tab comes in one download). Requires the sheet to be shared
// "anyone with the link can view" (or published to the web).
function sheetXlsxUrl(url) {
  const s = String(url || '').trim();
  const idMatch = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || s.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  if (!idMatch) return null;
  return `https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=xlsx`;
}
// Fetch the workbook and return every sheet: [{ name, columns, rows }].
async function fetchAttendance(url) {
  const xlsxUrl = sheetXlsxUrl(url);
  if (!xlsxUrl) throw new Error('Not a Google Sheets link. Paste the full sheet URL.');
  let XLSX;
  try { XLSX = await import('xlsx'); } catch { throw new Error('The "xlsx" package is not installed — run: npm install'); }
  const res = await fetch(xlsxUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not read the sheet (HTTP ${res.status}). Make sure it's shared "anyone with the link can view".`);
  const ctype = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (ctype.includes('text/html') || buf.slice(0, 15).toString('utf8').includes('<!DOCTYPE')) {
    throw new Error('The sheet is not public. In Google Sheets: Share → General access → "Anyone with the link" → Viewer.');
  }
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheets = wb.SheetNames.map((name) => {
    const grid = sheetToGrid(XLSX, wb.Sheets[name]);
    // Keep header cells raw so their hyperlinks stay clickable (some tabs have
    // no real header row — the first row is data).
    return { name, columns: grid[0] || [], rows: grid.slice(1) };
  });
  return { sheets };
}
// Build a grid where each cell is either a string, or { text, url } when the
// cell carries a hyperlink (e.g. a "recording link" that shows a label).
function sheetToGrid(XLSX, ws) {
  const ref = ws && ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const grid = [];
  for (let R = range.s.r; R <= range.e.r; R++) {
    const row = [];
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell) { row.push(''); continue; }
      const text = cell.w != null ? cell.w : (cell.v != null ? cell.v : '');
      const url = cell.l && cell.l.Target ? cell.l.Target : null;
      row.push(url ? { text: String(text), url: String(url) } : String(text));
    }
    grid.push(row);
  }
  return grid.filter((r) => r.some((c) => String(c && typeof c === 'object' ? (c.text || c.url) : c).trim() !== ''));
}
const attKey = (collegeId) => 'attendance_sheet_url:' + String(collegeId || '');
app.get('/api/attendance', requireAdmin, async (req, res) => {
  const collegeId = req.query.collegeId || '';
  try {
    if (!collegeId) return res.status(400).json({ error: 'Pick a college.' });
    const url = await db.getSetting(attKey(collegeId));
    if (!url) return res.json({ url: '', sheets: [] });
    const data = await fetchAttendance(url);
    res.json({ url, ...data });
  } catch (e) { res.status(200).json({ url: (await db.getSetting(attKey(collegeId))) || '', error: e.message, sheets: [] }); }
});
app.post('/api/attendance', requireAdmin, async (req, res) => {
  try {
    const collegeId = String(req.body?.collegeId || '').trim();
    const url = String(req.body?.url || '').trim();
    if (!collegeId) return res.status(400).json({ error: 'Pick a college first.' });
    if (!url) return res.status(400).json({ error: 'Paste a Google Sheets link.' });
    const data = await fetchAttendance(url); // validate before saving
    await db.setSetting(attKey(collegeId), url);
    res.json({ ok: true, url, ...data });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/attendance', requireAdmin, async (req, res) => {
  try {
    const collegeId = String(req.query.collegeId || req.body?.collegeId || '').trim();
    if (!collegeId) return res.status(400).json({ error: 'Pick a college first.' });
    await db.setSetting(attKey(collegeId), '');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------- Students (roster) ----------------
app.get('/api/students', requireAdmin, async (req, res) => {
  try {
    const { college, department, section, year, contestId } = req.query;
    if (contestId) return res.json({ students: await db.listStudentsForContest(contestId) });
    res.json({ students: await db.listStudents({ college, department, section, year }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Distinct department / section / year for a college — powers the manual-entry dropdowns.
app.get('/api/student-facets', requireAdmin, async (req, res) => {
  try { res.json(await db.getStudentFacets(req.query.college || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Placeholder usernames that are not real HackerRank accounts.
const PLACEHOLDER_USERNAMES = new Set(['sample', 'absent', 'na', 'n/a', 'nil', 'none', 'null', 'test', 'xxx', '-', '--', '.']);
app.post('/api/students/upload', requireAdmin, async (req, res) => {
  try {
    const { college, students, contestId } = req.body || {};
    if (!college || !Array.isArray(students)) return res.status(400).json({ error: 'Expected { college, students: [...] }.' });

    const warnings = [];
    const unmatched = [];         // rows with no valid HackerRank id — kept, listed at the end
    const duplicates = [];        // rows collapsed because the key repeats in this file
    const seen = new Map();       // username_key -> first student name (dup detection)
    const prepared = [];          // final rows with an explicit usernameKey

    // Stable synthetic key for a student with no usable HackerRank id, so the
    // row is preserved (not dropped, not collapsed) and re-uploads stay idempotent.
    const synthKey = (s, rowNo) => 'unmatched:' + String(s.registerNo || s.email || s.name || ('row' + rowNo)).trim().toLowerCase();

    students.forEach((s, i) => {
      const rowNo = i + 2; // +1 header, +1 to 1-index
      const raw = String(s.hrUsername || '').trim();
      const lc = raw.toLowerCase();
      const valid = raw && !PLACEHOLDER_USERNAMES.has(lc);
      // Valid HR id -> key = the username; otherwise a synthetic key, HR id cleared.
      const usernameKey = valid ? lc : synthKey(s, rowNo);
      const rec = { ...s, hrUsername: valid ? raw : '', usernameKey };
      if (!valid) unmatched.push({ row: rowNo, name: s.name || '', username: raw });
      if (seen.has(usernameKey)) { duplicates.push({ row: rowNo, name: s.name || '', key: usernameKey, firstSeen: seen.get(usernameKey) }); }
      else seen.set(usernameKey, s.name || `row ${rowNo}`);
      prepared.push(rec);
    });

    if (unmatched.length) {
      warnings.push(`${unmatched.length} student(s) had no valid HackerRank id — kept and shown at the end as “no HR id”.`);
    }
    if (duplicates.length) {
      warnings.push(`${duplicates.length} row(s) collapsed onto an earlier student (same id / same identifying details) — the last of each was kept.`);
    }

    // Reconcile by register number: if an incoming student's register number
    // already exists under a DIFFERENT key (e.g. previously saved with no HR id,
    // now re-uploaded with the correct username), update that same person and
    // drop the stale row instead of creating a duplicate.
    let merged = 0;
    const existing = await db.listStudents({ college });
    const byReg = new Map();
    for (const e of existing) { const rn = String(e.registerNo || '').trim().toLowerCase(); if (rn) byReg.set(rn, e); }
    const staleIds = [];
    for (const s of prepared) {
      const rn = String(s.registerNo || '').trim().toLowerCase(); if (!rn) continue;
      const ex = byReg.get(rn);
      if (ex && String(ex.usernameKey || '').toLowerCase() !== s.usernameKey) { staleIds.push(ex.id); merged++; }
    }

    const r = await db.upsertStudents(college, prepared);
    if (staleIds.length) await db.deleteStudents(staleIds);
    let assigned = 0;
    if (contestId) assigned = await db.assignStudentsToContest(contestId, prepared.map((s) => s.usernameKey));
    if (merged) warnings.push(`${merged} student(s) matched an existing record by register number and were updated (e.g. a corrected HackerRank id) — no duplicate created.`);
    res.json({ ok: true, ...r, assigned, received: students.length, unmatched, duplicates, merged, warnings });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/students/:id', requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateStudent(req.params.id, req.body || {});
    res.json({ ok: true, student: updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/students', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ ok: true, deleted: await db.deleteStudents(ids) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- HackerRank connect + scrape ----------------
let envHrSessionCache = null;
let envHrSessionTime = 0;
const SESSION_TTL = 30 * 60 * 1000; // 30 mins

// Helper to obtain a HackerRank session using server environment variables or cached session.
async function getEnvHrSession(forceRefresh = false) {
  if (MOCK) return { mock: true };
  if (!forceRefresh && envHrSessionCache && Date.now() - envHrSessionTime < SESSION_TTL) {
    return envHrSessionCache;
  }
  const email = HR_EMAIL || process.env.HR_EMAIL;
  const pass = HR_PASS || process.env.HR_PASS;
  const cookieStr = process.env.HR_COOKIE || '';

  if (cookieStr) {
    const jar = createJar();
    cookieStr.split(';').forEach((part) => {
      const eq = part.indexOf('=');
      if (eq !== -1) {
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        if (k) jar.set(k, v);
      }
    });
    const csrfToken = jar.get('_csrf_token') || jar.get('csrf_token') || '';
    envHrSessionCache = { jar, csrfToken };
    envHrSessionTime = Date.now();
    return envHrSessionCache;
  }

  if (!email || !pass) {
    throw new Error('HR_EMAIL / HR_PASS environment variables are not configured in .env on the server.');
  }
  try {
    const { jar, csrfToken } = await login(email, pass);
    envHrSessionCache = { jar, csrfToken };
    envHrSessionTime = Date.now();
    return envHrSessionCache;
  } catch (err) {
    envHrSessionCache = null;
    throw new Error(`HackerRank connection failed: ${err.message}`);
  }
}

app.get('/api/hr/status', requireAdmin, async (_req, res) => {
  try {
    const hasEnv = !!(HR_EMAIL && HR_PASS) || !!process.env.HR_COOKIE;
    const isConnected = !!envHrSessionCache || hrSessions.size > 0 || MOCK;
    res.json({
      ok: true,
      hasEnvCreds: hasEnv,
      connected: isConnected,
      email: HR_EMAIL ? HR_EMAIL.replace(/(.{2})(.*)(@.*)/, '$1***$3') : '',
      mock: MOCK,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/hr/connect', requireAdmin, async (req, res) => {
  try {
    if (MOCK) { const t = crypto.randomUUID(); hrSessions.set(t, { mock: true }); return res.json({ ok: true, hrToken: t, mock: true }); }
    let { email, password } = req.body || {};
    if ((!email || !password) && (HR_EMAIL && HR_PASS)) {
      email = HR_EMAIL;
      password = HR_PASS;
    }
    const session = await login(email, password);
    const t = crypto.randomUUID();
    hrSessions.set(t, session);
    envHrSessionCache = session;
    envHrSessionTime = Date.now();
    res.json({ ok: true, hrToken: t });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

const SCRAPE_CAP = 3000; // max users compared per scrape

// Resolve which usernames to scrape for a contest: the mapped roster (capped),
// combined with any active leaderboard participants.
async function resolveScrapeTargets(contest, leaderboard) {
  const roster = await db.listStudentsForContest(contest.id);
  const targets = roster.map((s) => String(s.hrUsername || '').trim()).filter(Boolean);
  const lbUsernames = (leaderboard || []).map((l) => String(l.username || '').trim()).filter(Boolean);

  // dedupe case-insensitively, preserve first spelling
  const seen = new Set(); const deduped = [];
  for (const u of [...targets, ...lbUsernames]) { const k = u.toLowerCase(); if (!seen.has(k)) { seen.add(k); deduped.push(u); } }
  const source = roster.length ? 'roster' : 'leaderboard';
  const capped = deduped.length > SCRAPE_CAP;
  return { targets: deduped.slice(0, SCRAPE_CAP), source, capped, rosterCount: roster.length };
}

function assembleDashboard({ slug, contest, leaderboard, questions, userMap, reference }) {
  const users = leaderboard.map((entry) => {
    const key = String(entry.username || '').toLowerCase();
    const status = userMap.get(key) || userMap.get(entry.username) || {};
    let solved = 0, attempted = 0, score = 0;
    const questionStatus = {};
    for (const q of questions) {
      const cell = status[q.name];
      if (cell) { questionStatus[q.name] = cell; if (cell.solved) solved++; if (cell.attempted) attempted++; score += cell.score || 0; }
      else questionStatus[q.name] = { score: 0, points: q.points, attempted: false, solved: false };
    }
    return { username: entry.username, rank: entry.rank, computedScore: score, solved, attempted, questionStatus };
  });
  const totalSolves = users.reduce((a, u) => a + u.solved, 0); const qc = questions.length;
  return {
    contest: { slug, name: contest?.name || slug, challengesCount: qc },
    summary: { totalUsers: users.length, totalQuestions: qc, avgSolved: users.length ? +(totalSolves / users.length).toFixed(2) : 0, overallCompletion: users.length && qc ? Math.round((totalSolves / (users.length * qc)) * 100) : 0 },
    questions, users, reference,
  };
}

async function scrapeAndSave(session, contest, onProgress) {
  const slug = contest.slug;
  if (!slug) throw new Error('Course has no link.');
  if (MOCK || session.mock) { const dash = buildMockDashboard(slug, 60); await db.saveScrape(slug, dash); invalidateScrapeCache(slug); pruneScrapesFor(slug); return { slug, users: dash.summary.totalUsers }; }
  const { jar, csrfToken } = session;
  let leaderboard = [];
  try { leaderboard = await fetchAllLeaderboard({ jar, csrfToken, slug }); } catch { /* ranks are optional; full leaderboard */ }
  const rankMap = new Map(leaderboard.map((l) => [String(l.username).toLowerCase(), l.rank]));
  const { targets } = await resolveScrapeTargets(contest, leaderboard);
  if (!targets.length) throw new Error('no students mapped and no leaderboard entries');
  const reference = (leaderboard[0] && leaderboard[0].username) || targets[0];
  const { contest: c, questions, userMap } = await buildMatrix({ jar, csrfToken, slug, hackers: targets, reference, concurrency: 8, onProgress });
  const entries = targets.map((u) => ({ username: u, rank: rankMap.get(u.toLowerCase()) ?? null }));
  const dash = assembleDashboard({ slug, contest: c, leaderboard: entries, questions, userMap, reference });
  await db.saveScrape(slug, dash); invalidateScrapeCache(slug); pruneScrapesFor(slug);
  return { slug, users: dash.summary.totalUsers };
}

// Single contest scrape runner with live SSE streaming.
async function streamSingleContestScrape({ session, contest, send, isAborted }) {
  const slug = contest.slug;
  if (!slug) throw new Error('Course has no link.');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (MOCK || session.mock) {
    const dash = buildMockDashboard(slug, 60); const total = dash.summary.totalUsers;
    for (let i = 1; i <= total && !isAborted(); i++) { send('progress', { phase: 'comparing', completed: i, total }); await sleep(15); }
    if (!isAborted()) { const saved = await db.saveScrape(slug, dash); invalidateScrapeCache(slug); pruneScrapesFor(slug); send('done', { ...saved, summary: dash.summary, contest: dash.contest }); }
    return;
  }
  const { jar, csrfToken } = session;
  send('progress', { phase: 'leaderboard', completed: 0, total: 0 });
  let leaderboard = [];
  try { leaderboard = await fetchAllLeaderboard({ jar, csrfToken, slug, onPage: (c) => send('progress', { phase: 'leaderboard', completed: c, total: 0 }) }); }
  catch (e) { send('progress', { phase: 'leaderboard', completed: 0, total: 0, note: 'leaderboard unavailable: ' + e.message }); }
  const rankMap = new Map(leaderboard.map((l) => [String(l.username).toLowerCase(), l.rank]));

  const { targets, source, capped, rosterCount } = await resolveScrapeTargets(contest, leaderboard);
  if (!targets.length) { send('failed', { error: 'No students mapped to this course and no leaderboard entries. Upload a roster and map it to this course.' }); return; }
  send('progress', { phase: 'comparing', completed: 0, total: targets.length, source, capped, rosterCount });

  const reference = (leaderboard[0] && leaderboard[0].username) || targets[0];
  const { contest: cInfo, questions, userMap } = await buildMatrix({ jar, csrfToken, slug, hackers: targets, reference, concurrency: 8, onProgress: (c, t) => { if (!isAborted()) send('progress', { phase: 'comparing', completed: c, total: t }); } });
  if (isAborted()) return;
  const entries = targets.map((u) => ({ username: u, rank: rankMap.get(u.toLowerCase()) ?? null }));
  const dash = assembleDashboard({ slug, contest: cInfo, leaderboard: entries, questions, userMap, reference });
  const saved = await db.saveScrape(slug, dash); invalidateScrapeCache(slug); pruneScrapesFor(slug);
  send('done', { ...saved, summary: dash.summary, contest: dash.contest, source, capped });
}

// Scrape a college's contest with live progress (SSE).
app.get('/api/scrape-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  let aborted = false; req.on('close', () => { aborted = true; });
  try {
    const { adminToken, hrToken, contestId } = req.query;
    if (!adminToken || (!verifyAdminToken(adminToken) && !adminTokens.has(adminToken))) { send('failed', { error: 'Admin auth required.' }); return res.end(); }
    let session = hrSessions.get(hrToken);
    if (!session) {
      try { session = await getEnvHrSession(); }
      catch (e) { send('failed', { error: e.message || 'Connect your HackerRank account first or configure HR_EMAIL/HR_PASS in .env.' }); return res.end(); }
    }
    const ct = await db.getContest(contestId);
    if (!ct || !ct.slug) { send('failed', { error: 'Course has no link.' }); return res.end(); }
    await streamSingleContestScrape({ session, contest: ct, send, isAborted: () => aborted });
    res.end();
  } catch (e) { send('failed', { error: e.message }); res.end(); }
});

// Sync EVERY contest across EVERY college, using the admin's connected
// HackerRank session. Streams per-contest progress; one failure doesn't stop the run.
app.get('/api/sync-all-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  let aborted = false; req.on('close', () => { aborted = true; });
  try {
    const { adminToken, hrToken } = req.query;
    if (!adminToken || (!verifyAdminToken(adminToken) && !adminTokens.has(adminToken))) { send('failed', { error: 'Admin auth required.' }); return res.end(); }
    let session = hrSessions.get(hrToken);
    if (!session) {
      try { session = await getEnvHrSession(); }
      catch (e) { send('failed', { error: e.message || 'Connect your HackerRank account first or configure HR_EMAIL/HR_PASS in .env.' }); return res.end(); }
    }
    const contests = (await db.listContests()).filter((c) => c.slug);
    if (!contests.length) { send('failed', { error: 'No contests have a HackerRank link yet.' }); return res.end(); }
    send('start', { total: contests.length });
    let ok = 0; const failures = [];
    for (let i = 0; i < contests.length && !aborted; i++) {
      const c = contests[i];
      const at = { index: i + 1, total: contests.length, name: c.name, college: c.college };
      send('contest', at);
      try {
        // NB: `total` here is the user count — keep it distinct from at.total (contest count).
        const r = await scrapeAndSave(session, c, (completed, total) => { if (!aborted) send('progress', { ...at, completed, totalUsers: total }); });
        ok++; send('contest-done', { ...at, users: r.users });
      } catch (e) {
        failures.push(`${c.college} / ${c.name}: ${e.message}`);
        send('contest-failed', { ...at, error: e.message });
      }
    }
    if (!aborted) send('done', { ok, total: contests.length, failures });
    res.end();
  } catch (e) { send('failed', { error: e.message }); res.end(); }
});

// Topic of a question: admin-assigned, else parsed from "Topic - Title".
function titleTag(name) { const m = String(name).split(/\s+[–—-]\s+/); return m.length >= 2 ? m[0].trim() : ''; }
function resolveTopic(saved, name) { return (saved && saved[name]) || titleTag(name) || 'Other'; }

// Latest scrape for a contest (admin) — used by the dashboard students table.
app.get('/api/contest-dashboard/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const [dash, topics, categories, students] = await Promise.all([
      contest.slug ? cachedLatestScrape(contest.slug) : null,
      contest.slug ? db.getTopics(contest.slug) : {},
      contest.slug ? db.getQuestionCategories(contest.slug) : {},
      db.listStudentsForContest(contest.id),
    ]);
    res.json({ contest, college: contest.college, dashboard: dash, topics, categories, students });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Topics editor (admin): list questions + current topics for a contest.
app.get('/api/topics/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const dash = contest.slug ? await cachedLatestScrape(contest.slug) : null;
    const saved = contest.slug ? await db.getTopics(contest.slug) : {};
    const cats = contest.slug ? await db.getQuestionCategories(contest.slug) : {};
    const questions = dash ? dash.questions.map((q) => ({ name: q.name, topic: saved[q.name] || '', suggested: titleTag(q.name), category: cats[q.name] || '' })) : [];
    res.json({ contest, slug: contest.slug, contestUrl: contest.contestUrl || '', hasScrape: !!dash, questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/topics/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest || !contest.slug) return res.status(400).json({ error: 'Course has no link.' });
    res.json({ ok: true, ...(await db.saveTopics(contest.slug, req.body?.map || {})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Distinct topics of a contest (from saved topics / title fallback).
async function distinctTopics(slug, dash) {
  const saved = await db.getTopics(slug);
  const seen = new Set(); const out = [];
  for (const q of (dash?.questions || [])) { const t = resolveTopic(saved, q.name); if (!seen.has(t)) { seen.add(t); out.push(t); } }
  return out;
}
// Topic videos editor (admin)
app.get('/api/topic-videos/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const dash = contest.slug ? await cachedLatestScrape(contest.slug) : null;
    const videos = contest.slug ? await db.getTopicVideos(contest.slug) : {};
    const topics = (await distinctTopics(contest.slug, dash)).map((t) => ({ name: t, videos: videos[t] || [] }));
    res.json({ contest, hasScrape: !!dash, topics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/topic-videos/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest || !contest.slug) return res.status(400).json({ error: 'Course has no link.' });
    res.json({ ok: true, ...(await db.saveTopicVideos(contest.slug, req.body?.map || {})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Question categories (In-class / Post-class / Challenges)
app.get('/api/question-categories/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const dash = contest.slug ? await cachedLatestScrape(contest.slug) : null;
    const cats = contest.slug ? await db.getQuestionCategories(contest.slug) : {};
    const questions = dash ? dash.questions.map((q) => ({ name: q.name, category: cats[q.name] || '' })) : [];
    res.json({ contest, hasScrape: !!dash, questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/question-categories/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest || !contest.slug) return res.status(400).json({ error: 'Course has no link.' });
    res.json({ ok: true, ...(await db.saveQuestionCategories(contest.slug, req.body?.map || {})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Build per-student daily questions-completed from stored snapshots. Shared by
// the admin Daily tab and the read-only shared view.
// Calendar dates (UTC, matching how snapshots are bucketed) for the window
// ending today: index 0 is (N-1) days ago, last is today.
function lastNDates(n) {
  const now = new Date(); const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10));
  }
  return out;
}
async function computeDaily(contest, N = 10) {
  const [series, roster] = await Promise.all([
    contest.slug ? cachedScrapeSeries(contest.slug) : [],
    db.listStudentsForContest(contest.id),
  ]);
  const days = lastNDates(N);                         // always the last N calendar days
  const dayBefore = new Date(Date.parse(days[0] + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

  // Cumulative solved per snapshot day, carrying a student's last known count
  // forward so a missing entry doesn't read as a drop to zero.
  const resolved = []; let acc = {};
  for (const s of series) { acc = Object.assign({}, acc, s.solved); resolved.push({ day: s.day, solved: acc }); }
  // Latest snapshot on or before a given calendar date (null if none yet).
  const mapAt = (day) => { let m = null; for (const r of resolved) { if (r.day <= day) m = r.solved; else break; } return m; };
  const windowMaps = days.map(mapAt);
  const beforeMap = mapAt(dayBefore);

  const students = roster.map((s) => {
    const key = (s.usernameKey || s.hrUsername || '').toLowerCase();
    let prev = beforeMap && beforeMap[key] != null ? beforeMap[key] : 0; // baseline from before the window
    const daily = windowMaps.map((m) => {
      const cur = m && m[key] != null ? m[key] : prev; // no snapshot that day -> no change
      const delta = Math.max(0, cur - prev);
      prev = cur;
      return delta;
    });
    return { id: s.id, name: s.name, hrUsername: s.hrUsername, department: s.department, section: s.section, year: s.year, campus: s.campus, registerNo: s.registerNo, email: s.email, daily, total: prev };
  }).sort((a, b) => b.total - a.total);
  return { days, students };
}

// Per-student daily questions-completed (derived from daily snapshots).
app.get('/api/daily/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const N = Math.min(Math.max(parseInt(req.query.days, 10) || 10, 1), 60); // last N days (default 10)
    const { days, students } = await computeDaily(contest, N);
    res.json({ contest: { name: contest.name }, days, students });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Student portal (access code) ----------------
app.post('/api/student/login', async (req, res) => {
  try {
    const { college, accessCode } = req.body || {};
    if (!college || !accessCode) return res.status(400).json({ error: 'College and access code are required.' });
    if (!(await db.verifyCollegeCode(college, accessCode))) return res.status(401).json({ error: 'Wrong college or access code.' });
    const c = await db.getCollegeByName(college);
    const students = (await db.listStudents({ college: c.name })).map((s) => ({ name: s.name, hrUsername: s.hrUsername }));
    res.json({ ok: true, college: c.name, students });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Contests visible to a specific student (only the ones they're mapped to).
app.post('/api/student/contests', async (req, res) => {
  try {
    const { college, accessCode, hrUsername } = req.body || {};
    if (!(await db.verifyCollegeCode(college, accessCode))) return res.status(401).json({ error: 'Wrong college or access code.' });
    const c = await db.getCollegeByName(college);
    res.json({ contests: (await db.listContestsForStudent(c.name, hrUsername)).map((ct) => ({ id: ct.id, name: ct.name })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/student/practice', async (req, res) => {
  try {
    const { college, accessCode, hrUsername, contestId } = req.body || {};
    if (!(await db.verifyCollegeCode(college, accessCode))) return res.status(401).json({ error: 'Wrong college or access code.' });
    const c = await db.getCollegeByName(college);
    // Choose the requested contest, else the college's first contest.
    const contests = await db.listContests(c.name);
    const ct = contests.find((x) => String(x.id) === String(contestId)) || contests[0];
    const slug = ct?.slug || c.slug;
    const dash = slug ? await cachedLatestScrape(slug) : null;
    let contest = null, questions = [], stats = null, topicVideos = {};
    if (dash) {
      contest = { name: (ct && ct.name) || dash.contest.name };
      topicVideos = await db.getTopicVideos(slug);
      const saved = await db.getTopics(slug);
      const cats = await db.getQuestionCategories(slug);
      const u = dash.users.find((x) => x.username.toLowerCase() === String(hrUsername).toLowerCase());
      questions = dash.questions.map((q) => {
        const st = (u && u.questionStatus[q.name]) || { score: 0, points: q.points, solved: false, attempted: false };
        return { name: q.name, url: q.url, points: q.points, topic: resolveTopic(saved, q.name), category: cats[q.name] || '', score: st.score || 0, solved: !!st.solved, attempted: !!st.attempted };
      });
      const total = dash.questions.length;
      const sorted = dash.users.slice().sort((a, b) => b.computedScore - a.computedScore);
      const rank = u ? sorted.findIndex((x) => x.username === u.username) + 1 : null;
      stats = {
        inContest: !!u, solved: u ? u.solved : 0, total, score: u ? u.computedScore : 0,
        attempted: u ? u.attempted : 0, completion: total ? Math.round(((u ? u.solved : 0) / total) * 100) : 0,
        rank, participants: dash.users.length,
      };
    }
    res.json({ contest, questions, hrUsername, stats, topicVideos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Which tabs the shared (read-only) views may show. Global, default all on.
async function getSharedTabs() {
  const raw = await db.getSetting('shared_tabs');
  let t = {}; try { t = raw ? JSON.parse(raw) : {}; } catch { /* */ }
  return { dashboard: t.dashboard !== false, daily: t.daily !== false, attendance: t.attendance !== false };
}
app.get('/api/shared-tabs', requireAdmin, async (_req, res) => {
  try { res.json(await getSharedTabs()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/shared-tabs', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const t = { dashboard: !!b.dashboard, daily: !!b.daily, attendance: !!b.attendance };
    await db.setSetting('shared_tabs', JSON.stringify(t));
    res.json({ ok: true, ...t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Build the read-only payload for one contest (shared by contest + college links).
async function contestSharePayload(contest) {
  const [dash, topics, rosterRaw, topicVideos, categories, facets] = await Promise.all([
    contest.slug ? cachedLatestScrape(contest.slug) : null,
    contest.slug ? db.getTopics(contest.slug) : {},
    db.listStudentsForContest(contest.id),
    contest.slug ? db.getTopicVideos(contest.slug) : {},
    contest.slug ? db.getQuestionCategories(contest.slug) : {},
    db.getStudentFacets(contest.college),
  ]);
  const roster = rosterRaw.map((s) => ({ id: s.id, name: s.name, hrUsername: s.hrUsername, department: s.department, section: s.section, year: s.year, campus: s.campus, registerNo: s.registerNo, email: s.email }));
  const daily = await computeDaily(contest, 10);
  return { college: contest.college, contest: { name: contest.name }, dashboard: dash, topics, roster, topicVideos, categories, daily, facets, tabs: await getSharedTabs() };
}
async function collegeAttendance(collegeName) {
  const college = await db.getCollegeByName(collegeName);
  const url = college ? await db.getSetting(attKey(college.id)) : null;
  if (!url) return { sheets: [] };
  return fetchAttendance(url);
}

// ---------------- Read-only shared dashboard (contest token) ----------------
app.get('/api/shared/:token', async (req, res) => {
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    res.json(await contestSharePayload(contest));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/shared/:token/facets', async (req, res) => {
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    res.json(await db.getStudentFacets(contest.college));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/shared/:token/attendance', async (req, res) => {
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    res.json(await collegeAttendance(contest.college));
  } catch (e) { res.status(200).json({ error: e.message, sheets: [] }); }
});

// Read-only contest sync stream using server environment credentials (no prompt required)
app.get('/api/shared/:token/sync-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  let aborted = false; req.on('close', () => { aborted = true; });
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) { send('failed', { error: 'This link is invalid or was revoked.' }); return res.end(); }
    if (!contest.slug) { send('failed', { error: 'Course has no link.' }); return res.end(); }
    const session = await getEnvHrSession();
    await streamSingleContestScrape({ session, contest, send, isAborted: () => aborted });
    res.end();
  } catch (e) { send('failed', { error: e.message }); res.end(); }
});

app.post('/api/shared/:token/students', async (req, res) => {
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) return res.status(404).json({ error: 'This link is invalid or was revoked.' });

    const rawStudents = Array.isArray(req.body?.students)
      ? req.body.students
      : (req.body ? [req.body] : []);

    const cleanUser = (v) => {
      v = String(v || '').trim();
      if (!v) return '';
      if (v.includes('/')) { const p = v.split('/').filter(Boolean); return p[p.length - 1]; }
      return v.replace(/^@/, '');
    };

    const synthKey = (s, idx) => 'unmatched:' + String(s.registerNo || s.email || s.name || ('add_' + Date.now() + '_' + idx)).trim().toLowerCase();

    const prepared = [];
    rawStudents.forEach((s, idx) => {
      const raw = cleanUser(s.hrUsername || s.username || '');
      const lc = raw.toLowerCase();
      const valid = raw && !PLACEHOLDER_USERNAMES.has(lc);
      const usernameKey = valid ? lc : synthKey(s, idx);
      if (s.name || valid || s.registerNo || s.email) {
        prepared.push({
          name: String(s.name || raw || '').trim(),
          hrUsername: valid ? raw : '',
          usernameKey,
          registerNo: String(s.registerNo || '').trim(),
          email: String(s.email || '').trim(),
          campus: String(s.campus || '').trim(),
          department: String(s.department || '').trim(),
          section: String(s.section || '').trim(),
          year: String(s.year || '').trim(),
        });
      }
    });

    if (!prepared.length) {
      return res.status(400).json({ error: 'Please provide at least a student name or HackerRank username.' });
    }

    await db.upsertStudents(contest.college, prepared);
    if (contest.id) {
      await db.assignStudentsToContest(contest.id, prepared.map((s) => s.usernameKey));
    }

    const collegeStudents = await db.listStudents({ college: contest.college });
    const keySet = new Set(prepared.map((s) => s.usernameKey));
    const addedList = collegeStudents.filter((s) => keySet.has(s.usernameKey));

    res.json({ ok: true, count: prepared.length, students: addedList, student: addedList[0] || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/shared/:token/students/:id', async (req, res) => {
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const cur = await db.getStudent(req.params.id);
    if (!cur || cur.college !== contest.college) return res.status(403).json({ error: 'Student not found in this course.' });
    const updated = await db.updateStudent(req.params.id, { ...req.body, college: contest.college });
    res.json({ ok: true, student: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------- College-wide share link ----------------
// Token stored both ways in app_settings for O(1) lookup, no schema change.
async function collegeIdForToken(token) { return token ? await db.getSetting('college_token:' + token) : null; }
app.post('/api/colleges/:id/share', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const colleges = await db.listColleges();
    const college = colleges.find((c) => String(c.id) === id);
    if (!college) return res.status(404).json({ error: 'College not found.' });
    let token = await db.getSetting('college_share:' + id);
    if (!token) {
      token = crypto.randomBytes(9).toString('hex');
      await db.setSetting('college_share:' + id, token);
      await db.setSetting('college_token:' + token, id);
    }
    res.json({ ok: true, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Contests in a college for a share token.
app.get('/api/college/:token/contests', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    if (!college) return res.status(404).json({ error: 'College not found.' });
    const contests = (await db.listContests(college.name)).map((c) => ({ id: c.id, name: c.name, hasLink: !!c.slug }));
    res.json({ college: college.name, contests, tabs: await getSharedTabs() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// One contest's data via the college token (contest must belong to the college).
app.get('/api/college/:token/contest/:contestId', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    const contest = await db.getContest(req.params.contestId);
    if (!college || !contest || contest.college !== college.name) return res.status(404).json({ error: 'Course not found for this link.' });
    res.json(await contestSharePayload(contest));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/college/:token/attendance', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'Invalid link.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    res.json(await collegeAttendance(college ? college.name : ''));
  } catch (e) { res.status(200).json({ error: e.message, sheets: [] }); }
});
app.get('/api/college/:token/facets', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    if (!college) return res.status(404).json({ error: 'College not found.' });
    res.json(await db.getStudentFacets(college.name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Read-only college sync stream using server environment credentials (no prompt required)
app.get('/api/college/:token/sync-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  let aborted = false; req.on('close', () => { aborted = true; });
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) { send('failed', { error: 'This link is invalid or was revoked.' }); return res.end(); }
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    if (!college) { send('failed', { error: 'College not found.' }); return res.end(); }
    const session = await getEnvHrSession();

    const { contestId } = req.query;
    if (contestId && contestId !== 'all') {
      const contest = await db.getContest(contestId);
      if (!contest || contest.college !== college.name) { send('failed', { error: 'Course not found in this college.' }); return res.end(); }
      if (!contest.slug) { send('failed', { error: 'This course has no link.' }); return res.end(); }
      await streamSingleContestScrape({ session, contest, send, isAborted: () => aborted });
      return res.end();
    }

    // Sync all contests in this college
    const contests = (await db.listContests(college.name)).filter((c) => c.slug);
    if (!contests.length) { send('failed', { error: 'No courses with links found for this college.' }); return res.end(); }
    send('start', { total: contests.length, college: college.name });
    let ok = 0; const failures = [];
    for (let i = 0; i < contests.length && !aborted; i++) {
      const c = contests[i];
      const at = { index: i + 1, total: contests.length, name: c.name, college: college.name };
      send('contest', at);
      try {
        const r = await scrapeAndSave(session, c, (completed, total) => { if (!aborted) send('progress', { ...at, completed, totalUsers: total }); });
        ok++; send('contest-done', { ...at, users: r.users });
      } catch (e) {
        failures.push(`${c.name}: ${e.message}`);
        send('contest-failed', { ...at, error: e.message });
      }
    }
    if (!aborted) send('done', { ok, total: contests.length, failures, college: college.name });
    res.end();
  } catch (e) { send('failed', { error: e.message }); res.end(); }
});

app.post('/api/college/:token/students', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    if (!college) return res.status(404).json({ error: 'College not found.' });

    const { contestId } = req.body || {};
    const rawStudents = Array.isArray(req.body?.students)
      ? req.body.students
      : (req.body ? [req.body] : []);

    const cleanUser = (v) => {
      v = String(v || '').trim();
      if (!v) return '';
      if (v.includes('/')) { const p = v.split('/').filter(Boolean); return p[p.length - 1]; }
      return v.replace(/^@/, '');
    };

    const synthKey = (s, idx) => 'unmatched:' + String(s.registerNo || s.email || s.name || ('add_' + Date.now() + '_' + idx)).trim().toLowerCase();

    const prepared = [];
    rawStudents.forEach((s, idx) => {
      const raw = cleanUser(s.hrUsername || s.username || '');
      const lc = raw.toLowerCase();
      const valid = raw && !PLACEHOLDER_USERNAMES.has(lc);
      const usernameKey = valid ? lc : synthKey(s, idx);
      if (s.name || valid || s.registerNo || s.email) {
        prepared.push({
          name: String(s.name || raw || '').trim(),
          hrUsername: valid ? raw : '',
          usernameKey,
          registerNo: String(s.registerNo || '').trim(),
          email: String(s.email || '').trim(),
          campus: String(s.campus || '').trim(),
          department: String(s.department || '').trim(),
          section: String(s.section || '').trim(),
          year: String(s.year || '').trim(),
        });
      }
    });

    if (!prepared.length) {
      return res.status(400).json({ error: 'Please provide at least a student name or HackerRank username.' });
    }

    await db.upsertStudents(college.name, prepared);

    if (contestId) {
      const contest = await db.getContest(contestId);
      if (contest && contest.college === college.name) {
        await db.assignStudentsToContest(contest.id, prepared.map((s) => s.usernameKey));
      }
    }

    const collegeStudents = await db.listStudents({ college: college.name });
    const keySet = new Set(prepared.map((s) => s.usernameKey));
    const addedList = collegeStudents.filter((s) => keySet.has(s.usernameKey));

    res.json({ ok: true, count: prepared.length, students: addedList, student: addedList[0] || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/college/:token/students/:id', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    if (!college) return res.status(404).json({ error: 'College not found.' });
    const cur = await db.getStudent(req.params.id);
    if (!cur || cur.college !== college.name) return res.status(403).json({ error: 'Student not found in this college.' });
    const updated = await db.updateStudent(req.params.id, { ...req.body, college: college.name });
    res.json({ ok: true, student: updated });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get(['/view/:token', '/view/:token/'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'view.html')));
app.get(['/college/:token', '/college/:token/'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'view.html')));
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get(['/student', '/student/'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------------- Automatic sync (scheduled) ----------------
const autoState = { lastRun: null, lastResult: null, running: false };
async function autoSyncAll() {
  if (autoState.running) return;
  autoState.running = true;
  try {
    const session = await getEnvHrSession();
    const contests = (await db.listContests()).filter((c) => c.slug);
    let ok = 0; const errs = [];
    for (const c of contests) { try { await scrapeAndSave(session, c); ok++; } catch (e) { errs.push(`${c.slug}: ${e.message}`); } }
    autoState.lastRun = new Date().toISOString();
    autoState.lastResult = `${ok}/${contests.length} courses synced${errs.length ? ' · ' + errs.length + ' failed' : ''}`;
    console.log('[auto-sync]', autoState.lastResult);
  } catch (e) {
    autoState.lastRun = new Date().toISOString();
    autoState.lastResult = 'failed: ' + e.message;
    console.warn('[auto-sync] failed:', e.message);
  } finally { autoState.running = false; }
}
app.get('/api/auto-sync/status', requireAdmin, (_req, res) => res.json({ enabled: AUTO_SYNC, times: AUTO_TIMES, tz: AUTO_TZ, hasCreds: MOCK || !!(HR_EMAIL && HR_PASS), lastRun: autoState.lastRun, lastResult: autoState.lastResult, running: autoState.running }));
app.post('/api/auto-sync/run', requireAdmin, (_req, res) => { autoSyncAll(); res.json({ ok: true }); });
// Keyed trigger for an EXTERNAL scheduler (cron-job.org, Render Cron, GitHub
// Actions) — reliable on hosts whose in-process timers don't fire (e.g. Render
// free instances that sleep). Set AUTO_SYNC_KEY to a secret and call:
//   GET/POST /api/auto-sync/trigger?key=<AUTO_SYNC_KEY>
app.all('/api/auto-sync/trigger', (req, res) => {
  const key = req.query.key || req.get('x-sync-key');
  if (!process.env.AUTO_SYNC_KEY) return res.status(403).json({ error: 'Trigger disabled — set AUTO_SYNC_KEY.' });
  if (key !== process.env.AUTO_SYNC_KEY) return res.status(403).json({ error: 'Bad key.' });
  if (autoState.running) return res.json({ ok: true, alreadyRunning: true });
  autoSyncAll();
  res.json({ ok: true, started: true });
});

// Time (and date key) in the configured timezone, so AUTO_SYNC_TIMES are the
// admin's wall-clock times regardless of where the server runs (e.g. UTC hosts).
const AUTO_TZ = process.env.AUTO_SYNC_TZ || 'Asia/Kolkata';
function nowInTz() {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: AUTO_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t).value;
    return { hhmm: `${g('hour')}:${g('minute')}`, date: `${g('year')}-${g('month')}-${g('day')}` };
  } catch { const d = new Date(); return { hhmm: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'), date: d.toDateString() }; }
}
if (AUTO_SYNC) {
  let lastSlot = '';
  setInterval(() => {
    const { hhmm, date } = nowInTz();
    const slot = date + ' ' + hhmm;
    if (AUTO_TIMES.includes(hhmm) && lastSlot !== slot) { lastSlot = slot; console.log('[auto-sync] triggering scheduled run at', hhmm, AUTO_TZ); autoSyncAll(); }
  }, 30 * 1000).unref?.();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, mock: MOCK, storage: db.storageBackend() }));

if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;

