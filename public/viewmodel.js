// viewmodel.js — display layer, step 1 of the Planner modularisation.
//
// Contract: contracts/viewmodel.v1.schema.json
//
// Why this file exists: today `public/app.js` mixes four things in one 3000-line
// scope — data fetching, data shaping, HTML strings and DOM mounting. This module
// keeps only the *shaping*: pure functions `state -> ViewModel`. No DOM, no fetch,
// no side effects, so the same object can feed the browser, the native shell, the
// CLI, email and Markdown.
//
// Day-1 scope is deliberately additive: nothing in app.js imports this file yet.
// The shapes below mirror what renderToday()/renderTasks()/renderConnectors()
// already do, verified by tests/viewmodel.test.mjs against a captured /api/state.

// ---------------------------------------------------------------- primitives

const pad = (n) => String(n).padStart(2, '0');

// 截止时间规则（纯日期 = 当天 23:59 结束）。副本与 lib/duedate.mjs、
// public/app.js 逐字相同，由 tests/duedate.test.mjs 强制一致。
// #region due-rule — single source of truth, keep byte-identical in:
//   lib/duedate.mjs · public/app.js · public/viewmodel.js
const DUE_END_OF_DAY = { hour: 23, minute: 59, second: 59, ms: 999 };
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function hasTimeOfDay(value) {
  return typeof value === 'string' && value.includes('T');
}

