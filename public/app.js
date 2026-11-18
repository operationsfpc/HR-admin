// HackerRank Admin Dashboard — admin frontend.
const $ = (id) => document.getElementById(id);
let adminToken = localStorage.getItem('hradmin_token') || '';
let hrToken = '';
let colleges = [];
let roster = [];        // current college roster
let dashData = null;    // latest scrape dashboard for current contest
let selectedCollegeId = '';
let selectedContestId = '';
let dashContests = [];  // contests of the selected dashboard college
let solvedFilter = null; // completion-breakdown filter (number of solved) or null
let studentsPage = 1;
const STUDENTS_PAGE = 50;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = (el, m, k = 'info') => { el.textContent = m; el.className = `status ${k}`; };

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && adminToken) headers['x-admin-token'] = adminToken;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) { logout(); throw new Error(data.error || 'Session expired.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Admin auth ----------
$('admin-login-btn').addEventListener('click', adminLogin);
$('admin-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });
async function adminLogin() {
  try {
    const d = await api('/api/admin/login', { method: 'POST', auth: false, body: { username: $('admin-user').value.trim(), password: $('admin-pass').value } });
    adminToken = d.token; localStorage.setItem('hradmin_token', adminToken);
    enterApp();
    if (d.defaultCreds) setStatus($('dash-status'), 'Using default admin/admin — set ADMIN_USER & ADMIN_PASS env vars to secure this.', 'info');
  } catch (e) { setStatus($('admin-login-status'), e.message, 'err'); }
}
function logout() { adminToken = ''; localStorage.removeItem('hradmin_token'); $('app').classList.add('hidden'); $('login-screen').classList.remove('hidden'); }
$('logout-btn').addEventListener('click', logout);

async function enterApp() {
  try {
    $('login-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    await loadColleges();
    await Promise.allSettled([loadAutoSyncStatus(), loadSharedTabs(), loadHrStatus()]);
  } catch (e) {
    logout();
  }
}
async function loadHrStatus() {
  try {
    const s = await api('/api/hr/status');
    const pill = $('hr-pill');
    if (s.mock) {
      pill.textContent = 'HR: mock';
      pill.className = 'pill';
    } else if (s.connected || s.hasEnvCreds) {
      pill.textContent = s.email ? `HR: connected (${s.email})` : 'HR: connected (.env)';
      pill.className = 'pill';
    } else {
      pill.textContent = 'HR: not connected';
      pill.className = 'pill off';
    }
  } catch {
    /* ignore */
  }
}
async function loadAutoSyncStatus() {
  try {
    const s = await api('/api/auto-sync/status');
    const el = $('auto-sync-note');
    if (!s.enabled) { el.textContent = '⚪ Auto-sync off — enable with AUTO_SYNC=1 (needs HR_EMAIL/HR_PASS).'; el.style.color = ''; return; }
    const when = s.lastRun ? new Date(s.lastRun).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
    const parts = [`🟢 Auto-sync ON · ${s.times.join(', ')} ${s.tz || ''}`.trim()];
    if (s.running) parts.push('⏳ running now…');
    parts.push(`last run: ${when}`);
    if (s.lastResult) parts.push(s.lastResult);
    if (!s.hasCreds) parts.push('⚠ HR_EMAIL/HR_PASS not set — runs will fail');
    el.textContent = parts.join(' · ');
    el.style.color = (!s.hasCreds || (s.lastResult && /fail/i.test(s.lastResult))) ? 'var(--danger)' : '';
  } catch { /* ignore */ }
}
// Refresh status periodically
setInterval(() => { if (adminToken && !document.getElementById('login-screen')?.offsetParent) { loadAutoSyncStatus(); loadHrStatus(); } }, 60 * 1000);

// ---------- Tabs ----------
document.querySelectorAll('#tabs .tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + b.dataset.tab));
  if (b.dataset.tab === 'attendance') loadAttendance();
}));

// ---------- Attendance (Google Sheet, per college, all tabs) ----------
let attSheets = [];      // [{ name, columns, rows }]
let attSheetIdx = 0;
let attCollegeId = '';
let attPage = 1;
const ATT_PAGE = 50;

function renderAttSheetTabs() {
  const el = $('att-sheet-tabs');
  if (attSheets.length <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = attSheets.map((s, i) =>
    `<button class="tab${i === attSheetIdx ? ' active' : ''}" data-idx="${i}" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px">${esc(s.name)} <span class="muted">(${s.rows.length})</span></button>`).join('');
}
// Plain text of a cell (string, or a { text, url } hyperlink object).
function attText(v) { return v && typeof v === 'object' ? (v.text || v.url || '') : String(v ?? ''); }
// Render a cell: hyperlink object → link; a bare URL string → link; else text.
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
$('att-sheet-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-idx]'); if (!b) return;
  attSheetIdx = Number(b.dataset.idx); attPage = 1; renderAttendance();
});
function applyAttResult(d) {
  attSheets = d.sheets || []; attSheetIdx = 0; attPage = 1;
  renderAttendance();
  const totalRows = attSheets.reduce((a, s) => a + s.rows.length, 0);
  return { totalRows, tabs: attSheets.length };
}
async function loadAttendance() {
  fillCollegeSelect($('att-college'));
  if (!attCollegeId && colleges[0]) attCollegeId = String(colleges[0].id);
  $('att-college').value = attCollegeId;
  attSheets = []; attSheetIdx = 0; attPage = 1; renderAttendance();
  if (!attCollegeId) { setStatus($('att-status'), 'Add a college first (Colleges tab).', 'info'); $('att-url').value = ''; return; }
  setStatus($('att-status'), 'Loading…', 'info');
  try {
    const d = await api('/api/attendance?collegeId=' + attCollegeId);
    $('att-url').value = d.url || '';
    const { totalRows, tabs } = applyAttResult(d);
    if (d.error) setStatus($('att-status'), d.error, 'err');
    else if (!d.url) setStatus($('att-status'), 'No sheet linked for this college yet — paste a Google Sheets link above and Load.', 'info');
    else setStatus($('att-status'), `Loaded ${tabs} tab(s), ${totalRows} row(s) total.`, 'ok');
  } catch (e) { setStatus($('att-status'), e.message, 'err'); }
}
$('att-college').addEventListener('change', (e) => { attCollegeId = e.target.value; attPage = 1; loadAttendance(); });
$('att-load').addEventListener('click', async () => {
  const url = $('att-url').value.trim();
  if (!attCollegeId) return setStatus($('att-status'), 'Pick a college first.', 'err');
  if (!url) return setStatus($('att-status'), 'Paste a Google Sheets link first.', 'err');
  setStatus($('att-status'), 'Fetching sheet…', 'info');
  try {
    const d = await api('/api/attendance', { method: 'POST', body: { collegeId: attCollegeId, url } });
    const { totalRows, tabs } = applyAttResult(d);
    setStatus($('att-status'), `Loaded and saved for this college — ${tabs} tab(s), ${totalRows} row(s).`, 'ok');
  } catch (e) { setStatus($('att-status'), e.message, 'err'); }
});
$('att-refresh').addEventListener('click', () => loadAttendance());
$('att-remove').addEventListener('click', async () => {
  if (!attCollegeId) return setStatus($('att-status'), 'Pick a college first.', 'err');
  if (!confirm('Remove the attendance sheet link for this college?')) return;
  try {
    await api('/api/attendance?collegeId=' + attCollegeId, { method: 'DELETE' });
    $('att-url').value = ''; attSheets = []; attSheetIdx = 0; attPage = 1; renderAttendance();
    setStatus($('att-status'), 'Attendance link removed for this college.', 'ok');
  } catch (e) { setStatus($('att-status'), e.message, 'err'); }
});
$('att-search').addEventListener('input', () => { attPage = 1; renderAttendance(); });

// ---------- Colleges ----------
let collegesPage = 1;
const COLLEGES_PAGE = 10;
let ccPage = 1;
const CC_PAGE = 10;
let ccContests = [];

async function loadColleges() {
  colleges = (await api('/api/colleges')).colleges || [];
  renderCollegesTable();
  fillCollegeSelect($('dash-college')); fillCollegeSelect($('up-college')); fillCollegeSelect($('t-college')); fillCollegeSelect($('cc-college'));
  loadUploadContests(); loadCollegeContests();
  if (!selectedCollegeId && colleges[0]) selectedCollegeId = String(colleges[0].id);
  if (selectedCollegeId) { $('dash-college').value = selectedCollegeId; await loadDashContests(); }
}
function fillCollegeSelect(sel) {
  const prev = sel.value;
  sel.innerHTML = colleges.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') || `<option value="">No colleges yet</option>`;
  if (colleges.some((c) => String(c.id) === prev)) sel.value = prev;
}

function getFilteredColleges() {
  const q = ($('c-search')?.value || '').trim().toLowerCase();
  if (!q) return colleges;
  return colleges.filter((c) => (c.name || '').toLowerCase().includes(q));
}

function renderCollegesTable() {
  const filtered = getFilteredColleges();
  $('c-count').textContent = `· ${colleges.length}${filtered.length !== colleges.length ? ` (${filtered.length} matching)` : ''}`;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / COLLEGES_PAGE));
  if (collegesPage > pages) collegesPage = pages;
  const start = (collegesPage - 1) * COLLEGES_PAGE;
  const rows = filtered.slice(start, start + COLLEGES_PAGE);

  $('colleges-table').innerHTML =
    `<thead><tr>` +
    `<th>#</th>` +
    `<th>College</th>` +
    `<th class="num">Students</th>` +
    `<th class="num">Courses</th>` +
    `<th>Student Code</th>` +
    `<th>Set Code</th>` +
    `<th>🔗 Share College</th>` +
    `<th style="text-align:center">Actions</th>` +
    `</tr></thead><tbody>` +
    (rows.length ? rows.map((c, i) => {
      const shareUrl = c.shareToken ? `${location.origin}/college/${c.shareToken}` : '';
      const shareHtml = shareUrl
        ? `<div style="display:flex;align-items:center;gap:4px">` +
          `<span style="font-family:monospace;font-size:.74rem;background:var(--surface2);padding:2px 6px;border-radius:4px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(shareUrl)}">/college/${esc(c.shareToken)}</span>` +
          `<button class="ghost sm" data-copy-college-share="${c.id}" data-url="${esc(shareUrl)}" title="Copy Share Link" style="padding:2px 6px">📋</button>` +
          `<a href="${esc(shareUrl)}" target="_blank" class="ghost sm" style="text-decoration:none;padding:2px 6px;display:inline-block" title="Open Share Link">↗</a>` +
          `</div>`
        : `<button class="ghost sm" data-gen-college-share="${c.id}" style="font-size:.76rem;padding:2px 6px">🔗 Create Link</button>`;

      return `<tr>` +
        `<td class="num">${start + i + 1}</td>` +
        `<td><b>${esc(c.name)}</b></td>` +
        `<td class="num">${c.students}</td>` +
        `<td class="num">${c.contestsCount || 0}</td>` +
        `<td>${c.hasCode ? '<span class="chip code">set</span>' : '<span class="chip nocode">none</span>'}</td>` +
        `<td><div style="display:flex;gap:4px"><input class="code-input" data-id="${c.id}" placeholder="new code" style="min-width:90px;padding:3px 6px;font-size:.8rem"/> <button class="ghost sm" data-savecode="${c.id}">Save</button></div></td>` +
        `<td>${shareHtml}</td>` +
        `<td style="text-align:center;white-space:nowrap">` +
        `<button class="ghost sm" data-export-college="${c.id}" data-college-name="${esc(c.name)}" title="Export College Excel Data" style="padding:2px 6px;margin-right:4px">📥</button>` +
        `<button class="ghost sm danger" data-delc="${c.id}" title="Delete College" style="padding:2px 6px">🗑</button>` +
        `</td>` +
        `</tr>`;
    }).join('')
      : `<tr><td colspan="8" class="muted">No colleges found.</td></tr>`) + `</tbody>`;

  const from = total ? start + 1 : 0;
  if ($('c-pager')) {
    $('c-pager').innerHTML = total > COLLEGES_PAGE
      ? `<button class="ghost sm" id="c-prev" ${collegesPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + COLLEGES_PAGE, total)} of ${total} · page ${collegesPage}/${pages}</span><button class="ghost sm" id="c-next" ${collegesPage >= pages ? 'disabled' : ''}>Next ›</button>`
      : '';
    if (total > COLLEGES_PAGE) {
      $('c-prev')?.addEventListener('click', () => { if (collegesPage > 1) { collegesPage--; renderCollegesTable(); } });
      $('c-next')?.addEventListener('click', () => { if (collegesPage < pages) { collegesPage++; renderCollegesTable(); } });
    }
  }
}
$('c-search')?.addEventListener('input', () => { collegesPage = 1; renderCollegesTable(); });

