import express from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, createJar, parseContestSlug, fetchAllLeaderboard, buildMatrix } from './lib/hackerrank.js';
import { buildMockDashboard } from './lib/mock.js';
import { buildCourseWorkbook, buildCollegeWorkbook, buildStudentWorkbook } from './lib/excel-export.js';
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

// ---------------- Contests (many per college, semester-organized) ----------------
app.get('/api/contests', requireAdmin, async (req, res) => {
  try {
    let college;
    if (req.query.collegeId) { const c = (await db.listColleges()).find((x) => String(x.id) === String(req.query.collegeId)); college = c?.name; }
    else if (req.query.college) college = String(req.query.college);
    const semester = req.query.semester ? String(req.query.semester).trim() : undefined;
    const includeArchived = req.query.includeArchived !== 'false';
    res.json({ contests: await db.listContests(college, { semester, includeArchived }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/contests', requireAdmin, async (req, res) => {
  try {
    const { collegeId, name, contestUrl, semester } = req.body || {};
    const col = (await db.listColleges()).find((x) => String(x.id) === String(collegeId));
    if (!col) return res.status(400).json({ error: 'College not found.' });
    const c = await db.addContest({
      college: col.name,
      name,
      contestUrl: contestUrl || '',
      slug: slugFromUrl(contestUrl),
      semester: semester || '',
    });
    res.json({ ok: true, contest: c });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/contests/:id', requireAdmin, async (req, res) => {
  try {
    const { name, contestUrl, semester, primaryLabel, isArchived, force } = req.body || {};
    const cur = await db.getContest(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Course not found.' });
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (semester !== undefined) fields.semester = semester;
    if (primaryLabel !== undefined) fields.primaryLabel = primaryLabel;
    if (isArchived !== undefined) fields.isArchived = !!isArchived;
    if (contestUrl !== undefined) {
      const nextSlug = slugFromUrl(contestUrl);
      if (cur.slug && nextSlug !== cur.slug && !force && (await db.hasScrapeData(cur.slug))) {
        return res.status(409).json({
          code: 'PROGRESS_EXISTS',
          existingSlug: cur.slug,
          error: `This course already has saved progress for "${cur.slug}". Add another labeled link to this course instead of overwriting this link.`,
        });
      }
      fields.contestUrl = contestUrl;
      fields.slug = nextSlug;
    }
    const c = await db.updateContest(req.params.id, fields);
    res.json({ ok: true, contest: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/contests/:id/archive', requireAdmin, async (req, res) => {
  try {
    const isArchived = req.body?.isArchived !== false;
    const c = await db.archiveContest(req.params.id, isArchived);
    if (!c) return res.status(404).json({ error: 'Course not found.' });
    res.json({ ok: true, contest: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Additional labeled contest links attached to an existing course
app.get('/api/contests/:id/links', requireAdmin, async (req, res) => {
  try {
    const c = await db.getContest(req.params.id);
    if (!c) return res.status(404).json({ error: 'Course not found.' });
    res.json({ contest: c, links: c.links || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/contests/:id/links', requireAdmin, async (req, res) => {
  try {
    const c = await db.getContest(req.params.id);
    if (!c) return res.status(404).json({ error: 'Course not found.' });
    const { label, contestUrl } = req.body || {};
    const slug = slugFromUrl(contestUrl);
    if (!slug) return res.status(400).json({ error: 'Paste a valid HackerRank contest link.' });
    const link = await db.addContestLink({ contestId: c.id, label, contestUrl: String(contestUrl || '').trim(), slug });
    const updated = await db.getContest(c.id);
    res.json({ ok: true, link, contest: updated, links: updated.links || [] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/contests/:id/links/:linkId', requireAdmin, async (req, res) => {
  try {
    const c = await db.getContest(req.params.id);
    if (!c) return res.status(404).json({ error: 'Course not found.' });
    const { label, contestUrl, force } = req.body || {};
    if (req.params.linkId === 'primary') {
      const fields = {};
      if (label !== undefined) fields.primaryLabel = label;
      if (contestUrl !== undefined) {
        const nextSlug = slugFromUrl(contestUrl);
        if (c.slug && nextSlug !== c.slug && !force && (await db.hasScrapeData(c.slug))) {
          return res.status(409).json({
            code: 'PROGRESS_EXISTS',
            existingSlug: c.slug,
            error: `The primary link already has saved progress for "${c.slug}". Add another labeled link instead of overwriting it.`,
          });
        }
        fields.contestUrl = contestUrl;
        fields.slug = nextSlug;
      }
      const updated = await db.updateContest(c.id, fields);
      return res.json({ ok: true, contest: updated, links: updated.links || [] });
    }
    const cur = await db.getContestLink(req.params.linkId);
    if (!cur || cur.contestId !== c.id) return res.status(404).json({ error: 'Link not found for this course.' });
    const fields = {};
    if (label !== undefined) fields.label = label;
    if (contestUrl !== undefined) {
      const nextSlug = slugFromUrl(contestUrl);
      if (cur.slug && nextSlug !== cur.slug && !force && (await db.hasScrapeData(cur.slug))) {
        return res.status(409).json({
          code: 'PROGRESS_EXISTS',
          existingSlug: cur.slug,
          error: `Link "${cur.label}" already has saved progress for "${cur.slug}". Add a new labeled link instead of overwriting it.`,
        });
      }
      fields.contestUrl = contestUrl;
      fields.slug = nextSlug;
    }
    await db.updateContestLink(cur.id, fields);
    const updated = await db.getContest(c.id);
    res.json({ ok: true, contest: updated, links: updated.links || [] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/contests/:id/links/:linkId', requireAdmin, async (req, res) => {
  try {
    const c = await db.getContest(req.params.id);
    if (!c) return res.status(404).json({ error: 'Course not found.' });
    if (req.params.linkId === 'primary') return res.status(400).json({ error: 'Cannot delete the primary course link.' });
    const cur = await db.getContestLink(req.params.linkId);
    if (!cur || cur.contestId !== c.id) return res.status(404).json({ error: 'Link not found for this course.' });
    await db.deleteContestLink(cur.id);
    const updated = await db.getContest(c.id);
    res.json({ ok: true, contest: updated, links: updated.links || [] });
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

// ---------------- Multi-link Course Helpers ----------------
function getEffectiveLinks(contest) {
  if (!contest) return [];
  if (Array.isArray(contest.links) && contest.links.length) return contest.links;
  return [{
    id: 'primary',
    contestId: contest.id,
    label: contest.primaryLabel || contest.semester || 'Main',
    contestUrl: contest.contestUrl || '',
    slug: contest.slug || '',
    isPrimary: true,
  }];
}

function resolveSelectedLink(contest, linkId) {
  const links = getEffectiveLinks(contest);
  const reqId = String(linkId || '').trim();
  if (reqId === 'all' && links.length > 1) {
    return { mode: 'all', link: null, links, activeLinkId: 'all' };
  }
  if (reqId && reqId !== 'all') {
    const found = links.find((l) => String(l.id) === reqId);
    if (found) return { mode: 'single', link: found, links, activeLinkId: String(found.id) };
  }
  const first = links[0] || null;
  return { mode: 'single', link: first, links, activeLinkId: first ? String(first.id) : 'primary' };
}

function expandScrapeJobs(contests) {
  const jobs = [];
  for (const c of contests) {
    const links = getEffectiveLinks(c).filter((l) => l.slug);
    for (const l of links) {
      const displayName = links.length > 1 ? `${c.name} [${l.label}]` : c.name;
      jobs.push({ ...c, slug: l.slug, contestUrl: l.contestUrl, name: displayName, linkLabel: l.label });
    }
  }
  return jobs;
}

async function loadCombinedContestData(contest, links) {
  const validLinks = links.filter((l) => l.slug);
  const perLink = await Promise.all(validLinks.map(async (l) => {
    const [dash, topics, categories, topicVideos] = await Promise.all([
      cachedLatestScrape(l.slug),
      db.getTopics(l.slug),
      db.getQuestionCategories(l.slug),
      db.getTopicVideos(l.slug),
    ]);
    return { link: l, dash, topics, categories, topicVideos };
  }));
  const synced = perLink.filter((x) => x.dash);
  if (!synced.length) return { dash: null, topics: {}, categories: {}, topicVideos: {} };

  const questions = [];
  const topics = {};
  const categories = {};
  const topicVideos = {};
  const usersByKey = new Map();

  for (const item of synced) {
    const prefix = `[${item.link.label}] `;
    const qList = item.dash.questions || [];
    for (const q of qList) {
      const qKey = prefix + q.name;
      questions.push({ ...q, name: qKey });
      topics[qKey] = resolveTopic(item.topics, q.name);
      if (item.categories[q.name]) categories[qKey] = item.categories[q.name];
    }
    for (const [t, vids] of Object.entries(item.topicVideos || {})) {
      if (!topicVideos[t]) topicVideos[t] = [];
      for (const v of vids) if (!topicVideos[t].includes(v)) topicVideos[t].push(v);
    }
    for (const u of (item.dash.users || [])) {
      const uk = String(u.username || '').toLowerCase();
      if (!uk) continue;
      let rec = usersByKey.get(uk);
      if (!rec) {
        rec = { username: u.username, rank: null, computedScore: 0, solved: 0, attempted: 0, questionStatus: {} };
        usersByKey.set(uk, rec);
      }
      for (const q of qList) {
        const qKey = prefix + q.name;
        const st = u.questionStatus?.[q.name] || { score: 0, points: q.points || 0, attempted: false, solved: false };
        rec.questionStatus[qKey] = st;
        if (st.solved) rec.solved++;
        if (st.attempted) rec.attempted++;
        rec.computedScore += Number(st.score || 0);
      }
    }
  }
  // Ensure every user has entries for every question across all links
  const users = Array.from(usersByKey.values());
  for (const u of users) {
    for (const q of questions) {
      if (!u.questionStatus[q.name]) u.questionStatus[q.name] = { score: 0, points: q.points || 0, attempted: false, solved: false };
    }
  }
  const totalSolves = users.reduce((a, u) => a + u.solved, 0);
  const qc = questions.length;
  return {
    dash: {
      contest: { slug: contest.slug, name: `${contest.name} (All Links)`, challengesCount: qc },
      summary: {
        totalUsers: users.length,
        totalQuestions: qc,
        avgSolved: users.length ? +(totalSolves / users.length).toFixed(2) : 0,
        overallCompletion: users.length && qc ? Math.round((totalSolves / (users.length * qc)) * 100) : 0,
      },
      questions,
      users,
    },
    topics,
    categories,
    topicVideos,
  };
}

async function loadContestViewData(contest, linkId) {
  const sel = resolveSelectedLink(contest, linkId);
  if (sel.mode === 'all') {
    const combined = await loadCombinedContestData(contest, sel.links);
    return { ...combined, links: sel.links, activeLinkId: 'all', activeLink: null };
  }
  const slug = sel.link?.slug || '';
  const [dash, topics, categories, topicVideos] = await Promise.all([
    slug ? cachedLatestScrape(slug) : null,
    slug ? db.getTopics(slug) : {},
    slug ? db.getQuestionCategories(slug) : {},
    slug ? db.getTopicVideos(slug) : {},
  ]);
  return { dash, topics, categories, topicVideos, links: sel.links, activeLinkId: sel.activeLinkId, activeLink: sel.link };
}

// Scrape a college's contest (one link or all links of the course) with live progress (SSE).
app.get('/api/scrape-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  let aborted = false; req.on('close', () => { aborted = true; });
  try {
    const { adminToken, hrToken, contestId, linkId } = req.query;
    if (!adminToken || (!verifyAdminToken(adminToken) && !adminTokens.has(adminToken))) { send('failed', { error: 'Admin auth required.' }); return res.end(); }
    let session = hrSessions.get(hrToken);
    if (!session) {
      try { session = await getEnvHrSession(); }
      catch (e) { send('failed', { error: e.message || 'Connect your HackerRank account first or configure HR_EMAIL/HR_PASS in .env.' }); return res.end(); }
    }
    const ct = await db.getContest(contestId);
    if (!ct) { send('failed', { error: 'Course not found.' }); return res.end(); }
    const sel = resolveSelectedLink(ct, linkId);
    if (sel.mode === 'all') {
      const jobs = expandScrapeJobs([ct]);
      if (!jobs.length) { send('failed', { error: 'Course has no links.' }); return res.end(); }
      let ok = 0; const failures = [];
      for (let i = 0; i < jobs.length && !aborted; i++) {
        const j = jobs[i];
        send('progress', { phase: 'comparing', completed: i, total: jobs.length, note: `Syncing ${j.linkLabel} (${i + 1}/${jobs.length})…` });
        try { await scrapeAndSave(session, j, (c, t) => { if (!aborted) send('progress', { phase: 'comparing', completed: c, total: t, note: `[${j.linkLabel}] ${c}/${t}` }); }); ok++; }
        catch (e) { failures.push(`${j.linkLabel}: ${e.message}`); }
      }
      if (!aborted) send('done', { summary: { totalUsers: ok, totalQuestions: jobs.length }, ok, total: jobs.length, failures });
      return res.end();
    }
    if (!sel.link || !sel.link.slug) { send('failed', { error: 'Selected link has no HackerRank URL.' }); return res.end(); }
    await streamSingleContestScrape({ session, contest: { ...ct, slug: sel.link.slug, contestUrl: sel.link.contestUrl }, send, isAborted: () => aborted });
    res.end();
  } catch (e) { send('failed', { error: e.message }); res.end(); }
});

// Sync EVERY contest & attached link across EVERY active college.
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
    const contests = await db.listContests(undefined, { includeArchived: false });
    const jobs = expandScrapeJobs(contests);
    if (!jobs.length) { send('failed', { error: 'No contests have a HackerRank link yet.' }); return res.end(); }
    send('start', { total: jobs.length });
    let ok = 0; const failures = [];
    for (let i = 0; i < jobs.length && !aborted; i++) {
      const c = jobs[i];
      const at = { index: i + 1, total: jobs.length, name: c.name, college: c.college };
      send('contest', at);
      try {
        const r = await scrapeAndSave(session, c, (completed, total) => { if (!aborted) send('progress', { ...at, completed, totalUsers: total }); });
        ok++; send('contest-done', { ...at, users: r.users });
      } catch (e) {
        failures.push(`${c.college} / ${c.name}: ${e.message}`);
        send('contest-failed', { ...at, error: e.message });
      }
    }
    if (!aborted) send('done', { ok, total: jobs.length, failures });
    res.end();
  } catch (e) { send('failed', { error: e.message }); res.end(); }
});

// Topic of a question: admin-assigned, else parsed from "Topic - Title".
function titleTag(name) { const m = String(name).split(/\s+[–—-]\s+/); return m.length >= 2 ? m[0].trim() : ''; }
function resolveTopic(saved, name) { return (saved && saved[name]) || titleTag(name) || 'Other'; }

// Latest scrape for a contest (admin) — supports ?linkId=primary|<id>|all.
app.get('/api/contest-dashboard/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const [view, students] = await Promise.all([
      loadContestViewData(contest, req.query.linkId),
      db.listStudentsForContest(contest.id),
    ]);
    res.json({
      contest,
      college: contest.college,
      dashboard: view.dash,
      topics: view.topics,
      categories: view.categories,
      links: view.links,
      activeLinkId: view.activeLinkId,
      students,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Formatted Excel Exports (Admin + Read-Only Shared) ----------------
function cleanFilename(s) {
  return String(s || 'report').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'report';
}
function requestOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return host ? `${proto}://${host}` : '';
}
function sendXlsx(res, buf, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${cleanFilename(filename)}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}
async function loadLinkExportData(contest, link, studentsOverride = null) {
  const slug = link?.slug || '';
  const [dash, topics, categories, students, prog] = await Promise.all([
    slug ? cachedLatestScrape(slug) : null,
    slug ? db.getTopics(slug) : {},
    slug ? db.getQuestionCategories(slug) : {},
    studentsOverride !== null ? Promise.resolve(studentsOverride) : db.listStudentsForContest(contest.id),
    slug ? db.getStudentProgressMap(slug) : { firstSolved: new Map() },
  ]);
  const multi = getEffectiveLinks(contest).length > 1;
  const virtualContest = multi
    ? { ...contest, name: `${contest.name} — ${link.label}`, semester: link.label || contest.semester, slug: link.slug, contestUrl: link.contestUrl }
    : { ...contest, semester: contest.semester || (link?.label !== 'Main' ? link?.label : '') };
  return { contest: virtualContest, dash, topics, categories, students, firstSolvedMap: prog.firstSolved };
}
function semFromLinkLabel(label) {
  const m = String(label || '').trim().match(/^(Sem\s*\d+)/i);
  return m ? ('Sem ' + m[1].replace(/\D+/g, '')) : '';
}
async function expandContestExportData(contest, studentsOverride = null, semesterFilter = '') {
  const links = getEffectiveLinks(contest);
  const out = [];
  for (const l of links) {
    if (semesterFilter) {
      const linkSem = semFromLinkLabel(l.label) || String(contest.semester || '').trim();
      if (linkSem.toLowerCase() !== semesterFilter.toLowerCase()) continue;
    }
    out.push(await loadLinkExportData(contest, l, studentsOverride));
  }
  return out;
}
function filterStudentsByQuery(students, query = {}) {
  const { campus = '', department = '', section = '', year = '', q = '' } = query;
  const ql = String(q || '').trim().toLowerCase();
  const filtered = (students || []).filter((s) =>
    (!campus || s.campus === campus) &&
    (!department || s.department === department) &&
    (!section || s.section === section) &&
    (!year || s.year === year) &&
    (!ql || (s.name || '').toLowerCase().includes(ql) || (s.hrUsername || '').toLowerCase().includes(ql) || (s.registerNo || '').toLowerCase().includes(ql))
  );
  const filterParts = [
    campus && `Campus=${campus}`,
    department && `Dept=${department}`,
    section && `Sec=${section}`,
    year && `Year=${year}`,
    ql && `Search="${q}"`,
  ].filter(Boolean);
  return { filtered, filterSummary: filterParts.join(', ') };
}
async function exportSingleCourseResponse({ contest, linkId, query, origin, res }) {
  const sel = resolveSelectedLink(contest, linkId);
  const baseStudents = await db.listStudentsForContest(contest.id);
  const { filtered, filterSummary } = filterStudentsByQuery(baseStudents, query);

  if (sel.mode === 'all' && sel.links.length > 1) {
    const coursesData = [];
    for (const l of sel.links) coursesData.push(await loadLinkExportData(contest, l, filtered));
    if (!coursesData.some((d) => d.dash)) {
      return res.status(400).json({ error: 'No synced results for this course yet — sync first, then export.' });
    }
    const shareUrl = contest.shareToken && origin ? `${origin}/view/${contest.shareToken}` : '';
    const buf = await buildCollegeWorkbook({
      collegeName: `${contest.college} — ${contest.name}`,
      collegeShareUrl: shareUrl,
      semesterFilter: filterSummary ? `All Links (${filterSummary})` : 'All Links',
      coursesData,
      allStudents: filtered,
      shareOrigin: origin,
    });
    return sendXlsx(res, buf, `${contest.college}_${contest.name}_All_Links_Report`);
  }

  const data = await loadLinkExportData(contest, sel.link, filtered);
  if (!data.dash) return res.status(400).json({ error: 'No synced results for this link yet — sync first, then export.' });
  const buf = await buildCourseWorkbook({
    collegeName: contest.college,
    contest: data.contest,
    dash: data.dash,
    students: filtered,
    topics: data.topics,
    categories: data.categories,
    firstSolvedMap: data.firstSolvedMap,
    shareOrigin: origin,
    filterSummary,
  });
  const tag = sel.links.length > 1 && sel.link?.label ? `${sel.link.label}_` : (contest.semester ? `${contest.semester}_` : '');
  return sendXlsx(res, buf, `${contest.college}_${tag}${contest.name}_report`);
}

// Single course styled workbook (supports ?linkId=primary|<id>|all + student filters).
app.get('/api/export/course/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    await exportSingleCourseResponse({ contest, linkId: req.query.linkId, query: req.query, origin: requestOrigin(req), res });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// College-wide or semester-scoped multi-course styled workbook (includes all labeled links).
app.get('/api/export/college/:collegeId', requireAdmin, async (req, res) => {
  try {
    const colleges = await db.listColleges();
    const college = colleges.find((c) => String(c.id) === String(req.params.collegeId));
    if (!college) return res.status(404).json({ error: 'College not found.' });

    const semesterFilter = req.query.semester ? String(req.query.semester).trim() : '';
    const includeArchived = req.query.includeArchived !== 'false';
    const [allStudents, contests] = await Promise.all([
      db.listStudents({ college: college.name }),
      db.listContests(college.name, { includeArchived }),
    ]);

    const coursesData = [];
    for (const ct of contests) {
      coursesData.push(...(await expandContestExportData(ct, null, semesterFilter)));
    }

    const origin = requestOrigin(req);
    const collegeShareUrl = college.shareToken && origin ? `${origin}/college/${college.shareToken}` : '';
    const buf = await buildCollegeWorkbook({
      collegeName: college.name,
      collegeShareUrl,
      semesterFilter,
      coursesData,
      allStudents,
      shareOrigin: origin,
    });
    const semPart = semesterFilter ? `_${semesterFilter}` : '_All_Semesters';
    sendXlsx(res, buf, `${college.name}${semPart}_Completion_Report`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Individual student complete progress transcript across all semesters, courses & labeled links.
app.get('/api/export/student/:studentId', requireAdmin, async (req, res) => {
  try {
    const student = await db.getStudent(req.params.studentId);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const contests = await db.listContestsForStudent(student.college, student.usernameKey || student.hrUsername);
    const coursesData = [];
    for (const ct of contests) {
      coursesData.push(...(await expandContestExportData(ct, [student])));
    }
    const buf = await buildStudentWorkbook({
      student,
      coursesData,
      shareOrigin: requestOrigin(req),
    });
    const who = student.registerNo ? `${student.name}_${student.registerNo}` : (student.name || student.hrUsername);
    sendXlsx(res, buf, `${who}_Progress_Report`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Topics editor (admin): list questions + current topics for a contest (supports ?linkId=).
app.get('/api/topics/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const sel = resolveSelectedLink(contest, req.query.linkId);
    const activeLink = sel.link || sel.links[0] || null;
    const slug = activeLink?.slug || '';
    const dash = slug ? await cachedLatestScrape(slug) : null;
    const saved = slug ? await db.getTopics(slug) : {};
    const cats = slug ? await db.getQuestionCategories(slug) : {};
    const questions = dash ? dash.questions.map((q) => ({ name: q.name, topic: saved[q.name] || '', suggested: titleTag(q.name), category: cats[q.name] || '' })) : [];
    res.json({ contest, links: sel.links, activeLinkId: activeLink ? String(activeLink.id) : 'primary', slug, contestUrl: activeLink?.contestUrl || '', hasScrape: !!dash, questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/topics/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const sel = resolveSelectedLink(contest, req.body?.linkId || req.query.linkId);
    const slug = sel.link?.slug || '';
    if (!slug) return res.status(400).json({ error: 'Selected link has no HackerRank URL.' });
    res.json({ ok: true, ...(await db.saveTopics(slug, req.body?.map || {})) });
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
    const sel = resolveSelectedLink(contest, req.query.linkId);
    const slug = sel.link?.slug || '';
    const dash = slug ? await cachedLatestScrape(slug) : null;
    const videos = slug ? await db.getTopicVideos(slug) : {};
    const topics = slug ? (await distinctTopics(slug, dash)).map((t) => ({ name: t, videos: videos[t] || [] })) : [];
    res.json({ contest, hasScrape: !!dash, topics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/topic-videos/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const sel = resolveSelectedLink(contest, req.body?.linkId || req.query.linkId);
    const slug = sel.link?.slug || '';
    if (!slug) return res.status(400).json({ error: 'Selected link has no HackerRank URL.' });
    res.json({ ok: true, ...(await db.saveTopicVideos(slug, req.body?.map || {})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Question categories (In-class / Post-class / Challenges)
app.get('/api/question-categories/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const sel = resolveSelectedLink(contest, req.query.linkId);
    const slug = sel.link?.slug || '';
    const dash = slug ? await cachedLatestScrape(slug) : null;
    const cats = slug ? await db.getQuestionCategories(slug) : {};
    const questions = dash ? dash.questions.map((q) => ({ name: q.name, category: cats[q.name] || '' })) : [];
    res.json({ contest, hasScrape: !!dash, questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/question-categories/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const sel = resolveSelectedLink(contest, req.body?.linkId || req.query.linkId);
    const slug = sel.link?.slug || '';
    if (!slug) return res.status(400).json({ error: 'Selected link has no HackerRank URL.' });
    res.json({ ok: true, ...(await db.saveQuestionCategories(slug, req.body?.map || {})) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Build per-student daily questions-completed from stored snapshots. Shared by
// the admin Daily tab and the read-only shared view.
function lastNDates(n) {
  const now = new Date(); const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10));
  }
  return out;
}
function computeDailyFromSeries(series, roster, days) {
  const dayBefore = new Date(Date.parse(days[0] + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const resolved = []; let acc = {};
  for (const s of series) { acc = Object.assign({}, acc, s.solved); resolved.push({ day: s.day, solved: acc }); }
  const mapAt = (day) => { let m = null; for (const r of resolved) { if (r.day <= day) m = r.solved; else break; } return m; };
  const windowMaps = days.map(mapAt);
  const beforeMap = mapAt(dayBefore);
  return roster.map((s) => {
    const key = (s.usernameKey || s.hrUsername || '').toLowerCase();
    let prev = beforeMap && beforeMap[key] != null ? beforeMap[key] : 0;
    const daily = windowMaps.map((m) => {
      const cur = m && m[key] != null ? m[key] : prev;
      const delta = Math.max(0, cur - prev);
      prev = cur;
      return delta;
    });
    return { id: s.id, name: s.name, hrUsername: s.hrUsername, department: s.department, section: s.section, year: s.year, campus: s.campus, registerNo: s.registerNo, email: s.email, daily, total: prev };
  });
}
async function computeDaily(contest, N = 10, linkId = '') {
  const sel = resolveSelectedLink(contest, linkId);
  const roster = await db.listStudentsForContest(contest.id);
  const days = lastNDates(N);
  if (sel.mode === 'all' && sel.links.length > 1) {
    const slugs = sel.links.map((l) => l.slug).filter(Boolean);
    const allSeries = await Promise.all(slugs.map((sl) => cachedScrapeSeries(sl)));
    const combined = new Map();
    for (const s of roster) {
      combined.set(s.id, { id: s.id, name: s.name, hrUsername: s.hrUsername, department: s.department, section: s.section, year: s.year, campus: s.campus, registerNo: s.registerNo, email: s.email, daily: days.map(() => 0), total: 0 });
    }
    for (const series of allSeries) {
      const part = computeDailyFromSeries(series, roster, days);
      for (const p of part) {
        const dst = combined.get(p.id);
        if (!dst) continue;
        for (let i = 0; i < days.length; i++) dst.daily[i] += p.daily[i];
        dst.total += p.total;
      }
    }
    return { days, students: Array.from(combined.values()).sort((a, b) => b.total - a.total) };
  }
  const slug = sel.link?.slug || '';
  const series = slug ? await cachedScrapeSeries(slug) : [];
  const students = computeDailyFromSeries(series, roster, days).sort((a, b) => b.total - a.total);
  return { days, students };
}

// Per-student daily questions-completed (derived from daily snapshots).
app.get('/api/daily/:contestId', requireAdmin, async (req, res) => {
  try {
    const contest = await db.getContest(req.params.contestId);
    if (!contest) return res.status(404).json({ error: 'Course not found.' });
    const N = Math.min(Math.max(parseInt(req.query.days, 10) || 10, 1), 60); // last N days (default 10)
    const sel = resolveSelectedLink(contest, req.query.linkId);
    const { days, students } = await computeDaily(contest, N, req.query.linkId);
    res.json({ contest: { name: contest.name }, links: sel.links, activeLinkId: sel.activeLinkId, days, students });
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
    res.json({
      contests: (await db.listContestsForStudent(c.name, hrUsername)).map((ct) => ({
        id: ct.id,
        name: ct.name,
        semester: ct.semester || '',
        isArchived: !!ct.isArchived,
        links: getEffectiveLinks(ct).map((l) => ({ id: l.id, label: l.label, hasLink: !!l.slug })),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/student/practice', async (req, res) => {
  try {
    const { college, accessCode, hrUsername, contestId, linkId } = req.body || {};
    if (!(await db.verifyCollegeCode(college, accessCode))) return res.status(401).json({ error: 'Wrong college or access code.' });
    const c = await db.getCollegeByName(college);
    // Choose the requested contest, else the college's first contest.
    const contests = await db.listContests(c.name);
    const ct = contests.find((x) => String(x.id) === String(contestId)) || contests[0];
    const sel = ct ? resolveSelectedLink(ct, linkId) : null;
    const activeLink = sel?.link || null;
    const slug = activeLink?.slug || ct?.slug || c.slug;
    const dash = slug ? await cachedLatestScrape(slug) : null;
    let contest = null, questions = [], stats = null, topicVideos = {};
    if (dash) {
      const linkSuffix = sel && sel.links.length > 1 && activeLink?.label ? ` (${activeLink.label})` : '';
      contest = { name: ((ct && ct.name) || dash.contest.name) + linkSuffix, semester: (ct && ct.semester) || '', activeLinkId: sel?.activeLinkId || 'primary' };
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
    res.json({ contest, links: sel?.links || [], activeLinkId: sel?.activeLinkId || 'primary', questions, hrUsername, stats, topicVideos });
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
async function contestSharePayload(contest, linkId = '') {
  const [view, rosterRaw, facets] = await Promise.all([
    loadContestViewData(contest, linkId),
    db.listStudentsForContest(contest.id),
    db.getStudentFacets(contest.college),
  ]);
  const roster = rosterRaw.map((s) => ({ id: s.id, name: s.name, hrUsername: s.hrUsername, department: s.department, section: s.section, year: s.year, campus: s.campus, registerNo: s.registerNo, email: s.email }));
  const daily = await computeDaily(contest, 10, view.activeLinkId);
  return {
    college: contest.college,
    contest: { id: contest.id, name: contest.name, semester: contest.semester || '', isArchived: !!contest.isArchived },
    links: view.links,
    activeLinkId: view.activeLinkId,
    dashboard: view.dash,
    topics: view.topics,
    roster,
    topicVideos: view.topicVideos,
    categories: view.categories,
    daily,
    facets,
    tabs: await getSharedTabs(),
  };
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
    res.json(await contestSharePayload(contest, req.query.linkId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/shared/:token/export', async (req, res) => {
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    await exportSingleCourseResponse({ contest, linkId: req.query.linkId, query: req.query, origin: requestOrigin(req), res });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/shared/:token/export/student/:studentId', async (req, res) => {
  try {
    const contest = await db.getContestByShareToken(req.params.token);
    if (!contest) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const student = await db.getStudent(req.params.studentId);
    if (!student || student.college !== contest.college) return res.status(403).json({ error: 'Student not found in this course.' });
    const coursesData = await expandContestExportData(contest, [student]);
    const buf = await buildStudentWorkbook({ student, coursesData, shareOrigin: requestOrigin(req) });
    const who = student.registerNo ? `${student.name}_${student.registerNo}` : (student.name || student.hrUsername);
    sendXlsx(res, buf, `${who}_${contest.name}_Progress`);
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
    const sel = resolveSelectedLink(contest, req.query.linkId);
    const session = await getEnvHrSession();
    if (sel.mode === 'all') {
      const jobs = expandScrapeJobs([contest]);
      if (!jobs.length) { send('failed', { error: 'Course has no links.' }); return res.end(); }
      send('start', { total: jobs.length, college: contest.college });
      let ok = 0; const failures = [];
      for (let i = 0; i < jobs.length && !aborted; i++) {
        const j = jobs[i];
        const at = { index: i + 1, total: jobs.length, name: j.name, college: contest.college };
        send('contest', at);
        try {
          const r = await scrapeAndSave(session, j, (completed, total) => { if (!aborted) send('progress', { ...at, completed, totalUsers: total }); });
          ok++; send('contest-done', { ...at, users: r.users });
        } catch (e) { failures.push(`${j.linkLabel}: ${e.message}`); send('contest-failed', { ...at, error: e.message }); }
      }
      if (!aborted) send('done', { ok, total: jobs.length, failures });
      return res.end();
    }
    if (!sel.link || !sel.link.slug) { send('failed', { error: 'Selected link has no HackerRank URL.' }); return res.end(); }
    await streamSingleContestScrape({ session, contest: { ...contest, slug: sel.link.slug, contestUrl: sel.link.contestUrl }, send, isAborted: () => aborted });
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
    const contests = (await db.listContests(college.name)).map((c) => ({
      id: c.id,
      name: c.name,
      semester: c.semester || '',
      isArchived: !!c.isArchived,
      hasLink: getEffectiveLinks(c).some((l) => !!l.slug),
      links: getEffectiveLinks(c).map((l) => ({ id: l.id, label: l.label, hasLink: !!l.slug })),
    }));
    res.json({ college: college.name, contests, tabs: await getSharedTabs() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// One contest's data via the college token (supports ?linkId=primary|<id>|all).
app.get('/api/college/:token/contest/:contestId', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    const contest = await db.getContest(req.params.contestId);
    if (!college || !contest || contest.college !== college.name) return res.status(404).json({ error: 'Course not found for this link.' });
    res.json(await contestSharePayload(contest, req.query.linkId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Read-only Excel exports via college share token
app.get('/api/college/:token/export/course/:contestId', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    const contest = await db.getContest(req.params.contestId);
    if (!college || !contest || contest.college !== college.name) return res.status(404).json({ error: 'Course not found for this link.' });
    await exportSingleCourseResponse({ contest, linkId: req.query.linkId, query: req.query, origin: requestOrigin(req), res });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/college/:token/export/college', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    if (!college) return res.status(404).json({ error: 'College not found.' });
    const semesterFilter = req.query.semester ? String(req.query.semester).trim() : '';
    const [allStudents, contests] = await Promise.all([
      db.listStudents({ college: college.name }),
      db.listContests(college.name, { includeArchived: true }),
    ]);
    const coursesData = [];
    for (const ct of contests) coursesData.push(...(await expandContestExportData(ct, null, semesterFilter)));
    const origin = requestOrigin(req);
    const collegeShareUrl = origin ? `${origin}/college/${req.params.token}` : '';
    const buf = await buildCollegeWorkbook({
      collegeName: college.name,
      collegeShareUrl,
      semesterFilter,
      coursesData,
      allStudents,
      shareOrigin: origin,
    });
    const semPart = semesterFilter ? `_${semesterFilter}` : '_All_Semesters';
    sendXlsx(res, buf, `${college.name}${semPart}_Completion_Report`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/college/:token/export/student/:studentId', async (req, res) => {
  try {
    const id = await collegeIdForToken(req.params.token);
    if (!id) return res.status(404).json({ error: 'This link is invalid or was revoked.' });
    const college = (await db.listColleges()).find((c) => String(c.id) === String(id));
    const student = await db.getStudent(req.params.studentId);
    if (!college || !student || student.college !== college.name) return res.status(403).json({ error: 'Student not found in this college.' });
    const contests = await db.listContestsForStudent(college.name, student.usernameKey || student.hrUsername);
    const coursesData = [];
    for (const ct of contests) coursesData.push(...(await expandContestExportData(ct, [student])));
    const buf = await buildStudentWorkbook({ student, coursesData, shareOrigin: requestOrigin(req) });
    const who = student.registerNo ? `${student.name}_${student.registerNo}` : (student.name || student.hrUsername);
    sendXlsx(res, buf, `${who}_Progress_Report`);
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

    const { contestId, linkId } = req.query;
    if (contestId && contestId !== 'all') {
      const contest = await db.getContest(contestId);
      if (!contest || contest.college !== college.name) { send('failed', { error: 'Course not found in this college.' }); return res.end(); }
      const sel = resolveSelectedLink(contest, linkId);
      if (sel.mode === 'all') {
        const jobs = expandScrapeJobs([contest]);
        if (!jobs.length) { send('failed', { error: 'This course has no links.' }); return res.end(); }
        send('start', { total: jobs.length, college: college.name });
        let ok = 0; const failures = [];
        for (let i = 0; i < jobs.length && !aborted; i++) {
          const j = jobs[i];
          const at = { index: i + 1, total: jobs.length, name: j.name, college: college.name };
          send('contest', at);
          try {
            const r = await scrapeAndSave(session, j, (completed, total) => { if (!aborted) send('progress', { ...at, completed, totalUsers: total }); });
            ok++; send('contest-done', { ...at, users: r.users });
          } catch (e) { failures.push(`${j.name}: ${e.message}`); send('contest-failed', { ...at, error: e.message }); }
        }
        if (!aborted) send('done', { ok, total: jobs.length, failures, college: college.name });
        return res.end();
      }
      if (!sel.link || !sel.link.slug) { send('failed', { error: 'This link has no HackerRank URL.' }); return res.end(); }
      await streamSingleContestScrape({ session, contest: { ...contest, slug: sel.link.slug, contestUrl: sel.link.contestUrl }, send, isAborted: () => aborted });
      return res.end();
    }

    // Sync all active (non-archived) contests & their attached links in this college
    const contests = await db.listContests(college.name, { includeArchived: false });
    const jobs = expandScrapeJobs(contests);
    if (!jobs.length) { send('failed', { error: 'No courses with links found for this college.' }); return res.end(); }
    send('start', { total: jobs.length, college: college.name });
    let ok = 0; const failures = [];
    for (let i = 0; i < jobs.length && !aborted; i++) {
      const c = jobs[i];
      const at = { index: i + 1, total: jobs.length, name: c.name, college: college.name };
      send('contest', at);
      try {
        const r = await scrapeAndSave(session, c, (completed, total) => { if (!aborted) send('progress', { ...at, completed, totalUsers: total }); });
        ok++; send('contest-done', { ...at, users: r.users });
      } catch (e) {
        failures.push(`${c.name}: ${e.message}`);
        send('contest-failed', { ...at, error: e.message });
      }
    }
    if (!aborted) send('done', { ok, total: jobs.length, failures, college: college.name });
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
    const contests = await db.listContests(undefined, { includeArchived: false });
    const jobs = expandScrapeJobs(contests);
    let ok = 0; const errs = [];
    for (const c of jobs) { try { await scrapeAndSave(session, c); ok++; } catch (e) { errs.push(`${c.slug}: ${e.message}`); } }
    autoState.lastRun = new Date().toISOString();
    autoState.lastResult = `${ok}/${jobs.length} course links synced${errs.length ? ' · ' + errs.length + ' failed' : ''}`;
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

