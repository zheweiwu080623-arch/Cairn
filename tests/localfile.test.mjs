// 本地文件导入测试（适配器④）：CSV / JSON / ICS + 安全边界。
//
//   node tests/localfile.test.mjs

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getConnector, listConnectorMeta, normalizeForStore } from '../lib/connectors/index.mjs';
import {
  ALLOWED_EXT, CSV_HEADER_ALIASES, MAX_FILE_BYTES, detectFormat, guessMappingFromHeaders,
  importLocalFile, parseCsv,
} from '../lib/localfile.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
console.log('localfile.test.mjs');
const dir = mkdtempSync(join(TMP, 'localfile-'));

// ---------- 1. CSV 解析（含引号、逗号、换行、中文） ----------
const csvText = '标题,截止时间,备注\n"含,逗号的标题",2026-09-30,"他说""好""的"\n第二行,2026-10-01,\n';
const parsed = parseCsv(csvText);
ok('表头被解析', parsed.headers.join('|') === '标题|截止时间|备注', parsed.headers.join('|'));
ok('两行数据都被解析', parsed.rows.length === 2, String(parsed.rows.length));
ok('引号里的逗号不会被切开', parsed.rows[0].标题 === '含,逗号的标题', parsed.rows[0].标题);
ok('双引号被还原成一个', parsed.rows[0].备注 === '他说"好"的', parsed.rows[0].备注);
ok('空单元格保留为空串', parsed.rows[1].备注 === '');
ok('BOM 头不会污染第一列', parseCsv('\uFEFF标题,a\nx,1').headers[0] === '标题');
ok('空文本不崩', parseCsv('').headers.length === 0 && parseCsv('').rows.length === 0);
ok('只有表头没有数据行时 rows 为空', parseCsv('a,b\n').rows.length === 0);

// ---------- 2. 表头猜测 ----------
const guess = guessMappingFromHeaders(['标题', '截止时间', '链接', '备注']);
ok('中文表头能猜出来',
  guess.title === '标题' && guess.due === '截止时间' && guess.url === '链接' && guess.body === '备注',
  JSON.stringify(guess));
ok('英文表头也能猜', guessMappingFromHeaders(['title', 'due', 'url']).due === 'due');
ok('猜不出的不硬猜', Object.keys(guessMappingFromHeaders(['随便一列'])).length === 0);
ok('别名表覆盖中文与英文', CSV_HEADER_ALIASES.title.includes('标题') && CSV_HEADER_ALIASES.title.includes('title'));

// ---------- 3. 格式识别 ----------
ok('按扩展名识别', detectFormat('a.csv') === 'csv' && detectFormat('a.json') === 'json' && detectFormat('a.ics') === 'ics');
ok('没有扩展名时按内容识别',
  detectFormat('a', 'BEGIN:VCALENDAR') === 'ics' && detectFormat('a', '{"x":1}') === 'json' && detectFormat('a', 'a,b') === 'csv');
ok('认不出的返回 unknown', detectFormat('a.txt', '随便写点什么') === 'unknown');
ok('允许的扩展名清单合理', ALLOWED_EXT.includes('.csv') && ALLOWED_EXT.includes('.ics'));

// ---------- 4. 真读文件：CSV ----------
const csvPath = join(dir, 'tasks.csv');
writeFileSync(csvPath, csvText, 'utf8');
const csvResult = importLocalFile(csvPath, { kind: 'task' });
ok('CSV：读进来 2 条', csvResult.items.length === 2, String(csvResult.items.length));
ok('CSV：标题与截止都对上',
  csvResult.items[0].title === '含,逗号的标题' && csvResult.items[0].due_at === '2026-09-30',
  JSON.stringify(csvResult.items[0]));
ok('CSV：raw 里报出表头与统计',
  csvResult.raw.format === 'csv' && csvResult.raw.headers.length === 3 && csvResult.raw.kept === 2,
  JSON.stringify(csvResult.raw));