$('c-add').addEventListener('click', async () => {
  const name = $('c-name').value.trim();
  if (!name) return setStatus($('c-status'), 'Enter a college name.', 'err');
  try {
    await api('/api/colleges', { method: 'POST', body: { name, accessCode: $('c-code').value.trim() } });
    $('c-name').value = ''; $('c-code').value = '';
    setStatus($('c-status'), `Added "${name}".`, 'ok'); await loadColleges();
  } catch (e) { setStatus($('c-status'), e.message, 'err'); }
});

$('colleges-table').addEventListener('click', async (e) => {
  const sc = e.target.closest('[data-savecode]');
  const dc = e.target.closest('[data-delc]');
  const copyBtn = e.target.closest('[data-copy-college-share]');
  const genBtn = e.target.closest('[data-gen-college-share]');
  const expBtn = e.target.closest('[data-export-college]');

  if (sc) {
    const id = sc.dataset.savecode;
    const code = $('colleges-table').querySelector(`.code-input[data-id="${id}"]`).value.trim();
    if (!code) return setStatus($('c-status'), 'Enter a new code.', 'err');
    await api('/api/colleges/' + id, { method: 'PUT', body: { accessCode: code } });
    setStatus($('c-status'), 'Access code saved.', 'ok'); await loadColleges();
  }
  if (dc) {
    if (!confirm('Delete this college and all its courses and student mappings?')) return;
    await api('/api/colleges/' + dc.dataset.delc, { method: 'DELETE' });
    await loadColleges();
  }
  if (copyBtn) {
    const url = copyBtn.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
      setStatus($('c-status'), `Copied college link: ${url}`, 'ok');
    } catch {
      window.prompt('Copy college link:', url);
    }
  }
  if (genBtn) {
    const id = genBtn.dataset.genCollegeShare;
    setStatus($('c-status'), 'Generating share link…', 'info');
    try {
      const r = await api('/api/colleges/' + id + '/share', { method: 'POST' });
      const url = `${location.origin}/college/${r.token}`;
      await loadColleges();
      try { await navigator.clipboard.writeText(url); setStatus($('c-status'), `Created & copied college link: ${url}`, 'ok'); }
      catch { setStatus($('c-status'), `Created college link: ${url}`, 'ok'); }
    } catch (err) {
      setStatus($('c-status'), err.message, 'err');
    }
  }
  if (expBtn) {
    exportSingleCollege(expBtn.dataset.exportCollege, expBtn.dataset.collegeName);
  }
});

// ---------- Contest links (Colleges tab) ----------
$('cc-college').addEventListener('change', () => { ccPage = 1; loadCollegeContests(); });
$('cc-search')?.addEventListener('input', () => { ccPage = 1; renderCcTable(); });

async function loadCollegeContests() {
  const id = $('cc-college').value;
  if (!id) { ccContests = []; renderCcTable(); return; }
  ccContests = (await api('/api/contests?collegeId=' + id)).contests || [];
  renderCcTable();
}

function getFilteredCcContests() {
  const q = ($('cc-search')?.value || '').trim().toLowerCase();
  if (!q) return ccContests;
  return ccContests.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.slug || '').toLowerCase().includes(q));
}

function renderCcTable() {
  const t = $('cc-table');
  const filtered = getFilteredCcContests();
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / CC_PAGE));
  if (ccPage > pages) ccPage = pages;
  const start = (ccPage - 1) * CC_PAGE;
  const rows = filtered.slice(start, start + CC_PAGE);

  t.innerHTML =
    `<thead><tr>` +
    `<th>#</th>` +
    `<th>Course</th>` +
    `<th>Slug</th>` +
    `<th>HackerRank Link</th>` +
    `<th>🔗 Share Course</th>` +
    `<th style="text-align:center">Actions</th>` +
    `</tr></thead><tbody>` +
    (rows.length ? rows.map((c, i) => {
      const shareUrl = c.shareToken ? `${location.origin}/view/${c.shareToken}` : '';
      const shareHtml = shareUrl
        ? `<div style="display:flex;align-items:center;gap:4px">` +
          `<span style="font-family:monospace;font-size:.74rem;background:var(--surface2);padding:2px 6px;border-radius:4px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(shareUrl)}">/view/${esc(c.shareToken)}</span>` +
          `<button class="ghost sm" data-copy-course-share="${c.id}" data-url="${esc(shareUrl)}" title="Copy Course Link" style="padding:2px 6px">📋</button>` +
          `<a href="${esc(shareUrl)}" target="_blank" class="ghost sm" style="text-decoration:none;padding:2px 6px;display:inline-block" title="Open Course Share Link">↗</a>` +
          `</div>`
        : `<button class="ghost sm" data-gen-course-share="${c.id}" style="font-size:.76rem;padding:2px 6px">🔗 Create Link</button>`;

      return `<tr>` +
        `<td class="num">${start + i + 1}</td>` +
        `<td><b>${esc(c.name)}</b></td>` +
        `<td>${c.slug ? `<span class="chip" style="font-size:.74rem">${esc(c.slug)}</span>` : '<span class="muted">—</span>'}</td>` +
        `<td class="muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.contestUrl || '')}">${esc(c.contestUrl || '—')}</td>` +
        `<td>${shareHtml}</td>` +
        `<td style="text-align:center;white-space:nowrap">` +
        `<button class="ghost sm" data-export-course="${c.id}" data-course-name="${esc(c.name)}" title="Export Course Results to Excel" style="padding:2px 6px;margin-right:4px">📥</button>` +
        `<button class="ghost sm danger" data-delcc="${c.id}" title="Delete Course" style="padding:2px 6px">🗑</button>` +
        `</td>` +
        `</tr>`;
    }).join('')
      : `<tr><td colspan="6" class="muted">${ccContests.length ? 'No matching courses.' : 'No courses yet.'}</td></tr>`) + `</tbody>`;

  const from = total ? start + 1 : 0;
  if ($('cc-pager')) {
    $('cc-pager').innerHTML = total > CC_PAGE
      ? `<button class="ghost sm" id="cc-prev" ${ccPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + CC_PAGE, total)} of ${total} · page ${ccPage}/${pages}</span><button class="ghost sm" id="cc-next" ${ccPage >= pages ? 'disabled' : ''}>Next ›</button>`
      : '';
    if (total > CC_PAGE) {
      $('cc-prev')?.addEventListener('click', () => { if (ccPage > 1) { ccPage--; renderCcTable(); } });
      $('cc-next')?.addEventListener('click', () => { if (ccPage < pages) { ccPage++; renderCcTable(); } });
    }
  }
}

async function refreshContestSelectors(collegeId) {
  await loadCollegeContests();
  if (String(collegeId) === String(selectedCollegeId)) await loadDashContests();
  if (String(collegeId) === String($('up-college').value)) await loadUploadContests();
}
$('cc-add').addEventListener('click', async () => {
  const id = $('cc-college').value;
  if (!id) return setStatus($('cc-status'), 'Pick a college.', 'err');
  const name = $('cc-name').value.trim(); const link = $('cc-link').value.trim();
  if (!name) return setStatus($('cc-status'), 'Enter a course name.', 'err');
  try {
    await api('/api/contests', { method: 'POST', body: { collegeId: id, name, contestUrl: link } });
    $('cc-name').value = ''; $('cc-link').value = '';
    setStatus($('cc-status'), `Added "${name}".`, 'ok');
    await refreshContestSelectors(id);
  } catch (e) { setStatus($('cc-status'), e.message, 'err'); }
});
$('cc-bulk-add').addEventListener('click', async () => {
  const id = $('cc-college').value;
  if (!id) return setStatus($('cc-status'), 'Pick a college.', 'err');
  const links = $('cc-bulk').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!links.length) return setStatus($('cc-status'), 'Paste at least one link.', 'err');
  const existing = (await api('/api/contests?collegeId=' + id)).contests || [];
  let n = existing.length;
  try {
    for (const link of links) { n++; await api('/api/contests', { method: 'POST', body: { collegeId: id, name: 'Course ' + n, contestUrl: link } }); }
    $('cc-bulk').value = '';
    setStatus($('cc-status'), `Added ${links.length} course(s).`, 'ok');
    await refreshContestSelectors(id);
  } catch (e) { setStatus($('cc-status'), e.message, 'err'); }
});
$('cc-table').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delcc]');
  const copyBtn = e.target.closest('[data-copy-course-share]');
  const genBtn = e.target.closest('[data-gen-course-share]');
  const expBtn = e.target.closest('[data-export-course]');

  if (del) {
    if (!confirm('Delete this course?')) return;
    await api('/api/contests/' + del.dataset.delcc, { method: 'DELETE' });
    await refreshContestSelectors($('cc-college').value);
  }
  if (copyBtn) {
    const url = copyBtn.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
      setStatus($('cc-status'), `Copied course link: ${url}`, 'ok');
    } catch {
      window.prompt('Copy course link:', url);
    }
  }
  if (genBtn) {
    const id = genBtn.dataset.genCourseShare;
    setStatus($('cc-status'), 'Generating share link…', 'info');
    try {
      const r = await api('/api/contests/' + id + '/share', { method: 'POST' });
      const url = `${location.origin}/view/${r.token}`;
      await loadCollegeContests();
      try { await navigator.clipboard.writeText(url); setStatus($('cc-status'), `Created & copied course link: ${url}`, 'ok'); }
      catch { setStatus($('cc-status'), `Created course link: ${url}`, 'ok'); }
    } catch (err) {
      setStatus($('cc-status'), err.message, 'err');
    }
  }
  if (expBtn) {
    exportSingleCourse(expBtn.dataset.exportCourse, expBtn.dataset.courseName);
  }
});

// ---------- Bulk Exports & Helpers ----------
$('bulk-export-all-colleges-btn')?.addEventListener('click', bulkExportAllColleges);
$('bulk-copy-links-btn')?.addEventListener('click', bulkCopyAllShareLinks);

