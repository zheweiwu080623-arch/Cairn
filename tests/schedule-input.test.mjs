// 「一行式输入」与「.ics / .csv 导入」的解析器单测（2026-09-27）
//
//   node tests/schedule-input.test.mjs
//
// 用户要的两件事：① 不想写 JSON，也不想一条条填表单 → 一行文字搞定；
//                ② 学院发下来的 .ics 日历 / 手里的两列表格，直接导进来。
// 解析器在 public/schedule-input.js（经典脚本，挂 window.ScheduleInput），这里直接喂文本。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'schedule-input.js'), 'utf8');
const fakeWindow = {};
// eslint-disable-next-line no-new-func
new Function('window', 'module', SRC)(fakeWindow, { exports: {} });
const S = fakeWindow.ScheduleInput;

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('schedule-input.test.mjs');
const TODAY = new Date(2026, 8, 27);            // 2026-09-27（周日）
const p2 = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const day = (n) => { const d = new Date(TODAY); d.setDate(d.getDate() + n); return key(d); };

// ---------------- ① 一行式：校历 ----------------
{
  const a = S.parseQuickLine('10-01~10-07 国庆假期 #假期 @连休 7 天', { kind: 'academic', today: TODAY });
  ok('「10-01~10-07 国庆假期 #假期」→ 假期 · 10-01 到 10-07',
    a.ok && a.item.title === '国庆假期' && a.item.kind === 'holiday'
    && a.item.start_at === '2026-10-01' && a.item.end_at === '2026-10-07' && a.item.notes === '连休 7 天',
    JSON.stringify(a));

  const b = S.parseQuickLine('明天 交作业', { kind: 'academic', today: TODAY });
  ok('「明天 交作业」→ 明天的单天事项（类型默认"其他"）',
    b.ok && b.item.title === '交作业' && b.item.kind === 'general'
    && b.item.start_at === day(1) && b.item.end_at === day(1), JSON.stringify(b));

  const c = S.parseQuickLine('周三 小组会 #其他', { kind: 'academic', today: TODAY });
  ok('「周三」认成本周三的日期（今天是周日 9/27 ⇒ 本周三是 9/23）',
    c.ok && c.item.start_at === '2026-09-23', JSON.stringify(c));

  const d = S.parseQuickLine('2026-12-14~12-18 考试周 #考试', { kind: 'academic', today: TODAY });
  ok('带年份的区间也认（DTEND 排他那种写法由 .ics 那边处理）',
    d.ok && d.item.kind === 'exam' && d.item.start_at === '2026-12-14' && d.item.end_at === '2026-12-18', JSON.stringify(d));

  const e = S.parseQuickLine('12-30~01-02 元旦 #假期', { kind: 'academic', today: TODAY });
  ok('跨年区间：结束日期自动算到明年 1/2',
    e.ok && e.item.start_at === '2026-12-30' && e.item.end_at === '2027-01-02', JSON.stringify(e));

  const f = S.parseQuickLine('国庆假期', { kind: 'academic', today: TODAY });
  ok('没写日期 → 明确报错并给出正确写法', !f.ok && /日期/.test(f.error), JSON.stringify(f));
  const g = S.parseQuickLine('10-01', { kind: 'academic', today: TODAY });
  ok('只有日期没有标题 → 明确报错', !g.ok && /事项名/.test(g.error), JSON.stringify(g));
}

// ---------------- ② 一行式：课表 ----------------
{
  const a = S.parseQuickLine('周一 08:00-09:40 高等数学 @东中院4-304 #Zoom 周次1-14', { kind: 'course', today: TODAY });
  ok('课表一行：周一次 &#8594; 课程名 / 时间 / 地点 / 平台 / 周次 全部认出来',
    a.ok && a.item.course === '高等数学' && a.item.weekday === 1
    && a.item.start_at === '08:00' && a.item.end_at === '09:40'
    && a.item.location === '东中院4-304' && a.item.platform === 'Zoom' && a.item.weeks === '1-14',
    JSON.stringify(a));

  const b = S.parseQuickLine('10:00-11:40 工程导论', { kind: 'course', today: TODAY });
  ok('没写星期 → 用今天星期几（2026-09-27 是周日 ⇒ 7）',
    b.ok && b.item.weekday === 7 && b.item.weeks === '1-14', JSON.stringify(b));

  const c = S.parseQuickLine('周三 13:00-14:40 数据结构 @机房A203 周次3-8', { kind: 'course', today: TODAY });
  ok('周次写成"周次3-8"也认', c.ok && c.item.weeks === '3-8' && c.item.weekday === 3, JSON.stringify(c));

  const d = S.parseQuickLine('高等数学 周一', { kind: 'course', today: TODAY });
  ok('没写时间 → 报错并给出示例', !d.ok && /时间/.test(d.error), JSON.stringify(d));
}

