// Read-only shared contest dashboard — mirrors the admin Dashboard tab.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pathParts = location.pathname.split('/').filter(Boolean);
const isCollege = pathParts[0] === 'college';       // /college/<token> vs /view/<token>
const token = pathParts.pop();
const attUrl = (isCollege ? '/api/college/' : '/api/shared/') + token + '/attendance';
const heatColor = (p) => `hsl(${Math.round((p / 100) * 120)},70%,${p === 0 ? 30 : 52}%)`;
function questionUrl(q) { const u = q.url; if (!u || u === '#') return null; return u.startsWith('http') ? u : 'https://www.hackerrank.com' + (u.startsWith('/') ? u : '/' + u); }
function splitTitle(name) { const m = String(name).split(/\s+[–—-]\s+/); return m.length >= 2 ? { tag: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { tag: '', title: String(name) }; }

let dashData = null, dashTopics = {}, dashCats = {}, roster = [], dailyData = null;
let studentsPage = 1; const STUDENTS_PAGE = 50;
let currentContestId = '';
let taRows = [];
let compDist = [], compTotal = 0, compTotalQ = 0, compMax = 1, compPage = 1; const COMP_PAGE = 20;
let cbRows = [], cbPage = 1; const CB_PAGE = 20;

// Show only the tabs the admin enabled for shared links; activate the first visible one.
function applyTabs(tabs) {
  const t = tabs || { dashboard: true, daily: true, attendance: true };
  const map = { dashboard: t.dashboard !== false, daily: t.daily !== false, attendance: t.attendance !== false };
  let firstVisible = null;
  document.querySelectorAll('#view-tabs .tab').forEach((b) => {
    const on = map[b.dataset.vtab] !== false;
    b.classList.toggle('hidden', !on);
    if (on && !firstVisible) firstVisible = b;
  });
  const activeBtn = document.querySelector('#view-tabs .tab.active');
  if (!activeBtn || activeBtn.classList.contains('hidden')) { if (firstVisible) firstVisible.click(); }
}
function applyPayload(d) {
  if (d.tabs) applyTabs(d.tabs);
  dashData = d.dashboard; dashTopics = d.topics || {}; dashCats = d.categories || {}; roster = d.roster || []; dailyData = d.daily || null;
  $('view-title').textContent = isCollege ? `${d.college}` : `${d.contest.name} — ${d.college}`;
  document.title = isCollege ? `${d.college} · ${d.contest.name}` : `${d.contest.name} · ${d.college}`;
  studentsPage = 1;
  if (!dashData) {
    $('view-status').textContent = `"${d.contest.name}" has not been synced yet.`; $('view-status').className = 'status info';
    ['summary', 'topic-analysis-card', 'completion-card', 'category-card', 'topic-cat-card'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); });
    $('students-table').innerHTML = ''; renderDaily();
    return;
  }
  $('view-status').textContent = ''; $('view-status').className = 'status';
  fillFilters(); renderSummary(); renderTopicAnalysis(); renderCompletion(); renderCategoryChart(); renderStudents(); renderDaily();
}
async function boot() {
  try {
    if (isCollege) {
      const res = await fetch('/api/college/' + token + '/contests');
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Not found');
      applyTabs(d.tabs);
      $('view-title').textContent = d.college; document.title = d.college;
      const contests = d.contests || [];
      if (!contests.length) { $('view-status').textContent = 'No courses in this college yet.'; $('view-status').className = 'status info'; return; }
      if (contests.length > 1 && $('view-sync-all-btn')) $('view-sync-all-btn').classList.remove('hidden');
      const sel = $('view-contest'); $('view-contest-wrap').classList.remove('hidden');
      sel.innerHTML = contests.map((c) => `<option value="${c.id}">${esc(c.name)}${c.hasLink ? '' : ' (no link)'}</option>`).join('');
      sel.onchange = () => loadCollegeContest(sel.value);
      await loadCollegeContest(contests[0].id);
    } else {
      const res = await fetch('/api/shared/' + token);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Not found');
      applyPayload(d);
    }
  } catch (e) { $('view-status').textContent = e.message; $('view-status').className = 'status err'; }
}
async function loadCollegeContest(contestId) {
  currentContestId = String(contestId);
  $('view-status').textContent = 'Loading…'; $('view-status').className = 'status info';
  try {
    const res = await fetch('/api/college/' + token + '/contest/' + contestId);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Not found');
    applyPayload(d);
  } catch (e) { $('view-status').textContent = e.message; $('view-status').className = 'status err'; }
}

// ---------------- Read-only sync ----------------
function syncReadDashboard(syncAll = false) {
  const syncBtn = $('view-sync-btn');
  const syncAllBtn = $('view-sync-all-btn');
  if (syncBtn) syncBtn.disabled = true;
  if (syncAllBtn) syncAllBtn.disabled = true;

  const prog = $('view-progress');
  const progLab = $('view-prog-lab');
  const progFill = $('view-prog-fill');
  if (prog) prog.classList.remove('hidden');
  if (progLab) progLab.textContent = 'Starting sync…';
  if (progFill) progFill.style.width = '0%';

  const stat = $('view-status');
  stat.textContent = syncAll ? 'Syncing all courses for this college…' : 'Syncing course…';
  stat.className = 'status info';

  let url;
  if (isCollege) {
    url = '/api/college/' + token + '/sync-stream' + (syncAll ? '?contestId=all' : (currentContestId ? '?contestId=' + currentContestId : ''));
  } else {
    url = '/api/shared/' + token + '/sync-stream';
  }

  const stop = () => {
    if (syncBtn) syncBtn.disabled = false;
    if (syncAllBtn) syncAllBtn.disabled = false;
  };

  const es = new EventSource(url);
  es.addEventListener('start', (ev) => {
    const d = JSON.parse(ev.data);
    stat.textContent = `Syncing ${d.total} course(s) in ${d.college}…`;
  });
  es.addEventListener('contest', (ev) => {
    const p = JSON.parse(ev.data);
    if (progLab) progLab.textContent = `(${p.index}/${p.total}) ${p.name}: starting…`;
    if (progFill) progFill.style.width = Math.round(((p.index - 1) / p.total) * 100) + '%';
  });
  es.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    if (p.totalUsers != null) {
      if (progLab) progLab.textContent = `(${p.index}/${p.total}) ${p.name}: ${p.completed}/${p.totalUsers} users`;
      const frac = p.totalUsers ? Math.min(1, p.completed / p.totalUsers) : 0;
      if (progFill) progFill.style.width = Math.round((((p.index - 1) + frac) / p.total) * 100) + '%';
    } else {
      if (progLab) progLab.textContent = p.phase === 'leaderboard' ? `Fetching leaderboard… ${p.completed}` : `${p.completed} / ${p.total} users`;
      if (progFill) progFill.style.width = (p.total ? Math.round((p.completed / p.total) * 100) : 8) + '%';
    }
  });
  es.addEventListener('contest-done', (ev) => {
    const p = JSON.parse(ev.data);
    if (progFill) progFill.style.width = Math.round((p.index / p.total) * 100) + '%';
  });
  es.addEventListener('contest-failed', (ev) => {
    const p = JSON.parse(ev.data);
    console.warn('Contest sync failed:', p);
  });
  es.addEventListener('done', (ev) => {
    es.close();
    stop();
    if (progFill) progFill.style.width = '100%';
    const d = JSON.parse(ev.data);
    if (d.summary) {
      stat.textContent = `Synced successfully — ${d.summary.totalUsers} users, ${d.summary.totalQuestions} questions.`;
      stat.className = 'status ok';
    } else {
      const msg = `Synced ${d.ok} of ${d.total} course(s).` + (d.failures && d.failures.length ? ` ${d.failures.length} failed.` : '');
      stat.textContent = msg;
      stat.className = d.failures && d.failures.length ? 'status err' : 'status ok';
    }
    setTimeout(() => { if (prog) prog.classList.add('hidden'); }, 2000);
    // Refresh data
    if (isCollege) {
      if (currentContestId) loadCollegeContest(currentContestId);
    } else {
      fetch('/api/shared/' + token).then((r) => r.json()).then(applyPayload).catch((e) => console.error(e));
    }
  });
  es.addEventListener('failed', (ev) => {
    es.close();
    stop();
    if (prog) prog.classList.add('hidden');
    const err = JSON.parse(ev.data).error || 'Sync failed';
    stat.textContent = err;
    stat.className = 'status err';
  });
  es.onerror = () => {
    es.close();
    stop();
    if (prog) prog.classList.add('hidden');
  };
}
$('view-sync-btn')?.addEventListener('click', () => syncReadDashboard(false));
$('view-sync-all-btn')?.addEventListener('click', () => syncReadDashboard(true));

