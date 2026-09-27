// 通用 ICS（iCalendar）解析（适配器②）。
//
// 为什么做它：`ics` 是**日历界的 RSS** —— Google / Outlook / 学校教务 / 各种课程表工具
// 都能导出一个 .ics 链接。贴个链接就能把别人的日历并进来，不需要账号、不需要 OAuth。
//
// 覆盖范围（刻意克制）：
//   ✅ 单次事件、全天事件、带时区（TZID）、折行、转义、DESCRIPTION/LOCATION/URL
//   ✅ 简单重复：FREQ=DAILY / WEEKLY（含 BYDAY、COUNT、UNTIL），在给定窗口内展开
//   ⚠️ 复杂重复（MONTHLY / YEARLY / BYSETPOS…）只取**首次**，并在备注里说明

const CRLF = /\r\n|\n|\r/;

/** 折行还原：ICS 里长行会以「CRLF + 空格/制表」续行。 */
export function unfold(text) {
  return String(text ?? '').replace(/\r?\n[ \t]/g, '');
}

/** 反转义 ICS 文本值：\, \; \n \\ */
export function unescapeText(value) {
  return String(value ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** 取一行的「名字 + 参数 + 值」。 */
export function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = left.split(';');
  const name = parts[0].trim().toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim();
  }
  return { name, params, value };
}

const pad = (n) => String(n).padStart(2, '0');

/** 把「某时区的墙上时间」换算成 UTC 毫秒（用 Intl，不引入时区库）。 */
export function zonedToUtc(y, mo, d, h, mi, s, timeZone) {
  if (!timeZone) return Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    // 先按 UTC 造一个候选，再看它在目标时区显示成什么，差多少就补多少（一次迭代足够）
    let ts = Date.UTC(y, mo - 1, d, h, mi, s);
    for (let i = 0; i < 2; i += 1) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(ts)).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
      const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
        +parts.hour % 24, +parts.minute, +parts.second);
      ts += (Date.UTC(y, mo - 1, d, h, mi, s) - shown);
    }
    return ts;
  } catch {
    return Date.UTC(y, mo - 1, d, h, mi, s);   // 时区名不认就按 UTC 处理
  }
}

/** 解析 ICS 的时间值 → { iso, allDay, dateKey } */
export function parseIcsDate(value, params = {}) {
  const v = String(value || '').trim();
  const tz = params.TZID || '';
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m && (params.VALUE === 'DATE' || v.length === 8)) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return { iso: `${y}-${pad(mo)}-${pad(d)}`, allDay: true, dateKey: `${y}-${pad(mo)}-${pad(d)}` };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (m) {
    const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
    const ts = m[7] === 'Z' ? Date.UTC(y, mo - 1, d, h, mi, s) : zonedToUtc(y, mo, d, h, mi, s, tz);
    // 关键约定：**保留文件里写的"墙上时间"**（校历导出的是什么就是什么），
    // 另存真实时刻 ms 供窗口过滤/重复计算用。这样在任何时区的机器上结果都一致。
    const wall = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
    return { iso: wall, allDay: false, dateKey: wall.slice(0, 10), ms: ts };
  }
  return null;
}

/** 解析整份 ICS。返回 { calendarName, events: [...] } */
export function parseIcs(text) {
  const src = unfold(text);
  const calendarName = (() => {
    for (const line of src.split(CRLF)) {
      const l = parseLine(line);
      if (l && l.name === 'X-WR-CALNAME') return unescapeText(l.value);
    }
    return '';
  })();

  const blocks = [...src.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi)].map((m) => m[1]);
  const events = [];
  for (const block of blocks) {
    const rec = { rrule: '', rruleComplex: false };
    for (const line of block.split(CRLF)) {
      const l = parseLine(line);
      if (!l) continue;
      switch (l.name) {
        case 'UID': rec.uid = unescapeText(l.value); break;
        case 'SUMMARY': rec.title = unescapeText(l.value); break;
        case 'DESCRIPTION': rec.description = unescapeText(l.value); break;
        case 'LOCATION': rec.location = unescapeText(l.value); break;
        case 'URL': rec.url = l.value.trim(); break;
        case 'DTSTART': rec.start = parseIcsDate(l.value, l.params); break;
        case 'DTEND': rec.end = parseIcsDate(l.value, l.params); break;
        case 'RRULE': rec.rrule = l.value.trim(); break;
        default: break;
      }
    }
    if (!rec.start) continue;                       // 没有开始时间的事件无法用
    rec.title = rec.title || '（无标题日程）';
    rec.id = rec.uid || `${rec.start.iso}|${rec.title}`;
    rec.allDay = rec.start.allDay;
    events.push(rec);
  }
  return { calendarName, events };
}