// ---------------- ③ .ics ----------------
{
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'SUMMARY:国庆假期',
    'DTSTART;VALUE=DATE:20261001',
    'DTEND;VALUE=DATE:20261008',            // 排他 ⇒ 实际到 10-07
    'DESCRIPTION:National Holiday',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:期中考试',
    'DTSTART:20261109T090000Z',
    'DTEND:20261109T110000Z',
    'LOCATION:东中院 4-305',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:折行的长标题，标题后半段在下一行\\, 带逗号',
    'DTSTART;VALUE=DATE:20261214',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:没有日期的坏条目',
    'END:VEVENT',
    'BEGIN:VTODO',
    'SUMMARY:这是待办，不该被导入',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
  const r = S.parseIcs(ics);
  ok('全天事件的 DTEND 是排他的 → 10-01 到 10-07（不是 10-08）',
    r.ok && r.items[0].start_at === '2026-10-01' && r.items[0].end_at === '2026-10-07', JSON.stringify(r.items[0]));
  ok('带时间的 VEVENT 取日期部分（09:00Z 那条 ⇒ 11-09）', r.items[1].start_at === '2026-11-09', JSON.stringify(r.items[1]));
  ok('CONTINUATION 折行 + \\, 转义都还原了',
    r.items[2].title.startsWith('折行的长标题') && r.items[2].title.includes('带逗号'), r.items[2].title);
  ok('LOCATION 进备注', r.items[1].notes.includes('东中院 4-305'), r.items[1].notes);
  ok('标题里的"考试"→ 自动归到 exam 类型', r.items[1].kind === 'exam', r.items[1].kind);
  ok('没有日期的条目被跳过并说明原因（不是悄悄塞一条空的）',
    r.skipped.some((s) => s.why.includes('开始日期')), JSON.stringify(r.skipped));
  ok('VTODO 不导入（只认 VEVENT）', r.items.length === 3, String(r.items.length));

  const bad = S.parseIcs('这不是日历文件');
  ok('不是 .ics → 明确报错', !bad.ok && /VEVENT/.test(bad.error), JSON.stringify(bad));
}

// ---------------- ④ .csv ----------------
{
  const withHead = '标题,日期,结束日期,类型,备注\n国庆假期,2026-10-01,2026-10-07,假期,连休\n考试周,2026-12-14,2026-12-18,考试,"期末, 共五天"';
  const r = S.parseCsv(withHead, { kind: 'academic' });
  ok('带表头的校历 CSV：字段按表头对齐（不是按列号硬套）',
    r.ok && r.items.length === 2 && r.items[0].title === '国庆假期' && r.items[0].kind === 'holiday'
    && r.items[1].kind === 'exam', JSON.stringify(r.items));
  ok('带引号的字段（"期末, 共五天"）没被逗号切断',
    r.items[1].notes === '期末, 共五天', r.items[1].notes);

  const noHead = '2026-10-01,国庆假期\n2026-11-09,期中考试';
  const r2 = S.parseCsv(noHead, { kind: 'academic' });
  ok('没有表头：按"第一列日期、第二列标题"认', r2.ok && r2.items[1].title === '期中考试', JSON.stringify(r2.items));

  const bad = '标题,日期\n空日期,瞎写';
  const r3 = S.parseCsv(bad, { kind: 'academic' });
  ok('认不出的行被跳过并说明第几行', !r3.ok && r3.skipped[0].line === 2, JSON.stringify(r3));

  const courses = '课程名,星期,开始,结束,地点,平台,教师,周次\n高等数学,周一,08:00,09:40,东中院4-304,Zoom,Horst,1-14\n工程导论,周四,10:00,11:40,线上,Teams,,1-8';
  const r4 = S.parseCsv(courses, { kind: 'course' });
  ok('课表 CSV：课程名 / 星期 / 时间 / 地点 / 平台 / 周次 全部对上',
    r4.ok && r4.items.length === 2 && r4.items[0].course === '高等数学' && r4.items[0].weekday === 1
    && r4.items[0].location === '东中院4-304' && r4.items[1].weeks === '1-8', JSON.stringify(r4.items));

  const noHeadCourse = '高等数学,周一,08:00,09:40';
  const r5 = S.parseCsv(noHeadCourse, { kind: 'course' });
  ok('课表 CSV 没表头 → 如实说要表头（不瞎猜列）', !r5.ok && /表头/.test(r5.error), JSON.stringify(r5));
}

console.log('');
console.log(failures === 0 ? 'schedule-input.test: PASS' : `schedule-input.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
