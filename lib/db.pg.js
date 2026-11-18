// Storage layer — Supabase / Postgres via node-postgres (pg).
// Activated when SUPABASE_DB_URL (or DATABASE_URL) is set. Auto-creates tables.
// Updated to use hc_* table prefix for unified Supabase hosting in public schema.
import pg from 'pg';
const { Pool } = pg;

let connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('SUPABASE_DB_URL is not set.');

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_MAX_POOL) || 2, // Conservative pool size (2 max clients) to stay well under Supabase pooler 15-limit
  idleTimeoutMillis: 1000,                  // Release idle connections quickly
  connectionTimeoutMillis: 10000,           // 10s connection timeout
  allowExitOnIdle: true,
});

// Graceful cleanup on process reload
const cleanPool = () => { pool.end().catch(() => {}); };
process.on('SIGTERM', cleanPool);
process.on('SIGINT', cleanPool);

export const storageBackend = () => 'supabase';

async function queryWithRetry(text, params = [], retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const msg = err?.message || '';
      const isPoolFull = msg.includes('EMAXCONNSESSION') || msg.includes('max clients reached') || msg.includes('timeout') || err?.code === '53300';
      if (isPoolFull && attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function q(text, params = []) { const r = await queryWithRetry(text, params); return r.rows; }
async function q1(text, params = []) { const r = await queryWithRetry(text, params); return r.rows[0] || null; }
function parseVideos(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean); } catch { /* */ }
  return s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}