async function bulkExportAllColleges() {
  const statusEl = $('bulk-action-status');
  setStatus(statusEl, 'Preparing bulk export workbook for all colleges…', 'info');
  try {
    const wb = XLSX.utils.book_new();
    const allCols = (await api('/api/colleges')).colleges || [];
    if (!allCols.length) return setStatus(statusEl, 'No colleges found to export.', 'err');

    const summaryRows = [
      ['College Name', 'Total Students', 'Total Courses', 'Has Student Code', 'College Share URL']
    ];
    for (const col of allCols) {
      const shareUrl = col.shareToken ? `${location.origin}/college/${col.shareToken}` : 'Not generated';
      summaryRows.push([col.name, col.students, col.contestsCount || 0, col.hasCode ? 'Yes' : 'No', shareUrl]);
    }
    const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Colleges Summary');

    for (const col of allCols) {
      setStatus(statusEl, `Fetching roster for "${col.name}"…`, 'info');
      const stRes = await api('/api/students?college=' + encodeURIComponent(col.name));
      const students = stRes.students || [];
      const rosterRows = [
        ['Name', 'HackerRank Username', 'Register Number', 'Email', 'Department', 'Section', 'Year', 'Campus']
      ];
      for (const s of students) {
        rosterRows.push([
          s.name || '', s.hrUsername || '', s.registerNo || '', s.email || '',
          s.department || '', s.section || '', s.year || '', s.campus || ''
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(rosterRows);
      let sheetName = String(col.name).replace(/[:\\\/\?\*\[\]]/g, '').slice(0, 28).trim() || `College_${col.id}`;
      if (wb.SheetNames.includes(sheetName)) sheetName = `${sheetName.slice(0, 25)}_${col.id}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const timestamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `All_Colleges_Bulk_Export_${timestamp}.xlsx`);
    setStatus(statusEl, `Exported ${allCols.length} colleges successfully!`, 'ok');
  } catch (e) {
    setStatus(statusEl, `Bulk export failed: ${e.message}`, 'err');
  }
}

async function bulkCopyAllShareLinks() {
  const statusEl = $('bulk-action-status');
  setStatus(statusEl, 'Generating and compiling all share links…', 'info');
  try {
    const allCols = (await api('/api/colleges')).colleges || [];
    if (!allCols.length) return setStatus(statusEl, 'No colleges found.', 'err');

    const lines = ['⚡ HackerRank Dashboard — All College & Course Share Links', ''];
    for (const col of allCols) {
      let token = col.shareToken;
      if (!token) {
        try {
          const r = await api('/api/colleges/' + col.id + '/share', { method: 'POST' });
          token = r.token;
          col.shareToken = token;
        } catch { /* ignore */ }
      }
      const colUrl = token ? `${location.origin}/college/${token}` : '(no share link)';
      lines.push(`🏛️ ${col.name}`);
      lines.push(`   🔗 College Dashboard: ${colUrl}`);

      const contestsRes = await api('/api/contests?collegeId=' + col.id);
      const contests = contestsRes.contests || [];
      if (contests.length) {
        lines.push('   Courses:');
        for (const ct of contests) {
          let ctToken = ct.shareToken;
          if (!ctToken) {
            try {
              const r = await api('/api/contests/' + ct.id + '/share', { method: 'POST' });
              ctToken = r.token;
            } catch { /* ignore */ }
          }
          const ctUrl = ctToken ? `${location.origin}/view/${ctToken}` : '(no share link)';
          lines.push(`     • ${ct.name}: ${ctUrl}`);
        }
      }
      lines.push('');
    }

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus(statusEl, `Copied all share links for ${allCols.length} colleges to clipboard! 📋`, 'ok');
    } catch {
      window.prompt('Copy all share links:', text);
      setStatus(statusEl, 'Share links ready (copied from prompt).', 'ok');
    }
    renderCollegesTable();
  } catch (e) {
    setStatus(statusEl, `Failed to copy links: ${e.message}`, 'err');
  }
}

async function exportSingleCollege(collegeId, collegeName) {
  const statusEl = $('c-status');
  setStatus(statusEl, `Exporting "${collegeName}"…`, 'info');
  try {
    const [stRes, ctRes] = await Promise.all([
      api('/api/students?college=' + encodeURIComponent(collegeName)),
      api('/api/contests?collegeId=' + collegeId)
    ]);
    const wb = XLSX.utils.book_new();
    const students = stRes.students || [];
    const rosterRows = [
      ['Name', 'HackerRank Username', 'Register Number', 'Email', 'Department', 'Section', 'Year', 'Campus']
    ];
    for (const s of students) {
      rosterRows.push([
        s.name || '', s.hrUsername || '', s.registerNo || '', s.email || '',
        s.department || '', s.section || '', s.year || '', s.campus || ''
      ]);
    }
    const wsRoster = XLSX.utils.aoa_to_sheet(rosterRows);
    XLSX.utils.book_append_sheet(wb, wsRoster, 'Student Roster');

    const contests = ctRes.contests || [];
    const courseRows = [
      ['Course Name', 'Slug', 'HackerRank URL', 'Share URL']
    ];
    for (const ct of contests) {
      const ctUrl = ct.shareToken ? `${location.origin}/view/${ct.shareToken}` : '';
      courseRows.push([ct.name, ct.slug || '', ct.contestUrl || '', ctUrl]);
    }
    const wsCourses = XLSX.utils.aoa_to_sheet(courseRows);
    XLSX.utils.book_append_sheet(wb, wsCourses, 'Courses');

    const cleanName = collegeName.replace(/[^a-zA-Z0-9_-]/g, '_');
    XLSX.writeFile(wb, `${cleanName}_data.xlsx`);
    setStatus(statusEl, `Exported "${collegeName}" data to Excel.`, 'ok');
  } catch (e) {
    setStatus(statusEl, `Export failed: ${e.message}`, 'err');
  }
}

async function exportSingleCourse(contestId, contestName) {
  const statusEl = $('cc-status');
  setStatus(statusEl, `Exporting "${contestName}"…`, 'info');
  try {
    const d = await api('/api/contest-dashboard/' + contestId);
    const dash = d.dashboard;
    const students = d.students || [];
    const byUser = new Map((dash?.users || []).map((u) => [u.username.toLowerCase(), u]));
    const rows = [
      ['Student Name', 'HackerRank Username', 'Department', 'Section', 'Solved', 'Score', 'Completion %', 'Campus', 'Register No', 'Email']
    ];
    const totalQ = dash?.summary?.totalQuestions || 0;
    for (const s of students) {
      const u = s.hrUsername ? byUser.get(s.hrUsername.toLowerCase()) : null;
      const solved = u ? u.solved : 0;
      const score = u ? u.computedScore : 0;
      const comp = totalQ ? Math.round((solved / totalQ) * 100) : 0;
      rows.push([s.name || '', s.hrUsername || '', s.department || '', s.section || '', solved, score, comp, s.campus || '', s.registerNo || '', s.email || '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Course Results');
    const cleanName = contestName.replace(/[^a-zA-Z0-9_-]/g, '_');
    XLSX.writeFile(wb, `${cleanName}_course_data.xlsx`);
    setStatus(statusEl, `Exported "${contestName}" data to Excel.`, 'ok');
  } catch (e) {
    setStatus(statusEl, `Export failed: ${e.message}`, 'err');
  }
}

// ---------- Upload roster ----------
$('up-college').addEventListener('change', loadUploadContests);
async function loadUploadContests() {
  const id = $('up-college').value;
  const sel = $('up-contest');
  if (!id) { sel.innerHTML = `<option value="">(no college)</option>`; await loadStudentFacets(); return; }
  const [contestsRes] = await Promise.all([api('/api/contests?collegeId=' + id), loadStudentFacets()]);
  const contests = contestsRes.contests || [];
  sel.innerHTML = `<option value="">College only (no course)</option>` + contests.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}
function pickCol(h, kws, exclude = []) {
  const ex = new Set(exclude.filter((i) => i >= 0));
  const n = h.map((x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const k of kws) { for (let i = 0; i < n.length; i++) { if (ex.has(i)) continue; if (n[i].includes(k)) return i; } }
  return -1;
}
$('up-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; const sel = $('up-college'); const college = sel.options[sel.selectedIndex]?.textContent;
  if (!file || !college) return setStatus($('up-status'), 'Pick a college first.', 'err');
  setStatus($('up-status'), 'Reading…', 'info');
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: '' });
    if (!rows.length) throw new Error('Empty file.');
    const h = rows[0];
    const col = {};
    // Detect the username column FIRST, then exclude it from every other match
    // (so "HackerRank Username" can't be mistaken for the Name column).
    col.user = pickCol(h, ['hackerrankusername', 'hackerrankid', 'hackerrankurl', 'hackerrank', 'username', 'handle', 'user', 'url']);
    if (col.user === -1) throw new Error('No HackerRank username/URL column found.');
    const ex = [col.user];
    col.name = pickCol(h, ['studentname', 'fullname', 'name'], ex);
    col.reg = pickCol(h, ['registernumber', 'registerno', 'rollno', 'roll', 'regno'], ex);
    col.email = pickCol(h, ['emailid', 'email', 'mail'], ex);
    col.dept = pickCol(h, ['department', 'dept', 'branch'], ex);
    col.section = pickCol(h, ['section', 'batch'], ex);
    col.year = pickCol(h, ['year'], ex);
    col.campus = pickCol(h, ['campusname', 'campus'], ex);
    const cleanUser = (v) => { v = String(v).trim(); if (!v) return ''; if (v.includes('/')) { const p = v.split('/').filter(Boolean); return p[p.length - 1]; } return v.replace(/^@/, ''); };
    const students = [];
    for (let r = 1; r < rows.length; r++) {
      const u = cleanUser(rows[r][col.user]); if (!u) continue;
      students.push({ hrUsername: u, name: col.name !== -1 ? String(rows[r][col.name]).trim() : '', registerNo: col.reg !== -1 ? String(rows[r][col.reg]).trim() : '', email: col.email !== -1 ? String(rows[r][col.email]).trim() : '', department: col.dept !== -1 ? String(rows[r][col.dept]).trim() : '', section: col.section !== -1 ? String(rows[r][col.section]).trim() : '', year: col.year !== -1 ? String(rows[r][col.year]).trim() : '', campus: col.campus !== -1 ? String(rows[r][col.campus]).trim() : '' });
    }
    if (!students.length) throw new Error('No student rows with a username.');
    const contestId = $('up-contest').value;
    const res = await api('/api/students/upload', { method: 'POST', body: { college, students, contestId: contestId || undefined } });
    const ctName = contestId ? ($('up-contest').options[$('up-contest').selectedIndex]?.textContent) : '';
    const nameWarn = col.name === -1 ? ' ⚠ No NAME column detected — names will show as usernames. Check your header row.' : '';
    const hasIssues = (res.warnings && res.warnings.length) || col.name === -1;
    setStatus($('up-status'), `Saved ${res.count} of ${res.received ?? students.length} rows to ${college}${contestId ? ` and mapped ${res.assigned} to "${ctName}"` : ''}.${nameWarn}`, hasIssues ? 'err' : 'ok');
    // Build a details panel including unmatched/duplicate notices.
    let issuesHtml = '';
    if (res.warnings && res.warnings.length) {
      issuesHtml += `<div style="margin-top:6px;color:#c0392b"><b>⚠ ${res.warnings.length === 1 ? 'Notice' : 'Notices'}:</b><ul style="margin:4px 0 0 18px">` +
        res.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + `</ul></div>`;
      const sample = (res.unmatched || []).slice(0, 8).map((x) => `${esc(x.name || '(no name)')}${x.username ? ' → <code>' + esc(x.username) + '</code>' : ''}`).join('; ');
      if (sample) issuesHtml += `<div style="margin-top:4px;font-size:12px;color:#888">No HR id: ${sample}${(res.unmatched || []).length > 8 ? ' …' : ''}</div>`;
    }
    $('up-detected').innerHTML =
      `<div>Detected → <b>name:</b> ${lbl(h, col.name)} · <b>user:</b> ${lbl(h, col.user)} · <b>reg:</b> ${lbl(h, col.reg)} · <b>email:</b> ${lbl(h, col.email)} · <b>dept:</b> ${lbl(h, col.dept)} · <b>section:</b> ${lbl(h, col.section)} · <b>year:</b> ${lbl(h, col.year)}</div>` +
      `<div style="margin-top:4px">Your sheet's headers: ${h.map((x) => `<code>${esc(String(x))}</code>`).join(', ')}</div>` + issuesHtml;
    clearDashCache(); // roster changed
    await loadColleges();
  } catch (err) { setStatus($('up-status'), err.message, 'err'); }
  finally { e.target.value = ''; }
});
const lbl = (h, i) => (i === -1 ? '—' : `"${h[i]}"`);
$('up-template').addEventListener('click', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Student Name', 'HackerRank Username', 'Register Number', 'Email ID', 'Department', 'Section', 'Year', 'Campus name']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Roster'); XLSX.writeFile(wb, 'roster_template.xlsx');
});

// ---------- Manual entry (no Excel) ----------
const cleanUsername = (v) => { v = String(v || '').trim(); if (!v) return ''; if (v.includes('/')) { const p = v.split('/').filter(Boolean); return p[p.length - 1]; } return v.replace(/^@/, ''); };

// Department / Section / Year dropdowns, populated from the college's existing
// students. "＋ New…" reveals a text box so new values aren't blocked.
const FACET_FIELDS = [['one-dept', 'departments', 'department'], ['one-section', 'sections', 'section'], ['one-year', 'years', 'year']];
async function loadStudentFacets() {
  const sel = $('up-college'); const college = sel.options[sel.selectedIndex]?.textContent;
  let facets = { departments: [], sections: [], years: [] };
  if (college) { try { facets = await api('/api/student-facets?college=' + encodeURIComponent(college)); } catch { /* keep empty */ } }
  for (const [id, key, label] of FACET_FIELDS) {
    const el = $(id); const prev = el.value;
    const opts = (facets[key] || []);
    el.innerHTML = `<option value="">— ${label} —</option>` + opts.map((v) => `<option>${esc(v)}</option>`).join('') + `<option value="__new__">＋ New…</option>`;
    if (prev && prev !== '__new__' && opts.includes(prev)) el.value = prev;
    $(id + '-new').classList.add('hidden');
  }
}
// Toggle the free-text box when "＋ New…" is picked.
for (const [id] of FACET_FIELDS) {
  $(id).addEventListener('change', () => {
    const box = $(id + '-new');
    if ($(id).value === '__new__') { box.classList.remove('hidden'); box.focus(); }
    else { box.classList.add('hidden'); box.value = ''; }
  });
}
// Value of a facet field: the typed text when "＋ New…" is active, else the picked option.
const facetValue = (id) => ($(id).value === '__new__' ? $(id + '-new').value.trim() : $(id).value);
// Shared submit for the single + bulk manual forms.
async function submitStudents(students, statusEl) {
  const sel = $('up-college'); const college = sel.options[sel.selectedIndex]?.textContent;
  if (!college) { setStatus(statusEl, 'Pick a college above first.', 'err'); return null; }
  if (!students.length) { setStatus(statusEl, 'Nothing to add.', 'err'); return null; }
  const contestId = $('up-contest').value;
  setStatus(statusEl, 'Saving…', 'info');
  try {
    const res = await api('/api/students/upload', { method: 'POST', body: { college, students, contestId: contestId || undefined } });
    const ctName = contestId ? ($('up-contest').options[$('up-contest').selectedIndex]?.textContent) : '';
    const warn = (res.warnings || []).join(' ');
    setStatus(statusEl, `Saved ${res.count} of ${res.received ?? students.length} to ${college}${contestId ? ` and mapped ${res.assigned} to "${ctName}"` : ''}.${warn ? ' ⚠ ' + warn : ''}`, (res.warnings || []).length ? 'err' : 'ok');
    clearDashCache(); // roster changed
    await loadColleges();
    return res;
  } catch (err) { setStatus(statusEl, err.message, 'err'); return null; }
}

// Single student
$('one-add').addEventListener('click', async () => {
  const user = cleanUsername($('one-user').value);
  const name = $('one-name').value.trim();
  if (!user) return setStatus($('one-status'), 'HackerRank username is required.', 'err');
  if (!name) return setStatus($('one-status'), 'Student name is required.', 'err');
  const student = {
    hrUsername: user, name,
    registerNo: $('one-reg').value.trim(), email: $('one-email').value.trim(),
    department: facetValue('one-dept'), section: facetValue('one-section'),
    year: facetValue('one-year'), campus: '',
  };
  const res = await submitStudents([student], $('one-status'));
  if (res) {
    ['one-name', 'one-user', 'one-reg', 'one-email'].forEach((id) => { $(id).value = ''; }); // keep dept/section/year for the next entry
    await loadStudentFacets(); // a newly typed dept/section/year now appears in the list
  }
});

// Bulk paste — "Name, username, reg, email, dept, section, year" (commas or tabs)
function parseBulk(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const parts = line.split(/\t|,/).map((s) => s.trim());
    let name = '', user = '', rest = [];
    if (parts.length === 1) { user = cleanUsername(parts[0]); name = user; }
    else { name = parts[0]; user = cleanUsername(parts[1]); rest = parts.slice(2); }
    if (!user) continue;
    out.push({ hrUsername: user, name: name || user, registerNo: rest[0] || '', email: rest[1] || '', department: rest[2] || '', section: rest[3] || '', year: rest[4] || '', campus: '' });
  }
  return out;
}
$('bulk-text').addEventListener('input', () => {
  const n = parseBulk($('bulk-text').value).length;
  $('bulk-count').textContent = n ? `${n} student${n > 1 ? 's' : ''} detected` : '';
});
$('bulk-add').addEventListener('click', async () => {
  const students = parseBulk($('bulk-text').value);
  if (!students.length) return setStatus($('bulk-status'), 'No valid lines found — each line needs at least a username.', 'err');
  const res = await submitStudents(students, $('bulk-status'));
  if (res) { $('bulk-text').value = ''; $('bulk-count').textContent = ''; }
});

