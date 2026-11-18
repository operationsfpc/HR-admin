const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = (el, m, k = 'info') => { el.textContent = m; el.className = `status ${k}`; };
let students = [];
let contests = [];
let cur = {};             // { college, code, hrUsername, contestId }
let svQuestions = [];
let topicVideos = {};
const CAT_LABELS = { inclass: 'In-class', postclass: 'Post-class', challenges: 'Challenges' };

function questionUrl(q) { const u = q.url; if (!u || u === '#') return null; return u.startsWith('http') ? u : 'https://www.hackerrank.com' + (u.startsWith('/') ? u : '/' + u); }
// Split "Topic - Question title" into { tag, title }.
function splitTitle(name) {
  const m = String(name).split(/\s+[–—-]\s+/);
  if (m.length >= 2) return { tag: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  return { tag: '', title: String(name) };
}

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `Request failed (${res.status}) — if this says 404, restart the server.`);
  return d;
}

$('continue-btn').addEventListener('click', onContinue);
async function onContinue() {
  const college = $('college').value.trim(); const code = $('code').value.trim();
  if (!college || !code) return setStatus($('login-status'), 'Enter college and access code.', 'err');
  if ($('name-row').style.display === 'none') {
    try {
      const d = await post('/api/student/login', { college, accessCode: code });
      students = d.students || []; contests = [];
      if (!students.length) return setStatus($('login-status'), 'No students in this college yet. Ask your admin.', 'err');
      $('name-select').innerHTML = `<option value="">Select your name…</option>` + students.map((s) => `<option value="${esc(s.hrUsername)}">${esc(s.name || s.hrUsername)} (${esc(s.hrUsername)})</option>`).join('');
      $('name-row').style.display = 'flex';
      $('contest-row').style.display = 'none';
      setStatus($('login-status'), 'Pick your name to load your contests.', 'ok');
    } catch (e) { setStatus($('login-status'), e.message, 'err'); }
    return;
  }
  const hrUsername = $('name-select').value;
  if (!hrUsername) return setStatus($('login-status'), 'Select your name.', 'err');
  if (!contests.length) return setStatus($('login-status'), 'No courses are assigned to you yet. Ask your admin.', 'err');
  const contestId = $('contest-select').value || String(contests[0].id);
  cur = { college, code, hrUsername, contestId };
  loadPractice();
}

// When the student picks their name, load only the contests mapped to them.
$('name-select').addEventListener('change', async (e) => {
  const hrUsername = e.target.value;
  const college = $('college').value.trim(), code = $('code').value.trim();
  if (!hrUsername) { $('contest-row').style.display = 'none'; return; }
  try {
    const d = await post('/api/student/contests', { college, accessCode: code, hrUsername });
    contests = d.contests || [];
    $('contest-select').innerHTML = contests.length ? contests.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') : `<option value="">No courses assigned to you</option>`;
    $('contest-row').style.display = 'flex';
    setStatus($('login-status'), contests.length ? 'Pick your course, then Continue.' : 'No courses are assigned to you yet.', contests.length ? 'ok' : 'err');
  } catch (err) { setStatus($('login-status'), err.message, 'err'); }
});

async function loadPractice() {
  try { render(await post('/api/student/practice', { college: cur.college, accessCode: cur.code, hrUsername: cur.hrUsername, contestId: cur.contestId })); }
  catch (e) { setStatus($('login-status'), e.message, 'err'); }
}
$('sv-contest-switch').addEventListener('change', (e) => { cur.contestId = e.target.value; loadPractice(); });

function render(d) {
  const college = cur.college, hrUsername = cur.hrUsername;
  $('login-main').classList.add('hidden');
  $('practice-main').classList.remove('hidden');
  const me = students.find((s) => s.hrUsername === hrUsername);
  const who = $('who'); who.textContent = `${me?.name || hrUsername}`; who.classList.remove('hidden');
  $('logout-btn2').classList.remove('hidden');
  $('sv-contest-switch').innerHTML = contests.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (contests.some((c) => String(c.id) === String(cur.contestId))) $('sv-contest-switch').value = cur.contestId;

  topicVideos = d.topicVideos || {};
  const qs = d.questions || [];
  if (!d.contest || !qs.length) {
    $('sv-header').innerHTML = `<h1>${esc(me?.name || hrUsername)}</h1><p class="muted">No course published for ${esc(college)} yet. Check back later.</p>`;
    $('sv-tabs').classList.add('hidden'); $('sv-stats').innerHTML = ''; $('sv-topics').innerHTML = ''; $('sv-list').innerHTML = ''; $('sv-pager').innerHTML = '';
    return;
  }
  const st = d.stats || { solved: qs.filter((q) => q.solved).length, total: qs.length, score: qs.reduce((a, q) => a + (q.score || 0), 0), attempted: qs.filter((q) => q.attempted).length, completion: 0, rank: null, participants: 0 };
  const pct = st.completion || Math.round((st.solved / st.total) * 100);
  $('sv-header').innerHTML =
    `<div class="hero-top">
       <div><h1>${esc(me?.name || hrUsername)}</h1><div class="hero-sub">${esc(college)} · <b>${esc(d.contest.name)}</b></div></div>
       <div class="hero-ring" style="--p:${pct}"><span>${pct}%</span></div>
     </div>`;

  // Dashboard section: stat cards + by-topic
  $('sv-stats').innerHTML = [
    ['Solved', `${st.solved}/${st.total}`], ['Score', st.score], ['Completion', pct + '%'],
    ['Attempted', st.attempted], st.rank ? ['Course rank', `#${st.rank}`] : null,
  ].filter(Boolean).map(([l, v]) => `<div class="stat"><div class="value">${v}</div><div class="label">${esc(l)}</div></div>`).join('');

  const topics = new Map();
  for (const q of qs) { const t = q.topic || splitTitle(q.name).tag || 'Other'; if (!topics.has(t)) topics.set(t, { total: 0, solved: 0 }); const e = topics.get(t); e.total++; if (q.solved) e.solved++; }
  $('sv-topics').innerHTML = Array.from(topics.entries()).map(([t, e]) => {
    const pct = e.total ? Math.round((e.solved / e.total) * 100) : 0;
    return `<div class="tc-row"><span class="tc-name">${esc(t)}</span><div class="bar"><span style="width:${pct}%"></span></div><span class="tc-count">${e.solved}/${e.total}</span></div>`;
  }).join('');

  // Practice section — questions grouped under foldable topics.
  svQuestions = qs.slice();
  renderPractice();
}

