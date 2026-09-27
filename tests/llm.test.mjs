// 通用 agent 接入测试（W4-3）：请求拼装 / 响应解析 / 报错人话化 / 真调一次（本地假服务）。
//
//   node tests/llm.test.mjs

import { createServer } from 'node:http';

import {
  DEFAULT_LLM, PROVIDER_DEFAULTS, askLlm, buildRequest, describeLlm, humanizeLlmError,
  llmReady, normalizeLlm, parseResponse,
} from '../lib/llm.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('llm.test.mjs');

// ---------- 1. 配置整理 ----------
ok('默认走本机 Codex CLI（不改变现有行为）', DEFAULT_LLM.provider === 'codex-cli' && normalizeLlm({}).provider === 'codex-cli');
ok('未知 provider 回落到 codex-cli', normalizeLlm({ provider: 'gpt5' }).provider === 'codex-cli');
ok('只填 provider 也能得到默认地址与模型',
  normalizeLlm({ provider: 'openai' }).base_url === PROVIDER_DEFAULTS.openai.base_url
  && normalizeLlm({ provider: 'ollama' }).model === PROVIDER_DEFAULTS.ollama.model);
ok('显式填的地址/模型优先',
  normalizeLlm({ provider: 'openai', base_url: 'http://x/v1', model: 'm1' }).base_url === 'http://x/v1'
  && normalizeLlm({ provider: 'openai', base_url: 'http://x/v1', model: 'm1' }).model === 'm1',
  JSON.stringify(normalizeLlm({ provider: 'openai', base_url: 'http://x/v1', model: 'm1' })));
ok('脏输入不崩', normalizeLlm(null).schema === 'llm.v1' && normalizeLlm('x').enabled === true);
ok('超时时间有下限保护', normalizeLlm({ timeout_ms: 10 }).timeout_ms === DEFAULT_LLM.timeout_ms);

// ---------- 2. 可用性判定 ----------
ok('codex-cli 永远算可用', llmReady({ provider: 'codex-cli' }).ready === true);
ok('openai 缺 Key 不可用', llmReady({ provider: 'openai' }).ready === false
  && llmReady({ provider: 'openai' }).why.includes('API Key'));
ok('openai 有 Key 就可用', llmReady({ provider: 'openai', api_key: 'sk-x' }).ready === true);
ok('本地地址不需要 Key（自家 vLLM / LM Studio）',
  llmReady({ provider: 'openai', base_url: 'http://127.0.0.1:8000/v1' }).ready === true);
ok('Ollama 不需要 Key', llmReady({ provider: 'ollama' }).ready === true);
ok('关掉之后不可用', llmReady({ provider: 'ollama', enabled: false }).ready === false);
ok('describeLlm 说人话',
  describeLlm({ provider: 'anthropic', api_key: 'k' }).includes('Anthropic')
  && describeLlm({ provider: 'codex-cli' }) === '本机 Codex CLI');

// ---------- 3. 请求拼装 ----------
const openaiReq = buildRequest({ provider: 'openai', api_key: 'sk-1', model: 'm' }, '你好');
ok('OpenAI：地址与鉴权头正确',
  openaiReq.url === 'https://api.openai.com/v1/chat/completions'
  && openaiReq.headers.Authorization === 'Bearer sk-1', JSON.stringify(openaiReq).slice(0, 120));
ok('OpenAI：消息体正确（带 system 时在前）',
  buildRequest({ provider: 'openai', api_key: 'k' }, 'p', { system: 's' }).body.messages[0].role === 'system'
  && openaiReq.body.messages[0].content === '你好');

const anthReq = buildRequest({ provider: 'anthropic', api_key: 'ak' }, '你好', { system: 'sys' });
ok('Anthropic：/messages + x-api-key + 版本头',
  anthReq.url === 'https://api.anthropic.com/v1/messages'
  && anthReq.headers['x-api-key'] === 'ak'
  && anthReq.headers['anthropic-version'] === '2023-06-01');
ok('Anthropic：system 是顶层字段（不放进 messages）',
  anthReq.body.system === 'sys' && anthReq.body.messages.length === 1);

const ollamaReq = buildRequest({ provider: 'ollama', model: 'qwen2.5:7b' }, 'hi');
ok('Ollama：/api/chat + stream=false + 不带鉴权头',
  ollamaReq.url === 'http://127.0.0.1:11434/api/chat'
  && ollamaReq.body.stream === false && !ollamaReq.headers.Authorization);