// Multi-row insert: bulkInsert('hc_topics', ['slug','question','topic'], rows)
async function bulkInsert(table, cols, rows) {
  if (!rows.length) return;
  const vals = []; const groups = [];
  rows.forEach((r, i) => { groups.push('(' + cols.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')'); for (const c of cols) vals.push(r[c]); });
  await q(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${groups.join(',')}`, vals);
}

// ---- One-time schema (runs on module load) ----
try {
  await queryWithRetry(`
    CREATE TABLE IF NOT EXISTS hc_colleges (
      id bigint generated always as identity primary key,
      name text unique, access_code text, contest_url text, slug text, created_at timestamptz default now()
    );
    CREATE TABLE IF NOT EXISTS hc_students (
      id bigint generated always as identity primary key,
      college text, name text, hr_username text, username_key text,
      register_no text, email text, department text, section text, year text, campus text,
      unique(college, username_key)
    );
    CREATE TABLE IF NOT EXISTS hc_contests (
      id bigint generated always as identity primary key,
      college text, name text, contest_url text, slug text, share_token text,
      semester text NOT NULL DEFAULT '',
      is_archived boolean NOT NULL DEFAULT false,
      created_at timestamptz default now()
    );
    ALTER TABLE hc_contests ADD COLUMN IF NOT EXISTS semester text NOT NULL DEFAULT '';
    ALTER TABLE hc_contests ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS hc_contest_students (contest_id bigint, username_key text, primary key(contest_id, username_key));
    CREATE TABLE IF NOT EXISTS hc_scrapes (
      id bigint generated always as identity primary key,
      slug text, contest_name text, total_users int, total_questions int, payload jsonb, created_at timestamptz default now()
    );
    CREATE TABLE IF NOT EXISTS hc_student_progress (
      slug text NOT NULL,
      username_key text NOT NULL,
      question text NOT NULL,
      points numeric NOT NULL DEFAULT 0,
      max_score numeric NOT NULL DEFAULT 0,
      solved boolean NOT NULL DEFAULT false,
      attempted boolean NOT NULL DEFAULT false,
      first_solved_at timestamptz,
      last_synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (slug, username_key, question)
    );
    CREATE TABLE IF NOT EXISTS hc_daily_progress (
      slug text NOT NULL,
      day date NOT NULL,
      username_key text NOT NULL,
      solved_count int NOT NULL DEFAULT 0,
      score numeric NOT NULL DEFAULT 0,
      PRIMARY KEY (slug, day, username_key)
    );
    CREATE TABLE IF NOT EXISTS hc_topics (slug text, question text, topic text, primary key(slug, question));
    CREATE TABLE IF NOT EXISTS hc_topic_videos (slug text, topic text, video_url text, primary key(slug, topic));
    CREATE TABLE IF NOT EXISTS hc_question_categories (slug text, question text, category text, primary key(slug, question));
    CREATE TABLE IF NOT EXISTS hc_app_settings (key text primary key, value text);

    -- Indexes for the columns we filter/sort on (huge win on a remote DB).
    CREATE INDEX IF NOT EXISTS idx_hc_students_college ON hc_students(college);
    CREATE INDEX IF NOT EXISTS idx_hc_students_college_name ON hc_students(college, name);
    CREATE INDEX IF NOT EXISTS idx_hc_contests_college ON hc_contests(college);
    CREATE INDEX IF NOT EXISTS idx_hc_contests_college_sem ON hc_contests(college, semester);
    CREATE INDEX IF NOT EXISTS idx_hc_contests_share_token ON hc_contests(share_token);
    CREATE INDEX IF NOT EXISTS idx_hc_contest_students_contest ON hc_contest_students(contest_id);
    CREATE INDEX IF NOT EXISTS idx_hc_scrapes_slug_id ON hc_scrapes(slug, id DESC);
    CREATE INDEX IF NOT EXISTS idx_hc_sp_slug_user ON hc_student_progress(slug, username_key);
    CREATE INDEX IF NOT EXISTS idx_hc_sp_user ON hc_student_progress(username_key);
    CREATE INDEX IF NOT EXISTS idx_hc_dp_slug_day ON hc_daily_progress(slug, day);
    CREATE INDEX IF NOT EXISTS idx_hc_topics_slug ON hc_topics(slug);
    CREATE INDEX IF NOT EXISTS idx_hc_topic_videos_slug ON hc_topic_videos(slug);
    CREATE INDEX IF NOT EXISTS idx_hc_qcat_slug ON hc_question_categories(slug);

    -- Auto-migrate existing data from legacy public.colleges or hackerrank.colleges if present
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='colleges') THEN
        INSERT INTO hc_colleges (name, access_code, contest_url, slug)
        SELECT name, access_code, contest_url, slug FROM public.colleges
        ON CONFLICT (name) DO NOTHING;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='hackerrank' AND table_name='colleges') THEN
        INSERT INTO hc_colleges (name, access_code, contest_url, slug)
        SELECT name, access_code, contest_url, slug FROM hackerrank.colleges
        ON CONFLICT (name) DO NOTHING;
      END IF;
    END $$;
  `);
  console.log('[db] Supabase/Postgres connected; hc_* schema ensured.');
} catch (err) {
  console.error('[db] Database connection / schema error on boot:', err.message);
}

// ===================== Colleges =====================
export async function listColleges() {
  try {
    const rows = await q(`SELECT c.id, c.name, c.contest_url, c.slug,
        (c.access_code IS NOT NULL AND c.access_code <> '') AS has_code,
        COUNT(DISTINCT s.id) AS students,
        COUNT(DISTINCT ct.id) AS contests_count
      FROM hc_colleges c
      LEFT JOIN hc_students s ON s.college = c.name
      LEFT JOIN hc_contests ct ON ct.college = c.name
      GROUP BY c.id, c.name, c.contest_url, c.slug, c.access_code ORDER BY c.name`);

    const settings = await q(`SELECT key, value FROM hc_app_settings WHERE key LIKE 'college_share:%'`);
    const tokenMap = new Map();
    for (const s of settings) {
      const cid = s.key.replace('college_share:', '');
      tokenMap.set(cid, s.value);
    }

    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      contestUrl: r.contest_url || '',
      slug: r.slug || '',
      hasCode: !!r.has_code,
      students: Number(r.students),
      contestsCount: Number(r.contests_count || 0),
      shareToken: tokenMap.get(String(r.id)) || '',
    }));
  } catch (err) {
    try {
      const rows = await q(`SELECT c.id, c.name, c.contest_url, c.slug,
          (c.access_code IS NOT NULL AND c.access_code <> '') AS has_code,
          COUNT(DISTINCT s.id) AS students,
          COUNT(DISTINCT ct.id) AS contests_count
        FROM colleges c
        LEFT JOIN students s ON s.college = c.name
        LEFT JOIN contests ct ON ct.college = c.name
        GROUP BY c.id, c.name, c.contest_url, c.slug, c.access_code ORDER BY c.name`);
      return rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        contestUrl: r.contest_url || '',
        slug: r.slug || '',
        hasCode: !!r.has_code,
        students: Number(r.students),
        contestsCount: Number(r.contests_count || 0),
        shareToken: '',
      }));
    } catch {
      throw err;
    }
  }
}
export async function getCollegeByName(name) {
  const r = await q1('SELECT id,name,access_code,contest_url,slug FROM hc_colleges WHERE lower(name)=lower($1) LIMIT 1', [String(name)]);
  return r ? { id: Number(r.id), name: r.name, accessCode: r.access_code, contestUrl: r.contest_url, slug: r.slug } : null;
}
export async function addCollege({ name, accessCode = '', contestUrl = '', slug = '' }) {
  const nm = String(name || '').trim(); if (!nm) throw new Error('College name is required.');
  await q('INSERT INTO hc_colleges(name,access_code,contest_url,slug) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO NOTHING', [nm, accessCode, contestUrl, slug]);
  const r = await q1('SELECT id,name FROM hc_colleges WHERE name=$1', [nm]);
  return { id: Number(r.id), name: r.name };
}
export async function updateCollege(id, fields) {
  const cur = await q1('SELECT access_code,contest_url,slug FROM hc_colleges WHERE id=$1', [Number(id)]);
  if (!cur) return null;
  const next = { accessCode: fields.accessCode !== undefined ? fields.accessCode : cur.access_code, contestUrl: fields.contestUrl !== undefined ? fields.contestUrl : cur.contest_url, slug: fields.slug !== undefined ? fields.slug : cur.slug };
  await q('UPDATE hc_colleges SET access_code=$1,contest_url=$2,slug=$3 WHERE id=$4', [next.accessCode, next.contestUrl, next.slug, Number(id)]);
  return { id: Number(id), ...next };
}
export async function verifyCollegeCode(name, code) {
  const c = await getCollegeByName(name);
  return !!c && String(c.accessCode || '') !== '' && String(c.accessCode) === String(code);
}
export async function deleteCollege(id) {
  const c = await q1('SELECT name FROM hc_colleges WHERE id=$1', [Number(id)]);
  if (c) {
    const contests = await q('SELECT id FROM hc_contests WHERE college=$1', [c.name]);
    for (const ct of contests) await deleteContest(ct.id);
    await q('DELETE FROM hc_students WHERE college=$1', [c.name]);
  }
  await q('DELETE FROM hc_colleges WHERE id=$1', [Number(id)]);
  return true;
}

// ===================== Contests =====================
const CONTEST_COLS = 'id,college,name,contest_url,slug,share_token,semester,is_archived';
function mapContest(c) {
  return c ? {
    id: Number(c.id),
    college: c.college,
    name: c.name,
    contestUrl: c.contest_url || '',
    slug: c.slug || '',
    shareToken: c.share_token || '',
    semester: c.semester || '',
    isArchived: !!c.is_archived,
  } : null;
}
export async function listContests(college, { semester, includeArchived = true } = {}) {
  const where = []; const args = [];
  if (college) { args.push(college); where.push(`college=$${args.length}`); }
  if (semester !== undefined && semester !== null && semester !== '') {
    args.push(String(semester).trim());
    where.push(`semester=$${args.length}`);
  }
  if (!includeArchived) where.push('is_archived = false');
  const sql = `SELECT ${CONTEST_COLS} FROM hc_contests` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    (college ? ' ORDER BY is_archived ASC, semester ASC, id ASC' : ' ORDER BY college ASC, is_archived ASC, semester ASC, id ASC');
  return (await q(sql, args)).map(mapContest);
}
export async function getContest(id) { return mapContest(await q1(`SELECT ${CONTEST_COLS} FROM hc_contests WHERE id=$1`, [Number(id)])); }
export async function getContestByShareToken(token) { if (!token) return null; return mapContest(await q1(`SELECT ${CONTEST_COLS} FROM hc_contests WHERE share_token=$1`, [String(token)])); }
export async function setContestShareToken(id, token) { await q('UPDATE hc_contests SET share_token=$1 WHERE id=$2', [token, Number(id)]); }
export async function addContest({ college, name, contestUrl = '', slug = '', semester = '' }) {
  const col = String(college || '').trim(); const nm = String(name || '').trim();
  const sem = String(semester || '').trim();
  if (!col) throw new Error('College is required.'); if (!nm) throw new Error('Contest name is required.');
  const r = await q1(`INSERT INTO hc_contests(college,name,contest_url,slug,semester) VALUES($1,$2,$3,$4,$5) RETURNING ${CONTEST_COLS}`, [col, nm, contestUrl, slug, sem]);
  return mapContest(r);
}
export async function updateContest(id, { name, contestUrl, slug, semester, isArchived }) {
  const cur = await getContest(id); if (!cur) return null;
  const next = {
    name: name !== undefined ? String(name).trim() : cur.name,
    contestUrl: contestUrl !== undefined ? contestUrl : cur.contestUrl,
    slug: slug !== undefined ? slug : cur.slug,
    semester: semester !== undefined ? String(semester || '').trim() : cur.semester,
    isArchived: isArchived !== undefined ? !!isArchived : cur.isArchived,
  };
  await q('UPDATE hc_contests SET name=$1,contest_url=$2,slug=$3,semester=$4,is_archived=$5 WHERE id=$6',
    [next.name, next.contestUrl, next.slug, next.semester, next.isArchived, Number(id)]);
  return getContest(id);
}
export async function archiveContest(id, isArchived = true) {
  return updateContest(id, { isArchived: !!isArchived });
}
export async function hasScrapeData(slug) {
  if (!slug) return false;
  const r = await q1(`SELECT (EXISTS(SELECT 1 FROM hc_scrapes WHERE slug=$1) OR EXISTS(SELECT 1 FROM hc_student_progress WHERE slug=$1)) AS has_data`, [slug]);
  return !!(r && r.has_data);
}
export async function deleteContest(id) {
  const ct = await getContest(id); if (!ct) return false;
  await q('DELETE FROM hc_contests WHERE id=$1', [Number(id)]);
  await q('DELETE FROM hc_contest_students WHERE contest_id=$1', [Number(id)]);
  // Note: hc_student_progress and hc_daily_progress are intentionally NOT deleted
  // here so historical completion data is never accidentally destroyed.
  if (ct.slug) {
    const others = await q('SELECT id FROM hc_contests WHERE slug=$1', [ct.slug]);
    if (!others.length) {
      for (const t of ['hc_topics', 'hc_topic_videos', 'hc_question_categories']) await q(`DELETE FROM ${t} WHERE slug=$1`, [ct.slug]);
    }
  }
  return true;
}

// ===================== Contest ↔ student mapping =====================
export async function assignStudentsToContest(contestId, usernameKeys) {
  const keys = (usernameKeys || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  if (keys.length) await bulkInsertConflictNothing('hc_contest_students', ['contest_id', 'username_key'], keys.map((k) => ({ contest_id: Number(contestId), username_key: k })), 'contest_id,username_key');
  return keys.length;
}
async function bulkInsertConflictNothing(table, cols, rows, conflict) {
  if (!rows.length) return;
  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK);
    const vals = []; const groups = [];
    slice.forEach((r, i) => { groups.push('(' + cols.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')'); for (const c of cols) vals.push(r[c]); });
    await q(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${groups.join(',')} ON CONFLICT(${conflict}) DO NOTHING`, vals);
  }
}
export async function getContestStudentKeys(contestId) { return (await q('SELECT username_key FROM hc_contest_students WHERE contest_id=$1', [Number(contestId)])).map((r) => r.username_key); }
export async function listContestsForStudent(college, usernameKey) {
  const key = String(usernameKey || '').toLowerCase();
  const contests = await listContests(college); const out = [];
  for (const c of contests) { const keys = (await getContestStudentKeys(c.id)).map((k) => k.toLowerCase()); if (!keys.length || keys.includes(key)) out.push(c); }
  return out;
}
export async function listStudentsForContest(contestId) {
  // Single round-trip: students in the contest's college, filtered to the
  // mapped keys when a mapping exists (else the whole college).
  const id = Number(contestId);
  const rows = await q(`
    SELECT s.* FROM hc_students s
    JOIN hc_contests c ON c.id = $1 AND s.college = c.college
    WHERE NOT EXISTS (SELECT 1 FROM hc_contest_students cs WHERE cs.contest_id = $1)
       OR s.username_key IN (SELECT username_key FROM hc_contest_students WHERE contest_id = $1)
    ORDER BY s.name`, [id]);
  return rows.map(normalize);
}

