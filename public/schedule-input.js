// schedule-input.js —— 「一行式输入」与「.ics / .csv 导入」的解析器（2026-09-27）
//
// 为什么要单独一个文件：`public/app.js` 已经 4200 多行，而这两件事都是
// **文本 → 结构化条目**的纯函数（不碰 DOM、不发请求）。单拎出来才能直接写单测
// （`tests/schedule-input.test.mjs`），也不至于把主程序继续撑大。
// 它按**经典脚本**在 app.js 之前加载，挂成 `window.ScheduleInput`。
//
// 三件事：
//   parseQuickLine(line, { kind, today })  一行文字 → 一条课程 / 一条校历事项
//   parseIcs(text, { today })              .ics 日历文件 → 校历事项[]（VEVENT）
//   parseCsv(text, { kind, today })        .csv 两列表格或带表头的表格 → 条目[]
//
// 诚实边界：解析不出来的就**说清哪一条、为什么**，绝不猜出一条脏数据塞进去。
(function (global) {
  global.__scheduleInputLoaded = (global.__scheduleInputLoaded || 0) + 1;
  const KINDS = {
    term: { label: '学期', color: '#4f7cff' },
    holiday: { label: '假期', color: '#ffd166' },
    exam: { label: '考试', color: '#ff6b6b' },
    makeup: { label: '补课', color: '#9b59b6' },
    general: { label: '其他', color: '#95a5a6' },
  };
  const KIND_ALIAS = {
    学期: 'term', term: 'term', 开学: 'term',
    假期: 'holiday', 放假: 'holiday', holiday: 'holiday',
    考试: 'exam', 考试周: 'exam', exam: 'exam',
    补课: 'makeup', 调课: 'makeup', makeup: 'makeup',
    其他: 'general', 事项: 'general', general: 'general', other: 'general',
  };
  const WEEK_ALIAS = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
    1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7,
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  /** 周一 = 0 … 周日 = 6 */
  const dow0 = (d) => (d.getDay() + 6) % 7;
  /** 本周一（那一天的 00:00） */
  const mondayOf = (d) => addDays(startOfDay(d), -dow0(d));

  function normalizeKind(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    return KIND_ALIAS[s] || KIND_ALIAS[raw] || '';
  }

  /**
   * 认一段"日期区间"，支持：
   *   今天 / 明天 / 后天 / 昨天
   *   周一…周日（本周那一天的日期）
   *   2026-10-01、2026/10/1、10-01、10/1、10月1日（带年份或不带）
   *   区间用 ~ – — 到 至 连接（2026-10-01-2026-10-07 也认）
   * @returns {{start:string, end:string}|null} 认不出来返回 null
   */
  function parseDateRange(text, { today = new Date() } = {}) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const base = startOfDay(today);

    const rel = { 今天: 0, 明天: 1, 后天: 2, 昨天: -1 };
    if (rel[raw] !== undefined) {
      const d = addDays(base, rel[raw]);
      return { start: dateKey(d), end: dateKey(d) };
    }
    const w = raw.match(/^(?:周|星期|礼拜)([一二三四五六日天1-7]|mon|tue|wed|thu|fri|sat|sun)$/i);
    if (w) {
      const target = WEEK_ALIAS[String(w[1]).toLowerCase()] || WEEK_ALIAS[w[1]];
      if (target) {
        const d = addDays(mondayOf(base), target - 1);
        return { start: dateKey(d), end: dateKey(d) };
      }
    }

    // 拆区间：优先用明确的区间分隔符，避免和日期里的 - 打架
    const rangeSep = /\s*(?:~|～|–|—|到|至)\s*/;
    let [a, b = ''] = raw.split(rangeSep);
    // 形如 2026-10-01-2026-10-07：第二个 4 位年份开头时也当区间
    if (!b) {
      const m = raw.match(/^(.+?)-(\d{4}[-/]\d{1,2}[-/]\d{1,2})$/);
      if (m) { a = m[1]; b = m[2]; }
    }
    const one = (s) => {
      const t = String(s || '').trim();
      let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
      m = t.match(/^(\d{1,2})[-/](\d{1,2})$/);
      if (m) return new Date(base.getFullYear(), +m[1] - 1, +m[2]);
      m = t.match(/^(\d{4})?年?(\d{1,2})月(\d{1,2})日?$/);
      if (m) return new Date(m[1] ? +m[1] : base.getFullYear(), +m[2] - 1, +m[3]);
      return null;
    };
    const s = one(a);
    if (!s) return null;
    const e = b ? one(b) : s;
    if (!e) return null;
    // 区间只写了月-日、而且结束早于开始（跨年，例如 12-30~01-02）→ 结束年 +1
    const endDate = (e < s && /^\d{1,2}[-/]/.test(String(b).trim())) ? new Date(e.getFullYear() + 1, e.getMonth(), e.getDate()) : e;
    return { start: dateKey(s), end: dateKey(endDate) };
  }

  /**
   * 一行式快速输入。两种语法，看当前在哪一页：
   *
   * 校历：`10-01~10-07 国庆假期 #假期 @备注`
   *       `[日期] [标题] [#类型] [@备注]`
   * 课表：`周一 08:00-09:40 高等数学 @东中院4-304 #Zoom 周次1-14`
   *       `[周X] HH:MM-HH:MM [课程名] [@地点] [#平台] [周次A-B]`
   *
   * @returns {{ok:boolean, item?:object, error?:string}}
   */
  function parseQuickLine(line, { kind = 'academic', today = new Date() } = {}) {
    const text = String(line || '').trim();
    if (!text) return { ok: false, error: '先写点什么。例如：10-01~10-07 国庆假期 #假期' };
    return kind === 'course' ? parseQuickCourse(text, today) : parseQuickAcademic(text, today);
  }

  function parseQuickAcademic(text, today) {
    const tokens = text.split(/\s+/);
    const range = parseDateRange(tokens[0], { today });
    if (!range) {
      return { ok: false, error: `开头要是一个日期：今天 / 明天 / 周三 / 10-01 / 2026-10-01~10-07（读到的开头是「${tokens[0]}」）` };
    }
    let rest = text.slice(tokens[0].length).trim();
    let kind = 'general';
    rest = rest.replace(/#([^\s#@]+)/g, (m, tag) => {
      const k = normalizeKind(tag);
      if (k) { kind = k; return ' '; }
      return m;
    });
    let notes = '';
    rest = rest.replace(/@([^\s@]+(?:\s+[^\s@#]+)*)$/u, (m, note) => { notes = String(note).trim(); return ' '; });
    const title = rest.replace(/\s+/g, ' ').trim();
    if (!title) return { ok: false, error: '日期后面要有事项名，例如：10-01~10-07 国庆假期 #假期' };
    return {
      ok: true,
      item: {
        title,
        kind,
        start_at: range.start,
        end_at: range.end,
        notes,
        color: (KINDS[kind] || KINDS.general).color,
      },
    };
  }

  function parseQuickCourse(text, today) {
    let rest = text;
    let weekday = 0;
    const w = rest.match(/^(?:周|星期|礼拜)([一二三四五六日天1-7]|mon|tue|wed|thu|fri|sat|sun)\s+/i);
    if (w) {
      weekday = WEEK_ALIAS[String(w[1]).toLowerCase()] || WEEK_ALIAS[w[1]] || 0;
      rest = rest.slice(w[0].length);
    }
    const t = rest.match(/^(\d{1,2}:\d{2})\s*(?:[-~–—]|到)\s*(\d{1,2}:\d{2})\s*/);
    if (!t) {
      return { ok: false, error: '要写上课时间，例如：周一 08:00-09:40 高等数学 @东中院4-304' };
    }
    const startAt = t[1].length === 4 ? '0' + t[1] : t[1];
    const endAt = t[2].length === 4 ? '0' + t[2] : t[2];
    rest = rest.slice(t[0].length);

    let location = ''; let platform = ''; let weeks = '';
    rest = rest.replace(/#([^\s#@]+)/g, (m, tag) => { platform = String(tag).trim(); return ' '; });
    rest = rest.replace(/@([^\s@#]+)/g, (m, loc) => { location = String(loc).trim(); return ' '; });
    rest = rest.replace(/(?:周次|週次|weeks?|w)\s*[:：]?\s*(\d{1,2}(?:\s*[-~]\s*\d{1,2})?(?:\s*,\s*\d{1,2})*)/i, (m, wk) => {
      weeks = String(wk).replace(/\s+/g, '').replace(/~/g, '-');
      return ' ';
    });
    const course = rest.replace(/\s+/g, ' ').trim();
    if (!course) return { ok: false, error: '时间后面要有课程名，例如：周一 08:00-09:40 高等数学 @东中院4-304' };
    return {
      ok: true,
      item: {
        course,
        weekday: weekday || (dow0(startOfDay(today)) + 1),
        start_at: startAt,
        end_at: endAt,
        location,
        platform,
        weeks: weeks || '1-14',
        color: '#4f7cff',
      },
    };
  }

  // ---------- .ics（日历文件）----------
  /** RFC5545 的续行（下一行以空格/制表开头 = 上一行的延续） */
  function unfold(text) {
    const out = [];
    for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
      else out.push(line);
    }
    return out;
  }
  const unescapeIcs = (s) => String(s || '')
    .replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
  /** `20261001` / `20261001T100000Z` → 'YYYY-MM-DD'（认不出返回 ''） */
  function icsDate(v) {
    const m = String(v || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return '';
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  /** 从标题猜类型（猜不出就 general —— 猜错比猜不出来更糟，所以只认很明确的词） */
  function guessKind(title) {
    const s = String(title || '');
    if (/考试|exam|quiz|midterm|final/i.test(s)) return 'exam';
    if (/假期|放假|holiday|break|festival|节/i.test(s)) return 'holiday';
    if (/学期|开学|term|semester/i.test(s)) return 'term';
    if (/补课|调课|makeup/i.test(s)) return 'makeup';
    return 'general';
  }

  /**
   * 解析 .ics。**只取 VEVENT**（VTODO/VALARM 之类跳过），
   * 全天事件（DTSTART;VALUE=DATE）的 DTEND 是**排他**的（10-01 到 10-08 表示到 10-07），
   * 这里按日历规范减一天 —— 否则假期会多出一天。
   * @returns {{ok:boolean, items:object[], skipped:{title:string,why:string}[], error?:string}}
   */
  function parseIcs(text) {
    const lines = unfold(text);
    if (!/BEGIN:VEVENT/i.test(text || '')) {
      return { ok: false, items: [], skipped: [], error: '这个文件里没有 VEVENT（是不是把 .ics 存成别的了？）' };
    }
    const items = [];
    const skipped = [];
    let cur = null;
    let allDay = false;
    for (const line of lines) {
      const upper = line.toUpperCase();
      if (upper === 'BEGIN:VEVENT') { cur = {}; allDay = false; continue; }
      if (upper === 'END:VEVENT') {
        if (cur) {
          const title = unescapeIcs(cur.SUMMARY) || '(无标题)';
          const start = icsDate(cur.DTSTART);
          if (!start) skipped.push({ title, why: '这条没有能认出来的开始日期' });
          else {
            let end = icsDate(cur.DTEND);
            if (end) {
              const isDateOnly = !/T/.test(String(cur.DTSTART)) && !/T/.test(String(cur.DTEND));
              if (isDateOnly && end > start) {
                const d = new Date(end + 'T00:00:00');
                d.setDate(d.getDate() - 1);
                end = dateKey(d);
              }
            } else end = start;
            const bits = [];
            const desc = unescapeIcs(cur.DESCRIPTION);
            if (desc) bits.push(desc);
            const loc = unescapeIcs(cur.LOCATION);
            if (loc) bits.push(`地点：${loc}`);
            const kind = guessKind(title);
            items.push({
              title, kind, start_at: start, end_at: end, notes: bits.join(' · '),
              color: (KINDS[kind] || KINDS.general).color,
            });
          }
        }
        cur = null;
        continue;
      }
      if (!cur) continue;
      const m = line.match(/^([A-Za-z0-9-]+)(;[^:]*)?:(.*)$/);
      if (!m) continue;
      const key = m[1].toUpperCase();
      if (['SUMMARY', 'DESCRIPTION', 'LOCATION', 'DTSTART', 'DTEND'].includes(key)) {
        cur[key] = m[3];
        if (key === 'DTSTART' && /VALUE=DATE(?!-)/i.test(m[2] || '')) allDay = true;
      }
    }
    return { ok: items.length > 0, items, skipped, ...(items.length ? {} : { error: '没解析出任何可导入的日程' }) };
  }

  // ---------- .csv（两列 / 带表头）----------
  /** 按 CSV 规则切一行（支持 "带逗号的字段"） */
  function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === '\t' || ch === ';') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }
  const ACAD_HEADERS = {
    title: ['标题', '事项', '名称', '事件', 'title', 'summary', 'name', 'subject'],
    start_at: ['日期', '开始日期', '开始', 'start', 'date', 'start_date', 'dtstart'],
    end_at: ['结束日期', '结束', 'end', 'end_date', 'dtend'],
    kind: ['类型', 'kind', 'type', 'category'],
    notes: ['备注', '说明', 'notes', 'description', 'location', '地点'],
  };
  const COURSE_HEADERS = {
    course: ['课程名', '课程', '名称', 'course', 'name', 'subject'],
    weekday: ['星期', '周几', 'weekday', 'day'],
    start_at: ['开始', '开始时间', 'start', 'start_time', 'from'],
    end_at: ['结束', '结束时间', 'end', 'end_time', 'to'],
    location: ['地点', '教室', 'location', 'room'],
    platform: ['平台', 'platform'],
    teacher: ['教师', '老师', 'teacher'],
    weeks: ['周次', 'weeks', 'week'],
  };
  function mapHeader(fields, spec) {
    const map = {};
    fields.forEach((f, i) => {
      const key = String(f || '').trim().toLowerCase();
      for (const [field, names] of Object.entries(spec)) {
        if (names.some((n) => key === n.toLowerCase())) { if (map[field] === undefined) map[field] = i; }
      }
    });
    return map;
  }
  function weekdayNumber(v) {
    const s = String(v || '').trim();
    const m = s.match(/(?:周|星期|礼拜)?\s*([一二三四五六日天1-7]|mon|tue|wed|thu|fri|sat|sun)/i);
    if (!m) return 0;
    return WEEK_ALIAS[String(m[1]).toLowerCase()] || WEEK_ALIAS[m[1]] || 0;
  }

  /**
   * 解析 .csv。两种形态都认：
   *   ① 带表头：`标题,日期,结束日期,类型,备注`（校历）/ `课程名,星期,开始,结束,地点…`（课表）
   *   ② 没有表头（校历）：第一列=日期、第二列=标题
   * @returns {{ok:boolean, items:object[], skipped:{line:number,why:string}[], error?:string}}
   */
  function parseCsv(text, { kind = 'academic', year = new Date().getFullYear() } = {}) {
    const rows = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!rows.length) return { ok: false, items: [], skipped: [], error: '文件是空的' };
    const spec = kind === 'course' ? COURSE_HEADERS : ACAD_HEADERS;
    const head = splitCsvLine(rows[0]);
    let map = mapHeader(head, spec);
    let body = rows.slice(1);
    const hasHeader = Object.keys(map).length > 0;
    if (!hasHeader) {
      // 没表头：按位置猜
      if (kind === 'course') {
        return { ok: false, items: [], skipped: [], error: '课表 CSV 需要表头行（例如：课程名,星期,开始,结束,地点）' };
      }
      map = { start_at: 0, title: 1 };
      body = rows;
    }
    const items = [];
    const skipped = [];
    body.forEach((row, i) => {
      const f = splitCsvLine(row);
      const lineNo = i + (hasHeader ? 2 : 1);
      if (!f.some(Boolean)) return;
      if (kind === 'course') {
        const course = String(f[map.course] ?? '').trim();
        const startAt = String(f[map.start_at] ?? '').trim();
        const endAt = String(f[map.end_at] ?? '').trim();
        const wd = weekdayNumber(f[map.weekday]);
        if (!course || !startAt || !endAt) { skipped.push({ line: lineNo, why: '缺课程名或开始/结束时间' }); return; }
        items.push({
          course, weekday: wd || 1, start_at: startAt, end_at: endAt,
          location: String(f[map.location] ?? '').trim(),
          platform: String(f[map.platform] ?? '').trim(),
          teacher: String(f[map.teacher] ?? '').trim(),
          weeks: String(f[map.weeks] ?? '').trim() || '1-14',
          color: '#4f7cff',
        });
        return;
      }
      const title = String(f[map.title] ?? '').trim();
      const rawStart = String(f[map.start_at] ?? '').trim();
      const r = parseDateRange(rawStart, { today: new Date(year, 0, 1) });
      if (!title || !r) { skipped.push({ line: lineNo, why: !title ? '缺标题' : `日期认不出来（${rawStart || '空'}）` }); return; }
      const rawEnd = String(f[map.end_at] ?? '').trim();
      const re = rawEnd ? parseDateRange(rawEnd, { today: new Date(r.start + 'T00:00:00') }) : null;
      const k = normalizeKind(f[map.kind]) || guessKind(title);
      items.push({
        title, kind: k, start_at: r.start, end_at: (re && re.start) || r.end,
        notes: String(f[map.notes] ?? '').trim(),
        color: (KINDS[k] || KINDS.general).color,
      });
    });
    if (!items.length) {
      return { ok: false, items, skipped, error: skipped.length ? `每一行都没读成（${skipped[0].why}）` : '没解析出任何条目' };
    }
    return { ok: true, items, skipped };
  }

  const api = { parseQuickLine, parseDateRange, parseIcs, parseCsv, KINDS, KIND_ALIAS };
  global.ScheduleInput = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