// ---------- Connect HackerRank ----------
$('connect-btn').addEventListener('click', () => $('connect-modal').classList.remove('hidden'));
$('hr-cancel').addEventListener('click', () => $('connect-modal').classList.add('hidden'));
$('hr-connect-btn').addEventListener('click', async () => {
  setStatus($('hr-connect-status'), 'Connecting…', 'info');
  try {
    const d = await api('/api/hr/connect', { method: 'POST', body: { email: $('hr-email').value.trim(), password: $('hr-pass').value } });
    hrToken = d.hrToken;
    $('hr-pill').textContent = d.mock ? 'HR: mock' : 'HR: connected'; $('hr-pill').className = 'pill';
    $('connect-modal').classList.add('hidden');
    setStatus($('dash-status'), 'HackerRank connected. Click Sync now.', 'ok');
  } catch (e) { setStatus($('hr-connect-status'), e.message, 'err'); }
});

// ---------- Dashboard ----------
const collegeName = (id) => { const c = colleges.find((x) => String(x.id) === String(id)); return c ? c.name : ''; };
$('dash-college').addEventListener('change', async (e) => { selectedCollegeId = e.target.value; selectedContestId = ''; await loadDashContests(); });
$('dash-contest').addEventListener('change', (e) => { selectedContestId = e.target.value; loadDashboard(); });
$('sync-btn').addEventListener('click', syncContest);
$('autosync-btn').addEventListener('click', async () => {
  setStatus($('dash-status'), 'Running auto-sync for all contests… this can take a while.', 'info');
  try {
    await api('/api/auto-sync/run', { method: 'POST' });
    // Poll status until it finishes.
    const poll = setInterval(async () => {
      const s = await api('/api/auto-sync/status');
      if (!s.running) {
        clearInterval(poll);
        setStatus($('dash-status'), `Auto-sync done — ${s.lastResult || ''}`, 'ok');
        loadAutoSyncStatus(); loadDashboard();
      }
    }, 2000);
  } catch (e) { setStatus($('dash-status'), e.message, 'err'); }
});
$('share-btn').addEventListener('click', shareContest);
$('contest-add').addEventListener('click', addContest);
async function shareContest() {
  if (!selectedContestId) return setStatus($('dash-status'), 'Select a course first.', 'err');
  try {
    const r = await api('/api/contests/' + selectedContestId + '/share', { method: 'POST' });
    const url = location.origin + '/view/' + r.token;
    try { await navigator.clipboard.writeText(url); setStatus($('dash-status'), `Read-only link copied: ${url}`, 'ok'); }
    catch { window.prompt('Read-only dashboard link (copy it):', url); }
  } catch (e) { setStatus($('dash-status'), e.message, 'err'); }
}
// Shared-tab visibility checkboxes
async function loadSharedTabs() {
  try {
    const t = await api('/api/shared-tabs');
    $('st-dashboard').checked = t.dashboard !== false;
    $('st-daily').checked = t.daily !== false;
    $('st-attendance').checked = t.attendance !== false;
  } catch { /* ignore */ }
}
['st-dashboard', 'st-daily', 'st-attendance'].forEach((id) => $(id).addEventListener('change', async () => {
  const body = { dashboard: $('st-dashboard').checked, daily: $('st-daily').checked, attendance: $('st-attendance').checked };
  // Never let all three be off — keep Dashboard on as a floor.
  if (!body.dashboard && !body.daily && !body.attendance) { $('st-dashboard').checked = true; body.dashboard = true; }
  try { await api('/api/shared-tabs', { method: 'POST', body }); $('st-status').textContent = 'Saved'; setTimeout(() => { $('st-status').textContent = ''; }, 1500); }
  catch (e) { $('st-status').textContent = e.message; }
}));

$('share-college-btn').addEventListener('click', shareCollege);
async function shareCollege() {
  if (!selectedCollegeId) return setStatus($('dash-status'), 'Select a college first.', 'err');
  try {
    const r = await api('/api/colleges/' + selectedCollegeId + '/share', { method: 'POST' });
    const url = location.origin + '/college/' + r.token;
    try { await navigator.clipboard.writeText(url); setStatus($('dash-status'), `College link copied (all contests): ${url}`, 'ok'); }
    catch { window.prompt('College dashboard link (copy it):', url); }
  } catch (e) { setStatus($('dash-status'), e.message, 'err'); }
}
$('contest-del').addEventListener('click', delContest);
['f-campus', 'f-department', 'f-section', 'f-year'].forEach((id) => $(id).addEventListener('change', () => { studentsPage = 1; renderStudents(); }));
$('f-search').addEventListener('input', () => { studentsPage = 1; renderStudents(); });

async function loadDashContests() {
  if (!selectedCollegeId) return;
  dashContests = (await api('/api/contests?collegeId=' + selectedCollegeId)).contests || [];
  const sel = $('dash-contest');
  sel.innerHTML = dashContests.map((c) => `<option value="${c.id}">${esc(c.name)}${c.slug ? '' : ' (no link)'}</option>`).join('') || `<option value="">No contests</option>`;
  if (!dashContests.some((c) => String(c.id) === selectedContestId)) selectedContestId = dashContests[0] ? String(dashContests[0].id) : '';
  sel.value = selectedContestId;
  await loadDashboard();
}
async function addContest() {
  if (!selectedCollegeId) return setStatus($('dash-status'), 'Pick a college first.', 'err');
  const name = prompt('Course name (e.g. Round 1):'); if (!name) return;
  const contestUrl = prompt('HackerRank course link:') || '';
  try { const r = await api('/api/contests', { method: 'POST', body: { collegeId: selectedCollegeId, name, contestUrl } }); selectedContestId = String(r.contest.id); await loadDashContests(); setStatus($('dash-status'), `Added "${name}". Connect HackerRank and Sync it.`, 'ok'); }
  catch (e) { setStatus($('dash-status'), e.message, 'err'); }
}
async function delContest() {
  if (!selectedContestId) return;
  if (!confirm('Delete this course?')) return;
  await api('/api/contests/' + selectedContestId, { method: 'DELETE' });
  selectedContestId = ''; await loadDashContests();
}

function showContestLink() {
  const ct = dashContests.find((c) => String(c.id) === String(selectedContestId));
  $('dash-contest-url').value = ct ? (ct.contestUrl || '') : '';
}
$('dash-savelink').addEventListener('click', async () => {
  if (!selectedContestId) return setStatus($('dash-status'), 'Select a course first.', 'err');
  try { await api('/api/contests/' + selectedContestId, { method: 'PUT', body: { contestUrl: $('dash-contest-url').value.trim() } }); setStatus($('dash-status'), 'Course link saved. Sync it now.', 'ok'); await loadDashContests(); }
  catch (e) { setStatus($('dash-status'), e.message, 'err'); }
});