export function dueMs(value) {
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

export function isOverdue(value, nowMs) {
  const t = dueMs(value);
  return t !== null && t < nowMs;
}

export function dueDayKey(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim();
  if (PLAIN_DATE.test(text)) return text;
  const t = dueMs(text);
  if (t === null) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dueLabel(value) {
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

/** Local calendar day key, same rule app.js uses for "today". */
export const dayKey = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const PRIORITY = {
  0: { title: '紧急', level: 'error' },
  1: { title: '高', level: 'warn' },
  2: { title: '中', level: 'info' },
  3: { title: '低', level: 'muted' },
};

/** Source tag table, lifted from app.js srcTag() so both surfaces agree. */
export const SOURCE_TAGS = {
  'connector:email_sjtu': { icon: '🏫', name: '交大邮箱' },
  'connector:canvas': { icon: '🎓', name: 'Canvas' },
  'connector:email': { icon: '📧', name: '邮件' },
  'connector:feishu': { icon: '💬', name: '飞书' },
};

export const sourceTag = (source) =>
  SOURCE_TAGS[String(source || '')] || { icon: '🔔', name: '' };

export const item = (id, title, { meta = '', body = '', level = 'info', at = null, url = null, actions = [] } = {}) =>
  ({ id: String(id), title: String(title), meta, body, level, at, url, actions });

export const section = (id, title, items = [], note = '') => ({ id, title, note, items });

export const view = (id, title, { status = 'ok', summary = '', badge = null, sections = [], actions = [] } = {}) =>
  ({ schema: 'viewmodel.v1', id, title, status, summary, badge, sections, actions });

// ---------------------------------------------------------------- selection

const notDone = (t) => t.status !== 'done';

/** Everything renderToday() needs, computed once so every surface agrees. */
export function todaySelection(state, nowMs = Date.now()) {
  const today = dayKey(new Date(nowMs));
  const tasks = state.tasks || [];
  const events = state.events || [];
  const notifications = state.notifications || [];

  const todaysEvents = events
    .filter((e) => dayKey(e.start_at) === today)
    .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));

  const overdue = tasks.filter((t) => notDone(t) && t.due_at && isOverdue(t.due_at, nowMs));
  const dueToday = tasks.filter((t) => notDone(t) && t.due_at && dueDayKey(t.due_at) === today);
  const upcoming = tasks
    .filter((t) => notDone(t) && t.due_at && dueDayKey(t.due_at) > today)
    .sort((a, b) => dueMs(a.due_at) - dueMs(b.due_at))
    .slice(0, 5);
  const openNotifs = notifications.filter((n) => n.enabled).slice(0, 5);
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  return { today, todaysEvents, overdue, dueToday, upcoming, openNotifs, doneCount };
}

const taskItem = (t, nowMs) => {
  const done = t.status === 'done';
  const overdue = !done && t.due_at && isOverdue(t.due_at, nowMs);
  const pri = PRIORITY[t.priority] || PRIORITY[2];
  return item(`task-${t.id}`, t.title, {
    meta: [t.due_at ? `${overdue ? '逾期 ' : ''}${dueLabel(t.due_at)}` : '无截止', pri.title, t.source === 'codex' ? 'Codex' : '']
      .filter(Boolean)
      .join(' · '),
    level: done ? 'muted' : overdue ? 'error' : pri.level,
    at: t.due_at || null,
    actions: ['toggle', 'edit', 'delete'],
  });
};

const notifState = (n) => {
  if (!n.enabled) return '已停用';
  if (n.repeat && n.repeat !== 'none') return '重复';
  return n.last_fired_at ? '已触发' : '待触发';
};

const notifItem = (n) => {
  const tag = sourceTag(n.source);
  return item(`notif-${n.id}`, n.title, {
    meta: [n.trigger_at || '', tag.name, n.message ? String(n.message).slice(0, 60) : '', notifState(n)]
      .filter(Boolean)
      .join(' · '),
    body: n.message ? String(n.message) : '',
    level: n.enabled ? (n.priority ? 'warn' : 'info') : 'muted',
    at: n.trigger_at || null,
    url: n.url || null,
    actions: ['edit', 'toggle'],
  });
};

// ---------------------------------------------------------------- builders

/** The "今日" view: one object, every surface. */
export function buildTodayVM(state, nowMs = Date.now()) {
  const sel = todaySelection(state, nowMs);
  const focus = [...sel.overdue, ...sel.dueToday].slice(0, 8);
  const codex = state.codex || {};

  return view('today', '今日', {
    summary: `${sel.todaysEvents.length} 项安排，${sel.overdue.length + sel.dueToday.length} 项到期/逾期`,
    badge: sel.overdue.length + sel.dueToday.length,
    sections: [
      section('stats', '概览', [
        item('stat-schedule', String(sel.todaysEvents.length), { meta: '今天有安排', level: 'info' }),
        item('stat-due', String(sel.overdue.length + sel.dueToday.length), { meta: '到期/逾期', level: 'warn' }),
        item('stat-done', String(sel.doneCount), { meta: '已完成', level: 'ok' }),
      ]),
      section('schedule', `今天的安排 ${sel.today}`, sel.todaysEvents.map((e) => item(`event-${e.id}`, e.title, {
        meta: [e.start_at, e.end_at].filter(Boolean).join('-'),
        body: e.notes || '',
        level: 'info',
        at: e.start_at || null,
        actions: ['edit', 'delete'],
      })), sel.todaysEvents.length ? '' : '今天还没有日程'),
      section('focus', '需要关注的任务', focus.map((t) => taskItem(t, nowMs)),
        sel.overdue.length ? `逾期 ${sel.overdue.length} 项` : '暂无到期任务'),
      section('reminders', '即将到来的提醒', sel.openNotifs.map(notifItem),
        sel.openNotifs.length ? '' : '尚未设置提醒'),
      section('upcoming', '未来任务', sel.upcoming.map((t) => taskItem(t, nowMs)),
        sel.upcoming.length ? '' : '暂无未来任务'),
      section('codex', 'Codex 连接', [
        item('codex-state', codex.connected ? `已连接 ${codex.home}` : '尚未连接 Codex', {
          meta: codex.connected
            ? `${(codex.automations || []).length} 个自动化`
            : '请到「数据源」页面完成连接',
          level: codex.connected ? 'ok' : 'warn',
        }),
      ]),
    ],
    actions: [{ id: 'quick-add', label: '快速添加', kind: 'primary' }],
  });
}

/** The "任务" view. */
export function buildTasksVM(state, nowMs = Date.now()) {
  const tasks = state.tasks || [];
  const buckets = [
    ['overdue', '逾期', (t) => notDone(t) && t.due_at && isOverdue(t.due_at, nowMs)],
    ['today', '今天到期', (t) => notDone(t) && t.due_at && dueDayKey(t.due_at) === dayKey(new Date(nowMs))],
    ['soon', '之后', (t) => notDone(t) && t.due_at && dueMs(t.due_at) !== null && dueMs(t.due_at) >= nowMs],
    ['someday', '无截止', (t) => notDone(t) && !t.due_at],
    ['done', '已完成', (t) => t.status === 'done'],
  ];
  const sections = buckets
    .map(([id, label, pred]) => section(id, label, tasks.filter(pred).map((t) => taskItem(t, nowMs))))
    .filter((s) => s.items.length);
  const open = tasks.filter(notDone).length;
  return view('tasks', '任务', {
    summary: `${open} 项未完成`,
    badge: open,
    sections,
    actions: [{ id: 'quick-add', label: '新建任务', kind: 'primary' }],
  });
}

/**
 * 任务视图的「取数」部分（P2-1）。
 *
 * 与 buildTasksVM 的区别：那个产出的是分组后的完整 ViewModel（给原生/邮件用）；
 * 这个只回答"按当前筛选，列表里应该是哪些任务、各状态各有多少条"——
 * 正好是 renderTasks() 需要的那一份数据，HTML 仍由原模板渲染，外观零变化。
 */
export function tasksSelection(state, { filter = 'all', sort = 'smart', nowMs = Date.now() } = {}) {
  const tasks = state.tasks || [];
  // 两种顺序（2026-09-25 新增「时间优先」）：
  //   smart = 未完成在前 → 截止时间升序（没填截止的排最后）
  //   due   = 严格按截止时间升序，不区分完成与否（做完的留在原位）
  // 与 public/app.js 的 sortTasks() 必须等价（tasks-wiring / tasks-html 两份测试比对）。
  const due = (t) => (t.due_at ? dueMs(t.due_at) : Infinity);
  // 三档：smart（默认）/ balanced（轻重缓急）/ due（时间优先）。语义与 public/app.js 的 sortTasks 一致。
  const bucketOf = (t) => {
    const d = t.due_at ? dueMs(t.due_at) : null;
    if (d === null) return 3;
    if (d < nowMs) return 0;
    if (d - nowMs <= 24 * 3600 * 1000) return 1;
    if (d - nowMs <= 3 * 24 * 3600 * 1000) return 2;
    return 3;
  };
  const priOf = (t) => (typeof t.priority === 'number' ? t.priority : 2);
  const sorted = sort === 'due'
    ? [...tasks].sort((a, b) => due(a) - due(b))
    : sort === 'balanced'
      ? [...tasks].sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)
        || bucketOf(a) - bucketOf(b) || priOf(a) - priOf(b) || due(a) - due(b))
      : [...tasks].sort((a, b) =>
        (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || due(a) - due(b));
  const list = filter === 'all' ? sorted : sorted.filter((t) => t.status === filter);
  const count = (status) => tasks.filter((t) => t.status === status).length;
  return {
    filter,
    sort,
    list,
    counts: { all: tasks.length, todo: count('todo'), doing: count('doing'), done: count('done') },
  };
}

