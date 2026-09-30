// Storage layer — Supabase / Postgres via node-postgres (pg).
// Activated when SUPABASE_DB_URL (or DATABASE_URL) is set. Auto-creates tables.
// Updated to use hc_* table prefix for unified Supabase hosting in public schema.
import pg from 'pg';
const { Pool } = pg;

const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('SUPABASE_DB_URL is not set.');
export const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 10, keepAlive: true, idleTimeoutMillis: 30000 });
export const storageBackend = () => 'supabase';

async function q(text, params = []) { const r = await pool.query(text, params); return r.rows; }
async function q1(text, params = []) { const r = await pool.query(text, params); return r.rows[0] || null; }
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
  await pool.query(`
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
      college text, name text, contest_url text, slug text, share_token text, created_at timestamptz default now()
    );
    CREATE TABLE IF NOT EXISTS hc_contest_students (contest_id bigint, username_key text, primary key(contest_id, username_key));
    CREATE TABLE IF NOT EXISTS hc_scrapes (
      id bigint generated always as identity primary key,
      slug text, contest_name text, total_users int, total_questions int, payload jsonb, created_at timestamptz default now()
    );
    CREATE TABLE IF NOT EXISTS hc_topics (slug text, question text, topic text, primary key(slug, question));
    CREATE TABLE IF NOT EXISTS hc_topic_videos (slug text, topic text, video_url text, primary key(slug, topic));
    CREATE TABLE IF NOT EXISTS hc_question_categories (slug text, question text, category text, primary key(slug, question));
    CREATE TABLE IF NOT EXISTS hc_app_settings (key text primary key, value text);

    -- Indexes for the columns we filter/sort on (huge win on a remote DB).
    CREATE INDEX IF NOT EXISTS idx_hc_students_college ON hc_students(college);
    CREATE INDEX IF NOT EXISTS idx_hc_students_college_name ON hc_students(college, name);
    CREATE INDEX IF NOT EXISTS idx_hc_contests_college ON hc_contests(college);
    CREATE INDEX IF NOT EXISTS idx_hc_contests_share_token ON hc_contests(share_token);
    CREATE INDEX IF NOT EXISTS idx_hc_contest_students_contest ON hc_contest_students(contest_id);
    CREATE INDEX IF NOT EXISTS idx_hc_scrapes_slug_id ON hc_scrapes(slug, id DESC);
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
        (c.access_code IS NOT NULL AND c.access_code <> '') AS has_code, COUNT(s.id) AS students
      FROM hc_colleges c LEFT JOIN hc_students s ON s.college = c.name
      GROUP BY c.id, c.name, c.contest_url, c.slug, c.access_code ORDER BY c.name`);
    return rows.map((r) => ({ id: Number(r.id), name: r.name, contestUrl: r.contest_url || '', slug: r.slug || '', hasCode: !!r.has_code, students: Number(r.students) }));
  } catch (err) {
    try {
      const rows = await q(`SELECT c.id, c.name, c.contest_url, c.slug,
          (c.access_code IS NOT NULL AND c.access_code <> '') AS has_code, COUNT(s.id) AS students
        FROM colleges c LEFT JOIN students s ON s.college = c.name
        GROUP BY c.id, c.name, c.contest_url, c.slug, c.access_code ORDER BY c.name`);
      return rows.map((r) => ({ id: Number(r.id), name: r.name, contestUrl: r.contest_url || '', slug: r.slug || '', hasCode: !!r.has_code, students: Number(r.students) }));
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
function mapContest(c) { return c ? { id: Number(c.id), college: c.college, name: c.name, contestUrl: c.contest_url || '', slug: c.slug || '', shareToken: c.share_token || '' } : null; }
export async function listContests(college) {
  const rows = college
    ? await q('SELECT id,college,name,contest_url,slug,share_token FROM hc_contests WHERE college=$1 ORDER BY id', [college])
    : await q('SELECT id,college,name,contest_url,slug,share_token FROM hc_contests ORDER BY college, id');
  return rows.map(mapContest);
}
export async function getContest(id) { return mapContest(await q1('SELECT id,college,name,contest_url,slug,share_token FROM hc_contests WHERE id=$1', [Number(id)])); }
export async function getContestByShareToken(token) { if (!token) return null; return mapContest(await q1('SELECT id,college,name,contest_url,slug,share_token FROM hc_contests WHERE share_token=$1', [String(token)])); }
export async function setContestShareToken(id, token) { await q('UPDATE hc_contests SET share_token=$1 WHERE id=$2', [token, Number(id)]); }
export async function addContest({ college, name, contestUrl = '', slug = '' }) {
  const col = String(college || '').trim(); const nm = String(name || '').trim();
  if (!col) throw new Error('College is required.'); if (!nm) throw new Error('Contest name is required.');
  const r = await q1('INSERT INTO hc_contests(college,name,contest_url,slug) VALUES($1,$2,$3,$4) RETURNING id,college,name,contest_url,slug,share_token', [col, nm, contestUrl, slug]);
  return mapContest(r);
}
export async function updateContest(id, { name, contestUrl, slug }) {
  const cur = await getContest(id); if (!cur) return null;
  const next = { name: name !== undefined ? String(name).trim() : cur.name, contestUrl: contestUrl !== undefined ? contestUrl : cur.contestUrl, slug: slug !== undefined ? slug : cur.slug };
  await q('UPDATE hc_contests SET name=$1,contest_url=$2,slug=$3 WHERE id=$4', [next.name, next.contestUrl, next.slug, Number(id)]);
  return getContest(id);
}
export async function deleteContest(id) {
  const ct = await getContest(id); if (!ct) return false;
  await q('DELETE FROM hc_contests WHERE id=$1', [Number(id)]);
  await q('DELETE FROM hc_contest_students WHERE contest_id=$1', [Number(id)]);
  if (ct.slug) {
    const others = await q('SELECT id FROM hc_contests WHERE slug=$1', [ct.slug]);
    if (!others.length) {
      for (const t of ['hc_scrapes', 'hc_topics', 'hc_topic_videos', 'hc_question_categories']) await q(`DELETE FROM ${t} WHERE slug=$1`, [ct.slug]);
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
  const vals = []; const groups = [];
  rows.forEach((r, i) => { groups.push('(' + cols.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')'); for (const c of cols) vals.push(r[c]); });
  await q(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${groups.join(',')} ON CONFLICT(${conflict}) DO NOTHING`, vals);
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
    const vals = []; const groups = [];
    recs.forEach((r, i) => { groups.push('(' + cols.map((_, j) => '$' + (i * cols.length + j + 1)).join(',') + ')'); for (const c of cols) vals.push(r[c]); });
    await q(`INSERT INTO hc_students(${cols.join(',')}) VALUES ${groups.join(',')}
      ON CONFLICT(college,username_key) DO UPDATE SET name=excluded.name, hr_username=excluded.hr_username,
        register_no=excluded.register_no, email=excluded.email, department=excluded.department, section=excluded.section, year=excluded.year, campus=excluded.campus`, vals);
  }
  return { count: recs.length };
}
// ===================== App settings (key/value) =====================
export async function getSetting(key) { const r = await q1('SELECT value FROM hc_app_settings WHERE key=$1', [key]); return r ? r.value : null; }
export async function setSetting(key, value) { await q('INSERT INTO hc_app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]); }

// Distinct department / section / year for a college (for dropdowns).
export async function getStudentFacets(college) {
  if (!college) return { departments: [], sections: [], years: [] };
  const r = await q1(`SELECT
      array_agg(DISTINCT department) FILTER (WHERE department IS NOT NULL AND department <> '') AS departments,
      array_agg(DISTINCT section)    FILTER (WHERE section    IS NOT NULL AND section    <> '') AS sections,
      array_agg(DISTINCT year)       FILTER (WHERE year       IS NOT NULL AND year       <> '') AS years
    FROM hc_students WHERE college=$1`, [college]);
  const s = (a) => (a || []).slice().sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }));
  return { departments: s(r && r.departments), sections: s(r && r.sections), years: s(r && r.years) };
}
export async function deleteStudents(ids) {
  const arr = (ids || []).map(Number); if (!arr.length) return 0;
  const r = await pool.query('DELETE FROM hc_students WHERE id = ANY($1::bigint[])', [arr]);
  return r.rowCount;
}

// ===================== Scrapes =====================
export async function saveScrape(slug, payload) {
  const createdAt = new Date().toISOString();
  const meta = { contestName: payload?.contest?.name || slug, totalUsers: payload?.summary?.totalUsers || 0, totalQuestions: payload?.summary?.totalQuestions || 0 };
  const r = await q1('INSERT INTO hc_scrapes(slug,contest_name,total_users,total_questions,created_at,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id', [slug, meta.contestName, meta.totalUsers, meta.totalQuestions, createdAt, JSON.stringify(payload)]);
  return { id: Number(r.id), createdAt };
}
export async function getLatestScrape(slug) {
  if (!slug) return null;
  const r = await q1('SELECT payload FROM hc_scrapes WHERE slug=$1 ORDER BY id DESC LIMIT 1', [slug]);
  return r ? r.payload : null;
}
// Keep the DB small: for a course, keep only the LATEST scrape of each calendar
// day, and only the most recent `keepDays` days. Old rows are the biggest storage
// hog and slow down the daily-series query.
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
  // One row per calendar day (the last scrape of that day), so we don't transfer
  // intermediate snapshots. Extract only username+solved from the jsonb payload
  // server-side to shrink the payload crossing the network.
  const rows = await q(`
    SELECT DISTINCT ON (created_at::date) created_at::date AS day,
      (SELECT jsonb_agg(jsonb_build_object('u', u->>'username', 's', u->'solved'))
         FROM jsonb_array_elements(payload->'users') AS u) AS users
    FROM hc_scrapes WHERE slug=$1
    ORDER BY created_at::date ASC, id DESC`, [slug]);
  return rows.map((r) => {
    const solved = {};
    for (const u of (r.users || [])) solved[String(u.u).toLowerCase()] = u.s;
    const day = (r.day instanceof Date ? r.day.toISOString() : String(r.day)).slice(0, 10);
    return { day, solved };
  });
}

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
