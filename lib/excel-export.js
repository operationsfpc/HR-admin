// Styled Excel (.xlsx) workbook generator using ExcelJS.
// Produces standardized multi-sheet completion reports for:
//   1. Single course   (buildCourseWorkbook)
//   2. Whole college / semester (buildCollegeWorkbook)
//   3. Single student  (buildStudentWorkbook)
import ExcelJS from 'exceljs';

const CAT_LABELS = {
  inclass: 'In-class',
  postclass: 'Post-class',
  challenges: 'Challenges',
};

const COLORS = {
  bannerFill: 'FF0F172A',
  bannerText: 'FFFFFFFF',
  headerFill: 'FF1E293B',
  headerText: 'FFFFFFFF',
  subHeaderFill: 'FFE2E8F0',
  subHeaderText: 'FF0F172A',
  zebraFill: 'FFF8FAFC',
  border: 'FFD1D5DB',
  solvedFill: 'FFDCFCE7',
  solvedText: 'FF166534',
  attemptedFill: 'FFFEF3C7',
  attemptedText: 'FF92400E',
  notAttemptedFill: 'FFFEE2E2',
  notAttemptedText: 'FF991B1B',
  mutedFill: 'FFF1F5F9',
  mutedText: 'FF64748B',
  linkText: 'FF1D4ED8',
};

const THIN_BORDER = {
  top: { style: 'thin', color: { argb: COLORS.border } },
  left: { style: 'thin', color: { argb: COLORS.border } },
  bottom: { style: 'thin', color: { argb: COLORS.border } },
  right: { style: 'thin', color: { argb: COLORS.border } },
};

function titleTag(name) {
  const m = String(name || '').split(/\s+[–—-]\s+/);
  return m.length >= 2 ? m[0].trim() : '';
}

function resolveTopic(topics, qName) {
  return (topics && topics[qName]) || titleTag(qName) || 'Other';
}

function formatCategory(code) {
  if (!code) return '—';
  return CAT_LABELS[code] || code;
}

function formatQuestionUrl(q) {
  const u = q && q.url;
  if (!u || u === '#') return '';
  return u.startsWith('http') ? u : 'https://www.hackerrank.com' + (u.startsWith('/') ? u : '/' + u);
}

function formatDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function safeCellText(text, maxLen = 32000) {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 20) + ' … (truncated)';
}

