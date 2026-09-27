// 通用 ICS 连接器测试（适配器②·端到端离线版）。
//
//   node tests/ical-connector.test.mjs

import { createServer } from 'node:http';

import { getConnector, listConnectorMeta, normalizeForStore } from '../lib/connectors/index.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('ical-connector.test.mjs');

const conn = getConnector('ical');
ok('ical 连接器已注册', !!conn && typeof conn.fetchAll === 'function' && typeof conn.fromSample === 'function');
ok('出现在数据源清单里', listConnectorMeta().some((m) => m.id === 'ical'));
ok('必填字段只有链接', conn.meta.fields.filter((f) => f.required).map((f) => f.key).join(',') === 'url');
ok('声明了可调窗口（往前/往后天数）',
  conn.meta.fields.some((f) => f.key === 'days_ahead') && conn.meta.fields.some((f) => f.key === 'days_back'));

// 离线示例
const sample = conn.fromSample();
ok('示例能产出日程', sample.items.length >= 3, String(sample.items.length));
ok('示例条目都是 event 且带标题/时间',
  sample.items.every((i) => i.kind === 'event' && i.title && i.start_at));
ok('示例能被 normalizeForStore 接受', sample.items.every((i) => normalizeForStore(i, 'ical').kind === 'event'));

// 本地假站点：一份含"过去/现在/未来/重复"的日历
const now = Date.now();
const stamp = (offsetDays, h = 9) => {
  const d = new Date(now + offsetDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(h)}0000`;
};
const ics = [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:本地测试日历',
  'BEGIN:VEVENT', 'UID:soon', 'SUMMARY:明天的课',
  `DTSTART:${stamp(1, 8)}`, `DTEND:${stamp(1, 9)}`, 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:far', 'SUMMARY:三个月后的事',
  `DTSTART:${stamp(90, 8)}`, `DTEND:${stamp(90, 9)}`, 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:old', 'SUMMARY:去年的事',
  `DTSTART:${stamp(-400, 8)}`, `DTEND:${stamp(-400, 9)}`, 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:weekly', 'SUMMARY:每周例会',
  `DTSTART:${stamp(1, 20)}`, `DTEND:${stamp(1, 21)}`,
  'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const server = createServer((req, res) => {
  if (req.url === '/cal.ics') {
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
    return res.end(ics);
  }
  if (req.url === '/page.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html>不是日历</html>');
  }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const got = await conn.fetchAll({ url: `${base}/cal.ics`, days_ahead: '60', days_back: '7', max_results: '50' });
const titles = got.items.map((i) => i.title);
ok('窗口外的事件被过滤（去年 / 三个月后都不在）',
  !titles.some((t) => t.includes('去年') || t.includes('三个月后')), JSON.stringify(titles));
ok('窗口内的事件在（明天的课）', titles.some((t) => t.includes('明天的课')));
ok('重复事件被展开（每周例会 ×3）', titles.filter((t) => t.includes('每周例会')).length === 3,
  JSON.stringify(titles));
ok('raw 里带日历名与统计',
  got.raw.calendar === '本地测试日历' && got.raw.kept === got.items.length, JSON.stringify(got.raw));
ok('短名字会加在标题前',
  (await conn.fetchAll({ url: `${base}/cal.ics`, label: '课表', days_ahead: '3' })).items[0].title.startsWith('课表: '));
ok('往前天数可调（days_back=500 时去年那条也进来）',
  (await conn.fetchAll({ url: `${base}/cal.ics`, days_back: '500', days_ahead: '1' })).items.some((i) => i.title.includes('去年')));

// 出错要说人话
const cases = [
  [{}, '缺少日历'],
  [{ url: 'webcal://x/y.ics' }, 'http'],
  [{ url: `${base}/page.html` }, '没有解析出日程'],
  [{ url: `${base}/missing.ics` }, 'HTTP 404'],
];
for (const [cfg, expect] of cases) {
  let msg = '';
  try { await conn.fetchAll(cfg); } catch (e) { msg = e.message; }
  ok(`错误提示包含「${expect}」`, msg.includes(expect), msg);
}

server.close();
console.log('');
console.log(failures === 0 ? 'ical-connector.test: PASS' : `ical-connector.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