function joinedRows() {
  const byUser = new Map((dashData?.users || []).map((u) => [u.username.toLowerCase(), u]));
  return roster.map((s) => { const rawHr = String(s.hrUsername || '').trim(); const hasHrId = !!rawHr; const u = hasHrId ? byUser.get(rawHr.toLowerCase()) : null; const totalQ = dashData?.summary.totalQuestions || 0;
    return { ...s, hasHrId, inContest: !!u, solved: u ? u.solved : 0, score: u ? u.computedScore : 0, totalQ, completion: u && totalQ ? Math.round((u.solved / totalQ) * 100) : 0 }; });
}
function fillFilters() {
  const labels = { department: 'departments', section: 'sections', year: 'years', campus: 'campuses' };
  for (const [id, key] of [['f-campus', 'campus'], ['f-department', 'department'], ['f-section', 'section'], ['f-year', 'year']]) {
    const sel = $(id); const vals = Array.from(new Set(roster.map((s) => s[key]).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    sel.innerHTML = `<option value="">All ${labels[key]}</option>` + vals.map((v) => `<option>${esc(v)}</option>`).join('');
    sel.addEventListener('change', () => { studentsPage = 1; renderStudents(); });
  }
  $('f-search').addEventListener('input', () => { studentsPage = 1; renderStudents(); });
}
function filteredRows() {
  const f = { campus: $('f-campus').value, department: $('f-department').value, section: $('f-section').value, year: $('f-year').value, q: $('f-search').value.trim().toLowerCase() };
  return joinedRows().filter((r) => (!f.campus || r.campus === f.campus) && (!f.department || r.department === f.department) && (!f.section || r.section === f.section) && (!f.year || r.year === f.year) &&
    (!f.q || (r.name || '').toLowerCase().includes(f.q) || (r.hrUsername || '').toLowerCase().includes(f.q))).sort((a, b) => (a.hasHrId === b.hasHrId ? 0 : a.hasHrId ? -1 : 1) || b.solved - a.solved || b.score - a.score);
}
function renderSummary() {
  const sm = $('summary'); sm.classList.remove('hidden');
  const userKeys = new Set((dashData.users || []).map((u) => u.username.toLowerCase()));
  const inContest = roster.filter((s) => s.hrUsername && userKeys.has(String(s.hrUsername).trim().toLowerCase())).length;
  sm.innerHTML = [['Students', roster.length], ['In course', inContest], ['Questions', dashData.summary.totalQuestions], ['Avg solved', dashData.summary.avgSolved], ['Completion', dashData.summary.overallCompletion + '%']]
    .map(([l, v]) => `<div class="stat"><div class="value">${v}</div><div class="label">${l}</div></div>`).join('');
}

// ---- Topic analysis ----
function topicChartSVG(rows) {
  const rowH = 28, top = 8, left = 168, barMax = 320, W = 620, H = top * 2 + rows.length * rowH;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:${H}px;font-family:inherit">`;
  rows.forEach((r, i) => {
    const y = top + i * rowH; const bw = Math.max(2, Math.round((barMax * r.solveRate) / 100));
    const name = esc(r.topic.length > 24 ? r.topic.slice(0, 23) + '…' : r.topic);
    s += `<text x="${left - 8}" y="${y + 15}" text-anchor="end" fill="var(--text)" font-size="12">${name}</text>`;
    s += `<rect x="${left}" y="${y + 4}" width="${barMax}" height="16" rx="4" fill="var(--surface2)"/>`;
    s += `<rect x="${left}" y="${y + 4}" width="${bw}" height="16" rx="4" fill="${heatColor(r.solveRate)}"><title>${name}: ${r.solveRate}%</title></rect>`;
    s += `<text x="${left + barMax + 8}" y="${y + 15}" fill="var(--muted)" font-size="12">${r.solveRate}%</text>`;
  });
  return s + `</svg>`;
}
function renderTopicAnalysis() {
  const card = $('topic-analysis-card');
  const byUser = new Map(dashData.users.map((u) => [u.username.toLowerCase(), u]));
  const participants = roster.map((s) => byUser.get((s.hrUsername || '').toLowerCase())).filter(Boolean);
  if (!participants.length) { card.classList.add('hidden'); return; }
  const topicQs = new Map();
  for (const q of dashData.questions) { const t = dashTopics[q.name] || splitTitle(q.name).tag || 'Other'; if (!topicQs.has(t)) topicQs.set(t, []); topicQs.get(t).push(q.name); }
  // Keep topics in the order questions appear in the contest (same as the Topics tab).
  const rows = Array.from(topicQs.entries()).map(([topic, qs]) => {
    let solved = 0; for (const u of participants) for (const qn of qs) if (u.questionStatus[qn]?.solved) solved++;
    const denom = participants.length * qs.length;
    return { topic, questions: qs.length, solveRate: denom ? Math.round((solved / denom) * 100) : 0, avgSolved: +(solved / participants.length).toFixed(2) };
  });
  taRows = rows;
  const weakest = rows.reduce((a, b) => (b.solveRate < a.solveRate ? b : a), rows[0]);
  $('ta-note').textContent = `· ${participants.length} participants · ${rows.length} topics · weakest: ${weakest.topic} (${weakest.solveRate}%)`;
  $('ta-chart').innerHTML = topicChartSVG(rows);
  $('topic-analysis-table').innerHTML =
    `<thead><tr><th>#</th><th>Topic</th><th class="num">Questions</th><th class="num">Avg solved / student</th><th>Solve rate</th></tr></thead><tbody>` +
    rows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(r.topic)}</td><td class="num">${r.questions}</td><td class="num">${r.avgSolved}</td><td><div class="bar" style="display:inline-block;width:120px;vertical-align:middle"><span style="width:${r.solveRate}%"></span></div> <span class="muted">${r.solveRate}%</span></td></tr>`).join('') +
    `</tbody>`;
  card.classList.remove('hidden');
}
$('ta-chart-btn').addEventListener('click', () => { if (!taRows.length) return; $('ta-modal-chart').innerHTML = topicChartSVG(taRows); $('ta-modal').classList.remove('hidden'); });
$('ta-modal-close').addEventListener('click', () => $('ta-modal').classList.add('hidden'));
$('ta-modal').addEventListener('click', (e) => { if (e.target.id === 'ta-modal') $('ta-modal').classList.add('hidden'); });

// ---- Question categories ----
const CAT_LABELS = { inclass: 'In-class', postclass: 'Post-class', challenges: 'Challenges' };
function renderCategoryChart() {
  const card = $('category-card');
  if (!dashData) { card.classList.add('hidden'); return; }
  const byUser = new Map(dashData.users.map((u) => [u.username.toLowerCase(), u]));
  const participants = roster.map((s) => byUser.get((s.hrUsername || '').toLowerCase())).filter(Boolean);
  const catQs = new Map();
  for (const q of dashData.questions) { const c = dashCats[q.name]; if (!c) continue; if (!catQs.has(c)) catQs.set(c, []); catQs.get(c).push(q.name); }
  if (!participants.length || !catQs.size) { card.classList.add('hidden'); return; }
  const rows = ['inclass', 'postclass', 'challenges'].filter((c) => catQs.has(c)).map((c) => {
    const qs = catQs.get(c); let solved = 0;
    for (const u of participants) for (const qn of qs) if (u.questionStatus[qn]?.solved) solved++;
    const denom = participants.length * qs.length;
    return { topic: CAT_LABELS[c] || c, questions: qs.length, solveRate: denom ? Math.round((solved / denom) * 100) : 0 };
  });
  $('cat-note').textContent = `· ${participants.length} participants`;
  $('cat-chart').innerHTML = topicChartSVG(rows);
  $('cat-table').innerHTML =
    `<thead><tr><th>Category</th><th class="num">Questions</th><th class="num">Solve rate</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.topic)}</td><td class="num">${r.questions}</td><td class="num">${r.solveRate}%</td></tr>`).join('') + `</tbody>`;

  const present = ['inclass', 'postclass', 'challenges'].filter((c) => catQs.has(c));
  const topicOrder = []; const tset = new Set(); const cellMap = {};
  for (const q of dashData.questions) {
    const cat = dashCats[q.name]; if (!cat || !present.includes(cat)) continue;
    const topic = dashTopics[q.name] || splitTitle(q.name).tag || 'Other';
    if (!tset.has(topic)) { tset.add(topic); topicOrder.push(topic); }
    cellMap[topic] = cellMap[topic] || {};
    cellMap[topic][cat] = cellMap[topic][cat] || { total: 0, solved: 0, qs: [] };
    const e = cellMap[topic][cat]; e.total++; e.qs.push(q.name);
    for (const u of participants) if (u.questionStatus[q.name]?.solved) e.solved++;
  }
  tcCellMap = cellMap;
  $('cat-topic-table').innerHTML =
    `<thead><tr><th>Topic</th>${present.map((c) => `<th class="num">${CAT_LABELS[c]}</th>`).join('')}</tr></thead><tbody>` +
    topicOrder.map((t) => `<tr><td>${esc(t)}</td>${present.map((c) => {
      const e = cellMap[t] && cellMap[t][c];
      if (!e) return '<td class="num muted">—</td>';
      const pct = e.total ? Math.round((e.solved / (participants.length * e.total)) * 100) : 0;
      return `<td class="tcell" data-topic="${esc(t)}" data-cat="${c}" style="background:${heatColor(pct)};cursor:pointer">${pct}% <span style="opacity:.7">(${e.total})</span></td>`;
    }).join('')}</tr>`).join('') + `</tbody>`;
  card.classList.remove('hidden');
}
let tcCellMap = {}, tcRows = [], tcFilter = 'all', tcPage = 1;
const TC_PAGE = 20;
$('cat-topic-table').addEventListener('click', (e) => { const td = e.target.closest('td.tcell[data-topic]'); if (td) openTopicCat(td.dataset.topic, td.dataset.cat); });
function openTopicCat(topic, cat) {
  const entry = tcCellMap[topic] && tcCellMap[topic][cat]; if (!entry) return;
  const qs = entry.qs; const byUser = new Map(dashData.users.map((u) => [u.username.toLowerCase(), u]));
  const rows = [];
  for (const s of roster) { const u = byUser.get((s.hrUsername || '').toLowerCase()); if (!u) continue; const solved = qs.filter((qn) => u.questionStatus[qn]?.solved).length; rows.push({ name: s.name || s.hrUsername, hrUsername: s.hrUsername, department: s.department, section: s.section, solved, total: qs.length, completed: solved === qs.length }); }
  const done = rows.filter((r) => r.completed).length;
  tcRows = rows.sort((a, b) => (b.completed - a.completed) || (b.solved - a.solved)); tcFilter = 'all'; tcPage = 1;
  $('tc-modal-title').textContent = `${topic} · ${CAT_LABELS[cat] || cat} — ${done}/${rows.length} completed (${qs.length} question${qs.length > 1 ? 's' : ''})`;
  renderTcPage(); $('tc-modal').classList.remove('hidden');
}
function tcFiltered() { return tcFilter === 'done' ? tcRows.filter((r) => r.completed) : tcFilter === 'not' ? tcRows.filter((r) => !r.completed) : tcRows; }
function renderTcPage() {
  const all = tcFiltered(); const pages = Math.max(1, Math.ceil(all.length / TC_PAGE));
  if (tcPage > pages) tcPage = pages;
  const start = (tcPage - 1) * TC_PAGE; const slice = all.slice(start, start + TC_PAGE);
  document.querySelectorAll('#tc-filter-all,#tc-filter-done,#tc-filter-not').forEach((b) => b.classList.remove('active-filter'));
  $('tc-filter-' + (tcFilter === 'done' ? 'done' : tcFilter === 'not' ? 'not' : 'all')).classList.add('active-filter');
  $('tc-modal-table').innerHTML =
    `<thead><tr><th>#</th><th>Student</th><th>HR username</th><th>Dept</th><th>Section</th><th class="num">Solved</th><th>Status</th></tr></thead><tbody>` +
    (slice.length ? slice.map((r, i) => `<tr><td class="num">${start + i + 1}</td><td><a class="user-link" data-user="${esc(r.hrUsername)}">${esc(r.name)}</a></td><td>${esc(r.hrUsername)}</td><td>${esc(r.department || '—')}</td><td>${esc(r.section || '—')}</td><td class="num">${r.solved}/${r.total}</td><td><span class="badge ${r.completed ? 'solved' : 'attempted'}">${r.completed ? 'Completed' : 'Not completed'}</span></td></tr>`).join('')
      : `<tr><td colspan="7" class="muted">None.</td></tr>`) + `</tbody>`;
  const from = all.length ? start + 1 : 0;
  $('tc-pager').innerHTML = all.length > TC_PAGE ? `<button class="ghost sm" id="tc-prev" ${tcPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + TC_PAGE, all.length)} of ${all.length} · page ${tcPage}/${pages}</span><button class="ghost sm" id="tc-next" ${tcPage >= pages ? 'disabled' : ''}>Next ›</button>` : '';
  if (all.length > TC_PAGE) { $('tc-prev').addEventListener('click', () => { if (tcPage > 1) { tcPage--; renderTcPage(); } }); $('tc-next').addEventListener('click', () => { if (tcPage < pages) { tcPage++; renderTcPage(); } }); }
}
$('tc-filter-all').addEventListener('click', () => { tcFilter = 'all'; tcPage = 1; renderTcPage(); });
$('tc-filter-done').addEventListener('click', () => { tcFilter = 'done'; tcPage = 1; renderTcPage(); });
$('tc-filter-not').addEventListener('click', () => { tcFilter = 'not'; tcPage = 1; renderTcPage(); });
$('tc-modal-close').addEventListener('click', () => $('tc-modal').classList.add('hidden'));
$('tc-modal').addEventListener('click', (e) => { if (e.target.id === 'tc-modal') $('tc-modal').classList.add('hidden'); });
$('tc-modal-table').addEventListener('click', (e) => { const l = e.target.closest('.user-link[data-user]'); if (l) { e.preventDefault(); $('tc-modal').classList.add('hidden'); openPerf(l.dataset.user); } });