/** The "数据源 / connectors" view — replaces the 300-line renderConnectors(). */
export function buildSourcesVM(state) {
  // /api/state 里 connectors 的形状是 { meta: [...], configs: [...], counts: {...} }；
  // 也兼容直接传 [{...}] 或 { 名称: {...} } 的形状。
  const raw = state.connectors || {};
  const list = Array.isArray(raw.meta) ? raw.meta : raw;
  const counts = raw.counts || {};
  const entries = Array.isArray(list)
    ? list.map((meta) => [meta?.id || meta?.key || meta?.name || 'connector', meta])
    : Object.entries(list);
  const items = entries.map(([key, meta]) => {
    const m = meta && typeof meta === 'object' ? meta : { value: meta };
    const count = counts[key] ?? m.count;
    const detail = m.detail || m.status || m.note || (count != null ? `${count} 条` : '');
    const ok = m.ok !== false && m.state !== 'error';
    return item(`connector-${key}`, m.title || key, {
      meta: String(detail),
      body: m.description || '',
      level: ok ? 'ok' : 'error',
      url: m.url || null,
      actions: ['open', 'refresh'],
    });
  });
  return view('sources', '数据源', {
    summary: `${items.length} 个连接器`,
    badge: items.length,
    sections: [section('connectors', '连接器', items)],
  });
}

/** The "通知" view. */
export function buildNotificationsVM(state, nowMs = Date.now()) {
  const all = [...(state.notifications || [])].sort(
    (a, b) => new Date(b.trigger_at || 0) - new Date(a.trigger_at || 0),
  );
  const bySource = new Map();
  for (const n of all) {
    const key = String(n.source || 'app');
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(n);
  }
  const sections = [...bySource.entries()].map(([source, list]) => {
    const tag = sourceTag(source);
    return section(source, `${tag.icon} ${tag.name || source}`.trim(), list.slice(0, 20).map(notifItem));
  });
  const active = all.filter((n) => n.enabled).length;
  return view('notifications', '通知', {
    summary: `${active} 条启用中，共 ${all.length} 条`,
    badge: active,
    sections,
  });
}