// Browser-side cache of contest dashboards so switching back is instant.
// Cleared for a contest whenever it's re-synced.
const dashCache = new Map();
function clearDashCache(contestId) { if (contestId == null) dashCache.clear(); else dashCache.delete(String(contestId)); }

function applyDashboard(d) {
  dashData = d.dashboard;
  dashTopics = d.topics || {};
  dashCats = d.categories || {};
  roster = d.students || [];  // students mapped to this contest (falls back to whole college if none mapped)
  fillFilters();
  renderSummary();
  renderTopicAnalysis();
  renderCompletion();
  renderCategoryChart();
  renderStudents();
  setStatus($('dash-status'), dashData ? '' : `"${d.contest.name}" not synced yet. Connect HackerRank and Sync now.`, 'info');
}

async function loadDashboard() {
  solvedFilter = null;
  studentsPage = 1;
  showContestLink();
  if (!selectedContestId) {
    // Only when there's no contest do we need the whole-college roster.
    roster = selectedCollegeId ? (await api('/api/students?college=' + encodeURIComponent(collegeName(selectedCollegeId)))).students || [] : [];
    dashData = null; dashTopics = {}; fillFilters(); renderSummary(); renderTopicAnalysis(); renderStudents();
    setStatus($('dash-status'), 'No course yet — add one with ＋ Course.', 'info'); return;
  }
  const id = String(selectedContestId);
  const cached = dashCache.get(id);
  if (cached) {
    applyDashboard(cached);                       // paint instantly from cache
    revalidateDashboard(id);                      // then refresh quietly in the background
    return;
  }
  setStatus($('dash-status'), 'Loading…', 'info');
  // The contest-dashboard call already returns this contest's students, so skip the redundant roster fetch.
  const d = await api('/api/contest-dashboard/' + id);
  dashCache.set(id, d);
  if (String(selectedContestId) !== id) return;   // user switched away while it loaded
  applyDashboard(d);
  prefetchSiblingContests();
}

// Refresh a cached dashboard in the background; re-render only if still shown.
function revalidateDashboard(id) {
  api('/api/contest-dashboard/' + id).then((d) => {
    dashCache.set(id, d);
    if (String(selectedContestId) === String(id)) applyDashboard(d);
  }).catch(() => { /* keep showing cached data */ });
}

// Warm the cache for the other contests of the current college, one at a time
// so we don't flood the network while the user is reading.
let prefetching = false;
async function prefetchSiblingContests() {
  if (prefetching) return;
  prefetching = true;
  try {
    for (const c of dashContests) {
      const id = String(c.id);
      if (dashCache.has(id) || id === String(selectedContestId)) continue;
      try { dashCache.set(id, await api('/api/contest-dashboard/' + id)); } catch { /* ignore */ }
    }
  } finally { prefetching = false; }
}

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
    rows.map((r) => `<tr><td>${esc(r.topic)}</td><td class="num">${r.questions}</td><td class="num">${r.solveRate}%</td></tr>`).join('') +
    `</tbody>`;

  // Topic × category completion matrix
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
    }).join('')}</tr>`).join('') +
    `</tbody>`;
  card.classList.remove('hidden');
}

// ---- Topic × category: who completed / who didn't ----
let tcCellMap = {}, tcRows = [], tcFilter = 'all', tcPage = 1;
const TC_PAGE = 20;
$('cat-topic-table').addEventListener('click', (e) => {
  const td = e.target.closest('td.tcell[data-topic]');
  if (td) openTopicCat(td.dataset.topic, td.dataset.cat);
});
function openTopicCat(topic, cat) {
  const entry = tcCellMap[topic] && tcCellMap[topic][cat];
  if (!entry) return;
  const qs = entry.qs;
  const byUser = new Map(dashData.users.map((u) => [u.username.toLowerCase(), u]));
  const rows = [];
  for (const s of roster) {
    const u = byUser.get((s.hrUsername || '').toLowerCase()); if (!u) continue;
    const solved = qs.filter((qn) => u.questionStatus[qn]?.solved).length;
    rows.push({ name: s.name || s.hrUsername, hrUsername: s.hrUsername, department: s.department, section: s.section, solved, total: qs.length, completed: solved === qs.length });
  }
  const done = rows.filter((r) => r.completed).length;
  tcRows = rows.sort((a, b) => (b.completed - a.completed) || (b.solved - a.solved));
  tcFilter = 'all'; tcPage = 1;
  $('tc-modal-title').textContent = `${topic} · ${CAT_LABELS[cat] || cat} — ${done}/${rows.length} completed (${qs.length} question${qs.length > 1 ? 's' : ''})`;
  renderTcPage();
  $('tc-modal').classList.remove('hidden');
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
// Bands of `step`: a "0" (none) band, then 1–step, step+1–2·step, … up to totalQ.
function completionBands(totalQ, step = 10) {
  const bands = [{ label: '0', lo: 0, hi: 0 }];
  for (let lo = 1; lo <= totalQ; lo += step) { const hi = Math.min(lo + step - 1, totalQ); bands.push({ label: lo === hi ? `${lo}` : `${lo}–${hi}`, lo, hi }); }
  return bands;
}
// Default band size by contest size: ≤100 → 10, 101–150 → 15, >150 → 20.
function defaultBandSize(totalQ) { return totalQ > 150 ? 20 : totalQ > 100 ? 15 : 10; }
let cbLastTotalQ = null;
$('cb-band-size').addEventListener('change', renderCompletion);
function renderCompletion() {
  const card = $('completion-card');
  if (!dashData) { card.classList.add('hidden'); return; }
  const rows = joinedRows();
  if (!rows.length) { card.classList.add('hidden'); return; }
  const totalQ = dashData.summary.totalQuestions;
  const total = rows.length;
  // On a new contest (different question count) reset the dropdown to the size-based default;
  // keep the user's manual choice while the same contest is shown.
  if (cbLastTotalQ !== totalQ) { $('cb-band-size').value = String(defaultBandSize(totalQ)); cbLastTotalQ = totalQ; }
  const step = parseInt($('cb-band-size').value, 10) || 10;
  const bands = completionBands(totalQ, step).map((b) => ({ ...b, count: rows.filter((r) => r.solved >= b.lo && r.solved <= b.hi).length }));
  $('cb-note').textContent = `· ${total} students`;
  $('completion-chart').innerHTML = completionBarSVG(bands, total);
  $('completion-pager').innerHTML = '';
  card.classList.remove('hidden');
}
// Vertical bar chart. Each bar is clickable (data-lo / data-hi) to list students.
function completionBarSVG(bands, total) {
  const W = 640, H = 260, padL = 40, padB = 46, padT = 14, padR = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = bands.length;
  const gap = 8;
  const bw = Math.max(6, (plotW - gap * (n - 1)) / n);
  const maxCount = Math.max(...bands.map((b) => b.count), 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="font-family:inherit;display:inline-block;width:100%;max-width:${W}px;max-height:${H}px">`;
  // y gridlines (0, 25, 50, 75, 100% of maxCount)
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (plotH * g) / 4;
    const val = Math.round((maxCount * g) / 4);
    s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    s += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${val}</text>`;
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
$('completion-chart').addEventListener('click', (e) => {
  const bar = e.target.closest('.cb-bar[data-lo]');
  if (bar) openCompletionNames(Number(bar.dataset.lo), Number(bar.dataset.hi), bar.dataset.label);
});
let cbRows = [], cbPage = 1;
const CB_PAGE = 20;
function openCompletionNames(lo, hi, label) {
  if (!dashData) return;
  const totalQ = dashData.summary.totalQuestions;
  cbRows = joinedRows().filter((r) => r.solved >= lo && r.solved <= hi).sort((a, b) => b.solved - a.solved || b.score - a.score);
  cbPage = 1;
  const range = lo === hi ? `${lo}` : `${label || lo + '–' + hi}`;
  $('cb-modal-title').textContent = `${cbRows.length} student(s) solved ${range} / ${totalQ}`;
  renderCbPage();
  $('cb-modal').classList.remove('hidden');
}
function renderCbPage() {
  const total = cbRows.length;
  const pages = Math.max(1, Math.ceil(total / CB_PAGE));
  if (cbPage > pages) cbPage = pages;
  const start = (cbPage - 1) * CB_PAGE;
  const slice = cbRows.slice(start, start + CB_PAGE);
  $('cb-modal-table').innerHTML =
    `<thead><tr><th>#</th><th>Student</th><th>HR username</th><th>Dept</th><th>Section</th><th class="num">Solved</th><th class="num">Score</th></tr></thead><tbody>` +
    (slice.length ? slice.map((r, idx) => `<tr><td class="num">${start + idx + 1}</td><td><a class="user-link" data-user="${esc(r.hrUsername)}">${esc(r.name || r.hrUsername)}</a></td><td>${esc(r.hrUsername)}</td><td>${esc(r.department || '—')}</td><td>${esc(r.section || '—')}</td><td class="num">${r.solved}</td><td class="num">${r.score}</td></tr>`).join('')
      : `<tr><td colspan="7" class="muted">No students.</td></tr>`) + `</tbody>`;
  const from = total ? start + 1 : 0;
  $('cb-pager').innerHTML = total > CB_PAGE
    ? `<button class="ghost sm" id="cb-prev" ${cbPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + CB_PAGE, total)} of ${total} · page ${cbPage}/${pages}</span><button class="ghost sm" id="cb-next" ${cbPage >= pages ? 'disabled' : ''}>Next ›</button>`
    : '';
  if (total > CB_PAGE) {
    $('cb-prev').addEventListener('click', () => { if (cbPage > 1) { cbPage--; renderCbPage(); } });
    $('cb-next').addEventListener('click', () => { if (cbPage < pages) { cbPage++; renderCbPage(); } });
  }
}
$('cb-modal-close').addEventListener('click', () => $('cb-modal').classList.add('hidden'));
$('cb-modal').addEventListener('click', (e) => { if (e.target.id === 'cb-modal') $('cb-modal').classList.add('hidden'); });
$('cb-modal-table').addEventListener('click', (e) => { const l = e.target.closest('.user-link[data-user]'); if (l) { e.preventDefault(); $('cb-modal').classList.add('hidden'); openPerf(l.dataset.user); } });