// ---- Completion breakdown ----
function completionBands(totalQ, step = 10) {
  const bands = [{ label: '0', lo: 0, hi: 0 }];
  for (let lo = 1; lo <= totalQ; lo += step) { const hi = Math.min(lo + step - 1, totalQ); bands.push({ label: lo === hi ? `${lo}` : `${lo}–${hi}`, lo, hi }); }
  return bands;
}
function defaultBandSize(totalQ) { return totalQ > 150 ? 20 : totalQ > 100 ? 15 : 10; }
let cbLastTotalQ = null;
$('cb-band-size').addEventListener('change', renderCompletion);
function renderCompletion() {
  const card = $('completion-card'); const rows = joinedRows();
  if (!rows.length) { card.classList.add('hidden'); return; }
  const totalQ = dashData.summary.totalQuestions;
  const total = rows.length;
  if (cbLastTotalQ !== totalQ) { $('cb-band-size').value = String(defaultBandSize(totalQ)); cbLastTotalQ = totalQ; }
  const step = parseInt($('cb-band-size').value, 10) || 10;
  const bands = completionBands(totalQ, step).map((b) => ({ ...b, count: rows.filter((r) => r.solved >= b.lo && r.solved <= b.hi).length }));
  $('cb-note').textContent = `· ${total} students`;
  $('completion-chart').innerHTML = completionBarSVG(bands, total);
  $('completion-pager').innerHTML = '';
  card.classList.remove('hidden');
}
function completionBarSVG(bands, total) {
  const W = 640, H = 260, padL = 40, padB = 46, padT = 14, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = bands.length, gap = 8;
  const bw = Math.max(6, (plotW - gap * (n - 1)) / n);
  const maxCount = Math.max(...bands.map((b) => b.count), 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="font-family:inherit;display:inline-block;width:100%;max-width:${W}px;max-height:${H}px">`;
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (plotH * g) / 4;
    s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    s += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${Math.round((maxCount * g) / 4)}</text>`;
  }
  bands.forEach((b, i) => {
    const x = padL + i * (bw + gap);
    const h = Math.round((plotH * b.count) / maxCount);
    const y = padT + plotH - h;
    const pct = total ? Math.round((b.count / total) * 100) : 0;
    s += `<rect class="cb-bar" data-lo="${b.lo}" data-hi="${b.hi}" data-label="${esc(b.label)}" x="${x}" y="${y}" width="${bw}" height="${Math.max(0, h)}" rx="3" fill="var(--accent)" style="cursor:pointer"><title>${esc(b.label)}: ${b.count} students (${pct}%)</title></rect>`;
    if (b.count) s += `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" fill="var(--text)" font-size="11" style="pointer-events:none">${b.count}</text>`;
    s += `<text x="${x + bw / 2}" y="${H - padB + 16}" text-anchor="middle" fill="var(--muted)" font-size="11" style="pointer-events:none">${esc(b.label)}</text>`;
  });
  s += `<text x="${padL}" y="${H - 6}" fill="var(--muted)" font-size="11">Questions solved →</text>`;
  return s + `</svg>`;
}
$('completion-chart').addEventListener('click', (e) => { const bar = e.target.closest('.cb-bar[data-lo]'); if (bar) openCompletionNames(Number(bar.dataset.lo), Number(bar.dataset.hi), bar.dataset.label); });
function openCompletionNames(lo, hi, label) {
  const totalQ = dashData.summary.totalQuestions;
  cbRows = joinedRows().filter((r) => r.solved >= lo && r.solved <= hi).sort((a, b) => b.solved - a.solved || b.score - a.score); cbPage = 1;
  $('cb-modal-title').textContent = `${cbRows.length} student(s) solved ${lo === hi ? lo : (label || lo + '–' + hi)} / ${totalQ}`;
  renderCbPage(); $('cb-modal').classList.remove('hidden');
}
function renderCbPage() {
  const total = cbRows.length; const pages = Math.max(1, Math.ceil(total / CB_PAGE));
  if (cbPage > pages) cbPage = pages;
  const start = (cbPage - 1) * CB_PAGE, slice = cbRows.slice(start, start + CB_PAGE);
  $('cb-modal-table').innerHTML = `<thead><tr><th>#</th><th>Student</th><th>HR username</th><th>Dept</th><th>Section</th><th class="num">Solved</th><th class="num">Score</th></tr></thead><tbody>` +
    (slice.length ? slice.map((r, idx) => `<tr><td class="num">${start + idx + 1}</td><td><a class="user-link" data-user="${esc(r.hrUsername)}">${esc(r.name || r.hrUsername)}</a></td><td>${esc(r.hrUsername)}</td><td>${esc(r.department || '—')}</td><td>${esc(r.section || '—')}</td><td class="num">${r.solved}</td><td class="num">${r.score}</td></tr>`).join('') : `<tr><td colspan="7" class="muted">No students.</td></tr>`) + `</tbody>`;
  const from = total ? start + 1 : 0;
  $('cb-pager').innerHTML = total > CB_PAGE ? `<button class="ghost sm" id="cb-prev" ${cbPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + CB_PAGE, total)} of ${total} · page ${cbPage}/${pages}</span><button class="ghost sm" id="cb-next" ${cbPage >= pages ? 'disabled' : ''}>Next ›</button>` : '';
  if (total > CB_PAGE) { $('cb-prev').addEventListener('click', () => { if (cbPage > 1) { cbPage--; renderCbPage(); } }); $('cb-next').addEventListener('click', () => { if (cbPage < pages) { cbPage++; renderCbPage(); } }); }
}
$('cb-modal-close').addEventListener('click', () => $('cb-modal').classList.add('hidden'));
$('cb-modal').addEventListener('click', (e) => { if (e.target.id === 'cb-modal') $('cb-modal').classList.add('hidden'); });
$('cb-modal-table').addEventListener('click', (e) => { const l = e.target.closest('.user-link[data-user]'); if (l) { e.preventDefault(); $('cb-modal').classList.add('hidden'); openPerf(l.dataset.user); } });

