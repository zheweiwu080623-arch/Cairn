const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const DB = {
  tasks: [], events: [], notifications: [], codex: null, codex_home: null,
  connectors: { meta: [], configs: [], counts: {} },
  courses: [], academic: [], auto_sync: null, pending: [], server_time: 0,
  habits: [], habit_logs: [], focus: [], milestones: [], insights: null,
  music: { dir: '', tracks: [], scanned_at: 0 },
  health: null,
};
const WEEK_DAYS = ['一', '二', '三', '四', '五', '六', '日'];
const COLORS = ['#4f7cff', '#3ecf8e', '#ffd166', '#ff6b6b', '#b58cff', '#ff9f43', '#20c8d0'];

// taskSort：任务列表的顺序，两种（测试反馈 v，2026-09-25 新增）——
//   smart = 智能（默认，就是原来的行为）：没做完的排前面，做完的沉到最后，组内按截止时间；
//   due   = 时间优先：严格按截止时间排，做完的也留在原位（方便回看"这一周到底排了什么"）。
// 跟着浏览器记住选择（与 planner-lang / planner-os-notify 同一套做法）。
let state = {
  tab: 'hub', taskFilter: 'all',
  taskSort: (() => { try { return localStorage.getItem('planner-task-sort') === 'due' ? 'due' : 'smart'; } catch { return 'smart'; } })(),
  // follow = 是否"跟着今天走"：默认跟着（跨天/跨月会自动翻页）；用户手动翻页后停下来，
  // 点「今天」重新跟随（2026-09-27 加 —— 之前根本没有翻页按钮，也没有自动翻页）。
  sched: { level: 'month', cursor: null, dayMode: 'list', follow: true },
};

// ---------------- API ----------------
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function refresh() {
  const data = await api('GET', '/api/state');
  Object.assign(DB, data);
  // 显示名以服务端为准（作者本机是 data/brand.json 里的名字；别人 clone 默认 Cairn）
  if (data.brand && data.brand.app_name) {
    APP_TITLE = data.brand.app_name;
    if (typeof document !== 'undefined') document.title = APP_TITLE;
    const bn = document.getElementById('app-name-brand'); if (bn) bn.textContent = APP_TITLE;
    const bw = document.getElementById('app-name-wb'); if (bw) bw.textContent = APP_TITLE;
  }
  render();
  // 服务重启/网络抖动之后，当前这一页可能停在"空壳"上（模块挂载失败或取数没回来）——
  // 每次刷新顺手补挂一次（2026-09-26：用户看到"能力搭建/数据源是空的"，就是重启窗口里挂的）。
  try {
    const tab = state.tab;
    if (tab && tab !== 'hub') {
      const box = document.getElementById('module-' + tab);
      if (box && !box.innerHTML.trim()) mountGadgets(tab).catch(() => {});
      if (tab === 'settings') {
        const host = document.querySelector('#set-sources-host');
        const src = document.getElementById('view-connectors');
        if (host && (!src || !src.innerHTML.trim())) { try { renderConnectors(); } catch { /* ignore */ } if (src && src.parentElement !== host) host.appendChild(src); }
      }
    }
  } catch { /* 补挂失败不影响主流程 */ }
  runConflictSweep().catch(() => {}); // 检测时间冲突并自动调整(日程不动,顺延任务)
}

// 设置页要"寄存"数据源那一块：给它一个入口（模块里不直接依赖主程序的内部函数名）
window.__cairnRenderConnectors = () => { try { renderConnectors(); } catch { /* ignore */ } };

// ---------------- Date helpers ----------------
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDT = (iso) => {
  if (!iso) return '';
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
};
const fmtFull = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${fmtTime(iso)}`;
};
const isToday = (iso) => dayKey(iso) === dayKey(new Date().toISOString());
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const relative = (iso) => {
  if (!iso) return '';
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const span = mins < 60 ? `${mins}分钟` : hrs < 24 ? `${hrs}小时` : `${days}天`;
  return diff > 0 ? `还有${span}` : `已过${span}`;
};

// ---- Schedule helpers ----
const dateKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekdayIndex = (d) => (d.getDay() + 6) % 7; // 0=Mon .. 6=Sun
const mondayOf = (d) => {
  const r = new Date(d); r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - weekdayIndex(r));
  return r;
};
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const addMonths = (d, n) => { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; };
const fmtCn = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月`;
const fmtCnFull = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEK_DAYS[weekdayIndex(d)]}`;
const hm12 = (s) => {
  // "HH:MM" -> "08:30"
  if (!s) return '';
  const [h, m] = s.split(':');
  return `${pad(+h)}:${m}`;
};

// ---------------- 时间冲突检测与自动调整 ----------------
// 冲突定义(保守,避免误动):
//   · 指定了"时刻"的任务 与 日程(约定) 时间重叠 → 冲突:自动把任务顺延到该日程之后;
//   · 两个日程彼此重叠                          → 冲突:只提示,约定不自动移动;
//   · 仅有日期(无时刻)的任务、以及任务之间      → 不算冲突(多项待办可同处一个时刻)。
const TASK_BLOCK_MIN = 60;
let conflictIds = new Set();       // 当前仍存在冲突的条目 "kind:id"
let autoAdjusting = false;

// 截止时间规则（纯日期 = 当天 23:59 结束）。副本与 lib/duedate.mjs、
// public/viewmodel.js 逐字相同，由 tests/duedate.test.mjs 强制一致。
// #region due-rule — single source of truth, keep byte-identical in:
//   lib/duedate.mjs · public/app.js · public/viewmodel.js
const DUE_END_OF_DAY = { hour: 23, minute: 59, second: 59, ms: 999 };
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function hasTimeOfDay(value) {
  return typeof value === 'string' && value.includes('T');
}

function dueMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const plain = PLAIN_DATE.exec(text);
  if (plain && !hasTimeOfDay(text)) {
    return new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]),
      DUE_END_OF_DAY.hour, DUE_END_OF_DAY.minute, DUE_END_OF_DAY.second, DUE_END_OF_DAY.ms).getTime();
  }
  const parsed = new Date(text).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function isOverdue(value, nowMs) {
  const t = dueMs(value);
  return t !== null && t < nowMs;
}

function dueDayKey(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim();
  if (PLAIN_DATE.test(text)) return text;
  const t = dueMs(text);
  if (t === null) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dueLabel(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim();
  if (PLAIN_DATE.test(text)) return `${text} 当天截止`;
  const t = dueMs(text);
  if (t === null) return text;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// #endregion due-rule

const hasTime = (s) => hasTimeOfDay(s); // "2026-09-20T09:00" vs 纯日期

function timeBlocks() {
  const out = [];
  for (const e of DB.events || []) {
    const s = new Date(e.start_at); if (isNaN(s)) continue;
    const en = e.end_at ? new Date(e.end_at) : new Date(s.getTime() + 60 * 60000);
    out.push({ kind: 'event', id: e.id, title: e.title, start: s, end: en, ref: e });
  }
  for (const t of DB.tasks || []) {
    if (t.status === 'done' || !hasTime(t.due_at)) continue; // 只有指定"时刻"的任务才参与检测
    const s = new Date(t.due_at); if (isNaN(s)) continue;
    out.push({ kind: 'task', id: t.id, title: t.title, start: s, end: new Date(s.getTime() + TASK_BLOCK_MIN * 60000), ref: t });
  }
  return out;
}
function blocksOverlap(a, b) {
  return dayKey(a.start) === dayKey(b.start) && a.start < b.end && b.start < a.end;
}
// 只返回"任务×日程"与"日程×日程"两类冲突(不含任务×任务)。
function findConflicts(blocks) {
  const list = blocks || timeBlocks();
  const events = list.filter((b) => b.kind === 'event');
  const tasks = list.filter((b) => b.kind === 'task');
  const pairs = [];
  for (const t of tasks) for (const e of events) if (blocksOverlap(t, e)) pairs.push([t, e]);
  for (let i = 0; i < events.length; i++) for (let j = i + 1; j < events.length; j++) if (blocksOverlap(events[i], events[j])) pairs.push([events[i], events[j]]);
  return pairs;
}
function roundUpTo(d, stepMin = 30) {
  const r = new Date(d); r.setSeconds(0, 0);
  const add = (stepMin - (r.getMinutes() % stepMin)) % stepMin;
  r.setMinutes(r.getMinutes() + add);
  return r;
}
function recomputeConflicts() {
  conflictIds = new Set();
  for (const [a, b] of findConflicts()) { conflictIds.add(a.kind + ':' + a.id); conflictIds.add(b.kind + ':' + b.id); }
  return conflictIds;
}
const isConflict = (kind, id) => conflictIds.has(kind + ':' + id);
const isConflictingEvent = (ev) => isConflict('event', ev.id);
const fmtSize = (b) => {
  if (!b && b !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let n = b; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 0 && n < 10 ? 1 : 0)}${u[i]}`;
};

// 把与"日程"时间重叠的任务,顺延到该日程之后(四舍五入到 30 分)。日程(约定)保持不动。
async function autoAdjustConflicts() {
  const moves = [];
  for (let guard = 0; guard < 60; guard++) {
    const blocks = timeBlocks();
    const events = blocks.filter((b) => b.kind === 'event');
    let pick = null; let end = null;
    for (const t of blocks.filter((b) => b.kind === 'task')) {
      let eEnd = null;
      for (const e of events) if (blocksOverlap(t, e)) eEnd = eEnd ? new Date(Math.max(eEnd, e.end)) : e.end;
      if (eEnd) { pick = t; end = eEnd; break; }
    }
    if (!pick) break; // 没有"任务撞日程"的冲突了
    let ns = roundUpTo(end);
    if (ns.getHours() >= 23) { ns = new Date(ns); ns.setDate(ns.getDate() + 1); ns.setHours(9, 0, 0, 0); }
    const to = localDT(ns);
    if (to === pick.ref.due_at) break;
    moves.push({ id: pick.id, title: pick.title, from: pick.ref.due_at, to });
    pick.ref.due_at = to; // 本地即时更新,便于下一轮重新检测
  }
  for (const m of moves) { try { await api('PATCH', `/api/tasks/${m.id}`, { due_at: m.to }); } catch {} }
  return moves;
}

// 自动整理一次:有冲突就调整,并刷新冲突标记;返回调整条数。
async function runConflictSweep(manual = false) {
  if (autoAdjusting) return 0;
  autoAdjusting = true;
  try {
    const moves = findConflicts().length ? await autoAdjustConflicts() : [];
    recomputeConflicts();
    if (moves.length) {
      render();
      toast(`已自动调整 ${moves.length} 个时间冲突的任务`, 'green');
    } else if (manual) {
      renderCalendar();
    }
    return moves.length;
  } finally { autoAdjusting = false; }
}

// 在日历视图顶部提示"仍无法自动解决"的冲突(主要是日程 vs 日程)。
function renderConflictBanner(el) {
  el.querySelector('.conflict-banner')?.remove();
  recomputeConflicts();
  const hard = findConflicts().filter(([a, b]) => a.kind === 'event' && b.kind === 'event');
  if (!hard.length) return;
  const box = document.createElement('div');
  box.className = 'conflict-banner';
  box.innerHTML = `⚠ 检测到 ${hard.length} 处时间冲突（日程为固定安排,未自动移动）:` +
    hard.map(([a, b]) => `<div class="cf-line">· 「${esc(a.title)}」与「${esc(b.title)}」在 ${fmtDate(a.start)} ${fmtTime(a.start)}–${fmtTime(a.end)} 重叠</div>`).join('') +
    `<div class="cf-hint">可点上方「🔀 整理冲突」自动顺延任务,或手动调整其中之一。</div>`;
  const bar = el.querySelector('.sched-top');
  if (bar) bar.after(box); else el.prepend(box);
}

// Determine the current week number of a term (past week number) for course `weeks` filtering.
function termStart() {
  const terms = DB.academic.filter((a) => a.kind === 'term');
  if (terms.length) return terms.reduce((a, b) => new Date(a.start_at) < new Date(b.start_at) ? a : b);
  return null;
}
function weekNumberOf(date) {
  const ts = termStart();
  const base = ts ? mondayOf(new Date(ts.start_at)) : null;
  const monday = mondayOf(date);
  if (!base) return null;
  return Math.floor((monday - base) / (7 * 86400000)) + 1;
}
function semWeekLabel(date) {
  const n = weekNumberOf(date);
  if (n == null) return '—';
  if (n < 1) return '学期前';
  return `学期第${n}周`;
}
// Some academic titles carry a week marker (e.g. "2026秋 · 开学（学期第1周）").
// Recompute that marker for the given date so every day shows the real semester
// week (matching the left rail) instead of the week baked into the event title.
function acadLabel(a, date) {
  let title = (a.title || '').replace(/\s*[（(]学期第\s*\d+\s*周[)）]\s*$/u, '');
  if (a.kind === 'term') {
    const n = weekNumberOf(date);
    if (n != null && n >= 1) title = `${title}（学期第${n}周）`;
  }
  return title;
}
function courseInWeek(course, monday) {
  if (!course.weeks) return true;
  const wn = weekNumberOf(monday);
  if (wn == null) return true; // no term yet -> assume applies
  for (const part of course.weeks.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const s = +m[1]; const e = m[2] ? +m[2] : s;
    if (wn >= s && wn <= e) return true;
  }
  return false;
}
function eventsOn(key) { return DB.events.filter((e) => dayKey(e.start_at) === key); }
function tasksOn(key) { return DB.tasks.filter((t) => t.due_at && dueDayKey(t.due_at) === key); }
function notifsOn(key) { return DB.notifications.filter((n) => n.trigger_at && dayKey(n.trigger_at) === key); }
function academicOn(key) {
  return DB.academic.filter((a) => {
    const s = dayKey(a.start_at); const e = a.end_at ? dayKey(a.end_at) : s;
    return key >= s && key <= e;
  });
}
function coursesOnWeekday(wd, monday) {
  return DB.courses.filter((c) => c.weekday === (wd + 1) && courseInWeek(c, monday));
}
function courseForDay(date) { return coursesOnWeekday(weekdayIndex(date), date); }
function termIndex() {
  const ts = termStart();
  return ts ? `${dateKeyOf(new Date(ts.start_at))} 起第 ${weekNumberOf(new Date()) || 1} 周` : '尚未设置校历';
}

function nextNotif(n) {
  if (!n.enabled) return '已停用';
  if (n.repeat && n.repeat !== 'none') return `每${({ daily: '天', hourly: '小时', weekly: '周', monthly: '月' })[n.repeat] || ''} · ${relative(n.trigger_at)}`;
  if (n.last_fired_at) return `已触发 ${fmtDT(n.last_fired_at)}`;
  return relative(n.trigger_at);
}

// ---------------- Icons / pills ----------------
const PRI = { 0: { t: '紧急', c: 'p0' }, 1: { t: '高', c: 'p1' }, 2: { t: '中', c: 'p2' }, 3: { t: '低', c: 'p3' } };
const pill = (text, cls) => `<span class="pill ${cls || ''}">${text}</span>`;

// ---------------- Render ----------------
const MODULES = [
  { tab: 'today', ico: '◇', name: '今日', en: 'TODAY', sub: '总览', ensub: 'OVERVIEW' },
  { tab: 'calendar', ico: '▦', name: '日程', en: 'CALENDAR', sub: '月 · 周 · 日', ensub: 'MONTH · WEEK · DAY' },
  { tab: 'tasks', ico: '✓', name: '任务', en: 'TASKS', sub: '待办与进展', ensub: 'TO-DO' },
  { tab: 'habits', ico: '△', name: '养成', en: 'HABITS', sub: '习惯 · 番茄', ensub: 'ROUTINE' },
  { tab: 'notifications', ico: '◉', name: '通知', en: 'ALERTS', sub: '提醒', ensub: 'REMIND' },
  { tab: 'stats', ico: '▤', name: '统计', en: 'STATUS', sub: '洞察', ensub: 'STATS' },
  { tab: 'music', ico: '♪', name: '音乐', en: 'MUSIC', sub: '本地音乐', ensub: 'LOCAL MUSIC' },
];
// 2026-09-26（用户要求）：**主菜单上的每一项都是"功能"，都要能被勾选/排序** ——
// 包括今日 / 日程 / 任务 / 养成 / 通知 / 统计 / 音乐这些本来写死在 MODULES 里的。
// 「今日」是落地页，不允许取消（其余都能取消：有人确实不需要日程或音乐）。
const CORE_PAGES = MODULES.slice();
const ALWAYS_ON = ['today'];
/** 可以给用户挑的"功能"= 核心页（除落地页）+ 功能模块；「设置」「五步上手」永不入列。 */
function pickablePages() {
  return [
    ...CORE_PAGES.filter((m) => !ALWAYS_ON.includes(m.tab))
      .map((m) => ({ id: m.tab, name: m.name, sub: m.sub, icon: m.ico, core: true })),
    ...MODULE_PAGES.filter((m) => m.tab !== 'settings' && m.tab !== 'onboarding')
      // settings = 这个功能自己有"就地设置"（设置页据此提示"去那一页右上角改"）
      .map((m) => ({ id: m.tab, name: m.name, sub: m.sub, icon: m.ico, core: false, settings: m.settings === true })),
  ];
}
// 「功能模块」是**可选**的那一组（view 类模块：课程辅助 / 能力搭建 / 五步上手…）。
// 用户可以在首次运行的向导里勾选要哪些、排什么顺序（2026-09-25 用户要求：
// "勾选自己想要的功能、排好序，进入应用之后主页面就按对应顺序摆，其他功能一概不留"）。
let MODULE_PAGES = [];
let UI_MODULES = { enabled: null, order: [] };     // enabled = null 表示"没挑过 ⇒ 全都要"
const NAV_L = {
  zh: { hub: '主菜单', today: '今日', calendar: '日程', tasks: '任务', habits: '养成', notifications: '通知', stats: '统计', codex: 'Codex', connectors: '数据源' },
  en: { hub: 'HOME', today: 'TODAY', calendar: 'CALENDAR', tasks: 'TASKS', habits: 'HABITS', notifications: 'ALERTS', stats: 'STATUS', codex: 'SYSTEM', connectors: 'SOURCES' },
};
const TITLE_L = {
  zh: { hub: '主菜单', today: '今日', calendar: '日程', tasks: '任务', habits: '养成', notifications: '通知', stats: '统计', codex: '数据源', connectors: '数据源', music: '音乐' },
  en: { hub: 'MAIN MENU', today: 'TODAY', calendar: 'CALENDAR', tasks: 'TASKS', habits: 'HABITS', notifications: 'ALERTS', stats: 'STATUS', codex: 'SOURCES', connectors: 'SOURCES', music: 'MUSIC' },
};
let lang = (() => { try { return localStorage.getItem('planner-lang') || 'zh'; } catch { return 'zh'; } })();
let lastModule = 'today';
let hubCursor = 'today';
const APP_VERSION = 'Vol.2.4';
// 显示名由服务端下发（/api/state 的 brand.app_name）：
// 作者本机读 data/brand.json，别人 clone 下来默认是 Cairn。
let APP_TITLE = 'Cairn';
/**
 * 主菜单点击方式（2026-09-26 晚用户要求做成可选）：
 *   `once`  = 点一次就进（**默认**；审核的人反馈"菜单要点两下才起作用"）
 *   `twice` = 点一次只选中/高亮，再点一次才进（原来那套）
 * 值存在偏好里（`hub_click`），由 /api/prefs 下发。
 */
let HUB_CLICK = 'once';
/** 学生模式（由 /api/prefs 的 student_mode 决定；自动判断或用户自己设的）。 */
let STUDENT_MODE = 'general';
/** 设置页改完点击方式后，立刻作用到正在显示的主菜单上。 */
window.__cairnApplyHubClick = (mode) => {
  HUB_CLICK = mode === 'twice' ? 'twice' : 'once';
  renderHub();
};
/** 设置页改了学生模式后，页头那一行要立刻跟着出现/消失。 */
window.__cairnApplyStudent = (mode) => {
  STUDENT_MODE = mode === 'student' ? 'student' : 'general';
  renderSemester();
};
function renderHub() {
  const el = document.getElementById('view-hub');
  if (!el) return;
  const hub = hubSelectionFor();
  el.innerHTML = `
    <div class="hub-vert">
      <div class="hub-menu">
        ${hub.items.map((m) => `<button class="hub-mi ${m.active ? 'active' : ''}" data-tab="${m.tab}" style="--i:${m.order}">
          <span class="hmi-caret" aria-hidden="true">❯</span>
          <span class="hmi-name">${m.name}</span>
          <span class="hmi-sub">${m.sub}</span>
        </button>`).join('')}
      </div>
    </div>`;
  $$('.hub-mi', el).forEach((b) => b.onclick = () => {
    const tab = b.dataset.tab;
    if (HUB_CLICK !== 'twice') { switchTab(tab); return; }   // 默认：点一次就进
    if (hubCursor === tab) switchTab(tab);                   // 两下模式：第二次点同一项才进
    else { hubCursor = tab; renderHub(); }                   // 第一次只选中/高亮
  });
}
function switchTab(tab) {
  // 「数据源」这个词还活在别处（入门卡、能力搭建、五步向导…）：一律转成"设置页的数据源页签"。
  if (tab === 'connectors' || tab === 'codex') {
    window.__cairnSettingsWanted = 'sources';
    tab = 'settings';
    try { renderConnectors(); } catch { /* 渲染失败不影响切页 */ }   // 数据源那一块要先有内容
  }
  state.tab = tab;
  if (tab !== 'hub') {
    lastModule = tab; hubCursor = tab;
    const m = MODULES.find((x) => x.tab === tab);
    if (m) showBang(lang === 'en' ? m.en : m.name);
  }
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.remove('active'));
  const v = document.getElementById('view-' + tab); if (v) v.classList.add('active');
  if (tab === 'codex') { const cv = document.getElementById('view-connectors'); if (cv) cv.classList.add('active'); }
  const ph = document.getElementById('page-head'); if (ph) ph.style.display = (tab === 'hub') ? 'none' : '';
  const t = document.getElementById('page-title'); if (t) t.textContent = (TITLE_L[lang] || TITLE_L.zh)[tab] || '';
  renderPageActions(tab);
  applyWallpaper(document.body.dataset.theme, tab === 'hub' ? 'hub' : 'inner');
  if (tab === 'hub') renderHub();
  else render();
  // `kind: view` 的模块页：切过去的时候才挂载（懒加载；自己的页面自己画）
  if (MODULE_REGISTRY.some((x) => x.kind === 'view' && x.id === tab)) mountGadgets(tab).catch(() => {});
}
function showBang(txt) {
  const b = document.getElementById('bang');
  if (!b) return;
  const t = document.getElementById('bang-txt');
  if (t) t.textContent = txt;
  b.classList.remove('show');
  void b.offsetWidth;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 640);
}
function applyLang() {
  const l = NAV_L[lang] || NAV_L.zh;
  $$('.nav-item').forEach((b) => {
    const k = b.dataset.tab;
    if (l[k]) { const span = b.querySelector('.nav-label'); if (span) span.textContent = l[k]; }
  });
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  try { localStorage.setItem('planner-lang', lang); } catch {}
  const t = document.getElementById('page-title'); if (t) t.textContent = (TITLE_L[lang] || TITLE_L.zh)[state.tab] || '';
  renderHub();
}
/**
 * 学生特化（2026-09-26 晚）：页头那一行"第 N 周 / 共 M 周 · 考试周"。
 * 数据来自 /api/state 的 `semester`（服务端按偏好里的开学日算）；没设学期就整行留空。
 */
/**
 * 学生卡片（2026-09-26 晚）：一张卡把四件事说清 ——
 * ① 未交作业 ② 今天的课 ③ 考试周 ④ 学期进度。
 * 只在学生模式下出现，且必须排在 renderToday() **之后**调用（那一句会重建 #view-today）。
 */
function renderStudentCard() {
  const view = document.getElementById('view-today');
  if (!view) return;
  const old = document.getElementById('student-card');
  if (old) old.remove();
  if (STUDENT_MODE !== 'student') return;
  const sv = DB && DB.student_view;
  if (!sv) return;
  const when = (s) => { const t = String(s || ''); return t.length >= 16 ? t.slice(5, 16).replace('T', ' ') : t; };
  const bits = [];
  if (sv.hasSemester) {
    bits.push(`<div class="sc-head">🎒 学生 · 第 ${sv.week || 0} 周 / 共 ${sv.total} 周${sv.finals ? ' <span class="pill p0">考试周</span>' : ''}</div>`);
  } else {
    bits.push('<div class="sc-head">🎒 学生 </div><div class="dim">还没填开学日 —— 去 设置 → 偏好 → 学期 填一下，这里就会显示第几周</div>');
  }
  bits.push(`<div class="sc-row"><b>⚠️ 未交作业 ${sv.undone.length} 项</b>${sv.undone.length
    ? `<div class="dim">${sv.undone.slice(0, 3).map((u) => `${esc(u.title)}${u.due_at ? ` · 截止 ${when(u.due_at)}` : ''}`).join('<br>')}${sv.undone.length > 3 ? `<br>… 还有 ${sv.undone.length - 3} 项` : ''}</div>`
    : '<div class="dim">没有（或者 Canvas 还没同步）</div>'}</div>`);
  bits.push(`<div class="sc-row"><b>📚 今天的课 ${sv.todayCourses.length} 门</b>${sv.todayCourses.length
    ? `<div class="dim">${sv.todayCourses.slice(0, 4).map((c) => `${esc(c.start_at || '')}–${esc(c.end_at || '')} ${esc(c.course)}${c.location ? ` @ ${esc(c.location)}` : ''}`).join('<br>')}</div>`
    : ''}</div>`);
  bits.push(`<div class="sc-row"><b>✅ 已完成 ${sv.doneCount} 项</b><span class="dim">（截至现在）</span></div>`);
  view.insertAdjacentHTML('afterbegin', `<div class="card student-card" id="student-card">${bits.join('')}</div>`);
}

function renderSemester() {
  const box = document.getElementById('semester-line');
  if (!box) return;
  // 只有学生模式才显示这一行（用户要求：非学生不该看到学生专属的东西）
  if (STUDENT_MODE !== 'student') { box.textContent = ''; box.classList.remove('finals'); return; }
  const s = (DB && DB.semester) || null;
  if (!s || !s.configured) { box.textContent = ''; box.classList.remove('finals'); return; }
  box.textContent = s.label;
  box.classList.toggle('finals', s.phase === 'finals');
}
function render() {
  renderBadges();
  $('#clock').textContent = new Date().toLocaleString('zh-CN');
  renderSemester();
  renderHub();
  renderToday();
  renderStudentCard();   // 必须排在 renderToday 之后：它会重建 #view-today 的内容
  renderCalendar();
  renderTasks();
  renderHabits();
  renderNotifications();
  renderStats();
  renderMusic();
  renderCodex();
  renderConnectors();
}

function renderBadges() {
  const open = DB.tasks.filter((t) => t.status !== 'done').length;
  const tb = $('#task-badge'); if (tb) tb.textContent = open;
  const due = DB.notifications.filter((n) => n.enabled && n.repeat === 'none' && !n.last_fired_at).length;
  const nb = $('#notif-badge'); if (nb) nb.textContent = due;
  const c = DB.codex;
  const d = $('#codex-dot');
  if (d) d.className = 'dot' + (c && c.connected ? ' on' : ' err');
  // 2026-09-27：不再统计 Codex 会话（那个功能已按用户要求下线），只报自动化条数。
  $('#conn-small').textContent = c && c.connected ? `已连接 · ${(c.automations || []).length} 个自动化` : '未连接';
  const cc = DB.connectors?.counts || {};
  const connCount = Object.values(cc).reduce((a, b) => a + (b || 0), 0);
  const cb = $('#conn-badge'); if (cb) cb.textContent = connCount;
}

function evtCard(e) {
  const st = dayKey(e.start_at);
  const cls = isToday(e.start_at) ? ' today' : '';
  return `<div class="list-item evt${cls}" data-edit="event" data-id="${e.id}" style="cursor:pointer">
    <div style="width:52px;flex-shrink:0">
      <div class="meta">${fmtDate(e.start_at)}</div>
      <div class="meta">${e.all_day ? '全天' : fmtTime(e.start_at)}</div>
    </div>
    <div style="width:6px;height:34px;border-radius:4px;background:${e.color}"></div>
    <div class="title">${esc(e.title)}${e.source === 'codex' ? pill('Codex', 'src') : ''}</div>
    <button class="icon-btn" data-delev="${e.id}" title="删除日程">✕</button>
  </div>`;
}

// #region today-selection —— 「今日」视图的数据来源（P0-2，2026-09-18 用户确认）
// 默认走 ViewModel 层（public\viewmodel.js 的 todaySelection）；viewmodel.js 还没
// 加载完 / 加载失败 / 地址带 ?vm=0 时，回退到下面这份等价实现。两份实现在多个
// 时间点上由 tests/today-wiring.test.mjs 逐项比对，保证等价。
// 这里只换「取哪些数据」：HTML 仍由 evtCard / taskRow / notifRow 生成 —— 外观零变化。
function vmTodayEnabled() {
  try {
    if (new URLSearchParams(location.search).get('vm') === '0') return false;
  } catch { /* 测试脚本里没有 location，忽略 */ }
  if (window.PLANNER_VM_DISABLE) return false;
  return !!(window.PlannerVM && typeof window.PlannerVM.todaySelection === 'function');
}

