// preclass.mjs —— 「上课前 N 分钟检查这门课的 Canvas」（纯函数）
//
// 用户原话："在上课前半小时立即检查马上要上的课的 canvas。"
//
// 它属于三段式的**第二段（分析）**：每隔一会儿算一次"接下来 N 分钟内有课吗？是哪门课？"，
// 命中的就产出一条 `signal.v1`（delivery=now），交给再处理段的功能（`modules/preclass-check/`）
// 去决定"要不要提醒、提醒什么"。**这里不联网、不发通知**，所以能离线测。
//
// 三个容易踩的点，都在这里一次说清：
//   1) 单双周：课表里 `weeks` 可能是 "1-13" 也可能是 "1,3,5,7,9,11,13"（单周）；
//   2) 周次是相对**学期第 1 周**算的（学期起止在 academic_events 里，kind=term）；
//   3) 一天只检查一次：同一门课的同一节课，检查过就不再查（由调用方传 checked 集合）。

export const PRECLASS_SCHEMA = 'preclass.v1';

export const PRECLASS_DEFAULT = Object.freeze({
  schema: PRECLASS_SCHEMA,
  enabled: true,          // 检查本身默认开（这是用户点名要的功能）
  lead_minutes: 30,       // 提前多少分钟开始查
  notify_in_app: true,    // 有新增就进应用内通知
  bark: false,            // 手机推送默认关（短句通道，由用户自己勾）
  since_hours: 48,        // 只看最近 48 小时内更新的材料（避免把整学期都翻出来）
  updated_at: 0,
});

const bool = (v, d) => (v === undefined || v === null ? d : (v === true || v === '1' || v === 1 || v === 'true'));
const intIn = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

/** 设置清洗：把界面/存储里来的东西都当不可信。 */
export function normalizePreclass(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    schema: PRECLASS_SCHEMA,
    enabled: bool(r.enabled, PRECLASS_DEFAULT.enabled),
    lead_minutes: intIn(r.lead_minutes, 5, 180, PRECLASS_DEFAULT.lead_minutes),
    notify_in_app: bool(r.notify_in_app, PRECLASS_DEFAULT.notify_in_app),
    bark: bool(r.bark, PRECLASS_DEFAULT.bark),
    since_hours: intIn(r.since_hours, 1, 24 * 14, PRECLASS_DEFAULT.since_hours),
    updated_at: Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : 0,
  };
}

/**
 * 把任意时刻换算成"北京时间的挂钟"（口径与 `lib/peak.mjs` 完全一致：
 * 先加回时区偏移得到 UTC，再加 8 小时）。**不要再发明第二套换算** —— 2026-09-23 就因为
 * 写成了 `480 - offset`（本机 offset 是 -480，等于加 16 小时）而把周一算成了周二。
 */
export function beijingClock(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  return new Date(utcMs + 8 * 3600000);
}

/** 北京时间下的"星期几"：1=周一 … 7=周日（和课表 course_schedule.weekday 一致）。 */
export function weekdayOf(date = new Date()) {
  const wd = beijingClock(date).getDay();
  return wd === 0 ? 7 : wd;
}