/** 简单重复展开：FREQ=DAILY / WEEKLY（含 BYDAY / COUNT / UNTIL）。 */
export function expandRrule(rec, { fromMs, toMs, max = 200 } = {}) {
  const rule = String(rec.rrule || '').toUpperCase();
  if (!rule) return [];
  if (!/FREQ=(DAILY|WEEKLY)/.test(rule)) return [];      // 复杂规则不展开
  const get = (k) => (new RegExp(`${k}=([^;]+)`).exec(rule) || [])[1];
  const interval = Number(get('INTERVAL') || 1) || 1;
  const count = Number(get('COUNT') || 0) || 0;
  const until = get('UNTIL') ? parseIcsDate(get('UNTIL')) : null;
  const byDay = (get('BYDAY') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const weekly = /FREQ=WEEKLY/.test(rule);

  const baseMs = rec.start.ms ?? Date.parse(`${rec.start.iso}T00:00:00Z`);
  const out = [];
  const push = (ms) => {
    if (ms < fromMs || ms > toMs) return;
    // 与 parseIcsDate 保持同一约定：用**墙上时间**输出（这里按 UTC 计算重复步长，
    // 所以格式化也用 UTC 字段，避免受本机时区影响）
    const d = new Date(ms);
    const iso = rec.allDay
      ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
      : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
    out.push({ ...rec, start: { ...rec.start, iso, dateKey: iso.slice(0, 10) }, id: `${rec.id}@${iso}` });
  };

  // 注意两个细节（都踩过）：
  //   1) 不能用"周起点超出窗口"就 break —— 那一周里可能还有落在窗口内的日子；
  //   2) COUNT 数的是**出现次数**，不是循环次数。
  let occurrences = 0;
  const offsets = weekly && byDay.length
    ? [...new Set(byDay.filter((d) => d in DOW).map((d) => ((DOW[d] + 6) % 7) * 86400000))].sort((a, b) => a - b)
    : null;

  for (let step = 0; step < max * 2 && occurrences < max; step += 1) {
    const base = weekly ? baseMs + step * 7 * 86400000 : baseMs + step * interval * 86400000;
    if (until?.ms && base > until.ms) break;
    if (base > toMs + 8 * 86400000) break;               // 已经远远越过窗口
    const weekStart = offsets ? base - ((new Date(base).getUTCDay() + 6) % 7) * 86400000 : base;
    const candidates = offsets ? offsets.map((o) => weekStart + o) : [base];
    for (const c of candidates) {
      if (until?.ms && c > until.ms) break;
      if (c > toMs) break;
      if (count && occurrences >= count) break;
      if (c < fromMs) continue;
      push(c);
      occurrences += 1;
    }
    if (count && occurrences >= count) break;
  }
  return out;
}

/** 给定窗口，把 ICS 里的单次 + 简单重复事件都取出来。 */
export function icsEventsInWindow(parsed, { fromMs, toMs, max = 200 } = {}) {
  const out = [];
  for (const rec of parsed.events) {
    if (!rec.rrule) {
      const ms = rec.start.ms ?? Date.parse(`${rec.start.iso}${rec.allDay ? 'T00:00:00Z' : ''}`);
      if (Number.isFinite(ms) && ms >= fromMs - 12 * 3600000 && ms <= toMs) out.push(rec);
      continue;
    }
    const expanded = expandRrule(rec, { fromMs, toMs, max });
    if (expanded.length) out.push(...expanded);
    else if (rec.rrule && !/FREQ=(DAILY|WEEKLY)/.test(rec.rrule.toUpperCase())) {
      // 复杂重复：至少给出首次出现，并标注
      const first = { ...rec, rruleNote: '重复规则较复杂，这里只取了第一次' };
      out.push(first);
    }
  }
  return out.slice(0, max);
}

/** ICS 事件 → 平台条目（进「日程」）。 */
export function icsEventToPlanner(ev, { source = 'ical' } = {}) {
  const start = ev.allDay ? ev.start.iso : ev.start.iso.replace('T', 'T').slice(0, 19);
  return {
    kind: 'event',
    external_id: ev.id,
    title: ev.title,
    start_at: start,
    end_at: ev.end ? (ev.end.allDay ? ev.end.iso : ev.end.iso.slice(0, 19)) : null,
    url: ev.url || null,
    notes: [ev.location ? `地点：${ev.location}` : '', ev.description || '', ev.rruleNote || '']
      .filter(Boolean).join('\n'),
    payload: { from: source, all_day: ev.allDay },
  };
}