// ===================== Students =====================
function normalize(s) {
  return { id: Number(s.id), college: s.college, name: s.name, hrUsername: s.hr_username, usernameKey: s.username_key, registerNo: s.register_no, email: s.email, department: s.department, section: s.section, year: s.year, campus: s.campus };
}
export async function listStudents({ college, department, section, year } = {}) {
  const where = []; const args = [];
  for (const [k, v] of [['college', college], ['department', department], ['section', section], ['year', year]]) if (v) { args.push(v); where.push(`${k}=$${args.length}`); }
  const rows = await q('SELECT * FROM hc_students' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY name', args);
  return rows.map(normalize);
}
export async function upsertStudents(college, students) {
  // Keep every row that has a key. `usernameKey` may be supplied by the caller
  // (e.g. a synthetic key for students with no/invalid HackerRank id); otherwise
  // it's derived from the HackerRank username.
  const mapped = (students || [])
    .map((s) => ({ ...s, _key: String(s.usernameKey || s.hrUsername || '').toLowerCase() }))
    .filter((s) => s._key)
    .map((s) => ({ college, name: s.name || '', hr_username: s.hrUsername || '', username_key: s._key, register_no: s.registerNo || '', email: s.email || '', department: s.department || '', section: s.section || '', year: s.year || '', campus: s.campus || '' }));
  // Postgres rejects ON CONFLICT DO UPDATE when the same conflict key appears
  // twice in one INSERT. Dedupe by (college, username_key), keeping the last row.
  const byKey = new Map();
  for (const r of mapped) byKey.set(r.college + ' ' + r.username_key, r);
  const recs = Array.from(byKey.values());
  if (recs.length) {
    const cols = ['college', 'name', 'hr_username', 'username_key', 'register_no', 'email', 'department', 'section', 'year', 'campus'];
    const CHUNK = 400;
    for (let start = 0; start < recs.length; start += CHUNK) {
      const slice = recs.slice(start, start + CHUNK);
      const vals = []; const groups = [];
      slice.forEach((r, i) => { groups.push('(' + cols.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')'); for (const c of cols) vals.push(r[c]); });
      // Non-destructive upsert: blank columns in a new semester upload never erase existing student metadata.
      await q(`INSERT INTO hc_students(${cols.join(',')}) VALUES ${groups.join(',')}
        ON CONFLICT(college,username_key) DO UPDATE SET
          name=COALESCE(NULLIF(excluded.name, ''), hc_students.name),
          hr_username=COALESCE(NULLIF(excluded.hr_username, ''), hc_students.hr_username),
          register_no=COALESCE(NULLIF(excluded.register_no, ''), hc_students.register_no),
          email=COALESCE(NULLIF(excluded.email, ''), hc_students.email),
          department=COALESCE(NULLIF(excluded.department, ''), hc_students.department),
          section=COALESCE(NULLIF(excluded.section, ''), hc_students.section),
          year=COALESCE(NULLIF(excluded.year, ''), hc_students.year),
          campus=COALESCE(NULLIF(excluded.campus, ''), hc_students.campus)`, vals);
    }
  }
  return { count: recs.length };
}
// ===================== App settings (key/value) =====================
export async function getSetting(key) { const r = await q1('SELECT value FROM hc_app_settings WHERE key=$1', [key]); return r ? r.value : null; }
export async function setSetting(key, value) { await q('INSERT INTO hc_app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]); }

// Distinct department / section / year / campus for a college (for dropdowns).
export async function getStudentFacets(college) {
  if (!college) return { departments: [], sections: [], years: [], campuses: [] };
  const r = await q1(`SELECT
      array_agg(DISTINCT department) FILTER (WHERE department IS NOT NULL AND department <> '') AS departments,
      array_agg(DISTINCT section)    FILTER (WHERE section    IS NOT NULL AND section    <> '') AS sections,
      array_agg(DISTINCT year)       FILTER (WHERE year       IS NOT NULL AND year       <> '') AS years,
      array_agg(DISTINCT campus)     FILTER (WHERE campus     IS NOT NULL AND campus     <> '') AS campuses
    FROM hc_students WHERE college=$1`, [college]);
  const s = (a) => (a || []).slice().sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }));
  return { departments: s(r && r.departments), sections: s(r && r.sections), years: s(r && r.years), campuses: s(r && r.campuses) };
}
export async function deleteStudents(ids) {
  const arr = (ids || []).map(Number); if (!arr.length) return 0;
  const r = await pool.query('DELETE FROM hc_students WHERE id = ANY($1::bigint[])', [arr]);
  return r.rowCount;
}
export async function getStudent(id) {
  const r = await q1('SELECT * FROM hc_students WHERE id=$1', [Number(id)]);
  return r ? normalize(r) : null;
}
export async function updateStudent(id, data) {
  const sid = Number(id);
  const cur = await getStudent(sid);
  if (!cur) throw new Error('Student not found.');
  const rawHr = data.hrUsername !== undefined ? String(data.hrUsername).trim() : (cur.hrUsername || '');
  const lc = rawHr.toLowerCase();
  const name = data.name !== undefined ? String(data.name).trim() : cur.name;
  const regNo = data.registerNo !== undefined ? String(data.registerNo).trim() : (cur.registerNo || '');
  const email = data.email !== undefined ? String(data.email).trim() : (cur.email || '');
  const campus = data.campus !== undefined ? String(data.campus).trim() : (cur.campus || '');
  const dept = data.department !== undefined ? String(data.department).trim() : (cur.department || '');
  const sec = data.section !== undefined ? String(data.section).trim() : (cur.section || '');
  const year = data.year !== undefined ? String(data.year).trim() : (cur.year || '');
  const college = data.college !== undefined ? String(data.college).trim() : cur.college;

  const valid = rawHr && !['sample', 'absent', 'na', 'n/a', 'nil', 'none', 'null', 'test', 'xxx', '-', '--', '.'].includes(lc);
  const usernameKey = valid ? lc : (cur.usernameKey || ('unmatched:' + String(regNo || email || name || sid).toLowerCase()));

  await q(`UPDATE hc_students SET
    name=$1, hr_username=$2, username_key=$3, register_no=$4, email=$5,
    campus=$6, department=$7, section=$8, year=$9, college=$10
    WHERE id=$11`,
    [name, valid ? rawHr : '', usernameKey, regNo, email, campus, dept, sec, year, college, sid]
  );
  if (cur.usernameKey && cur.usernameKey !== usernameKey) {
    await q('UPDATE hc_contest_students SET username_key=$1 WHERE username_key=$2', [usernameKey, cur.usernameKey]);
  }
  return getStudent(sid);
}