// ---- Students table ----
function renderStudents() {
  const all = filteredRows(); const pages = Math.max(1, Math.ceil(all.length / STUDENTS_PAGE));
  if (studentsPage > pages) studentsPage = pages;
  const start = (studentsPage - 1) * STUDENTS_PAGE, rows = all.slice(start, start + STUDENTS_PAGE);
  $('students-table').innerHTML =
    `<thead><tr><th>#</th><th class="grow">Student</th><th class="grow">HR username</th><th>Dept</th><th>Section</th><th class="num">Solved</th><th class="num">Score</th><th class="comp">Completion</th><th style="width:48px;text-align:center">Edit</th></tr></thead><tbody>` +
    (rows.length ? rows.map((r, idx) =>
      `<tr><td class="num">${start + idx + 1}</td><td class="grow"><a class="user-link" data-user="${esc(r.hrUsername)}">${esc(r.name || r.hrUsername || '(unnamed)')}</a></td><td class="grow">${r.hasHrId ? esc(r.hrUsername) + (r.inContest ? '' : ' <span class="muted">·absent</span>') : '<span class="badge warn">no HR id</span>'}</td><td>${esc(r.department || '—')}</td><td>${esc(r.section || '—')}</td><td class="num">${r.solved}/${r.totalQ}</td><td class="num">${r.score}</td><td class="comp"><div class="bar"><span style="width:${r.completion}%"></span></div></td><td style="text-align:center"><button class="ghost sm edit-student-btn" data-edit-student="${r.id}" title="Check & Update student details" style="padding:2px 7px;font-size:.85rem;cursor:pointer">✏️</button></td></tr>`).join('')
      : `<tr><td colspan="9" class="muted">No students.</td></tr>`) + `</tbody>`;
  const from = all.length ? start + 1 : 0;
  $('students-pager').innerHTML = all.length > STUDENTS_PAGE ? `<button class="ghost sm" id="st-prev" ${studentsPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + STUDENTS_PAGE, all.length)} of ${all.length} · page ${studentsPage}/${pages}</span><button class="ghost sm" id="st-next" ${studentsPage >= pages ? 'disabled' : ''}>Next ›</button>` : '';
  if (all.length > STUDENTS_PAGE) { $('st-prev').addEventListener('click', () => { if (studentsPage > 1) { studentsPage--; renderStudents(); } }); $('st-next').addEventListener('click', () => { if (studentsPage < pages) { studentsPage++; renderStudents(); } }); }
}