function safeSheetName(wb, raw) {
  const base = String(raw || 'Sheet')
    .replace(/[:\\/?*\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';
  let candidate = base;
  let idx = 2;
  while (wb.worksheets.some((w) => w.name.toLowerCase() === candidate.toLowerCase())) {
    const suffix = `_${idx++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  return candidate;
}

function semesterLabel(sem) {
  return sem && String(sem).trim() ? String(sem).trim() : 'Unassigned';
}

function courseTag(contest) {
  const parts = [contest.course, contest.studyYear, contest.semester, contest.subject].map((s) => String(s || '').trim()).filter(Boolean);
  if (parts.length) return parts.join(' · ');
  const sem = contest.semester ? `[${contest.semester}] ` : '';
  return `${sem}${contest.name || contest.slug || 'Course'}`;
}

function applyHeaderStyle(ws, headerRowNumber, colCount) {
  const row = ws.getRow(headerRowNumber);
  row.height = 24;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerFill } };
    cell.font = { bold: true, color: { argb: COLORS.headerText }, size: 10, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = THIN_BORDER;
  }
  ws.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  if (colCount > 0) {
    ws.autoFilter = {
      from: { row: headerRowNumber, column: 1 },
      to: { row: headerRowNumber, column: colCount },
    };
  }
}

function styleStatusCell(cell, status) {
  if (status === 'Solved' || String(status).startsWith('Solved')) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.solvedFill } };
    cell.font = { bold: true, color: { argb: COLORS.solvedText }, size: 10, name: 'Calibri' };
  } else if (status === 'Attempted' || String(status).startsWith('Attempted')) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.attemptedFill } };
    cell.font = { bold: true, color: { argb: COLORS.attemptedText }, size: 10, name: 'Calibri' };
  } else if (status === 'Not Attempted') {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.notAttemptedFill } };
    cell.font = { color: { argb: COLORS.notAttemptedText }, size: 10, name: 'Calibri' };
  } else {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.mutedFill } };
    cell.font = { color: { argb: COLORS.mutedText }, size: 10, name: 'Calibri' };
  }
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
}

function setHyperlink(cell, url, label) {
  if (!url) {
    cell.value = label || '';
    return;
  }
  cell.value = { text: label || url, hyperlink: url };
  cell.font = { color: { argb: COLORS.linkText }, underline: true, size: 10, name: 'Calibri' };
}

function styleDataRow(row, colCount, isAlt) {
  row.height = 19;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    if (!cell.font) cell.font = { size: 10, name: 'Calibri' };
    if (isAlt && !cell.fill) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebraFill } };
    }
    cell.border = THIN_BORDER;
    if (!cell.alignment) cell.alignment = { vertical: 'middle' };
  }
}

function autoFitColumns(ws, { minWidth = 10, maxWidth = 44, overrides = {} } = {}) {
  const colCount = ws.columnCount || 0;
  for (let c = 1; c <= colCount; c++) {
    if (overrides[c]) {
      ws.getColumn(c).width = overrides[c];
      continue;
    }
    let maxLen = minWidth;
    const col = ws.getColumn(c);
    col.eachCell({ includeEmpty: false }, (cell, rowNum) => {
      if (rowNum === 1 && ws.getRow(1).height >= 28) return; // ignore full-width title banner
      let v = cell.value;
      if (v && typeof v === 'object') v = v.text || v.result || '';
      const str = String(v ?? '');
      const longestLine = str.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
      if (longestLine + 3 > maxLen) maxLen = longestLine + 3;
    });
    col.width = Math.min(maxWidth, Math.max(minWidth, maxLen));
  }
}

function addTitleBanner(ws, title, subtitle, colSpan = 8) {
  const r1 = ws.addRow([title]);
  r1.height = 30;
  ws.mergeCells(1, 1, 1, Math.max(2, colSpan));
  const c1 = r1.getCell(1);
  c1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.bannerFill } };
  c1.font = { bold: true, color: { argb: COLORS.bannerText }, size: 14, name: 'Calibri' };
  c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  if (subtitle) {
    const r2 = ws.addRow([subtitle]);
    r2.height = 20;
    ws.mergeCells(2, 1, 2, Math.max(2, colSpan));
    const c2 = r2.getCell(1);
    c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subHeaderFill } };
    c2.font = { italic: true, color: { argb: COLORS.subHeaderText }, size: 10, name: 'Calibri' };
    c2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  }
  ws.addRow([]);
}

function indexUsersByKey(dash) {
  const m = new Map();
  for (const u of (dash?.users || [])) {
    const k = String(u.username || '').toLowerCase();
    if (k) m.set(k, u);
  }
  return m;
}

function computeTopicRows({ contest, dash, students, topics = {}, categories = {} }) {
  const questions = dash?.questions || [];
  const byUser = indexUsersByKey(dash);
  // Group questions by topic
  const topicGroups = new Map();
  for (const q of questions) {
    const t = resolveTopic(topics, q.name);
    if (!topicGroups.has(t)) topicGroups.set(t, []);
    topicGroups.get(t).push(q);
  }
  const rows = [];
  const sem = semesterLabel(contest.semester);
  const cName = contest.name || contest.slug || '';

  for (const s of students) {
    const uk = String(s.hrUsername || s.usernameKey || '').toLowerCase();
    const u = s.hrUsername ? byUser.get(uk) : null;
    for (const [topic, qs] of topicGroups.entries()) {
      const catCounts = {
        inclass: { s: 0, t: 0 },
        postclass: { s: 0, t: 0 },
        challenges: { s: 0, t: 0 },
      };
      let topicSolved = 0;
      for (const q of qs) {
        const cat = categories[q.name] || '';
        const isSolved = !!(u?.questionStatus?.[q.name]?.solved);
        if (isSolved) topicSolved++;
        if (catCounts[cat]) {
          catCounts[cat].t++;
          if (isSolved) catCounts[cat].s++;
        }
      }
      const pct = qs.length ? topicSolved / qs.length : 0;
      const fmtCat = (obj) => (obj.t ? `${obj.s}/${obj.t}` : '—');
      rows.push([
        sem,
        cName,
        s.name || '',
        s.registerNo || '',
        s.hrUsername || '',
        s.department || '',
        s.section || '',
        topic,
        fmtCat(catCounts.inclass),
        fmtCat(catCounts.postclass),
        fmtCat(catCounts.challenges),
        topicSolved,
        qs.length,
        pct,
      ]);
    }
  }
  return rows;
}

function addQuestionMatrixSheet(wb, sheetTitle, { dash, students, topics = {} }) {
  const ws = wb.addWorksheet(safeSheetName(wb, sheetTitle));
  const questions = dash?.questions || [];
  const byUser = indexUsersByKey(dash);
  const totalQ = questions.length;

  const fixedHeaders = ['S.No', 'Student Name', 'Register No', 'HackerRank Username', 'Department', 'Section', 'Solved', 'Total Qs', 'Completion %'];
  const qHeaders = questions.map((q) => {
    const t = resolveTopic(topics, q.name);
    return t && t !== 'Other' ? `[${t}] ${q.name}` : q.name;
  });
  const headers = [...fixedHeaders, ...qHeaders];
  ws.addRow(headers);
  applyHeaderStyle(ws, 1, headers.length);
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

  students.forEach((s, idx) => {
    const uk = String(s.hrUsername || s.usernameKey || '').toLowerCase();
    const u = s.hrUsername ? byUser.get(uk) : null;
    const solved = u ? Number(u.solved || 0) : 0;
    const pct = totalQ ? solved / totalQ : 0;

    const rowVals = [
      idx + 1,
      s.name || '',
      s.registerNo || '',
      s.hrUsername || '',
      s.department || '',
      s.section || '',
      solved,
      totalQ,
      pct,
    ];
    for (const q of questions) {
      const st = u?.questionStatus?.[q.name];
      if (st?.solved) rowVals.push(`Solved (${st.score ?? q.points ?? 0})`);
      else if (st?.attempted) rowVals.push(`Attempted (${st.score ?? 0})`);
      else rowVals.push('—');
    }
    const row = ws.addRow(rowVals);
    styleDataRow(row, headers.length, idx % 2 === 1);
    row.getCell(9).numFmt = '0%';
    for (let qi = 0; qi < questions.length; qi++) {
      const cell = row.getCell(fixedHeaders.length + 1 + qi);
      styleStatusCell(cell, cell.value);
    }
  });

  const overrides = { 1: 7, 2: 24, 3: 16, 4: 20, 5: 14, 6: 10, 7: 10, 8: 10, 9: 14 };
  for (let c = fixedHeaders.length + 1; c <= headers.length; c++) overrides[c] = 18;
  autoFitColumns(ws, { overrides });
}

function addQuestionDetailSheet(wb, coursesData, { onlyActiveIfHuge = true } = {}) {
  const ws = wb.addWorksheet(safeSheetName(wb, 'Question Detail'));
  const headers = [
    'Semester', 'Course', 'Student Name', 'Register No', 'HackerRank Username',
    'Department', 'Section', 'Year', 'Campus',
    'Topic', 'Category', 'Question Title', 'Question URL',
    'Max Points', 'Score Earned', 'Status', 'First Solved Date',
  ];
  ws.addRow(headers);
  applyHeaderStyle(ws, 1, headers.length);

  // Estimate row count to avoid exceeding Excel's 1,048,576 row limit.
  let estimated = 0;
  for (const cd of coursesData) {
    estimated += (cd.students?.length || 0) * (cd.dash?.questions?.length || 0);
  }
  const compactMode = onlyActiveIfHuge && estimated > 250000;
  let rowIdx = 0;

  for (const cd of coursesData) {
    const { contest, dash, students = [], topics = {}, categories = {}, firstSolvedMap } = cd;
    if (!dash) continue;
    const questions = dash.questions || [];
    const byUser = indexUsersByKey(dash);
    const sem = semesterLabel(contest.semester);
    const cName = contest.name || contest.slug || '';

    for (const s of students) {
      const uk = String(s.hrUsername || s.usernameKey || '').toLowerCase();
      const u = s.hrUsername ? byUser.get(uk) : null;
      for (const q of questions) {
        const st = u?.questionStatus?.[q.name] || { score: 0, points: q.points || 0, attempted: false, solved: false };
        const status = st.solved ? 'Solved' : st.attempted ? 'Attempted' : 'Not Attempted';
        if (compactMode && status === 'Not Attempted') continue;

        const qUrl = formatQuestionUrl(q);
        const fsIso = firstSolvedMap ? firstSolvedMap.get(`${uk}|${q.name}`) : '';
        const row = ws.addRow([
          sem,
          cName,
          s.name || '',
          s.registerNo || '',
          s.hrUsername || '',
          s.department || '',
          s.section || '',
          s.year || '',
          s.campus || '',
          resolveTopic(topics, q.name),
          formatCategory(categories[q.name]),
          q.name,
          qUrl,
          Number(st.points ?? q.points ?? 0),
          Number(st.score ?? 0),
          status,
          formatDate(fsIso),
        ]);
        styleDataRow(row, headers.length, rowIdx % 2 === 1);
        if (qUrl) setHyperlink(row.getCell(13), qUrl, 'Open Problem');
        styleStatusCell(row.getCell(16), status);
        rowIdx++;
      }
    }
  }

  autoFitColumns(ws, {
    maxWidth: 42,
    overrides: { 12: 36, 13: 16, 16: 16, 17: 16 },
  });
  return { rowCount: rowIdx, compactMode };
}

// =====================================================================
// 1. Single Course Workbook
// =====================================================================
export async function buildCourseWorkbook({
  collegeName = '',
  contest,
  dash,
  students = [],
  topics = {},
  categories = {},
  firstSolvedMap = new Map(),
  shareOrigin = '',
  filterSummary = '',
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HackerRank Admin Dashboard';
  wb.created = new Date();

  const questions = dash?.questions || [];
  const totalQ = questions.length;
  const byUser = indexUsersByKey(dash);
  const sem = semesterLabel(contest.semester);
  const shareUrl = contest.shareToken && shareOrigin ? `${shareOrigin}/view/${contest.shareToken}` : '';

  // Compute aggregates for overview
  let totalSolvedSum = 0;
  let totalScoreSum = 0;
  for (const s of students) {
    const u = s.hrUsername ? byUser.get(String(s.hrUsername).toLowerCase()) : null;
    if (u) {
      totalSolvedSum += Number(u.solved || 0);
      totalScoreSum += Number(u.computedScore || 0);
    }
  }
  const avgSolved = students.length ? +(totalSolvedSum / students.length).toFixed(2) : 0;
  const overallComp = students.length && totalQ ? totalSolvedSum / (students.length * totalQ) : 0;

  // ---------- Sheet 1: Overview ----------
  const wsOv = wb.addWorksheet('Overview');
  addTitleBanner(
    wsOv,
    `${collegeName || contest.college} — ${contest.name}`,
    `Semester: ${sem}  |  Generated: ${new Date().toLocaleString()}${filterSummary ? '  |  Filters: ' + filterSummary : ''}`,
    6
  );

  const metaRows = [
    ['College', collegeName || contest.college || ''],
    ['Course', contest.course || '—'],
    ['Year', contest.studyYear || '—'],
    ['Semester', sem],
    ['Subject', contest.subject || contest.name || ''],
    ['Status', contest.isArchived ? 'Archived' : 'Active'],
    ['Contest Slug', contest.slug || ''],
    ['HackerRank Contest Link', contest.contestUrl || ''],
    ['Dashboard Share Link', shareUrl || 'Not generated'],
    ['Total Students (in report)', students.length],
    ['Total Questions', totalQ],
    ['Average Questions Solved', avgSolved],
    ['Overall Completion %', overallComp],
  ];
  for (const [label, val] of metaRows) {
    const r = wsOv.addRow([label, val]);
    r.height = 20;
    r.getCell(1).font = { bold: true, size: 10, name: 'Calibri' };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subHeaderFill } };
    r.getCell(1).border = THIN_BORDER;
    r.getCell(2).font = { size: 10, name: 'Calibri' };
    r.getCell(2).border = THIN_BORDER;
    if (label === 'Overall Completion %') r.getCell(2).numFmt = '0.0%';
    if ((label === 'HackerRank Contest Link' || label === 'Dashboard Share Link') && String(val).startsWith('http')) {
      setHyperlink(r.getCell(2), val, val);
    }
  }

  // Topic summary table on Overview
  wsOv.addRow([]);
  const tHeadRowNum = wsOv.rowCount + 1;
  wsOv.addRow(['Topic', 'Questions', 'Total Solves (All Students)', 'Avg Solved / Student', 'Topic Completion %']);
  const tHeadRow = wsOv.getRow(tHeadRowNum);
  tHeadRow.height = 22;
  for (let c = 1; c <= 5; c++) {
    const cell = tHeadRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerFill } };
    cell.font = { bold: true, color: { argb: COLORS.headerText }, size: 10, name: 'Calibri' };
    cell.border = THIN_BORDER;
  }
  const topicMap = new Map();
  for (const q of questions) {
    const t = resolveTopic(topics, q.name);
    if (!topicMap.has(t)) topicMap.set(t, []);
    topicMap.get(t).push(q);
  }
  let tIdx = 0;
  for (const [topic, qs] of topicMap.entries()) {
    let solves = 0;
    for (const s of students) {
      const u = s.hrUsername ? byUser.get(String(s.hrUsername).toLowerCase()) : null;
      if (!u) continue;
      for (const q of qs) if (u.questionStatus?.[q.name]?.solved) solves++;
    }
    const denom = students.length * qs.length;
    const row = wsOv.addRow([
      topic,
      qs.length,
      solves,
      students.length ? +(solves / students.length).toFixed(2) : 0,
      denom ? solves / denom : 0,
    ]);
    styleDataRow(row, 5, tIdx++ % 2 === 1);
    row.getCell(5).numFmt = '0.0%';
  }
  autoFitColumns(wsOv, { overrides: { 1: 28, 2: 52, 3: 24, 4: 22, 5: 20 } });

  // ---------- Sheet 2: Student Summary ----------
  const wsSum = wb.addWorksheet('Student Summary');
  const sumHeaders = [
    'S.No', 'Student Name', 'Register No', 'HackerRank Username', 'Email',
    'Department', 'Section', 'Year', 'Campus', 'Semester', 'Course',
    'Solved', 'Attempted', 'Total Questions', 'Score', 'Completion %', 'Completed Questions',
  ];
  wsSum.addRow(sumHeaders);
  applyHeaderStyle(wsSum, 1, sumHeaders.length);

  students.forEach((s, idx) => {
    const uk = String(s.hrUsername || s.usernameKey || '').toLowerCase();
    const u = s.hrUsername ? byUser.get(uk) : null;
    const solved = u ? Number(u.solved || 0) : 0;
    const attempted = u ? Number(u.attempted || 0) : 0;
    const score = u ? Number(u.computedScore || 0) : 0;
    const pct = totalQ ? solved / totalQ : 0;
    const completedNames = questions
      .filter((q) => u?.questionStatus?.[q.name]?.solved)
      .map((q) => q.name);

    const row = wsSum.addRow([
      idx + 1,
      s.name || '',
      s.registerNo || '',
      s.hrUsername || '',
      s.email || '',
      s.department || '',
      s.section || '',
      s.year || '',
      s.campus || '',
      sem,
      contest.name || '',
      solved,
      attempted,
      totalQ,
      score,
      pct,
      safeCellText(completedNames.join(', ')),
    ]);
    styleDataRow(row, sumHeaders.length, idx % 2 === 1);
    row.getCell(16).numFmt = '0%';
  });
  autoFitColumns(wsSum, { overrides: { 1: 7, 17: 55 } });

  // ---------- Sheet 3: Topic & Category Summary ----------
  const wsTop = wb.addWorksheet('Topic & Category Summary');
  const topHeaders = [
    'Semester', 'Course', 'Student Name', 'Register No', 'HackerRank Username',
    'Department', 'Section', 'Topic',
    'In-class (Solved/Total)', 'Post-class (Solved/Total)', 'Challenges (Solved/Total)',
    'Topic Solved', 'Topic Total', 'Topic Completion %',
  ];
  wsTop.addRow(topHeaders);
  applyHeaderStyle(wsTop, 1, topHeaders.length);
  const tRows = computeTopicRows({ contest, dash, students, topics, categories });
  tRows.forEach((vals, idx) => {
    const row = wsTop.addRow(vals);
    styleDataRow(row, topHeaders.length, idx % 2 === 1);
    row.getCell(14).numFmt = '0%';
  });
  autoFitColumns(wsTop);

  // ---------- Sheet 4: Question Matrix ----------
  addQuestionMatrixSheet(wb, 'Question Matrix', { dash, students, topics });

  // ---------- Sheet 5: Question Detail ----------
  addQuestionDetailSheet(wb, [{ contest, dash, students, topics, categories, firstSolvedMap }]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// =====================================================================
// 2. College / Semester Multi-Course Workbook
// =====================================================================
export async function buildCollegeWorkbook({
  collegeName,
  collegeShareUrl = '',
  semesterFilter = '',
  coursesData = [],
  allStudents = [],
  shareOrigin = '',
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HackerRank Admin Dashboard';
  wb.created = new Date();

  const semHeading = semesterFilter || 'All Semesters';

  // Build unified student map (preferring allStudents, plus any student mapped in coursesData)
  const studentMap = new Map();
  const addStudentRec = (s) => {
    const key = String(s.usernameKey || s.hrUsername || s.id || '').toLowerCase();
    if (!key) return;
    if (!studentMap.has(key)) studentMap.set(key, s);
  };
  for (const s of allStudents) addStudentRec(s);
  for (const cd of coursesData) {
    for (const s of (cd.students || [])) addStudentRec(s);
  }
  const students = Array.from(studentMap.values()).sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''))
  );

  // ---------- Sheet 1: Overview ----------
  const wsOv = wb.addWorksheet('Overview');
  addTitleBanner(
    wsOv,
    `${collegeName} — Student Completion Report`,
    `Semester Scope: ${semHeading}  |  Courses: ${coursesData.length}  |  Students: ${students.length}  |  Generated: ${new Date().toLocaleString()}`,
    9
  );

  const infoPairs = [
    ['College Name', collegeName],
    ['Semester Scope', semHeading],
    ['College Dashboard Share Link', collegeShareUrl || 'Not generated'],
    ['Total Students', students.length],
    ['Total Courses Included', coursesData.length],
  ];
  for (const [k, v] of infoPairs) {
    const r = wsOv.addRow([k, v]);
    r.height = 20;
    r.getCell(1).font = { bold: true, size: 10, name: 'Calibri' };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subHeaderFill } };
    r.getCell(1).border = THIN_BORDER;
    r.getCell(2).font = { size: 10, name: 'Calibri' };
    r.getCell(2).border = THIN_BORDER;
    if (k === 'College Dashboard Share Link' && String(v).startsWith('http')) setHyperlink(r.getCell(2), v, v);
  }

  wsOv.addRow([]);
  const cHeadRowNum = wsOv.rowCount + 1;
  const cHeaders = [
    'S.No', 'Course', 'Year', 'Semester', 'Subject', 'Status', 'Slug',
    'HackerRank Contest URL', 'Course Share URL', 'Students', 'Total Questions', 'Avg Solved', 'Completion %',
  ];
  wsOv.addRow(cHeaders);
  const cHeadRow = wsOv.getRow(cHeadRowNum);
  cHeadRow.height = 22;
  for (let c = 1; c <= cHeaders.length; c++) {
    const cell = cHeadRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerFill } };
    cell.font = { bold: true, color: { argb: COLORS.headerText }, size: 10, name: 'Calibri' };
    cell.border = THIN_BORDER;
  }

  coursesData.forEach((cd, idx) => {
    const ct = cd.contest;
    const dash = cd.dash;
    const stList = cd.students || [];
    const totalQ = dash?.questions?.length || 0;
    const byUser = indexUsersByKey(dash);
    let solves = 0;
    for (const s of stList) {
      const u = s.hrUsername ? byUser.get(String(s.hrUsername).toLowerCase()) : null;
      if (u) solves += Number(u.solved || 0);
    }
    const avg = stList.length ? +(solves / stList.length).toFixed(2) : 0;
    const comp = stList.length && totalQ ? solves / (stList.length * totalQ) : 0;
    const shareUrl = ct.shareToken && shareOrigin ? `${shareOrigin}/view/${ct.shareToken}` : '';

    const row = wsOv.addRow([
      idx + 1,
      ct.course || '—',
      ct.studyYear || '—',
      semesterLabel(ct.semester),
      ct.subject || ct.name || '',
      ct.isArchived ? 'Archived' : 'Active',
      ct.slug || '',
      ct.contestUrl || '',
      shareUrl || 'Not generated',
      stList.length,
      totalQ,
      avg,
      comp,
    ]);
    styleDataRow(row, cHeaders.length, idx % 2 === 1);
    if (ct.contestUrl && String(ct.contestUrl).startsWith('http')) setHyperlink(row.getCell(8), ct.contestUrl, ct.contestUrl);
    if (shareUrl) setHyperlink(row.getCell(9), shareUrl, shareUrl);
    row.getCell(13).numFmt = '0.0%';
  });
  autoFitColumns(wsOv, { overrides: { 1: 7, 2: 24, 3: 12, 4: 12, 5: 18, 8: 38, 9: 38 } });

  // ---------- Sheet 2: Student Summary (Consolidated across semesters/courses) ----------
  const wsSum = wb.addWorksheet('Student Summary');
  const scrapedCourses = coursesData.filter((cd) => cd.dash);
  const dynamicCols = [];
  for (const cd of scrapedCourses) {
    const label = courseTag(cd.contest);
    dynamicCols.push(`${label} (Solved/Total)`, `${label} %`);
  }
  const sumHeaders = [
    'S.No', 'Student Name', 'Register No', 'HackerRank Username', 'Email',
    'Department', 'Section', 'Year', 'Campus',
    ...dynamicCols,
    'Total Solved', 'Total Attempted', 'Total Questions', 'Total Score', 'Overall Completion %', 'Completed Questions',
  ];
  wsSum.addRow(sumHeaders);
  applyHeaderStyle(wsSum, 1, sumHeaders.length);

  // Pre-index each course's student membership and scrape users
  const courseLookups = scrapedCourses.map((cd) => ({
    contest: cd.contest,
    questions: cd.dash.questions || [],
    byUser: indexUsersByKey(cd.dash),
    memberKeys: new Set((cd.students || []).map((s) => String(s.usernameKey || s.hrUsername || '').toLowerCase())),
  }));

  students.forEach((s, idx) => {
    const uk = String(s.usernameKey || s.hrUsername || '').toLowerCase();
    const hrKey = String(s.hrUsername || '').toLowerCase();
    let grandSolved = 0, grandAttempted = 0, grandTotalQ = 0, grandScore = 0;
    const completedAll = [];
    const perCourseCells = [];

    for (const cl of courseLookups) {
      const enrolled = cl.memberKeys.has(uk) || (hrKey && cl.memberKeys.has(hrKey));
      const u = hrKey ? cl.byUser.get(hrKey) : null;
      const totalQ = cl.questions.length;
      if (!enrolled && !u) {
        perCourseCells.push('N/A', null);
        continue;
      }
      const solved = u ? Number(u.solved || 0) : 0;
      const attempted = u ? Number(u.attempted || 0) : 0;
      const score = u ? Number(u.computedScore || 0) : 0;
      grandSolved += solved;
      grandAttempted += attempted;
      grandTotalQ += totalQ;
      grandScore += score;
      perCourseCells.push(`${solved}/${totalQ}`, totalQ ? solved / totalQ : 0);

      if (u) {
        for (const q of cl.questions) {
          if (u.questionStatus?.[q.name]?.solved) {
            completedAll.push(`${courseTag(cl.contest)}: ${q.name}`);
          }
        }
      }
    }

    const overallPct = grandTotalQ ? grandSolved / grandTotalQ : 0;
    const rowVals = [
      idx + 1,
      s.name || '',
      s.registerNo || '',
      s.hrUsername || '',
      s.email || '',
      s.department || '',
      s.section || '',
      s.year || '',
      s.campus || '',
      ...perCourseCells,
      grandSolved,
      grandAttempted,
      grandTotalQ,
      grandScore,
      overallPct,
      safeCellText(completedAll.join('; ')),
    ];
    const row = wsSum.addRow(rowVals);
    styleDataRow(row, sumHeaders.length, idx % 2 === 1);
    // Format dynamic % columns
    for (let ci = 0; ci < scrapedCourses.length; ci++) {
      const pctCol = 10 + ci * 2 + 1;
      if (row.getCell(pctCol).value !== null) row.getCell(pctCol).numFmt = '0%';
    }
    const overallPctCol = 10 + scrapedCourses.length * 2 + 4;
    row.getCell(overallPctCol).numFmt = '0%';
  });
  autoFitColumns(wsSum, { overrides: { 1: 7, [sumHeaders.length]: 55 } });

  // ---------- Sheet 3: Topic & Category Summary ----------
  const wsTop = wb.addWorksheet('Topic & Category Summary');
  const topHeaders = [
    'Semester', 'Course', 'Student Name', 'Register No', 'HackerRank Username',
    'Department', 'Section', 'Topic',
    'In-class (Solved/Total)', 'Post-class (Solved/Total)', 'Challenges (Solved/Total)',
    'Topic Solved', 'Topic Total', 'Topic Completion %',
  ];
  wsTop.addRow(topHeaders);
  applyHeaderStyle(wsTop, 1, topHeaders.length);
  let topRowIdx = 0;
  for (const cd of scrapedCourses) {
    const tRows = computeTopicRows(cd);
    for (const vals of tRows) {
      const row = wsTop.addRow(vals);
      styleDataRow(row, topHeaders.length, topRowIdx++ % 2 === 1);
      row.getCell(14).numFmt = '0%';
    }
  }
  autoFitColumns(wsTop);

  // ---------- Sheet 4+: Per-Course Question Matrix (up to 10 courses) ----------
  if (scrapedCourses.length <= 10) {
    for (const cd of scrapedCourses) {
      const prefix = cd.contest.semester ? `${cd.contest.semester} ` : '';
      addQuestionMatrixSheet(wb, `Matrix - ${prefix}${cd.contest.name}`, {
        dash: cd.dash,
        students: cd.students || [],
        topics: cd.topics || {},
      });
    }
  }

  // ---------- Final Sheet: Question Detail ----------
  const detailMeta = addQuestionDetailSheet(wb, scrapedCourses);
  if (detailMeta.compactMode) {
    wsOv.addRow([]);
    const noteRow = wsOv.addRow(['Note', 'Question Detail sheet contains Solved and Attempted records only because the full student × question grid exceeded 250,000 rows.']);
    noteRow.getCell(1).font = { bold: true, color: { argb: COLORS.attemptedText } };
    noteRow.getCell(2).font = { italic: true, color: { argb: COLORS.attemptedText } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// =====================================================================
// 3. Individual Student Transcript Workbook (All Semesters & Courses)
// =====================================================================
export async function buildStudentWorkbook({
  student,
  coursesData = [],
  shareOrigin = '',
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'HackerRank Admin Dashboard';
  wb.created = new Date();

  const hrKey = String(student.hrUsername || student.usernameKey || '').toLowerCase();

  let grandSolved = 0, grandAttempted = 0, grandTotalQ = 0, grandScore = 0;
  const courseSummaries = [];
  const completedRows = [];
  const topicRows = [];
  const allDetailRows = [];

  for (const cd of coursesData) {
    const { contest, dash, topics = {}, categories = {}, firstSolvedMap } = cd;
    const sem = semesterLabel(contest.semester);
    const cName = contest.name || contest.slug || '';
    const questions = dash?.questions || [];
    const byUser = indexUsersByKey(dash);
    const u = hrKey ? byUser.get(hrKey) : null;

    const solved = u ? Number(u.solved || 0) : 0;
    const attempted = u ? Number(u.attempted || 0) : 0;
    const score = u ? Number(u.computedScore || 0) : 0;
    const totalQ = questions.length;
    grandSolved += solved;
    grandAttempted += attempted;
    grandTotalQ += totalQ;
    grandScore += score;

    courseSummaries.push({
      semester: sem,
      courseName: cName,
      status: contest.isArchived ? 'Archived' : 'Active',
      solved,
      attempted,
      totalQ,
      score,
      pct: totalQ ? solved / totalQ : 0,
      contestUrl: contest.contestUrl || '',
      shareUrl: contest.shareToken && shareOrigin ? `${shareOrigin}/view/${contest.shareToken}` : '',
    });

    if (dash) {
      const tRows = computeTopicRows({ contest, dash, students: [student], topics, categories });
      for (const tr of tRows) topicRows.push(tr);

      for (const q of questions) {
        const st = u?.questionStatus?.[q.name] || { score: 0, points: q.points || 0, attempted: false, solved: false };
        const status = st.solved ? 'Solved' : st.attempted ? 'Attempted' : 'Not Attempted';
        const qUrl = formatQuestionUrl(q);
        const fsIso = firstSolvedMap ? firstSolvedMap.get(`${hrKey}|${q.name}`) : '';
        const topic = resolveTopic(topics, q.name);
        const cat = formatCategory(categories[q.name]);

        const detailRec = {
          sem, cName, topic, cat, qName: q.name, qUrl,
          points: Number(st.points ?? q.points ?? 0),
          score: Number(st.score ?? 0),
          status,
          firstSolved: formatDate(fsIso),
        };
        allDetailRows.push(detailRec);
        if (st.solved) completedRows.push(detailRec);
      }
    }
  }

  // ---------- Sheet 1: Student Overview ----------
  const wsOv = wb.addWorksheet('Student Overview');
  addTitleBanner(
    wsOv,
    `${student.name || student.hrUsername} — Complete Progress Report`,
    `College: ${student.college || ''}  |  HR Username: @${student.hrUsername || '—'}  |  Generated: ${new Date().toLocaleString()}`,
    8
  );

  const profileRows = [
    ['Student Name', student.name || ''],
    ['Register Number', student.registerNo || '—'],
    ['HackerRank Username', student.hrUsername || '—'],
    ['Email', student.email || '—'],
    ['College', student.college || '—'],
    ['Department / Section', [student.department, student.section].filter(Boolean).join(' - ') || '—'],
    ['Year / Campus', [student.year, student.campus].filter(Boolean).join(' · ') || '—'],
    ['Courses Enrolled', coursesData.length],
    ['Total Questions Solved', `${grandSolved} / ${grandTotalQ}`],
    ['Total Questions Attempted', grandAttempted],
    ['Total Score', grandScore],
    ['Overall Completion %', grandTotalQ ? grandSolved / grandTotalQ : 0],
  ];
  for (const [label, val] of profileRows) {
    const r = wsOv.addRow([label, val]);
    r.height = 20;
    r.getCell(1).font = { bold: true, size: 10, name: 'Calibri' };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.subHeaderFill } };
    r.getCell(1).border = THIN_BORDER;
    r.getCell(2).font = { size: 10, name: 'Calibri' };
    r.getCell(2).border = THIN_BORDER;
    if (label === 'Overall Completion %') r.getCell(2).numFmt = '0.0%';
  }

  wsOv.addRow([]);
  const csHeadNum = wsOv.rowCount + 1;
  const csHeaders = ['S.No', 'Semester', 'Course', 'Status', 'Solved', 'Attempted', 'Total Qs', 'Score', 'Completion %', 'Contest Link'];
  wsOv.addRow(csHeaders);
  const csHeadRow = wsOv.getRow(csHeadNum);
  csHeadRow.height = 22;
  for (let c = 1; c <= csHeaders.length; c++) {
    const cell = csHeadRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerFill } };
    cell.font = { bold: true, color: { argb: COLORS.headerText }, size: 10, name: 'Calibri' };
    cell.border = THIN_BORDER;
  }
  courseSummaries.forEach((cs, idx) => {
    const row = wsOv.addRow([
      idx + 1, cs.semester, cs.courseName, cs.status,
      cs.solved, cs.attempted, cs.totalQ, cs.score, cs.pct, cs.contestUrl,
    ]);
    styleDataRow(row, csHeaders.length, idx % 2 === 1);
    row.getCell(9).numFmt = '0%';
    if (cs.contestUrl && cs.contestUrl.startsWith('http')) setHyperlink(row.getCell(10), cs.contestUrl, 'Open Contest');
  });
  autoFitColumns(wsOv, { overrides: { 1: 26, 2: 34, 3: 26, 10: 18 } });

  // ---------- Sheet 2: Completed Questions ----------
  const wsComp = wb.addWorksheet('Completed Questions');
  const compHeaders = ['S.No', 'Semester', 'Course', 'Topic', 'Category', 'Question Title', 'Score Earned', 'Max Points', 'First Solved Date', 'Question URL'];
  wsComp.addRow(compHeaders);
  applyHeaderStyle(wsComp, 1, compHeaders.length);
  completedRows.forEach((d, idx) => {
    const row = wsComp.addRow([
      idx + 1, d.sem, d.cName, d.topic, d.cat, d.qName, d.score, d.points, d.firstSolved, d.qUrl,
    ]);
    styleDataRow(row, compHeaders.length, idx % 2 === 1);
    if (d.qUrl) setHyperlink(row.getCell(10), d.qUrl, 'Open Problem');
  });
  autoFitColumns(wsComp, { overrides: { 1: 7, 6: 38, 10: 16 } });

  // ---------- Sheet 3: Topic & Category Summary ----------
  const wsTop = wb.addWorksheet('Topic & Category Summary');
  const topHeaders = [
    'Semester', 'Course', 'Student Name', 'Register No', 'HackerRank Username',
    'Department', 'Section', 'Topic',
    'In-class (Solved/Total)', 'Post-class (Solved/Total)', 'Challenges (Solved/Total)',
    'Topic Solved', 'Topic Total', 'Topic Completion %',
  ];
  wsTop.addRow(topHeaders);
  applyHeaderStyle(wsTop, 1, topHeaders.length);
  topicRows.forEach((vals, idx) => {
    const row = wsTop.addRow(vals);
    styleDataRow(row, topHeaders.length, idx % 2 === 1);
    row.getCell(14).numFmt = '0%';
  });
  autoFitColumns(wsTop);

  // ---------- Sheet 4: All Questions Detail ----------
  const wsAll = wb.addWorksheet('All Questions Detail');
  const allHeaders = [
    'S.No', 'Semester', 'Course', 'Topic', 'Category',
    'Question Title', 'Max Points', 'Score Earned', 'Status', 'First Solved Date', 'Question URL',
  ];
  wsAll.addRow(allHeaders);
  applyHeaderStyle(wsAll, 1, allHeaders.length);
  allDetailRows.forEach((d, idx) => {
    const row = wsAll.addRow([
      idx + 1, d.sem, d.cName, d.topic, d.cat,
      d.qName, d.points, d.score, d.status, d.firstSolved, d.qUrl,
    ]);
    styleDataRow(row, allHeaders.length, idx % 2 === 1);
    styleStatusCell(row.getCell(9), d.status);
    if (d.qUrl) setHyperlink(row.getCell(11), d.qUrl, 'Open Problem');
  });
  autoFitColumns(wsAll, { overrides: { 1: 7, 6: 38, 9: 16, 11: 16 } });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
