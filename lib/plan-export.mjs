// 把 Planner 的「每日计划与安排」导出为 Codex 可读的文件(Markdown + JSON)。
// 默认写到 <dataDir>/plan/ 以及 <CODEX_HOME>/planner/，Codex 任意会话都能直接读取。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dueDayKey, dueLabel, isOverdue } from './duedate.mjs';

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

// 写出 Markdown + JSON 到 dataDir/plan 与 CODEX_HOME/planner。
export function writePlanExport(store, { dataDir, codexHome, days = 14 } = {}) {
  const plan = buildPlan(store, { days });
  const md = planToMarkdown(plan);
  const paths = [];
  const targets = [];
  if (dataDir) targets.push(join(dataDir, 'plan'));
  if (codexHome) targets.push(join(codexHome, 'planner'));
  for (const dir of targets) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'daily-plan.md'), md, 'utf8');
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
      paths.push(join(dir, 'daily-plan.md'));
    } catch { /* 单个目标失败不影响其它 */ }
  }
  return { exported_at: plan.exported_at, paths, markdown: md, plan };
}
