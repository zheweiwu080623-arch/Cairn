// 数据源「实例」：**同一类型可以配多条**（2026-09-26 用户要求 A）。
//
//   node tests/connector-instances.test.mjs
//
// 约定（见 lib/connectors/instances.mjs）：实例 id = 类型（第一条）/ `类型@2`、`类型@3`…
// 分隔符是 `@` 而不是 `#`：id 要当 URL 路径用，而 `#` 在 URL 里是片段起点，会被吃掉
//（写这组测试时当场踩到："删第二条"变成了"删第一条"）。
// 这样不用改表结构：`connector_config.source` 本来就是文本主键，
// 老数据（id 就是类型）天然是"这个类型的第一条实例"。
//
// 最要紧的几条：
//   * 两次 import（都带 create:true）⇒ 库里出现两条，**互不覆盖**；
//   * 带 instance 的 import ⇒ 改的是那一条；
//   * 不带 create 的老式 import ⇒ 还是"刷新这一条"（幂等，脚本别被改坏）；
//   * 删掉第二条，第一条与它的数据**分毫不动**。

import { createConnectorRoutes } from '../lib/routes/connectors.mjs';
import { instanceOrdinal, instanceSuffix, instanceType, nextInstanceId } from '../lib/connectors/instances.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('connector-instances.test.mjs');

// ---------------- 1. 纯函数：id 的约定 ----------------
{
  ok('类型（第一条）就是类型本身', instanceType('rss') === 'rss' && instanceOrdinal('rss') === 1);
  ok('第二条是 `类型@2`', instanceType('rss@2') === 'rss' && instanceOrdinal('rss@2') === 2);
  ok('第 3 条、第 10 条也认得', instanceOrdinal('rss@3') === 3 && instanceOrdinal('rss@10') === 10);
  ok('坏值不炸：`rss@x` / 空 / null 都当第一条',
    instanceOrdinal('rss@x') === 1 && instanceOrdinal('') === 1 && instanceOrdinal(null) === 1);
  ok('分隔符不是 `#`（它在 URL 里会被当成片段吃掉）',
    instanceType('rss#2') === 'rss#2' && instanceOrdinal('rss#2') === 1);
  ok('挑下一个没人用的 id', nextInstanceId('rss', []) === 'rss'
    && nextInstanceId('rss', ['rss']) === 'rss@2'
    && nextInstanceId('rss', ['rss', 'rss@2']) === 'rss@3'
    && nextInstanceId('rss', ['rss', 'rss@3']) === 'rss@2');
  ok('列表里第 2 条起带后缀（免得两行同名分不清）',
    instanceSuffix('rss') === '' && instanceSuffix('rss@2') === '（第 2 条）');
}

// ---------------- 2. 接口层：真存两条 ----------------
const meta = {
  id: 'fake', name: '假的源', icon: '🧪',
  fields: [{ key: 'url', label: '接口地址', required: true }],
};
let fetchMode = 'ok';
const connector = {
  meta,
  async fetchAll(config) {
    if (fetchMode === 'fail') throw new Error('ECONNREFUSED 连不上');
    const n = config.url === 'https://b.example' ? 2 : 1;
    return { items: Array.from({ length: n }, (_, i) => ({ id: `${config.url}#${i}`, title: `来自 ${config.url} 的第 ${i + 1} 条` })), raw: {} };
  },
  fromSample() { return { items: [{ id: 's1', title: '示例条目' }], raw: {} }; },
};

