// 通用 ICS 日历解析测试（适配器②）。
//
//   node tests/ical.test.mjs

import {
  expandRrule, icsEventToPlanner, icsEventsInWindow, parseIcs, parseIcsDate, parseLine,
  unescapeText, unfold, zonedToUtc,
} from '../lib/ical.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('ical.test.mjs');

// ---------- 1. 基础 ----------
ok('折行还原（CRLF + 空格续行）',
  unfold('SUMMARY:很长的一行\r\n 接着写\r\nLOCATION:x') === 'SUMMARY:很长的一行接着写\r\nLOCATION:x',
  unfold('SUMMARY:很长的一行\r\n 接着写\r\nLOCATION:x'));
ok('转义还原', unescapeText('a\\, b\\; c\\nD') === 'a, b; c\nD', unescapeText('a\\, b\\; c\\nD'));
const line = parseLine('DTSTART;TZID=Asia/Shanghai;VALUE=DATE-TIME:20260920T080000');
ok('解析「名字 + 参数 + 值」',
  line.name === 'DTSTART' && line.params.TZID === 'Asia/Shanghai' && line.value === '20260920T080000',
  JSON.stringify(line));
ok('没有冒号的行返回 null', parseLine('随便一行') === null);

// ---------- 2. 时间解析 ----------
const allDay = parseIcsDate('20260920', { VALUE: 'DATE' });
ok('全天事件（VALUE=DATE）', allDay.allDay === true && allDay.iso === '2026-09-20', JSON.stringify(allDay));
const utc = parseIcsDate('20260920T080000Z', {});
ok('UTC 时间', utc.allDay === false && utc.iso === '2026-09-20T08:00:00', JSON.stringify(utc));
const sh = parseIcsDate('20260920T080000', { TZID: 'Asia/Shanghai' });
ok('带时区：上海 08:00 = UTC 00:00',
  sh.ms === Date.UTC(2026, 8, 20, 0, 0, 0), `${sh.iso} ms=${sh.ms} want=${Date.UTC(2026, 8, 20, 0, 0, 0)}`);
ok('时区名不认时按 UTC 处理（不崩）',
  parseIcsDate('20260920T080000', { TZID: 'Not/AZone' })?.iso === '2026-09-20T08:00:00');
ok('坏时间返回 null', parseIcsDate('明天') === null && parseIcsDate('') === null);
ok('zonedToUtc 与已知时差一致',
  zonedToUtc(2026, 9, 20, 8, 0, 0, 'Asia/Shanghai') === Date.UTC(2026, 8, 20, 0, 0, 0));

// ---------- 3. 解析整份日历 ----------
const ics = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:示例校历',
  'BEGIN:VEVENT',
  'UID:ev-1',
  'SUMMARY:高等数学（第 3 周）',
  'DTSTART;TZID=Asia/Shanghai:20260921T080000',
  'DTEND;TZID=Asia/Shanghai:20260921T094000',
  'LOCATION:东中院 201',
  'DESCRIPTION:带\\, 逗号 的说明',
  'URL:https://example.edu/course/1',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:ev-2',
  'SUMMARY:国庆假期',
  'DTSTART;VALUE=DATE:20261001',
  'DTEND;VALUE=DATE:20261008',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const parsed = parseIcs(ics);
ok('日历名解析到', parsed.calendarName === '示例校历', parsed.calendarName);
ok('解析出 2 个事件', parsed.events.length === 2, String(parsed.events.length));
const ev1 = parsed.events[0];
ok('事件字段齐全（标题/时间/地点/说明/链接）',
  ev1.title === '高等数学（第 3 周）' && ev1.start.iso === '2026-09-21T08:00:00'
  && ev1.location === '东中院 201' && ev1.description === '带, 逗号 的说明'
  && ev1.url === 'https://example.edu/course/1', JSON.stringify(ev1));
ok('全天事件被标记', parsed.events[1].allDay === true && parsed.events[1].start.iso === '2026-10-01');
ok('没有 DTSTART 的事件被跳过',
  parseIcs('BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:没时间\r\nEND:VEVENT').events.length === 0);