// ===================== Scrapes & Permanent Progress =====================

// Load preserved high-water-mark progress for a contest slug.
// Returns { byUser: Map<usernameKey, Map<question, row>>, firstSolved: Map<usernameKey+'|'+question, isoString> }
export async function getStudentProgressMap(slug) {
  const byUser = new Map();
  const firstSolved = new Map();
  if (!slug) return { byUser, firstSolved };
  const rows = await q(
    'SELECT username_key, question, points, max_score, solved, attempted, first_solved_at FROM hc_student_progress WHERE slug=$1',
    [slug]
  );
  for (const r of rows) {
    const uk = String(r.username_key || '').toLowerCase();
    if (!uk) continue;
    let qm = byUser.get(uk);
    if (!qm) { qm = new Map(); byUser.set(uk, qm); }
    const iso = r.first_solved_at
      ? (r.first_solved_at instanceof Date ? r.first_solved_at.toISOString() : String(r.first_solved_at))
      : null;
    qm.set(r.question, {
      points: Number(r.points || 0),
      maxScore: Number(r.max_score || 0),
      solved: !!r.solved,
      attempted: !!r.attempted,
      firstSolvedAt: iso,
    });
    if (iso) firstSolved.set(`${uk}|${r.question}`, iso);
  }
  return { byUser, firstSolved };
}

