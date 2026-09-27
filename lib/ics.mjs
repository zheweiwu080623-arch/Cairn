// 生成 iCalendar(.ics)：课程表 / 校历 / 日程 / 截止任务 / 里程碑。
// 供 iPhone 日历、iFlytek 办公本、Google Calendar 等订阅或一次性导入。
// 无第三方依赖，纯字符串拼装。
import { createHash } from 'node:crypto';
import { dueMs } from './duedate.mjs';

const TZID = 'Asia/Shanghai';
const pad = (n) => String(n).padStart(2, '0');

const parseAny = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
// "2026-09-14" 这类纯日期按本地零点解析，避免时区把日期挪一天。
const parseDate = (v) => {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = parseAny(v);
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null;
};
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utcStamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
  + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const localStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  + `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const dateStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

// iCal 文本转义：反斜杠、分号、逗号、换行。
const escText = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n');

// 折行：每行不超过 73 字节（UTF-8），续行以一个空格开头。
function fold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 73) return line;
  const out = [];
  let cur = '';
  let limit = 73;
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > limit) {
      out.push(cur);
      cur = ' ' + ch;
      limit = 73;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}

const uid = (kind, key) => `${kind}-${createHash('sha1').update(String(key)).digest('hex').slice(0, 16)}@codex-planner`;

// "1-14" / "1,3,5" / "1,3-5" / "" 都解析成周次数组；空值按 1-20 处理。
function parseWeeks(spec, maxWeek = 20) {
  const s = String(spec || '').trim();
  const set = new Set();
  if (!s) { for (let i = 1; i <= maxWeek; i++) set.add(i); return set; }
  for (const part of s.split(/[,，;；\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*[-~到]\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    } else if (/^\d+$/.test(part)) {
      set.add(Number(part));
    }
  }
  return set;
}

// 真课程（带课号，如 MATH1860J / KE1201）与作息块（早读、娱乐）区分开。
const COURSE_CODE = /[A-Z]{2,8}\s?\d{3,5}[A-Z]?/;
const isRealCourse = (c) => COURSE_CODE.test(String(c.course || ''));
const hasEmoji = (s) => /^\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(String(s || ''));

const hm = (s) => {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
};

function atTime(d, spec) {
  const t = hm(spec);
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t ? t.h : 0, t ? t.m : 0, 0);
  return out;
}

function eventLines(lines, ev) {
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${ev.uid}`);
  lines.push(`DTSTAMP:${utcStamp(ev.stamp || new Date())}`);
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(ev.start)}`);
    lines.push(`DTEND;VALUE=DATE:${dateStamp(ev.end)}`);
  } else {
    lines.push(`DTSTART;TZID=${TZID}:${localStamp(ev.start)}`);
    lines.push(`DTEND;TZID=${TZID}:${localStamp(ev.end)}`);
  }
  lines.push(`SUMMARY:${escText(ev.summary)}`);
  if (ev.location) lines.push(`LOCATION:${escText(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escText(ev.description)}`);
  if (ev.url) lines.push(`URL:${ev.url}`);
  if (ev.status) lines.push(`STATUS:${ev.status}`);
  if (ev.categories) lines.push(`CATEGORIES:${escText(ev.categories)}`);
  if (ev.alarmMinutes != null) {
    lines.push('BEGIN:VALARM');
    lines.push('ACTION:DISPLAY');
    lines.push(`DESCRIPTION:${escText(ev.summary)}`);
    lines.push(`TRIGGER:-PT${Math.abs(ev.alarmMinutes)}M`);
    lines.push('END:VALARM');
  }
  lines.push('END:VEVENT');
}

/**
 * 生成整份日历。
 * @param {object} store planner 的 store
 * @param {object} [opts]
 * @param {number} [opts.pastDays=14]  往前包含多少天
 * @param {number} [opts.futureDays=180] 往后包含多少天
 * @param {boolean} [opts.routine=false] 是否把作息块（早读/娱乐）也放进日历
 * @param {boolean} [opts.tasks=true] 是否包含有截止时间的未完成任务
 * @param {boolean} [opts.events=true] 是否包含日程
 * @param {boolean} [opts.notifications=false] 是否把提醒也作为事件导出
 * @param {string} [opts.name='空庭Coterie的Planner']
 */
export function buildIcs(store, opts = {}) {
  const {
    pastDays = 14, futureDays = 180, routine = false,
    tasks = true, events = true, notifications = false,
    milestones = true, name = '空庭Coterie的Planner', alarms = true,
  } = opts;

  const now = new Date();
  const from = new Date(now); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - pastDays);
  const to = new Date(now); to.setHours(23, 59, 59, 0); to.setDate(to.getDate() + futureDays);

  const academic = store.listAcademic ? store.listAcademic() : [];
  const courses = store.listCourses ? store.listCourses() : [];
  const planEvents = events && store.listEvents ? store.listEvents() : [];
  const taskRows = tasks && store.listTasks ? store.listTasks() : [];
  const notifRows = notifications && store.listNotifications ? store.listNotifications() : [];
  const milestoneRows = milestones && store.listMilestones ? store.listMilestones() : [];

  const term = academic.find((a) => a.kind === 'term' && parseDate(a.start_at) && parseDate(a.start_at) <= now)
    || academic.find((a) => a.kind === 'term');
  const termStart = term ? parseDate(term.start_at) : null;
  const termEnd = term && term.end_at ? parseDate(term.end_at) : null;
  // 学期结束后再多给两周，让订阅者能看到期末收尾。
  if (termEnd && termEnd > now && termEnd < to) {
    const tail = new Date(termEnd); tail.setDate(tail.getDate() + 14);
    if (tail < to) to.setTime(tail.getTime());
  }
  const holidays = academic.filter((a) => a.kind === 'holiday').map((a) => ({
    s: parseDate(a.start_at), e: parseDate(a.end_at || a.start_at),
  })).filter((h) => h.s);
  const inHoliday = (d) => holidays.some((h) => h.s && d >= h.s && (!h.e || d <= h.e));

  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//Codex Planner//Kotei Coterie//CN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:${escText(name)}`);
  lines.push('X-WR-TIMEZONE:Asia/Shanghai');
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
  lines.push('X-PUBLISHED-TTL:PT1H');
  lines.push('BEGIN:VTIMEZONE');
  lines.push(`TZID:${TZID}`);
  lines.push('BEGIN:STANDARD');
  lines.push('DTSTART:19700101T000000');
  lines.push('TZOFFSETFROM:+0800');
  lines.push('TZOFFSETTO:+0800');
  lines.push('TZNAME:CST');
  lines.push('END:STANDARD');
  lines.push('END:VTIMEZONE');

  let count = 0;
  const stamp = new Date();
  // 每条事件单独留一份，供 CalDAV 逐条 PUT 到 iCloud 日历。
  const units = [];
  const emit = (ev) => {
    const unit = [];
    eventLines(unit, ev);
    units.push({ uid: ev.uid, lines: unit });
    lines.push(...unit);
    count += 1;
  };

  // ---- 1. 课程表：按周次展开成一条条具体课程 ----
  if (termStart) {
    const week1 = new Date(termStart);
    while (week1.getDay() !== 1) week1.setDate(week1.getDate() - 1); // 归到周一
    for (const c of courses) {
      const real = isRealCourse(c);
      if (!real && !routine) continue;
      const wk = Number(c.weekday || 1);
      const weeks = parseWeeks(c.weeks, 20);
      for (const w of weeks) {
        const day = new Date(week1);
        day.setDate(day.getDate() + (w - 1) * 7 + (wk - 1));
        if (day < from || day > to) continue;
        if (real && inHoliday(day)) continue;        // 正式课程遇假期停课，作息块照常保留
        const start = atTime(day, c.start_at);
        const end = atTime(day, c.end_at);
        if (!start || !end) continue;
        const desc = [];
        if (c.teacher) desc.push(`教师：${c.teacher}`);
        if (c.weeks) desc.push(`周次：${c.weeks}`);
        desc.push(`第 ${w} 教学周`);
        emit({
          uid: uid('course', `${c.id || c.course}|${dayKey(day)}`),
          stamp, start, end,
          summary: c.course,
          location: c.location || '',
          description: desc.join(' · '),
          categories: real ? '课程' : '作息',
          alarmMinutes: real && alarms ? 20 : null,
        });
      }
    }
  }

  // ---- 2. 校历（开学 / 假期 / 考试周）----
  for (const a of academic) {
    const s = parseDate(a.start_at);
    if (!s) continue;
    // 学期整段（kind=term，跨度近 4 个月）只在开学当天放一条，避免日历上挂一条长横幅。
    const e = a.kind === 'term' ? s : (parseDate(a.end_at) || s);
    if (e < from || s > to) continue;
    const end = new Date(e); end.setDate(end.getDate() + 1); // iCal 全天事件结束为次日
    emit({
      uid: uid('academic', a.id || a.title),
      stamp, start: s, end, allDay: true,
      summary: a.title,
      description: a.notes || '',
      categories: a.kind === 'holiday' ? '假期' : a.kind === 'exam' ? '考试' : '校历',
      alarmMinutes: null,
    });
  }

  // ---- 3. 日程 ----
  for (const e of planEvents) {
    const s = parseAny(e.start_at);
    if (!s) continue;
    if (s < from || s > to) continue;
    const en = parseAny(e.end_at);
    if (e.all_day) {
      const base = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      const endD = en ? new Date(en.getFullYear(), en.getMonth(), en.getDate()) : base;
      const end = new Date(endD); end.setDate(end.getDate() + 1);
      emit({
        uid: uid('event', e.id), stamp, start: base, end, allDay: true,
        summary: e.title, description: e.notes || '', categories: '日程',
      });
    } else {
      const end = en && en > s ? en : new Date(s.getTime() + 60 * 60 * 1000);
      emit({
        uid: uid('event', e.id), stamp, start: s, end,
        summary: e.title, description: e.notes || '', categories: '日程',
        alarmMinutes: alarms ? 15 : null,
      });
    }
  }

  // ---- 4. 有截止时间的未完成任务（DDL）----
  for (const t of taskRows) {
    if (!t.due_at || t.status === 'done') continue;
    // 统一规则：纯日期 = 当天 23:59 截止（lib/duedate.mjs）
    const dueValue = dueMs(t.due_at);
    if (dueValue === null) continue;
    const due = new Date(dueValue);
    if (due < from || due > to) continue;
    const tag = t.tags ? `${t.tags}` : '';
    const desc = [t.notes || '', tag ? `标签：${tag}` : '', `优先级：${t.priority}`].filter(Boolean).join(' · ');
    const day = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const end = new Date(day); end.setDate(end.getDate() + 1);
    emit({
      uid: uid('task', t.id), stamp, start: day, end, allDay: true,
      summary: `DDL: ${t.title}`,
      description: desc, categories: '任务',
    });
  }

  // ---- 5. 里程碑 ----
  for (const m of milestoneRows) {
    if (m.done) continue;
    const s = parseDate(m.target_at);
    if (!s || s < from || s > to) continue;
    const end = new Date(s); end.setDate(end.getDate() + 1);
    emit({
      uid: uid('milestone', m.id), stamp, start: s, end, allDay: true,
      summary: `里程碑: ${m.title}`,
      description: m.note || '',
      categories: m.kind === 'exam' ? '考试' : m.kind === 'deadline' ? '截止' : '里程碑',
      alarmMinutes: alarms && m.kind !== 'date' ? 1440 : null,
    });
  }

  // ---- 6. 提醒（默认不导出，避免刷屏）----
  for (const n of notifRows) {
    if (!n.enabled || !n.trigger_at) continue;
    const s = parseAny(n.trigger_at);
    if (!s || s < from || s > to) continue;
    const end = new Date(s.getTime() + 15 * 60 * 1000);
    emit({
      uid: uid('reminder', n.id), stamp, start: s, end,
      summary: `提醒: ${n.title}`, description: n.message || '', categories: '提醒',
    });
  }

  lines.push('END:VCALENDAR');
  const body = lines.map(fold).join('\r\n') + '\r\n';
  return {
    ics: body, count, units,
    from: dayKey(from), to: dayKey(to),
    term_start: termStart ? dayKey(termStart) : null,
  };
}

// 把整份日历拆成一条事件一个 .ics（CalDAV 逐条上传用；每条自带 VTIMEZONE）。
export function buildIcsUnits(store, opts = {}) {
  const { ics, units, count, from, to } = buildIcs(store, opts);
  const head = ics.split('BEGIN:VEVENT')[0].replace(/\r\n$/, '');
  const out = units.map((u) => ({
    uid: u.uid,
    ics: `${head}\r\n${u.lines.map(fold).join('\r\n')}\r\nEND:VCALENDAR\r\n`,
  }));
  return { units: out, count, from, to };
}