function renderPractice() {
  const groups = new Map();
  for (const q of svQuestions) {
    const t = q.topic || splitTitle(q.name).tag || 'Other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(q);
  }
  let gi = 0;
  $('sv-list').innerHTML = Array.from(groups.entries()).map(([topic, qs]) => {
    const solved = qs.filter((q) => q.solved).length;
    const body = qs.map((q) => {
      const { title } = splitTitle(q.name);
      const url = questionUrl(q);
      const cls = q.solved ? 'solved' : q.attempted ? 'attempted' : 'none';
      const txt = q.solved ? 'Solved' : q.attempted ? 'Attempted' : 'To do';
      const titleHtml = url ? `<a href="#" class="q-open" data-url="${esc(url)}" data-name="${esc(title)}">${esc(title)}</a>` : esc(title);
      const action = url ? `<a class="solve-link q-open ${q.solved ? 'review' : ''}" href="#" data-url="${esc(url)}" data-name="${esc(title)}">${q.solved ? 'Review →' : 'Solve →'}</a>` : `<span class="muted">no link</span>`;
      const cat = CAT_LABELS[q.category];
      const catChip = cat ? `<span class="q-cat cat-${q.category}">${cat}</span>` : '';
      return `<div class="q-row ${q.solved ? 'done' : ''}"><div class="q-main"><div class="q-title">${titleHtml} ${catChip}</div></div><div class="q-status"><span class="badge ${cls}">${txt}</span></div><div class="q-action">${action}</div></div>`;
    }).join('');
    const done = solved === qs.length;
    const vids = topicVideos[topic] || [];
    const watch = vids.map((u, i) => `<a class="solve-link tg-watch vid-open" href="#" data-url="${esc(u)}" data-name="${esc(topic)}">🎬 ${vids.length > 1 ? 'Video ' + (i + 1) : 'Watch'}</a>`).join('');
    return `<div class="topic-group${done ? ' collapsed' : ''}"><div class="topic-head" data-g="${gi++}"><span class="chev">▾</span><span class="tg-name">${esc(topic)}</span>${watch}<span class="muted tg-count">${solved}/${qs.length} solved</span></div><div class="topic-body">${body}</div></div>`;
  }).join('');
  $('sv-pager').innerHTML = '';
}
// Fold / unfold a topic (ignore clicks on the question links inside).
$('sv-list').addEventListener('click', (e) => {
  const vid = e.target.closest('.vid-open[data-url]');
  if (vid) { e.preventDefault(); openVideo(vid.dataset.url, vid.dataset.name); return; }
  if (e.target.closest('a')) return; // let question links work
  const head = e.target.closest('.topic-head');
  if (head) head.parentElement.classList.toggle('collapsed');
});

// Play a video in-app (same tab). YouTube links are converted to embeds.
function toEmbed(url) {
  try {
    const u = new URL(url);
    let id = '';
    if (u.hostname.includes('youtu.be')) id = u.pathname.slice(1);
    else if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2];
    }
    if (id) return `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`;
  } catch { /* ignore */ }
  return url;
}
function openVideo(url, title) {
  $('vid-title').textContent = title || 'Video';
  $('vid-frame').src = toEmbed(url);
  $('vid-overlay').classList.remove('hidden');
}
function closeVideo() { $('vid-overlay').classList.add('hidden'); $('vid-frame').src = 'about:blank'; }
$('vid-back').addEventListener('click', closeVideo);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('vid-overlay').classList.contains('hidden')) closeVideo(); });

// Sub-tab switching
document.querySelectorAll('#sv-tabs .subtab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#sv-tabs .subtab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.sv-section').forEach((s) => s.classList.toggle('active', s.id === 'sv-' + b.dataset.sec));
}));

$('logout-btn').addEventListener('click', () => location.reload());
$('logout-btn2').addEventListener('click', () => location.reload());
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') onContinue(); });

// HackerRank forbids embedding its pages in an iframe (X-Frame-Options / CSP),
// so questions open in a new tab — this keeps the student's place + login.
document.getElementById('sv-list').addEventListener('click', (e) => {
  const a = e.target.closest('.q-open[data-url]');
  if (!a) return;
  e.preventDefault();
  window.open(a.dataset.url, '_blank', 'noopener');
});