function legacyTodaySelection(nowMs) {
  const today = dayKey(new Date(nowMs).toISOString());
  const notDone = (t) => t.status !== 'done';
  const todaysEvents = DB.events.filter((e) => dayKey(e.start_at) === today);
  const overdue = DB.tasks.filter((t) => notDone(t) && t.due_at && isOverdue(t.due_at, nowMs));
  const duetoday = DB.tasks.filter((t) => notDone(t) && t.due_at && dueDayKey(t.due_at) === today);
  const upcoming = DB.tasks.filter((t) => notDone(t) && t.due_at && dueDayKey(t.due_at) > today)
    .sort((a, b) => dueMs(a.due_at) - dueMs(b.due_at)).slice(0, 5);
  const openNotifs = DB.notifications.filter((n) => n.enabled).slice(0, 5);
  const doneCount = DB.tasks.filter((t) => t.status === 'done').length;
  return { todaysEvents, overdue, duetoday, upcoming, openNotifs, doneCount };
}

function todaySelectionFromVM(nowMs) {
  const sel = window.PlannerVM.todaySelection(DB, nowMs);
  return {
    todaysEvents: sel.todaysEvents,
    overdue: sel.overdue,
    duetoday: sel.dueToday,
    upcoming: sel.upcoming,
    openNotifs: sel.openNotifs,
    doneCount: sel.doneCount,
  };
}

function todaySelectionFor(nowMs) {
  return vmTodayEnabled() ? todaySelectionFromVM(nowMs) : legacyTodaySelection(nowMs);
}
// #endregion today-selection

// 模块脚本（vm-bridge.js）比普通脚本先加载完也要能被接住：在顶层就登记监听。
window.addEventListener('planner-vm-ready', () => {
  try { renderToday(); } catch { /* 数据还没到就等下一次 refresh */ }
});

function renderToday() {
  const el = $('#view-today');
  const now = Date.now();
  el.innerHTML = todayHtml(todaySelectionFor(now), now);
  // 可插拔模块的第二个挂载点（2026-09-22）：功能层加东西不用改这里，
  // 只挂起来自 modules/*/module.json 里声明 mount_into: "today" 的块。
  // 注意必须在 innerHTML 之后再挂，否则会被整段重画冲掉。
  mountGadgets('today').catch(() => {});
}

// 同屏自检：同一份数据、两条取数路径，比较渲染出的 HTML 是否逐字节相同。
// 打开 http://127.0.0.1:3210/?vmcheck=1 后页面右下会出现 #vmcheck 元素。
function vmSelfCheck() {
  const box = document.createElement('div');
  box.id = 'vmcheck';
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:12px/1.5 monospace;'
    + 'background:#000c;color:#0f0;padding:6px 8px;border-radius:6px;max-width:74vw;white-space:pre-wrap';
  let verdict;
  try {
    const now = Date.now();
    const a = todayHtml(legacyTodaySelection(now), now);
    const b = todayHtml(todaySelectionFromVM(now), now);
    if (a === b) {
      verdict = 'VMCHECK OK 两条路径渲染结果逐字节相同（' + a.length + ' 字符）';
    } else {
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      verdict = 'VMCHECK DIFF @' + i + '\n legacy: ' + a.slice(i, i + 120) + '\n vm:     ' + b.slice(i, i + 120);
    }
  } catch (e) {
    verdict = 'VMCHECK ERROR ' + (e && e.message);
  }
  box.textContent = verdict;
  document.body.appendChild(box);
  try { console.log(verdict); } catch { /* ignore */ }
  return verdict;
}

function todayHtml(sel, now) {
  const { todaysEvents, overdue, duetoday, upcoming, openNotifs, doneCount } = sel;
  const today = dayKey(new Date(now).toISOString());
  return `
    <div class="grid cols-3">
      <div class="card"><h3>今日日程</h3><div class="stat-row">
        <div><div class="stat">${todaysEvents.length}</div><div class="stat-label">今天有安排</div></div>
      </div></div>
      <div class="card"><h3>待办任务</h3><div class="stat-row">
        <div><div class="stat todo">${overdue.length + duetoday.length}</div><div class="stat-label">到期/逾期</div></div>
      </div></div>
      <div class="card"><h3>任务完成</h3><div class="stat-row">
        <div><div class="stat done">${doneCount}</div><div class="stat-label">已完成</div></div>
      </div></div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <h3>今天的安排 ${today}<span class="muted">${todaysEvents.length ? '' : '，暂无'}</span></h3>
        ${todaysEvents.length ? todaysEvents.map(evtCard).join('') : '<div class="empty">今天还没有日程</div>'}
      </div>
      <div class="card">
        <h3>需要关注的任务</h3>
        ${overdue.length ? `<div class="dim" style="margin-bottom:6px">逾期 ${overdue.length} 项</div>` : ''}
        ${(overdue.length + duetoday.length) ? [...overdue, ...duetoday].slice(0, 8).map(taskRow).join('') : '<div class="empty">暂无到期任务</div>'}
      </div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <h3>即将到来的提醒</h3>
        ${openNotifs.length ? openNotifs.map(notifRow).join('') : '<div class="empty">尚未设置提醒</div>'}
      </div>
      <div class="card">
        <h3>未来任务</h3>
        ${upcoming.length ? upcoming.map(taskRow).join('') : '<div class="empty">暂无未来任务</div>'}
      </div>
    </div>

    <div class="card mt">
      <h3>Codex 连接</h3>
      <div class="conn-state">
        <span class="big-dot ${DB.codex && DB.codex.connected ? 'on' : 'off'}"></span>
        <span>${DB.codex && DB.codex.connected
          ? `已连接 <b>${DB.codex.home}</b>，同步了 ${(DB.codex.automations || []).length} 个自动化`
          : '尚未连接 Codex。请到 “Codex 连接” 页面完成连接。'}</span>
      </div>
      <button class="btn primary small" data-goto="codex">查看 Codex 数据</button>
    </div>
  `;
}

function taskRow(t) {
  const done = t.status === 'done';
  const overdue = !done && t.due_at && isOverdue(t.due_at, Date.now());
  const p = PRI[t.priority] || PRI[2];
  // 每行**固定 6 格**，与表头同一套 class（.task-grid）——
  // 没填截止时间就用「—」占位，绝不少一格（少了整行就往左挤，那是 2026-09-25 修的错位 bug）。
  const stateTxt = done ? '已完成' : (t.status === 'doing' ? '进行中' : '待办');
  const stateCls = done ? 'status' : (t.status === 'doing' ? 'p1' : 'p3');
  return `<div class="list-item task-grid" data-edit="task" data-id="${t.id}" style="cursor:pointer">
    <div class="checkbox ${done ? 'checked' : ''}" data-toggle="${t.id}">✓</div>
    <div class="title task-cell ${done ? 'done' : ''}">${t.source === 'codex' ? pill('Codex', 'src') + ' ' : ''}${esc(t.title)}</div>
    <div class="task-cell">${t.due_at ? pill((overdue ? '逾期 ' : '') + dueLabel(t.due_at), overdue ? 'p0' : '') : '<span class="dim">—</span>'}</div>
    <div class="task-cell">${pill(p.t, p.c)}</div>
    <div class="task-cell">${pill(stateTxt, stateCls)}</div>
    <button class="icon-btn" data-deltask="${t.id}" title="删除任务">✕</button>
  </div>`;
}

function notifRow(n) {
  const stateCls = !n.enabled ? 'off' : (n.repeat !== 'none' ? '' : (n.last_fired_at ? 'status' : 'pending'));
  const stateTxt = !n.enabled ? '已停用' : (n.repeat !== 'none' ? '重复' : (n.last_fired_at ? '已触发' : '待触发'));
  const tag = srcTag(n);
  return `<div class="list-item" data-edit="notif" data-id="${n.id}" style="cursor:pointer">
    <span style="font-size:18px">${tag.ico}</span>
    <div class="title">${n.priority ? '<span class="pill p1">重点</span> ' : ''}${esc(n.title)}</div>
    <div class="meta">${nextNotif(n)}${tag.name ? ' · ' + tag.name : ''}${n.message ? ' · ' + esc(String(n.message).slice(0, 60)) : ''}${n.url ? ' · ↗' : ''}</div>
    <span class="pill ${stateCls}">${stateTxt}</span>
  </div>`;
}

// 外部同步来的提醒标一下出处（邮件 / Canvas / 飞书）
function srcTag(n) {
  const s = String((n && n.source) || '');
  if (s === 'connector:email_sjtu') return { ico: '🏫', name: '交大邮箱', hot: true };
  if (s === 'connector:canvas') return { ico: '🎓', name: 'Canvas', hot: true };
  if (s === 'connector:email') return { ico: '📧', name: '邮件' };
  if (s === 'connector:feishu') return { ico: '💬', name: '飞书' };
  return { ico: '🔔', name: '' };
}

// ---------------- Calendar ----------------
function renderCalendar() {
  const el = $('#view-calendar');
  if (!state.sched.cursor) state.sched.cursor = todayStart();
  const lvl = state.sched.level;
  if (lvl === 'month') renderMonth(el);
  else if (lvl === 'week') renderWeek(el);
  else renderDay(el);
  renderConflictBanner(el);
}

function schedNav(el, title, onPrev, onNext, onToday) {
  const lvl = state.sched.level;
  // 上一页 / 下一页在三种视图里含义不同，按钮提示跟着变
  const step = { month: ['上一月', '下一月'], week: ['上一周', '下一周'], day: ['前一天', '后一天'] }[lvl] || ['上一页', '下一页'];
  const seg = [
    ['month', '月', '月历'],
    ['week', '周', '周历'],
    ['day', '日', '每日'],
  ];
  el.querySelector('.sched-top')?.remove();
  const bar = document.createElement('div');
  bar.className = 'sched-top';
  bar.innerHTML = `
    <div class="sched-nav">
      <button class="btn small" data-sd="today" title="回到今天（并恢复自动跟随）">今天</button>
      <button class="btn small icon" data-sd="prev" title="${step[0]}" ${onPrev ? '' : 'disabled'} aria-label="${step[0]}">◀</button>
      <span class="sched-title">${title}</span>
      <button class="btn small icon" data-sd="next" title="${step[1]}" ${onNext ? '' : 'disabled'} aria-label="${step[1]}">▶</button>
    </div>
    <div class="sched-seg">
      ${seg.map(([k, label, tip]) => `<button class="filter ${lvl === k ? 'active' : ''}" data-sd="level" data-lvl="${k}" title="${tip}">${label}</button>`).join('')}
    </div>
    <div style="flex:1"></div>
    <button class="btn small" data-sd="resolve" title="检测时间冲突并自动顺延任务">🔀 整理冲突</button>
    <button class="btn small" data-sd="manage">课表/校历</button>
    <button class="btn primary small" data-sd="add">+ 日程</button>
  `;
  el.prepend(bar);
  // 手动翻页 = 不再自动跟随（点「今天」恢复）。
  const manual = (fn) => () => { state.sched.follow = false; fn(); };
  $('[data-sd="today"]', bar).onclick = () => { state.sched.follow = true; onToday(); };
  // 2026-09-27：这两个回调以前**收了却没人接** ⇒ 月/周/日都翻不了页（用户报的"看不到后面的日程"）。
  if (onPrev) $('[data-sd="prev"]', bar).onclick = manual(onPrev);
  if (onNext) $('[data-sd="next"]', bar).onclick = manual(onNext);
  $('[data-sd="resolve"]', bar).onclick = async () => {
    const n = await runConflictSweep(true);
    toast(n ? `已自动顺延 ${n} 个冲突任务` : '没有可自动整理的任务冲突', n ? 'green' : '');
  };
  $('[data-sd="manage"]', bar).onclick = openScheduleManager;
  $('[data-sd="add"]', bar).onclick = () => openModal('event');
  $$('[data-sd="level"]', bar).forEach((b) => b.onclick = () => {
    state.sched.level = b.dataset.lvl;
    renderCalendar();
  });
}

// ----- 跟随"今天"：跨天 / 跨月自动翻页（2026-09-27） -----
/**
 * 默认"跟着今天走"：一直停在今天所在的那一天 / 那一周 / 那一月 ——
 * 所以**到了十月会自动翻到十月**（不用手动点）。
 * 但用户一旦自己按 ◀ ▶ 或点了某一天，就把跟随关掉：**不能把他正在看的那一页拽回今天**；
 * 点顶栏「今天」重新跟随。
 * 这个是纯判断（今天没变就返回 false，不做无谓重画），每分钟 + 切回窗口时各看一眼。
 */
function schedFollowToday() {
  if (!state.sched.follow) return false;
  const now = new Date();
  const cur = state.sched.cursor;
  if (cur && dateKeyOf(cur) === dateKeyOf(now)) return false;
  state.sched.cursor = todayStart();
  return true;
}
function schedFollowTick() { if (schedFollowToday()) renderCalendar(); }
function startSchedFollow() {
  setInterval(schedFollowTick, 60000);                    // 每分钟看一眼：跨过 00:00 / 跨月就自动翻
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedFollowTick(); });
  window.addEventListener('focus', schedFollowTick);      // 切回窗口时也算一次（可能已经过了一天）
}

// ----- Month -----
function monthWeeks(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  let cur = mondayOf(first);
  const weeks = [];
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  while (cur <= last || weeks.length < 4) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cur, i)));
    cur = addDays(cur, 7);
    if (weeks.length > 6) break;
    if (cur > addDays(last, 7)) break;
  }
  return weeks;
}

// #region calendar-month-selection —— 「日程·月」视图的数据来源（A4，2026-09-20）
// 与 today/tasks/notifications 同一套做法：默认向 ViewModel 层要数据
// （public\viewmodel.js 的 calendarMonthSelection），模块没加载 / 地址带 ?vm=0 时
// 回退到下面这份等价实现。**只换「取哪些数据」**：网格布局、周号、校历标签
// 仍由 renderMonth() 自己拼，所以外观零变化。
// 两份实现由 tests/calendar-wiring.test.mjs（多个月份逐格比对）与
// tests/calendar-html.test.mjs（HTML 逐字节相同）验证。本轮只覆盖「月」。
function legacyCalendarMonthSelection(cursor) {
  const weeks = monthWeeks(cursor);
  return {
    monthIndex: cursor.getMonth(),
    weeks: weeks.map((wdays) => {
      const monday = wdays[0];
      const sunday = wdays[6];
      return {
        mondayKey: dateKeyOf(monday),
        mondayMs: monday.getTime(),
        range: `${monday.getMonth() + 1}/${monday.getDate()}–${sunday.getMonth() + 1}/${sunday.getDate()}`,
        days: wdays.map((d) => {
          const key = dateKeyOf(d);
          return {
            key,
            ms: d.getTime(),
            day: d.getDate(),
            inMonth: d.getMonth() === cursor.getMonth(),
            events: eventsOn(key),
            tasks: tasksOn(key).filter((t) => t.status !== 'done'),
            acad: academicOn(key),
          };
        }),
      };
    }),
  };
}

function calendarMonthSelectionFromVM(cursor) {
  return window.PlannerVM.calendarMonthSelection(DB, { cursorMs: cursor.getTime() });
}

function monthGridFor(cursor) {
  if (vmTodayEnabled()) {
    const sel = calendarMonthSelectionFromVM(cursor);
    if (sel) return sel;
  }
  return legacyCalendarMonthSelection(cursor);
}
// #endregion calendar-month-selection

function renderMonth(el) {
  const cursor = state.sched.cursor;
  const weeks = monthGridFor(cursor).weeks;
  const todayKey = dateKeyOf(new Date());
  el.innerHTML = '';
  schedNav(el, `${fmtCn(cursor)} · ${semWeekLabel(cursor)}`,
    () => { state.sched.cursor = addMonths(state.sched.cursor, -1); renderCalendar(); },
    () => { state.sched.cursor = addMonths(state.sched.cursor, 1); renderCalendar(); },
    () => { state.sched.cursor = todayStart(); renderCalendar(); });

  const monthGrid = document.createElement('div');
  monthGrid.className = 'month-view';
  // header: corner + weekdays
  monthGrid.innerHTML = `<div class="mg-corner"></div>` + WEEK_DAYS.map((d) => `<div class="mg-head">周${d}</div>`).join('');

  weeks.forEach((wk, i) => {
    const wn = weekNumberOf(new Date(wk.mondayMs));
    // Render the week number with a lighter font so the Arabic digits stay legible.
    const weekLabel = wn == null
      ? `第<span class="wnum">${i + 1}</span>周`
      : `学期第<span class="wnum">${wn}</span>周`;
    monthGrid.innerHTML += `
      <div class="mg-wcell" data-monday="${wk.mondayKey}" title="点击查看 ${weekLabel}">
        <div class="mg-wnum">${weekLabel}</div>
        <div class="mg-wrange">${wk.range}</div>
      </div>`;
      wk.days.forEach((d) => {
        const evts = d.events;
        const tks = d.tasks;
        // 「学期」是**区间标记**（一整个学期），不是每天一件事：左边那列已经写着"学期第 N 周"了，
        // 所以只在开学那天标一次 —— 否则翻到 12 月，每一天都印着「开学」。
        // 假期 / 考试 / 补课这种是真的覆盖那几天，照常在每一天标出来。
        const acad = d.acad.filter((a) => a.kind !== 'term' || dayKey(a.start_at) === d.key);
        // 格子里放不下时会写「还有 N 条」（以前多出来的条目直接看不见）
        const shownEvt = evts.slice(0, 1);
        const shownTk = tks.slice(0, 2);
        const more = (evts.length - shownEvt.length) + (tks.length - shownTk.length) + Math.max(0, acad.length - 1);
        monthGrid.innerHTML += `
          <div class="mg-cell ${d.inMonth ? '' : 'dim'} ${d.key === todayKey ? 'today' : ''}" data-date="${d.key}">
            <div class="mg-date">${d.day}</div>
            ${shownEvt.map((e) => `<div class="mg-evt${isConflictingEvent(e) ? ' conflict' : ''}" style="background:${e.color}">${esc(e.title)}</div>`).join('')}
            ${shownTk.map((t) => `<div class="mg-task">• ${esc(t.title)}</div>`).join('')}
            ${acad.length ? `<div class="mg-acad">◆ ${esc(acadLabel(acad[0], new Date(d.ms)))}</div>` : ''}
            ${more > 0 ? `<div class="mg-more">还有 ${more} 条</div>` : ''}
            ${(evts.length + tks.length + acad.length) > 0 ? '' : '<div class="mg-fill"></div>'}
          </div>`;
      });
  });
  el.appendChild(monthGrid);

  $$('.mg-wcell', monthGrid).forEach((r) => r.onclick = () => {
    state.sched.level = 'week';
    state.sched.follow = false;                 // 自己点进去看某一周 → 不再自动跟随
    state.sched.cursor = mondayOf(new Date(r.dataset.monday + 'T00:00:00'));
    renderCalendar();
  });
  $$('.mg-cell', monthGrid).forEach((c) => c.onclick = () => {
    state.sched.level = 'day';
    state.sched.follow = false;                 // 同上
    state.sched.cursor = new Date(c.dataset.date + 'T00:00:00');
    renderCalendar();
  });
}

// ----- Week (class-schedule grid) -----
// #region calendar-dayweek-selection —— 「日程·周/日」视图的数据来源（A4 续，2026-09-20）
// 和「月」同一套做法：默认向 ViewModel 层要数据（calendarWeekSelection /
// calendarDaySelection），模块没加载 / ?vm=0 时回退到下面这份等价实现。
// **只换「取哪些数据」**：时间轴上的像素位置、列表怎么排，仍由 renderWeek() /
// renderDay() 自己算 —— 外观零变化。由 tests/calendar-dayweek.test.mjs 比对。
function legacyCalendarWeekSelection(cursor) {
  const monday = mondayOf(cursor);
  return {
    mondayKey: dateKeyOf(monday),
    mondayMs: monday.getTime(),
    days: Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((d, i) => {
      const key = dateKeyOf(d);
      return {
        key,
        ms: d.getTime(),
        dow: i,
        date: d.getDate(),
        monthIndex: d.getMonth(),
        courses: courseForDay(d),
        events: eventsOn(key),
        acad: academicOn(key),
      };
    }),
  };
}

function legacyCalendarDaySelection(cursor) {
  const key = dateKeyOf(cursor);
  return {
    key,
    ms: cursor.getTime(),
    courses: courseForDay(cursor),
    events: eventsOn(key),
    tasks: tasksOn(key),
    notifs: notifsOn(key),
    acad: academicOn(key),
  };
}

function calendarWeekSelectionFromVM(cursor) {
  return window.PlannerVM.calendarWeekSelection(DB, { cursorMs: cursor.getTime() });
}

function calendarDaySelectionFromVM(cursor) {
  return window.PlannerVM.calendarDaySelection(DB, { cursorMs: cursor.getTime() });
}

function weekSelectionFor(cursor) {
  if (vmTodayEnabled()) {
    const sel = calendarWeekSelectionFromVM(cursor);
    if (sel) return sel;
  }
  return legacyCalendarWeekSelection(cursor);
}

function daySelectionFor(cursor) {
  if (vmTodayEnabled()) {
    const sel = calendarDaySelectionFromVM(cursor);
    if (sel) return sel;
  }
  return legacyCalendarDaySelection(cursor);
}
// #endregion calendar-dayweek-selection

function renderWeek(el) {
  const weekSel = weekSelectionFor(state.sched.cursor);
  const monday = new Date(weekSel.mondayMs);
  const days = weekSel.days;
  const todayKey = dateKeyOf(new Date());
  // 时间轴：作息改到 00:30–07:30 后，晚上的块会一直排到 23:59，
  // 所以可见范围从 07:00–23:00 扩到 07:00–24:00，否则 23:00 之后的块会被裁掉。
  const START = 7, END = 24, HOURPX = 56;
  const GRID_H = (END - START) * HOURPX; // full column height for the visible hour range
  const now = new Date();
  const nowPos = (now.getHours() + now.getMinutes() / 60 - START) * HOURPX;
  const range = `${days[0].monthIndex + 1}/${days[0].date} – ${days[6].monthIndex + 1}/${days[6].date}`;

  el.innerHTML = '';
  schedNav(el, `${semWeekLabel(monday)} · ${range}`,
    () => { state.sched.cursor = addDays(state.sched.cursor, -7); renderCalendar(); },
    () => { state.sched.cursor = addDays(state.sched.cursor, 7); renderCalendar(); },
    () => { state.sched.cursor = todayStart(); renderCalendar(); });

  const wrap = document.createElement('div');
  wrap.className = 'week-wrap';
  const timeCol = document.createElement('div');
  timeCol.className = 'week-time';
  for (let h = START; h <= END; h++) timeCol.innerHTML += `<div class="ht" style="top:${(h - START) * HOURPX}px">${pad(h)}:00</div>`;
  wrap.appendChild(timeCol);

  const daysWrap = document.createElement('div');
  daysWrap.className = 'week-days';
  days.forEach((d, i) => {
    const key = d.key;
    const isToday = key === todayKey;
    const areCourses = d.courses;
    const evts = d.events;
      // 同月历：学期是区间标记，只在这条区间的第一天标出来，别在整周的每一天都印「开学」
      const acad = d.acad.filter((a) => a.kind !== 'term' || dayKey(a.start_at) === d.key);
    let html = `<div class="wd-head ${isToday ? 'today' : ''}" data-date="${key}">
        <div class="wd-dow">周${WEEK_DAYS[i]}</div>
        <div class="wd-date">${d.monthIndex + 1}/${d.date}</div>
        ${acad.length ? `<div class="wd-acad">◆ ${esc(acadLabel(acad[0], d))}</div>` : ''}
      </div>
      <div class="wd-body" style="height:${GRID_H}px">`;

    const els = [];
    for (const c of areCourses) {
      const s = hmToMin(c.start_at), e = hmToMin(c.end_at);
      els.push({ top: (s / 60 - START) * HOURPX, height: Math.max(((e - s) / 60) * HOURPX, 26), type: 'course', c });
    }
    for (const ev of evts) {
      if (ev.all_day) { els.push({ atop: true, type: 'event', ev }); continue; }
      const t = new Date(ev.start_at);
      const pos = (t.getHours() + t.getMinutes() / 60 - START) * HOURPX;
      const endT = ev.end_at ? new Date(ev.end_at) : new Date(ev.start_at.getTime() + 3600000);
      const h = (endT - t) / 3600000 * HOURPX;
      els.push({ top: pos, height: Math.max(h, 22), type: 'event', ev });
    }
    els.sort((a, b) => (a.top - b.top));
    for (const it of els) {
      if (it.atop) {
        html += `<div class="wk-all${isConflictingEvent(it.ev) ? ' conflict' : ''}" style="background:${it.ev.color}" data-edit="event" data-id="${it.ev.id}">全天 · ${esc(it.ev.title)}</div>`;
        continue;
      }
      if (it.type === 'course') {
        html += `<div class="wk-course" style="top:${it.top}px;height:${it.height}px;background:${it.c.color}" data-edit="course" data-id="${it.c.id}" title="点击编辑这门课">
            <div class="wk-cname">${esc(it.c.course)}</div>
            <div class="wk-cmeta">${hm12(it.c.start_at)}–${hm12(it.c.end_at)}${it.c.platform ? ' · ' + esc(it.c.platform) : ''}${it.c.location ? ' · ' + esc(it.c.location) : ''}</div>
          </div>`;
      } else {
        html += `<div class="wk-event${isConflictingEvent(it.ev) ? ' conflict' : ''}" style="top:${it.top}px;height:${it.height}px;border-left-color:${it.ev.color}" data-edit="event" data-id="${it.ev.id}">
            <div class="wk-ename">${esc(it.ev.title)}</div>
          </div>`;
      }
    }
    if (isToday) html += `<div class="nowline" style="top:${nowPos}px"></div>`;
    html += `</div>`;
    html += `</div>`;
    const col = document.createElement('div');
    col.className = 'week-day';
    col.innerHTML = html;
    daysWrap.appendChild(col);
  });
  wrap.appendChild(daysWrap);
  el.appendChild(wrap);

  // Align the time-labels column with each day's body (which sits below the day
  // header) and give it the full content height, so the week renders completely
  // with no nested vertical scrollbar (only the app's own scrollbar scrolls).
  const firstHead = wrap.querySelector('.wd-head');
  const headH = firstHead ? firstHead.offsetHeight : 0;
  if (headH) {
    // Absolute-positioned labels are not shifted by padding, so offset each one.
    $$('.ht', timeCol).forEach((l) => { l.style.top = (parseFloat(l.style.top) + headH) + 'px'; });
  }
  timeCol.style.height = (headH + GRID_H) + 'px';

  $$('.wd-head', wrap).forEach((h) => h.onclick = () => {
    state.sched.level = 'day';
    state.sched.follow = false;               // 自己点了某一天 → 不再自动跟随
    state.sched.cursor = new Date(h.dataset.date + 'T00:00:00');
    renderCalendar();
  });
  $$('.wk-course', wrap).forEach((c) => c.onclick = (e) => { e.stopPropagation(); openCourseManager(); });
}

function hmToMin(s) { const [h, m] = (s || '0:0').split(':'); return (+h) * 60 + (+m); }

// ----- Day (two modes) -----
function renderDay(el) {
  const cursor = state.sched.cursor;
  const key = dateKeyOf(cursor);
  el.innerHTML = '';
  schedNav(el, fmtCnFull(cursor),
    () => { state.sched.cursor = addDays(state.sched.cursor, -1); renderCalendar(); },
    () => { state.sched.cursor = addDays(state.sched.cursor, 1); renderCalendar(); },
    () => { state.sched.cursor = todayStart(); renderCalendar(); });

  const modeBar = document.createElement('div');
  modeBar.className = 'day-mode flex';
  modeBar.innerHTML = `
    <span class="dim" style="flex:1">${key} · 点击日程/任务可编辑</span>
    <button class="btn small ${state.sched.dayMode === 'list' ? 'active' : ''}" data-mode="list">🗂️ 任务栏</button>
    <button class="btn small ${state.sched.dayMode === 'timeline' ? 'active' : ''}" data-mode="timeline">🕑 时间轴</button>
    <button class="btn small" id="add-day-task">+ 任务</button>
  `;
  el.appendChild(modeBar);
  $$('[data-mode]', modeBar).forEach((b) => b.onclick = () => { state.sched.dayMode = b.dataset.mode; renderCalendar(); });
  $('#add-day-task', modeBar).onclick = () => openModal('task', { due_at: key + 'T20:00' });

  const body = document.createElement('div');
  body.className = 'day-body';
  el.appendChild(body);
  if (state.sched.dayMode === 'list') dayListInto(body, cursor);
  else dayTimelineInto(body, cursor);
}

function dayListInto(el, cursor) {
  const daySel = daySelectionFor(cursor);
  const key = daySel.key;
  const courses = daySel.courses;
  const evts = daySel.events.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const tks = daySel.tasks.sort((a, b) => dueMs(a.due_at) - dueMs(b.due_at));
  const notifs = daySel.notifs;
  const acad = daySel.acad;

  const section = (title, inner, extra) => `
    <div class="card day-section">
      <h3>${title} <span class="muted">${inner ? '' : '无'}</span></h3>
      ${inner || '<div class="empty">暂无</div>'}
      ${extra || ''}
    </div>`;

  // courses
  el.innerHTML = `
    <div class="grid cols-2">
      ${section('📚 今日课程', courses.map((c) => `
        <div class="list-item" data-edit="course" data-id="${c.id}" title="点击编辑这门课（地点 / 平台 / 时间…）">
          <div style="width:6px;height:40px;border-radius:4px;background:${c.color}"></div>
          <div class="title">${esc(c.course)}</div>
          <div class="meta">${hm12(c.start_at)}–${hm12(c.end_at)}</div>
          ${c.platform ? pill(esc(c.platform), 'src') : ''}
          ${c.location ? pill(esc(c.location), 'tag') : ''}
          ${c.teacher ? pill(esc(c.teacher), 'src') : ''}
        </div>`).join(''), `<button class="btn small mt" id="dl-add-course">+ 添加课程</button>`)}
      ${section('🗓️ 今日日程', evts.map(evtCard).join(''))}
    </div>
    <div class="grid cols-2 mt">
      ${section('✅ 今日任务', tks.map(taskRow).join(''), `<button class="btn small mt" id="dl-add-task">+ 新增今日任务</button>`)}
      ${section('🔔 今日提醒', notifs.map(notifRow).join(''))}
    </div>
    ${acad.length ? section('📅 校历安排', acad.map((a) => `
      <div class="list-item"><span class="pill" style="border-color:${a.color};color:${a.color}">${esc(ACADEMIC_KIND_LABEL[a.kind] || a.kind)}</span>
      <div class="title">${esc(a.title)}</div><div class="meta">${esc(a.start_at)}${a.end_at ? ' – ' + esc(a.end_at) : ''}</div></div>`).join('')) : ''}
  `;
  const b = el.querySelector('#dl-add-task');
  if (b) b.onclick = () => openModal('task', { due_at: key + 'T20:00' });
  const bc = el.querySelector('#dl-add-course');
  if (bc) bc.onclick = () => openModal('course', { weekday: weekdayIndex(cursor) + 1, weeks: '1-14', color: '#4f7cff' });
}