let taRows = [];
const heatColor = (p) => `hsl(${Math.round((p / 100) * 120)},70%,${p === 0 ? 30 : 52}%)`;
$('ta-chart-btn').addEventListener('click', () => { if (!taRows.length) return; $('ta-modal-chart').innerHTML = topicChartSVG(taRows); $('ta-modal').classList.remove('hidden'); });
$('ta-modal-close').addEventListener('click', () => $('ta-modal').classList.add('hidden'));
$('ta-modal').addEventListener('click', (e) => { if (e.target.id === 'ta-modal') $('ta-modal').classList.add('hidden'); });
function topicChartSVG(rows) {
  const rowH = 28, top = 8, left = 168, barMax = 320, W = 620, H = top * 2 + rows.length * rowH;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:${H}px;font-family:inherit">`;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const bw = Math.max(2, Math.round((barMax * r.solveRate) / 100));
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
  if (!dashData) { card.classList.add('hidden'); return; }
  const byUser = new Map(dashData.users.map((u) => [u.username.toLowerCase(), u]));
  const participants = roster.map((s) => byUser.get((s.hrUsername || '').toLowerCase())).filter(Boolean);
  if (!participants.length) { card.classList.add('hidden'); return; }

  const topicQs = new Map();
  for (const q of dashData.questions) {
    const t = dashTopics[q.name] || splitTitle(q.name).tag || 'Other';
    if (!topicQs.has(t)) topicQs.set(t, []);
    topicQs.get(t).push(q.name);
  }
  // Keep topics in the order questions appear in the contest (same as the Topics tab).
  const rows = Array.from(topicQs.entries()).map(([topic, qs]) => {
    let solved = 0;
    for (const u of participants) for (const qn of qs) if (u.questionStatus[qn]?.solved) solved++;
    const denom = participants.length * qs.length;
    return { topic, questions: qs.length, solveRate: denom ? Math.round((solved / denom) * 100) : 0, avgSolved: +(solved / participants.length).toFixed(2) };
  });

  const weakest = rows.reduce((a, b) => (b.solveRate < a.solveRate ? b : a), rows[0]);
  taRows = rows;
  $('ta-note').textContent = `· ${participants.length} participants · ${rows.length} topics · weakest: ${weakest.topic} (${weakest.solveRate}%)`;
  $('ta-chart').innerHTML = topicChartSVG(rows);
  $('topic-analysis-table').innerHTML =
    `<thead><tr><th>#</th><th>Topic</th><th class="num">Questions</th><th class="num">Avg solved / student</th><th>Solve rate</th></tr></thead><tbody>` +
    rows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(r.topic)}</td><td class="num">${r.questions}</td><td class="num">${r.avgSolved}</td><td><div class="bar" style="display:inline-block;width:120px;vertical-align:middle"><span style="width:${r.solveRate}%"></span></div> <span class="muted">${r.solveRate}%</span></td></tr>`).join('') +
    `</tbody>`;
  card.classList.remove('hidden');
}
function fillFilters() {
  const labels = { department: 'departments', section: 'sections', year: 'years', campus: 'campuses' };
  for (const [id, key] of [['f-campus', 'campus'], ['f-department', 'department'], ['f-section', 'section'], ['f-year', 'year']]) {
    const sel = $(id); const prev = sel.value;
    const vals = Array.from(new Set(roster.map((s) => s[key]).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    sel.innerHTML = `<option value="">All ${labels[key]}</option>` + vals.map((v) => `<option>${esc(v)}</option>`).join('');
    if (vals.includes(prev)) sel.value = prev;
  }
}
function renderSummary() {
  const sm = $('summary');
  if (!dashData) { sm.classList.add('hidden'); return; }
  sm.classList.remove('hidden');
  const userKeys = new Set((dashData.users || []).map((u) => u.username.toLowerCase()));
  const inContest = roster.filter((s) => s.hrUsername && userKeys.has(String(s.hrUsername).trim().toLowerCase())).length;
  sm.innerHTML = [['Students', roster.length], ['In course', inContest], ['Questions', dashData.summary.totalQuestions], ['Avg solved', dashData.summary.avgSolved], ['Completion', dashData.summary.overallCompletion + '%']]
    .map(([l, v]) => `<div class="stat"><div class="value">${v}</div><div class="label">${l}</div></div>`).join('');
}
function joinedRows() {
  const byUser = new Map((dashData?.users || []).map((u) => [u.username.toLowerCase(), u]));
  return roster.map((s) => {
    const rawHr = String(s.hrUsername || '').trim();
    const hasHrId = !!rawHr;
    const u = hasHrId ? byUser.get(rawHr.toLowerCase()) : null;
    const totalQ = dashData?.summary.totalQuestions || 0;
    return { ...s, hasHrId, inContest: !!u, solved: u ? u.solved : 0, score: u ? u.computedScore : 0, totalQ, completion: u && totalQ ? Math.round((u.solved / totalQ) * 100) : 0 };
  });
}
function filteredRows() {
  const f = { campus: $('f-campus').value, department: $('f-department').value, section: $('f-section').value, year: $('f-year').value, q: $('f-search').value.trim().toLowerCase() };
  return joinedRows().filter((r) => (!f.campus || r.campus === f.campus) && (!f.department || r.department === f.department) && (!f.section || r.section === f.section) && (!f.year || r.year === f.year) &&
    (!f.q || (r.name || '').toLowerCase().includes(f.q) || (r.hrUsername || '').toLowerCase().includes(f.q)))
    // Students with no HackerRank id always sink to the very end.
    .sort((a, b) => (a.hasHrId === b.hasHrId ? 0 : a.hasHrId ? -1 : 1) || b.solved - a.solved || b.score - a.score);
}
function renderStudents() {
  const all = filteredRows();
  const hasScrape = !!dashData;
  const pages = Math.max(1, Math.ceil(all.length / STUDENTS_PAGE));
  if (studentsPage > pages) studentsPage = pages;
  const start = (studentsPage - 1) * STUDENTS_PAGE;
  const rows = all.slice(start, start + STUDENTS_PAGE);
  $('students-table').innerHTML =
    `<thead><tr><th><input type="checkbox" id="sel-all"/></th><th>#</th><th class="grow">Student</th><th class="grow">HR username</th><th>Dept</th><th>Section</th>` +
    (hasScrape ? `<th class="num">Solved</th><th class="num">Score</th><th class="comp">Completion</th>` : '') +
    `<th style="width:48px;text-align:center">Edit</th></tr></thead><tbody>` +
    (rows.length ? rows.map((r, idx) =>
      `<tr><td><input type="checkbox" class="sel" value="${r.id}"/></td><td class="num">${start + idx + 1}</td><td class="grow"><a class="user-link" data-user="${esc(r.hrUsername)}">${esc(r.name || r.hrUsername || '(unnamed)')}</a></td><td class="grow">${r.hasHrId ? esc(r.hrUsername) + (r.inContest ? '' : ' <span class="muted">·absent</span>') : '<span class="badge warn">no HR id</span>'}</td><td>${esc(r.department || '—')}</td><td>${esc(r.section || '—')}</td>` +
      (hasScrape ? `<td class="num">${r.solved}/${r.totalQ}</td><td class="num">${r.score}</td><td class="comp"><div class="bar"><span style="width:${r.completion}%"></span></div></td>` : '') +
      `<td style="text-align:center"><button class="ghost sm edit-student-btn" data-edit-student="${r.id}" title="Edit student details" style="padding:2px 7px;font-size:.85rem;cursor:pointer">✏️</button></td></tr>`).join('')
      : `<tr><td colspan="${hasScrape ? 10 : 7}" class="muted">No students. Upload a roster (Upload tab).</td></tr>`) + `</tbody>`;
  const selAll = $('sel-all'); if (selAll) selAll.addEventListener('change', () => document.querySelectorAll('#students-table .sel').forEach((c) => (c.checked = selAll.checked)));
  const from = all.length ? start + 1 : 0;
  $('students-pager').innerHTML = all.length > STUDENTS_PAGE
    ? `<button class="ghost sm" id="st-prev" ${studentsPage <= 1 ? 'disabled' : ''}>‹ Prev</button><span class="muted">${from}–${Math.min(start + STUDENTS_PAGE, all.length)} of ${all.length} · page ${studentsPage}/${pages}</span><button class="ghost sm" id="st-next" ${studentsPage >= pages ? 'disabled' : ''}>Next ›</button>`
    : '';
  if (all.length > STUDENTS_PAGE) {
    $('st-prev').addEventListener('click', () => { if (studentsPage > 1) { studentsPage--; renderStudents(); } });
    $('st-next').addEventListener('click', () => { if (studentsPage < pages) { studentsPage++; renderStudents(); } });
  }
}

// Student Edit Modal handlers
function openEditStudent(id) {
  const s = roster.find((x) => String(x.id) === String(id));
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

  const sel = $('edit-st-college');
  sel.innerHTML = colleges.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  if (s.college) sel.value = s.college;
  else if (selectedCollegeId) {
    const curCol = colleges.find((c) => String(c.id) === String(selectedCollegeId));
    if (curCol) sel.value = curCol.name;
  }

  setStatus($('edit-st-status'), '', 'info');
  $('edit-student-modal').classList.remove('hidden');
}

$('edit-st-close')?.addEventListener('click', () => $('edit-student-modal').classList.add('hidden'));
$('edit-st-cancel')?.addEventListener('click', () => $('edit-student-modal').classList.add('hidden'));
$('edit-student-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'edit-student-modal') $('edit-student-modal').classList.add('hidden');
});

$('edit-st-save')?.addEventListener('click', async () => {
  const id = $('edit-st-id').value;
  const name = $('edit-st-name').value.trim();
  const hrUsername = $('edit-st-username').value.trim();
  const registerNo = $('edit-st-reg').value.trim();
  const email = $('edit-st-email').value.trim();
  const college = $('edit-st-college').value.trim();
  const campus = $('edit-st-campus').value.trim();
  const department = $('edit-st-dept').value.trim();
  const section = $('edit-st-sec').value.trim();
  const year = $('edit-st-year').value.trim();

  if (!name && !hrUsername) {
    return setStatus($('edit-st-status'), 'Please provide a student name or HackerRank username.', 'err');
  }

  setStatus($('edit-st-status'), 'Saving changes…', 'info');
  try {
    const res = await api('/api/students/' + id, {
      method: 'PUT',
      body: { name, hrUsername, registerNo, email, college, campus, department, section, year }
    });
    const updated = res.student || { id: Number(id), name, hrUsername, registerNo, email, college, campus, department, section, year };

    const idx = roster.findIndex((x) => String(x.id) === String(id));
    if (idx !== -1) {
      roster[idx] = { ...roster[idx], ...updated };
    }

    if (dailyDataCache && Array.isArray(dailyDataCache.students)) {
      const dIdx = dailyDataCache.students.findIndex((x) => String(x.id) === String(id) || (x.hrUsername && x.hrUsername.toLowerCase() === (updated.hrUsername || '').toLowerCase()));
      if (dIdx !== -1) {
        dailyDataCache.students[dIdx] = { ...dailyDataCache.students[dIdx], ...updated };
      }
    }

    setStatus($('edit-st-status'), 'Saved successfully!', 'ok');
    setTimeout(() => {
      $('edit-student-modal').classList.add('hidden');
      renderStudents();
      if (typeof drawDailyTable === 'function') drawDailyTable();
    }, 400);
  } catch (e) {
    setStatus($('edit-st-status'), e.message || 'Failed to save student.', 'err');
  }
});

$('students-table').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-student]');
  if (editBtn) {
    e.preventDefault();
    openEditStudent(editBtn.dataset.editStudent);
    return;
  }
  const u = e.target.closest('.user-link[data-user]');
  if (u && u.dataset.user) {
    e.preventDefault();
    openPerf(u.dataset.user);
  }
});

$('del-btn').addEventListener('click', async () => {
  const ids = Array.from(document.querySelectorAll('#students-table .sel:checked')).map((c) => Number(c.value));
  if (!ids.length) return setStatus($('dash-status'), 'Select students to delete.', 'err');
  if (!confirm(`Delete ${ids.length} student(s)?`)) return;
  await api('/api/students', { method: 'DELETE', body: { ids } });
  await loadDashboard();
});
$('export-btn').addEventListener('click', () => {
  const rows = filteredRows();
  const aoa = [['Name', 'HR Username', 'Register No', 'Email', 'Department', 'Section', 'Year', 'Campus', 'Solved', 'Score', 'Completion %']];
  for (const r of rows) aoa.push([r.name, r.hrUsername, r.registerNo, r.email, r.department, r.section, r.year, r.campus, r.solved, r.score, r.completion]);
  const ws = XLSX.utils.aoa_to_sheet(aoa); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Students'); XLSX.writeFile(wb, 'students.xlsx');
});

// ---------- Daily tab ----------
let dailyCollegeId = '', dailyContestId = '';
let dailyPage = 1;
const DAILY_PAGE = 30;