// Merge an incoming scrape payload with preserved high-water-mark progress so
// previously completed questions, scores, or temporarily omitted students are
// never downgraded or overwritten.
export function mergeDashboardWithProgress(payload, progressByUser) {
  if (!payload || !progressByUser || !progressByUser.size) return payload;
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const qByName = new Map(questions.map((q) => [q.name, q]));

  // Include any historical question names present in preserved progress
  // if they were somehow omitted from a partial scrape.
  const mergedQuestions = questions.slice();
  for (const qm of progressByUser.values()) {
    for (const [qName, st] of qm.entries()) {
      if (!qByName.has(qName)) {
        const added = { name: qName, points: st.points || 0, url: '' };
        qByName.set(qName, added);
        mergedQuestions.push(added);
      }
    }
  }

  const incomingUsers = Array.isArray(payload.users) ? payload.users : [];
  const seenKeys = new Set();
  const mergedUsers = incomingUsers.map((u) => {
    const uk = String(u.username || '').toLowerCase();
    seenKeys.add(uk);
    const prevMap = progressByUser.get(uk);
    if (!prevMap) return u;
    const nextStatus = { ...(u.questionStatus || {}) };
    for (const q of mergedQuestions) {
      const cur = nextStatus[q.name] || { score: 0, points: q.points || 0, attempted: false, solved: false };
      const prev = prevMap.get(q.name);
      if (prev) {
        const solved = !!(cur.solved || prev.solved);
        const attempted = !!(cur.attempted || prev.attempted || solved);
        const score = Math.max(Number(cur.score || 0), Number(prev.maxScore || 0));
        const points = Number(cur.points || prev.points || q.points || 0);
        nextStatus[q.name] = { score, points, attempted, solved };
      } else if (!nextStatus[q.name]) {
        nextStatus[q.name] = { score: 0, points: q.points || 0, attempted: false, solved: false };
      }
    }
    let solved = 0, attempted = 0, computedScore = 0;
    for (const q of mergedQuestions) {
      const cell = nextStatus[q.name];
      if (!cell) continue;
      if (cell.solved) solved++;
      if (cell.attempted) attempted++;
      computedScore += Number(cell.score || 0);
    }
    return { ...u, solved, attempted, computedScore, questionStatus: nextStatus };
  });

  // Preserve students who had progress in earlier scrapes even if missing from this scrape.
  for (const [uk, prevMap] of progressByUser.entries()) {
    if (seenKeys.has(uk)) continue;
    const questionStatus = {};
    let solved = 0, attempted = 0, computedScore = 0;
    for (const q of mergedQuestions) {
      const prev = prevMap.get(q.name);
      if (prev) {
        const cell = {
          score: Number(prev.maxScore || 0),
          points: Number(prev.points || q.points || 0),
          attempted: !!(prev.attempted || prev.solved),
          solved: !!prev.solved,
        };
        questionStatus[q.name] = cell;
        if (cell.solved) solved++;
        if (cell.attempted) attempted++;
        computedScore += cell.score;
      } else {
        questionStatus[q.name] = { score: 0, points: q.points || 0, attempted: false, solved: false };
      }
    }
    mergedUsers.push({ username: uk, rank: null, computedScore, solved, attempted, questionStatus });
  }

  const totalSolves = mergedUsers.reduce((a, u) => a + (u.solved || 0), 0);
  const qc = mergedQuestions.length;
  return {
    ...payload,
    contest: { ...(payload.contest || {}), challengesCount: qc },
    summary: {
      totalUsers: mergedUsers.length,
      totalQuestions: qc,
      avgSolved: mergedUsers.length ? +(totalSolves / mergedUsers.length).toFixed(2) : 0,
      overallCompletion: mergedUsers.length && qc ? Math.round((totalSolves / (mergedUsers.length * qc)) * 100) : 0,
    },
    questions: mergedQuestions,
    users: mergedUsers,
  };
}