function dayTimelineInto(el, cursor) {
  const daySel = daySelectionFor(cursor);
  const key = daySel.key;
  const cursorKey = key;
  const START = 0, HOURPX = 56;
  const now = new Date();
  const nowPos = (now.getHours() + now.getMinutes() / 60) * HOURPX;
  const courses = daySel.courses;
  const evts = daySel.events;
  const tks = daySel.tasks;
  const notifs = daySel.notifs;
  const items = [];

  for (const c of courses) {
    items.push({ top: hmToMin(c.start_at) / 60 * HOURPX, height: Math.max((hmToMin(c.end_at) - hmToMin(c.start_at)) / 60 * HOURPX, 30), kind: 'course', color: c.color, title: c.course, id: c.id, sub: `${hm12(c.start_at)}–${hm12(c.end_at)}${c.platform ? ' · ' + c.platform : ''}${c.location ? ' · ' + c.location : ''}` });
  }
  for (const ev of evts) {
    if (ev.all_day) { items.push({ top: 0, height: 28, kind: 'all', color: ev.color, title: ev.title, sub: '全天' }); continue; }
    const t = new Date(ev.start_at);
    const pos = (t.getHours() + t.getMinutes() / 60) * HOURPX;
    const endT = ev.end_at ? new Date(ev.end_at) : new Date(t.getTime() + 3600000);
    const h = (endT - t) / 3600000 * HOURPX;
    items.push({ top: pos, height: Math.max(h, 26), kind: 'event', color: ev.color, title: ev.title, sub: fmtTime(ev.start_at), id: ev.id });
  }
  for (const t of tks) {
    // 纯日期 = 当天 23:59 截止，所以落在时间轴最底部（并夹住高度避免溢出）。
    const ms = dueMs(t.due_at);
    const dt = new Date(ms === null ? t.due_at : ms);
    const pos = Math.min((dt.getHours() + dt.getMinutes() / 60) * HOURPX, 24 * HOURPX - 26);
    const sub = t.status === 'done' ? '已完成'
      : hasTimeOfDay(t.due_at) ? fmtTime(t.due_at) : dueLabel(t.due_at);
    items.push({ top: pos, height: 26, kind: 'task', color: t.status === 'done' ? '#3ecf8e' : '#ffd166', title: t.title, sub, id: t.id });
  }
  for (const n of notifs) {
    const dt = new Date(n.trigger_at);
    const pos = (dt.getHours() + dt.getMinutes() / 60) * HOURPX;
    items.push({ top: pos, height: 26, kind: 'notif', color: '#b58cff', title: n.title, sub: fmtTime(n.trigger_at), id: n.id });
  }
  items.sort((a, b) => a.top - b.top);

  el.innerHTML = `
    <div class="card">
      <h3>🕑 当日时间轴 <span class="muted">${cursorKey}</span></h3>
      <div class="timeline">
        <div class="tl-time" style="height:${24 * HOURPX}px">
          ${Array.from({ length: 25 }, (_, h) => `<div class="tl-ht" style="top:${h * HOURPX}px">${pad(h)}:00</div>`).join('')}
        </div>
        <div class="tl-body" style="height:${24 * HOURPX}px">
          ${items.map((it, idx) => `
            <div class="tl-item ${it.kind}${(it.kind === 'event' || it.kind === 'task') && isConflict(it.kind, it.id) ? ' conflict' : ''}" style="top:${it.top}px;height:${it.height}px;border-left-color:${it.color};
              ${idx % 3 === 1 ? 'left:38%;' : idx % 3 === 2 ? 'left:66%;' : 'left:2%;'} width:30%"
              ${it.id ? `data-edit="${it.kind === 'task' ? 'task' : it.kind === 'event' ? 'event' : it.kind === 'course' ? 'course' : 'notif'}" data-id="${it.id}"` : ''}>
              <div class="tl-title" style="color:${it.color}">${esc(it.title)}</div>
              <div class="tl-sub">${esc(it.sub)}</div>
            </div>`).join('')}
          <div class="nowline" style="top:${nowPos}px"></div>
        </div>
      </div>
    </div>
  `;
}

// ---------------- Tasks ----------------
// #region tasks-selection —— 「任务」视图的数据来源（P2-1，2026-09-20）
// 与 #region today-selection 同一套做法：默认向 ViewModel 层要数据
// （public\viewmodel.js 的 tasksSelection），模块没加载 / 地址带 ?vm=0 时回退到下面
// 这份等价实现；**HTML 模板不动**，所以外观零变化。
// 两份实现由 tests/tasks-wiring.test.mjs（数据级）与 tests/tasks-html.test.mjs（HTML 级）比对。
// 两种顺序（2026-09-25 新增「时间优先」，见测试反馈 v）：
//   smart = 未完成在前 → 截止时间升序（没填截止时间的排最后）
//   due   = 严格按截止时间升序，**不区分完成与否**（做完的留在原位）
// 两份实现（这里与 public/viewmodel.js）必须一字不差地等价，由 tasks-html/wiring 测试比对。
function sortTasks(list, sort) {
  const due = (t) => (t.due_at ? dueMs(t.due_at) : Infinity);
  if (sort === 'due') return [...list].sort((a, b) => due(a) - due(b));
  // 「轻重缓急」（2026-09-26 新增的折中档）：先按"急不急"分桶（逾期 > 今天 > 三天内 > 其他），
  // 桶内按优先级、再按截止时间 —— "重要但不紧急"不会像"绝对优先级优先"那样占满前排，
  // 也不会像纯时间排序那样把重要事埋在后面。
  if (sort === 'balanced') {
    const bucket = (t) => {
      const d = t.due_at ? dueMs(t.due_at) : null;
      if (d === null) return 3;
      const now = Date.now();
      if (d < now) return 0;
      if (d - now <= 24 * 3600 * 1000) return 1;
      if (d - now <= 3 * 24 * 3600 * 1000) return 2;
      return 3;
    };
    const pri = (t) => (typeof t.priority === 'number' ? t.priority : 2);
    return [...list].sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
      || bucket(a) - bucket(b) || pri(a) - pri(b) || due(a) - due(b));
  }
  return [...list].sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || due(a) - due(b));
}

function legacyTasksSelection(filter, sort = 'smart') {
  let list = sortTasks(DB.tasks, sort);
  if (filter === 'todo') list = list.filter((t) => t.status === 'todo');
  if (filter === 'doing') list = list.filter((t) => t.status === 'doing');
  if (filter === 'done') list = list.filter((t) => t.status === 'done');
  const count = (status) => DB.tasks.filter((t) => t.status === status).length;
  return { filter, sort, list, counts: { all: DB.tasks.length, todo: count('todo'), doing: count('doing'), done: count('done') } };
}

function tasksSelectionFromVM(filter, sort = 'smart') {
  const sel = window.PlannerVM.tasksSelection(DB, { filter, sort });
  return { filter: sel.filter, sort: sel.sort, list: sel.list, counts: sel.counts };
}

// vmTodayEnabled() 是 P0-2 留下的共用开关（?vm=0 / 模块未加载 → false）
// sort 由 renderTasks 显式传入（不从 state 里取，这样这段代码能独立被测试加载）；
// 传别的值（含 undefined）都当「智能」，与 legacyTasksSelection 的默认值一致。
function tasksSelectionFor(filter, sort) {
  return vmTodayEnabled() ? tasksSelectionFromVM(filter, sort) : legacyTasksSelection(filter, sort);
}
// #endregion tasks-selection

function renderTasks() {
  const el = $('#view-tasks');
  const filter = state.taskFilter;
  const sort = ['due', 'balanced'].includes(state.taskSort) ? state.taskSort : 'smart';
  const icons = { all: '全部', todo: '待办', doing: '进行中', done: '已完成' };
  const list = tasksSelectionFor(filter, sort).list;

  el.innerHTML = `
    <div class="filters">
      ${Object.entries(icons).map(([k, v]) => `<button class="filter ${filter === k ? 'active' : ''}" data-filter="${k}">${v}</button>`).join('')}
      <span style="flex:1"></span>
      <select id="task-sort" class="select-inline" title="智能排序：没做完的排前面、做完的沉到最后（组内按截止时间）。轻重缓急：先用「逾期 / 今天 / 三天内」分档，桶内按优先级 —— 重要但不紧急不会占满前排。时间优先：严格按截止时间排，做完的也留在原位。">
        <option value="smart" ${sort === 'smart' ? 'selected' : ''}>智能排序</option>
        <option value="balanced" ${sort === 'balanced' ? 'selected' : ''}>轻重缓急</option>
        <option value="due" ${sort === 'due' ? 'selected' : ''}>时间优先</option>
      </select>
      <button class="btn primary" id="add-task">+ 新增任务</button>
    </div>
    <div class="card">
      <div class="task-head task-grid">
        <span></span><span>任务</span><span>截止时间</span><span>优先级</span><span>状态</span><span></span>
      </div>
      ${list.length ? list.map((t) => taskRow(t)).join('') : '<div class="empty">暂无任务</div>'}
    </div>
  `;
  $$('.filter', el).forEach((f) => f.onclick = () => { state.taskFilter = f.dataset.filter; renderTasks(); });
  $('#task-sort').onchange = (e) => {
    state.taskSort = ['due', 'balanced'].includes(e.target.value) ? e.target.value : 'smart';
    try { localStorage.setItem('planner-task-sort', state.taskSort); } catch {}
    renderTasks();
  };
  $('#add-task').onclick = () => openModal('task');
  // 可插拔模块的挂载点（⏳ DDL 提醒卡片挂在这里：与"截止时间"最相关的一页）
  mountGadgets('tasks').catch(() => {});
}

// ---------------- Notifications ----------------
// 时间戳归一化：trigger_at 是 ISO 字符串，created_at 是毫秒数。
function tsMs(v) {
  const t = typeof v === 'number' ? v : Date.parse(String(v || ''));
  return Number.isNaN(t) ? 0 : t;
}
// 通知管理列表顺序：越晚的通知越靠前（提醒时间倒序；重点来源仍置顶，同一时间按创建时间倒序）。
function notifListOrdered() {
  return [...DB.notifications].sort((a, b) =>
    (b.priority ? 1 : 0) - (a.priority ? 1 : 0)
    || tsMs(b.trigger_at) - tsMs(a.trigger_at)
    || tsMs(b.created_at) - tsMs(a.created_at));
}

// #region notifications-selection —— 「通知」视图的数据来源（P2-1，2026-09-20）
// 与 today/tasks 同一套做法：默认走 ViewModel 层，模块没加载 / ?vm=0 时回退；
// **排序规则与 HTML 模板都不动**。
function legacyNotificationsSelection() {
  const list = [...DB.notifications].sort((a, b) =>
    (b.priority ? 1 : 0) - (a.priority ? 1 : 0)
    || tsMs(b.trigger_at) - tsMs(a.trigger_at)
    || tsMs(b.created_at) - tsMs(a.created_at));
  return { list };
}

function notificationsSelectionFromVM() {
  return { list: window.PlannerVM.notificationsSelection(DB).list };
}

function notificationsSelectionFor() {
  return vmTodayEnabled() ? notificationsSelectionFromVM() : legacyNotificationsSelection();
}
// #endregion notifications-selection

function renderNotifications() {
  const el = $('#view-notifications');
  const list = notificationsSelectionFor().list;
  el.innerHTML = `
    <div class="between" style="margin-bottom:16px">
      <div class="dim">到点后应用内会弹出提醒横幅。系统通知默认关闭，需要时再打开。</div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="toggle-os-notify">${osNotifyEnabled() ? '🔔 系统通知：开' : '🔕 系统通知：关'}</button>
        <button class="btn primary" id="add-notif">+ 新增提醒</button>
      </div>
    </div>
    <div class="card">
      ${list.length ? list.map((n) => `
        <div class="list-item" data-edit="notif" data-id="${n.id}" style="cursor:pointer">
          <span style="font-size:18px">${srcTag(n).ico}</span>
          <div class="title">${n.priority ? '<span class="pill p1">重点</span> ' : ''}${esc(n.title)}</div>
          <div class="meta">${fmtFull(n.trigger_at)}${srcTag(n).name ? ' · 来自' + srcTag(n).name : ''}${n.url ? ' · <span style="color:#7fd1ff">↗ 点一下打开原文</span>' : ''}</div>
          ${n.message ? `<div class="meta">${esc(String(n.message).slice(0, 80))}</div>` : ''}
          <div class="meta">${nextNotif(n)}</div>
          <div class="row-actions" style="margin-left:auto">
            <label class="notif-switch" title="关掉后这条提醒就不会再响（仍然留在列表里，随时可以再打开）">
              <input type="checkbox" data-toggle-notif="${n.id}" ${n.enabled ? 'checked' : ''} />
              ${n.enabled ? '提醒：开' : '提醒：关'}
            </label>
            ${n.url ? `<button class="btn small" data-open="${n.id}">打开</button>` : ''}
            <button class="btn small" data-editbtn="${n.id}">编辑</button>
            <button class="btn small" data-test="${n.id}" title="发一条测试提醒：真的会响一次（应用内横幅 / 系统通知），不会影响这条通知之后的正常提醒">测试提醒</button>
            <button class="btn small" data-del="${n.id}">删除</button>
          </div>
        </div>`).join('')
        : '<div class="empty">还没有通知提醒</div>'}
    </div>
  `;
  $('#add-notif').onclick = () => openModal('notif');
  $('#toggle-os-notify').onclick = () => {
    if (!osNotifyEnabled()) {
      if (!('Notification' in window)) { toast('浏览器不支持系统通知', 'red'); return; }
      Notification.requestPermission().then((p) => {
        if (p === 'granted') setOsNotify(true);
        else toast('未获得系统通知权限', 'red');
      });
    } else {
      setOsNotify(false);
    }
  };
  $$('[data-open]', el).forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const n = DB.notifications.find((x) => x.id === b.dataset.open);
    if (n && n.url) openExternal(n.url);
  });
  $$('[data-editbtn]', el).forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const n = DB.notifications.find((x) => x.id === b.dataset.editbtn);
    if (n) openModal('notif', n);
  });
  $$('[data-test]', el).forEach((b) => b.onclick = (e) => { e.stopPropagation(); testNotif(b.dataset.test); });
  $$('[data-del]', el).forEach((b) => b.onclick = (e) => { e.stopPropagation(); delItem('notifications', b.dataset.del); });
  // 逐条开关（测试反馈 iii）：以前只能整条删掉或一直响，现在每条都能单独关掉。
  // 关掉的条目仍然留在列表里（状态标「已停用」），随时能再打开。
  $$('[data-toggle-notif]', el).forEach((c) => {
    c.onclick = (e) => e.stopPropagation();          // 别顺手打开编辑弹窗
    c.onchange = async () => {
      const id = c.dataset.toggleNotif;
      const next = !!c.checked;
      try {
        await api('PATCH', `/api/notifications/${id}`, { enabled: next });
        toast(next ? '这条提醒已打开' : '这条提醒已停用（不再响，随时可以再打开）', next ? 'green' : '');
        refresh();
      } catch (err) {
        c.checked = !next;                             // 没改成就把开关拨回去，别骗人
        toast('没能改这条提醒，稍后再试', 'red');
      }
    };
  });
}

