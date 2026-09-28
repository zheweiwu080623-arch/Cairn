// 把 Planner 的「每日计划与安排」导出成文件（Markdown / JSON / ICS / CSV，2026-09-28 起可选）。
// 默认写到 <dataDir>/plan/ 以及 <CODEX_HOME>/planner/，Codex 任意会话都能直接读取。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dueDayKey, dueLabel, isOverdue } from './duedate.mjs';
import { buildIcs } from './ics.mjs';

/**
 * 能导出的四种格式（设置 → 本机 → 计划导出 里勾选；默认 md + json，和以前一样）。
 *
 *   md   —— 给人 / 给 Codex 看的正文（`daily-plan.md`）
 *   json —— 给程序读的完整结构（`plan.json`）
 *   ics  —— 日历（导进手机 / 办公本日历；复用 lib/ics.mjs，跟 /api/calendar 同一套）
 *   csv  —— 表格（导进 Excel / 飞书表格，一行一件事）
 */
export const PLAN_FORMATS = ['md', 'json', 'ics', 'csv'];
export const PLAN_FORMAT_LABELS = {
  md: 'Markdown（给 Codex / 人看）',
  json: 'JSON（给程序读）',
  ics: 'ICS 日历（导进手机 / 办公本日历）',
  csv: 'CSV 表格（导进 Excel / 飞书表格）',
};
export const DEFAULT_PLAN_FORMATS = ['md', 'json'];

/** 把（设置里存的 / 接口传来的）格式串规整成数组：只留认识的、去重、按固定顺序。 */
export function normalizePlanFormats(value) {
  const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,，;\s]+/);
  const wanted = new Set(list.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean));
  const out = PLAN_FORMATS.filter((f) => wanted.has(f));
  return out.length ? out : [...DEFAULT_PLAN_FORMATS];
}

/** 每种格式写出来的文件名（`/api/plan.<fmt>` 与磁盘上同一套名字）。 */
export const PLAN_FILE_NAMES = {
  md: 'daily-plan.md', json: 'plan.json', ics: 'daily-plan.ics', csv: 'daily-plan.csv',
};

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayKeyOf = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : ymd(d); };
const hm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDT = (iso) => { const d = new Date(iso); return isNaN(d) ? (iso || '') : `${ymd(d)} ${hm(d)}`; };
const PRI = { 0: '紧急', 1: '高', 2: '中', 3: '低' };
const STATUS = { todo: '待办', doing: '进行中', done: '已完成' };

function taskLine(t) {
  const box = t.status === 'done' ? '[x]' : '[ ]';
  const bits = [];
  if (t.due_at) bits.push(dueLabel(t.due_at));
  if (t.priority != null) bits.push(PRI[t.priority] || '');
  if (t.status === 'doing') bits.push('进行中');
  if (t.tags) bits.push('#' + t.tags);
  const note = t.notes ? ` — ${t.notes}` : '';
  return `- ${box} ${t.title || '(无标题)'}${bits.length ? `（${bits.filter(Boolean).join(' · ')}）` : ''}${note}`;
}

export function buildPlan(store, { days = 14 } = {}) {
  const tasks = store.listTasks();
  const events = store.listEvents();
  const notifs = store.listNotifications();
  const courses = store.listCourses();
  const academic = store.listAcademic();
  const milestones = store.listMilestones ? store.listMilestones() : [];
  const now = new Date();

  const dayList = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i);
    const key = ymd(d);
    const isoWd = d.getDay() === 0 ? 7 : d.getDay(); // 1=Mon .. 7=Sun
    dayList.push({
      date: key,
      weekday: WEEK[(d.getDay() + 6) % 7],
      is_today: i === 0,
      events: events.filter((e) => dayKeyOf(e.start_at) === key)
        .map((e) => ({ title: e.title, start: fmtDT(e.start_at), end: e.end_at ? fmtDT(e.end_at) : '', all_day: !!e.all_day, notes: e.notes || '' })),
      courses: courses.filter((c) => c.weekday === isoWd)
        .map((c) => ({ course: c.course, start: c.start_at, end: c.end_at, location: c.location || '', teacher: c.teacher || '' })),
      due_tasks: tasks.filter((t) => t.due_at && dueDayKey(t.due_at) === key)
        .map((t) => ({ title: t.title, due: dueLabel(t.due_at), status: t.status, priority: t.priority, notes: t.notes || '' })),
      reminders: notifs.filter((n) => n.enabled && n.trigger_at && dayKeyOf(n.trigger_at) === key)
        .map((n) => ({ title: n.title, at: fmtDT(n.trigger_at), message: n.message || '' })),
      academic: academic.filter((a) => { const s = dayKeyOf(a.start_at); const e = a.end_at ? dayKeyOf(a.end_at) : s; return s && key >= s && key <= e; })
        .map((a) => ({ title: a.title, kind: a.kind })),
      milestones: milestones.filter((m) => dayKeyOf(m.target_at) === key).map((m) => ({ title: m.title, kind: m.kind })),
    });
  }

  const open = tasks.filter((t) => t.status !== 'done');
  return {
    exported_at: new Date().toISOString(),
    exported_at_local: `${ymd(now)} ${hm(now)}`,
    app: '空庭Coterie的Planner',
    source: 'http://localhost:3210',
    today: ymd(now),
    days: dayList,
    backlog: {
      overdue: open.filter((t) => t.due_at && isOverdue(t.due_at, now.getTime())).map((t) => ({ title: t.title, due: dueLabel(t.due_at), priority: t.priority })),
      no_due: open.filter((t) => !t.due_at).map((t) => ({ title: t.title, priority: t.priority })),
    },
    stats: {
      open_tasks: open.length,
      done_tasks: tasks.length - open.length,
      events: events.length,
    },
  };
}

