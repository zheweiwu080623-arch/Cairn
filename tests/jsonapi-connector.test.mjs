// 通用 JSON 接口连接器测试（适配器③·端到端离线版）。
//
//   node tests/jsonapi-connector.test.mjs

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

console.log('jsonapi-connector.test.mjs');

const conn = getConnector('jsonapi');
ok('jsonapi 连接器已注册', !!conn && typeof conn.fetchAll === 'function' && typeof conn.fromSample === 'function');
ok('出现在数据源清单里', listConnectorMeta().some((m) => m.id === 'jsonapi'));
ok('必填字段只有接口地址', conn.meta.fields.filter((f) => f.required).map((f) => f.key).join(',') === 'url');
ok('字段映射项都在（标题/截止/开始/结束/链接/ID/正文/类型）',
  ['map_title', 'map_due', 'map_start', 'map_end', 'map_url', 'map_id', 'map_body', 'kind']
    .every((k) => conn.meta.fields.some((f) => f.key === k)));

// 离线示例
const sample = conn.fromSample();
ok('示例能产出条目', sample.items.length === 3, String(sample.items.length));
ok('示例条目是 task 且带截止时间',
  sample.items.every((i) => i.kind === 'task' && i.due_at), JSON.stringify(sample.items[0]));
ok('示例能被 normalizeForStore 接受', sample.items.every((i) => normalizeForStore(i, 'jsonapi').kind === 'task'));

// 本地假接口
const seen = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization || '', body });
    if (req.url === '/items') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        code: 0,
        data: { list: [
          { id: 1, name: '作业一', deadline: '2026-09-30', link: 'https://x/1' },
          { id: 2, title: '作业二', due_at: '2026-10-05', url: 'https://x/2' },
        ] },
      }));
    }
    if (req.url === '/flat') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ title: '扁平数组里的一条', due: '2026-10-01' }]));
    }
    if (req.url === '/empty') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { list: [] } }));
    }
    if (req.url === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>不是接口</html>');
    }
    res.writeHead(500); res.end('boom');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ① 自动猜路径与字段
const auto = await conn.fetchAll({ url: `${base}/items` });
ok('自动猜出 data.list 与字段（name→标题、deadline→截止）',
  auto.items.length === 2 && auto.items[0].title === '作业一' && auto.items[0].due_at === '2026-09-30',
  JSON.stringify(auto.items.map((i) => [i.title, i.due_at])));
ok('同一条里混用 title/due_at 也能认', auto.items[1].title === '作业二' && auto.items[1].due_at === '2026-10-05');
ok('raw 里报出总条数与收录条数', auto.raw.total === 2 && auto.raw.kept === 2, JSON.stringify(auto.raw));

// ② 显式映射 + 短名字 + 类型
const explicit = await conn.fetchAll({
  url: `${base}/items`, list_path: 'data.list', map_title: 'name', map_due: 'deadline',
  kind: 'task', label: '教务',
});
ok('显式映射生效并加短名前缀', explicit.items[0].title === '教务: 作业一', explicit.items[0].title);
ok('kind=task 保留', explicit.items.every((i) => i.kind === 'task'));

// ③ Token 会作为 Authorization 头发出
  await conn.fetchAll({ url: `${base}/items`, token: 'example-token' });
  ok('Token 以 Bearer 形式发出', seen.at(-1).auth === 'Bearer example-token', seen.at(-1).auth);

// ④ POST + 请求体
await conn.fetchAll({ url: `${base}/items`, method: 'POST', body: '{"page":1}' });
ok('POST 生效且带上请求体',
  seen.at(-1).method === 'POST' && seen.at(-1).body === '{"page":1}', JSON.stringify(seen.at(-1)));

// ⑤ 根就是数组
const flat = await conn.fetchAll({ url: `${base}/flat` });
ok('响应本身就是数组时也能处理', flat.items.length === 1 && flat.items[0].title.includes('扁平数组'), JSON.stringify(flat.items));

// ⑥ 出错要说人话
const cases = [
  [{}, '缺少接口地址'],
  [{ url: 'ftp://x' }, 'http'],
  [{ url: `${base}/empty` }, '没映射出条目'],
  [{ url: `${base}/html` }, '不是 JSON'],
  [{ url: `${base}/boom` }, 'HTTP 500'],
  [{ url: `${base}/items`, headers: '{坏掉的' }, '不是合法的 JSON'],
];
for (const [cfg, expect] of cases) {
  let msg = '';
  try { await conn.fetchAll(cfg); } catch (e) { msg = e.message; }
  ok(`错误提示包含「${expect}」`, msg.includes(expect), msg);
}

server.close();
console.log('');
console.log(failures === 0 ? 'jsonapi-connector.test: PASS' : `jsonapi-connector.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