// Student Add Modal handlers
function populateAddStudentDatalists() {
  const uniq = (key) => Array.from(new Set(roster.map((s) => s[key]).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const setOpts = (id, arr) => {
    const dl = $(id);
    if (dl) dl.innerHTML = arr.map((v) => `<option value="${esc(v)}"></option>`).join('');
  };
  setOpts('add-st-campus-list', uniq('campus'));
  setOpts('add-st-dept-list', uniq('department'));
  setOpts('add-st-sec-list', uniq('section'));
  setOpts('add-st-year-list', uniq('year'));
}

function setAddStudentMode(mode) {
  const isSingle = mode === 'single';
  $('add-st-tab-single')?.classList.toggle('active', isSingle);
  $('add-st-tab-bulk')?.classList.toggle('active', !isSingle);
  $('add-st-single-pane')?.classList.toggle('hidden', !isSingle);
  $('add-st-bulk-pane')?.classList.toggle('hidden', isSingle);
  if ($('add-st-save')) $('add-st-save').textContent = isSingle ? '＋ Add Student' : '＋ Add Students';
}

function openAddStudentModal() {
  $('add-st-name').value = '';
  $('add-st-username').value = '';
  $('add-st-reg').value = '';
  $('add-st-email').value = '';
  $('add-st-campus').value = $('f-campus')?.value || '';
  $('add-st-dept').value = $('f-department')?.value || '';
  $('add-st-sec').value = $('f-section')?.value || '';
  $('add-st-year').value = $('f-year')?.value || '';
  $('add-st-bulk-text').value = '';
  $('add-st-bulk-count').textContent = '';

  const stat = $('add-st-status');
  if (stat) { stat.textContent = ''; stat.className = 'status'; }

  setAddStudentMode('single');
  populateAddStudentDatalists();
  $('add-student-modal')?.classList.remove('hidden');
}

$('add-student-btn')?.addEventListener('click', () => openAddStudentModal());
$('add-st-tab-single')?.addEventListener('click', () => setAddStudentMode('single'));
$('add-st-tab-bulk')?.addEventListener('click', () => setAddStudentMode('bulk'));
$('add-st-close')?.addEventListener('click', () => $('add-student-modal')?.classList.add('hidden'));
$('add-st-cancel')?.addEventListener('click', () => $('add-student-modal')?.classList.add('hidden'));
$('add-student-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'add-student-modal') $('add-student-modal').classList.add('hidden');
});

function parseBulkText(text) {
  const out = [];
  const cleanUser = (v) => { v = String(v || '').trim(); if (!v) return ''; if (v.includes('/')) { const p = v.split('/').filter(Boolean); return p[p.length - 1]; } return v.replace(/^@/, ''); };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const parts = line.split(/\t|,/).map((s) => s.trim());
    let name = '', user = '', rest = [];
    if (parts.length === 1) { user = cleanUser(parts[0]); name = user; }
    else { name = parts[0]; user = cleanUser(parts[1]); rest = parts.slice(2); }
    if (!user && !name) continue;
    out.push({
      name: name || user,
      hrUsername: user,
      registerNo: rest[0] || '',
      email: rest[1] || '',
      department: rest[2] || '',
      section: rest[3] || '',
      year: rest[4] || '',
      campus: rest[5] || ''
    });
  }
  return out;
}

$('add-st-bulk-text')?.addEventListener('input', () => {
  const n = parseBulkText($('add-st-bulk-text').value).length;
  $('add-st-bulk-count').textContent = n ? `${n} student${n > 1 ? 's' : ''} detected` : '';
});

$('add-st-save')?.addEventListener('click', async () => {
  const isSingle = $('add-st-tab-single')?.classList.contains('active');
  const stat = $('add-st-status');
  const url = isCollege
    ? `/api/college/${token}/students`
    : `/api/shared/${token}/students`;

  let payload = {};
  if (isSingle) {
    const name = $('add-st-name').value.trim();
    const hrUsername = $('add-st-username').value.trim();
    const registerNo = $('add-st-reg').value.trim();
    const email = $('add-st-email').value.trim();
    const campus = $('add-st-campus').value.trim();
    const department = $('add-st-dept').value.trim();
    const section = $('add-st-sec').value.trim();
    const year = $('add-st-year').value.trim();

    if (!name && !hrUsername) {
      if (stat) { stat.textContent = 'Please provide a student name or HackerRank username.'; stat.className = 'status err'; }
      return;
    }
    payload = {
      name, hrUsername, registerNo, email, campus, department, section, year,
      contestId: (isCollege && currentContestId) ? currentContestId : undefined
    };
  } else {
    const students = parseBulkText($('add-st-bulk-text').value);
    if (!students.length) {
      if (stat) { stat.textContent = 'No valid student lines found. Enter at least one name or username.'; stat.className = 'status err'; }
      return;
    }
    payload = {
      students,
      contestId: (isCollege && currentContestId) ? currentContestId : undefined
    };
  }

  if (stat) { stat.textContent = 'Adding student…'; stat.className = 'status info'; }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to add student.');

    const newStudents = d.students || (d.student ? [d.student] : []);
    newStudents.forEach((newSt) => {
      const idx = roster.findIndex((x) => String(x.id) === String(newSt.id) || (newSt.hrUsername && x.hrUsername && x.hrUsername.toLowerCase() === newSt.hrUsername.toLowerCase()));
      if (idx !== -1) {
        roster[idx] = { ...roster[idx], ...newSt };
      } else {
        roster.push(newSt);
      }
      if (dailyData && dailyData.students) {
        const dIdx = dailyData.students.findIndex((x) => String(x.id) === String(newSt.id) || (newSt.hrUsername && x.hrUsername && x.hrUsername.toLowerCase() === newSt.hrUsername.toLowerCase()));
        if (dIdx !== -1) {
          dailyData.students[dIdx] = { ...dailyData.students[dIdx], ...newSt };
        } else {
          dailyData.students.push({
            ...newSt,
            daily: (dailyData.days || []).map(() => 0),
            total: 0
          });
        }
      }
    });

    fillFilters();
    renderSummary();
    renderTopicAnalysis();
    renderCompletion();
    renderCategoryChart();
    renderStudents();
    renderDaily();

    if (stat) {
      const count = newStudents.length || 1;
      stat.textContent = `${count} student${count > 1 ? 's' : ''} added successfully!`;
      stat.className = 'status ok';
    }

    setTimeout(() => {
      $('add-student-modal')?.classList.add('hidden');
    }, 600);
  } catch (e) {
    if (stat) { stat.textContent = e.message || 'Failed to add student.'; stat.className = 'status err'; }
  }
});

// Student Edit Modal handlers (read-only / shared view)
function openEditStudent(id) {
  const s = roster.find((x) => String(x.id) === String(id) || (x.hrUsername && String(x.hrUsername) === String(id)));
  if (!s) return;
  $('edit-st-id').value = s.id;
  $('edit-st-name').value = s.name || '';
  $('edit-st-username').value = s.hrUsername || '';
  $('edit-st-reg').value = s.registerNo || '';
  $('edit-st-email').value = s.email || '';
  $('edit-st-campus').value = s.campus || '';
  $('edit-st-dept').value = s.department || '';
  $('edit-st-sec').value = s.section || '';
  $('edit-st-year').value = s.year || '';

  const stat = $('edit-st-status');
  if (stat) { stat.textContent = ''; stat.className = 'status'; }
  $('edit-student-modal')?.classList.remove('hidden');
}

$('edit-st-close')?.addEventListener('click', () => $('edit-student-modal')?.classList.add('hidden'));
$('edit-st-cancel')?.addEventListener('click', () => $('edit-student-modal')?.classList.add('hidden'));
$('edit-student-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'edit-student-modal') $('edit-student-modal').classList.add('hidden');
});

$('edit-st-save')?.addEventListener('click', async () => {
  const id = $('edit-st-id').value;
  const name = $('edit-st-name').value.trim();
  const hrUsername = $('edit-st-username').value.trim();
  const registerNo = $('edit-st-reg').value.trim();
  const email = $('edit-st-email').value.trim();
  const campus = $('edit-st-campus').value.trim();
  const department = $('edit-st-dept').value.trim();
  const section = $('edit-st-sec').value.trim();
  const year = $('edit-st-year').value.trim();

  const stat = $('edit-st-status');
  if (!name && !hrUsername) {
    if (stat) { stat.textContent = 'Please provide a student name or HackerRank username.'; stat.className = 'status err'; }
    return;
  }

  if (stat) { stat.textContent = 'Saving changes…'; stat.className = 'status info'; }

  const url = isCollege
    ? `/api/college/${token}/students/${id}`
    : `/api/shared/${token}/students/${id}`;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hrUsername, registerNo, email, campus, department, section, year })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Failed to save student.');

    const updated = d.student || { id: Number(id), name, hrUsername, registerNo, email, campus, department, section, year };

    const idx = roster.findIndex((x) => String(x.id) === String(id));
    if (idx !== -1) {
      roster[idx] = { ...roster[idx], ...updated };
    }

    if (stat) { stat.textContent = 'Saved successfully!'; stat.className = 'status ok'; }
    setTimeout(() => {
      $('edit-student-modal')?.classList.add('hidden');
      renderStudents();
    }, 400);
  } catch (e) {
    if (stat) { stat.textContent = e.message || 'Failed to save student.'; stat.className = 'status err'; }
  }
});