export async function upsertStudentProgress(slug, payload, syncedAt = new Date().toISOString()) {
  if (!slug || !payload || !Array.isArray(payload.users)) return 0;
  const rows = [];
  for (const u of payload.users) {
    const uk = String(u.username || '').trim().toLowerCase();
    if (!uk) continue;
    const qs = u.questionStatus || {};
    for (const [question, st] of Object.entries(qs)) {
      if (!st) continue;
      const solved = !!st.solved;
      const attempted = !!(st.attempted || solved);
      const score = Number(st.score || 0);
      if (!solved && !attempted && score <= 0) continue; // keep table compact; unattempted rows need no row
      rows.push({
        slug,
        username_key: uk,
        question,
        points: Number(st.points || 0),
        max_score: score,
        solved,
        attempted,
        first_solved_at: solved ? syncedAt : null,
        last_synced_at: syncedAt,
      });
    }
  }
  if (!rows.length) return 0;
  const cols = ['slug', 'username_key', 'question', 'points', 'max_score', 'solved', 'attempted', 'first_solved_at', 'last_synced_at'];
  const CHUNK = 350;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK);
    const vals = []; const groups = [];
    slice.forEach((r, i) => {
      groups.push('(' + cols.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')');
      for (const c of cols) vals.push(r[c]);
    });
    await q(`INSERT INTO hc_student_progress(${cols.join(',')}) VALUES ${groups.join(',')}
      ON CONFLICT(slug, username_key, question) DO UPDATE SET
        points = GREATEST(hc_student_progress.points, excluded.points),
        max_score = GREATEST(hc_student_progress.max_score, excluded.max_score),
        solved = hc_student_progress.solved OR excluded.solved,
        attempted = hc_student_progress.attempted OR excluded.attempted,
        first_solved_at = COALESCE(hc_student_progress.first_solved_at, excluded.first_solved_at),
        last_synced_at = excluded.last_synced_at`, vals);
  }
  return rows.length;
}

