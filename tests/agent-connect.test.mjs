// Agent 接入模块测试（W4-3 的 UI 部分）。
//
//   node tests/agent-connect.test.mjs

import { PROVIDER_OPTIONS, renderCard } from '../modules/agent-connect/view.js';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('agent-connect.test.mjs');

ok('四种 provider 都能选',
  PROVIDER_OPTIONS.length === 5
  && PROVIDER_OPTIONS.map((o) => o.id).join(',') === 'codex-cli,codex-config,openai,anthropic,ollama',
  PROVIDER_OPTIONS.map((o) => o.id).join(','));
ok('有「沿用本机 Codex 配置」这一项（DeepSeek 跑在 Codex 壳子里的情况）',
  PROVIDER_OPTIONS.some((o) => o.id === 'codex-config'));

const cliCard = renderCard({});
ok('默认是本机 CLI（字段区默认隐藏）',
  cliCard.includes('value="codex-cli" selected') && cliCard.includes('id="ag-fields" style="display:none"'),
  cliCard.slice(0, 200));
ok('卡片有测试与保存按钮', cliCard.includes('id="ag-test"') && cliCard.includes('id="ag-save"'));

const openaiCard = renderCard({
  provider: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
  has_key: true, api_key: '••••abcd', ready: true, label: 'OpenAI 兼容接口 · deepseek-chat',
});
ok('非 CLI 时字段区展开', !openaiCard.includes('id="ag-fields" style="display:none"'));
ok('地址/模型回填', openaiCard.includes('https://api.deepseek.com/v1') && openaiCard.includes('deepseek-chat'));
ok('Key 只显示掩码', openaiCard.includes('value="••••abcd"') && !openaiCard.includes('sk-'));
ok('当前 provider 被选中', openaiCard.includes('value="openai" selected'));

const notReady = renderCard({ provider: 'openai', ready: false, why: '缺少 API Key' });
ok('不可用时把原因说出来', notReady.includes('缺少 API Key'));

ok('脏输入不崩', renderCard(null).includes('agent-connect'));
ok('HTML 转义生效', renderCard({ model: '<script>x</script>' }).includes('&lt;script&gt;'));

// ---- 真 mount 一次 ----
function fakeEl() {
  const nodes = new Map();
  const store = new Map([
    ['#ag-provider', { value: 'ollama', onchange: null }],
    ['#ag-enabled', { checked: true }],
    ['#ag-base', { value: 'http://127.0.0.1:11434' }],
    ['#ag-model', { value: 'qwen2.5:7b' }],
    ['#ag-key', { value: '' }],
  ]);
  return {
    innerHTML: '',
    querySelector(sel) {
      if (nodes.has(sel)) return nodes.get(sel);
      if (store.has(sel)) return store.get(sel);
      nodes.set(sel, { textContent: '', innerHTML: '', onclick: null, style: {} });
      return nodes.get(sel);
    },
    querySelectorAll: () => [],
  };
}

const el = fakeEl();
const calls = [];
const ctx = {
  api: async (method, path, body) => {
    calls.push({ path, body });
    if (path === '/api/agent/test') return { ok: true, message: '本地模型（Ollama） · qwen2.5:7b 可用（回复：可用）' };
    return { ok: true };
  },
  toast: () => {},
  refresh: async () => {},
  DB: { agent: { provider: 'ollama', base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', enabled: true, label: '本地模型（Ollama） · qwen2.5:7b', ready: true } },
};

const mod = await import('../modules/agent-connect/view.js');
let err = null;
try { await mod.mount(el, ctx); } catch (e) { err = e; }
ok('mount() 不抛异常', err === null, String(err));
ok('mount() 渲染出卡片', el.innerHTML.includes('Agent / 模型接入'));

await el.querySelector('#ag-test').onclick();
ok('点「测试」→ 先保存配置再调测试接口',
  calls.some((c) => c.path === '/api/agent') && calls.some((c) => c.path === '/api/agent/test'),
  JSON.stringify(calls.map((c) => c.path)));
ok('保存时带上 provider/地址/模型', (() => {
  const save = calls.find((c) => c.path === '/api/agent');
  return save?.body?.provider === 'ollama' && save?.body?.model === 'qwen2.5:7b';
})(), JSON.stringify(calls.find((c) => c.path === '/api/agent')?.body));
ok('测试结果写到界面', String(el.querySelector('#ag-result').innerHTML).includes('可用'),
  String(el.querySelector('#ag-result').innerHTML));

console.log('');
console.log(failures === 0 ? 'agent-connect.test: PASS' : `agent-connect.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
