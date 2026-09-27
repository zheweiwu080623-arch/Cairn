// 连接向导测试（W4-2）：报错人话化 + 向导模块本身。
//
//   node tests/connect-wizard.test.mjs

import { describeTestResult, humanizeConnectorError } from '../lib/connector-errors.mjs';
import { renderCard, renderFields } from '../modules/connect-wizard/view.js';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('connect-wizard.test.mjs');

// ---------- 1. 报错人话化 ----------
const cases = [
  ['canvas', 'HTTP 401 Unauthorized', '令牌'],
  ['canvas', '403 Forbidden', '权限'],
  ['canvas', '404 Not Found', '域名'],
  ['email', 'LOGIN failed', '应用专用密码'],
  ['email', 'AUTHENTICATIONFAILED', '应用专用密码'],
  ['email', 'IMAP is disabled for this account', 'IMAP'],
  ['email_sjtu', 'getaddrinfo ENOTFOUND imap.example', '域名解析'],
  ['email', 'ETIMEDOUT', '超时'],
  ['email', 'ECONNREFUSED', '端口'],
  ['canvas', 'SSL certificate problem', '证书'],
];
for (const [source, raw, expectWord] of cases) {
  const h = humanizeConnectorError(source, new Error(raw));
  ok(`「${raw.slice(0, 26)}」→ ${expectWord}`, h.text.includes(expectWord), h.text.slice(0, 60));
}
ok('未知错误也给出原文（不吞）',
  humanizeConnectorError('canvas', new Error('some weird failure')).text.includes('some weird failure'));
ok('带前缀的状态码也能认（真跑 Canvas 时就是 "HTTP 401：…"）',
  humanizeConnectorError('canvas', new Error('HTTP 401：/api/v1/courses')).text.includes('令牌'),
  humanizeConnectorError('canvas', new Error('HTTP 401：/api/v1/courses')).text.slice(0, 40));
ok('连接器自己抛的中文提示原样透传（不再套一层"连接失败"）',
  humanizeConnectorError('arxiv', new Error('请至少填一个关键词或一个 arXiv 分类')).text.startsWith('请至少填'),
  humanizeConnectorError('arxiv', new Error('请至少填一个关键词或一个 arXiv 分类')).text);
ok('没有报错信息时兜底', humanizeConnectorError('canvas', null).text.includes('未知错误'));
ok('超长报错会被截断', humanizeConnectorError('canvas', new Error('x'.repeat(500))).text.length < 200);
ok('成功且有数据 → 明确说能导入',
  describeTestResult('canvas', { ok: true, count: 12 }).includes('12 条'));
ok('成功但没数据 → 也解释清楚这是正常的',
  describeTestResult('email', { ok: true, count: 0 }).includes('正常'));
ok('失败 → 复用人话化',
  describeTestResult('email', { ok: false, detail: new Error('LOGIN failed') }).includes('应用专用密码'));

// ---------- 2. 向导卡片（纯函数） ----------
const meta = [
  { id: 'canvas', name: 'Canvas LMS', icon: '🎓', description: '导入课程与作业', fields: [
    { key: 'base_url', label: 'Canvas 域名', type: 'text', placeholder: 'https://school.instructure.com', required: true },
    { key: 'token', label: 'API 令牌', type: 'password', placeholder: '粘贴 Canvas 生成的 Token', required: true },
  ] },
  { id: 'arxiv', name: 'arXiv 订阅', icon: '📄', fields: [{ key: 'keywords', label: '关键词', type: 'text' }] },
];
const card = renderCard(meta, 'canvas');
ok('卡片有数据源下拉与三步提示',
  card.includes('id="cw-source"') && card.includes('① 选数据源') && card.includes('③ 测试连接'));
ok('下拉里有两个数据源且当前项被选中',
  card.includes('value="canvas" selected') && card.includes('value="arxiv"'));
ok('有「保存并导入」按钮', card.includes('id="cw-import"'));
ok('没有数据源时给出提示', renderCard([], '').includes('还没有可用的数据源'));

const fields = renderFields(meta[0], { base_url: 'https://canvas.example.edu', token: '••••ora9' });
ok('字段按定义生成（含必填星号与占位示例）',
  fields.includes('data-cwkey="base_url"') && fields.includes('API 令牌 *') && fields.includes('粘贴 Canvas 生成的 Token'));
