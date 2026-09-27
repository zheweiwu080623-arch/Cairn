// 通用 JSON 映射引擎测试（适配器③）。
//
//   node tests/jsonmap.test.mjs

import {
  FIELD_GUESSES, extractList, getByPath, mapRecordToItem, mapResponse, normalizeTime, pickFirst,
} from '../lib/jsonmap.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('jsonmap.test.mjs');

// ---------- 1. 路径取值 ----------
const payload = { data: { items: [{ title: 'A', n: 1 }, { title: 'B' }], meta: { count: 2 } } };
ok('点路径取值', getByPath(payload, 'data.meta.count') === 2);
ok('支持数组下标', getByPath(payload, 'data.items.1.title') === 'B');
ok('路径不存在返回 undefined', getByPath(payload, 'data.nope.deep') === undefined);
ok('空路径返回原对象', getByPath(payload, '') === payload);
ok('中途是 null 也不会崩', getByPath({ a: null }, 'a.b.c') === undefined);
ok('pickFirst 取第一个有值的', pickFirst({ b: 'x' }, ['a', 'b', 'c']) === 'x');
ok('pickFirst 跳过空字符串', pickFirst({ a: '  ', b: 'y' }, ['a', 'b']) === 'y');
ok('pickFirst 全空返回 undefined', pickFirst({}, ['a', 'b']) === undefined);

// ---------- 2. 找条目数组 ----------
ok('根是数组就用根', extractList([1, 2, 3]).length === 3);
ok('从 data 里找', extractList({ data: [1] }).length === 1);
ok('从 items 里找', extractList({ items: [1, 2] }).length === 2);
ok('从 results 里找', extractList({ results: [1] }).length === 1);
ok('只有一个数组字段时用它', extractList({ weird: [1, 2, 3] }).length === 3);
ok('显式 list_path 优先于猜测', extractList({ data: [1], other: { list: [1, 2] } }, 'other.list').length === 2);
ok('list_path 指到非数组时返回空', extractList({ data: { x: 1 } }, 'data').length === 0);
ok('对象里没有数组时返回空', extractList({ a: 1, b: 'x' }).length === 0);
ok('null / undefined 不崩', extractList(null).length === 0 && extractList(undefined).length === 0);

// ---------- 3. 时间归一化 ----------
ok('秒级时间戳', normalizeTime(1789000000)?.startsWith('2026-') === true, String(normalizeTime(1789000000)));
ok('毫秒时间戳', normalizeTime(1789000000000)?.startsWith('2026-') === true);
ok('纯日期原样保留（平台规则：当天 23:59）', normalizeTime('2026-09-25') === '2026-09-25');
ok('ISO 时间归一化成本地时间格式', normalizeTime('2026-09-25T08:30:00Z')?.includes('T') === true,
  String(normalizeTime('2026-09-25T08:30:00Z')));
ok('数字字符串时间戳也认', normalizeTime('1789000000')?.startsWith('2026-') === true);
ok('认不出的原样保留（不丢信息）', normalizeTime('明天下午') === '明天下午');
ok('空值返回 null', normalizeTime(null) === null && normalizeTime('') === null);

// ---------- 4. 单条记录映射 ----------
const rec = {
  name: '数据结构作业 3',
  deadline: '2026-09-30',
  link: 'https://example.edu/hw/3',
  id: 42,
  description: '第三章课后题',
};
const item = mapRecordToItem(rec, {}, { source: 'jsonapi', kind: 'task' });
ok('猜字段：name → 标题、deadline → 截止、link → 链接',
  item.title === '数据结构作业 3' && item.due_at === '2026-09-30' && item.url === 'https://example.edu/hw/3',
  JSON.stringify(item));
ok('external_id 与备注都在', item.external_id === '42' && item.notes.includes('第三章'), JSON.stringify(item));
ok('没有标题的记录被跳过', mapRecordToItem({ foo: 1 }, {}) === null);
ok('用户填的映射优先于猜测',
  mapRecordToItem({ name: 'A', my_title: 'B' }, { title: 'my_title' }).title === 'B');
ok('映射支持多个候选路径（逗号分隔）',
  mapRecordToItem({ a: '', b: 'B' }, { title: 'a, b' }).title === 'B');

// kind 的自动降级
ok('event 但没有开始时间 → 降级为提醒',
  mapRecordToItem({ title: 'x' }, {}, { kind: 'event' }).kind === 'reminder');
ok('task 但没有任何时间 → 降级为提醒',
  mapRecordToItem({ title: 'x' }, {}, { kind: 'task' }).kind === 'reminder');
ok('task 有截止时间 → 保持 task',
  mapRecordToItem({ title: 'x', due_at: '2026-09-30' }, {}, { kind: 'task' }).kind === 'task');
ok('event 有开始时间 → 保持 event',
  mapRecordToItem({ title: 'x', start_time: '2026-09-30T08:00:00' }, {}, { kind: 'event' }).kind === 'event');
ok('短名字会加前缀', mapRecordToItem(rec, {}, { label: '教务' }).title.startsWith('教务: '));

// ---------- 5. 整段响应映射 ----------
const api = { code: 0, data: { list: [
  { title: '一', due: '2026-09-30' },
  { title: '二', due: '2026-10-01' },
  { name: '三', deadline: '2026-10-02' },
  { nothing: true },
] } };
const mapped = mapResponse(api, { listPath: 'data.list', kind: 'task' });
ok('映射出 3 条（没有标题的跳过）', mapped.items.length === 3, JSON.stringify(mapped.items.map((i) => i.title)));
ok('total 与 kept 都报出来', mapped.total === 4 && mapped.kept === 3, JSON.stringify(mapped));
ok('maxResults 生效', mapResponse(api, { listPath: 'data.list', maxResults: 2 }).items.length === 2);
ok('不用 list_path 时也能猜出 list', mapResponse(api, {}).items.length === 3);
ok('空响应不崩', mapResponse(null, {}).items.length === 0 && mapResponse({}, {}).items.length === 0);
ok('全都是坏记录时返回空而不是抛错', mapResponse({ items: [1, 'x', null] }, {}).items.length === 0);

// ---------- 6. 猜测表要覆盖常见写法 ----------
ok('猜测表覆盖 title/name/subject 等', FIELD_GUESSES.title.includes('title') && FIELD_GUESSES.title.includes('subject'));
ok('猜测表覆盖 deadline/due 等', FIELD_GUESSES.due.includes('deadline') && FIELD_GUESSES.due.includes('due_at'));

console.log('');
console.log(failures === 0 ? 'jsonmap.test: PASS' : `jsonmap.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
