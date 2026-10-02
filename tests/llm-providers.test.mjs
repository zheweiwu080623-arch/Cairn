// 模型供应商注册表（改造项 4）的验证。
//
//   node tests/llm-providers.test.mjs
//
// 要说清的是三件事：
//   ① 对外契约没变：LLM_PROVIDERS / PROVIDER_DEFAULTS 还是原来那五家、原样的值；
//   ② 每家都实现了同一套契约（加一家只加文件 + 注册表一行，靠的就是这个形状统一）；
//   ③ 拼请求 / 解析 / 可用性 / 说明文案确实由注册表驱动（不是还有一份藏在别处的 switch）。

import { LLM_PROVIDERS, PROVIDER_DEFAULTS, buildRequest, describeLlm, llmReady, normalizeLlm } from '../lib/llm.mjs';
import { REGISTRY, getProvider, providerDefaults, providerIds } from '../lib/llm-providers/index.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('llm-providers.test.mjs');

// ---------------- ① 对外契约没变 ----------------
{
  const expected = ['codex-cli', 'codex-config', 'openai', 'anthropic', 'ollama'];
  ok('LLM_PROVIDERS 仍是原来那五家、顺序不变',
    JSON.stringify(LLM_PROVIDERS) === JSON.stringify(expected), JSON.stringify(LLM_PROVIDERS));
  ok('providerIds() 与 LLM_PROVIDERS 一致',
    JSON.stringify(providerIds()) === JSON.stringify(LLM_PROVIDERS));

  // 逐家核对默认值：这是"重构不许改行为"的硬证据
  const want = {
    openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needs_key: true, label: 'OpenAI 兼容接口' },
    anthropic: { base_url: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', needs_key: true, label: 'Anthropic' },
    ollama: { base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', needs_key: false, label: '本地模型（Ollama）' },
    'codex-cli': { base_url: '', model: '', needs_key: false, label: '本机 Codex CLI' },
    'codex-config': { base_url: '', model: '', needs_key: false, label: '沿用本机 Codex 配置' },
  };
  const same = Object.entries(want).every(([id, w]) => {
    const d = PROVIDER_DEFAULTS[id];
    return d && d.base_url === w.base_url && d.model === w.model && d.needs_key === w.needs_key && d.label === w.label;
  });
  ok('五家的默认地址 / 默认模型 / 是否要 Key / 名称都没变', same, JSON.stringify(PROVIDER_DEFAULTS));
  ok('PROVIDER_DEFAULTS 由注册表生成（两份是同一内容）',
    JSON.stringify(providerDefaults()) === JSON.stringify(PROVIDER_DEFAULTS));
}

// ---------------- ② 每家都实现了同一套契约 ----------------
{
  const bad = REGISTRY.filter((p) => !(
    typeof p.id === 'string' && p.id
    && typeof p.label === 'string' && p.label
    && typeof p.needs_key === 'boolean'
    && p.defaults && typeof p.defaults === 'object'
    && typeof p.build === 'function'
    && typeof p.parse === 'function'
  ));
  ok('注册表里每家都有 { id, label, needs_key, defaults, build, parse }',
    bad.length === 0, bad.map((p) => p.id).join(','));
  ok('id 不重复', new Set(REGISTRY.map((p) => p.id)).size === REGISTRY.length);
  ok('getProvider 能按 id 取到，取不到给 null',
    getProvider('openai')?.id === 'openai' && getProvider('没有这家') === null);
}

// ---------------- ③ 行为确实由注册表驱动 ----------------
{
  // 拼请求：五家各自的形状
  const openai = buildRequest({ provider: 'openai', api_key: 'k' }, 'hi');
  ok('OpenAI：/chat/completions + Bearer',
    openai.url.endsWith('/chat/completions') && openai.headers.Authorization === 'Bearer k');

  const anth = buildRequest({ provider: 'anthropic', api_key: 'k' }, 'hi');
  ok('Anthropic：/messages + x-api-key + version 头',
    anth.url.endsWith('/messages') && anth.headers['x-api-key'] === 'k' && !!anth.headers['anthropic-version']);

  const oll = buildRequest({ provider: 'ollama' }, 'hi');
  ok('Ollama：/api/chat 且不带 Authorization', oll.url.endsWith('/api/chat') && !oll.headers.Authorization);

  ok('codex-cli：不走 HTTP（返回 null）', buildRequest({ provider: 'codex-cli' }, 'hi') === null);

  const cfg = buildRequest({ provider: 'codex-config', base_url: 'http://127.0.0.1:8080/v1', model: 'm', wire_api: 'responses' }, 'hi');
  ok('codex-config + responses：打到 /responses', cfg.url.endsWith('/responses'));
  const cfgChat = buildRequest({ provider: 'codex-config', base_url: 'http://127.0.0.1:8080/v1', model: 'm', wire_api: 'chat' }, 'hi');
  ok('codex-config + chat：打到 /chat/completions', cfgChat.url.endsWith('/chat/completions'));

  // 说明文案：特殊的那家自己提供，其余用通用规则
  ok('describeLlm：codex-cli 用自己的文案', describeLlm({ provider: 'codex-cli' }) === '本机 Codex CLI');
  ok('describeLlm：codex-config 用自己的文案（带接口类型）',
    /沿用本机 Codex 配置/.test(describeLlm({ provider: 'codex-config', model: 'm', wire_api: 'responses' })));
  ok('describeLlm：其余用通用规则（label · model）',
    describeLlm({ provider: 'openai', api_key: 'k' }) === 'OpenAI 兼容接口 · gpt-4o-mini');

  // 可用性：特殊的自己判、其余走通用
  ok('llmReady：codex-cli 永远可用', llmReady({ provider: 'codex-cli' }).ready === true);
  ok('llmReady：codex-config 没有地址时给出原因',
    llmReady({ provider: 'codex-config' }).why.includes('Codex 配置'));
  ok('llmReady：远程 openai 缺 Key 时给出原因',
    llmReady({ provider: 'openai' }).why === '缺少 API Key');
  ok('llmReady：本机地址的 openai 不需要 Key',
    llmReady({ provider: 'openai', base_url: 'http://127.0.0.1:1234/v1' }).ready === true);
  ok('normalizeLlm 仍会把不认识的 provider 归到 codex-cli',
    normalizeLlm({ provider: '不存在' }).provider === 'codex-cli');
}

console.log('');
console.log(failures === 0 ? 'llm-providers.test: PASS' : `llm-providers.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