export async function upsertDailyProgress(slug, day, payload) {
  if (!slug || !day || !payload || !Array.isArray(payload.users)) return 0;
  const byUser = new Map();
  for (const u of payload.users) {
    const uk = String(u.username || '').trim().toLowerCase();
    if (!uk) continue;
    const solved = Number(u.solved || 0);
    const score = Number(u.computedScore || 0);
    const prev = byUser.get(uk);
    if (!prev || solved > prev.solved_count || score > prev.score) {
      byUser.set(uk, { slug, day, username_key: uk, solved_count: solved, score });
    }
  }
  const rows = Array.from(byUser.values());
  if (!rows.length) return 0;
  const cols = ['slug', 'day', 'username_key', 'solved_count', 'score'];
  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK);
    const vals = []; const groups = [];
    slice.forEach((r, i) => {
      groups.push('(' + cols.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')');
      for (const c of cols) vals.push(r[c]);
    });
    await q(`INSERT INTO hc_daily_progress(${cols.join(',')}) VALUES ${groups.join(',')}
      ON CONFLICT(slug, day, username_key) DO UPDATE SET
        solved_count = GREATEST(hc_daily_progress.solved_count, excluded.solved_count),
        score = GREATEST(hc_daily_progress.score, excluded.score)`, vals);
  }
  return rows.length;
}

export async function saveScrape(slug, payload) {
  const createdAt = new Date().toISOString();
  const day = createdAt.slice(0, 10);
  // Non-destructive merge: never downgrade or lose previously solved progress.
  let merged = payload;
  try {
    const { byUser } = await getStudentProgressMap(slug);
    merged = mergeDashboardWithProgress(payload, byUser);
    await upsertStudentProgress(slug, merged, createdAt);
    await upsertDailyProgress(slug, day, merged);
  } catch (e) {
    console.warn('[db] progress merge/save warning for', slug, e.message);
  }
  const meta = { contestName: merged?.contest?.name || slug, totalUsers: merged?.summary?.totalUsers || 0, totalQuestions: merged?.summary?.totalQuestions || 0 };
  const r = await q1('INSERT INTO hc_scrapes(slug,contest_name,total_users,total_questions,created_at,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id', [slug, meta.contestName, meta.totalUsers, meta.totalQuestions, createdAt, JSON.stringify(merged)]);
  return { id: Number(r.id), createdAt, dashboard: merged };
}
export async function getLatestScrape(slug) {
  if (!slug) return null;
  const r = await q1('SELECT payload FROM hc_scrapes WHERE slug=$1 ORDER BY id DESC LIMIT 1', [slug]);
  if (!r || !r.payload) return null;
  try {
    const { byUser } = await getStudentProgressMap(slug);
    return byUser.size ? mergeDashboardWithProgress(r.payload, byUser) : r.payload;
  } catch {
    return r.payload;
  }
}
// Keep the DB small: for a course, keep only the LATEST scrape of each calendar
// day, and only the most recent `keepDays` days. Raw JSONB snapshots are pruned,
// while permanent completion progress lives in hc_student_progress + hc_daily_progress.
export async function pruneScrapes(slug, keepDays = 20) {
  if (!slug) return { deleted: 0 };
  const r = await pool.query(`
    WITH ranked AS (
      SELECT id, created_at::date AS d,
             row_number() OVER (PARTITION BY created_at::date ORDER BY id DESC) AS rn
      FROM hc_scrapes WHERE slug=$1
    ),
    keep_days AS (
      SELECT DISTINCT d FROM ranked ORDER BY d DESC LIMIT $2
    )
    DELETE FROM hc_scrapes
    WHERE slug=$1 AND id IN (
      SELECT r.id FROM ranked r
      WHERE r.rn > 1                                   -- same-day duplicates
         OR r.d NOT IN (SELECT d FROM keep_days)       -- days beyond the window
    )`, [slug, keepDays]);
  return { deleted: r.rowCount };
}
export async function getScrapeSeries(slug) {
  if (!slug) return [];
  // Merge permanent hc_daily_progress with any historical hc_scrapes rows so
  // daily progress never disappears after raw JSONB scrape pruning.
  const byDay = new Map();
  const dpRows = await q(
    'SELECT day, username_key, solved_count FROM hc_daily_progress WHERE slug=$1 ORDER BY day ASC',
    [slug]
  );
  for (const r of dpRows) {
    const day = (r.day instanceof Date ? r.day.toISOString() : String(r.day)).slice(0, 10);
    let m = byDay.get(day);
    if (!m) { m = {}; byDay.set(day, m); }
    const uk = String(r.username_key || '').toLowerCase();
    m[uk] = Math.max(m[uk] || 0, Number(r.solved_count || 0));
  }
  const rows = await q(`
    SELECT DISTINCT ON (created_at::date) created_at::date AS day,
      (SELECT jsonb_agg(jsonb_build_object('u', u->>'username', 's', u->'solved'))
         FROM jsonb_array_elements(payload->'users') AS u) AS users
    FROM hc_scrapes WHERE slug=$1
    ORDER BY created_at::date ASC, id DESC`, [slug]);
  for (const r of rows) {
    const day = (r.day instanceof Date ? r.day.toISOString() : String(r.day)).slice(0, 10);
    let m = byDay.get(day);
    if (!m) { m = {}; byDay.set(day, m); }
    for (const u of (r.users || [])) {
      const uk = String(u.u || '').toLowerCase();
      m[uk] = Math.max(m[uk] || 0, Number(u.s || 0));
    }
  }
  return Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, solved]) => ({ day, solved }));
}