/**
 * 通知视图的「取数」部分（P2-1）。
 *
 * 复刻 app.js 里 notifListOrdered() 的排序：**重点优先 → 提醒时间倒序 → 创建时间倒序**。
 * trigger_at 是 ISO 字符串、created_at 是毫秒数，两种都要能比（与原实现一致）。
 */
export function notificationsSelection(state) {
  const ts = (v) => {
    const t = typeof v === 'number' ? v : Date.parse(String(v || ''));
    return Number.isNaN(t) ? 0 : t;
  };
  const list = [...(state.notifications || [])].sort((a, b) =>
    (b.priority ? 1 : 0) - (a.priority ? 1 : 0)
    || ts(b.trigger_at) - ts(a.trigger_at)
    || ts(b.created_at) - ts(a.created_at));
  return {
    list,
    counts: {
      all: (state.notifications || []).length,
      enabled: (state.notifications || []).filter((n) => n.enabled).length,
      priority: (state.notifications || []).filter((n) => n.priority).length,
    },
  };
}

/**
 * 数据源视图的「取数」部分（A3，2026-09-20）。
 *
 * 与 buildSourcesVM 的区别：那个产出的是完整视图对象（给原生外壳/邮件用）；
 * 这个只回答 renderConnectors() 真正要读的那份数据 ——「有哪些数据源、各多少条、
 * 什么状态、每个输入框已经填了什么」。输入框、按钮和事件绑定仍留在 app.js，
 * 因为那是 UI 而不是数据。
 */
export function connectorsSelection(state) {
  const raw = state.connectors || {};
  const meta = Array.isArray(raw.meta) ? raw.meta : [];
  const configs = Array.isArray(raw.configs) ? raw.configs : [];
  const counts = raw.counts || {};
  const cfgOf = (id) => configs.find((c) => c.source === id);
  const savedCfg = (id) => {
    const c = cfgOf(id);
    try { return c ? JSON.parse(c.config_json || '{}') : {}; } catch { return {}; }
  };
  const list = meta.map((m) => {
    const cfg = cfgOf(m.id);
    const status = (cfg && cfg.status) || 'never';
    return {
      id: m.id,
      name: m.name,
      icon: m.icon,
      description: m.description || '',
      fields: Array.isArray(m.fields) ? m.fields : [],
      count: counts[m.id] || 0,
      status,
      statusCls: status === 'ok' || status === 'demo' || status === 'configured' ? 'status' : status === 'error' ? 'p0' : 'off',
      lastError: (cfg && cfg.last_error) || null,
      savedCfg: savedCfg(m.id),
    };
  });
  return { list };
}

// ---- 日历取数共用的小工具（A4，2026-09-20；与 app.js 逐条同规则，由
//      tests/calendar-wiring.test.mjs 在多月/多天上比对）----

const WEEK_MS = 7 * 86400000;

// 周一是一周的第一天（app.js 的 mondayOf 同规则）
const mondayOfDate = (d) => {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
};
const addDaysDate = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

const eventsOnKey = (state, key) => (state.events || []).filter((e) => dayKey(e.start_at) === key);
const tasksOnKey = (state, key) => (state.tasks || []).filter((t) => t.due_at && dueDayKey(t.due_at) === key);
const notifsOnKey = (state, key) => (state.notifications || []).filter((n) => n.trigger_at && dayKey(n.trigger_at) === key);
const academicOnKey = (state, key) => (state.academic || []).filter((a) => {
  const s = dayKey(a.start_at);
  const e = a.end_at ? dayKey(a.end_at) : s;
  return key >= s && key <= e;
});

/** 校历起点：academic 里 kind=term 最早的一条（app.js termStart() 同规则）。 */
export function termStartOf(state) {
  const terms = (state.academic || []).filter((a) => a.kind === 'term');
  if (terms.length) return terms.reduce((a, b) => (new Date(a.start_at) < new Date(b.start_at) ? a : b));
  return null;
}

