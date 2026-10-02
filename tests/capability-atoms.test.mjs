// 七条**通用原子能力**的验证（2026-10-02 · 台阶 2）。
//
//   node tests/capability-atoms.test.mjs
//
// 为什么是这七条：在它们之前，登记表里 10 条能力有 4 条是 course.*、2 条是去重、
// 1 条是读设置 —— 想干"取一个接口 → 取字段 → 拼一段话 → 推手机"这种通用的事，
// 只有写代码一条路。这七条补上之后，这类事在「能力搭建」里连一连就能做。
//
// 全程**不联网**：http.get 打的是本机临时起的一个小服务。

import { createServer } from 'node:http';

import { CAPABILITIES, getCapability, validateCapability } from '../lib/capabilities/index.mjs';
import { run as csvParseRun, splitCsvLine } from '../lib/capabilities/impl/csv.parse.mjs';
import { run as httpGet } from '../lib/capabilities/impl/http.get.mjs';
import { pickPath, run as jsonPick } from '../lib/capabilities/impl/json.pick.mjs';
import { bindItem, run as logicEach } from '../lib/capabilities/impl/logic.each.mjs';
import { run as textExtract } from '../lib/capabilities/impl/text.extract.mjs';
import { run as textSplit } from '../lib/capabilities/impl/text.split.mjs';
import { run as textTemplate } from '../lib/capabilities/impl/text.template.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('capability-atoms.test.mjs');

const GENERIC = ['http.get', 'json.pick', 'text.template', 'text.split', 'text.extract', 'csv.parse', 'logic.each'];

// ---------- ① 都在登记表里，形状都对 ----------
{
  const missing = GENERIC.filter((id) => !getCapability(id));
  ok('七条通用原子都登记上了', missing.length === 0, missing.join(', '));
  const bad = GENERIC.map((id) => ({ id, r: validateCapability(getCapability(id)) })).filter((x) => !x.r.ok);
  ok('每条都过 capability.v1 校验', bad.length === 0, bad.map((x) => `${x.id}: ${x.r.errors.join('；')}`).join(' | '));
  ok('都在「通用」组（素材栏里单独一栏）', GENERIC.every((id) => getCapability(id).ui.group === '通用'));
  ok('只有 http.get 要联网权限，别的不要额外权限',
    GENERIC.filter((id) => (getCapability(id).permissions || []).length).join() === 'http.get',
    GENERIC.map((id) => `${id}:${(getCapability(id).permissions || []).join()}`).join(' '));
  ok('登记表里没有重名的（通用原子没有覆盖自带能力）',
    new Set(CAPABILITIES.map((c) => c.id)).size === CAPABILITIES.length);
}

// ---------- ② json.pick ----------
{
  const run = jsonPick;
  ok('pickPath：点分路径', pickPath({ a: { b: { c: 7 } } }, 'a.b.c') === 7);
  ok('pickPath：数组下标', pickPath({ list: [{ x: 'first' }, { x: 'second' }] }, 'list[1].x') === 'second');
  ok('pickPath：取不到返回 undefined（不抛）', pickPath({ a: 1 }, 'a.b.c') === undefined);
  const one = await run({ data: { a: { b: 3 } }, path: 'a.b' });
  ok('取一个字段：value + found', one.value === 3 && one.found === true);
  const miss = await run({ data: {}, path: 'a.b', fallback: '—' });
  ok('取不到时给 fallback，并如实说 found=false', miss.value === '—' && miss.found === false);
  const many = await run({ data: { title: 'hi' }, fields: { t: 'title', n: 'nope' } });
  ok('取一组字段：拿到的进 out，没拿到的进 missing',
    many.out.t === 'hi' && many.missing.join() === 'n' && many.found === false);
}

// ---------- ③ text.template / text.split / text.extract ----------
{
  const r1 = await textTemplate({ template: '{{a.b}} 有 {{n}} 条', data: { a: { b: '课程' }, n: 3 } });
  ok('模板填值（数字也填得进去）', r1.text === '课程 有 3 条', r1.text);
  const r2 = await textTemplate({ template: 'A{{nope}}B', data: {}, fallback: '空' });
  ok('填不上的字段用 fallback，并列进 missing', r2.text === 'A空B' && r2.missing.join() === 'nope', JSON.stringify(r2));
  const r3 = await textTemplate({ template: '{{o}}', data: { o: { k: 1 } } });
  ok('对象值会被序列化（不是 [object Object]）', r3.text === '{"k":1}', r3.text);

  const s1 = await textSplit({ text: 'a\n\nb\nc\n' });
  ok('默认按换行切、去空白、丢空行', s1.items.join() === 'a,b,c', JSON.stringify(s1));
  const s2 = await textSplit({ text: 'a1b22c', by: '\\d+', regex: true });
  ok('regex=true 时按正则切', s2.items.join() === 'a,b,c', JSON.stringify(s2.items));
  const s3 = await textSplit({ text: 'x,y,z', by: ',', limit: 2 });
  ok('limit 只留前几条', s3.items.join() === 'x,y' && s3.count === 2);
  const s4 = await textSplit({ text: 'a', by: '(', regex: true });
  ok('坏正则如实报错（items 给空数组）', Array.isArray(s4.items) && !!s4.error);

  const e1 = await textExtract({ text: '课号 MATH1860J 与 STAT1000J', pattern: '([A-Z]{4}\\d{4}J)' });
  ok('正则捞全部匹配', e1.matches.join() === 'MATH1860J,STAT1000J' && e1.count === 2, JSON.stringify(e1));
  const e2 = await textExtract({ text: 'x', pattern: 'x', all: false });
  ok('all=false 只留第一条', e2.matches.length === 1 && e2.first === 'x');
  const e3 = await textExtract({ text: 'a', pattern: '' });
  ok('没给 pattern 时如实报错', e3.first === null && !!e3.error);
}