/** 北京时间下的 YYYY-MM-DD（用来做"今天检查过没有"的键）。 */
export function dateKeyOf(date = new Date()) {
  const cn = beijingClock(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${cn.getFullYear()}-${p(cn.getMonth() + 1)}-${p(cn.getDate())}`;
}

/** "1-13" / "1,3,5,7" / "1-13,15" → 周次数组；空/认不出来 → null（= 每周都上）。 */
export function parseWeeks(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const out = new Set();
  for (const part of s.split(/[,，、;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part));
    }
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/** 学期第几周（1 起算）。termStart 是"第 1 周的周一"（没有就返回 null）。 */
export function weekNumber(date, termStart) {
  const start = termStart ? new Date(termStart) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const d = date instanceof Date ? date : new Date(date);
  const days = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
    - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000);
  return Math.floor(days / 7) + 1;
}

/** 这门课今天上不上（星期 + 周次）。 */
export function meetsOn(course = {}, date = new Date(), termStart = null) {
  if (Number(course.weekday) !== weekdayOf(date)) return false;
  const weeks = parseWeeks(course.weeks);
  if (!weeks) return true;                       // 没写周次 = 每周都上
  const wk = weekNumber(date, termStart);
  if (wk === null) return true;                  // 没有学期起点就不按周次过滤（宁可多查一次）
  return weeks.includes(wk);
}

/** 从课程名里抠课程代码（"高等数学B1 · Honors Mathematics II MATH1860J" → MATH1860J）。 */
export function courseCodeOf(course = {}) {
  const s = String(course.course_code || course.course || '');
  const m = s.match(/\b([A-Z]{2,6}\d{3,4}[A-Z]?)\b/);
  return m ? m[1] : (String(course.course_code || '').trim() || '');
}

/** 这门课今天的开始时间（Date）。 */
export function sessionStartAt(course = {}, date = new Date()) {
  const m = String(course.start_at || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

/**
 * 找出"接下来 leadMinutes 内要上、且今天还没检查过"的课。
 * @param {any[]} courses     课表（store.listCourses()）
 * @param {{now?:number, leadMinutes?:number, termStart?:string|Date|null, checked?:Set<string>|string[]}} opts
 * @returns {Array<{key, course, courseCode, courseName, startAt, minutesLeft, dateKey, location, weekday}>}
 */
export function upcomingSessions(courses = [], {
  now = Date.now(), leadMinutes = PRECLASS_DEFAULT.lead_minutes, termStart = null, checked = [],
} = {}) {
  const when = new Date(now);
  const done = checked instanceof Set ? checked : new Set(checked || []);
  const dateKey = dateKeyOf(when);
  const out = [];
  for (const c of Array.isArray(courses) ? courses : []) {
    if (!meetsOn(c, when, termStart)) continue;
    const startAt = sessionStartAt(c, when);
    if (!startAt) continue;
    const minutesLeft = (startAt.getTime() - when.getTime()) / 60000;
    if (minutesLeft <= 0 || minutesLeft > leadMinutes) continue;
    const courseCode = courseCodeOf(c);
    if (!courseCode) continue;
    const key = `preclass:${courseCode}:${dateKey}:${c.start_at}`;
    if (done.has(key)) continue;
    out.push({
      key, course: c, courseCode,
      courseName: String(c.course || '').trim(),
      startAt: startAt.toISOString(), minutesLeft: Math.round(minutesLeft),
      dateKey, location: c.location || '', weekday: Number(c.weekday) || weekdayOf(when),
    });
  }
  return out.sort((a, b) => a.minutesLeft - b.minutesLeft);
}

/**
 * 把一条"快要上课"的事实折成 signal.v1（第二段的产出，喂给再处理功能）。
 * **没有判断"要不要打扰"的权力** —— 那属于功能（processor）；这里只把事实写清楚。
 */
export function buildSignal(session, { now = Date.now(), sinceMs = 48 * 3600000 } = {}) {
  const at = new Date(now).toISOString();
  return {
    schema: 'signal.v1',
    id: `signal:preclass:${session.courseCode}:${session.dateKey}`,
    item_id: `course:${session.courseCode}:${session.dateKey}`,
    created_at: at,
    score: 80,
    band: 'high',
    verdict: 'push',
    confidence: 1,
    reasons: [{ rule: 'class-soon', label: `${session.minutesLeft} 分钟后上课`, delta: 0 }],
    evidence: [{ kind: 'metadata', text: `${session.courseName}${session.location ? ` @${session.location}` : ''}`, ref: null }],
    delivery: 'now',
    analysis: { engine: 'rules', ms: 0, cost: 0, cached: false },
    meta: {
      courseCode: session.courseCode,
      courseName: session.courseName,
      startAt: session.startAt,
      minutesLeft: session.minutesLeft,
      dateKey: session.dateKey,
      sinceMs,          // 只关心这段时间内更新的材料
      session_key: session.key,
    },
  };
}

/** 检查结果 → 一句人话（给通知/日志用）。 */
export function describeCheck({ courseName, courseCode, minutesLeft, fresh = [], error = '' } = {}) {
  const who = courseName || courseCode || '这门课';
  if (error) return `上课前检查「${who}」没成功：${error}`;
  if (!fresh.length) return `上课前检查「${who}」：${minutesLeft} 分钟后上课，Canvas 上没有新东西。`;
  const kinds = [...new Set(fresh.map((x) => x.type))].join('/');
  return `上课前 ${minutesLeft} 分钟：${who} 有 ${fresh.length} 条新东西（${kinds}）`;
}