/** 学期第几周；没设校历就返回 null（app.js weekNumberOf() 同规则）。 */
export function weekNumberOf(state, date) {
  const base = termStartOf(state);
  if (!base) return null;
  return Math.floor((mondayOfDate(date) - mondayOfDate(new Date(base.start_at))) / WEEK_MS) + 1;
}

/** 这门课在 date 那一周上不上（weeks 形如 "1-14,16"；没写 weeks = 每周都上）。 */
export function courseInWeek(state, course, date) {
  if (!course.weeks) return true;
  const wn = weekNumberOf(state, date);
  if (wn == null) return true; // 还没设校历 -> 先当作都要上
  for (const part of String(course.weeks).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const s = +m[1];
    const e = m[2] ? +m[2] : s;
    if (wn >= s && wn <= e) return true;
  }
  return false;
}

/** 某天该上哪些课（星期几 + 周次过滤）；app.js courseForDay() 同规则。 */
export function coursesForDay(state, date) {
  const wd = (date.getDay() + 6) % 7; // 0=周一
  return (state.courses || []).filter((c) => c.weekday === (wd + 1) && courseInWeek(state, c, date));
}

/**
 * 日程「月」视图的「取数」部分（A4，2026-09-20）。
 *
 * 回答的是：这一个月的网格里，每个格子该显示哪些日程、哪些未完成任务、哪些校历
 * 安排、以及它属不属于本月 —— **不含任何 HTML**。网格布局、周号、校历标签仍由
 * app.js 的 renderMonth() 自己拼，所以外观零变化。
 */
export function calendarMonthSelection(state, { cursorMs = Date.now() } = {}) {
  const cursor = new Date(cursorMs);
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  let cur = mondayOfDate(first);
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const weeks = [];
  while (cur <= last || weeks.length < 4) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDaysDate(cur, i)));
    cur = addDaysDate(cur, 7);
    if (weeks.length > 6) break;
    if (cur > addDaysDate(last, 7)) break;
  }

  return {
    monthIndex: cursor.getMonth(),
    weeks: weeks.map((days) => {
      const monday = days[0];
      const sunday = days[6];
      return {
        mondayKey: dayKey(monday),
        mondayMs: monday.getTime(),
        range: `${monday.getMonth() + 1}/${monday.getDate()}–${sunday.getMonth() + 1}/${sunday.getDate()}`,
        days: days.map((d) => {
          const key = dayKey(d);
          return {
            key,
            ms: d.getTime(),
            day: d.getDate(),
            inMonth: d.getMonth() === cursor.getMonth(),
            events: eventsOnKey(state, key),
            tasks: tasksOnKey(state, key).filter((t) => t.status !== 'done'),
            acad: academicOnKey(state, key),
          };
        }),
      };
    }),
  };
}

/**
 * 日程「周」视图的「取数」部分（A4 续，2026-09-20）。
 *
 * 一周七天，每天给出：该上哪些课、有哪些日程、有哪些校历安排。
 * 时间轴上的像素位置（top/height）**不在这里算** —— 那是布局，仍由 renderWeek() 负责。
 */
export function calendarWeekSelection(state, { cursorMs = Date.now() } = {}) {
  const monday = mondayOfDate(new Date(cursorMs));
  return {
    mondayKey: dayKey(monday),
    mondayMs: monday.getTime(),
    days: Array.from({ length: 7 }, (_, i) => addDaysDate(monday, i)).map((d, i) => {
      const key = dayKey(d);
      return {
        key,
        ms: d.getTime(),
        dow: i,              // 0=周一
        date: d.getDate(),
        monthIndex: d.getMonth(),
        courses: coursesForDay(state, d),
        events: eventsOnKey(state, key),
        acad: academicOnKey(state, key),
      };
    }),
  };
}

/**
 * 日程「日」视图的「取数」部分（A4 续，2026-09-20）。
 *
 * 一天的课程 / 日程 / 任务 / 提醒 / 校历，五个桶一次性给全。
 * 列表模式和两栏布局都从这里取数，具体怎么排仍由 renderDay() 决定。
 */
export function calendarDaySelection(state, { cursorMs = Date.now() } = {}) {
  const cursor = new Date(cursorMs);
  const key = dayKey(cursor);
  return {
    key,
    ms: cursor.getTime(),
    courses: coursesForDay(state, cursor),
    events: eventsOnKey(state, key),
    tasks: tasksOnKey(state, key),
    notifs: notifsOnKey(state, key),
    acad: academicOnKey(state, key),
  };
}