const dbMap = new Map();     // instance id -> row
const dataMap = new Map();   // instance id -> rows
const store = {
  listConnectors: () => [...dbMap.entries()].map(([source, v]) => ({ source, ...v })),
  getConnector: (s) => (dbMap.has(s) ? { source: s, ...dbMap.get(s) } : undefined),
  setConnector: (s, configJson, status, lastError) => { dbMap.set(s, { config_json: configJson, status, last_error: lastError }); },
  deleteConnector: (s) => (dbMap.delete(s) ? 1 : 0),
  clearConnectorData: (s) => { dataMap.set(s, []); },
  insertConnectorData: (s, row) => { if (!dataMap.has(s)) dataMap.set(s, []); dataMap.get(s).push(row); },
  listConnectorData: (s) => dataMap.get(s) || [],
  countConnectorData: (s) => (dataMap.get(s) || []).length,
};
const routes = createConnectorRoutes({
  store,
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
  notFound: (res) => { res.code = 404; res.body = { error: 'Not Found' }; },
  readBody: async (req) => req.body || {},
  listConnectorMeta: () => [meta],
  getConnector: (id) => (id === 'fake' ? connector : undefined),
  normalizeForStore: (it, source) => ({ ...it, source, normalized: true }),
  describeTestResult: (s, { count }) => `✓ ${s} 能连上，取到 ${count} 条`,
  humanizeConnectorError: (s, e) => ({ raw: e.message, text: `连不上：${e.message}` }),
  pushItemToPlanner: () => 1,
});
const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);
const mkRes = () => ({ code: null, body: null });
const call = async (method, path, body) => { const res = mkRes(); await routes.handleConnectors(req(method, body), res, urlOf(path)); return res; };

// 第一条：类型还没人用 ⇒ 直接用类型本身当 id
{
  const res = await call('POST', '/api/connectors/fake/import', { config: { url: 'https://a.example' }, create: true });
  ok('第一条实例的 id 就是类型本身', res.body.source === 'fake' && res.body.instance === 1, JSON.stringify(res.body));
  ok('第一条数据进的是它自己', dataMap.get('fake').length === 1 && dataMap.get('fake').every((r) => r.normalized));
}

// 第二条：同类型再配一个 ⇒ 自动变成 `fake@2`，**第一条分毫不动**
{
  const before = JSON.stringify(dbMap.get('fake'));
  const res = await call('POST', '/api/connectors/fake/import', { config: { url: 'https://b.example' }, create: true });
  ok('同类型再加一个 ⇒ 自动分到 `fake@2`', res.body.source === 'fake@2' && res.body.instance === 2, JSON.stringify(res.body));
  ok('第一条的配置**没被覆盖**', JSON.stringify(dbMap.get('fake')) === before);
  ok('两条各自的数据也是分开的', dataMap.get('fake').length === 1 && dataMap.get('fake@2').length === 2);
  ok('库里现在确实是两条', dbMap.size === 2 && [...dbMap.keys()].sort().join(',') === 'fake,fake@2');
}

// 第三条：继续加
{
  const res = await call('POST', '/api/connectors/fake/import', { config: { url: 'https://c.example' }, create: true });
  ok('再一个 ⇒ `fake@3`', res.body.source === 'fake@3' && dbMap.size === 3);
}

// 3. 列表接口：configs 是**实例**，counts 仍按类型合计、另给一份按实例的
{
  const res = await call('GET', '/api/connectors');
  const list = res.body;
  ok('configs 每条都标出 type / instance / suffix',
    list.configs.every((c) => c.type === 'fake' && typeof c.instance === 'number' && typeof c.suffix === 'string')
    && list.configs.map((c) => c.suffix).sort().join('|') === '|（第 2 条）|（第 3 条）',
    JSON.stringify(list.configs.map((c) => [c.source, c.suffix])));
  ok('counts 仍按类型合计（老页面不炸）', list.counts.fake === 4, JSON.stringify(list.counts));
  ok('counts_by_instance 才是每条各自的条数',
    list.counts_by_instance.fake === 1 && list.counts_by_instance['fake@2'] === 2 && list.counts_by_instance['fake@3'] === 1,
    JSON.stringify(list.counts_by_instance));
  ok('凭据照旧是掩码（多实例没把这条底线弄丢）', !JSON.stringify(list).includes('ECONNREFUSED'));
}