ok('CSV：短名字加前缀', importLocalFile(csvPath, { label: '旧应用' }).items[0].title.startsWith('旧应用: '));
ok('CSV：可指定列名', importLocalFile(csvPath, { mapping: { title: '标题' } }).items.length === 2);
ok('CSV：maxResults 生效', importLocalFile(csvPath, { maxResults: 1 }).items.length === 1);

// ---------- 5. 真读文件：JSON ----------
const jsonPath = join(dir, 'items.json');
writeFileSync(jsonPath, JSON.stringify({ code: 0, data: { list: [
  { title: 'JSON 里的任务', due: '2026-10-10', url: 'https://x/1' },
  { name: '用 name 当标题', deadline: '2026-10-11' },
] } }), 'utf8');
const jsonResult = importLocalFile(jsonPath, { kind: 'task' });
ok('JSON：自动猜出 data.list 与字段，读进来 2 条',
  jsonResult.items.length === 2 && jsonResult.items[0].title === 'JSON 里的任务', JSON.stringify(jsonResult.items.map((i) => i.title)));
ok('JSON：raw 标明格式', jsonResult.raw.format === 'json');

// ---------- 6. 真读文件：ICS ----------
const icsPath = join(dir, 'cal.ics');
const icsStamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};
writeFileSync(icsPath, [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:文件里的日历',
  'BEGIN:VEVENT', 'UID:f1', 'SUMMARY:文件里的事件',
  `DTSTART:${icsStamp(Date.now() + 86400000)}`,
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n'), 'utf8');
const icsResult = importLocalFile(icsPath, {});
ok('ICS：读进来 1 条且是 event',
  icsResult.items.length === 1 && icsResult.items[0].kind === 'event'
  && icsResult.items[0].title === '文件里的事件', JSON.stringify(icsResult.items));
ok('ICS：raw 里有日历名', icsResult.raw.calendar === '文件里的日历');

// ---------- 7. 安全与错误 ----------
const cases = [
  [{}, '缺少文件路径'],
  [{ path: join(dir, 'nope.csv') }, '文件不存在'],
  [{ path: dir }, '不是文件'],
  [{ path: join(dir, 'x.txt') }, '认不出文件格式'],
];
writeFileSync(join(dir, 'x.txt'), '随便写点什么', 'utf8');
for (const [cfg, expect] of cases) {
  let msg = '';
  try { importLocalFile(cfg.path, cfg); } catch (e) { msg = e.message; }
  ok(`错误提示包含「${expect}」`, msg.includes(expect), msg);
}
// 太大的文件要被挡住（写一个超过上限的）
const bigPath = join(dir, 'big.csv');
writeFileSync(bigPath, 'a,b\n' + 'x'.repeat(MAX_FILE_BYTES + 10), 'utf8');
let bigMsg = '';
try { importLocalFile(bigPath, {}); } catch (e) { bigMsg = e.message; }
ok('超过大小上限会被拒绝', bigMsg.includes('文件太大'), bigMsg);

// ---------- 8. 连接器层 ----------
const conn = getConnector('localfile');
ok('localfile 连接器已注册', !!conn && typeof conn.fetchAll === 'function' && typeof conn.fromSample === 'function');
ok('出现在数据源清单里', listConnectorMeta().some((m) => m.id === 'localfile'));
ok('必填只有文件路径', conn.meta.fields.filter((f) => f.required).map((f) => f.key).join(',') === 'path');
const sample = conn.fromSample();
ok('离线示例能产出任务', sample.items.length === 3 && sample.items.every((i) => i.kind === 'task'));
ok('示例能被 normalizeForStore 接受', sample.items.every((i) => normalizeForStore(i, 'localfile').kind === 'task'));
const viaConnector = await conn.fetchAll({ path: csvPath, kind: 'task' });
ok('连接器 fetchAll 能读真实文件', viaConnector.items.length === 2, String(viaConnector.items.length));

console.log('');
console.log(failures === 0 ? 'localfile.test: PASS' : `localfile.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
