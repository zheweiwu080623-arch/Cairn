// 数据源接口的验证（R2 第三组之二）：/api/connectors* 的六条路径。
//
//   node tests/connectors-routes.test.mjs
//
// 最重要的两条断言：
//   * **回给界面的配置里绝不能出现明文凭据**；
//   * **"测试连接"走的是导入那条代码路径**（不是另写一套假检查）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createConnectorRoutes } from '../lib/routes/connectors.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('connectors-routes.test.mjs');

const PLAIN = 'super-secret-token-1234';
const meta = {
  id: 'fake',
  name: '假的源',
  icon: '🧪',
  fields: [
    { key: 'url', label: '接口地址', required: true },
    { key: 'token', label: '访问令牌', type: 'password', required: false },
    { key: 'max_results', label: '最多几条', required: false },
  ],
};

/** 可切换行为的假连接器 */
let fetchMode = 'ok';
const connector = {
  meta,
  async fetchAll(config) {
    if (fetchMode === 'fail') throw new Error('ECONNREFUSED 连不上');
    if (fetchMode === 'slow') return new Promise(() => {});   // 永远不返回（配合超时）
    return {
      items: [1, 2, 3, 4].map((i) => ({ id: `x${i}`, title: `第 ${i} 条` })),
      raw: { note: '假的响应', token_used: config.token },
    };
  },
  fromSample() {
    return { items: [{ id: 's1', title: '示例条目' }], raw: { note: '示例' } };
  },
};

const dbMap = new Map();      // source -> { config_json, status, last_sync, last_error }
const dataMap = new Map();    // source -> rows
const calls = [];
const store = {
  listConnectors: () => [...dbMap.entries()].map(([source, v]) => ({ source, ...v })),
  getConnector: (source) => (dbMap.has(source) ? { source, ...dbMap.get(source) } : undefined),
  setConnector: (source, configJson, status, lastError) => {
    calls.push(['setConnector', source, status]);
    dbMap.set(source, { config_json: configJson, status, last_error: lastError });
  },
  clearConnectorData: (source) => { calls.push(['clearData', source]); dataMap.set(source, []); },
  insertConnectorData: (source, row) => {
    calls.push(['insertData', source]);
    if (!dataMap.has(source)) dataMap.set(source, []);
    dataMap.get(source).push(row);
  },
  listConnectorData: (source) => dataMap.get(source) || [],
  countConnectorData: (source) => (dataMap.get(source) || []).length,
  // 2026-09-26 新增：删掉一个数据源的配置行
  deleteConnector: (source) => { calls.push(['deleteConfig', source]); return dbMap.delete(source) ? 1 : 0; },
};

const pushed = [];
const routes = createConnectorRoutes({
  store,
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, message) => { res.code = code; res.body = { error: message }; },
  notFound: (res) => { res.code = 404; res.body = { error: 'Not Found' }; },
  readBody: async (req) => req.body || {},
  listConnectorMeta: () => [meta],
  getConnector: (id) => (id === 'fake' ? connector : undefined),
  normalizeForStore: (it, source) => ({ ...it, source, normalized: true }),
  describeTestResult: (source, { ok: flag, count }) => (ok ? `✓ ${source} 能连上，取到 ${count} 条` : '✗ 连不上'),
  humanizeConnectorError: (source, e) => ({ raw: e.message, text: `连不上：${e.message}。检查一下地址是否可访问。` }),
  pushItemToPlanner: (row) => { pushed.push(row); return 1; },
});
const req = (method, body) => ({ method, body });
const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);
const mkRes = () => ({ code: null, body: null });

// ---------------- 1. 列表：凭据必须是掩码 ----------------
dbMap.set('fake', { config_json: JSON.stringify({ url: 'https://a.example', token: PLAIN }), status: 'ok', last_error: null });
dataMap.set('fake', [{ id: 'x1' }, { id: 'x2' }]);
{
  const res = mkRes();
  await routes.handleConnectors(req('GET'), res, urlOf('/api/connectors'));
  const json = JSON.stringify(res.body);
  ok('列表接口 200 且有 connectors/configs/counts',
    res.code === 200 && res.body.connectors.length === 1 && res.body.configs.length === 1 && res.body.counts.fake === 2);
  ok('**列表里没有明文凭据**', !json.includes(PLAIN), json.slice(0, 200));
  ok('掩码保留末四位，便于确认填的是哪一个', json.includes('••••1234'));
  ok('非凭据字段照常回显', json.includes('https://a.example'));
}