document.querySelectorAll('#tabs .tab').forEach((b) => { if (b.dataset.tab === 'daily') b.addEventListener('click', initDailyTab); });
function initDailyTab() { fillCollegeSelect($('daily-college')); if (!dailyCollegeId && colleges[0]) dailyCollegeId = String(colleges[0].id); $('daily-college').value = dailyCollegeId; loadDailyContests(); }
$('daily-college').addEventListener('change', (e) => { dailyCollegeId = e.target.value; dailyContestId = ''; dailyPage = 1; loadDailyContests(); });
$('daily-contest').addEventListener('change', (e) => { dailyContestId = e.target.value; dailyPage = 1; renderDaily(); });
async function loadDailyContests() {
  if (!dailyCollegeId) return;
  const contests = (await api('/api/contests?collegeId=' + dailyCollegeId)).contests || [];
  const sel = $('daily-contest');
  sel.innerHTML = contests.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') || `<option value="">No contests</option>`;
  if (!contests.some((c) => String(c.id) === dailyContestId)) dailyContestId = contests[0] ? String(contests[0].id) : '';
  sel.value = dailyContestId;
  dailyPage = 1;
  renderDaily();
}
let dailyDataCache = null; // { days, students } for the loaded course
function fmtDay(s) { const dt = new Date(s + 'T00:00:00'); return isNaN(dt) ? s : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }

async function renderDaily() {
  const t = $('daily-table');
  if (!dailyContestId) { t.innerHTML = ''; $('daily-note').textContent = ''; dailyDataCache = null; if ($('daily-table-pager')) $('daily-table-pager').innerHTML = ''; return; }
  const d = await api('/api/daily/' + dailyContestId);
  dailyDataCache = d;
  if (!d.days.length) { t.innerHTML = `<tbody><tr><td class="muted">No snapshots yet — sync this course on at least one day (ideally daily) to build history.</td></tr></tbody>`; $('daily-note').textContent = ''; if ($('daily-table-pager')) $('daily-table-pager').innerHTML = ''; return; }
  // Populate filter dropdowns from this course's students.
  const dailyLabels = { department: 'departments', section: 'sections', year: 'years', campus: 'campuses' };
  for (const [id, key] of [['daily-f-campus', 'campus'], ['daily-f-department', 'department'], ['daily-f-section', 'section'], ['daily-f-year', 'year']]) {
    const sel = $(id); const prev = sel.value;
    const vals = Array.from(new Set(d.students.map((s) => s[key]).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
    sel.innerHTML = `<option value="">All ${dailyLabels[key]}</option>` + vals.map((v) => `<option>${esc(v)}</option>`).join('');
    if (vals.includes(prev)) sel.value = prev;
  }
  drawDailyTable();
}

function getFilteredDailyStudents() {
  const d = dailyDataCache;
  if (!d || !d.students) return [];
  const f = {
    campus: $('daily-f-campus')?.value || '',
    department: $('daily-f-department')?.value || '',
    section: $('daily-f-section')?.value || '',
    year: $('daily-f-year')?.value || '',
    q: ($('daily-f-search')?.value || '').trim().toLowerCase(),
  };
  return d.students.filter((s) =>
    (!f.campus || s.campus === f.campus) &&
    (!f.department || s.department === f.department) &&
    (!f.section || s.section === f.section) &&
    (!f.year || s.year === f.year) &&
    (!f.q || (s.name || '').toLowerCase().includes(f.q) || (s.hrUsername || '').toLowerCase().includes(f.q))
  );
}

function drawDailyTable() {
  const d = dailyDataCache; if (!d || !d.days) return;
  const t = $('daily-table');
  const allStudents = getFilteredDailyStudents();
  $('daily-note').textContent = `· ${allStudents.length}${allStudents.length !== d.students.length ? ' of ' + d.students.length : ''} students · ${d.days.length} day(s)`;

  // Compute stats per day for all filtered students
  const dayStats = d.days.map((day, idx) => {
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
    d.days.map((day, idx) =>
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
    d.days.map((day, idx) =>
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
      : `<tr><td colspan="${d.days.length + 2}" class="muted">No students match these filters.</td></tr>`) +
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
  const d = dailyDataCache; if (!d || !d.days) return;
  dailyModalSelectedDayIdx = dayIdx;
  const isAll = dayIdx === 'all';
  const dayStr = isAll ? null : d.days[Number(dayIdx)];
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
    $('daily-modal-subtitle').textContent = `Active students with solves · Solved in ${d.days.length}-day window: ${totalWindowQ}`;
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
    openPerf(u.dataset.user, dailyContestId);
  }
});

$('daily-modal-close')?.addEventListener('click', () => $('daily-modal').classList.add('hidden'));
$('daily-modal')?.addEventListener('click', (e) => { if (e.target.id === 'daily-modal') $('daily-modal').classList.add('hidden'); });
$('daily-modal-search')?.addEventListener('input', () => { dailyModalPage = 1; renderDailyModalPage(); });
$('daily-modal-table')?.addEventListener('click', (e) => {
  const target = e.target.closest('.view-perf-btn, .view-perf-link, .user-link[data-user]');
  if (target && target.dataset.user) {
    e.preventDefault();
    openPerf(target.dataset.user, dailyContestId);
  }
});

// ---------- Topics tab ----------
let topicsCollegeId = '', topicsContestId = '', topicsContests = [];
document.querySelectorAll('#tabs .tab').forEach((b) => { if (b.dataset.tab === 'topics') b.addEventListener('click', initTopicsTab); });
function initTopicsTab() { fillCollegeSelect($('t-college')); if (!topicsCollegeId && colleges[0]) topicsCollegeId = String(colleges[0].id); $('t-college').value = topicsCollegeId; loadTopicsContests(); }
$('t-college').addEventListener('change', (e) => { topicsCollegeId = e.target.value; topicsContestId = ''; loadTopicsContests(); });
$('t-contest-sel').addEventListener('change', (e) => { topicsContestId = e.target.value; loadTopicsEditor(); });
async function loadTopicsContests() {
  if (!topicsCollegeId) return;
  topicsContests = (await api('/api/contests?collegeId=' + topicsCollegeId)).contests || [];
  const sel = $('t-contest-sel');
  sel.innerHTML = topicsContests.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') || `<option value="">No contests</option>`;
  if (!topicsContests.some((c) => String(c.id) === topicsContestId)) topicsContestId = topicsContests[0] ? String(topicsContests[0].id) : '';
  sel.value = topicsContestId;
  loadTopicsEditor();
}
async function loadTopicsEditor() {
  if (!topicsContestId) { $('topics-table').innerHTML = ''; $('t-contest').value = ''; setStatus($('t-status'), 'No contests for this college — add one in the Dashboard tab.', 'info'); return; }
  const d = await api('/api/topics/' + topicsContestId);
  $('t-contest').value = d.contestUrl || '';
  if (!d.contestUrl) { $('topics-table').innerHTML = ''; setStatus($('t-status'), 'This course has no link. Set it above and Save link.', 'info'); return; }
  if (!d.hasScrape) { $('topics-table').innerHTML = ''; $('topic-videos-card').classList.add('hidden'); setStatus($('t-status'), `Course "${d.slug}" not synced yet. Sync it in the Dashboard tab to load its questions.`, 'info'); return; }
  setStatus($('t-status'), `${d.questions.length} questions in ${d.slug}.`, 'info');
  $('topics-table').innerHTML =
    `<thead><tr><th>#</th><th>Question</th><th>Topic</th><th>Category</th></tr></thead><tbody>` +
    d.questions.map((q, i) => `<tr><td class="num">${i + 1}</td><td>${esc(q.name)}</td>` +
      `<td><input class="topic-in" data-q="${esc(q.name)}" data-sug="${esc(q.suggested)}" value="${esc(q.topic)}" placeholder="${esc(q.suggested || 'topic')}" style="min-width:180px"/></td>` +
      `<td><select class="qcat-in" data-q="${esc(q.name)}">${QCATS.map(([v, l]) => `<option value="${v}" ${q.category === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`).join('') +
    `</tbody>`;
  loadTopicVideos();
}
async function loadTopicVideos() {
  const card = $('topic-videos-card');
  if (!topicsContestId) { card.classList.add('hidden'); return; }
  const d = await api('/api/topic-videos/' + topicsContestId);
  if (!d.hasScrape || !d.topics.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('tv-table').innerHTML =
    `<thead><tr><th>Topic</th><th>Video links (one per line)</th></tr></thead><tbody>` +
    d.topics.map((t) => `<tr><td>${esc(t.name)}</td><td><textarea class="tv-in" data-topic="${esc(t.name)}" rows="2" placeholder="https://youtu.be/…&#10;https://youtu.be/… (one per line)" style="min-width:300px">${esc((t.videos || []).join('\n'))}</textarea></td></tr>`).join('') +
    `</tbody>`;
}
const QCATS = [['', '—'], ['inclass', 'In-class'], ['postclass', 'Post-class'], ['challenges', 'Challenges']];

// ---- Bulk-set category on every question in the loaded contest ----
$('t-bulk-cat').innerHTML = QCATS.map(([v, l]) => `<option value="${v}">${v ? l : '— (clear)'}</option>`).join('');
function bulkSetCategory(onlyBlank) {
  const val = $('t-bulk-cat').value;
  const sels = document.querySelectorAll('#topics-table .qcat-in');
  if (!sels.length) return setStatus($('t-status'), 'No questions loaded — pick a synced course first.', 'err');
  let n = 0;
  sels.forEach((sel) => { if (onlyBlank && sel.value) return; sel.value = val; n++; });
  const label = (QCATS.find(([v]) => v === val) || ['', '—'])[1];
  setStatus($('t-status'), `Set ${n} question${n === 1 ? '' : 's'} to "${val ? label : 'no category'}". Click Save topics to apply.`, 'ok');
}
$('t-bulk-apply').addEventListener('click', () => bulkSetCategory(false));
$('t-bulk-apply-blank').addEventListener('click', () => bulkSetCategory(true));
$('tv-save').addEventListener('click', async () => {
  if (!topicsContestId) return;
  const map = {};
  document.querySelectorAll('#tv-table .tv-in').forEach((inp) => { if (inp.value.trim()) map[inp.dataset.topic] = inp.value; });
  try { const r = await api('/api/topic-videos/' + topicsContestId, { method: 'POST', body: { map } }); setStatus($('tv-status'), `Saved ${r.count} topic video(s).`, 'ok'); }
  catch (e) { setStatus($('tv-status'), e.message, 'err'); }
});
$('t-savelink').addEventListener('click', async () => {
  if (!topicsContestId) return;
  try {
    await api('/api/contests/' + topicsContestId, { method: 'PUT', body: { contestUrl: $('t-contest').value.trim() } });
    setStatus($('t-status'), 'Course link saved. Now sync it in the Dashboard tab.', 'ok');
    await loadTopicsContests();
  } catch (e) { setStatus($('t-status'), e.message, 'err'); }
});
$('t-autofill').addEventListener('click', () => document.querySelectorAll('#topics-table .topic-in').forEach((inp) => { if (!inp.value.trim() && inp.dataset.sug) inp.value = inp.dataset.sug; }));
$('t-save').addEventListener('click', async () => {
  if (!topicsContestId) return;
  const map = {};
  document.querySelectorAll('#topics-table .topic-in').forEach((inp) => { if (inp.value.trim()) map[inp.dataset.q] = inp.value.trim(); });
  const catMap = {};
  document.querySelectorAll('#topics-table .qcat-in').forEach((sel) => { if (sel.value) catMap[sel.dataset.q] = sel.value; });
  try {
    const r = await api('/api/topics/' + topicsContestId, { method: 'POST', body: { map } });
    await api('/api/question-categories/' + topicsContestId, { method: 'POST', body: { map: catMap } });
    setStatus($('t-status'), `Saved ${r.count} topics and ${Object.keys(catMap).length} categories.`, 'ok');
    clearDashCache(topicsContestId);
    loadTopicVideos(); if (String(topicsContestId) === String(selectedContestId)) loadDashboard();
  }
  catch (e) { setStatus($('t-status'), e.message, 'err'); }
});

// ---------- Student performance modal ----------
let dashTopics = {}; // saved question->topic for current college
let dashCats = {};   // saved question->category for current contest
function questionUrl(q) { const u = q.url; if (!u || u === '#') return null; return u.startsWith('http') ? u : 'https://www.hackerrank.com' + (u.startsWith('/') ? u : '/' + u); }
function splitTitle(name) { const m = String(name).split(/\s+[–—-]\s+/); return m.length >= 2 ? { tag: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { tag: '', title: String(name) }; }

document.getElementById('students-table').addEventListener('click', (e) => {
  const link = e.target.closest('.user-link[data-user]');
  if (link) { e.preventDefault(); openPerf(link.dataset.user); }
});
$('perf-close').addEventListener('click', () => $('perf-modal').classList.add('hidden'));
$('perf-modal').addEventListener('click', (e) => { if (e.target.id === 'perf-modal') $('perf-modal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('perf-modal').classList.add('hidden'); });

async function openPerf(hrUsername, optContestId) {
  if (!hrUsername) return;
  const username = String(hrUsername).trim();
  const cid = optContestId || (document.querySelector('#tabs .tab.active')?.dataset.tab === 'daily' ? dailyContestId : selectedContestId);
  
  let dData = dashData;
  let dTopics = dashTopics;
  
  // If viewing a different contest from the one in dashData, load its dashboard
  if (cid && (!dData || String(selectedContestId) !== String(cid))) {
    try {
      const res = await api('/api/contest-dashboard/' + cid);
      dData = res.dashboard;
      dTopics = res.topics || {};
    } catch (e) {
      console.warn('Could not fetch contest dashboard:', e);
    }
  }

  const r = (dailyDataCache?.students || roster || []).find((x) => x.hrUsername && x.hrUsername.toLowerCase() === username.toLowerCase()) ||
            joinedRows().find((x) => x.hrUsername && x.hrUsername.toLowerCase() === username.toLowerCase()) ||
            { name: username, hrUsername: username };

  const u = dData?.users?.find((x) => x.username && x.username.toLowerCase() === username.toLowerCase());

  $('perf-title').textContent = r.name || username;
  $('perf-meta').innerHTML = [
    `@${esc(username)}`,
    r.registerNo && `Reg: ${esc(r.registerNo)}`,
    r.campus && esc(r.campus),
    r.department && esc(r.department),
    r.section && `Sec ${esc(r.section)}`,
    r.year && `Year ${esc(r.year)}`,
    r.email && esc(r.email),
  ].filter(Boolean).join(' · ');

  if (!dData || !u) {
    $('perf-stats').innerHTML = `<div class="stat"><div class="value">—</div><div class="label">No course data</div></div>`;
    $('perf-topics').innerHTML = `<p class="muted">${dData ? 'This student did not appear in the course scrape.' : 'No course synced yet for this college.'}</p>`;
    $('perf-table').innerHTML = '';
    $('perf-modal').classList.remove('hidden');
    return;
  }

  const totalQ = dData.summary.totalQuestions;
  const contestRank = dData.users.slice().sort((a, b) => b.computedScore - a.computedScore).findIndex((x) => x.username === u.username) + 1;
  $('perf-stats').innerHTML = [
    ['Solved', `${u.solved}/${totalQ}`],
    ['Score', u.computedScore],
    ['Completion', Math.round((u.solved / totalQ) * 100) + '%'],
    ['Attempted', u.attempted],
    ['Course rank', contestRank > 0 ? `#${contestRank}` : '—'],
  ].map(([l, v]) => `<div class="stat"><div class="value">${v}</div><div class="label">${l}</div></div>`).join('');

  // Per-topic breakdown (parsed from "Topic - Title")
  const topicMap = new Map();
  for (const q of dData.questions) {
    const t = dTopics[q.name] || splitTitle(q.name).tag || 'Other';
    if (!topicMap.has(t)) topicMap.set(t, { total: 0, solved: 0 });
    const e = topicMap.get(t); e.total++; if (u.questionStatus[q.name]?.solved) e.solved++;
  }
  $('perf-topics').innerHTML = `<div class="muted" style="margin-bottom:6px">By topic <span style="font-size:11px">(click a topic to filter the questions below)</span></div>` +
    Array.from(topicMap.entries()).map(([t, e]) => {
      const cls = e.solved === e.total ? 'solved' : e.solved > 0 ? 'attempted' : 'none';
      return `<span class="topic-tag" data-topic="${esc(t)}" style="cursor:pointer"><b>${esc(t)}</b> <span class="badge ${cls}">${e.solved}/${e.total}</span></span>`;
    }).join('');

  perfState = { u, dData, dTopics };
  perfTopicFilter = null;
  renderPerfTable();
  $('perf-modal').classList.remove('hidden');
}
let perfState = null, perfTopicFilter = null;
const perfTopicOf = (q) => (perfState?.dTopics && perfState.dTopics[q.name]) || splitTitle(q.name).tag || 'Other';
function renderPerfTable() {
  if (!perfState) return;
  const { u, dData } = perfState;
  const questions = dData?.questions || [];
  const rows = questions
    .filter((q) => !perfTopicFilter || perfTopicOf(q) === perfTopicFilter)
    .map((q) => ({ q, st: u.questionStatus[q.name] || { score: 0, points: q.points, solved: false, attempted: false } }));
  $('perf-table').innerHTML =
    `<thead><tr><th>#</th><th>Question</th><th>Status</th><th class="num">Score</th></tr></thead><tbody>` +
    (rows.length ? rows.map(({ q, st }, i) => {
      const cls = st.solved ? 'solved' : st.attempted ? 'attempted' : 'none';
      const txt = st.solved ? 'Solved' : st.attempted ? 'Attempted' : 'Not attempted';
      const url = questionUrl(q);
      const name = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(q.name)}</a>` : esc(q.name);
      return `<tr><td class="num">${i + 1}</td><td>${name}</td><td><span class="badge ${cls}">${txt}</span></td><td class="num">${st.score || 0} / ${q.points}</td></tr>`;
    }).join('') : `<tr><td colspan="4" class="muted">No questions in this topic.</td></tr>`) + `</tbody>`;
  // highlight the active topic tag
  document.querySelectorAll('#perf-topics .topic-tag').forEach((el) => el.classList.toggle('active-filter', el.dataset.topic === perfTopicFilter));
}
// Toggle topic filter when a topic tag is clicked (click again to clear).
$('perf-topics').addEventListener('click', (e) => {
  const tag = e.target.closest('.topic-tag[data-topic]'); if (!tag) return;
  perfTopicFilter = perfTopicFilter === tag.dataset.topic ? null : tag.dataset.topic;
  renderPerfTable();
});

// ---------- Sync (scrape) ----------
function syncContest() {
  if (!selectedContestId) return setStatus($('dash-status'), 'Add or select a course first.', 'err');
  const ct = dashContests.find((c) => String(c.id) === String(selectedContestId));
  if (!ct || !ct.slug) return setStatus($('dash-status'), 'This course has no link — delete and re-add it with a link.', 'err');
  $('sync-btn').disabled = true;
  $('dash-progress').classList.remove('hidden'); $('dash-prog-lab').textContent = 'Starting…'; $('dash-prog-fill').style.width = '0%';
  setStatus($('dash-status'), `Syncing ${ct.name}…`, 'info');
  const params = { adminToken, contestId: selectedContestId };
  if (hrToken) params.hrToken = hrToken;
  const es = new EventSource('/api/scrape-stream?' + new URLSearchParams(params));
  es.addEventListener('progress', (ev) => { const p = JSON.parse(ev.data); $('dash-prog-lab').textContent = p.phase === 'leaderboard' ? `Fetching leaderboard… ${p.completed}` : `${p.completed} / ${p.total} users`; $('dash-prog-fill').style.width = (p.total ? Math.round(p.completed / p.total * 100) : 8) + '%'; });
  es.addEventListener('done', (ev) => { es.close(); $('sync-btn').disabled = false; $('dash-prog-fill').style.width = '100%'; const d = JSON.parse(ev.data); setStatus($('dash-status'), `Synced — ${d.summary.totalUsers} users, ${d.summary.totalQuestions} questions.`, 'ok'); clearDashCache(selectedContestId); loadDashboard(); });
  es.addEventListener('failed', (ev) => {
    es.close(); $('sync-btn').disabled = false; $('dash-progress').classList.add('hidden');
    const err = JSON.parse(ev.data).error || 'Sync failed';
    setStatus($('dash-status'), err, 'err');
    if (!hrToken && (err.includes('Connect') || err.includes('HR_EMAIL'))) $('connect-modal').classList.remove('hidden');
  });
  es.onerror = () => { es.close(); $('sync-btn').disabled = false; };
}

// ---------- Sync ALL colleges / all contests ----------
$('sync-all-btn').addEventListener('click', syncAll);
function syncAll() {
  if (!confirm('Scrape every course in every college? This can take a long while.')) return;
  const btns = ['sync-btn', 'sync-all-btn'];
  btns.forEach((b) => { $(b).disabled = true; });
  $('dash-progress').classList.remove('hidden'); $('dash-prog-lab').textContent = 'Starting…'; $('dash-prog-fill').style.width = '0%';
  setStatus($('dash-status'), 'Syncing all colleges…', 'info');
  const done = [];
  const stop = () => { btns.forEach((b) => { $(b).disabled = false; }); };
  const params = { adminToken };
  if (hrToken) params.hrToken = hrToken;
  const es = new EventSource('/api/sync-all-stream?' + new URLSearchParams(params));
  es.addEventListener('start', (ev) => { const d = JSON.parse(ev.data); setStatus($('dash-status'), `Syncing ${d.total} course(s) across all colleges…`, 'info'); });
  es.addEventListener('contest', (ev) => {
    const p = JSON.parse(ev.data);
    $('dash-prog-lab').textContent = `(${p.index}/${p.total}) ${p.college} — ${p.name}: starting…`;
    $('dash-prog-fill').style.width = Math.round(((p.index - 1) / p.total) * 100) + '%';
  });
  es.addEventListener('progress', (ev) => {
    const p = JSON.parse(ev.data);
    $('dash-prog-lab').textContent = `(${p.index}/${p.total}) ${p.college} — ${p.name}: ${p.completed}/${p.totalUsers} users`;
    // Overall bar = contests finished + fraction of the current one.
    const frac = p.totalUsers ? Math.min(1, p.completed / p.totalUsers) : 0;
    $('dash-prog-fill').style.width = Math.round((((p.index - 1) + frac) / p.total) * 100) + '%';
  });
  es.addEventListener('contest-done', (ev) => {
    const p = JSON.parse(ev.data); done.push(`${p.college} / ${p.name}: ${p.users} users`);
    $('dash-prog-fill').style.width = Math.round((p.index / p.total) * 100) + '%';
  });
  es.addEventListener('contest-failed', (ev) => {
    const p = JSON.parse(ev.data); done.push(`⚠ ${p.college} / ${p.name}: ${p.error}`);
  });
  es.addEventListener('done', (ev) => {
    es.close(); stop(); $('dash-prog-fill').style.width = '100%';
    const d = JSON.parse(ev.data);
    const msg = `Synced ${d.ok} of ${d.total} course(s).` + (d.failures.length ? ` ${d.failures.length} failed.` : '');
    setStatus($('dash-status'), msg, d.failures.length ? 'err' : 'ok');
    if (d.failures.length) $('dash-prog-lab').textContent = 'Failed: ' + d.failures.join(' · ');
    else $('dash-prog-lab').textContent = 'All done.';
    clearDashCache(); // every contest may have changed
    loadDashboard();
  });
  es.addEventListener('failed', (ev) => { es.close(); stop(); $('dash-progress').classList.add('hidden'); setStatus($('dash-status'), JSON.parse(ev.data).error, 'err'); });
  es.onerror = () => { es.close(); stop(); };
}

// ---------- Boot ----------
if (adminToken) enterApp().catch(logout); else { $('login-screen').classList.remove('hidden'); }