ok('codex-cli 不走 HTTP（返回 null）', buildRequest({ provider: 'codex-cli' }, 'x') === null);
ok('地址末尾斜杠不会拼出双斜杠', buildRequest({ provider: 'openai', base_url: 'http://x/v1//' }, 'y').url === 'http://x/v1/chat/completions');

// ---------- 4. 响应解析 ----------
ok('OpenAI 解析', parseResponse('openai', { choices: [{ message: { content: ' 答案 ' } }] }) === '答案');
ok('Anthropic 解析（多段拼接）',
  parseResponse('anthropic', { content: [{ text: 'A' }, { text: 'B' }] }) === 'AB');
ok('Ollama 解析', parseResponse('ollama', { message: { content: '本地答案' } }) === '本地答案');
ok('结构不对时返回空串而不是抛错',
  parseResponse('openai', null) === '' && parseResponse('anthropic', { content: 'x' }) === '');

// ---------- 5. 报错人话化 ----------
ok('Ollama 连不上 → 提示启动服务',
  humanizeLlmError(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { provider: 'ollama' }).includes('ollama serve'));
ok('401 → 提示重新生成 Key',
  humanizeLlmError(new Error('HTTP 401: invalid api key'), { provider: 'openai' }).includes('重新生成'));
ok('404 → 提醒检查地址与模型名',
  humanizeLlmError(new Error('HTTP 404: model not found'), { provider: 'openai', model: 'gpt-x' }).includes('gpt-x'));
ok('超时 → 提示本地模型首次加载慢',
  humanizeLlmError(new Error('ETIMEDOUT'), { provider: 'ollama' }).includes('第一次加载'));

// ---------- 6. 真调一次：起一个本地假服务，按三家格式应答 ----------
const seen = [];
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    if (req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: '来自 OpenAI 形状的回答' } }] }));
    }
    if (req.url.includes('/api/chat')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: { content: '来自 Ollama 形状的回答' } }));
    }
    if (req.url.includes('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ content: [{ type: 'text', text: '来自 Anthropic 形状的回答' }] }));
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;
const base = `http://127.0.0.1:${port}`;

const r1 = await askLlm({ provider: 'openai', base_url: `${base}/v1`, api_key: 'sk-t', model: 'm' }, '问一句');
ok('OpenAI：真调一次拿到回答', r1.ok === true && r1.text.includes('OpenAI 形状'), JSON.stringify(r1).slice(0, 120));
ok('OpenAI：请求真的发对了（模型名进了 body）', seen.at(-1).body.model === 'm' && seen.at(-1).body.messages.at(-1).content === '问一句');

const r2 = await askLlm({ provider: 'ollama', base_url: base, model: 'qwen' }, '本地问一句');
ok('Ollama：真调一次拿到回答', r2.ok === true && r2.text.includes('Ollama 形状'));

const r3 = await askLlm({ provider: 'anthropic', base_url: base, api_key: 'ak', model: 'claude-x' }, '你好');
ok('Anthropic：真调一次拿到回答', r3.ok === true && r3.text.includes('Anthropic 形状'));

// 注意：本机地址（127.0.0.1）默认不需要 Key —— 自家的 vLLM / LM Studio 就是这样。
// 所以"缺 Key"要拿一个远程地址来测。
const before = seen.length;
const r4 = await askLlm({ provider: 'openai', base_url: 'https://api.openai.com/v1' }, 'x');
ok('远程地址缺 Key 时不会真的发请求，而是给出原因',
  r4.ok === false && r4.error.includes('API Key') && seen.length === before, JSON.stringify(r4).slice(0, 80));
ok('本机地址不需要 Key（自家模型服务）',
  (await askLlm({ provider: 'openai', base_url: `${base}/v1`, model: 'm' }, '无 Key')).ok === true);

const r5 = await askLlm({ provider: 'codex-cli' }, 'x');
ok('codex-cli 明确不走 HTTP（由本机 CLI 处理）', r5.ok === false && r5.error.includes('CLI'));

// 服务端 500 的情况
const bad = createServer((req, res) => { res.writeHead(500); res.end('boom'); });
await new Promise((r) => bad.listen(0, '127.0.0.1', r));
const r6 = await askLlm({ provider: 'openai', base_url: `http://127.0.0.1:${bad.address().port}/v1`, api_key: 'k' }, 'x');
ok('服务端 500 → 明确失败并带上状态码', r6.ok === false && r6.error.includes('500'), JSON.stringify(r6).slice(0, 80));
bad.close();
fake.close();

console.log('');
console.log(failures === 0 ? 'llm.test: PASS' : `llm.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