/**
 * 「首页 / 主菜单」导航视图的数据来源（R4，2026-09-21）。
 *
 * 这一页本身不读数据库，它读的是**导航表**：所以这个选择器证明了一件更根本的事 ——
 * 导航也是数据，不是写死在 HTML 里的九个按钮。
 * @param {{cursor?:string, lang?:string, modules?:object[]}} opts
 */
export function hubSelection(state, { cursor = null, lang = 'zh', modules = [] } = {}) {
  const en = lang === 'en';
  const items = (modules || []).map((m, i) => ({
    tab: m.tab,
    icon: m.ico || '',
    name: en ? m.en : m.name,
    sub: en ? m.ensub : m.sub,
    active: m.tab === cursor,
    order: i,
  }));
  return { items, cursor, lang, count: items.length };
}

/** 「养成」视图需要的一切：倒计时、习惯 7 日打卡、番茄统计（R4）。 */
export function habitsSelection(state, nowMs = Date.now()) {
  const habits = state.habits || [];
  const logs = state.habit_logs || [];
  const milestones = state.milestones || [];
  const ins = state.insights || {};
  const lastDays = Array.from({ length: 7 }, (_, i) => new Date(nowMs - (6 - i) * 86400000));
  const streaks = ins.habits?.streaks || [];
  const streakOf = (h) => (streaks.find((s) => s.id === h.id)?.streak) || 0;
  const doneSet = (h, d) => logs.some((l) => l.habit_id === h.id && l.date === dayKey(d) && l.done);

  const countdowns = milestones.filter((m) => !m.done).slice(0, 4).map((m) => ({
    id: m.id,
    title: m.title,
    targetAt: m.target_at,
    daysLeft: daysUntil(m.target_at, nowMs),
  }));

  return {
    countdowns,
    hasCountdowns: countdowns.length > 0,
    habits: habits.map((h) => ({
      id: h.id,
      name: h.name,
      icon: h.icon,
      color: h.color,
      streak: streakOf(h),
      days: lastDays.map((d) => ({ date: dayKey(d), day: d.getDate(), done: doneSet(h, d) })),
    })),
    emptyHabits: habits.length === 0,
    todayDone: ins.habits?.todayDone || 0,
    total: habits.length,
    focus: { today: ins.focus?.today || 0, week: ins.focus?.week || 0 },
  };
}

/** 距目标还有几天（不早于 0）—— 与 app.js 的 daysUntil() 同一规则。 */
export function daysUntil(target, nowMs = Date.now()) {
  return Math.max(0, Math.ceil((new Date(target).getTime() - nowMs) / 86400000));
}

/**
 * 「统计」视图需要的一切（R4）。
 *
 * 注意这里的定位：**汇总数字由服务端算**（`state.insights`），
 * ViewModel 只负责「把哪些数字放到哪张卡片、近 7 日的柱子多高」。
 * 所以换掉界面（网页 / 原生外壳 / 邮件 / Markdown）时，数字不会各算各的。
 */