// 4. 改其中一条：带 instance ⇒ 只动那一条
{
  const res = await call('POST', '/api/connectors/fake/import', { instance: 'fake@2', config: { url: 'https://b2.example' } });
  ok('带 instance 改的是 `fake@2`', res.body.source === 'fake@2');
  ok('改完还是两条（没有又新建一条）', dbMap.size === 3);
  ok('改的是它的数据，不是别人的', dataMap.get('fake@2').every((r) => String(r.title).includes('b2.example')));
}

// 5. 不带 create 的老式调用 = 刷新这一条（幂等，脚本别被改坏）
{
  fetchMode = 'fail';
  const res = await call('POST', '/api/connectors/fake/import', { config: { url: 'https://a.example' } });
  ok('老式调用（不带 create）仍然只刷新 `fake` 这一条', dbMap.size === 3 && res.body.source === 'fake');
  ok('连不上时 200 + error，状态写 error（老行为不变）',
    res.code === 200 && res.body.status === 'error' && dbMap.get('fake').status === 'error',
    JSON.stringify(res.body));
  ok('错误原因记进 last_error', String(dbMap.get('fake').last_error).includes('ECONNREFUSED'));
  fetchMode = 'ok';
}

// 6. 删掉第二条：第一条分毫不动
{
  const firstConfig = JSON.stringify(dbMap.get('fake'));
  const res = await call('DELETE', '/api/connectors/fake@2');
  // 上一步把 fake@2 改成 b2.example，那份只回 1 条，所以这里是 1（不是 2）
  ok('按实例删：只删那一条（含它自己的数据）',
    res.code === 200 && res.body.source === 'fake@2' && res.body.removed_config === 1 && res.body.removed_items === 1,
    JSON.stringify(res.body));
  ok('第二条的配置和数据都没了', !dbMap.has('fake@2') && (dataMap.get('fake@2') || []).length === 0);
  ok('第一条（含它的数据）**分毫不动**',
    dbMap.has('fake') && JSON.stringify(dbMap.get('fake')) === firstConfig && dataMap.get('fake').length === 1);
}

// 7. 类型名不能乱来：拿类型当 key 时同样能查、未知类型仍 404
{
  const res = await call('GET', '/api/connectors/fake');
  ok('GET 一条实例同样带 type', res.code === 200 && res.body.type === 'fake');
  const bad = await call('DELETE', '/api/connectors/不存在@2');
  ok('未知类型（哪怕带 @2）→ 404', bad.code === 404);
  const wrong = await call('POST', '/api/connectors/fake/import', { instance: 'other@2', config: {} });
  ok('实例和类型对不上 → 400（不会写串）', wrong.code === 400, JSON.stringify(wrong.body));
}

// 7b. URL 里把 `@` 写成 `%40` 也要认（客户端用 encodeURIComponent 时的常见写法）
{
  const res = await call('GET', '/api/connectors/fake%403');
  ok('路径段会先解码：`fake%403` 认得出是 `fake@3`',
    res.code === 200 && res.body.source === 'fake@3' && res.body.type === 'fake', JSON.stringify(res.body).slice(0, 120));
  const del = await call('DELETE', '/api/connectors/fake%403');
  ok('编码过的实例 id 也能删（不会 404、也不会误删别人）',
    del.code === 200 && del.body.source === 'fake@3' && !dbMap.has('fake@3') && dbMap.has('fake'), JSON.stringify(del.body));
}

// 8. 源码守卫：这两个界面必须把 create / instance 传对，不然"加第二个"会变成"覆盖第一个"
{
  const fsmod = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['modules/settings/panel.js', 'modules/onboarding/wizard.js']) {
    const s = fsmod.readFileSync(join(ROOT, f), 'utf8');
    ok(`${f} 里"添加"会带 create:true（否则会覆盖第一条）`, s.includes('create: ') && s.includes('instance: '));
    ok(`${f} 里认得实例 id（把 @ 之后剥掉再查类型）`, s.includes('instanceTypeOf'));
  }
}

console.log('');
console.log(failures === 0 ? 'connector-instances.test: PASS' : `connector-instances.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
