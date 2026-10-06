// HackerRank scraping logic ported from the Chrome extension's background.js
// to run server-side in Node (>=18, uses global fetch / undici).
//
// The extension relied on chrome.cookies + credentials:"include". Server-side we
// manage our own cookie jar by reading Set-Cookie headers and replaying them.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE_URL = 'https://www.hackerrank.com';

// ---------------------------------------------------------------------------
// Cookie jar
// ---------------------------------------------------------------------------
export function createJar() {
  return new Map(); // name -> value
}

function ingestSetCookie(jar, res) {
  // Node 18.14+/undici exposes getSetCookie(); fall back to raw header.
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') {
    list = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = [raw];
  }
  for (const line of list) {
    const first = line.split(';')[0];
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function jarFetch(jar, url, options = {}) {
  // Follow redirects manually so we can capture Set-Cookie at EVERY hop.
  // (A normal redirect:"follow" hides intermediate cookies, and HackerRank sets
  // its csrf_token cookie on a redirect from /auth/login — which is exactly the
  // cookie the browser extension relied on.)
  let currentUrl = url;
  let method = options.method || 'GET';
  let body = options.body;
  const maxRedirects = 6;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const headers = new Headers(options.headers || {});
    headers.set('user-agent', USER_AGENT);
    headers.set('accept-language', 'en-US,en;q=0.9');
    const cookie = cookieHeader(jar);
    if (cookie) headers.set('cookie', cookie);

    const res = await fetch(currentUrl, { ...options, method, body, headers, redirect: 'manual' });
    ingestSetCookie(jar, res);

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      // Per spec: 303 (and 301/302 after POST) become GET with no body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}

// ---------------------------------------------------------------------------
// CSRF + login
// ---------------------------------------------------------------------------
function extractCsrfToken(html) {
  if (!html) return null;
  const patterns = [
    /name=["']csrf-token["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+name=["']csrf-token["']/i,
    /name=["']_csrf_token["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+name=["']_csrf_token["']/i,
    /data-csrf=["']([^"']+)["']/i,
    /data-csrf-token=["']([^"']+)["']/i,
    /["']csrf_token["']\s*:\s*["']([^"']+)["']/i,
    /["']_csrf_token["']\s*:\s*["']([^"']+)["']/i,
    /csrfToken["']?\s*:\s*["']([^"']+)["']/i,
    /CSRF_TOKEN["']?\s*=\s*["']([^"']+)["']/i,
    /authenticity_token["']?\s+value=["']([^"']+)["']/i,
    /"csrf-token"\s*:\s*"([^"]+)"/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

export async function login(email, password) {
  if (!email || !password) throw new Error('Email and password are required.');

  const jar = createJar();

  // 0. Warm up: hit the homepage so HackerRank sets its baseline cookies
  //    (including csrf_token) before we touch the login endpoint.
  await jarFetch(jar, `${BASE_URL}/`, { method: 'GET' }).then((r) => r.text()).catch(() => {});

  // 1. Load login page to obtain a CSRF token + any additional cookies.
  const loginPage = await jarFetch(jar, `${BASE_URL}/auth/login`, { method: 'GET' });
  const loginHtml = await loginPage.text();
  let csrfToken = jar.get('_csrf_token') || jar.get('csrf_token') || extractCsrfToken(loginHtml);

  if (!csrfToken) {
    const looksBlocked = /captcha|cloudflare|access denied|unusual traffic/i.test(loginHtml);
    throw new Error(
      looksBlocked
        ? 'HackerRank returned a bot/security challenge instead of the login page, so no CSRF token was available. Log in once in a normal browser, then you can use HR_COOKIE in .env.'
        : 'Unable to extract CSRF token from HackerRank login page.'
    );
  }

  // 2. Submit credentials (try JSON first, fallback to URL-encoded form).
  let res;
  let bodyText = '';
  try {
    res = await jarFetch(jar, `${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        origin: BASE_URL,
        referer: `${BASE_URL}/auth/login`,
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': csrfToken,
        accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body: JSON.stringify({ login: email, password, remember_me: true, fallback: true }),
    });
    bodyText = await res.text();
  } catch {
    res = null;
  }

  if (!res || !res.ok || (bodyText && bodyText.includes('"status":false'))) {
    const form = new URLSearchParams({ login: email, password, remember_me: 'true' });
    const res2 = await jarFetch(jar, `${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        origin: BASE_URL,
        referer: `${BASE_URL}/auth/login`,
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': csrfToken,
        accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body: form,
    });
    const bodyText2 = await res2.text();
    if (res2.ok || !res) {
      res = res2;
      bodyText = bodyText2;
    }
  }

  if (!res.ok) {
    throw new Error(`Login failed (${res.status}): ${bodyText.slice(0, 300)}`);
  }

  // HackerRank returns JSON; a failed login often has status:false in the body.
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.status === false) {
      const msg = (parsed.errors && parsed.errors.join('; ')) || parsed.message || 'Invalid HackerRank credentials.';
      throw new Error(`Login rejected: ${msg}`);
    }
    if (parsed && parsed.csrf_token) csrfToken = parsed.csrf_token;
  } catch (e) {
    if (e.message && e.message.startsWith('Login rejected')) throw e;
  }

  const finalCsrf = jar.get('_csrf_token') || jar.get('csrf_token') || csrfToken;
  const hasSession = jar.has('_hrank_session') || jar.size > 1;
  if (!hasSession) {
    throw new Error('Login appeared to succeed but no session cookie was set.');
  }

  return { jar, csrfToken: finalCsrf };
}

// ---------------------------------------------------------------------------
// Contest slug parsing
// ---------------------------------------------------------------------------
export function parseContestSlug(input) {
  if (!input) throw new Error('A contest link or slug is required.');
  const raw = input.trim();

  // Already a bare slug (no slashes / dots).
  if (!raw.includes('/') && !raw.includes('.')) return raw;

  let url;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Could not parse contest link: ${input}`);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const ci = parts.indexOf('contests');
  if (ci !== -1 && parts[ci + 1]) return parts[ci + 1];
  // Some contest URLs are just /<slug>
  if (parts.length >= 1) return parts[0];
  throw new Error(`Could not find a contest slug in: ${input}`);
}

// ---------------------------------------------------------------------------
// Leaderboard (paginated)
// ---------------------------------------------------------------------------
export async function fetchLeaderboardPage({ jar, csrfToken, slug, offset = 0, limit = 100 }) {
  const url = `${BASE_URL}/rest/contests/${slug}/leaderboard?offset=${offset}&limit=${limit}`;
  const res = await jarFetch(jar, url, {
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrf-token': csrfToken || '',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Leaderboard fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Returns a normalized array of { username, rank, score }.
export async function fetchAllLeaderboard({ jar, csrfToken, slug, max = Infinity, pageSize = 100, onPage }) {
  const out = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total && out.length < max) {
    const page = await fetchLeaderboardPage({ jar, csrfToken, slug, offset, limit: pageSize });
    if (typeof page.total === 'number') total = page.total;
    const models = page.models || page.data || [];
    if (!models.length) break;

    for (const m of models) {
      out.push({
        username: m.hacker || m.username || m.hacker_username || m.slug,
        rank: m.rank,
        score: m.score != null ? m.score : m.solved,
      });
    }
    offset += models.length;
    if (onPage) onPage(Math.min(out.length, max));
    if (models.length < pageSize) break;
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Compare (per-challenge scores between two hackers)
// ---------------------------------------------------------------------------
export async function compare({ jar, csrfToken, slug, hacker1, hacker2 }) {
  const ts = Date.now();
  const url =
    `${BASE_URL}/rest/compare?contest_slug=${encodeURIComponent(slug)}` +
    `&hacker_slug_1=${encodeURIComponent(hacker1)}` +
    `&hacker_slug_2=${encodeURIComponent(hacker2)}&_=${ts}`;
  const res = await jarFetch(jar, url, {
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      'x-csrf-token': csrfToken || '',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Compare failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const p = parseFloat(v);
    if (!isNaN(p)) return p;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Build a users x questions completion matrix by comparing everyone against a
// fixed reference hacker. Mirrors createComparisonMatrix() from the extension.
// ---------------------------------------------------------------------------
export async function buildMatrix({ jar, csrfToken, slug, hackers, reference, concurrency = 8, onProgress }) {
  if (!hackers.length) throw new Error('No hackers to compare.');
  const ref = reference || hackers[0];
  const others = hackers.filter((h) => h !== ref);

  const questions = []; // ordered
  const questionSet = new Set();
  const userMap = new Map(); // username -> { [questionName]: {score, points, attempted, solved} }
  let contest = null;
  let completed = 0;
  const errors = [];

  function ingestChallenges(challenges, username, scoreKey, attemptedKey) {
    if (!userMap.has(username)) userMap.set(username, {});
    const bag = userMap.get(username);
    for (const c of challenges) {
      if (!questionSet.has(c.name)) {
        questionSet.add(c.name);
        questions.push({ name: c.name, url: c.url, points: c.point || c.points || 0 });
      }
      const score = num(c[scoreKey]);
      bag[c.name] = {
        score,
        points: c.point || c.points || 0,
        attempted: Boolean(c[attemptedKey]),
        solved: score > 0,
      };
    }
  }

  // Process the comparison list with bounded concurrency.
  let idx = 0;
  async function worker() {
    while (idx < others.length) {
      const hacker2 = others[idx++];
      try {
        const data = await compare({ jar, csrfToken, slug, hacker1: ref, hacker2 });
        const model = data && data.model;
        if (model) {
          if (!contest && model.contest) contest = model.contest;
          const challenges = model.challenges || [];
          // reference (hacker1) — only needs to be recorded once but harmless to repeat
          ingestChallenges(challenges, model.hacker1?.username || ref, 'score1', 'attempted1');
          ingestChallenges(challenges, model.hacker2?.username || hacker2, 'score2', 'attempted2');
        }
      } catch (err) {
        errors.push({ hacker: hacker2, error: err.message });
      } finally {
        completed++;
        if (onProgress) onProgress(completed, others.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, others.length) }, worker));

  return { reference: ref, contest, questions, userMap, errors };
}

export { BASE_URL };