// One-time idempotent backfill: seed hc_student_progress from the latest
// existing scrape per slug so all existing progress is protected immediately.
async function backfillStudentProgressOnce() {
  try {
    const done = await getSetting('progress_backfill_v1');
    if (done === '1') return;
    const latestRows = await q(`
      SELECT DISTINCT ON (slug) slug, created_at, payload
      FROM hc_scrapes
      WHERE slug IS NOT NULL AND slug <> ''
      ORDER BY slug, id DESC
    `);
    for (const row of latestRows) {
      if (!row.payload) continue;
      const ts = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || new Date().toISOString());
      await upsertStudentProgress(row.slug, row.payload, ts);
      await upsertDailyProgress(row.slug, ts.slice(0, 10), row.payload);
    }
    await setSetting('progress_backfill_v1', '1');
    if (latestRows.length) console.log(`[db] Backfilled hc_student_progress for ${latestRows.length} existing course(s).`);
  } catch (e) {
    console.warn('[db] Backfill hc_student_progress skipped:', e.message);
  }
}
backfillStudentProgressOnce();

// ===================== Topics / videos / categories =====================
export async function getTopics(slug) { if (!slug) return {}; const m = {}; for (const r of await q('SELECT question,topic FROM hc_topics WHERE slug=$1', [slug])) m[r.question] = r.topic; return m; }
export async function saveTopics(slug, map) {
  const clean = {}; for (const [qn, t] of Object.entries(map || {})) { const v = String(t || '').trim(); if (v) clean[qn] = v; }
  await q('DELETE FROM hc_topics WHERE slug=$1', [slug]);
  await bulkInsert('hc_topics', ['slug', 'question', 'topic'], Object.entries(clean).map(([question, topic]) => ({ slug, question, topic })));
  return { count: Object.keys(clean).length };
}
export async function getTopicVideos(slug) { if (!slug) return {}; const m = {}; for (const r of await q('SELECT topic,video_url FROM hc_topic_videos WHERE slug=$1', [slug])) m[r.topic] = parseVideos(r.video_url); return m; }
export async function saveTopicVideos(slug, map) {
  const clean = {}; for (const [t, v] of Object.entries(map || {})) { const arr = parseVideos(v); if (arr.length) clean[t] = arr; }
  await q('DELETE FROM hc_topic_videos WHERE slug=$1', [slug]);
  await bulkInsert('hc_topic_videos', ['slug', 'topic', 'video_url'], Object.entries(clean).map(([topic, arr]) => ({ slug, topic, video_url: JSON.stringify(arr) })));
  return { count: Object.keys(clean).length };
}
export async function getQuestionCategories(slug) { if (!slug) return {}; const m = {}; for (const r of await q('SELECT question,category FROM hc_question_categories WHERE slug=$1', [slug])) m[r.question] = r.category; return m; }
export async function saveQuestionCategories(slug, map) {
  const clean = {}; for (const [qn, c] of Object.entries(map || {})) { const v = String(c || '').trim(); if (v) clean[qn] = v; }
  await q('DELETE FROM hc_question_categories WHERE slug=$1', [slug]);
  await bulkInsert('hc_question_categories', ['slug', 'question', 'category'], Object.entries(clean).map(([question, category]) => ({ slug, question, category })));
  return { count: Object.keys(clean).length };
}