ok('空输入不崩', parseIcs('').events.length === 0 && parseIcs(null).events.length === 0);

// ---------- 4. 简单重复展开 ----------
const weekly = {
  id: 'wk', title: '每周课', allDay: false, rrule: 'FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE',
  start: { iso: '2026-09-21T08:00:00', ms: Date.parse('2026-09-21T08:00:00Z'), dateKey: '2026-09-21' },
};
const from = Date.parse('2026-09-21T00:00:00Z');
// 窗口给到 10-01 00:00（UTC 午夜），这样 09-30 08:00 那次也落在窗口里
const to = Date.parse('2026-10-01T00:00:00Z');
const expanded = expandRrule(weekly, { fromMs: from, toMs: to });
ok('每周一/三展开出 4 次（COUNT=4 生效）', expanded.length === 4, JSON.stringify(expanded.map((e) => e.start.iso)));
ok('展开后的 id 带日期（避免互相覆盖）', new Set(expanded.map((e) => e.id)).size === 4);
// UNTIL 是"截止到某个时刻"：给到 09-29 00:00Z，这样 09-21 与 09-28 两次都在
const untilRule = { ...weekly, rrule: 'FREQ=WEEKLY;UNTIL=20260929T000000Z;BYDAY=MO' };
const untilExpanded = expandRrule(untilRule, { fromMs: from, toMs: Date.parse('2026-11-01T00:00:00Z') });
ok('UNTIL 生效', untilExpanded.length === 2, JSON.stringify(untilExpanded.map((e) => e.start.iso)));
const daily = { ...weekly, rrule: 'FREQ=DAILY;INTERVAL=2' };
const dailyExpanded = expandRrule(daily, { fromMs: from, toMs: Date.parse('2026-09-28T00:00:00Z') });
ok('FREQ=DAILY + INTERVAL=2 生效', dailyExpanded.length === 4, JSON.stringify(dailyExpanded.map((e) => e.start.dateKey)));
ok('不认识的规则不展开（返回空）',
  expandRrule({ ...weekly, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' }, { fromMs: from, toMs: to }).length === 0);
ok('没有 RRULE 的不展开', expandRrule({ ...weekly, rrule: '' }, { fromMs: from, toMs: to }).length === 0);

// ---------- 5. 窗口筛选 + 转成平台条目 ----------
const inWindow = icsEventsInWindow(parsed, { fromMs: Date.parse('2026-09-20T00:00:00Z'), toMs: Date.parse('2026-09-30T00:00:00Z') });
ok('窗口内只留那次课（国庆在窗口外）',
  inWindow.length === 1 && inWindow[0].title.includes('高等数学'), JSON.stringify(inWindow.map((e) => e.title)));
const wide = icsEventsInWindow(parsed, { fromMs: Date.parse('2026-09-20T00:00:00Z'), toMs: Date.parse('2026-10-10T00:00:00Z') });
ok('窗口放宽后两个都在', wide.length === 2, String(wide.length));
const complex = icsEventsInWindow(
  { calendarName: '', events: [{ ...weekly, rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' }] },
  { fromMs: from, toMs: Date.parse('2026-12-01T00:00:00Z') });
ok('复杂重复至少给出首次并标注原因',
  complex.length === 1 && String(complex[0].rruleNote).includes('只取了第一次'), JSON.stringify(complex.map((e) => e.rruleNote)));

const mapped = icsEventToPlanner(ev1, { source: 'ical' });
ok('转成日程（kind=event）且带上开始/结束',
  mapped.kind === 'event' && mapped.start_at === '2026-09-21T08:00:00' && mapped.end_at === '2026-09-21T09:40:00',
  JSON.stringify(mapped));
ok('备注里带地点与说明', mapped.notes.includes('东中院 201') && mapped.notes.includes('逗号'), mapped.notes);
const allDayMapped = icsEventToPlanner(parsed.events[1], { source: 'ical' });
ok('全天事件不写时间（避免显示成 00:00）', allDayMapped.start_at === '2026-10-01', allDayMapped.start_at);

console.log('');
console.log(failures === 0 ? 'ical.test: PASS' : `ical.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