// ---------------- 2. 单个数据源状态 ----------------
{
  const res = mkRes();
  await routes.handleConnectors(req('GET'), res, urlOf('/api/connectors/fake'));
  ok('单个接口 200 且带 meta/status/data/count',
    res.code === 200 && res.body.status === 'ok' && res.body.count === 2 && res.body.meta.id === 'fake');
  ok('单个接口里也没有明文凭据', !JSON.stringify(res.body).includes(PLAIN));
}
{
  const res = mkRes();
  await routes.handleConnectors(req('GET'), res, urlOf('/api/connectors/不存在的源'));
  ok('未知数据源 → 404 且提示是中文', res.code === 404 && res.body.error === '未知数据源');
}

// ---------------- 3. 导入 ----------------
{
  fetchMode = 'ok';
  calls.length = 0;
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: { url: 'https://a.example', token: PLAIN } }), res, urlOf('/api/connectors/fake/import'));
  ok('导入 200 且报出条数', res.code === 200 && res.body.inserted === 4 && res.body.status === 'ok');
  ok('导入前先清掉旧数据', calls.some((c) => c[0] === 'clearData'));
  ok('每条都过了 normalizeForStore', (dataMap.get('fake') || []).every((r) => r.normalized === true));
  ok('**库里存的是明文（只有库里能有）**', dbMap.get('fake').config_json.includes(PLAIN));
  ok('状态写成 ok 并清空上次错误', dbMap.get('fake').status === 'ok' && dbMap.get('fake').last_error === null);
}
{
  // 关键安全路径：界面把掩码传回来，不能把掩码当新密码存进去
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: { url: 'https://a.example', token: '••••1234' } }), res, urlOf('/api/connectors/fake/import'));
  ok('带掩码提交后，库里仍是原来的真值（没有被掩码覆盖）',
    dbMap.get('fake').config_json.includes(PLAIN) && !dbMap.get('fake').config_json.includes('••••'));
}
{
  fetchMode = 'fail';
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: { url: 'https://bad.example' } }), res, urlOf('/api/connectors/fake/import'));
  ok('连不上时 200 + error（界面好处理），状态写成 error',
    res.code === 200 && res.body.inserted === 0 && res.body.status === 'error' && dbMap.get('fake').status === 'error');
  ok('错误原因记进 last_error', String(dbMap.get('fake').last_error).includes('ECONNREFUSED'));
  fetchMode = 'ok';
}

// ---------------- 4. 测试连接 ----------------
{
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: { url: 'https://a.example' } }), res, urlOf('/api/connectors/fake/test'));
  ok('测试成功：ok=true + 条数 + 耗时', res.body.ok === true && res.body.count === 4 && typeof res.body.ms === 'number');
  ok('成功信息是人话（走 describeTestResult）', String(res.body.message).includes('能连上'));
  ok('最多给 3 条样例，避免大响应', res.body.sample.length === 3, JSON.stringify(res.body.sample));
}
{
  // 这条要先清掉"库里已存的配置"，否则会回落到已存的 url（那正是设计意图，见下一条）
  const keep = dbMap.get('fake').config_json;
  dbMap.get('fake').config_json = '{}';
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: {} }), res, urlOf('/api/connectors/fake/test'));
  ok('必填项没填：ok=false 且列出中文标签', res.body.ok === false && res.body.missing.includes('接口地址'));
  ok('必填提示是人话', String(res.body.message).includes('还有必填项没填'));
  dbMap.get('fake').config_json = keep;
}
{
  // 设计意图："只改一个字段再测一次"时，没填的字段要回落到已存的值
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: {} }), res, urlOf('/api/connectors/fake/test'));
  ok('没填的字段回落到已存配置（不会误报缺必填）', res.body.ok === true, JSON.stringify(res.body).slice(0, 160));
}
{
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: { url: 'https://a.example' } }), res, urlOf('/api/connectors/fake/fail-mode-test'));
  // 用不存在的 action 走 404，确认不会误当测试
  ok('未知 action → 404', res.code === 404);
}
{
  fetchMode = 'fail';
  const res = mkRes();
  await routes.handleConnectors(req('POST', { config: { url: 'https://a.example' } }), res, urlOf('/api/connectors/fake/test'));
  ok('测试失败：ok=false + 人话 + 原始错误都给出',
    res.body.ok === false && String(res.body.message).includes('检查一下地址') && String(res.body.error).includes('ECONNREFUSED'));
  fetchMode = 'ok';
}

