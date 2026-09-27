// 通用 RSS 连接器测试（适配器①·端到端离线版）。
//
//   node tests/rss-connector.test.mjs
//
// 起一个本地 HTTP 服务假装成 feed 站点，验证：
//   正常抓取 / 404 / 不是 feed 的网址 / 关键词过滤 / 离线示例 / 形状符合平台要求

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

console.log('rss-connector.test.mjs');

// ---------- 1. 注册与描述符 ----------
const conn = getConnector('rss');
ok('rss 连接器已注册', !!conn && typeof conn.fetchAll === 'function' && typeof conn.fromSample === 'function');
ok('出现在数据源清单里', listConnectorMeta().some((m) => m.id === 'rss'));
ok('meta 声明了「进通知」', conn.meta.notify === true);
ok('必填字段只有网址', conn.meta.fields.filter((f) => f.required).map((f) => f.key).join(',') === 'url');
ok('给了"怎么填"的占位提示', conn.meta.fields.every((f) => f.label));

// ---------- 2. 离线示例（「示例演示」按钮走这条） ----------
const sample = conn.fromSample();
ok('示例能产出条目', sample.items.length >= 3, String(sample.items.length));
ok('示例条目形状符合平台要求',
  sample.items.every((i) => i.kind && i.title && i.external_id && typeof i.notes === 'string'));
ok('示例标题带 feed 名的前缀', sample.items[0].title.startsWith('示例 · 学院公告:'), sample.items[0].title);
ok('示例能被 normalizeForStore 接受',
  sample.items.every((i) => normalizeForStore(i, 'rss').kind === 'reminder'));

// ---------- 3. 真抓一次（本地假站点） ----------
const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>本地测试源</title>
  <item><title>选课通知 A</title><link>https://x/1</link><guid>1</guid>
    <pubDate>${new Date().toUTCString()}</pubDate><description>重要</description></item>
  <item><title>促销广告 B</title><link>https://x/2</link><guid>2</guid>
    <pubDate>${new Date().toUTCString()}</pubDate><description>打折</description></item>
  <item><title>很旧的 C</title><link>https://x/3</link><guid>3</guid>
    <pubDate>${new Date(Date.now() - 60 * 86400000).toUTCString()}</pubDate></item>
</channel></rss>`;

const server = createServer((req, res) => {
  if (req.url === '/feed.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    return res.end(feedXml);
  }
  if (req.url === '/notafeed') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><body>普通网页</body></html>');
  }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const got = await conn.fetchAll({ url: `${base}/feed.xml`, since_days: '7', max_results: '10' });
ok('真抓：拿到最近两条（旧的被时间过滤掉）', got.items.length === 2, String(got.items.length));
ok('真抓：raw 里带统计', got.raw.feed_title === '本地测试源' && got.raw.kept === 2, JSON.stringify(got.raw));
ok('真抓：条目标题正确', got.items.some((i) => i.title.includes('选课通知 A')));

const filtered = await conn.fetchAll({ url: `${base}/feed.xml`, since_days: '7', exclude: '促销' });
ok('排除词生效', !filtered.items.some((i) => i.title.includes('促销')));
const included = await conn.fetchAll({ url: `${base}/feed.xml`, since_days: '7', include: '选课' });
ok('包含词生效', included.items.length === 1 && included.items[0].title.includes('选课'));

// ---------- 4. 出错要说人话 ----------
const cases = [
  [{}, '缺少 RSS 网址'],
  [{ url: 'ftp://x/y' }, 'http'],
  [{ url: `${base}/missing.xml` }, 'HTTP 404'],
  [{ url: `${base}/notafeed` }, '不是 RSS'],
];
for (const [cfg, expect] of cases) {
  let msg = '';
  try { await conn.fetchAll(cfg); } catch (e) { msg = e.message; }
  ok(`错误提示包含「${expect}」`, msg.includes(expect), msg);
}

server.close();
console.log('');
console.log(failures === 0 ? 'rss-connector.test: PASS' : `rss-connector.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