export function planToMarkdown(plan) {
  const L = [];
  L.push('# 空庭Coterie 的 Planner · 每日计划与安排');
  L.push('');
  L.push(`> 导出时间：${plan.exported_at_local}　数据源：本机 Planner 应用（${plan.source}）`);
  L.push(`> 概览：未完成任务 ${plan.stats.open_tasks}，已完成 ${plan.stats.done_tasks}，日程 ${plan.stats.events} 项`);
  L.push('');
  for (const d of plan.days) {
    const tag = d.is_today ? '（今天）' : '';
    L.push(`## ${d.date} 周${d.weekday}${tag}`);
    if (d.academic.length) L.push(`- 校历：${d.academic.map((a) => a.title).join('、')}`);
    if (d.courses.length) {
      L.push('### 课程');
      for (const c of d.courses) L.push(`- ${c.start}–${c.end} ${c.course}${c.location ? ' @' + c.location : ''}${c.teacher ? `（${c.teacher}）` : ''}`);
    }
    if (d.events.length) {
      L.push('### 日程');
      for (const e of d.events) L.push(`- ${e.all_day ? '全天' : `${e.start.slice(11)}${e.end ? '–' + e.end.slice(11) : ''}`}　${e.title}${e.notes ? ` — ${e.notes}` : ''}`);
    }
    const pending = d.due_tasks.filter((t) => t.status !== 'done');
    if (pending.length) {
      L.push('### 到期任务');
      for (const t of pending) L.push(`- [ ] ${t.title}（${t.priority != null ? PRI[t.priority] : ''}${t.status === 'doing' ? ' · 进行中' : ''}）${t.notes ? ' — ' + t.notes : ''}`);
    }
    const done = d.due_tasks.filter((t) => t.status === 'done');
    if (done.length) L.push(`- （已完成 ${done.length} 项：${done.map((t) => t.title).join('、')}）`);
    if (d.reminders.length) {
      L.push('### 提醒');
      for (const r of d.reminders) L.push(`- ${r.at.slice(11)}　${r.title}${r.message ? ` — ${r.message}` : ''}`);
    }
    if (d.milestones.length) L.push(`- 里程碑：${d.milestones.map((m) => m.title).join('、')}`);
    if (!d.academic.length && !d.courses.length && !d.events.length && !d.due_tasks.length && !d.reminders.length && !d.milestones.length) L.push('- （无安排）');
    L.push('');
  }
  L.push('## 逾期任务');
  L.push(plan.backlog.overdue.length ? plan.backlog.overdue.map((t) => `- [ ] ${t.title}（原截止 ${t.due}）`).join('\n') : '- （无）');
  L.push('');
  L.push('## 未排期任务');
  L.push(plan.backlog.no_due.length ? plan.backlog.no_due.map((t) => `- [ ] ${t.title}`).join('\n') : '- （无）');
  L.push('');
  return L.join('\n');
}