// ---------------- 5. 离线示例 / 推进平台 ----------------
{
  calls.length = 0;
  const res = mkRes();
  await routes.handleConnectors(req('POST', {}), res, urlOf('/api/connectors/fake/demo'));
  ok('示例：插了 1 条、状态 demo', res.body.inserted === 1 && res.body.status === 'demo' && dbMap.get('fake').status === 'demo');
  ok('示例不需要任何配置', calls.some((c) => c[0] === 'insertData'));
}
{
  pushed.length = 0;
  dataMap.set('fake', [{ id: 'x1' }, { id: 'x2' }]);
  const res = mkRes();
  await routes.handleConnectors(req('POST', {}), res, urlOf('/api/connectors/fake/push'));
  ok('推进平台：每条都被推一次', res.body.pushed === 2 && pushed.length === 2);
  ok('推进时带上来源', pushed.every((r) => r.source === 'fake'));
}

// ---------------- 6. 搬家之后 server.mjs 里不再有这些实现 ----------------
// ---------------- 5b. 删除一个已添加的数据源（2026-09-26 用户要求） ----------------
{
  // 先确保它有一条配置 + 两条数据
  store.setConnector('fake', JSON.stringify({ url: 'https://a.example' }), 'ok', null);
  dataMap.set('fake', [{ id: 'x1' }, { id: 'x2' }]);
  const res = mkRes();
  await routes.handleConnectors(req('DELETE'), res, urlOf('/api/connectors/fake'));
  ok('删除接口 200 并报出删了什么',
    res.code === 200 && res.body.ok === true && res.body.removed_config === 1 && res.body.removed_items === 2,
    JSON.stringify(res.body));
  ok('配置行真的没了', !dbMap.has('fake'));
  ok('它导入的数据也一起清了（不留孤儿数据）', (dataMap.get('fake') || []).length === 0);
  ok('删的时候走的是 store 的方法（不是直接写 SQL）',
    calls.some((c) => c[0] === 'clearData' && c[1] === 'fake') && calls.some((c) => c[0] === 'deleteConfig' && c[1] === 'fake'));

  // 本来就没配过的：不报错，返回 0
  const res2 = mkRes();
  await routes.handleConnectors(req('DELETE'), res2, urlOf('/api/connectors/fake'));
  ok('重复删 / 没配过也不炸，如实返回 0', res2.code === 200 && res2.body.removed_config === 0);

  // 未知数据源仍然 404（删之前先过白名单）
  const res3 = mkRes();
  await routes.handleConnectors(req('DELETE'), res3, urlOf('/api/connectors/不存在'));
  ok('未知数据源 → 404', res3.code === 404);
}

// ---------------- 6. 搬家之后 server.mjs 里不再有这些实现 ----------------
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('server.mjs 不再自己实现 handleConnectors', !srv.includes('async function handleConnectors'));
  ok('server.mjs 保留接线', srv.includes('createConnectorRoutes({') && srv.includes('handleConnectors(req, res, url)'));
  const routesSrc = readFileSync(join(ROOT, 'lib', 'routes', 'connectors.mjs'), 'utf8');
  ok('接口实现里明确写了"测试连接走的就是导入那条路径"', routesSrc.includes('走的就是导入那条代码路径'));
}

console.log('');
console.log(failures === 0 ? 'connectors-routes.test: PASS' : `connectors-routes.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