// ---------- ④ csv.parse ----------
{
  ok('一行带引号的 CSV：引号里的逗号不算分隔符',
    JSON.stringify(splitCsvLine('a,"b,c",d', ',')) === '["a","b,c","d"]');
  ok('两个连续引号 = 一个引号', JSON.stringify(splitCsvLine('"he said ""hi""",2', ',')) === '["he said \\"hi\\"","2"]');
  const r = await csvParseRun({ text: 'name,score\n张三,90\n李四,85\n' });
  ok('带表头：每行是对象', r.count === 2 && r.rows[1].name === '李四' && r.rows[0].score === '90', JSON.stringify(r));
  const noHead = await csvParseRun({ text: '1,2\n3,4', header: false });
  ok('不带表头：每行是数组，表头自动叫 col1/col2',
    noHead.count === 2 && noHead.headers.join() === 'col1,col2' && noHead.rows[0][1] === '2');
  const tsv = await csvParseRun({ text: 'a\tb', delimiter: '\t' });
  ok('分隔符可换（TSV）', tsv.headers.join() === 'a,b');
}

// ---------- ⑤ logic.each ----------
{
  const each = { run: logicEach, bindItem };
  const calls = [];
  const invoke = async (id, input) => {
    calls.push({ id, input });
    if (id === 'write.file') return { ok: true, actions: [{ type: 'file', target: { path: input.path } }] };
    return { ok: true, output: { got: input.title } };
  };
  const r = await each.run({
    items: [{ title: 'a' }, { title: 'b' }],
    capability: 'write.file',
    input: { path: '/tmp/$index-$item.title.md', title: '$item.title' },
  }, { invoke });
  ok('逐条调用（条数对）', r.count === 2 && calls.length === 2, JSON.stringify(r));
  ok('$item.字段 与 $index 会被换掉',
    calls[1].input.path === '/tmp/1-b.md' && calls[1].input.title === 'b', JSON.stringify(calls[1].input));
  ok('整个字符串是 $item 时保留原类型（对象还是对象）',
    JSON.stringify(each.bindItem({ v: '$item' }, { x: 1 }, 0).v) === '{"x":1}');
  ok('被调能力产出的动作会汇总上去（dry-run 照旧只演练）',
    Array.isArray(r.actions) && r.actions.length === 2 && r.actions[0].type === 'file');
  const failOne = await each.run(
    { items: [1, 2, 3], capability: 'x', input: { v: '$item' } },
    { invoke: async (id, i) => (i.v === 2 ? { ok: false, error: '炸了' } : { ok: true, output: i.v }) },
  );
  ok('某一条失败：如实记账，不拖垮其它条',
    failOne.count === 2 && failOne.errors.length === 1 && failOne.errors[0].index === 1, JSON.stringify(failOne));
  const boom = await each.run({ items: [1], capability: 'x' }, { invoke: async () => ({ ok: false, error: 'x' }) });
  ok('调用器报错时也照常返回结构', Array.isArray(boom.items));
  const self = await each.run({ items: [1], capability: 'logic.each' }, { invoke });
  ok('不许调用它自己（否则一个图就能把自己转死）', self.errors[0].error.includes('不能调用它自己'));
  const noInvoke = await each.run({ items: [1], capability: 'x' }, {});
  ok('没有调用器时明确说清', noInvoke.errors[0].error.includes('ctx.invoke'));
  const capped = await each.run({ items: Array.from({ length: 20 }, (_v, i) => i), capability: 'x', max: 5 }, { invoke });
  ok('条数有上限（默认 200，可调），越界会说明',
    capped.count === 5 && capped.errors.some((e) => String(e.error).includes('上限')), JSON.stringify(capped.count));
}

// ---------- ⑥ http.get：打本机临时服务，不联网 ----------
{
  const run = httpGet;
  const server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: '你好', n: 2 }));
    } else if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('就是一段文字');
    } else {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = await run({ url: `${base}/ok` });
    ok('取到 JSON：解析好了（mode=auto 看 Content-Type）',
      good.ok === true && good.status === 200 && good.json.title === '你好', JSON.stringify(good).slice(0, 140));
    const plain = await run({ url: `${base}/plain` });
    ok('不是 JSON 就只给文字，不硬解析', plain.ok === true && plain.json === null && plain.text.includes('就是一段文字'));
    const bad = await run({ url: `${base}/nope` });
    ok('对方 500：如实返回 ok:false + 状态码（不抛）',
      bad.ok === false && bad.status === 500 && String(bad.error).includes('500'), JSON.stringify(bad).slice(0, 120));
    const ftp = await run({ url: 'file:///C:/Windows/win.ini' });
    ok('非 http/https 一律拒绝（不给图留后门）', ftp.ok === false && ftp.error.includes('http'), JSON.stringify(ftp));
    const wrong = await run({ url: '不是网址' });
    ok('看不懂的网址：如实报错', wrong.ok === false && !!wrong.error);
    const noUrl = await run({});
    ok('没给 url：如实报错', noUrl.ok === false && noUrl.error.includes('url'));
    const huge = await run({ url: `${base}/plain`, max_chars: 500 });
    ok('大小上限给了就照做（500 是最小值，这里只验证参数不炸）', huge.ok === true);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

console.log('');
console.log(failures === 0 ? 'capability-atoms.test: PASS' : `capability-atoms.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