// ---------------- 养成 (Habits + Pomodoro + Countdown) ----------------
function renderHabits() {
  const el = $('#view-habits');
  const hab = habitsSelectionFor();

  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3>⏳ 倒计时 <span class="muted">考试 / 截止 / 目标</span>
        <button class="btn small" style="margin-left:auto" id="add-milestone">+ 里程碑</button>
      </h3>
      <div class="countdown-row">
        ${hab.hasCountdowns ? hab.countdowns.map((m) => `
          <div class="cd-chip" data-id="${m.id}">
            <div class="cd-num">${m.daysLeft}</div>
            <div class="cd-label">${esc(m.title)}</div>
            <div class="cd-date">${fmtShort(m.targetAt)}</div>
            <button class="icon-btn cd-del" data-del-cd="${m.id}" title="删除这个倒计时">✕</button>
          </div>`).join('') : '<div class="empty" style="padding:12px">暂无倒计时，点“+ 里程碑”添加考试/截止日</div>'}
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <div class="between" style="margin-bottom:10px">
          <h3 style="margin:0">🌱 习惯打卡 <span class="muted">${hab.todayDone}/${hab.total}</span></h3>
          <button class="btn small" id="add-habit">+ 习惯</button>
        </div>
        ${hab.habits.length ? hab.habits.map((h) => `
          <div class="habit-row">
            <div class="habit-ico" style="background:${h.color}22;border-color:${h.color}">${esc(h.icon)}</div>
            <div class="habit-name">${esc(h.name)}<div class="dim">连续 ${h.streak} 天</div></div>
            <div class="habit-days">
              ${h.days.map((d) => `<button class="hday ${d.done ? 'done' : ''}" data-toggle-h="${h.id}" data-date="${d.date}">${d.day}</button>`).join('')}
            </div>
            <button class="icon-btn" data-del-h="${h.id}">✕</button>
          </div>`).join('') : '<div class="empty">还没有习惯，点“+ 习惯”建立（如背单词、锻炼、早起）</div>'}
      </div>

      <div class="card">
        <h3>🍅 番茄专注 <span class="muted">今日 ${hab.focus.today} 分钟 · 本周 ${hab.focus.week} 分钟</span></h3>
        <div class="pomodoro">
          <div class="pomo-ring" id="pomo-ring">
            <div class="pomo-time" id="pomo-time">25:00</div>
            <div class="pomo-state" id="pomo-state">待开始</div>
          </div>
          <div class="flex" style="justify-content:center">
            <button class="btn small" id="pomo-start">▶ 开始</button>
            <button class="btn small" id="pomo-pause">⏸ 暂停</button>
            <button class="btn small" id="pomo-reset">↺ 重置</button>
          </div>
          <div class="flex" style="justify-content:center;margin-top:8px">
            <span id="pomo-label" class="dim"></span>
            <button class="btn primary small" id="pomo-log" style="display:none">✅ 记录本次专注</button>
          </div>
        </div>
        <div class="dim" style="margin-top:10px">选时长后可开始;结束后点「记录本次专注」计入统计。</div>
        <div class="flex" style="margin-top:6px">
          ${[25, 45, 60].map((m) => `<button class="filter ${m === 25 ? 'active' : ''}" data-pomo-len="${m}">${m} 分钟</button>`).join('')}
        </div>
      </div>
    </div>
  `;

  $('#add-habit').onclick = () => openModal('habit');
  $('#add-milestone').onclick = () => openModal('milestone');
  // 2026-09-25：倒计时（里程碑）以前只能通过接口删、界面上没有入口 —— 补一个 ✕
  $$('[data-del-cd]', el).forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const m = (hab.countdowns || []).find((x) => x.id === b.dataset.delCd);
    delItem('milestones', b.dataset.delCd, `删除倒计时「${m ? m.title : ''}」？`);
  });
  $$('[data-toggle-h]', el).forEach((b) => b.onclick = () => {
    api('POST', `/api/habits/${b.dataset.toggleH}/toggle`, { date: b.dataset.date }).then(refresh);
  });
  $$('[data-del-h]', el).forEach((b) => b.onclick = () => delItem('habits', b.dataset.delH, `删除习惯「${esc(b.closest('.habit-row').querySelector('.habit-name').textContent.trim())}」及其打卡记录?`));
  $$('[data-pomo-len]', el).forEach((b) => b.onclick = () => {
    $$('[data-pomo-len]', el).forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    setPomoDuration(+b.dataset.pomoLen);
  });
  $('#pomo-start').onclick = pomoStart;
  $('#pomo-pause').onclick = pomoPause;
  $('#pomo-reset').onclick = pomoReset;
  $('#pomo-log').onclick = pomoLog;
  $('#pomo-label').textContent = pomoLabel || '';
}

const hk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function daysUntil(t) { return Math.max(0, Math.ceil((new Date(t) - new Date()) / 86400000)); }
function fmtShort(t) { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; }

// pomodoro state
let pomoLen = 25, pomoLeft = 25 * 60, pomoTimer = null, pomoRunning = false, pomoLabel = '';
function setPomoDuration(m) { pomoLen = m; pomoLeft = m * 60; renderPomo(); }
function renderPomo() {
  const t = $('#pomo-time'); if (t) t.textContent = `${String(Math.floor(pomoLeft / 60)).padStart(2, '0')}:${String(pomoLeft % 60).padStart(2, '0')}`;
  const s = $('#pomo-state'); if (s) s.textContent = pomoRunning ? '专注中' : (pomoLeft < pomoLen * 60 ? '已暂停' : '待开始');
  const ring = $('#pomo-ring'); if (ring) ring.style.setProperty('--pct', `${Math.round((1 - pomoLeft / (pomoLen * 60)) * 100)}%`);
}
function pomoStart() { if (pomoLeft <= 0) pomoLeft = pomoLen * 60; pomoRunning = true; clearInterval(pomoTimer); pomoTimer = setInterval(() => { pomoLeft--; renderPomo(); if (pomoLeft <= 0) { clearInterval(pomoTimer); pomoRunning = false; pomoLabel = ''; renderPomo(); const b = $('#pomo-log'); if (b) b.style.display = 'inline-block'; } }, 1000); renderPomo(); }
function pomoPause() { pomoRunning = false; clearInterval(pomoTimer); renderPomo(); }
function pomoReset() { pomoRunning = false; clearInterval(pomoTimer); pomoLeft = pomoLen * 60; pomoLabel = ''; const b = $('#pomo-log'); if (b) b.style.display = 'none'; renderPomo(); }
async function pomoLog() {
  const minutes = Math.max(1, Math.round((pomoLen * 60 - pomoLeft) / 60));
  const label = prompt('本次专注标签(可选):', pomoLabel || '专注') || '专注';
  await api('POST', '/api/focus', { label, started_at: new Date(Date.now() - minutes * 60000).toISOString(), ended_at: new Date().toISOString(), minutes });
  pomoLabel = ''; pomoReset();
  await refresh();
  toast(`已记录 ${minutes} 分钟专注`, 'green');
}

// ---------------- 统计 (insights) ----------------
function renderStats() {
  const el = $('#view-stats');
  // 汇总数字、近 7 日柱子高度都来自显示层（R4 接线）：见 #region stats-selection
  const st = statsSelectionFor();

  el.innerHTML = `
    <div class="grid cols-4">
      ${statCard('📅 学期', st.semesterWeek ? `第${st.semesterWeek}周` : '未设校历')}
      ${statCard(st.nextCountdown ? '⏳ 最近倒计时' : '⏳ 倒计时', st.nextCountdown ? `${st.nextCountdown.daysLeft} 天` : '—', st.nextCountdown ? esc(st.nextCountdown.title) : '添加里程碑/考试')}
      ${statCard('✅ 任务完成率', `${st.tasks.completion ?? 0}%`, `${st.tasks.done ?? 0}/${st.tasks.total ?? 0} 已完成`) }
      ${statCard('🌱 习惯今日', `${st.habits.todayDone ?? 0}/${st.habits.total ?? 0}`, '完成打卡')}
    </div>
    <div class="grid cols-2 mt">
      <div class="card">
        <h3>🍅 专注时长 <span class="muted">近7日(分钟)</span></h3>
        <div class="bars">
          ${st.focusBars.map((w) => `<div class="bar-wrap">
            <div class="bar" style="height:${w.heightPct}%"></div>
            <div class="bar-v">${w.fMin}</div>
            <div class="bar-l">${w.label}</div></div>`).join('')}
        </div>
        <div class="dim" style="margin-top:8px">今日 ${st.focus.today || 0} 分钟 · 本周 ${st.focus.week || 0} 分钟 · 累计 ${st.focus.sessions || 0} 次</div>
      </div>
      <div class="card">
        <h3>✅ 完成任务 <span class="muted">近7日</span></h3>
        <div class="bars">
          ${st.taskBars.map((w) => `<div class="bar-wrap">
            <div class="bar task" style="height:${w.heightPct}%"></div>
            <div class="bar-v">${w.tDone}</div>
            <div class="bar-l">${w.label}</div></div>`).join('')}
        </div>
        <div class="dim" style="margin-top:8px">今日完成 ${st.tasks.doneToday || 0} · 本周完成 ${st.tasks.doneWeek || 0} · 待办 ${st.tasks.open || 0}</div>
      </div>
    </div>
    <div class="card mt">
      <h3>🔥 习惯连续打卡 <span class="muted">连击</span></h3>
      ${st.streaks.length ? `<div class="flex" style="flex-wrap:wrap;gap:10px">
        ${st.streaks.map((s) => `<span class="pill status">${esc(s.name)} · ${s.streak} 天</span>`).join('')}
      </div>` : '<div class="empty">暂无习惯</div>'}
    </div>
  `;
  // 可插拔模块的挂载点（💾 数据备份卡片挂在这里；今日页只放"当下要知道的事"）
  mountGadgets('stats').catch(() => {});
}
function statCard(t, big, sub) {
  return `<div class="card"><h3>${t}</h3><div class="stat">${big}</div><div class="stat-label">${sub || ''}</div></div>`;
}

// ---------------- 本地音乐(播放本机文件) ----------------
let localMusicTracks = [];   // 浏览器直接选择的本机文件(对象 URL),优先于服务器扫描结果
function renderMusic() {
  const el = $('#view-music');
  // 曲库从哪来（服务端扫描 / 浏览器直读）由显示层决定：见 #region music-selection
  const mu = musicSelectionFor();
  const m = { dir: mu.dir };
  const usingLocal = mu.usingLocal;
  const tracks = mu.tracks;
  el.innerHTML = `
    <div class="card music-hero">
      <h3>🎵 本地音乐 <span class="muted">播放本机的音乐文件</span></h3>
      <div class="dim" style="margin-bottom:12px">指定一个本机音乐文件夹,应用会扫描其中的音频文件(支持 mp3 / flac / m4a / aac / wav / ogg / wma 等),在应用内直接播放——不涉及任何在线平台。</div>
      <div class="music-search">
        <input id="mu-dir" placeholder="本机音乐文件夹，例如 你的用户目录\\Music" value="${esc(m.dir || '')}" />
        <button class="btn primary" id="mu-scan">扫描</button>
      </div>
      <div class="music-actions" style="margin-top:10px">
        <input type="file" id="mu-files" webkitdirectory multiple accept="audio/*" style="display:none" />
        <button class="btn small" id="mu-pick">选择本机文件夹（浏览器直接读取）</button>
        ${usingLocal ? '<button class="btn small" id="mu-clear">清除本地选择</button>' : ''}
      </div>
      <div class="dim" id="mu-status" style="margin-top:8px">${mu.status}</div>
    </div>

    <div class="card mt">
      <h3>正在播放 <span class="muted" id="mu-now">未选择</span></h3>
      <audio id="mu-audio" controls preload="metadata" style="width:100%"></audio>
      <div class="music-actions" style="margin-top:10px;align-items:center">
        <button class="btn small" id="mu-prev">⏮ 上一首</button>
        <button class="btn primary small" id="mu-toggle">▶ 播放</button>
        <button class="btn small" id="mu-next">⏭ 下一首</button>
        <label class="dim" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="mu-loop" checked style="width:auto" /> 列表循环</label>
      </div>
    </div>

    <div class="card mt">
      <h3>曲库 <span class="muted">${tracks.length} 首</span></h3>
      <div id="mu-list" class="music-list">
        ${tracks.length ? tracks.map((t, i) => `
          <div class="mu-item" data-i="${i}">
            <span class="mu-i">${i + 1}</span>
            <span class="mu-name">${esc(t.name)}</span>
            <span class="mu-sub">${esc((t.ext || '').replace('.', '').toUpperCase())}${t.size ? ' · ' + fmtSize(t.size) : ''}</span>
          </div>`).join('') : '<div class="empty">还没有歌曲——先设置文件夹并点「扫描」</div>'}
      </div>
    </div>
  `;
  const audio = $('#mu-audio');
  let cur = -1;
  const streamUrl = (t) => t.url || `/api/music/stream?f=${encodeURIComponent(t.file)}`;
  const markCur = () => $$('.mu-item', el).forEach((n) => n.classList.toggle('on', +n.dataset.i === cur));
  const playAt = (i) => {
    if (!tracks.length) { toast('曲库为空,请先扫描文件夹', 'red'); return; }
    cur = ((i % tracks.length) + tracks.length) % tracks.length;
    const t = tracks[cur];
    audio.src = streamUrl(t);
    audio.play().catch(() => {});
    $('#mu-now').textContent = t.name;
    markCur();
  };
  $('#mu-toggle').onclick = () => { if (audio.paused) { if (cur < 0) playAt(0); else audio.play().catch(() => {}); } else audio.pause(); };
  $('#mu-prev').onclick = () => playAt(cur <= 0 ? tracks.length - 1 : cur - 1);
  $('#mu-next').onclick = () => playAt(cur + 1);
  audio.addEventListener('play', () => { $('#mu-toggle').textContent = '⏸ 暂停'; });
  audio.addEventListener('pause', () => { $('#mu-toggle').textContent = '▶ 播放'; });
  audio.addEventListener('ended', () => { if ($('#mu-loop').checked) playAt(cur + 1); });
  $$('.mu-item', el).forEach((n) => n.onclick = () => playAt(+n.dataset.i));
  const doScan = async () => {
    const dir = $('#mu-dir').value.trim();
    $('#mu-status').textContent = '正在扫描…';
    try {
      const r = await api('POST', '/api/music/scan', { dir });
      DB.music = r;
      renderMusic();
      toast(`已收录 ${(r.tracks || []).length} 首`, 'green');
    } catch (e) {
      const st = $('#mu-status');
      if (st) st.textContent = `扫描失败：${e.message || ''}（若应用尚未重启,请改用上方「选择本机文件夹」）`;
      toast('扫描失败——可改用「选择本机文件夹」', 'red');
    }
  };
  $('#mu-scan').onclick = doScan;
  $('#mu-dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doScan(); } });

  // 浏览器直接读取本机文件夹(无需服务端,刷新后需重选)
  const pick = $('#mu-pick'); const files = $('#mu-files');
  if (pick) pick.onclick = () => files.click();
  if (files) files.onchange = (e) => {
    const list = [...(e.target.files || [])].filter((f) => /\.(mp3|flac|m4a|aac|wav|ogg|oga|opus|wma)$/i.test(f.name));
    if (!list.length) { toast('未在所选文件夹中找到音频文件', 'red'); return; }
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    localMusicTracks = list.map((f) => ({
      name: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f),
      ext: (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase(), size: f.size,
    }));
    renderMusic();
    toast(`已载入 ${localMusicTracks.length} 首（本地）`, 'green');
  };
  const clr = $('#mu-clear');
  if (clr) clr.onclick = () => { localMusicTracks.forEach((t) => t.url && URL.revokeObjectURL(t.url)); localMusicTracks = []; renderMusic(); };
}

async function testNotif(id) {
  await api('POST', `/api/notifications/${id}/test`);
  toast('已发出一条测试提醒（只响这一次，不影响这条通知之后的正常提醒）', 'green');
}

// 用系统默认浏览器打开外部内容（邮件 / Canvas 页面）
async function openExternal(url) {
  if (!url) return;
  try {
    const r = await api('POST', '/api/open', { url });
    if (r && r.ok === false) {
      // 服务端打不开就退回浏览器新标签
      window.open(url, '_blank', 'noopener');
      toast('已在新标签打开', 'green');
    }
  } catch (e) {
    window.open(url, '_blank', 'noopener');
    toast('已在新标签打开', 'green');
  }
}

// ---------------- Codex connection ----------------
function renderCodex() {
  const el = $('#view-codex');
  // 「连没连上、几条自动化在跑、计划导到哪、对话记录」都来自显示层：见 #region codex-selection
  const cx = codexSelectionFor();
  const c = cx;
  const home = cx.home;
  const active = cx.automationActive;

  const statusPill = (a) => `<span class="pill ${a.statusCls}">${a.statusCls.startsWith('status') ? a.statusLabel : esc(a.status)}</span>`;

  el.innerHTML = `
    <div class="card chat-card">
      <div class="between"><h3 style="margin:0">💬 Codex 问答 <span class="muted">输入问题，由 Codex 直接回答</span></h3></div>
      <div class="chat-thread" id="chat-thread">
        ${cx.chat.messages.length ? cx.chat.messages.map((m) => `<div class="chat-msg ${m.role}"><div class="bubble">${esc(m.text)}</div></div>`).join('') : '<div class="empty">还没有对话，输入你的第一条问题。</div>'}
      </div>
      <div class="chat-input">
        <input id="chat-in" placeholder="问 Codex 任何问题…" autocomplete="off" />
        <button class="btn primary small" id="chat-send">发送</button>
      </div>
    </div>

    <div class="card">
      <h3>连接 Codex</h3>
      <div class="conn-state">
        <span class="big-dot ${c.connected ? 'on' : 'off'}"></span>
        <span>${c.connected ? '已成功连接 Codex 数据' : '未连接'}</span>
      </div>
      <div class="field">
        <label>Codex 主目录 (CODEX_HOME)</label>
        <input id="codex-home" value="${esc(home || '')}" placeholder="C:\\Users\\<用户名>\\.codex" />
      </div>
      <button class="btn primary" id="btn-connect">
        ${c.syncedAt ? '重新同步' : '连接并同步'}
      </button>
       ${c.syncedAt ? `<span class="dim" style="margin-left:10px">上次同步：${fmtFull(new Date(c.syncedAt).toISOString())}</span>` : ''}
      ${c.error ? `<div class="dim" style="margin-top:10px;color:var(--red)">⚠ ${esc(c.error)}</div>` : ''}
    </div>

    <div class="card mt">
      <h3>让 Codex 读取你的计划 <span class="muted">把每日计划与安排导出给 Codex</span></h3>
      <div class="dim" style="margin-bottom:10px">
        应用会把「每日计划与安排」（今天的日程 / 到期任务 / 课程 / 提醒，及未来 14 天）导出成文件，Codex 任意会话都能直接读取。
        <b>导出哪几种格式由你定</b>（Markdown / JSON / ICS 日历 / CSV 表格，默认 Markdown + JSON）——
        在<b>设置 → 本机 → 计划导出</b>里勾选，也可以在那儿直接下载某一种。
      </div>
      <div class="dim" style="font-family:monospace;font-size:12px;line-height:1.9">
        ${cx.planPaths.length
          ? cx.planPaths.map((x) => `· ${esc(x)}`).join('<br>')
          : `<span>· ${esc(home || 'C:\\Users\\<用户名>\\.codex')}\\planner\\daily-plan.md</span><br><span>· data\\plan\\daily-plan.md</span>`}
      </div>
      <div class="flex" style="margin-top:10px;align-items:center;gap:10px">
        <button class="btn primary small" id="plan-export">立即导出</button>
        <a class="btn small" href="/api/plan.md" target="_blank" rel="noopener">预览 Markdown</a>
        <a class="btn small" href="/api/plan.ics?download=1">下载 ICS 日历</a>
        <a class="btn small" href="/api/plan.csv?download=1">下载 CSV 表格</a>
        <span id="plan-export-status" class="dim">${cx.planExport && cx.planExport.exported_at ? '上次导出：' + fmtFull(cx.planExport.exported_at) : '（尚未导出，操作后会更新）'}</span>
      </div>
    </div>

    <div class="card mt">
      <h3>Codex 自动化 <span class="muted">${active}/${cx.automationTotal} 运行中 · 可作为日程与提醒</span></h3>
      ${cx.automations.length ? `
        <table class="table">
          <thead><tr><th>名称</th><th>类型</th><th>状态</th><th>计划</th><th>下次运行</th></tr></thead>
          <tbody>
            ${cx.automations.map((a) => `
              <tr>
                <td><b>${esc(a.name)}</b><div class="dim" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.prompt)}</div></td>
                <td>${esc(a.kind)}</td>
                <td>${statusPill(a)}</td>
                <td>${esc(a.describe || '—')}</td>
                <td>${a.nextRunAt ? fmtDT(a.nextRunAt) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">未读取到自动化(可能在 ~/.codex/automations)</div>'}
    </div>

  `;

  $('#btn-connect').onclick = () => connectCodex($('#codex-home').value.trim());
  const peBtn = $('#plan-export');
  if (peBtn) peBtn.onclick = async () => {
    const st = $('#plan-export-status');
    peBtn.disabled = true;
    try {
      const r = await api('POST', '/api/plan/export');
      if (st) st.textContent = '已导出：' + ((r.paths || []).join('  ·  ') || '已更新');
      toast('已把计划导出给 Codex', 'green');
    } catch (e) {
      toast(e.message || '导出失败', 'red');
    } finally { peBtn.disabled = false; }
  };
  const ci = $('#chat-in');
  if (ci) {
    const send = () => { const t = ci.value.trim(); if (t) { ci.value = ''; chatAsk(t); } };
    $('#chat-send').onclick = send;
    ci.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    const th = $('#chat-thread'); if (th) th.scrollTop = th.scrollHeight;
  }
}

let chatLog = (() => { try { return JSON.parse(localStorage.getItem('codex-chat') || '[]'); } catch { return []; } })().slice(-80);
function chatSave() { try { localStorage.setItem('codex-chat', JSON.stringify(chatLog)); } catch {} }
function chatScroll() { const th = $('#chat-thread'); if (th) { th.scrollTop = th.scrollHeight; } }
async function chatAsk(text) {
  chatLog.push({ role: 'user', text }); chatSave(); renderCodex(); chatScroll();
  const ph = { role: 'assistant', text: '…' };
  chatLog.push(ph); renderCodex(); chatScroll();
  try {
    const r = await api('POST', '/api/codex/ask', { prompt: text });
    ph.text = (r.ok && r.text) ? r.text : ('⚠ ' + (r.error || '无结果'));
  } catch (e) { ph.text = '⚠ ' + e.message; }
  chatSave(); renderCodex(); chatScroll();
}

async function connectCodex(home) {
  $('#btn-connect').textContent = '同步中…';
  try {
    const res = await api('POST', '/api/codex/connect', { home });
    await refresh();
    toast(res.connected ? `已连接，同步 ${(res.automations || []).length} 个自动化` : '连接失败', res.connected ? 'green' : 'red');
  } catch (e) {
    toast('连接失败：' + e.message, 'red');
  }
  $('#btn-connect').textContent = '重新同步';
}

// ---------------- Data sources (connectors) ----------------
// ---------------- 后台常驻（托盘 / 桌面外壳）状态 ----------------
const canvasWatch = () => DB.canvas_watch || DB.health?.canvas_watch || { enabled: true, interval_hours: 3 };

function fmtUptime(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return '刚刚启动';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
}

function bgHtml() {
  const h = DB.health;
  if (!h) return '<div class="dim">后台状态读取中…（刷新页面或稍后再看）</div>';
  const w = h.canvas_watch || {};
  const last = w.last_run ? fmtDT(w.last_run) : '尚未运行';
  const next = w.next_run ? fmtDT(w.next_run) : '—';
  const added = w.last_result && w.last_result.added != null ? w.last_result.added : 0;
  const rr = (w.last_result && w.last_result.raw) || null;
  const rawParts = rr ? [
    `课程 ${rr.courses ?? '—'}`,
    `作业 ${rr.assignments ?? '—'}`,
    `事件 ${rr.events ?? '—'}`,
    rr.files != null || rr.pages != null || rr.module_items != null
      ? `文件 ${rr.files ?? 0} · 页面 ${rr.pages ?? 0} · 大纲 ${rr.syllabus ?? 0} · 模块 ${rr.module_items ?? 0}` : '',
  ].filter(Boolean) : [];
  const raw = rawParts.length ? `（${rawParts.join(' · ')}）` : '';
  const auto = h.autostart?.enabled;
  return `
    <div class="between" style="flex-wrap:wrap;gap:10px">
      <div>
        <div>后台服务：<b>运行中</b> <span class="muted">pid ${h.pid} · 已运行 ${fmtUptime(h.uptime_sec)} · 日志 data/server.log</span></div>
        <div class="dim">Canvas 巡检：${w.enabled ? `开（每 ${w.interval_hours} 小时）` : '已关闭'} · 上次 ${last} · 下次 ${next}</div>
        <div class="dim">上次新增 ${added} 条${raw} · 任务 ${h.counts?.tasks ?? '—'} · 通知 ${h.counts?.notifications ?? '—'}</div>
        ${w.last_error ? `<div class="dim" style="color:var(--red)">⚠ 上次巡检出错：${esc(w.last_error)}</div>` : ''}
      </div>
      <div>${auto ? pill('开机自启：已开启', 'status') : pill('开机自启：未开启', 'off')}</div>
    </div>`;
}

// 手机 / 办公本同步卡片：Bark 推送、日历订阅、每日摘要、办公本文件。
function mobileCardHtml() {
  const m = DB.mobile || {};
  const p = m.prefs || {};
  const cal = m.calendar || { urls: [], port: 3211, enabled: false };
  const urls = cal.urls || [];
  const last = m.last_digest;
  const lastLine = last
    ? `${last.ok ? '✅ 上次成功' : '⚠️ 上次失败'} ${fmtDT(last.at)}${last.ok ? ` · 发到 ${(last.to || []).join(', ')}` : ` · ${esc(last.error || '')}`}`
    : '还没有发送过';
  const ic = m.last_icloud;
  const lastEve = m.last_digest_evening;
  const lastEveLine = lastEve
    ? `${lastEve.ok ? '✅ 上次成功' : '⚠️ 上次失败'} ${fmtDT(lastEve.at)}${lastEve.ok ? ` · 发到 ${(lastEve.to || []).join(', ')}` : ` · ${esc(lastEve.error || '')}`}`
    : '还没有发送过晚报';
  const icloudLine = ic
    ? `${ic.ok ? '✅ 上次同步' : '⚠️ 上次失败'} ${fmtDT(ic.at)}${ic.ok ? ` · 更新 ${ic.pushed || 0} 条，未变 ${ic.unchanged || 0} 条，删除 ${ic.deleted || 0} 条` : ` · ${esc(ic.error || '')}`}`
    : '还没有同步过';
  const keyHint = p.bark_key ? `${String(p.bark_key).slice(0, 6)}…${String(p.bark_key).slice(-4)}` : '';
  return `
    <div class="card" style="margin-bottom:16px">
      <h3>📱 手机与办公本 <span class="muted">Bark 推送 · 日历订阅 · iCloud 直推 · 每日摘要</span></h3>

      <div class="grid cols-2" style="gap:16px">
        <div>
          <div class="dim" style="margin-bottom:6px"><b>① Bark 即时推送</b>（iPhone 装 Bark，把密钥或推送地址粘到这里）</div>
          <div class="field-row">
            <div class="field">
              <label>Bark 密钥 / 推送地址</label>
              <input type="text" id="mb-bark-key" placeholder="例如 https://api.day.app/你的密钥" value="${esc(p.bark_key || '')}" />
            </div>
            <div class="field">
              <label>推送来源</label>
              <input type="text" id="mb-bark-sources" placeholder="email_sjtu,canvas" value="${esc(p.bark_sources || '')}" />
            </div>
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:10px;margin-top:6px">
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="mb-bark-enabled" ${p.bark_enabled ? 'checked' : ''} style="width:auto" />启用推送
            </label>
            <button class="btn small" id="mb-bark-save">保存</button>
            <button class="btn primary small" id="mb-bark-test">发送测试推送</button>
            <span class="dim">${keyHint ? `已保存 ${esc(keyHint)}` : '尚未填写密钥'}</span>
          </div>
        </div>

        <div>
          <div class="dim" style="margin-bottom:6px"><b>② 日历订阅</b>（iPhone 日历自动同步课表 / 校历 / DDL）</div>
          ${urls.length ? urls.map((u) => `
            <div class="field">
              <label>${esc(u.name)} · ${esc(u.ip)}（手机与本机连同一个 Wi-Fi 时可用）</label>
              <input type="text" id="mb-cal-url" readonly value="${esc(u.webcal)}" />
            </div>
            <div class="flex" style="flex-wrap:wrap;gap:8px;margin-top:6px">
              <button class="btn small" data-mb-copy="${esc(u.webcal)}">复制订阅链接</button>
              <button class="btn small" data-mb-copy="${esc(u.ics)}">复制 http 链接</button>
              <button class="btn small" data-mb-open="${esc(u.page)}">在浏览器打开（含一键订阅按钮）</button>
            </div>`).join('') : '<div class="dim">还没有检测到局域网地址（连上 Wi-Fi 后刷新）。</div>'}
          <div class="flex" style="flex-wrap:wrap;gap:10px;margin-top:10px">
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="mb-lan-enabled" ${p.lan_enabled ? 'checked' : ''} style="width:auto" />开启手机访问端口 (${cal.port})
            </label>
            <button class="btn small" id="mb-cal-save">保存</button>
            <button class="btn small" id="mb-cal-reset">重置订阅密钥</button>
            <button class="btn small" id="mb-ics">下载 .ics</button>
          </div>
        </div>
      </div>

      <div class="grid cols-2" style="gap:16px;margin-top:16px">
        <div>
          <div class="dim" style="margin-bottom:6px"><b>③ 早报 / 晚报邮件</b>（手机邮箱 / 办公本邮箱都能收到；两封都带"最值得先看的 3 条 + 建议"）</div>
          <div class="field-row">
            <div class="field">
              <label>发送时间</label>
              <input type="time" id="mb-digest-time" value="${esc(p.digest_time || '07:00')}" />
            </div>
            <div class="field">
              <label>用哪个邮箱发</label>
              <select id="mb-digest-from">
                <option value="email_sjtu" ${p.digest_from === 'email_sjtu' ? 'selected' : ''}>交大邮箱（推荐，校内稳定）</option>
                <option value="email" ${p.digest_from === 'email' ? 'selected' : ''}>Gmail</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>收件人（留空＝发给上面这个邮箱自己；多个用逗号分隔）</label>
            <input type="text" id="mb-digest-to" placeholder="留空即可；办公本邮箱账号可另填" value="${esc(p.digest_to || '')}" />
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:10px;margin-top:6px">
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="mb-digest-enabled" ${p.digest_enabled ? 'checked' : ''} style="width:auto" />每天自动发送
            </label>
            <button class="btn small" id="mb-digest-save">保存</button>
            <button class="btn primary small" id="mb-digest-send">立即发送一封</button>
          </div>
          <div class="dim" style="margin-top:8px">${lastLine}</div>
          <div class="flex" style="flex-wrap:wrap;gap:10px;margin-top:10px;padding-top:8px;border-top:1px dashed #5553">
            <div class="field" style="max-width:150px">
              <label>晚报时间</label>
              <input type="time" id="mb-digest-eve-time" value="${esc(p.digest_evening_time || '21:00')}" />
            </div>
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="mb-digest-eve-enabled" ${p.digest_evening_enabled ? 'checked' : ''} style="width:auto" />每天自动发晚报
            </label>
            <button class="btn small" id="mb-digest-eve-save">保存晚报</button>
            <button class="btn small" id="mb-digest-eve-send">立即发一封晚报</button>
          </div>
          <div class="dim" style="margin-top:6px">${lastEveLine}</div>
        </div>

        <div>
          <div class="dim" style="margin-bottom:6px"><b>⑤ iCloud 日历直推</b>（写进 iPhone 自带日历，不需要同一 Wi-Fi）</div>
          <div class="field-row">
            <div class="field">
              <label>Apple ID</label>
              <input type="text" id="mb-icloud-user" placeholder="you@example.com" value="${esc(p.icloud_user || '')}" />
            </div>
            <div class="field">
              <label>App 专用密码</label>
              <input type="password" id="mb-icloud-pass" placeholder="xxxx-xxxx-xxxx-xxxx" value="${esc(p.icloud_pass || '')}" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>账号区域</label>
              <select id="mb-icloud-host">
                <option value="china" ${p.icloud_host === 'china' ? 'selected' : ''}>中国区（云上贵州 · caldav.icloud.com.cn）</option>
                <option value="global" ${p.icloud_host === 'global' ? 'selected' : ''}>国际版（caldav.icloud.com）</option>
              </select>
            </div>
            <div class="field">
              <label>日历名称</label>
              <input type="text" id="mb-icloud-calendar" value="${esc(p.icloud_calendar || 'Planner')}" />
            </div>
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:10px;margin-top:6px">
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="mb-icloud-enabled" ${p.icloud_enabled ? 'checked' : ''} style="width:auto" />每天自动同步
            </label>
            <label class="dim" style="margin:0 4px">时间</label>
            <input type="time" id="mb-icloud-time" value="${esc(p.icloud_time || '07:00')}" style="width:120px" />
            <button class="btn small" id="mb-icloud-save">保存</button>
            <button class="btn small" id="mb-icloud-test">测试连接</button>
            <button class="btn primary small" id="mb-icloud-sync">立即同步到 iCloud</button>
          </div>
          <div class="dim" style="margin-top:8px">${icloudLine}</div>
          <div class="dim" style="margin-top:6px">
            App 专用密码在 <b>appleid.apple.com</b> → 登录与安全 → App 专用密码 里生成（形如 <code>abcd-efgh-ijkl-mnop</code>），不是 Apple ID 登录密码。日程会上传到 Apple 服务器。<br />
            <b>重要</b>：iCloud 不允许程序自己新建日历，请先在 iPhone「日历」App 里加一个名为 <b>${esc(p.icloud_calendar || 'Planner')}</b> 的日历（日历 → 底部「日历」→ 编辑 → 添加日历），再点「立即同步到 iCloud」。
          </div>
        </div>

        <div>
          <div class="dim" style="margin-bottom:6px"><b>④ 办公本（讯飞 X5）</b>：生成可导入的文件，再走数据线 / 网盘 / 邮件</div>
          <div class="field">
            <label>本机文件目录（数据线直接拷这里的内容）</label>
            <input type="text" id="mb-mobile-dir" placeholder="${esc(m.mobile_dir_default || '')}" value="${esc(p.mobile_dir || '')}" />
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:8px;margin-top:6px">
            <button class="btn small" id="mb-files-save">保存目录</button>
            <button class="btn small" id="mb-files-make">生成今日文件</button>
            <button class="btn small" id="mb-open-dir">打开目录</button>
          </div>
          <div class="dim" style="margin-top:8px">生成 <code>today-plan-日期.txt</code>（放入书架直接看）与 <code>planner-calendar.ics</code>（办公本/手机导入日历）。填一个网盘同步目录（如百度网盘同步文件夹）后，办公本从网盘取用即可。</div>
        </div>
      </div>
    </div>`;
}

function bindMobileCard(el) {
  const val = (sel) => { const n = $(sel, el); return n ? n.value.trim() : ''; };
  const chk = (sel) => { const n = $(sel, el); return n ? n.checked : false; };

  const savePrefs = async (patch, msg) => {
    await api('POST', '/api/mobile', patch);
    await refresh();
    toast(msg, 'green');
  };
  const bs = $('#mb-bark-save', el);
  if (bs) bs.onclick = () => savePrefs({
    bark_key: val('#mb-bark-key'),
    bark_sources: val('#mb-bark-sources'),
    bark_enabled: chk('#mb-bark-enabled'),
  }, 'Bark 推送设置已保存');
  const bt = $('#mb-bark-test', el);
  if (bt) bt.onclick = async () => {
    bt.textContent = '发送中…';
    try {
      await api('POST', '/api/mobile', {
        bark_key: val('#mb-bark-key'), bark_sources: val('#mb-bark-sources'), bark_enabled: true,
      });
      const r = await api('POST', '/api/mobile/bark/test', {});
      if (r.ok) toast('测试推送已发出，看手机上的 Bark', 'green');
      else toast('推送失败：' + (r.error || '请检查密钥'), 'red');
    } catch (e) { toast('推送失败：' + e.message, 'red'); }
    bt.textContent = '发送测试推送';
  };
  const cs = $('#mb-cal-save', el);
  if (cs) cs.onclick = () => savePrefs({ lan_enabled: chk('#mb-lan-enabled') }, '日历订阅设置已保存');
  const cr = $('#mb-cal-reset', el);
  if (cr) cr.onclick = async () => {
    if (!confirm('重置后旧订阅链接会失效，需要在手机上重新订阅。继续？')) return;
    await api('POST', '/api/mobile/calendar/reset', {});
    await refresh();
    toast('订阅密钥已重置', 'green');
  };
  const ics = $('#mb-ics', el);
  if (ics) ics.onclick = () => { window.location.href = '/api/mobile/calendar.ics'; };
  const ds = $('#mb-digest-save', el);
  if (ds) ds.onclick = () => savePrefs({
    digest_enabled: chk('#mb-digest-enabled'),
    digest_time: val('#mb-digest-time'),
    digest_from: val('#mb-digest-from'),
    digest_to: val('#mb-digest-to'),
  }, '每日摘要设置已保存');
  const dsend = $('#mb-digest-send', el);
  if (dsend) dsend.onclick = async () => {
    dsend.textContent = '发送中…';
    try {
      const r = await api('POST', '/api/mobile/digest/send', {
        digest_to: val('#mb-digest-to'),
        kind: 'morning',
      });
      await refresh();
      if (r.ok) toast(`已发送到 ${(r.to || []).join(', ')}`, 'green');
      else toast('发送失败：' + (r.error || ''), 'red');
    } catch (e) { toast('发送失败：' + e.message, 'red'); }
    dsend.textContent = '立即发送一封';
  };
  // 晚报（和早报各自独立开关 / 时间）
  const des = $('#mb-digest-eve-save', el);
  if (des) des.onclick = () => savePrefs({
    digest_evening_enabled: chk('#mb-digest-eve-enabled'),
    digest_evening_time: val('#mb-digest-eve-time'),
  }, '晚报设置已保存');
  const dee = $('#mb-digest-eve-send', el);
  if (dee) dee.onclick = async () => {
    dee.textContent = '发送中…';
    try {
      const r = await api('POST', '/api/mobile/digest/send', {
        digest_to: val('#mb-digest-to'),
        kind: 'evening',
      });
      await refresh();
      if (r.ok) toast(`晚报已发送到 ${(r.to || []).join(', ')}`, 'green');
      else toast('晚报发送失败：' + (r.error || ''), 'red');
    } catch (e) { toast('晚报发送失败：' + e.message, 'red'); }
    dee.textContent = '立即发一封晚报';
  };
  const fs = $('#mb-files-save', el);
  if (fs) fs.onclick = () => savePrefs({ mobile_dir: val('#mb-mobile-dir') }, '办公本目录已保存');
  const icFields = () => ({
    icloud_user: val('#mb-icloud-user'),
    icloud_pass: val('#mb-icloud-pass'),
    icloud_host: val('#mb-icloud-host'),
    icloud_calendar: val('#mb-icloud-calendar'),
    icloud_time: val('#mb-icloud-time'),
    icloud_enabled: chk('#mb-icloud-enabled'),
  });
  const ics2 = $('#mb-icloud-save', el);
  if (ics2) ics2.onclick = () => savePrefs(icFields(), 'iCloud 设置已保存');
  const ict = $('#mb-icloud-test', el);
  if (ict) ict.onclick = async () => {
    ict.textContent = '测试中…';
    try {
      const r = await api('POST', '/api/mobile/icloud/test', icFields());
      await refresh();
      if (r.ok) toast(`连接成功：${(r.calendars || []).length} 个日历${r.target_exists ? '，目标日历已存在' : '，目标日历会在首次同步时新建'}`, 'green');
      else toast('连接失败：' + (r.error || ''), 'red');
    } catch (e) { toast('连接失败：' + e.message, 'red'); }
    ict.textContent = '测试连接';
  };
  const icy = $('#mb-icloud-sync', el);
  if (icy) icy.onclick = async () => {
    icy.textContent = '同步中…';
    try {
      const r = await api('POST', '/api/mobile/icloud/sync', icFields());
      await refresh();
      if (r.ok) toast(`已同步：更新 ${r.pushed} 条，未变 ${r.unchanged} 条，删除 ${r.deleted} 条`, 'green');
      else toast('同步失败：' + (r.error || ''), 'red');
    } catch (e) { toast('同步失败：' + e.message, 'red'); }
    icy.textContent = '立即同步到 iCloud';
  };
  const fm = $('#mb-files-make', el);
  if (fm) fm.onclick = async () => {
    const r = await api('POST', '/api/mobile/files', {});
    toast(`已生成 ${r.written.length} 个文件（日历 ${r.ics_events} 条事件）`, 'green');
  };
  const od = $('#mb-open-dir', el);
  if (od) od.onclick = async () => {
    const dir = (DB.mobile && DB.mobile.prefs && DB.mobile.prefs.mobile_dir) || (DB.mobile && DB.mobile.mobile_dir_default) || '';
    if (!dir) return;
    try { await api('POST', '/api/mobile/open-folder', { dir }); toast('已打开：' + dir, 'green'); }
    catch (e) { toast('打开失败：' + e.message, 'red'); }
  };
  $$('[data-mb-copy]', el).forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.mbCopy); toast('已复制到剪贴板', 'green'); }
    catch { toast('复制失败，请手动选择输入框里的链接', 'red'); }
  });
  $$('[data-mb-open]', el).forEach((b) => b.onclick = async () => {
    try { await api('POST', '/api/open', { url: b.dataset.mbOpen }); toast('已在浏览器打开', 'green'); }
    catch (e) { toast('打开失败：' + e.message, 'red'); }
  });
}

// 课程资料自动同步卡片：Canvas 新文件 → 桌面课程资料 → 办公本 X5 / 邮件桥发信 + 每日清理历史记录。
function courseSyncCardHtml() {
  const cs = DB.course_sync || {};
  const c = cs.config || {};
  const h = c.history || {};
  const n = cs.counts || {};
  const last = c.last_result;
  const lastLine = last
    ? `${last.errors && last.errors.length ? '⚠️' : '✅'} 上次执行 ${fmtDT(last.at)}（${esc(last.trigger || '')}）`
      + ` · 下载 ${last.downloaded || 0} 份`
      + `（失败 ${last.download_failed || 0}）`
      + ` · 推进办公本 ${last.synced_to_device || 0} 份`
      + (last.emailed ? ` · 邮件${last.emailed.skipped ? `未重发（同一批已发过 ${last.emailed.count || 0} 份）` : last.emailed.ok ? `已发（${last.emailed.count || 0} 份 / 附件 ${last.emailed.attached || 0}）` : `失败：${esc(last.emailed.error || '')}`}` : '')
      + (last.errors && last.errors.length ? `<br />${last.errors.slice(0, 3).map((x) => '· ' + esc(x)).join('<br />')}` : '')
    : '还没有执行过';
  const dev = c.last_device;
  const deviceLine = dev
    ? `${dev.connected ? '🔌 上次检测：已连接' : '🔌 上次检测：未连接'}${dev.device ? `（${esc(dev.device)}）` : ''} · ${fmtDT(dev.at)}${dev.error ? ` · ${esc(dev.error)}` : ''}`
    : '还没有检测过办公本';
  const hp = h.last_result;
  const purgeLine = hp
    ? `上次清理 ${fmtDT(hp.at)}：删除 ${hp.total} 条（保留 ${hp.days} 天内的记录）`
    : '还没有清理过';
  const files = cs.files || [];
  const rows = files.filter((f) => f.status === 'downloaded' || f.status === 'error').slice(0, 8);
  return `
    <div class="card" id="course-sync-card">
      <h3>📥 课程资料自动同步 <span class="muted">Canvas 新文件 → 桌面课程资料 → 办公本 X5 / 邮件桥发信</span></h3>
      <div class="dim" style="margin-bottom:10px">
        Canvas 巡检发现<b>新文件</b>时：自动下载到「${esc(cs.root_label || c.root || '课程资料文件夹')}\\&lt;课程&gt;」，并<b>不再发 Bark 推送</b>；
        办公本插着就自动把 PDF 推进「书架」（.ipynb / .py / .m 这类代码文件不同步），没插着就交给本机的
        <b>邮件桥</b>发一封邮件（桥是可选的独立程序，没配也不影响别的功能）。
      </div>

      <div class="grid cols-2" style="gap:16px">
        <div>
          <div class="field">
            <label>课程资料文件夹 <span class="dim">（和「本机目录」共用同一处，选完立刻生效）</span></label>
     <input type="text" id="cs-root" value="${esc(c.root || '')}" placeholder="你的用户目录\\Desktop\\FA26课程资料" />
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:10px;margin-top:6px">
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="cs-enabled" ${c.enabled ? 'checked' : ''} style="width:auto" />启用（下载新文件）
            </label>
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="cs-workbook" ${c.workbook_enabled ? 'checked' : ''} style="width:auto" />连上办公本时同步 PDF
            </label>
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="cs-email" ${c.email_enabled ? 'checked' : ''} style="width:auto" />未连接时交给邮件桥发信
            </label>
          </div>
          <div class="field-row" style="margin-top:8px">
            <div class="field">
              <label>办公本设备名匹配</label>
              <input type="text" id="cs-device" value="${esc(c.device_pattern || '*AiNote*')}" />
            </div>
            <div class="field">
              <label>推进到哪个容器</label>
              <input type="text" id="cs-container" value="${esc(c.workbook_container || '书架')}" />
            </div>
          </div>
        </div>

        <div>
          <div class="field-row">
            <div class="field">
              <label>邮件桥目录 <span class="dim">（没配就只跳过发信）</span></label>
              <input type="text" id="cs-mail-bridge-dir" value="${esc(c.mail_bridge_dir || (DB.paths && DB.paths.mail_bridge_dir_default) || '')}" />
            </div>
            <div class="field">
              <label>收件人（留空＝邮件桥白名单里的地址）</label>
              <input type="text" id="cs-email-to" value="${esc(c.email_to || '')}" placeholder="留空即可" />
            </div>
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:10px;margin-top:6px">
            <label class="dim" style="display:flex;align-items:center;gap:6px">
              <input type="checkbox" id="cs-attach" ${c.email_attach ? 'checked' : ''} style="width:auto" />邮件附带 PDF
            </label>
            <label class="dim" style="margin:0 4px">附件上限</label>
            <input type="number" id="cs-attach-max" min="1" max="200" step="1" value="${esc(String(c.email_attach_max_mb || 15))}" style="width:80px" />
            <span class="dim">MB</span>
          </div>
          <div class="flex" style="flex-wrap:wrap;gap:8px;margin-top:10px">
            <button class="btn primary small" id="cs-save">保存</button>
            <button class="btn small" id="cs-run">立即执行一次</button>
            <button class="btn small" id="cs-probe">检测办公本</button>
            <button class="btn small" id="cs-mail-test">测试邮件通道</button>
            <button class="btn small" id="cs-rename-preview">统一命名（预览）</button>
            <button class="btn small" id="cs-rename">统一命名（执行）</button>
          </div>
          <div class="dim" style="margin-top:6px">统一命名规则：<code>${esc(cs.name_template || 'FA26_<课程号>_Week<n>_<文件名>')}</code>——<code>{周次}</code> 是材料在 Canvas 上所属的学期周（第 1 周 = 2026-09-14），文件名里教授自己写的课程号（如 <code>math186</code>）会被去掉，学院口径材料没有周次；桌面与办公本一起改。想换一种叫法：课程辅助页右上角 <b>⚙ 功能设置</b>。</div>
          <div class="dim" style="margin-top:8px">${lastLine}</div>
          <div class="dim" style="margin-top:4px">${deviceLine}</div>
          <div class="dim" style="margin-top:4px">
            台账 ${n.files || 0} 份 · 已下载 ${n.downloaded || 0} · 待进办公本 ${n.pending_device || 0} · 已在办公本 ${n.on_device || 0} · 失败 ${n.failed || 0}
          </div>
        </div>
      </div>

      ${rows.length ? `
      <div style="margin-top:12px">
        ${rows.map((f) => `
          <div class="list-item">
            <span class="pill ${f.status === 'downloaded' ? (f.device_status === 'synced' ? 'status' : 'pending') : 'p0'}">
              ${f.status === 'downloaded' ? (f.device_status === 'synced' ? '已在办公本' : '待进办公本') : '下载失败'}
            </span>
            <div class="title">${esc(f.filename)}</div>
            <div class="meta">${esc(f.course || f.course_code || '')} · ${esc(f.rel_path || '')}${f.error ? ` · ${esc(f.error)}` : ''}</div>
          </div>`).join('')}
      </div>` : ''}

      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
        <div class="dim" style="margin-bottom:6px"><b>🧹 每日清理历史记录</b>（删掉 Planner 里存在超过设定天数的旧记录；未来的提醒、未完成任务不动）</div>
        <div class="flex" style="flex-wrap:wrap;gap:10px;align-items:center">
          <label class="dim" style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="hs-enabled" ${h.enabled ? 'checked' : ''} style="width:auto" />每天自动清理
          </label>
          <label class="dim" style="margin:0 4px">保留</label>
          <input type="number" id="hs-days" min="1" max="365" step="1" value="${esc(String(h.days || 10))}" style="width:80px" />
          <span class="dim">天</span>
          <label class="dim" style="margin:0 4px 0 10px">时间</label>
          <input type="time" id="hs-time" value="${esc(h.time || '04:00')}" style="width:120px" />
        </div>
        <div class="flex" style="flex-wrap:wrap;gap:12px;margin-top:8px">
          <label class="dim" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="hs-notif" ${h.notifications !== false ? 'checked' : ''} style="width:auto" />已触发的通知</label>
          <label class="dim" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="hs-conn" ${h.connector_data !== false ? 'checked' : ''} style="width:auto" />数据源导入条目</label>
          <label class="dim" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="hs-dismissed" ${h.dismissed !== false ? 'checked' : ''} style="width:auto" />已删通知的标记</label>
          <label class="dim" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="hs-focus" ${h.focus !== false ? 'checked' : ''} style="width:auto" />专注记录</label>
          <label class="dim" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="hs-done" ${h.done_tasks ? 'checked' : ''} style="width:auto" />已完成任务</label>
        </div>
        <div class="flex" style="flex-wrap:wrap;gap:8px;margin-top:8px">
          <button class="btn small" id="hs-save">保存清理设置</button>
          <button class="btn small" id="hs-purge">立即清理一次</button>
          <span class="dim">${purgeLine}</span>
        </div>
      </div>
    </div>`;
}

function bindCourseSyncCard(el) {
  const val = (sel) => { const n = $(sel, el); return n ? n.value.trim() : ''; };
  const chk = (sel) => { const n = $(sel, el); return n ? n.checked : false; };
  const fields = () => ({
    enabled: chk('#cs-enabled'),
    root: val('#cs-root'),
    workbook_enabled: chk('#cs-workbook'),
    email_enabled: chk('#cs-email'),
    device_pattern: val('#cs-device') || '*AiNote*',
    workbook_container: val('#cs-container') || '书架',
    mail_bridge_dir: val('#cs-mail-bridge-dir') || (DB.paths && DB.paths.mail_bridge_dir_default) || '',
    email_to: val('#cs-email-to'),
    email_attach: chk('#cs-attach'),
    email_attach_max_mb: Number(val('#cs-attach-max')) || 15,
  });
  const history = () => ({
    enabled: chk('#hs-enabled'),
    days: Number(val('#hs-days')) || 10,
    time: val('#hs-time') || '04:00',
    notifications: chk('#hs-notif'),
    connector_data: chk('#hs-conn'),
    dismissed: chk('#hs-dismissed'),
    focus: chk('#hs-focus'),
    done_tasks: chk('#hs-done'),
  });

  const save = $('#cs-save', el);
  if (save) save.onclick = async () => {
    // 2026-09-27：「课程资料放在哪」只有一处 —— 先写本机目录（和壁纸目录同一套，改完即时生效），
    // 再把其余设置交给 course-sync；root 只作为老装机的兼容镜像（清空 = 回到默认）。
    const f = fields();
    try {
      await api('POST', '/api/localdirs', { key: 'course', dir: f.root });
      await api('POST', '/api/course-sync', { ...f, root: f.root, history: history() });
      await refresh();
      toast(f.root ? `课程资料文件夹：${f.root}` : '已清空课程资料文件夹（回到桌面默认）', 'green');
    } catch (e) {
      toast('没保存上：' + (e.message || ''), 'red');
    }
  };
  const run = $('#cs-run', el);
  if (run) run.onclick = async () => {
    run.textContent = '执行中…';
    try {
      await api('POST', '/api/course-sync', fields());
      const r = await api('POST', '/api/course-sync/run', {});
      await refresh();
      const res = r.result || {};
      const bits = [`下载 ${res.downloaded || 0} 份`];
      if (res.skipped === 'disabled') bits.push('（自动同步已关闭）');
      if (res.synced_to_device) bits.push(`推进办公本 ${res.synced_to_device} 份`);
      if (res.emailed) bits.push(res.emailed.skipped ? '邮件：同一批已发过，未重复发送' : res.emailed.ok ? `邮件已发到 ${(res.emailed.to || []).join(', ')}` : `邮件失败：${res.emailed.error || ''}`);
      toast(bits.join(' · '), res.errors && res.errors.length ? 'red' : 'green');
    } catch (e) { toast('执行失败：' + e.message, 'red'); }
    run.textContent = '立即执行一次';
  };
  const probe = $('#cs-probe', el);
  if (probe) probe.onclick = async () => {
    probe.textContent = '检测中…';
    try {
      await api('POST', '/api/course-sync', fields());
      const r = await api('POST', '/api/course-sync/device', {});
      await refresh();
      if (r.connected && r.ok) toast(`办公本已连接：${r.device} · 「${r.container}」里有 ${(r.items || []).length} 个条目`, 'green');
      else if (r.connected) toast('设备连着，但读取失败：' + (r.error || ''), 'red');
      else toast('现在没检测到办公本（插上数据线后再试）', '');
    } catch (e) { toast('检测失败：' + e.message, 'red'); }
    probe.textContent = '检测办公本';
  };
  const mt = $('#cs-mail-test', el);
  if (mt) mt.onclick = async () => {
    mt.textContent = '测试中…';
    try {
      await api('POST', '/api/course-sync', fields());
      const r = await api('POST', '/api/course-sync/mail-bridge-test', { send: true });
      await refresh();
      if (r.ok && r.sent) toast(`测试邮件已通过邮件桥发出 → ${(r.recipients || []).join(', ')}`, 'green');
      else toast('邮件通道失败：' + (r.error || '请检查邮件桥配置'), 'red');
    } catch (e) { toast('邮件通道失败：' + e.message, 'red'); }
    mt.textContent = '测试邮件通道';
  };
  const hs = $('#hs-save', el);
  if (hs) hs.onclick = async () => {
    await api('POST', '/api/course-sync', { history: history() });
    await refresh();
    toast('每日清理设置已保存', 'green');
  };
  const hp = $('#hs-purge', el);
  if (hp) hp.onclick = async () => {
    if (!confirm('立即删除超过设定天数的历史记录？此操作不可撤销。')) return;
    hp.textContent = '清理中…';
    try {
      await api('POST', '/api/course-sync', { history: history() });
      const r = await api('POST', '/api/history/purge', {});
      await refresh();
      toast(`已清理 ${r.total || 0} 条（通知 ${r.notifications || 0} · 导入条目 ${r.connector_data || 0} · 专注 ${r.focus || 0}${r.done_tasks ? ` · 已完成任务 ${r.done_tasks}` : ''}）`, 'green');
    } catch (e) { toast('清理失败：' + e.message, 'red'); }
    hp.textContent = '立即清理一次';
  };
  const rp = $('#cs-rename-preview', el);
  if (rp) rp.onclick = async () => {
    rp.textContent = '预览中…';
    try {
      const r = await api('POST', '/api/course-sync/rename', { dry_run: true });
      const ren = (r.desktop && r.desktop.renamed) || [];
      const dev = (r.device && r.device.renamed) || [];
      const preview = ren.slice(0, 6).map((x) => `${x.from} → ${x.to}`).join('\n');
      toast(`要改 ${ren.length} 个桌面文件、${dev.length} 个办公本条目`, 'green');
      if (ren.length) alert(`预览（前 6 条）：\n${preview}${ren.length > 6 ? `\n…还有 ${ren.length - 6} 条` : ''}\n\n办公本侧：${dev.length} 个条目会改名（新名重新导入后删掉旧条目）。\n\n确认无误后点「统一命名（执行）」。`);
    } catch (e) { toast('预览失败：' + e.message, 'red'); }
    rp.textContent = '统一命名（预览）';
  };
  const rn = $('#cs-rename', el);
  if (rn) rn.onclick = async () => {
    const rule = (DB.course_sync && DB.course_sync.name_template) || 'FA26_<课程号>_Week<n>_<文件名>';
    if (!confirm(`按 ${rule} 重命名桌面与办公本上的课程文件？\n（桌面直接改名；办公本会按新名重新导入并删掉旧条目，过程中可能弹出确认框会自动处理）`)) return;
    rn.textContent = '执行中…';
    try {
      const r = await api('POST', '/api/course-sync/rename', {});
      await refresh();
      const ren = (r.desktop && r.desktop.renamed) || [];
      const moved = (r.desktop && r.desktop.moved) || [];
      const dev = (r.device && r.device.renamed) || [];
      const fails = [...((r.desktop && r.desktop.renamed) || []).filter((x) => x.error), ...((r.device && r.device.failed) || [])];
      toast(`桌面改名 ${ren.length} · 挪走重复 ${moved.length} · 办公本改名 ${dev.length}${fails.length ? ` · 失败 ${fails.length}` : ''}`, fails.length ? 'red' : 'green');
    } catch (e) { toast('执行失败：' + e.message, 'red'); }
    rn.textContent = '统一命名（执行）';
  };
}

// #region connectors-selection —— 「数据源」视图的数据来源（A3，2026-09-20）
// 与 today/tasks/notifications/calendar-month 同一套做法：默认向 ViewModel 层要数据
// （public\viewmodel.js 的 connectorsSelection），模块没加载 / ?vm=0 时回退到下面这份
// 等价实现。**只换「读哪些数据源、各多少条、什么状态、表单已填什么」**；
// 输入框、按钮、点击行为仍由 renderConnectors() 自己拼，外观零变化。
function legacyConnectorsSelection() {
  const meta = DB.connectors?.meta || [];
  const configs = DB.connectors?.configs || [];
  const counts = DB.connectors?.counts || {};
  const cfgOf = (id) => configs.find((c) => c.source === id);
  const savedCfg = (id) => { const c = cfgOf(id); try { return c ? JSON.parse(c.config_json || '{}') : {}; } catch { return {}; } };
  return {
    list: meta.map((m) => {
      const cfg = cfgOf(m.id);
      const status = cfg?.status || 'never';
      return {
        id: m.id,
        name: m.name,
        icon: m.icon,
        description: m.description || '',
        fields: Array.isArray(m.fields) ? m.fields : [],
        count: counts[m.id] || 0,
        status,
        statusCls: status === 'ok' || status === 'demo' || status === 'configured' ? 'status' : status === 'error' ? 'p0' : 'off',
        lastError: cfg?.last_error || null,
        savedCfg: savedCfg(m.id),
      };
    }),
  };
}

function connectorsSelectionFromVM() {
  return { list: window.PlannerVM.connectorsSelection(DB).list };
}

function connectorsSelectionFor() {
  return vmTodayEnabled() ? connectorsSelectionFromVM() : legacyConnectorsSelection();
}
// #endregion connectors-selection

// #region hub-selection —— 「首页 / 主菜单」的数据来源（R4，2026-09-21）
// 与 today/tasks/notifications/connectors 同一套做法：默认向 ViewModel 层要
// 「导航表 + 当前高亮项」（public\viewmodel.js 的 hubSelection），模块没加载 / ?vm=0
// 时回退到下面这份等价实现。**只换取数**：按钮、点击、双段式进入动画仍在 renderHub() 里。
// 这一处顺带证明一件事：**导航本身也是数据**，不是写死在 HTML 里的九个按钮。
function legacyHubSelection() {
  return {
    items: MODULES.map((m, i) => ({
      tab: m.tab, icon: m.ico || '',
      name: lang === 'en' ? m.en : m.name,
      sub: lang === 'en' ? m.ensub : m.sub,
      active: m.tab === hubCursor,
      order: i,
    })),
    cursor: hubCursor,
    lang,
    count: MODULES.length,
  };
}

function hubSelectionFromVM() {
  return window.PlannerVM.hubSelection(null, { cursor: hubCursor, lang, modules: MODULES });
}

function hubSelectionFor() {
  return vmTodayEnabled() ? hubSelectionFromVM() : legacyHubSelection();
}
// #endregion hub-selection

// #region habits-selection —— 「养成」的数据来源（R4，2026-09-21）
// 倒计时、7 日打卡格子、番茄分钟数都从这里来；renderHabits() 只管把它们画出来。
function legacyHabitsSelection() {
  const habits = DB.habits || [];
  const logs = DB.habit_logs || [];
  const milestones = DB.milestones || [];
  const ins = DB.insights || {};
  const lastDays = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86400000));
  const streaks = ins.habits?.streaks || [];
  const streakOf = (h) => (streaks.find((s) => s.id === h.id)?.streak) || 0;
  const doneSet = (h, d) => logs.some((l) => l.habit_id === h.id && l.date === hk(d) && l.done);
  const countdowns = milestones.filter((m) => !m.done).slice(0, 4).map((m) => ({
    id: m.id, title: m.title, targetAt: m.target_at, daysLeft: daysUntil(m.target_at),
  }));
  return {
    countdowns,
    hasCountdowns: countdowns.length > 0,
    habits: habits.map((h) => ({
      id: h.id, name: h.name, icon: h.icon, color: h.color, streak: streakOf(h),
      days: lastDays.map((d) => ({ date: hk(d), day: d.getDate(), done: doneSet(h, d) })),
    })),
    emptyHabits: habits.length === 0,
    todayDone: ins.habits?.todayDone || 0,
    total: habits.length,
    focus: { today: ins.focus?.today || 0, week: ins.focus?.week || 0 },
  };
}

function habitsSelectionFromVM() {
  return window.PlannerVM.habitsSelection(DB);
}

function habitsSelectionFor() {
  return vmTodayEnabled() ? habitsSelectionFromVM() : legacyHabitsSelection();
}
// #endregion habits-selection

// #region stats-selection —— 「统计」的数据来源（R4，2026-09-21）
// 汇总数字由服务端算（DB.insights），这里只决定「哪些数字上哪张卡、近 7 日柱子多高」。
function legacyStatsSelection() {
  const ins = DB.insights || {};
  const tasksD = ins.tasks || {};
  const focusD = ins.focus || {};
  const habD = ins.habits || {};
  const nextCd = ins.milestone || ins.exam || null;
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86400000));
  const dayOf = (iso) => hk(new Date(iso));
  const week = days.map((d) => {
    const k = dayOf(d);
    const tDone = DB.tasks.filter((t) => t.status === 'done' && t.updated_at && dayOf(t.updated_at) === k).length;
    const fMin = DB.focus.filter((f) => dayOf(f.started_at) === k).reduce((a, f) => a + f.minutes, 0);
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, tDone, fMin };
  });
  const maxF = Math.max(1, ...week.map((w) => w.fMin));
  const maxT = Math.max(1, ...week.map((w) => w.tDone));
  return {
    semesterWeek: ins.semesterWeek || null,
    nextCountdown: nextCd ? { title: nextCd.title, daysLeft: nextCd.daysLeft } : null,
    tasks: tasksD,
    focus: focusD,
    habits: habD,
    week,
    focusBars: week.map((w) => ({ ...w, heightPct: Math.round(w.fMin / maxF * 100) })),
    taskBars: week.map((w) => ({ ...w, heightPct: Math.round(w.tDone / maxT * 100) })),
    streaks: habD.streaks || [],
  };
}

function statsSelectionFromVM() {
  return window.PlannerVM.statsSelection(DB);
}

function statsSelectionFor() {
  return vmTodayEnabled() ? statsSelectionFromVM() : legacyStatsSelection();
}
// #endregion stats-selection

// #region music-selection —— 「本地音乐」的数据来源（R4，2026-09-21）
// 浏览器直接选文件夹（本地对象 URL）优先于服务端扫描结果 —— 这个优先级在这里定。
function legacyMusicSelection() {
  const m = DB.music || { dir: '', tracks: [], scanned_at: 0 };
  const usingLocal = localMusicTracks.length > 0;
  const tracks = usingLocal ? localMusicTracks : (m.tracks || []);
  return {
    dir: m.dir || '',
    tracks,
    usingLocal,
    count: tracks.length,
    scannedAt: m.scanned_at || 0,
    empty: tracks.length === 0,
    status: tracks.length
      ? `已收录 ${tracks.length} 首${usingLocal ? '（本地直接读取）' : ''}`
      : '尚未扫描到歌曲——设置文件夹后点「扫描」,或直接「选择本机文件夹」',
  };
}

function musicSelectionFromVM() {
  return window.PlannerVM.musicSelection(DB, { localTracks: localMusicTracks });
}

function musicSelectionFor() {
  return vmTodayEnabled() ? musicSelectionFromVM() : legacyMusicSelection();
}
// #endregion music-selection

// #region codex-selection —— 「数据源 / Codex」的数据来源（R4，2026-09-21）
// 「连没连上、几条自动化在跑、计划导到哪、问答记录」都从这里来。
function legacyCodexSelection() {
  const c = DB.codex || { connected: false, home: null, automations: [], error: null, synced_at: 0 };
  const home = DB.codex_home || c.home;
  const automations = (c.automations || []).map((a) => ({
    id: a.id, name: a.name, prompt: a.prompt || '', kind: a.kind, status: a.status,
    describe: a.describe || '', nextRunAt: a.next_run_at || null,
    statusLabel: a.status === 'ACTIVE' ? '运行中' : a.status === 'PAUSED' ? '已暂停' : String(a.status || ''),
    statusCls: a.status === 'ACTIVE' ? 'status' : a.status === 'PAUSED' ? 'status off' : (a.status === 'PARSE_ERROR' ? 'p0' : ''),
    active: a.status === 'ACTIVE',
  }));
  return {
    connected: !!c.connected,
    home: home || null,
    automations,
    automationTotal: automations.length,
    automationActive: automations.filter((a) => a.active).length,
    error: c.error || null,
    syncedAt: c.synced_at || 0,
    chat: { messages: chatLog, empty: chatLog.length === 0 },
    planExport: DB.plan_export || null,
    planPaths: (DB.plan_export && DB.plan_export.paths) || [],
  };
}

function codexSelectionFromVM() {
  return window.PlannerVM.codexSelection(DB, { chatLog });
}

function codexSelectionFor() {
  return vmTodayEnabled() ? codexSelectionFromVM() : legacyCodexSelection();
}
// #endregion codex-selection

// 「我关心什么」面板已搬进可插拔模块 modules/filter-profile/（W2）。
// 这里只保留模块加载器与挂载点 —— 见文件末尾的 loadModules / mountGadgets。

/** 待批准条目上的裁决徽章（悬停显示命中的规则）。 */
function verdictPill(p) {
  if (!p || !p.verdict) return '';
  const map = { push: ['自动', 'status'], review: ['待确认', 'pending'], drop: ['建议忽略', 'off'] };
  const pair = map[p.verdict] || [p.verdict, ''];
  const why = (() => {
    try {
      return (JSON.parse(p.reasons || '[]') || []).filter((r) => r.delta)
        .map((r) => `${r.rule} ${r.delta > 0 ? '+' : ''}${r.delta}`).join('，');
    } catch { return ''; }
  })();
  const score = Number.isFinite(p.score) ? ` ${p.score}` : '';
  return `<span class="pill ${pair[1]}" title="${esc(why || '没有命中任何规则')}">${pair[0]}${score}</span>`;
}

/** 待批准条目下的"为什么"一行（把命中的规则翻成人话）。 */
function verdictWhy(p) {
  try {
    const rs = (JSON.parse(p.reasons || '[]') || []).filter((r) => r.delta);
    if (!rs.length) return '';
    return `<div class="meta">为什么：${rs.map((r) => esc(r.note || r.rule)).join('；')}</div>`;
  } catch { return ''; }
}

function renderConnectors() {
  const el = $('#view-connectors');
  const meta = connectorsSelectionFor().list;
  const as = DB.auto_sync || { enabled: false, time: '08:00', connectors: {}, demo: false, last_run: null, last_result: null };
  const connIds = meta.map((m) => m.id);
  const asConn = (id) => (as.connectors || {})[id] || false;

  el.innerHTML = `
    <div class="dim" style="margin-bottom:16px">
      连接 Codex 已接入的数据源，把外部日程/任务导入到本应用。每个连接器可：<b>导入</b>（实时拉取）、<b>示例演示</b>（离线验证）、<b>推送到日程/任务</b>。
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3>⏰ 每日自动同步 <span class="muted">每天一次，补充外部信息，结果进入“待批准”</span></h3>
      <div class="between" style="flex-wrap:wrap;gap:12px">
        <div class="flex">
          <label class="dim" style="margin-right:6px">启用</label>
          <input type="checkbox" id="as-enabled" ${as.enabled ? 'checked' : ''} style="width:auto" />
          <label class="dim" style="margin:0 6px 0 14px">时间</label>
          <input type="time" id="as-time" value="${esc(as.time || '08:00')}" />
        </div>
        <div class="flex">
          ${connIds.map((id) => `<label class="dim" style="margin-right:8px;display:flex;align-items:center;gap:4px">
            <input type="checkbox" data-asconn="${id}" ${asConn(id) ? 'checked' : ''} style="width:auto" />${iconOf(id)}</label>`).join('')}
          <label class="dim" style="display:flex;align-items:center;gap:4px;margin-left:8px">
            <input type="checkbox" id="as-demo" ${as.demo ? 'checked' : ''} style="width:auto" />演示模式</label>
          <label class="dim" style="display:flex;align-items:center;gap:4px;margin-left:8px">
            <input type="checkbox" id="as-approve" ${as.auto_approve ? 'checked' : ''} style="width:auto" />自动批准</label>
        </div>
      </div>
      <div class="mgr-actions" style="margin-top:10px">
        <button class="btn primary small" id="as-save">保存</button>
        <button class="btn small" id="as-run">立即同步</button>
        <span class="dim">${as.last_run ? '上次：' + fmtFull(new Date(as.last_run).toISOString()) : '尚未运行'}${as.last_result ? ` · 共 ${as.last_result.total || 0} 条 / 推送 ${(as.last_result.pushed != null ? as.last_result.pushed : (as.last_result.results && Object.values(as.last_result.results).reduce((a, r) => a + (r.pushed || 0), 0) || 0))}` : ''}</span>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3>🛰️ 后台常驻 <span class="muted">关掉窗口也继续跑「提醒」与「Canvas 巡检」</span></h3>
      ${bgHtml()}
      <div class="flex" style="flex-wrap:wrap;gap:8px;margin-top:12px">
        <label class="dim" style="margin-right:6px">启用 Canvas 巡检</label>
        <input type="checkbox" id="cw-enabled" ${canvasWatch().enabled ? 'checked' : ''} style="width:auto" />
        <label class="dim" style="margin:0 6px 0 14px">间隔（小时）</label>
        <input type="number" id="cw-interval" min="1" max="72" step="1" value="${canvasWatch().interval_hours || 3}" style="width:88px" />
        <button class="btn small" id="cw-save">保存巡检设置</button>
        <button class="btn small" id="cw-run">立即巡检</button>
        <button class="btn small" id="bg-autostart">${DB.health?.autostart?.enabled ? '开机自启：已开启（点击关闭）' : '开机自启：未开启（点击开启）'}</button>
      </div>
    </div>

    ${mobileCardHtml()}
    ${courseSyncCardHtml()}

    <div class="card" style="margin-bottom:16px">
      <h3>📖 第一次配置？<span class="muted">先看教程，不用猜</span></h3>
      <div class="dim" style="margin-bottom:12px">
        每种数据源要准备什么、每个字段怎么填、报错是什么意思，教程里都写了。
        <b>不需要账号的四种</b>（RSS / 日历订阅 / JSON 接口 / 本地文件）建议先拿它们练手：
        只要一个网址或一个文件路径，不用申请任何凭据。
      </div>
      <div class="flex" style="flex-wrap:wrap;gap:8px">
        <a class="btn primary small" href="/docs/CONNECT_SOURCES.md" target="_blank" rel="noopener">打开《数据源配置教程》</a>
        <a class="btn small" href="/docs/" target="_blank" rel="noopener">全部文档</a>
      </div>
    </div>

    <div class="grid cols-3">
      ${meta.map((m) => {
        return `
          <div class="card conn-card" data-conn="${m.id}">
            <h3>${m.icon} ${m.name}
              <span class="muted">${m.count} 条</span>
              <span class="pill ${m.statusCls}">${statusLabel(m.status)}</span>
            </h3>
            <div class="dim" style="margin-bottom:12px">${esc(m.description)}</div>
            ${m.fields.map((f) => `
              <div class="field">
                <label>${esc(f.label)}${f.required ? ' *' : ''}</label>
                <input type="${f.type}" data-key="${f.key}" placeholder="${esc(f.placeholder || '')}" value="${esc(m.savedCfg[f.key] || '')}" />
              </div>`).join('')}
            <div class="flex" style="flex-wrap:wrap;gap:8px;margin-top:6px">
              <button class="btn primary small act-import">导入 / 同步</button>
              <button class="btn small act-demo">示例演示</button>
              <button class="btn small act-push" ${m.count ? '' : 'disabled'}>推送到日程/任务</button>
            </div>
            ${m.lastError ? `<div class="dim" style="margin-top:8px;color:var(--red)">⚠ ${esc(m.lastError)}</div>` : ''}
          </div>`;
      }).join('')}
    </div>
    <div class="card mt" id="conn-data">
      <h3>已导入数据</h3>
      <div class="empty">选择一个数据源导入后，这里展示条目。可在“日程/任务/通知”页看到推送结果。</div>
    </div>

    <div class="card mt" id="pending-box">
      <h3>🕑 待批准 <span class="muted">${DB.pending.length} 条来自自动同步的数据</span></h3>
      ${DB.pending.length ? DB.pending.map((p) => `
        <div class="list-item">
          <span class="pill ${p.kind === 'event' ? 'status' : p.kind === 'task' ? '' : 'pending'}">${({event:'日程',task:'任务',reminder:'提醒'})[p.kind] || p.kind}</span>
          ${verdictPill(p)}
          <div class="title">${esc(p.title)}</div>
<div class="meta">${p.start_at ? fmtDT(p.start_at) : p.due_at ? dueLabel(p.due_at) : ''} · ${esc(p.source)}</div>
          ${verdictWhy(p)}
          <div class="row-actions" style="margin-left:auto">
            <button class="btn small" data-push="${p.id}">批准并推送</button>
            <button class="btn small" data-pdel="${p.id}">删除</button>
          </div>
        </div>`).join('') : '<div class="empty">暂无待批准数据（自动同步结果会出现在这里）。</div>'}
    </div>
  `;

  $('#as-save').onclick = async () => {
    const connectors = {};
    $$('[data-asconn]', el).forEach((c) => { connectors[c.dataset.asconn] = c.checked; });
    const cfg = { enabled: $('#as-enabled').checked, time: $('#as-time').value, connectors, demo: $('#as-demo').checked, auto_approve: $('#as-approve').checked };
    await api('POST', '/api/sync', cfg);
    await refresh();
    toast('自动同步设置已保存', 'green');
  };
  $('#as-run').onclick = async () => {
    $('#as-run').textContent = '同步中…';
    const res = await api('POST', '/api/sync/run');
    await refresh();
    toast(`已拉取 ${res.total || 0} 条${res.pushed ? `，自动批准并推送 ${res.pushed} 条` : '，请到“待批准”确认'}`, 'green');
    $('#as-run').textContent = '立即同步';
  };
  $$('[data-push]', el).forEach((b) => b.onclick = async () => {
    const r = await api('POST', `/api/pending/${b.dataset.push}/push`);
    await refresh();
    toast('已批准并推送到日程/任务', 'green');
    if (r && r.learned) toast(`已学习：以后优先「${r.learned.label}」（你批准了 ${r.learned.count} 次）`, 'green');
  });
  $$('[data-pdel]', el).forEach((b) => b.onclick = async () => {
    const r = await api('POST', `/api/pending/${b.dataset.pdel}/delete`);
    await refresh();
    if (r && r.learned) toast(`已学习：以后忽略「${r.learned.label}」（你删了 ${r.learned.count} 次）`, 'green');
  });

  $$('.conn-card', el).forEach((card) => {
    const source = card.dataset.conn;
    const conn = meta.find((m) => m.id === source);
    const collect = () => {
      const config = {};
      $$(`input[data-key]`, card).forEach((inp) => { config[inp.dataset.key] = inp.value; });
      return config;
    };
    $('.act-import', card).onclick = () => importConnector(source, collect(), 'import');
    $('.act-demo', card).onclick = () => importConnector(source, {}, 'demo');
    const pushBtn = $('.act-push', card);
    pushBtn.onclick = () => pushConnector(source, pushBtn);
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      loadConnectorData(source);
    });
  });

  // ---- 后台常驻卡片：巡检开关 / 间隔 / 立即巡检 / 开机自启 ----
  const cwSave = $('#cw-save', el);
  if (cwSave) cwSave.onclick = async () => {
    await api('POST', '/api/canvas-watch', {
      enabled: $('#cw-enabled', el).checked,
      interval_hours: Number($('#cw-interval', el).value) || 3,
    });
    await refresh();
    toast('后台巡检设置已保存', 'green');
  };
  const cwRun = $('#cw-run', el);
  if (cwRun) cwRun.onclick = async () => {
    cwRun.textContent = '巡检中…';
    try {
      const r = await api('POST', '/api/canvas-watch/run');
      await refresh();
      toast(`Canvas 巡检完成：新增 ${(r.result && r.result.added) || 0} 条`, 'green');
    } catch (e) {
      toast('巡检失败：' + e.message, 'red');
      cwRun.textContent = '立即巡检';
    }
  };
  const bgAuto = $('#bg-autostart', el);
  if (bgAuto) bgAuto.onclick = async () => {
    try {
      const r = await api('POST', '/api/autostart', {});
      await refresh();
      if (r.ok === false) toast('开机自启设置失败：' + (r.error || '系统拒绝了写入'), 'red');
      else toast(r.enabled ? '已开启开机自启（下次开机自动后台运行）' : '已关闭开机自启', 'green');
    } catch (e) {
      toast('开机自启设置失败：' + e.message, 'red');
    }
  };
  bindMobileCard(el);
  bindCourseSyncCard(el);
  // 「课程资料自动同步」那一块现在住在「设置 → 数据源」里（见 settings/panel.js 的寄存逻辑）：
  // 每次重画后叫设置页把刚画好的这一份搬过去，不然设置页上停的是上一帧的旧卡片。
  try { if (typeof window.__cairnAdoptCourseSync === 'function') window.__cairnAdoptCourseSync(); } catch { /* 设置页还没开过就算了 */ }
  // 可插拔模块的挂载点（「我关心什么」就是第一个这样接进来的功能）
  mountGadgets('connectors').catch(() => {});
}

// ---------------- 模块系统（W2）----------------
// 「加一个功能 = 加一个目录 + 注册一行」：这里只做发现与挂载，具体内容在 modules/<id>/ 里。
let MODULE_REGISTRY = [];
let MODULES_LOADED = false;

/** 拉取模块清单，把 kind=view 的模块注册进导航。坏模块不会影响其它模块。 */
async function loadModules() {
  try {
    const r = await api('GET', '/api/modules');
    MODULE_REGISTRY = (r.modules || []).filter((m) => !m.error);
    for (const m of MODULE_REGISTRY) {
      if (m.kind === 'view' && !MODULES.some((x) => x.tab === m.id)) {
        MODULE_PAGES.push({ tab: m.id, ico: m.icon || '◆', name: m.name, en: m.name, sub: m.sub || '模块', ensub: 'MODULE', settings: m.settings === true });
        // 模块自带的一页：导航名与页面标题都跟着模块走（不然切过去标题是空的）
        for (const l of ['zh', 'en']) {
          if (TITLE_L[l] && !TITLE_L[l][m.id]) TITLE_L[l][m.id] = m.name;
          if (NAV_L[l] && !NAV_L[l][m.id]) NAV_L[l][m.id] = m.name;
        }
        const main = document.getElementById('main');
        if (main && !document.getElementById('view-' + m.id)) {
          const sec = document.createElement('section');
          sec.id = 'view-' + m.id;
          sec.className = 'view';
          main.appendChild(sec);
        }
      }
    }
    MODULES_LOADED = true;
    applyModuleLayout();          // 按用户挑的清单与顺序摆（没挑过就是全都要）
  } catch {
    MODULES_LOADED = false;   // 模块接口挂了不影响主功能
  }
}

/**
 * 把「核心页面 + 用户挑中的功能模块」拼成导航表（`MODULES`）。
 * 核心页面（今日 / 日程 / 任务 / 养成 / 通知 / 统计 / 数据源 / 音乐）永远都在 ——
 * 用户挑的是**功能模块**那一组；没勾的模块不进导航、主页上也不会出现。
 */
function applyModuleLayout() {
  // 核心页也参与筛选（除 ALWAYS_ON）；「设置」永远不进导航（它是右上角齿轮那一页）
  const core = CORE_PAGES.filter((m) => ALWAYS_ON.includes(m.tab)
    || !Array.isArray(UI_MODULES.enabled) || UI_MODULES.enabled.includes(m.tab));
  const sel = UI_MODULES.enabled;
  let pages = MODULE_PAGES.filter((p) => p.tab !== 'settings').slice();
  if (Array.isArray(sel)) pages = pages.filter((p) => sel.includes(p.tab));
  const order = Array.isArray(UI_MODULES.order) ? UI_MODULES.order : [];
  // 核心页也按 order 排（没进 order 的排在功能模块前面，保持原来的观感）
  const arranged = [...core, ...pages];
  MODULES.length = 0;
  MODULES.push(...arranged
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ia = order.indexOf(a.p.tab); const ib = order.indexOf(b.p.tab);
      return (ia < 0 ? 900 + a.i : ia) - (ib < 0 ? 900 + b.i : ib);
    })
    .map((x) => x.p));
}

/** 重新读一遍"主页要摆哪些功能"，然后重画导航与主页（向导里改完就调它）。 */
async function reloadModuleLayout() {
  try {
    const pf = await api('GET', '/api/prefs');
    UI_MODULES = (pf && pf.ui_modules) || { enabled: null, order: [] };
  } catch { /* 读不到就保持现状 */ }
  applyModuleLayout();
  if (typeof renderHub === 'function') renderHub();
  const tab = state.tab;
  if (tab && tab !== 'hub' && !MODULES.some((m) => m.tab === tab) && !['connectors', 'hub'].includes(tab)) {
    switchTab('hub');           // 当前停在一个已经被取消勾选的页面上 → 回主菜单
  }
}

/**
 * 把模块挂进指定视图（幂等：每次重画都重建容器内容）。两类：
 *   * `gadget`：别人页面上的**一块**（`mount_into` 指名挂到哪，例如 today / connectors）；
 *   * `view`  ：模块**自己的一页**（`id` 就是那个页面，导航里与今日/通知/音乐并列）——
 *               以前这里只会给它建一个空壳页面，2026-09-24 补上真正的挂载，
 *               并且是"切过去才 import"，启动不为它多花时间。
 */
async function mountGadgets(viewId) {
  // 服务刚重启时，模块可能取不到；浏览器还会把"这次失败"记一辈子 ⇒ 用一个自增值把地址换掉再取。
  if (typeof MOD_CACHE_BUST !== 'number') globalThis.MOD_CACHE_BUST = 0;
  const host = document.getElementById('view-' + viewId);
  if (!host) return;
  const targets = MODULE_REGISTRY.filter((x) => (x.kind === 'gadget' && x.mount_into === viewId)
    || (x.kind === 'view' && x.id === viewId));
  for (const m of targets) {
    let box = document.getElementById('module-' + m.id);
    if (!box) {
      box = document.createElement('div');
      box.id = 'module-' + m.id;
      host.appendChild(box);
    }
    try {
      // 带版本号导入：浏览器的模块缓存按 URL 认，**不加版本号的话"改了模块但页面还跑旧代码"**
      // （2026-09-25 实测踩到：服务端已经在发新内容、还带 no-store，页面仍旧跑旧模块）。
      // 现在改完模块把 module.json 的 version 提一位，插件的页面就会立刻刷新。
      // 版本号 = 声明版本 + **入口文件的修改时间**（改完文件 mtime 就变，缓存自动失效，不用记得手动提版本）
      // 取模块：失败**重试一次**（服务刚重启时会取不到，浏览器还会把这次失败记一辈子，
      // 于是页面就永远显示"模块加载失败"——重试一次就能自愈）。
      const modUrl = '/modules/' + m.id + '/' + m.entry.view + '?v=' + encodeURIComponent((m.version || '0') + '-' + (m.mtime || 0))
        + (globalThis.MOD_CACHE_BUST ? '&r=' + globalThis.MOD_CACHE_BUST : '');
      const mod = await import(modUrl).catch(async () => {
        await new Promise((r) => setTimeout(r, 800));
        return import(modUrl + '&r=' + Date.now());
      });
      // nav：给模块一个"切到某个页面"的正规出口（入门卡用它跳去「数据源」）
      await mod.mount(box, moduleCtx());
    } catch (e) {
      // 取不到时给一颗「重试加载」——多半是后台服务刚重启/没在跑，换掉缓存地址再取一次就好
      box.innerHTML = `<div class="card mt"><h3>${esc(m.name)}</h3>
        <div class="dim">模块加载失败：${esc(e.message)}</div>
        <div class="dim" style="margin-top:6px">多半是后台服务刚重启、或者没在跑（托盘 / 启动后台.cmd）。</div>
        <button class="btn small" style="margin-top:8px" data-mod-retry="${esc(m.id)}">重新加载这一页</button></div>`;
      const btn = box.querySelector('[data-mod-retry]');
      if (btn) btn.onclick = () => {
        globalThis.MOD_CACHE_BUST = (globalThis.MOD_CACHE_BUST || 0) + 1;
        box.innerHTML = '<div class="dim">正在重新加载…</div>';
        mountGadgets(viewId);
      };
    }
  }
}

/**
 * 模块上下文：所有挂载点共用一份，免得某个入口漏字段（2026-09-26 就漏过 pickablePages）。
 */
function moduleCtx() {
  return {
    api, esc, toast, refresh, DB, state, nav: switchTab,
    pickablePages: pickablePages(), applyLayout: reloadModuleLayout,
    mountWallpaper: mountWallpaperPanel,
    mountProfile: (host) => mountModuleById(host, 'filter-profile'),
    // 通用出口：设置页要把原来挂在"数据源"页上的那几块（连接向导 / Agent 接入 / 摘要预览）接回来
    mountModule: (host, id) => mountModuleById(host, id),
    // 功能改完自己的设置后重画自己那一页（抽屉改了命名模板 → 页面上那行规则要跟着变）
    reloadPage: (id) => mountGadgets(id),
  };
}

/**
 * 把**某个模块**挂进任意容器（设置页要用：设置 → 分析偏好 挂的就是 filter-profile 那块）。
 * 版本号带入口文件 mtime ⇒ 改了模块文件、刷新页面就生效，不用手动提版本。
 */
async function mountModuleById(host, id) {
  if (!host) return null;
  const m = MODULE_REGISTRY.find((x) => x.id === id);
  if (!m || !m.entry || !m.entry.view) {
    host.innerHTML = `<div class="empty">没找到模块 ${esc(id)}</div>`;
    return null;
  }
  try {
    const mod = await import('/modules/' + m.id + '/' + m.entry.view + '?v=' + encodeURIComponent((m.version || '0') + '-' + (m.mtime || 0)));
    if (typeof mod.mount === 'function') await mod.mount(host, moduleCtx());
    return mod;
  } catch (e) {
    host.innerHTML = `<div class="empty">模块载入失败：${esc((e && e.message) || '')}</div>`;
    return null;
  }
}

// ---------------- 功能自己的设置（「⚙ 功能设置」抽屉，2026-09-27） ----------------
// 用户的判据：「谁的东西放在谁的页面上」——设置页只留一行指路，细项在功能页右上角改。
// 三件事：① 只有 module.json 里声明了 `settings: true` 的功能才出现按钮；
//         ② 抽屉是**覆盖式**的（贴右边 360px，画面不重排）；
//         ③ 抽屉里的内容由模块自己的 `settings(host, ctx)` 画 —— 主程序不认识"命名模板"这种东西。

/**
 * 这一页上**有专属设置**的模块（2026-09-28 推广到 gadget）。
 *
 * 以前只认 `kind: view` 且"模块 id 正好等于页名"的那种（课程辅助）；挂在页面里的卡片
 * （DDL 提醒 → 任务页、上课前检查 → 今日页）即便声明了 settings 也拿不到齿轮。
 * 现在两种都收：view 看 id，gadget 看它 `mount_into` 哪一页。
 */
function pageSettingsModules(tab) {
  return MODULE_REGISTRY.filter((x) => {
    if (x.settings !== true) return false;
    if (x.kind === 'view') return x.id === tab;
    return x.mount_into === tab;
  });
}

/** 页头右上角那颗按钮（这一页没有任何"有专属设置"的功能时，这里是空的）。 */
function renderPageActions(tab) {
  const box = document.getElementById('page-actions');
  if (!box) return;
  box.innerHTML = '';
  const list = pageSettingsModules(tab);
  if (!list.length) return;
  const m = list[0];
  if (!m || m.settings !== true) return;
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.id = 'page-fn-settings';
  btn.title = list.length === 1
    ? `只在「${m.name}」里生效的设置`
    : `这一页上 ${list.length} 个功能的设置：${list.map((x) => x.name).join(' / ')}`;
  btn.textContent = '⚙ 功能设置';
  btn.onclick = () => openFunctionDrawer(list.map((x) => x.id));
  box.appendChild(btn);
}

/** 抽屉的骨架（只建一次；关闭是 class 切换，不销毁内容）。 */
function fnDrawerEls() {
  let backdrop = document.getElementById('fn-drawer-backdrop');
  let drawer = document.getElementById('fn-drawer');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'fn-drawer-backdrop';
    backdrop.className = 'fn-drawer-backdrop';
    backdrop.onclick = () => closeFunctionDrawer();
    document.body.appendChild(backdrop);
  }
  if (!drawer) {
    drawer = document.createElement('aside');
    drawer.id = 'fn-drawer';
    drawer.className = 'fn-drawer';
    drawer.innerHTML = '<div class="fn-drawer-head">'
      + '<div class="fn-drawer-title" id="fn-drawer-title">功能设置</div>'
      + '<button class="icon-btn" id="fn-drawer-close" title="关闭">✕</button></div>'
      + '<div class="fn-drawer-body" id="fn-drawer-body"></div>';
    document.body.appendChild(drawer);
    const close = document.getElementById('fn-drawer-close');
    if (close) close.onclick = () => closeFunctionDrawer();
    // Esc 关抽屉。**必须用捕获阶段 + stopPropagation**：主程序自己也有一个
    // 「Esc → 回主菜单」的快捷键，不拦一下的话关抽屉会顺带把你踢回主菜单。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !drawer.classList.contains('open')) return;
      e.stopPropagation();
      closeFunctionDrawer();
    }, true);
  }
  return {
    backdrop, drawer,
    body: document.getElementById('fn-drawer-body'),
    title: document.getElementById('fn-drawer-title'),
  };
}

function closeFunctionDrawer() {
  const { backdrop, drawer } = fnDrawerEls();
  backdrop.classList.remove('open');
  drawer.classList.remove('open');
}

/**
 * 打开抽屉：取每个功能的 `settings(host, ctx)` 画内容。
 *
 * 参数收数组（2026-09-28）：一页上可能有好几个功能都有设置（今日页有"上课前检查"，
 * 任务页有"DDL 提醒"），抽屉就按功能分段显示 —— 段标题用模块自己的名字与图标。
 */
async function openFunctionDrawer(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
    .map((id) => MODULE_REGISTRY.find((x) => x.id === id))
    .filter((m) => m && m.entry && m.entry.view);
  const { backdrop, drawer, body, title } = fnDrawerEls();
  if (!list.length) return;
  title.textContent = list.length === 1 ? `${list[0].name} · 设置` : '这一页的功能设置';
  body.innerHTML = '<div class="dim">正在打开…</div>';
  backdrop.classList.add('open');
  drawer.classList.add('open');
  body.innerHTML = '';
  for (const m of list) {
    const sec = document.createElement('section');
    sec.className = 'fn-drawer-section';
    if (list.length > 1) {
      const h = document.createElement('div');
      h.className = 'fn-section-title';
      h.textContent = `${m.icon || ''} ${m.name}`.trim();
      sec.appendChild(h);
    }
    const slot = document.createElement('div');
    slot.className = 'fn-drawer-slot';
    slot.innerHTML = '<div class="dim">正在打开…</div>';
    sec.appendChild(slot);
    body.appendChild(sec);
    try {
      const modUrl = '/modules/' + m.id + '/' + m.entry.view + '?v=' + encodeURIComponent((m.version || '0') + '-' + (m.mtime || 0))
        + (globalThis.MOD_CACHE_BUST ? '&r=' + globalThis.MOD_CACHE_BUST : '');
      const mod = await import(modUrl).catch(async () => {
        await new Promise((r) => setTimeout(r, 800));
        return import(modUrl + '&r=' + Date.now());
      });
      slot.innerHTML = '';
      if (typeof mod.settings === 'function') await mod.settings(slot, moduleCtx());
      else slot.innerHTML = '<div class="empty">这个功能声明了有专属设置，但组件没有导出 settings(host, ctx)。</div>';
    } catch (e) {
      slot.innerHTML = `<div class="empty">打不开设置：${esc((e && e.message) || '')}</div>`;
    }
  }
}

/** 实例 id → 类型（`rss@2` → `rss`）。与 lib/connectors/instances.mjs 同一约定。 */
const instanceTypeOf = (id) => { const s = String(id || ''); const i = s.indexOf('@'); return i < 0 ? s : s.slice(0, i); };

function iconOf(id) {
  const t = instanceTypeOf(id);                 // 条目上挂的是实例 id，图标看类型
  const map = { feishu: '💬', canvas: '🎓', email: '📧', email_sjtu: '🏫' };
  if (map[t]) return map[t];
  const m = (DB.connectors?.meta || []).find((x) => x.id === t);
  return (m && m.icon) || id;
}

async function loadConnectorData(source) {
  const box = $('#conn-data');
  box.innerHTML = '<div class="empty">加载中…</div>';
  const res = await api('GET', `/api/connectors/${source}`);
  const items = res.data || [];
  const kindLabel = { event: '日程', task: '任务', reminder: '提醒' };
  box.innerHTML = `
    <div class="between" style="margin-bottom:10px">
      <h3 style="margin:0">${res.meta.icon} ${res.meta.name} · 已导入 ${items.length} 条</h3>
      <button class="btn small act-push2" ${items.length ? '' : 'disabled'}>推送到日程/任务</button>
    </div>
    ${items.length ? `
      <table class="table">
        <thead><tr><th>类型</th><th>标题</th><th>时间</th><th>来源</th></tr></thead>
        <tbody>
          ${items.map((it) => `
            <tr>
              <td><span class="pill ${it.kind === 'event' ? 'status' : it.kind === 'task' ? '' : 'pending'}">${kindLabel[it.kind] || it.kind}</span></td>
              <td>${esc(it.title)}${it.url ? `<div class="dim"><a href="${esc(it.url)}" target="_blank">打开原文</a></div>` : ''}</td>
<td>${it.start_at ? fmtDT(it.start_at) : it.due_at ? dueLabel(it.due_at) : '—'}</td>
              <td>${it.url ? '<span class="pill src">外部</span>' : '<span class="pill src">' + esc(source) + '</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
      : '<div class="empty">暂无数据，先点上方“示例演示”或“导入”。</div>'}
  `;
  $('.act-push2', box).onclick = () => pushConnector(source, $('.act-push2', box));
}

function statusLabel(s) {
  return ({ ok: '已同步', demo: '示例', error: '失败', never: '未连接', configured: '已配置' })[s] || s;
}

async function importConnector(source, config, mode) {
  toast(`正在${mode === 'demo' ? '生成示例' : '导入'} ${source}…`);
  try {
    const path = mode === 'demo' ? `/api/connectors/${source}/demo` : `/api/connectors/${source}/import`;
    const res = await api('POST', path, mode === 'demo' ? {} : { config });
    await refresh();
    if (res.error) toast(`导入失败：${res.error}`, 'red');
    else toast(`已导入 ${res.inserted} 条`, 'green');
  } catch (e) {
    toast('导入失败：' + e.message, 'red');
  }
  renderConnectors();
}

async function pushConnector(source, btn) {
  btn.textContent = '推送中…';
  try {
    const res = await api('POST', `/api/connectors/${source}/push`);
    await refresh();
    toast(`已推送 ${res.pushed} 条到日程/任务`, 'green');
  } catch (e) {
    toast('推送失败：' + e.message, 'red');
  }
  btn.textContent = '推送到日程/任务';
  renderConnectors();
}

// ---------------- Modal ----------------
let modalType = null;
let modalId = null;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function openModal(type, item) {
  modalType = type;
  // 新建时会传一个"预填值"对象（例如 { weekday: 1 }、{ kind: 'holiday' }），它**没有 id** ——
  // 所以判断"是不是编辑"要看有没有 id，不能只看有没有传对象（2026-09-27 修：以前新建课程/校历
  // 会显示成"编辑"，还会冒出一个删不掉的「🗑 删除」按钮）。
  const isNew = !(item && item.id);
  modalId = isNew ? null : item.id;
  const titles = { task: '任务', event: '日程', notif: '提醒', course: '课程', academic: '校历事项' };
  const isQuick = type === 'quick';
  $('#modal-title').textContent = isQuick ? '快速添加' : `${isNew ? '新建' : '编辑'}${titles[type] || ''}`;
  $('#modal-body').innerHTML = buildForm(type, item);
  const delBtn = $('#modal-delete');
  if (delBtn) delBtn.style.display = (!isNew && ['task', 'event', 'notif', 'course', 'academic'].includes(type)) ? '' : 'none';
  // 「快速添加」是个类型选择器，没有要保存的字段 —— 把「保存」先收起来（取消/✕ 照旧可用）
  const saveBtn = $('#modal-save');
  if (saveBtn) saveBtn.style.display = isQuick ? 'none' : '';
  $('#modal-backdrop').classList.remove('hidden');
  if (type === 'notif') {
    $('#schema-hint').innerHTML = '提醒会在 <code>触发时间</code> 到达时弹出横幅。可设置重复：每小时 / 每天 / 每周 / 每月。';
  }
}

function buildForm(type, item) {
  const i = item || {};
  // 颜色色块：表单里存的颜色若不在预设色板里（课表导入的 #e74c3c、#3498db 等），
  // 就先把它作为第一个色块塞进去 —— 否则保存时读不到 active，颜色会被悄悄改回默认值。
  const colorStrip = (current) => {
    const cur = current || COLORS[0];
    const list = COLORS.includes(cur) ? COLORS : [cur, ...COLORS];
    return `<div class="color-strip">${list.map((c) => `<div class="color-chip ${cur === c ? 'active' : ''}" data-color="${c}" style="background:${c}"></div>`).join('')}</div>`;
  };
  const nowLocal = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30, 0, 0);
    return localDT(d);
  };
  // 「快速添加」：先选类型（2026-09-27 —— 以前这个按钮只会开"新建任务"）。
  if (type === 'quick') {
    const last = (() => { try { return localStorage.getItem('planner-quick-add') || ''; } catch { return ''; } })();
    const opts = [
      { id: 'task', icon: '✅', name: '任务', sub: '有截止时间的事（进「任务」页）' },
      { id: 'event', icon: '📅', name: '日程', sub: '某个时间段的事（进「日程」页）' },
      { id: 'notif', icon: '⏰', name: '提醒', sub: '到点弹一条（进「通知」页）' },
    ];
    return `
      <div class="dim" style="margin-bottom:10px">想加什么？${last ? '（你上次选的是「' + (opts.find((o) => o.id === last) || {}).name + '」）' : ''}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${opts.map((o) => `<button class="btn ${last === o.id ? 'primary' : ''}" data-quick="${o.id}"
            style="text-align:left;padding:12px 14px">
          <b>${o.icon} ${o.name}</b><span class="dim" style="margin-left:8px">${o.sub}</span></button>`).join('')}
      </div>`;
  }
  if (type === 'task') {
    return `
      <div class="field"><label>标题</label><input id="f-title" value="${esc(i.title || '')}" placeholder="例如：准备会议材料" /></div>
      <div class="field"><label>备注</label><textarea id="f-notes">${esc(i.notes || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>截止时间</label><input type="datetime-local" id="f-due" value="${i.due_at ? localDT(new Date(i.due_at)) : ''}" /></div>
        <div class="field"><label>优先级</label><select id="f-priority">
          ${[0, 1, 2, 3].map((p) => `<option value="${p}" ${(i.priority ?? 2) === p ? 'selected' : ''}>${PRI[p].t}</option>`).join('')}
        </select></div>
      </div>
      <div class="field"><label>状态</label><select id="f-status">
        <option value="todo" ${i.status === 'todo' ? 'selected' : ''}>待办</option>
        <option value="doing" ${i.status === 'doing' ? 'selected' : ''}>进行中</option>
        <option value="done" ${i.status === 'done' ? 'selected' : ''}>已完成</option>
      </select></div>
      <div class="field"><label>标签</label><input id="f-tags" value="${esc(i.tags || '')}" placeholder="用逗号分隔" /></div>
    `;
  }
  if (type === 'event') {
    return `
      <div class="field"><label>标题</label><input id="f-title" value="${esc(i.title || '')}" placeholder="例如：团队周会" /></div>
      <div class="field"><label>备注</label><textarea id="f-notes">${esc(i.notes || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>开始</label><input type="datetime-local" id="f-start" value="${i.start_at ? localDT(new Date(i.start_at)) : nowLocal()}" /></div>
        <div class="field"><label>结束</label><input type="datetime-local" id="f-end" value="${i.end_at ? localDT(new Date(i.end_at)) : ''}" /></div>
      </div>
      <div class="field"><label>全天?</label><input type="checkbox" id="f-allday" ${i.all_day ? 'checked' : ''} style="width:auto" /></div>
      <div class="field">
        <label>颜色</label>
        ${colorStrip(i.color)}
      </div>
      <div class="field"><label>标签</label><input id="f-tags" value="${esc(i.tags || '')}" placeholder="用逗号分隔" /></div>
    `;
  }
  if (type === 'habit') {
    return `
      <div class="field"><label>习惯名称</label><input id="f-title" value="${esc(i.name || '')}" placeholder="如：背单词 / 晨跑 / 早睡" /></div>
      <div class="field-row">
        <div class="field"><label>图标</label><input id="f-icon" value="${esc(i.icon || '🎯')}" maxlength="4" /></div>
        <div class="field"><label>每周目标(次)</label><input type="number" id="f-target" value="${i.target ?? 1}" min="1" /></div>
      </div>
      <div class="field"><label>颜色</label>${colorStrip(i.color || '#e60012')}</div>
    `;
  }
  if (type === 'milestone') {
    return `
      <div class="field"><label>名称</label><input id="f-title" value="${esc(i.title || '')}" placeholder="如：期中考试 / 项目截止 / 目标日" /></div>
      <div class="field-row">
        <div class="field"><label>日期</label><input type="date" id="f-date" value="${(i.target_at || '').slice(0, 10)}" /></div>
        <div class="field"><label>类型</label><select id="f-kind">
          <option value="exam" ${i.kind === 'exam' ? 'selected' : ''}>考试</option>
          <option value="deadline" ${i.kind === 'deadline' ? 'selected' : ''}>截止</option>
          <option value="date" ${(i.kind || 'date') === 'date' ? 'selected' : ''}>目标</option>
        </select></div>
      </div>
      <div class="field"><label>备注</label><textarea id="f-note">${esc(i.note || '')}</textarea></div>
    `;
  }
  if (type === 'course') {
    // 课程基本信息：与任务一样用表单直接增改（不必再手写 JSON 导入）。
    const wd = Number(i.weekday) >= 1 && Number(i.weekday) <= 7 ? Number(i.weekday) : 1;
    const presets = ['Zoom', 'Teams', '腾讯会议', 'Canvas', '线下教室'];
    return `
      <div class="field"><label>课程名</label><input id="f-course" value="${esc(i.course || '')}" placeholder="如：高等数学B1 · Honors Mathematics II MATH1860J" /></div>
      <div class="field-row">
        <div class="field"><label>星期</label><select id="f-weekday">
          ${WEEK_DAYS.map((d, ix) => `<option value="${ix + 1}" ${wd === ix + 1 ? 'selected' : ''}>周${d}</option>`).join('')}
        </select></div>
        <div class="field"><label>周次</label><input id="f-weeks" value="${esc(i.weeks || '1-14')}" placeholder="1-14 / 1,3,5 / 全部" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>开始</label><input type="time" id="f-start" value="${esc(i.start_at || '08:00')}" /></div>
        <div class="field"><label>结束</label><input type="time" id="f-end" value="${esc(i.end_at || '09:40')}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>上课地点</label><input id="f-location" value="${esc(i.location || '')}" placeholder="东中院4-304 / 包玉刚图书馆" /></div>
        <div class="field"><label>上课平台</label><input id="f-platform" list="platform-list" value="${esc(i.platform || '')}" placeholder="Zoom / Teams / 线下教室" />
          <datalist id="platform-list">${presets.map((p) => `<option value="${p}"></option>`).join('')}</datalist></div>
      </div>
      <div class="field"><label>教师</label><input id="f-teacher" value="${esc(i.teacher || '')}" placeholder="如：Horst Hohberger" /></div>
      <div class="field"><label>颜色</label>${colorStrip(i.color)}</div>
      <div class="dialog-hint" style="color:var(--muted);font-size:12px">线上课这样填：<b>地点</b>=你实际坐的地方（如“包玉刚图书馆”），<b>平台</b>=Zoom / Teams；同一门课不同天可以分别编辑。</div>
    `;
  }
  if (type === 'academic') {
    // 校历事项（学期 / 假期 / 考试 / 补课 / 其他）：2026-09-27 之前这里**只能贴 JSON**，
    // 而且加进去只能删不能改。现在和课程一样有表单了。
    const kind = i.kind || 'holiday';
    const kinds = [
      ['term', '学期（校历上的开学 / 学期区间）'],
      ['holiday', '假期'],
      ['exam', '考试 / 考试周'],
      ['makeup', '补课 / 调课'],
      ['general', '其他'],
    ];
    return `
      <div class="field"><label>标题</label><input id="f-title" value="${esc(i.title || '')}" placeholder="例如：国庆假期 / 考试周 / 补课日" /></div>
      <div class="field"><label>类型</label><select id="f-kind">
        ${kinds.map(([v, t]) => `<option value="${v}" ${kind === v ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
      <div class="field-row">
        <div class="field"><label>开始日期</label><input type="date" id="f-start" value="${(i.start_at || '').slice(0, 10)}" /></div>
        <div class="field"><label>结束日期（单天可留空）</label><input type="date" id="f-end" value="${(i.end_at || '').slice(0, 10)}" /></div>
      </div>
      <div class="field"><label>备注</label><textarea id="f-notes">${esc(i.notes || '')}</textarea></div>
      <div class="field"><label>颜色</label>${colorStrip(i.color)}</div>
      <div class="dialog-hint" style="color:var(--muted);font-size:12px">
        只有"开始日期"也能存（就是单天）；假期 / 考试周这种填上结束日期，日历上会整段标出来。
        页头那行"第 N 周"读的是 <b>设置 → 偏好 → 学期</b> 里的开学日；这里填的是校历上的区间，两处各管一件事。
        想批量导入就在这里存完再回管理窗口的「高级：批量导入」。
      </div>
    `;
  }
  // notif
  return `
    <div class="field"><label>标题</label><input id="f-title" value="${esc(i.title || '')}" placeholder="例如：喝水提醒" /></div>
    <div class="field"><label>内容</label><textarea id="f-message">${esc(i.message || '')}</textarea></div>
    <div class="field"><label>触发时间</label><input type="datetime-local" id="f-trigger" value="${i.trigger_at ? localDT(new Date(i.trigger_at)) : nowLocal()}" /></div>
    <div class="field"><label>重复</label><select id="f-repeat">
      <option value="none" ${(i.repeat || 'none') === 'none' ? 'selected' : ''}>一次性</option>
      <option value="hourly" ${i.repeat === 'hourly' ? 'selected' : ''}>每小时</option>
      <option value="daily" ${i.repeat === 'daily' ? 'selected' : ''}>每天</option>
      <option value="weekly" ${i.repeat === 'weekly' ? 'selected' : ''}>每周</option>
      <option value="monthly" ${i.repeat === 'monthly' ? 'selected' : ''}>每月</option>
    </select></div>
    <div class="dialog-hint" id="schema-hint" style="color:var(--muted);font-size:12px"></div>
  `;
}

function localDT(d) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function saveModal() {
  const type = modalType;
  const id = modalId;
  let body = {};
  let path = `/api/${type}s`;
  let ok = true;
  if (type === 'task') {
    body = { title: $('#f-title').value, notes: $('#f-notes').value, due_at: $('#f-due').value || null, priority: +$('#f-priority').value, status: $('#f-status').value, tags: $('#f-tags').value };
  } else if (type === 'event') {
    body = { title: $('#f-title').value, notes: $('#f-notes').value, start_at: $('#f-start').value, end_at: $('#f-end').value || null, all_day: $('#f-allday').checked, color: $('.color-chip.active')?.dataset.color || '#4f7cff', tags: $('#f-tags').value };
  } else if (type === 'notif') {
    body = { title: $('#f-title').value, message: $('#f-message').value, trigger_at: $('#f-trigger').value, repeat: $('#f-repeat').value };
  } else if (type === 'habit') {
    body = { name: $('#f-title').value, icon: $('#f-icon').value || '🎯', color: $('.color-chip.active')?.dataset.color || '#e60012', target: +$('#f-target').value || 1 };
    path = '/api/habits';
    ok = !!body.name;
  } else if (type === 'milestone') {
    body = { title: $('#f-title').value, target_at: $('#f-date').value, kind: $('#f-kind').value, note: $('#f-note').value };
    path = '/api/milestones';
    ok = !!(body.title && body.target_at);
  } else if (type === 'course') {
    body = {
      course: $('#f-course').value.trim(),
      weekday: +$('#f-weekday').value,
      start_at: $('#f-start').value,
      end_at: $('#f-end').value,
      location: $('#f-location').value.trim(),
      platform: $('#f-platform').value.trim(),
      teacher: $('#f-teacher').value.trim(),
      weeks: $('#f-weeks').value.trim(),
      color: $('.color-chip.active')?.dataset.color || '#4f7cff',
    };
    path = '/api/courses';
    ok = !!(body.course && body.start_at && body.end_at);
  } else if (type === 'academic') {
    body = {
      title: $('#f-title').value.trim(),
      kind: $('#f-kind').value,
      start_at: $('#f-start').value,
      end_at: $('#f-end').value || null,        // 空 = 单天
      notes: $('#f-notes').value.trim(),
      color: $('.color-chip.active')?.dataset.color || '#ffd166',
    };
    path = '/api/academic';
    ok = !!(body.title && body.start_at);
  }
  if (!ok) {
    const msg = type === 'habit' ? '请填写习惯名称'
      : type === 'course' ? '请填写课程名与开始/结束时间'
        : type === 'academic' ? '请填写标题与开始日期'
          : '请填写名称与日期';
    toast(msg, 'red');
    return;
  }
  const method = id ? 'PATCH' : 'POST';
  const url = id ? `${path}/${id}` : path;
  api(method, url, body).then(async () => {
    closeModal();
    // 2026-09-27：**要等 refresh() 拿到新数据再重画**。以前这里没 await，
    // 管理窗口里刚存的那条会因为"重画得比取数快"而不出现（课表 / 校历都中过）。
    await refresh();
    if (mgrOpen) renderMgrTab(mgrTab);
    toast('已保存', 'green');
  }).catch((e) => toast(e.message, 'red'));
}

function closeModal() { $('#modal-backdrop').classList.add('hidden'); modalType = null; modalId = null; }

// Delete the item currently open in the edit modal (task / event / reminder).
async function deleteModalItem() {
  const type = modalType; const id = modalId;
  if (!id) return;
  const res = type === 'task' ? 'tasks' : type === 'event' ? 'events' : type === 'course' ? 'courses' : 'notifications';
  const titles = { task: '任务', event: '日程', notif: '提醒', course: '课程' };
  if (!window.confirm(`确认删除这个${titles[type] || '条目'}?（不可恢复）`)) return;
  const btn = $('#modal-delete'); if (btn) btn.disabled = true;
  try {
    await api('DELETE', `/api/${res}/${id}`);
    closeModal();
    await refresh();
    if (mgrOpen) renderMgrTab(mgrTab);
    toast('已删除', 'green');
  } catch (e) {
    toast(e.message || '删除失败', 'red');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------- 课表 / 校历 manager ----------------
const COURSE_TMPL = {
  items: [
    { course: '高等数学', weekday: 1, start_at: '08:00', end_at: '09:40', location: 'A101', teacher: '张老师', weeks: '1-16', color: '#4f7cff' },
    { course: '英语', weekday: 2, start_at: '14:00', end_at: '15:40', location: 'C303', teacher: '李老师', weeks: '1-16', color: '#3ecf8e' },
  ],
};
const ACAD_TMPL = {
  items: [
    { title: '开学报到', start_at: '2026-09-01', end_at: '', kind: 'term', color: '#4f7cff' },
    { title: '国庆假期', start_at: '2026-10-01', end_at: '2026-10-07', kind: 'holiday', color: '#ffd166' },
    { title: '期中考试周', start_at: '2026-11-09', end_at: '2026-11-13', kind: 'exam', color: '#ff6b6b' },
  ],
};
// 课表/校历管理弹窗的当前页签与开关状态（保存/删除后需要把这张表一起刷新）
let mgrTab = 'course';
let mgrOpen = false;
/** 校历事项的类型 → 人话（表格里显示的；JSON 里存的还是 term/holiday/exam/makeup/general）。 */
const ACADEMIC_KIND_LABEL = { term: '学期', holiday: '假期', exam: '考试', makeup: '补课', general: '其他' };

function openScheduleManager(tab = 'course') {
  const b = $('#manager-body');
  b.innerHTML = `
    <div class="mgr-tab">
      <button class="filter ${tab === 'course' ? 'active' : ''}" data-t="course">📚 课表</button>
      <button class="filter ${tab === 'academic' ? 'active' : ''}" data-t="academic">📅 校历</button>
    </div>
    <div id="mgr-content"></div>
  `;
  $('#manager-backdrop').classList.remove('hidden');
  mgrOpen = true;
  renderMgrTab(tab);
  $$('.mgr-tab .filter', b).forEach((f) => f.onclick = () => renderMgrTab(f.dataset.t));
}
const openCourseManager = () => openScheduleManager('course');

function renderMgrTab(tab = mgrTab) {
  mgrTab = tab;
  const box = $('#mgr-content');
  const isCourse = tab === 'course';
  const rows = isCourse ? DB.courses : DB.academic;
  const label = isCourse ? '课表' : '校历';
  const tmpl = isCourse ? COURSE_TMPL : ACAD_TMPL;
  const importPath = isCourse ? '/api/courses/import' : '/api/academic/import';
  const fieldHint = isCourse
    ? '字段：course(课程名) / weekday(1=周一..7=周日) / start_at("HH:MM") / end_at / location(在哪上) / platform(用什么上，如 Zoom) / teacher / weeks("1-16") / color'
    : '字段：title / start_at(YYYY-MM-DD) / end_at / kind(term|holiday|exam|general) / notes / color';

  box.innerHTML = `
    <div class="mgr-actions" style="margin-top:0">
      <button class="btn primary small" id="mgr-new">＋ 新建${isCourse ? '课程' : '校历事项'}</button>
      <span class="dim">点这里或表格里的「编辑」用表单增改；也可以用下面的一行式输入 —— 都不用手写 JSON。</span>
    </div>
    <div class="mgr-quick-row">
      <input id="mgr-quick" placeholder="${isCourse ? '周一 08:00-09:40 高等数学 @东中院4-304 #Zoom 周次1-14' : '10-01~10-07 国庆假期 #假期'}" />
      <button class="btn primary small" id="mgr-quick-add">添加</button>
      <button class="btn small" id="mgr-quick-sample" title="填一个例子进去，改一改就能用">示例</button>
    </div>
    <div class="dim" style="margin:4px 0 10px;font-size:12px">
      ${isCourse
        ? '一行式：<code>周X 开始-结束 课程名 @地点 #平台 周次A-B</code>（周几不写就按今天）'
        : '一行式：<code>日期 事项名 #类型 @备注</code> — 日期可写 <code>今天 / 明天 / 周三 / 10-01 / 10-01~10-07 / 2026-12-14~12-18</code>，类型可写 假期 / 考试 / 学期 / 补课 / 其他'}
    </div>
    <div class="mgr-actions" style="margin-top:0">
      <button class="btn small" id="mgr-file">📥 从文件导入（.ics / .csv）</button>
      <input type="file" id="mgr-file-input" accept=".ics,.csv,.txt" style="display:none" />
      <span class="dim" id="mgr-file-note">日历文件（.ics）按<b>校历</b>导入；表格（.csv）按当前页签导入。</span>
    </div>
    <div id="mgr-file-preview"></div>
    <details class="mgr-import">
      <summary>高级：批量导入 / 导出模板${isCourse ? '' : ''}</summary>
      <div class="dim" style="margin:6px 0">粘贴 JSON（{ "items": [...] }）导入。字段说明：${fieldHint}</div>
      <textarea id="mgr-paste" placeholder='{"items":[...]}'></textarea>
      <div class="mgr-actions">
        <button class="btn small" id="mgr-sample">填入示例</button>
        <button class="btn primary small" id="mgr-import">导入 ${label}</button>
        <button class="btn small" id="mgr-download">下载模板</button>
        <button class="btn small" id="mgr-clear">清空输入框</button>
        <span id="mgr-status" class="dim"></span>
      </div>
    </details>
    <h3>当前${label}（${rows.length}）</h3>
    ${rows.length ? `
      ${isCourse ? `
        <table class="table">
          <thead><tr><th>课程</th><th>星期</th><th>时间</th><th>地点</th><th>平台</th><th>教师</th><th>周次</th><th></th></tr></thead>
          <tbody>${rows.map((c) => `<tr>
            <td><span class="pill" style="border-color:${c.color};color:${c.color}">${esc(c.course)}</span></td>
            <td>周${c.weekday}</td><td>${hm12(c.start_at)}–${hm12(c.end_at)}</td>
            <td>${esc(c.location || '')}</td>
            <td>${c.platform ? `<span class="pill tag">${esc(c.platform)}</span>` : ''}</td>
            <td>${esc(c.teacher || '')}</td><td>${esc(c.weeks || '全部')}</td>
            <td class="nowrap"><button class="btn sm" data-edit-course="${c.id}">编辑</button>
              <button class="btn sm" data-del="${c.id}">删</button></td></tr>`).join('')}</tbody>
        </table>` : `
        <table class="table">
          <thead><tr><th>事项</th><th>类型</th><th>日期</th><th>备注</th><th></th></tr></thead>
          <tbody>${rows.map((a) => `<tr>
            <td><span class="pill" style="border-color:${a.color};color:${a.color}">${esc(a.title)}</span></td>
            <td class="nowrap">${esc(ACADEMIC_KIND_LABEL[a.kind] || a.kind)}</td>
            <td class="nowrap">${esc(a.start_at)}${a.end_at && a.end_at !== a.start_at ? ' – ' + esc(a.end_at) : ''}</td><td>${esc(a.notes || '')}</td>
            <td class="nowrap"><button class="btn sm" data-edit-academic="${a.id}">编辑</button>
              <button class="btn sm" data-del="${a.id}">删</button></td></tr>`).join('')}</tbody>
        </table>`}`
      : '<div class="empty">尚未导入${label}。可点“填入示例”预览效果，或粘贴你的数据后“导入”。</div>'}
  `;

  $('#mgr-sample').onclick = () => { $('#mgr-paste').value = JSON.stringify(tmpl, null, 2); $('#mgr-status').textContent = ''; };
  // 表单直接新建一门课（与任务表单同一套弹窗）
  const newBtn = $('#mgr-new');
  if (newBtn) {
    newBtn.onclick = () => (isCourse
      ? openModal('course', { weekday: 1, weeks: '1-14', color: '#4f7cff' })
      // 预填"今天"要用**本地日期**：toISOString() 是 UTC，晚上点开会显示成昨天。
      : openModal('academic', { kind: 'holiday', color: '#ffd166', start_at: localDT(new Date()).slice(0, 10) }));
  }
  // 每行「编辑」→ 同一个表单，带出这门课 / 这条校历事项的全部字段
  $$('[data-edit-course]', box).forEach((b) => b.onclick = () => {
    const c = DB.courses.find((x) => x.id === b.dataset.editCourse);
    if (c) openModal('course', c);
  });
  $$('[data-edit-academic]', box).forEach((b) => b.onclick = () => {
    const a = DB.academic.find((x) => x.id === b.dataset.editAcademic);
    if (a) openModal('academic', a);
  });

  // ---- 一行式输入 + 文件导入（2026-09-27）----
  // 为什么要有：用户说"让填入 JSON 不是特别人性化"。表单解决"一条一条改"，
  // 这两样解决"懒得填表 / 手上已经有一份表格或日历文件"。
  const SI = window.ScheduleInput;
  const setStatus = (t) => { const s = $('#mgr-status'); if (s) s.textContent = t || ''; };
  const quick = $('#mgr-quick');
  const quickAdd = async () => {
    if (!SI) { setStatus('解析器没加载上（刷新一下页面）'); return; }
    const raw = quick ? quick.value.trim() : '';
    const r = SI.parseQuickLine(raw, { kind: isCourse ? 'course' : 'academic', today: new Date() });
    if (!r.ok) { setStatus('没读成：' + r.error); return; }
    try {
      await api('POST', isCourse ? '/api/courses' : '/api/academic', r.item);
      quick.value = '';
      toast(`已添加：${r.item.course || r.item.title}`, 'green');
      await refresh();
      renderMgrTab(tab);
      setStatus('已添加');
    } catch (e) { setStatus('没存上：' + (e.message || '')); }
  };
  if (quick) quick.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } });
  const quickBtn = $('#mgr-quick-add');
  if (quickBtn) quickBtn.onclick = quickAdd;
  const sampleBtn = $('#mgr-quick-sample');
  if (sampleBtn && quick) sampleBtn.onclick = () => {
    quick.value = isCourse ? '周一 08:00-09:40 高等数学 @东中院4-304 #Zoom 周次1-14' : '10-01~10-07 国庆假期 #假期';
    quick.focus();
  };

  // 文件导入：先解析 → **给你看前几条** → 你点"确认导入"才真的写进去
  const pending = { items: [], kind: isCourse ? 'course' : 'academic' };
  const renderPreview = (r, fileName) => {
    const box2 = $('#mgr-file-preview');
    if (!box2) return;
    if (!r.ok) {
      box2.innerHTML = `<div class="fn-warn">「${esc(fileName)}」没读成：${esc(r.error || '未知原因')}</div>`
        + ((r.skipped || []).length ? `<div class="dim">跳过 ${r.skipped.length} 行：${esc(r.skipped.slice(0, 3).map((s) => (s.line ? `第 ${s.line} 行 ${s.why}` : s.why)).join('；'))}</div>` : '');
      return;
    }
    pending.items = r.items;
    const rows = r.items.slice(0, 5);
    box2.innerHTML = `
      <div class="mgr-preview">
        <div><b>${esc(fileName)}</b>：读到 <b>${r.items.length}</b> 条${r.skipped && r.skipped.length ? `（跳过 ${r.skipped.length} 条）` : ''}，前几条长这样：</div>
        ${rows.map((it) => `<div class="mgr-preview-row">${
          pending.kind === 'course'
            ? `周${it.weekday} ${esc(it.start_at)}–${esc(it.end_at)} <b>${esc(it.course)}</b>${it.location ? ` @${esc(it.location)}` : ''}${it.platform ? ` #${esc(it.platform)}` : ''}`
            : `${esc(it.start_at)}${it.end_at && it.end_at !== it.start_at ? ' ~ ' + esc(it.end_at) : ''} <b>${esc(it.title)}</b> <span class="dim">${esc(ACADEMIC_KIND_LABEL[it.kind] || it.kind)}</span>`
        }</div>`).join('')}
        ${r.items.length > 5 ? `<div class="dim">…还有 ${r.items.length - 5} 条</div>` : ''}
        ${r.skipped && r.skipped.length ? `<div class="dim">跳过：${esc(r.skipped.slice(0, 3).map((s) => (s.line ? `第 ${s.line} 行 ${s.why}` : s.why)).join('；'))}${r.skipped.length > 3 ? ' …' : ''}</div>` : ''}
        <div class="mgr-actions">
          <button class="btn primary small" id="mgr-file-ok">确认导入 ${r.items.length} 条</button>
          <button class="btn small" id="mgr-file-cancel">取消</button>
        </div>
      </div>`;
    const okBtn = $('#mgr-file-ok');
    if (okBtn) okBtn.onclick = async () => {
      okBtn.disabled = true;
      okBtn.textContent = '导入中…';
      try {
        const res = await api('POST', pending.kind === 'course' ? '/api/courses/import' : '/api/academic/import', { items: pending.items });
        toast(`已导入 ${res.inserted} 条`, 'green');
        await refresh();
        renderMgrTab(tab);
        setStatus(`已导入 ${res.inserted} 条`);
      } catch (e) {
        okBtn.disabled = false;
        okBtn.textContent = '确认导入';
        setStatus('导入失败：' + (e.message || ''));
      }
    };
    const cancelBtn = $('#mgr-file-cancel');
    if (cancelBtn) cancelBtn.onclick = () => { pending.items = []; box2.innerHTML = ''; };
  };
  const fileInput = $('#mgr-file-input');
  const fileBtn = $('#mgr-file');
  if (fileBtn && fileInput) fileBtn.onclick = () => fileInput.click();
  if (fileInput) fileInput.onchange = async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const name = String(f.name || '');
    const isIcs = /\.ics$/i.test(name);
    let text = '';
    try { text = await f.text(); } catch (e) { setStatus('读不到这个文件：' + (e.message || '')); return; }
    if (!SI) { setStatus('解析器没加载上（刷新一下页面）'); return; }
    if (isIcs && isCourse) {
      // .ics 是日历（校历）格式，不是课表 —— 切到校历页签再导，别硬塞进课表
      pending.kind = 'academic';
      const r = SI.parseIcs(text);
      renderMgrTab('academic');                       // 切页签（会重画，所以下面重新取预览容器）
      const box2 = $('#mgr-file-preview');
      if (box2) { box2.dataset.pending = '1'; renderPreview(r, name); }
      setStatus('日历文件按「校历」导入，已切到校历页签');
      return;
    }
    pending.kind = isCourse ? 'course' : 'academic';
    const r = isIcs ? SI.parseIcs(text) : SI.parseCsv(text, { kind: pending.kind });
    renderPreview(r, name);
  };
  $('#mgr-download').onclick = () => {
    const blob = new Blob([JSON.stringify(tmpl, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = isCourse ? '课表模板.json' : '校历模板.json';
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('#mgr-import').onclick = async () => {
    const st = $('#mgr-status');
    try {
      const parsed = JSON.parse($('#mgr-paste').value);
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const res = await api('POST', importPath, { items });
      st.textContent = `已导入 ${res.inserted} 条`;
      toast(`已导入 ${res.inserted} 条${label}`, 'green');
      await refresh();
      renderMgrTab(tab);
    } catch (e) { st.textContent = '导入失败：' + e.message; }
  };
  $('#mgr-clear').onclick = async () => {
    // 2026-09-27 修：原来这里发的是一个空的「导入」请求（不替换任何数据），
    // 实际什么都没发生，却提示「已清空校历」——被误导过的用户会以为数据没了。
    // 现在按这排按钮的一致语义来：清空上面那个 JSON 输入框，文案也不再撒谎。
    // （真要整表重来：先「下载模板」备份，再走导入；本按钮不碰已保存的${label}。）
    $('#mgr-paste').value = '';
    setStatus('已清空输入框（不影响已保存的' + label + '）');
  };
  $$('[data-del]', box).forEach((b) => b.onclick = async () => {
    const resource = isCourse ? 'courses' : 'academic';
    // 删了没有回收站：和别处一样先问一句（2026-09-27 加 —— 原来这里直接删，手滑点一下就没了）
    if (!window.confirm(`确认删除这条${label}？（不可恢复）`)) return;
    await api('DELETE', `/api/${resource}/${b.dataset.del}`);
    await refresh();
    renderMgrTab(tab);
    toast('已删除', 'green');
  });
}

function closeManager() { $('#manager-backdrop').classList.add('hidden'); mgrOpen = false; }

// ---------------- UI theme (Persona 5 / classic) ----------------
const THEMES = [
  { id: 'p5', name: 'Persona 5 · 黑红', desc: '黑红撞色、斜切角、网点、粗体大标题', bg: '#0b0a0d', accent: '#e60012', text: '#f4f1f5' },
  { id: 'p3r', name: 'Persona 3R · 克莱因蓝与镜子', desc: '水蓝/克莱因蓝 + 镜面玻璃质感', bg: '#060a1c', accent: '#2e6bff', text: '#eef6ff' },
];
function applyTheme(id) {
  document.body.dataset.theme = id;
  try { localStorage.setItem('planner-theme', id); } catch {}
  api('POST', '/api/prefs', { theme: id }).catch(() => {});
  fullScreenSwitch(id);
  applyWallpaper(id, state.tab === 'hub' ? 'hub' : 'inner');
}
/**
 * 设置页 / 五步向导那边点主题时走这个 —— **主题和壁纸要一起换**。
 * 以前那两处只自己改了 `body.dataset.theme`，绕过了 applyWallpaper ⇒
 * 换主题时壁纸不跟着换（2026-09-26 晚用户指出）。
 */
window.__cairnApplyTheme = (id) => {
  if (THEMES.some((t) => t.id === id)) applyTheme(id);
  return document.body.dataset.theme;
};
let wpMap = { p5: 'none', p3r: 'wolf-duo' };
/** 内页偏爱用的两张（原开发者机器上的 id）：**只有你库里确实有**才会用，见 applyWallpaper 的回退。 */
const WP_INNER = { p5: '2895586231', p3r: '3151551777' };
let wpList = [];
let wpById = {};
let wpDir = '';                       // 当前壁纸目录（服务端给的，可在这里改）
let wpLayers = null;
// 动态壁纸默认自动播放（保持原有效果）；如果用户手动关掉，会持久记住「关」。
// 关掉后视频壁纸会退化成同款静态预览图，可省下 4K 视频解码常驻的内存（约 500 MB）。
let wpVideoAllowed = (() => {
  try {
    const v = localStorage.getItem('planner-wp-video');
    return v === null ? true : v === '1';
  } catch { return true; }
})();
function initWpLayers() {
  wpLayers = [
    { el: document.getElementById('wp-a'), video: document.querySelector('#wp-a video'), type: null, id: null, active: true },
    { el: document.getElementById('wp-b'), video: document.querySelector('#wp-b video'), type: null, id: null, active: false },
  ];
  for (const L of wpLayers) if (L.video) { L.video.preload = 'none'; L.video.pause(); }
}
function stopWpVideo(layer) {
  const v = layer && layer.video;
  if (!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}   // load() 才会真正释放解码器/缓冲
  try { v.preload = 'none'; } catch {}                              // 未播放 = 不预加载
}
function wpUrl(id, kind) { return kind === 'video' ? (id === 'p5r' ? '/api/wallpapers/p5r/video' : `/assets/wallpapers/${id}.mp4`) : `/api/wallpapers/${id}/preview`; }
function setWpLayer(layer, id) {
  const meta = wpById[id] || {};
  const isVideo = !!meta.has_video && wpVideoAllowed;   // ← 关键改动：视频壁纸要用户主动开启才播放
  const still = meta.preview_url || wpUrl(id, 'image');
  layer.id = id;
  if (isVideo) {
    layer.el.classList.remove('image'); layer.el.style.backgroundImage = ''; layer.video.style.visibility = '';
    layer.video.poster = still;          // 未开播前显示同款静态图
    layer.video.preload = 'auto';
    const vurl = wpUrl(id, 'video');
    if (layer.video.getAttribute('src') !== vurl) layer.video.src = vurl;
    layer.video.play().catch(() => {});
  } else {
    stopWpVideo(layer);                  // 原来是 removeAttribute('src') 后就不管了，解码器可能继续挂着
    layer.el.classList.add('image'); layer.video.style.visibility = 'hidden';
    layer.el.style.backgroundImage = still ? `url('${still}')` : '';
  }
}
function setWpVideoAllowed(on) {
  wpVideoAllowed = !!on;
  try { localStorage.setItem('planner-wp-video', on ? '1' : '0'); } catch {}
  if (!on) for (const L of wpLayers || []) stopWpVideo(L);
  applyWallpaper(document.body.dataset.theme, state.tab === 'hub' ? 'hub' : 'inner', true);
}
function applyWallpaper(theme, mode, force) {
  if (!wpLayers) initWpLayers();
  const key = theme === 'p3r' ? 'p3r' : 'p5';
  // 选哪张壁纸，**逐级回退**（2026-09-26 晚修）：以前 hub 用 wpMap[key]、内页用两个写死的 id，
  // 那两个 id 是原开发者机器上的 —— 换到别人机器上库里没有，就会变成一片空背景
  //（用户反馈"后面的动态壁纸没了"）。现在：指定 id → 主题配的那张 → 名字像这个主题的 →
  // 库里的第一张 → 实在没有就**保持现在这张不动**（宁可不动，也不要黑掉）。
  const known = (id) => id && wpById[id];
  const byName = (re) => (wpList.find((w) => re.test(String(w.name || ''))) || {}).id;
  const pick = () => {
    if (mode !== 'hub' && known(WP_INNER[key])) return WP_INNER[key];
    if (known(wpMap[key])) return wpMap[key];
    if (known(WP_INNER[key])) return WP_INNER[key];
    const guess = key === 'p3r' ? byName(/p3r|persona\s*3|克莱因|水蓝/i) : byName(/p5|persona\s*5|黑红/i);
    if (known(guess)) return guess;
    if (wpList.length) return wpList[0].id;
    return '';
  };
  const id = pick();
  if (!id) return;                       // 库还没读回来 / 真的一张都没有 ⇒ 不动现在这张
  const active = wpLayers.find((L) => L.active);
  if (!id || id === 'none') { for (const L of wpLayers) { if (L.active) { L.el.classList.remove('on'); L.active = false; } } return; }
  if (!force && active && active.id === id) { return; }
  const next = wpLayers.find((L) => !L.active) || wpLayers[0];
  setWpLayer(next, id);
  if (active) { active.active = false; active.el.classList.remove('on'); }
  next.active = true; next.el.classList.add('on');
}
async function loadWallpapers() {
  try {
    const r = await api('GET', '/api/wallpapers');
    wpMap = r.map; wpList = r.wallpapers; wpDir = r.dir || '';
    wpById = {}; for (const w of r.wallpapers) wpById[w.id] = w;
    applyWallpaper(document.body.dataset.theme, state.tab === 'hub' ? 'hub' : 'inner');
  } catch { /* 读不到就当没有 */ }
  // 壁纸列表是异步来的：拉到了就把挂着面板的地方重画一遍（向导第⑤步可能比它先挂上）
  try { refreshWallpaperPanels(); } catch { /* ignore */ }
}
function fullScreenSwitch(id) {
  const f = document.getElementById('theme-flash');
  if (!f) return;
  const p5 = id === 'p5';
  // 预留 = 全屏切换动画的素材插槽。拿到美术素材后填入 HERO_ART，即可自动启用全屏演出。
  const HERO_ART = null;
  f.className = p5 ? 'p5' : 'p3r';
  if (HERO_ART) {
    const shards = Array.from({ length: 9 }, (_, i) => {
      const a = (i / 9) * Math.PI * 2; const d = 200 + Math.random() * 120;
      return `<span class="tf-shard" style="--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;--r:${Math.round(Math.random() * 360)}deg"></span>`;
    }).join('');
    f.innerHTML = `<div class="tf-slab"></div><div class="tf-flash-glow"></div><div class="tf-hero-wrap"><div class="tf-hero-p">${HERO_ART}</div></div>${p5 ? '' : shards}`;
    f.classList.add('show');
    setTimeout(() => { f.classList.remove('show'); f.className = ''; f.innerHTML = ''; }, 5200);
    return;
  }
  // 占位：干净的快速主题扫过（预留位置，待美术素材替换）
  f.innerHTML = `<div class="tf-slab"></div><div class="tf-flash-glow"></div><div class="tf-reserved">⚡ 美术素材待添加</div>`;
  f.classList.add('show');
  setTimeout(() => { f.classList.remove('show'); f.className = ''; f.innerHTML = ''; }, 960);
}
function winControl(a) { api('POST', '/api/window/' + a).catch(() => {}); }
function initFx() {
  const canvas = document.getElementById('fx-bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let W, H, parts = [];
  const resize = () => { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; };
  resize(); window.addEventListener('resize', resize);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const N = 38;
  const themeColors = () => {
    const t = document.body.dataset.theme;
    if (t === 'p3r') return 'rgba(87,201,216,';
    if (t === 'p5') return 'rgba(255,46,64,';
    return 'rgba(150,170,210,';
  };
  const spawn = (init) => parts.push({
    x: Math.random() * W,
    y: init ? Math.random() * H : H + 10,
    r: 0.6 + Math.random() * 2.2,
    vy: -(0.25 + Math.random() * 0.6),
    vx: (Math.random() - 0.5) * 0.35,
    a: 0.3 + Math.random() * 0.5,
    tw: Math.random() * Math.PI * 2,
    tws: 0.02 + Math.random() * 0.05,
  });
  for (let i = 0; i < N; i++) spawn(true);
  if (reduced) { return; }
  const frame = (now) => {
    ctx.clearRect(0, 0, W, H);
    const base = themeColors();
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.y += p.vy; p.x += p.vx + Math.sin(now / 1000 * 1.2 + p.tw) * 0.15; p.tw += p.tws; p.a *= 0.999;
      if (p.y < -12 || p.a < 0.02) parts.splice(i, 1);
    }
    while (parts.length < N) spawn(false);
    for (const p of parts) {
      const alpha = (p.a * (0.55 + 0.45 * Math.sin(p.tw))).toFixed(3);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = base + alpha + ')'; ctx.fill();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
// ---------------- 壁纸（含 Wallpaper Engine 接口）----------------
// 2026-09-26：用户要求「五步上手 第⑤步」也能接 Wallpaper Engine。
// 做法是**把这一整块抽成一个函数**：`设置 → 外观`、`五步上手 第⑤步`、老的主题弹窗
// 共用同一份界面与同一套接线（不各写一份，免得到处不一致）。
function wallpaperPanelHtml() {
  return `
    <div class="dim" style="margin-top:2px;margin-bottom:6px">🌌 壁纸 <span class="muted">自动收录 Wallpaper Engine 壁纸库（含你之后订阅 / 下载的）</span></div>
    <div class="wp-row">
      <button class="wp-toggle ${wpVideoAllowed ? 'on' : ''}" id="wp-video-toggle">${wpVideoAllowed ? '🎞 动态壁纸：开（默认）' : '🖼 动态壁纸：关（省内存）'}</button>
      <span class="muted">默认自动播放动态壁纸；想省内存（例如要开 AE/PR 时）点这里即可切回静态图。</span>
    </div>
    <div class="wp-row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
      <input id="wp-dir" placeholder="壁纸文件夹（Wallpaper Engine 创意工坊目录，或任何放着图片/视频的文件夹）" value="${esc(wpDir)}" style="flex:1;min-width:260px" />
      <button class="btn small primary" id="wp-dir-apply">应用并重新扫描</button>
      <button class="btn small" id="wp-dir-pick">📂 选择文件夹…</button>
    </div>
    <div class="dim" style="margin-top:6px">当前目录：${wpDir ? esc(wpDir) : '未配置（下面只有内置的 4 张）'}<span class="muted"> · 改动立刻生效，不用重启</span></div>
    <div class="wp-grid">
      ${wpList.map((w) => `<div class="wp-tile" data-id="${w.id}" title="${esc(w.name)}">
        <div class="wp-tags"><span class="${wpMap.p5 === w.id ? 'on' : ''}" data-as="p5">P5</span><span class="${wpMap.p3r === w.id ? 'on' : ''}" data-as="p3r">P3R</span></div>
        <img src="${w.preview_url || ''}" alt="">
        <div class="wp-name">${esc(w.name)}${w.has_video ? ' · 视频' : ' · 静态'}</div>
      </div>`).join('') || '<div class="dim">还没扫到壁纸。上面填 Wallpaper Engine 创意工坊目录（或任何放着图片/视频的文件夹），再点「应用并重新扫描」。</div>'}
    </div>
    <div class="flex" style="margin-top:12px;flex-wrap:wrap;gap:8px">
      <button class="btn small" id="wp-shop-p5">🛒 商店搜 · P5 黑红</button>
      <button class="btn small" id="wp-shop-p3r">🛒 商店搜 · P3R 水蓝</button>
      <button class="btn small" id="wp-site">🌐 Wallpaper Engine 官网</button>
    </div>`;
}

/** 已经挂过壁纸面板的容器（改完东西要把每一处都重画一遍）。 */
const WP_HOSTS = new Set();

/** 把壁纸面板挂进某个容器（设置页 / 向导 / 主题弹窗都用它）。 */
function mountWallpaperPanel(host) {
  if (!host) return null;
  WP_HOSTS.add(host);
  host.innerHTML = wallpaperPanelHtml();
  bindWallpaperPanel(host);
  return host;
}

/** 每一处挂着面板的地方都重画一次（断开过的顺手清掉）。 */
function refreshWallpaperPanels() {
  for (const h of [...WP_HOSTS]) {
    if (h && h.isConnected) mountWallpaperPanel(h);
    else WP_HOSTS.delete(h);
  }
}

/** 壁纸面板的接线（作用域限定在 root 里，所以可以同时挂好几处）。 */
function bindWallpaperPanel(root) {
  const q1 = (s) => (root || document).querySelector(s);
  const qa1 = (s) => [...(root || document).querySelectorAll(s)];

  qa1('.wp-tile span[data-as]').forEach((s) => s.onclick = async (e) => {
    e.stopPropagation();
    const tile = s.closest('.wp-tile');
    const id = tile.dataset.id;
    const theme = s.dataset.as;
    try {
      const res = await api('POST', `/api/wallpapers/${id}/use`, { theme });
      wpMap[theme] = res.id;
      // 用户明确点了视频壁纸 → 视为同意开启动态壁纸（默认仍是关的）
      if (wpById[id] && wpById[id].has_video && !wpVideoAllowed) setWpVideoAllowed(true);
      applyWallpaper(theme, state.tab === 'hub' ? 'hub' : 'inner');
      refreshWallpaperPanels();
      toast(`已设为 ${theme === 'p5' ? 'P5' : 'P3R'} 壁纸`, 'green');
    } catch (err) { toast(`没设上：${err.message || ''}`, 'red'); }
  });

  const wpTg = q1('#wp-video-toggle');
  if (wpTg) wpTg.onclick = () => {
    setWpVideoAllowed(!wpVideoAllowed);
    refreshWallpaperPanels();
    toast(wpVideoAllowed ? '已开启动态壁纸（视频解码会多占内存）' : '已关闭动态壁纸，改用静态图', 'green');
  };
  const shopP5 = q1('#wp-shop-p5');
  if (shopP5) shopP5.onclick = () => window.open('https://steamcommunity.com/workshop/browse/?appid=431960&searchtext=' + encodeURIComponent('Persona 5 wallpaper'));
  const shopP3r = q1('#wp-shop-p3r');
  if (shopP3r) shopP3r.onclick = () => window.open('https://steamcommunity.com/workshop/browse/?appid=431960&searchtext=' + encodeURIComponent('Persona 3 Reload wallpaper'));
  const site = q1('#wp-site');
  if (site) site.onclick = () => window.open('https://www.wallpaperengine.io/', '_blank', 'noreferrer');

  // 壁纸目录：可以直接贴路径，也可以让服务端弹一个系统选择框
  const applyWpDir = async (dir) => {
    try {
      await api('POST', '/api/localdirs', { key: 'wallpaper', dir });
      await loadWallpapers();
      refreshWallpaperPanels();
      toast(dir ? `壁纸目录已更新，收到 ${Math.max(0, wpList.length - 4)} 张` : '已清空壁纸目录（只留内置 4 张）', 'green');
    } catch (e) { toast(`没改成：${e.message || '未知原因'}`, 'red'); }
  };
  const wpDirApply = q1('#wp-dir-apply');
  if (wpDirApply) wpDirApply.onclick = () => {
    const box = q1('#wp-dir');
    applyWpDir(((box && box.value) || '').trim());
  };
  const wpDirInput = q1('#wp-dir');
  if (wpDirInput) wpDirInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyWpDir(wpDirInput.value.trim()); } });
  const wpDirPick = q1('#wp-dir-pick');
  if (wpDirPick) wpDirPick.onclick = async () => {
    wpDirPick.textContent = '⏳ 等你在弹出的窗口里选…';
    let r = null;
    try { r = await api('POST', '/api/localdirs/pick', { key: 'wallpaper' }); }
    catch (e) {
      refreshWallpaperPanels();
      toast(`选择框没能打开：${e.message || ''}——可以直接把路径粘到左边的输入框`, 'red');
      return;
    }
    if (!r || !r.dir) { refreshWallpaperPanels(); toast((r && r.error) || '没有选择文件夹', r && r.error ? 'red' : ''); return; }
    await applyWpDir(r.dir);
  };
}

function openThemeModal() {
  const cur = document.body.dataset.theme || 'p5';
  const body = $('#theme-body');
  body.innerHTML = `
    <div class="pm-row" style="margin-bottom:16px"><span class="pm-label">🌐 语言 / Language</span>
      <div class="pm-btns">
        <button class="${lang === 'zh' ? 'active' : ''}" data-lang="zh">中文</button>
        <button class="${lang === 'en' ? 'active' : ''}" data-lang="en">English</button>
      </div>
    </div>
    <div class="theme-grid">
      ${THEMES.map((t) => `
        <div class="theme-card ${t.id === cur ? 'active' : ''}" data-theme="${t.id}">
          <div class="theme-swatch" style="background:linear-gradient(135deg, ${t.bg} 55%, ${t.accent})"></div>
          <div class="theme-name">${t.name}</div>
          <div class="theme-desc">${t.desc}</div>
        </div>`).join('')}
    </div>
    <div class="dim" style="margin-top:16px">界面主题：选择后立即应用(全程动画)，并记住偏好。</div>
    <div id="theme-wp-host" style="margin-top:20px"></div>
  `;
  $('#theme-backdrop').classList.remove('hidden');
  $$('.theme-card', body).forEach((c) => c.onclick = () => {
    applyTheme(c.dataset.theme);
    closeThemeModal();
    toast('界面风格已切换', 'green');
  });
  $$('#theme-body [data-lang]').forEach((b) => b.onclick = () => {
    lang = b.dataset.lang;
    applyLang();
    openThemeModal();
    toast(lang === 'en' ? 'Language: English' : '语言：中文', 'green');
  });
  mountWallpaperPanel(body.querySelector('#theme-wp-host'));
}

function closeThemeModal() { $('#theme-backdrop').classList.add('hidden'); }

async function delItem(resource, id, confirmText) {
  if (!window.confirm(confirmText || '确认删除?')) return;
  await api('DELETE', `/api/${resource}/${id}`);
  await refresh();
  toast('已删除');
}

// ---------------- Toast ----------------
function toast(msg, color) {
  const t = document.createElement('div');
  t.className = 'toast' + (color ? ' ' + color : '');
  t.innerHTML = `<div class="t">${esc(msg)}</div>`;
  $('#toast-wrap').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

function liveBanner(n, test) {
  const b = $('#live-banner');
  b.textContent = `${test ? '[测试] ' : ''}🔔 ${n.title}${n.message ? ' · ' + n.message : ''}`;
  b.classList.add('show');
  // 只有在设置里明确打开「系统通知」时才弹系统通知，默认只用应用内横幅，避免刷屏。
  if (osNotifyEnabled() && window.Notification && Notification.permission === 'granted') {
    new Notification(n.title, { body: n.message, tag: 'planner-' + n.id });
  }
  setTimeout(() => b.classList.remove('show'), 5000);
}

// 系统通知开关（默认关闭）
function osNotifyEnabled() {
  try { return localStorage.getItem('planner-os-notify') === '1'; } catch { return false; }
}
function setOsNotify(on) {
  try { localStorage.setItem('planner-os-notify', on ? '1' : '0'); } catch {}
  api('POST', '/api/prefs', { os_notify: on ? '1' : '0' }).catch(() => {});
  toast(on ? '已开启系统通知' : '已关闭系统通知', on ? 'green' : '');
  renderNotifications();
}

// ---------------- Wire up ----------------
function bind() {
  // nav
  $$('.nav-item').forEach((btn) => btn.onclick = () => switchTab(btn.dataset.tab));
  $('#btn-home').onclick = () => switchTab('hub');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') switchTab('hub');
  });

  $('#quick-add').onclick = () => openQuickAdd();
  $('#modal-save').onclick = saveModal;
  $('#modal-delete').onclick = deleteModalItem;
  $('#modal-close').onclick = closeModal;
  $('#modal-cancel').onclick = closeModal;
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
  $('#manager-close').onclick = closeManager;
  $('#manager-backdrop').addEventListener('click', (e) => { if (e.target.id === 'manager-backdrop') closeManager(); });
$('#settings-btn').onclick = () => switchTab('settings');   // 齿轮 → 设置页（原来是"风格"弹窗）
  $('#theme-close').onclick = closeThemeModal;
  $('#theme-backdrop').addEventListener('click', (e) => { if (e.target.id === 'theme-backdrop') closeThemeModal(); });
  $('#open-browser').onclick = requestNotif;

  // delegation: quick add/edit, toggle tasks
  document.addEventListener('click', (e) => {
    // 「快速添加」里选了类型（2026-09-27）：记住这次选择，再开对应的新建表单
    const qk = e.target.closest('[data-quick]');
    if (qk) {
      const t = qk.dataset.quick;
      if (['task', 'event', 'notif'].includes(t)) {
        try { localStorage.setItem('planner-quick-add', t); } catch { /* ignore */ }
        openModal(t);
      }
      return;
    }
    // 颜色色块：点一下选中（原来只能看不能点，表单里的颜色一直用默认值）
    const chip = e.target.closest('.color-chip');
    if (chip) {
      const strip = chip.closest('.color-strip');
      if (strip) $$('.color-chip', strip).forEach((c) => c.classList.toggle('active', c === chip));
      return;
    }
    // inline delete buttons must win over the row's edit handler
    const dt = e.target.closest('[data-deltask]');
    if (dt) { e.stopPropagation(); delItem('tasks', dt.dataset.deltask, '确认删除此任务?'); return; }
    const de = e.target.closest('[data-delev]');
    if (de) { e.stopPropagation(); delItem('events', de.dataset.delev, '确认删除此日程?'); return; }
    // completion checkbox toggles only (must not also open the edit modal)
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      e.stopPropagation();
      const t = DB.tasks.find((x) => x.id === toggle.dataset.toggle);
      if (t) {
        const next = t.status === 'done' ? 'todo' : 'done';
        api('PATCH', `/api/tasks/${t.id}`, { status: next }).then(refresh);
      }
      return;
    }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const type = edit.dataset.edit;
        const res = type === 'task' ? 'tasks' : type === 'event' ? 'events' : type === 'course' ? 'courses' : 'notifications';
        const item = DB[res === 'tasks' ? 'tasks' : res === 'events' ? 'events' : res === 'courses' ? 'courses' : 'notifications']
          .find((x) => x.id === edit.dataset.id);
        // 通知如果带来源链接，点击直接跳到邮件 / Canvas 内容
        if (item && type === 'notif' && item.url) openExternal(item.url);
        else if (item) openModal(type, item);
        return;
      }
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      $$('.nav-item').find((b) => b.dataset.tab === goto.dataset.goto)?.click();
    }
  });
}

function openQuickAdd() {
  // 选类型（任务 / 日程 / 提醒）—— 2026-09-27：以前这里直接开"新建任务"，
  // 常用日程/提醒的人每次都得先跳到那一页。选过的类型记在 localStorage 里，下次高亮。
  openModal('quick');
}

function requestNotif() {
  if (!('Notification' in window)) { toast('浏览器不支持系统通知'); return; }
  Notification.requestPermission().then((p) => toast(p === 'granted' ? '已开启系统通知' : '未获得权限', p === 'granted' ? 'green' : 'red'));
}

// SSE
function startSSE() {
  const es = new EventSource('/events');
  es.addEventListener('notification', (e) => {
    const d = JSON.parse(e.data);
    liveBanner(d, d.test);
    refresh();
  });
  es.onerror = () => {};
}

function startClock() {
  setInterval(() => { $('#clock').textContent = new Date().toLocaleString('zh-CN'); }, 1000);
}

/**
 * 启动时跑一次的模块（`module.json` 里 `boot: true`）。
 *
 * 为什么要有它：用户要的"五步上手"不是导航里的一个页面，而是**能用应用之前**的配置向导
 * （像新电脑开箱那样）。模块自己决定要不要盖住界面 —— 它读了偏好里的"已完成/已跳过"，
 * 没做完才弹；做完了就是一个安静的函数，什么都不显示。
 * 坏掉的 boot 模块绝不能拖垮主应用，所以整段包在 try 里。
 */
async function runBootModules() {
  for (const m of MODULE_REGISTRY.filter((x) => x.boot === true)) {
    try {
      const mod = await import('/modules/' + m.id + '/' + m.entry.view + '?v=' + encodeURIComponent((m.version || '0') + '-' + (m.mtime || 0)));
      if (typeof mod.boot === 'function') {
        // pickablePages 必须一起给：向导第③步要让用户勾"主菜单上的每一个功能"
        //（含今日/日程/任务/养成/统计/音乐这些核心页），不给的话它只能退回到
        // /api/modules 里的插件页 —— 2026-09-26 实测就只列出了 2 个。
        await mod.boot(moduleCtx());
      }
    } catch (e) { console.log('[boot] 模块 ' + m.id + ' 启动钩子出错：' + ((e && e.message) || e)); }
  }
}

// ---------------- Init ----------------
// ---------------- 界面自更新提示（2026-09-27） ----------------
// 为什么要有它：网页会把 app.js / styles.css 缓存住 —— 服务端改了界面、你这个窗口还跑旧逻辑，
// 表现就是"说好的功能完全没有"（这一轮就撞上了：新加的「⚙ 功能设置」在老页面里根本不存在）。
// 这里每 30 秒问一次 /api/health 的 ui.version（= app.js / index.html / styles.css 的修改时间），
// 一旦和自己加载时看到的不一样，就浮出一个「界面已更新 · 点这里刷新」。
// **不自动刷新**：你手上可能正填着东西，刷不刷由你点。
let UI_BUILD_SEEN = null;
/**
 * 后台服务没在跑时的提示条（2026-09-27）。
 * 为什么要有它：服务一掉（托盘被退出、进程被杀），页面只会显示"未连接 / 模块加载失败"，
 * 看起来就像"壁纸又连不上了 / 功能坏了"—— 其实只是后台没了。这里明确说清 + 给一键重试。
 */
function showOfflinePill() {
  let el = document.getElementById('server-offline-pill');
  if (!el) {
    el = document.createElement('button');
    el.id = 'server-offline-pill';
    el.className = 'ui-update-pill offline';
    el.textContent = '⚠ 后台服务没在跑 · 点这里重试（或双击「启动后台.cmd」）';
    el.title = 'Planner 的后台服务（127.0.0.1:3210）连不上。双击仓库里的「启动后台.cmd」可以把它拉起来。';
    el.onclick = () => location.reload();
    document.body.appendChild(el);
  }
  el.classList.add('show');
}
function hideOfflinePill() {
  const el = document.getElementById('server-offline-pill');
  if (el) el.classList.remove('show');
}
function showUpdatePill() {
  let el = document.getElementById('ui-update-pill');
  if (!el) {
    el = document.createElement('button');
    el.id = 'ui-update-pill';
    el.className = 'ui-update-pill';
    el.textContent = '🔄 界面已更新 · 点这里刷新';
    el.onclick = () => location.reload();
    document.body.appendChild(el);
  }
  el.classList.add('show');
}
async function checkUiBuild() {
  try {
    const r = await fetch('/api/health?_t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) { showOfflinePill(); return; }
    const h = await r.json();
    hideOfflinePill();                                  // 服务回来了就把提示收掉
    const v = (h && h.ui && h.ui.version) || '';
    if (!v) return;
    if (UI_BUILD_SEEN === null) {
      UI_BUILD_SEEN = v;
      document.body.dataset.build = v;            // 一眼确认"这个页面跑的是哪一版前端"
      return;
    }
    if (v !== UI_BUILD_SEEN) showUpdatePill();
  } catch {
    showOfflinePill();                                 // 连不上 = 后台没在跑，明确告诉你
  }
}
function startUiWatch() {
  checkUiBuild();
  setInterval(checkUiBuild, 30000);
}

window.addEventListener('DOMContentLoaded', async () => {
  bind();
  await loadModules();          // 先发现模块（导航里要显示 view 类模块）
  document.title = APP_TITLE;
  const vt = document.getElementById('ver-tag'); if (vt) vt.textContent = APP_VERSION;
  const bv = document.getElementById('brand-ver'); if (bv) bv.textContent = APP_VERSION;
  // 品牌名同步到界面元素（服务端下发的名字优先）
  const bn = document.getElementById('app-name-brand'); if (bn) bn.textContent = APP_TITLE;
  const bw = document.getElementById('app-name-wb'); if (bw) bw.textContent = APP_TITLE;
  applyLang();
  const savedTheme = (() => { try { return localStorage.getItem('planner-theme'); } catch { return null; } })();
  // 从服务端同步「系统通知」开关（默认关闭）
  api('GET', '/api/prefs').then((pf) => {
    if (pf && pf.hub_click) { HUB_CLICK = pf.hub_click === 'twice' ? 'twice' : 'once'; renderHub(); }
    if (pf && pf.student_mode && pf.student_mode.mode) {
      STUDENT_MODE = pf.student_mode.mode === 'student' ? 'student' : 'general';
      renderSemester();
    }
    if (pf && pf.os_notify !== undefined) {
      try { localStorage.setItem('planner-os-notify', pf.os_notify ? '1' : '0'); } catch {}
      renderNotifications();
    }
    if (pf && pf.ui_modules) { UI_MODULES = pf.ui_modules; applyModuleLayout(); renderHub(); }
  }).catch(() => {});
  const mapTheme = (t) => (t === 'dark' ? 'p3r' : (t === 'p5' || t === 'p3r' ? t : 'p5'));
  document.body.dataset.theme = mapTheme(savedTheme);
  initFx();
  startClock();
  startSSE();
  startUiWatch();               // 界面更新了要主动告诉我（见上）
  startSchedFollow();           // 跨天 / 跨月时日历自动翻到"今天"所在的那一页
  await refresh().catch((e) => toast('加载失败：' + e.message, 'red'));
  // 能力清单只取一次，放进 DB —— 模块（能力搭建 / 向导）直接用这份，
  // 免得每个页面自己再请求一次（2026-09-25 踩到：页面里那次 fetch 会卡住，
  // 结果素材栏永远停在"0 条能力"这一帧）。
  api('GET', '/api/capabilities').then((r) => { DB.capabilities = (r && r.capabilities) || []; })
    .catch(() => { DB.capabilities = []; });
  await runBootModules();       // 启动时跑一次的模块（例：首次运行的配置向导，要盖在界面之前）
  try {
    if (new URLSearchParams(location.search).get('vmcheck') === '1') vmSelfCheck();
  } catch { /* ignore */ }
  loadWallpapers();
  switchTab('hub');
});