export function statsSelection(state, nowMs = Date.now()) {
  const ins = state.insights || {};
  const tasksD = ins.tasks || {};
  const focusD = ins.focus || {};
  const habD = ins.habits || {};
  const nextCd = ins.milestone || ins.exam || null;

  const days = Array.from({ length: 7 }, (_, i) => new Date(nowMs - (6 - i) * 86400000));
  const dayOf = (iso) => dayKey(new Date(iso));
  const tasks = state.tasks || [];
  const focus = state.focus || [];
  const week = days.map((d) => {
    const k = dayKey(d);
    const tDone = tasks.filter((t) => t.status === 'done' && t.updated_at && dayOf(t.updated_at) === k).length;
    const fMin = focus.filter((f) => dayOf(f.started_at) === k).reduce((a, f) => a + f.minutes, 0);
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
    focusBars: week.map((w) => ({ ...w, heightPct: Math.round((w.fMin / maxF) * 100) })),
    taskBars: week.map((w) => ({ ...w, heightPct: Math.round((w.tDone / maxT) * 100) })),
    streaks: habD.streaks || [],
  };
}

/**
 * 「本地音乐」视图的数据来源（R4）。
 * 浏览器直接选文件夹时用本地对象 URL，优先于服务端扫描结果 —— 这个优先级也在这里定。
 */
export function musicSelection(state, { localTracks = [] } = {}) {
  const m = state.music || { dir: '', tracks: [], scanned_at: 0 };
  const usingLocal = (localTracks || []).length > 0;
  const tracks = usingLocal ? localTracks : (m.tracks || []);
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

/**
 * 「数据源 / Codex」视图的数据来源（R4）。
 * 把「自动化有几条在跑、连没连上、计划导到哪」这些判断收在这里，
 * 界面只负责把状态渲染成颜色和文字。
 */
export function codexSelection(state, { chatLog = [] } = {}) {
  const c = state.codex || { connected: false, home: null, automations: [], error: null, synced_at: 0 };
  const home = state.codex_home || c.home;
  const automations = (c.automations || []).map((a) => ({
    id: a.id,
    name: a.name,
    prompt: a.prompt || '',
    kind: a.kind,
    status: a.status,
    describe: a.describe || '',
    nextRunAt: a.next_run_at || null,
    statusLabel: a.status === 'ACTIVE' ? '运行中' : a.status === 'PAUSED' ? '已暂停' : String(a.status || ''),
    statusCls: a.status === 'ACTIVE' ? 'status' : a.status === 'PAUSED' ? 'status off' : (a.status === 'PARSE_ERROR' ? 'p0' : ''),
    active: a.status === 'ACTIVE',
  }));
  const exportPaths = (state.plan_export && state.plan_export.paths) || [];
  return {
    connected: !!c.connected,
    home: home || null,
    automations,
    automationTotal: automations.length,
    automationActive: automations.filter((a) => a.active).length,
    error: c.error || null,
    syncedAt: c.synced_at || 0,
    chat: { messages: chatLog, empty: chatLog.length === 0 },
    planExport: state.plan_export || null,
    planPaths: exportPaths,
  };
}

// ---------------------------------------------------------------- registry

// A view is a first-class module: navigation, native shell, tray, email and
// `--json` all read this list instead of hard-coded tab arrays, which is what
// "add a feature = add a directory + register one line" means in practice.
export const VIEW_REGISTRY = [
  { id: 'today', title: '今日', icon: '◇', order: 10, kind: 'view', build: buildTodayVM },
  { id: 'calendar', title: '日程', icon: '▦', order: 20, kind: 'view', build: null },
  { id: 'tasks', title: '任务', icon: '✓', order: 30, kind: 'view', build: buildTasksVM },
  { id: 'habits', title: '养成', icon: '△', order: 40, kind: 'view', build: null },
  { id: 'notifications', title: '通知', icon: '◉', order: 50, kind: 'view', build: buildNotificationsVM },
  { id: 'stats', title: '统计', icon: '▤', order: 60, kind: 'view', build: null },
  { id: 'sources', title: '数据源', icon: '✕', order: 70, kind: 'view', build: buildSourcesVM },
  { id: 'music', title: '音乐', icon: '♪', order: 80, kind: 'view', build: null },
];

export const registeredViews = () => [...VIEW_REGISTRY].sort((a, b) => a.order - b.order);

export const buildView = (id, state, nowMs = Date.now()) => {
  const entry = VIEW_REGISTRY.find((v) => v.id === id);
  if (!entry || !entry.build) return null;
  return entry.build(state, nowMs);
};

// ---------------------------------------------------------------- 2nd surface

// Proof that the ViewModel is display-independent: the same object that feeds
// the browser is rendered to plain text here (and to Markdown in the test).
export function renderText(vm) {
  if (!vm) return '';
  const out = [vm.title + (vm.summary ? `　${vm.summary}` : '')];
  for (const s of vm.sections) {
    out.push(`【${s.title}】`);
    for (const i of s.items) out.push(`  · ${i.title}${i.meta ? `（${i.meta}）` : ''}`);
  }
  return out.join('\n');
}

export function renderMarkdown(vm) {
  if (!vm) return '';
  const out = [`# ${vm.title}`, ''];
  if (vm.summary) out.push(vm.summary, '');
  for (const s of vm.sections) {
    out.push(`## ${s.title}`, '');
    for (const i of s.items) out.push(`- **${i.title}**${i.meta ? ` — ${i.meta}` : ''}`);
    out.push('');
  }
  return out.join('\n');
}