/**
 * 把计划导成 **CSV 表格**（一行一件事）：日期 / 星期 / 类型 / 开始 / 结束 / 标题 / 地点 / 状态 / 优先级 / 备注。
 * 导进 Excel、飞书表格都能直接读 —— 用来"自己再排一遍"或跟别人对表。
 *
 * 两个刻意的处理：
 *   1) 字段里带逗号、引号、换行 → 按 RFC 4180 用双引号包起来并把引号写成两个（不然表格会错位）；
 *   2) 以 `= + - @` 开头的字段前面加一个单引号 —— 因为标题可能是**外部数据源的原文**
 *      （邮件主题、Canvas 作业名），直接喂给 Excel 会被当公式执行（CSV 注入）。
 *      Excel 里看到的是原文（单引号是它的转义写法），数据本身没改。
 */
export function planToCsv(plan) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };
  const timePart = (s) => {
    const t = String(s || '');
    const m = t.match(/(\d{2}:\d{2})/);
    return m ? m[1] : t;
  };
  const rows = [['日期', '星期', '类型', '开始', '结束', '标题', '地点', '状态', '优先级', '备注']];
  const push = (date, weekday, kind, start, end, title, where, status, prio, note) => {
    rows.push([date, weekday, kind, start, end, title, where, status, prio, note]);
  };
  for (const d of plan.days) {
    for (const a of d.academic) push(d.date, `周${d.weekday}`, '校历', '', '', a.title, '', '', '', a.kind || '');
    for (const c of d.courses) {
      push(d.date, `周${d.weekday}`, '课程', timePart(c.start), timePart(c.end), c.course, c.location || '', '', '', c.teacher || '');
    }
    for (const e of d.events) {
      push(d.date, `周${d.weekday}`, '日程', e.all_day ? '' : timePart(e.start), e.all_day ? '' : timePart(e.end),
        e.title, '', e.all_day ? '全天' : '', '', e.notes || '');
    }
    for (const t of d.due_tasks) {
      push(d.date, `周${d.weekday}`, '到期任务', t.due || '', '', t.title, '', STATUS[t.status] || t.status || '',
        t.priority != null ? (PRI[t.priority] || '') : '', t.notes || '');
    }
    for (const r of d.reminders) push(d.date, `周${d.weekday}`, '提醒', timePart(r.at), '', r.title, '', '', '', r.message || '');
    for (const m of d.milestones) push(d.date, `周${d.weekday}`, '里程碑', '', '', m.title, '', '', '', m.kind || '');
  }
  for (const t of plan.backlog.overdue) {
    push('', '', '逾期任务', t.due || '', '', t.title, '', '待办', t.priority != null ? (PRI[t.priority] || '') : '', '');
  }
  for (const t of plan.backlog.no_due) {
    push('', '', '未排期任务', '', '', t.title, '', '待办', t.priority != null ? (PRI[t.priority] || '') : '', '');
  }
  // \r\n：Excel 与 RFC 4180 都认这个，记事本打开也不会连成一行
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// 写出 Markdown + JSON（以及勾选上的 ICS / CSV）到 dataDir/plan 与 CODEX_HOME/planner。
export function writePlanExport(store, { dataDir, codexHome, days = 14, formats = null } = {}) {
  const plan = buildPlan(store, { days });
  const wanted = normalizePlanFormats(formats);
  const md = planToMarkdown(plan);
  const csv = wanted.includes('csv') ? planToCsv(plan) : '';
  // ICS 走 lib/ics.mjs 那一套（和 /api/calendar 同一份实现），窗口就是这份计划的天数
  let ics = '';
  if (wanted.includes('ics')) {
    // buildIcs 返回的是 { ics, count, units, from, to }：这里只要正文
    try { ics = buildIcs(store, { pastDays: 0, futureDays: days }).ics || ''; } catch { ics = ''; }
  }
  const bodies = {
    md, json: JSON.stringify(plan, null, 2), ics, csv,
  };
  const paths = [];
  const targets = [];
  if (dataDir) targets.push(join(dataDir, 'plan'));
  if (codexHome) targets.push(join(codexHome, 'planner'));
  for (const dir of targets) {
    try {
      mkdirSync(dir, { recursive: true });
      for (const fmt of wanted) {
        const body = bodies[fmt];
        if (!body) continue;                       // 这一种这次没生成出来（例如没有 ics 数据）
        const file = join(dir, PLAN_FILE_NAMES[fmt]);
        writeFileSync(file, body, 'utf8');
        paths.push(file);
      }
    } catch { /* 单个目标失败不影响其它 */ }
  }
  return { exported_at: plan.exported_at, formats: wanted, paths, markdown: md, csv, plan };
}