ok('已保存的值会回填（凭据是掩码）',
  fields.includes('value="https://canvas.example.edu"') && fields.includes('value="••••ora9"'));
ok('不需要填字段的数据源有说明',
  renderFields({ fields: [] }, {}).includes('不需要填'));
ok('meta 为空时也不崩', renderFields(null, {}).includes('没有这个数据源'));

// ---------- 3. 真正 mount 一次（框架的调用方式） ----------
function fakeInput(key) {
  return { dataset: { cwkey: key }, value: '', placeholder: '' };
}
function fakeEl(inputs) {
  const nodes = new Map();
  return {
    innerHTML: '',
    querySelector(sel) {
      if (sel === '#cw-source') return { value: 'canvas', onchange: null };
      if (!nodes.has(sel)) nodes.set(sel, { textContent: '', innerHTML: '', onclick: null, textContent2: '' });
      return nodes.get(sel);
    },
    querySelectorAll: () => inputs,
  };
}
const inputs = [fakeInput('base_url'), fakeInput('token')];
const el = fakeEl(inputs);
const calls = [];
const ctx = {
  api: async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/test')) return { ok: true, count: 7, message: '连接成功，已经能看到 7 条数据（可以放心导入了）' };
    return { inserted: 7 };
  },
  toast: () => {},
  refresh: async () => {},
  DB: { connectors: { meta, configs: [{ source: 'canvas', config_json: JSON.stringify({ base_url: 'https://canvas.example.edu', token: '••••ora9' }) }] } },
};

const mod = await import('../modules/connect-wizard/view.js');
let err = null;
let handle = null;
try { handle = await mod.mount(el, ctx); } catch (e) { err = e; }
ok('mount() 不抛异常', err === null, String(err));
ok('mount() 渲染了向导卡片', el.innerHTML.includes('连接向导'));
ok('mount() 返回 rerender', typeof handle?.rerender === 'function');

// 点「测试连接」：应当调后端 test 接口，并把结果写回界面
const testBtn = el.querySelector('#cw-test');
inputs[0].value = 'https://canvas.example.edu';
inputs[1].value = 'token-abc';
await testBtn.onclick();
const testCall = calls.find((c) => c.path.endsWith('/test'));
ok('点了「测试连接」→ 调 /api/connectors/canvas/test', !!testCall, JSON.stringify(calls.map((c) => c.path)));
ok('把表单里的值一起发过去', testCall?.body?.config?.token === 'token-abc' && testCall?.body?.config?.base_url === 'https://canvas.example.edu',
  JSON.stringify(testCall?.body));
ok('结果用人话显示在界面上',
  String(el.querySelector('#cw-result').innerHTML).includes('7 条'), String(el.querySelector('#cw-result').innerHTML));

// 点「保存并导入」
await el.querySelector('#cw-import').onclick();
ok('点了「保存并导入」→ 调 import 接口', calls.some((c) => c.path.endsWith('/import')));

// ---------- 4. 防回归 ----------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
// R2 之后「测试连接」那段搬到了 lib/routes/connectors.mjs，server.mjs 只做接线。
// 所以这里查实现文件，并额外确认 server 确实把它接上了。
const connSrc = readFileSync(join(ROOT, 'lib', 'routes', 'connectors.mjs'), 'utf8');
const iTest = connSrc.indexOf("action === 'test'");
const iDemo = connSrc.indexOf("action === 'demo'");
ok('服务端有 /api/connectors/:source/test 路由', iTest > 0);
ok('测试路由在 demo 分支之外（不会永远进不去）', iTest > 0 && iDemo > iTest, `test@${iTest} demo@${iDemo}`);
ok('测试连接有超时保护（60 秒，够 Canvas 全量拉取）',
  /new Promise\(\(_, reject\) => setTimeout/.test(connSrc) && connSrc.includes('60000'));
ok('测试连接会检查必填项', /missing/.test(connSrc.slice(iTest, iTest + 2000)));
ok('server.mjs 把数据源接口接上了（含测试连接这条路径）',
  srv.includes('createConnectorRoutes({') && srv.includes('handleConnectors(req, res, url)'));

console.log('');
console.log(failures === 0 ? 'connect-wizard.test: PASS' : `connect-wizard.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