$('students-table').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-student]');
  if (editBtn) {
    e.preventDefault();
    openEditStudent(editBtn.dataset.editStudent);
    return;
  }
  const l = e.target.closest('.user-link[data-user]');
  if (l) {
    e.preventDefault();
    openPerf(l.dataset.user);
  }
});

// ---- Performance modal ----
$('perf-close').addEventListener('click', () => $('perf-modal').classList.add('hidden'));
$('perf-modal').addEventListener('click', (e) => { if (e.target.id === 'perf-modal') $('perf-modal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.add('hidden')); });
function openPerf(hrUsername) {
  if (!hrUsername) return;
  const username = String(hrUsername).trim();
  const r = (dailyData?.students || []).find((x) => x.hrUsername && x.hrUsername.toLowerCase() === username.toLowerCase()) ||
            joinedRows().find((x) => x.hrUsername && x.hrUsername.toLowerCase() === username.toLowerCase()) ||
            roster.find((x) => x.hrUsername && x.hrUsername.toLowerCase() === username.toLowerCase()) ||
            { name: username, hrUsername: username };
  const u = dashData?.users?.find((x) => x.username && x.username.toLowerCase() === username.toLowerCase());

  $('perf-title').textContent = r.name || username;
  $('perf-meta').innerHTML = [
    `@${esc(username)}`,
    r.registerNo && `Reg: ${esc(r.registerNo)}`,
    r.campus && esc(r.campus),
    r.department && esc(r.department),
    r.section && `Sec ${esc(r.section)}`,
    r.year && `Year ${esc(r.year)}`,
  ].filter(Boolean).join(' · ');

  if (!dashData || !u) {
    $('perf-stats').innerHTML = `<div class="stat"><div class="value">—</div><div class="label">No course data</div></div>`;
    $('perf-topics').innerHTML = `<p class="muted">${dashData ? 'This student did not appear in the course scrape.' : 'No course synced yet for this college.'}</p>`;
    $('perf-table').innerHTML = '';
    $('perf-modal').classList.remove('hidden');
    return;
  }

  const totalQ = dashData.summary.totalQuestions;
  const rank = dashData.users.slice().sort((a, b) => b.computedScore - a.computedScore).findIndex((x) => x.username === u.username) + 1;
  $('perf-stats').innerHTML = [
    ['Solved', `${u.solved}/${totalQ}`],
    ['Score', u.computedScore],
    ['Completion', Math.round((u.solved / totalQ) * 100) + '%'],
    ['Attempted', u.attempted],
    ['Course rank', rank > 0 ? `#${rank}` : '—'],
  ].map(([l, v]) => `<div class="stat"><div class="value">${v}</div><div class="label">${l}</div></div>`).join('');

  const tm = new Map();
  for (const q of dashData.questions) {
    const t = dashTopics[q.name] || splitTitle(q.name).tag || 'Other';
    if (!tm.has(t)) tm.set(t, { total: 0, solved: 0 });
    const e = tm.get(t);
    e.total++;
    if (u.questionStatus[q.name]?.solved) e.solved++;
  }
  $('perf-topics').innerHTML = `<div class="muted" style="margin-bottom:6px">By topic <span style="font-size:11px">(click a topic to filter the questions below)</span></div>` +
    Array.from(tm.entries()).map(([t, e]) => {
      const cls = e.solved === e.total ? 'solved' : e.solved > 0 ? 'attempted' : 'none';
      return `<span class="topic-tag" data-topic="${esc(t)}" style="cursor:pointer"><b>${esc(t)}</b> <span class="badge ${cls}">${e.solved}/${e.total}</span></span>`;
    }).join('');

  perfState = { u };
  perfTopicFilter = null;
  renderPerfTable();
  $('perf-modal').classList.remove('hidden');
}
let perfState = null, perfTopicFilter = null;
const perfTopicOf = (q) => dashTopics[q.name] || splitTitle(q.name).tag || 'Other';
function renderPerfTable() {
  if (!perfState) return;
  const u = perfState.u;
  const qrows = dashData.questions.filter((q) => !perfTopicFilter || perfTopicOf(q) === perfTopicFilter).map((q) => ({ q, st: u.questionStatus[q.name] || { score: 0, points: q.points, solved: false, attempted: false } }));
  $('perf-table').innerHTML = `<thead><tr><th>#</th><th>Question</th><th>Status</th><th class="num">Score</th></tr></thead><tbody>` +
    qrows.map(({ q, st }, i) => { const cls = st.solved ? 'solved' : st.attempted ? 'attempted' : 'none'; const txt = st.solved ? 'Solved' : st.attempted ? 'Attempted' : 'Not attempted'; const url = questionUrl(q); const name = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(q.name)}</a>` : esc(q.name); return `<tr><td class="num">${i + 1}</td><td>${name}</td><td><span class="badge ${cls}">${txt}</span></td><td class="num">${st.score || 0} / ${q.points}</td></tr>`; }).join('') + `</tbody>`;
  document.querySelectorAll('#perf-topics .topic-tag').forEach((el) => el.classList.toggle('active-filter', el.dataset.topic === perfTopicFilter));
}
$('perf-topics').addEventListener('click', (e) => {
  const tag = e.target.closest('.topic-tag[data-topic]'); if (!tag) return;
  perfTopicFilter = perfTopicFilter === tag.dataset.topic ? null : tag.dataset.topic;
  renderPerfTable();
});

// ---- Tabs (Dashboard / Daily) ----
document.querySelectorAll('#view-tabs .tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#view-tabs .tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const t = b.dataset.vtab;
  $('tab-dashboard').classList.toggle('hidden', t !== 'dashboard');
  $('tab-daily').classList.toggle('hidden', t !== 'daily');
  $('tab-attendance').classList.toggle('hidden', t !== 'attendance');
  if (t === 'attendance') loadSharedAttendance();
}));

// ---------------- Attendance (Google Sheet) ----------------
let attSheets = [], attSheetIdx = 0, attLoaded = false;
let attPage = 1;
const ATT_PAGE = 50;

function renderAttSheetTabs() {
  const el = $('att-sheet-tabs');
  if (attSheets.length <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = attSheets.map((s, i) =>
    `<button class="tab${i === attSheetIdx ? ' active' : ''}" data-idx="${i}" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px">${esc(s.name)} <span class="muted">(${s.rows.length})</span></button>`).join('');
}
function attText(v) { return v && typeof v === 'object' ? (v.text || v.url || '') : String(v ?? ''); }
function attCell(v) {
  if (v && typeof v === 'object' && v.url) return `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.text || v.url)}</a>`;
  const s = String(v ?? '').trim();
  if (/^https?:\/\/\S+$/i.test(s)) return `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a>`;
  return esc(attText(v));
}
function renderAttendance() {
  renderAttSheetTabs();
  const sheet = attSheets[attSheetIdx];
  const q = $('att-search').value.trim().toLowerCase();
  const cols = sheet ? sheet.columns : [];
  const allRows = sheet ? sheet.rows.filter((r) => !q || r.some((c) => attText(c).toLowerCase().includes(q))) : [];
  $('att-count').textContent = sheet ? `${allRows.length} row${allRows.length === 1 ? '' : 's'}${q ? ' (filtered)' : ''}` : '';
  if (!cols.length) {
    $('att-table').innerHTML = sheet ? '<tbody><tr><td class="muted">This tab is empty.</td></tr></tbody>' : '';
    if ($('att-pager')) $('att-pager').innerHTML = '';
    return;
  }
  const pages = Math.max(1, Math.ceil(allRows.length / ATT_PAGE));
  if (attPage > pages) attPage = pages;
  const start = (attPage - 1) * ATT_PAGE;
  const rows = allRows.slice(start, start + ATT_PAGE);

  $('att-table').innerHTML =
    `<thead><tr><th class="num">#</th>${cols.map((c) => `<th>${attCell(c)}</th>`).join('')}</tr></thead><tbody>` +
    (rows.length ? rows.map((r, i) => `<tr><td class="num">${start + i + 1}</td>${cols.map((_, j) => `<td>${attCell(r[j])}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length + 1}" class="muted">No rows.</td></tr>`) + `</tbody>`;

  const from = allRows.length ? start + 1 : 0;
  if ($('att-pager')) {
    $('att-pager').innerHTML = allRows.length > ATT_PAGE
      ? `<button class="ghost sm" id="att-prev" ${attPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + ATT_PAGE, allRows.length)} of ${allRows.length} · page ${attPage}/${pages}</span><button class="ghost sm" id="att-next" ${attPage >= pages ? 'disabled' : ''}>Next ›</button>`
      : '';
    if (allRows.length > ATT_PAGE) {
      $('att-prev')?.addEventListener('click', () => { if (attPage > 1) { attPage--; renderAttendance(); } });
      $('att-next')?.addEventListener('click', () => { if (attPage < pages) { attPage++; renderAttendance(); } });
    }
  }
}
$('att-sheet-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-idx]'); if (!b) return; attSheetIdx = Number(b.dataset.idx); attPage = 1; renderAttendance(); });
$('att-search').addEventListener('input', () => { attPage = 1; renderAttendance(); });
async function loadSharedAttendance() {
  if (attLoaded) return;
  attLoaded = true;
  $('att-note').textContent = '· loading…';
  try {
    const res = await fetch(attUrl);
    const d = await res.json();
    attSheets = d.sheets || []; attSheetIdx = 0; attPage = 1;
    renderAttendance();
    if (d.error) $('att-note').textContent = '· ' + d.error;
    else if (!attSheets.length) $('att-note').textContent = '· no attendance sheet linked for this college';
    else $('att-note').textContent = `· ${attSheets.length} tab(s)`;
  } catch (e) { attLoaded = false; $('att-note').textContent = '· ' + e.message; }
}

// ---- Daily questions completed ----
let dailyPage = 1;
const DAILY_PAGE = 30;

function fmtDay(iso) { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
function renderDaily() {
  const t = $('daily-table');
  if (!dailyData || !dailyData.days || !dailyData.days.length) {
    t.innerHTML = `<tbody><tr><td class="muted">No daily snapshots yet — this course needs to be synced on at least one day to build history.</td></tr></tbody>`;
    $('daily-note').textContent = '';
    if ($('daily-table-pager')) $('daily-table-pager').innerHTML = '';
    return;
  }
  const all = dailyData.students || [];
  const labels = { department: 'departments', section: 'sections', year: 'years', campus: 'campuses' };
  for (const [id, key] of [['daily-f-campus', 'campus'], ['daily-f-department', 'department'], ['daily-f-section', 'section'], ['daily-f-year', 'year']]) {
    const sel = $(id); const prev = sel.value;
    const vals = Array.from(new Set(all.map((s) => s[key]).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    sel.innerHTML = `<option value="">All ${labels[key]}</option>` + vals.map((v) => `<option>${esc(v)}</option>`).join('');
    if (vals.includes(prev)) sel.value = prev;
  }
  drawDailyTable();
}
function getFilteredDailyStudents() {
  if (!dailyData || !dailyData.students) return [];
  const f = {
    campus: $('daily-f-campus')?.value || '',
    department: $('daily-f-department')?.value || '',
    section: $('daily-f-section')?.value || '',
    year: $('daily-f-year')?.value || '',
    q: ($('daily-f-search')?.value || '').trim().toLowerCase(),
  };
  return dailyData.students.filter((s) =>
    (!f.campus || s.campus === f.campus) &&
    (!f.department || s.department === f.department) &&
    (!f.section || s.section === f.section) &&
    (!f.year || s.year === f.year) &&
    (!f.q || (s.name || '').toLowerCase().includes(f.q) || (s.hrUsername || '').toLowerCase().includes(f.q))
  );
}

function drawDailyTable() {
  if (!dailyData || !dailyData.days) return;
  const t = $('daily-table');
  const { days } = dailyData;
  const allStudents = getFilteredDailyStudents();
  $('daily-note').textContent = `· ${allStudents.length}${allStudents.length !== (dailyData.students || []).length ? ' of ' + (dailyData.students || []).length : ''} students · ${days.length} day(s)`;

  // Compute stats per day for the filtered students
  const dayStats = days.map((day, idx) => {
    const doneList = allStudents.filter((s) => (s.daily[idx] || 0) > 0);
    const totalQ = allStudents.reduce((sum, s) => sum + (s.daily[idx] || 0), 0);
    return { count: doneList.length, totalQ };
  });
  const totalWithSolves = allStudents.filter((s) => (s.total || 0) > 0).length;

  const total = allStudents.length;
  const pages = Math.max(1, Math.ceil(total / DAILY_PAGE));
  if (dailyPage > pages) dailyPage = pages;
  const start = (dailyPage - 1) * DAILY_PAGE;
  const students = allStudents.slice(start, start + DAILY_PAGE);

  t.innerHTML =
    `<thead>` +
    `<tr>` +
    `<th class="sticky-name">Student</th>` +
    days.map((day, idx) =>
      `<th class="num daily-col-hdr" data-day-idx="${idx}" title="Click to view all students who completed questions on ${esc(fmtDay(day))}" style="cursor:pointer">` +
      `<div>${esc(fmtDay(day))}</div>` +
      `<span class="chip" style="background:rgba(46,164,79,.18);color:var(--accent);font-size:.72rem;margin-top:2px;display:inline-block">${dayStats[idx].count} done</span>` +
      `</th>`
    ).join('') +
    `<th class="num daily-col-hdr" data-day-idx="all" title="Click to view all active students" style="cursor:pointer">` +
    `<div>Total</div>` +
    `<span class="chip" style="background:rgba(31,111,235,.18);color:var(--accent2);font-size:.72rem;margin-top:2px;display:inline-block">${totalWithSolves} active</span>` +
    `</th>` +
    `</tr>` +
    `<tr class="daily-summary-row" style="background:var(--surface2)">` +
    `<td class="sticky-name" style="background:var(--surface2)"><b>Students Completed</b></td>` +
    days.map((day, idx) =>
      `<td class="num" style="padding:6px 10px">` +
      (dayStats[idx].count > 0
        ? `<button class="ghost sm daily-summary-btn" data-day-idx="${idx}" title="View ${dayStats[idx].count} student(s) who completed questions on ${esc(fmtDay(day))}" style="padding:2px 8px;font-size:.78rem;font-weight:700;color:var(--accent);border-color:rgba(46,164,79,.4);cursor:pointer">${dayStats[idx].count} done</button>`
        : `<span class="muted">0</span>`) +
      `</td>`
    ).join('') +
    `<td class="num" style="padding:6px 10px">` +
    (totalWithSolves > 0
      ? `<button class="ghost sm daily-summary-btn" data-day-idx="all" title="View all ${totalWithSolves} active student(s)" style="padding:2px 8px;font-size:.78rem;font-weight:700;color:var(--accent2);border-color:rgba(31,111,235,.4);cursor:pointer">${totalWithSolves} active</button>`
      : `<span class="muted">0</span>`) +
    `</td>` +
    `</tr>` +
    `</thead>` +
    `<tbody>` +
    (students.length ? students.map((s) =>
      `<tr>` +
      `<td class="sticky-name"><a class="user-link" data-user="${esc(s.hrUsername)}" title="Click to view student questions">${esc(s.name || s.hrUsername)}</a></td>` +
      s.daily.map((n) =>
        `<td class="num">` +
        (n
          ? `<a class="user-link" data-user="${esc(s.hrUsername)}" style="font-weight:700;color:var(--accent);cursor:pointer" title="Click to view questions solved by ${esc(s.name || s.hrUsername)}">${n}</a>`
          : `<span class="muted">·</span>`) +
        `</td>`
      ).join('') +
      `<td class="num"><a class="user-link" data-user="${esc(s.hrUsername)}" title="Click to view student questions">${s.total}</a></td>` +
      `</tr>`
    ).join('')
      : `<tr><td colspan="${days.length + 2}" class="muted">No students match these filters.</td></tr>`) +
    `</tbody>`;

  const from = total ? start + 1 : 0;
  if ($('daily-table-pager')) {
    $('daily-table-pager').innerHTML = total > DAILY_PAGE
      ? `<button class="ghost sm" id="dt-prev" ${dailyPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + DAILY_PAGE, total)} of ${total} · page ${dailyPage}/${pages}</span><button class="ghost sm" id="dt-next" ${dailyPage >= pages ? 'disabled' : ''}>Next ›</button>`
      : '';
    if (total > DAILY_PAGE) {
      $('dt-prev')?.addEventListener('click', () => { if (dailyPage > 1) { dailyPage--; drawDailyTable(); } });
      $('dt-next')?.addEventListener('click', () => { if (dailyPage < pages) { dailyPage++; drawDailyTable(); } });
    }
  }
}
['daily-f-campus', 'daily-f-department', 'daily-f-section', 'daily-f-year'].forEach((id) => $(id).addEventListener('change', () => { dailyPage = 1; drawDailyTable(); }));
$('daily-f-search').addEventListener('input', () => { dailyPage = 1; drawDailyTable(); });

// ---------- Daily popup modal logic ----------
let dailyModalRows = [], dailyModalPage = 1, dailyModalSelectedDayIdx = null;
const DAILY_MODAL_PAGE = 20;

function openDailyModal(dayIdx) {
  if (!dailyData || !dailyData.days) return;
  dailyModalSelectedDayIdx = dayIdx;
  const isAll = dayIdx === 'all';
  const dayStr = isAll ? null : dailyData.days[Number(dayIdx)];
  const students = getFilteredDailyStudents();

  if (isAll) {
    dailyModalRows = students
      .filter((s) => (s.total || 0) > 0)
      .map((s) => ({
        ...s,
        doneCount: (s.daily || []).reduce((a, b) => a + (b || 0), 0),
      }))
      .sort((a, b) => b.total - a.total || b.doneCount - a.doneCount);

    const totalWindowQ = dailyModalRows.reduce((sum, s) => sum + s.doneCount, 0);
    $('daily-modal-title').textContent = `⚡ ${dailyModalRows.length} active student(s)`;
    $('daily-modal-subtitle').textContent = `Active students with solves · Solved in ${dailyData.days.length}-day window: ${totalWindowQ}`;
  } else {
    const idx = Number(dayIdx);
    dailyModalRows = students
      .filter((s) => (s.daily[idx] || 0) > 0)
      .map((s) => ({
        ...s,
        doneCount: s.daily[idx] || 0,
      }))
      .sort((a, b) => b.doneCount - a.doneCount || b.total - a.total);

    const formattedDay = fmtDay(dayStr);
    const totalQ = dailyModalRows.reduce((sum, s) => sum + s.doneCount, 0);
    $('daily-modal-title').textContent = `⚡ ${dailyModalRows.length} student(s) completed questions on ${formattedDay}`;
    $('daily-modal-subtitle').textContent = `Date: ${dayStr} · Total questions solved on this day: ${totalQ}`;
  }

  $('daily-modal-search').value = '';
  dailyModalPage = 1;
  renderDailyModalPage();
  $('daily-modal').classList.remove('hidden');
}

function renderDailyModalPage() {
  const q = ($('daily-modal-search')?.value || '').trim().toLowerCase();
  const filtered = dailyModalRows.filter(
    (s) =>
      !q ||
      (s.name || '').toLowerCase().includes(q) ||
      (s.hrUsername || '').toLowerCase().includes(q) ||
      (s.department || '').toLowerCase().includes(q) ||
      (s.section || '').toLowerCase().includes(q) ||
      (s.campus || '').toLowerCase().includes(q)
  );

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / DAILY_MODAL_PAGE));
  if (dailyModalPage > pages) dailyModalPage = pages;
  const start = (dailyModalPage - 1) * DAILY_MODAL_PAGE;
  const slice = filtered.slice(start, start + DAILY_MODAL_PAGE);

  const isAll = dailyModalSelectedDayIdx === 'all';
  const countColTitle = isAll ? 'Window Solved' : 'Completed on Date';

  $('daily-modal-table').innerHTML =
    `<thead><tr>` +
    `<th style="width:40px">#</th>` +
    `<th>Student</th>` +
    `<th>HR username</th>` +
    `<th>Campus</th>` +
    `<th>Dept</th>` +
    `<th>Section</th>` +
    `<th>Year</th>` +
    `<th class="num">${countColTitle}</th>` +
    `<th class="num">Total Solved</th>` +
    `<th style="width:110px;text-align:center">Questions</th>` +
    `</tr></thead><tbody>` +
    (slice.length
      ? slice
          .map(
            (s, idx) =>
              `<tr>` +
              `<td class="num">${start + idx + 1}</td>` +
              `<td><a class="user-link view-perf-link" data-user="${esc(s.hrUsername)}" title="Click to view question completion breakdown">${esc(s.name || s.hrUsername)}</a></td>` +
              `<td><a class="user-link view-perf-link" data-user="${esc(s.hrUsername)}">${esc(s.hrUsername || '—')}</a></td>` +
              `<td>${esc(s.campus || '—')}</td>` +
              `<td>${esc(s.department || '—')}</td>` +
              `<td>${esc(s.section || '—')}</td>` +
              `<td>${esc(s.year || '—')}</td>` +
              `<td class="num"><b><span class="chip" style="background:rgba(46,164,79,.15);color:var(--accent);font-size:.82rem">+${s.doneCount}</span></b></td>` +
              `<td class="num"><b>${s.total}</b></td>` +
              `<td style="text-align:center"><button class="ghost sm view-perf-btn" data-user="${esc(s.hrUsername)}" style="padding:3px 8px;font-size:.76rem">View 📊</button></td>` +
              `</tr>`
          )
          .join('')
      : `<tr><td colspan="10" class="muted">No students found.</td></tr>`) +
    `</tbody>`;

  const from = total ? start + 1 : 0;
  $('daily-modal-count').textContent = q ? `${total} of ${dailyModalRows.length} matching` : `${total} student${total === 1 ? '' : 's'}`;
  $('daily-pager').innerHTML =
    total > DAILY_MODAL_PAGE
      ? `<button class="ghost sm" id="daily-prev" ${dailyModalPage <= 1 ? 'disabled' : ''}>‹ Prev</button>` +
        `<span class="muted">${from}–${Math.min(start + DAILY_MODAL_PAGE, total)} of ${total} · page ${dailyModalPage}/${pages}</span>` +
        `<button class="ghost sm" id="daily-next" ${dailyModalPage >= pages ? 'disabled' : ''}>Next ›</button>`
      : '';

  if (total > DAILY_MODAL_PAGE) {
    $('daily-prev')?.addEventListener('click', () => {
      if (dailyModalPage > 1) {
        dailyModalPage--;
        renderDailyModalPage();
      }
    });
    $('daily-next')?.addEventListener('click', () => {
      if (dailyModalPage < pages) {
        dailyModalPage++;
        renderDailyModalPage();
      }
    });
  }
}

$('daily-table')?.addEventListener('click', (e) => {
  const trigger = e.target.closest('.daily-col-hdr, .daily-summary-btn');
  if (trigger && trigger.dataset.dayIdx != null) {
    e.preventDefault();
    openDailyModal(trigger.dataset.dayIdx);
    return;
  }
  const u = e.target.closest('.user-link[data-user]');
  if (u && u.dataset.user) {
    e.preventDefault();
    openPerf(u.dataset.user);
  }
});

$('daily-modal-close')?.addEventListener('click', () => $('daily-modal').classList.add('hidden'));
$('daily-modal')?.addEventListener('click', (e) => { if (e.target.id === 'daily-modal') $('daily-modal').classList.add('hidden'); });
$('daily-modal-search')?.addEventListener('input', () => { dailyModalPage = 1; renderDailyModalPage(); });
$('daily-modal-table')?.addEventListener('click', (e) => {
  const target = e.target.closest('.view-perf-btn, .view-perf-link, .user-link[data-user]');
  if (target && target.dataset.user) {
    e.preventDefault();
    openPerf(target.dataset.user);
  }
});

boot();
