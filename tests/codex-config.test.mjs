// 「沿用本机 Codex 配置」这条通道的验证。
//
//   node tests/codex-config.test.mjs
//
// 背景：很多人的 agent 是**别的模型跑在 Codex 壳子里**（本文用 DeepSeek + 本机中转举例），
// 这时本机没有 `codex` 命令行，但 config.toml 里的地址/模型/令牌是可用的。
//
// 安全要求（本文件重点）：令牌**不落库、不进日志、不进接口**，对外只能出现掩码。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CODEX_CONFIG_FILE, describeLocalProvider, maskToken, parseCodexConfig, resolveCodexProvider,
} from '../lib/codex-config.mjs';
import {
  LLM_PROVIDERS, buildRequest, describeLlm, llmReady, normalizeLlm, parseResponse, redactToken, withLocalProvider,
} from '../lib/llm.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('codex-config.test.mjs');

// 一份"像真实机器那样"的配置：模型与供应商在顶层，细节在 [model_providers.<id>]
const SAMPLE = `
model = "deepseek-chat"
model_reasoning_effort = "high"
model_provider = "deepseek"
preferred_auth_method = "apikey"

[marketplaces.openai-bundled]
source_type = "local"

[model_providers.deepseek]
name = "deepseek"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
experimental_bearer_token = "sk-example000000000000"

[projects.'c:\\tmp\\demo']
trust_level = "trusted"
`;

// ---------------- 1. 解析 ----------------
const parsed = parseCodexConfig(SAMPLE);
ok('顶层 model 解析出来', parsed.top.model === 'deepseek-chat', JSON.stringify(parsed.top));
ok('顶层 model_provider 解析出来', parsed.top.model_provider === 'deepseek');
ok('分段被正确切开', Object.keys(parsed.sections).includes('model_providers.deepseek'));
ok('带点号的段名也认得', parsed.sections['projects.\'c:\\\\tmp\\\\demo\''] !== undefined
  || Object.keys(parsed.sections).some((k) => k.startsWith('projects')), JSON.stringify(Object.keys(parsed.sections)));
ok('布尔与数字也被解析', parseCodexConfig('a = true\nb = 12').top.a === true && parseCodexConfig('a = true\nb = 12').top.b === 12);
ok('单引号字符串也认', parseCodexConfig("k = 'v'").top.k === 'v');
ok('注释与空行被忽略', Object.keys(parseCodexConfig('# 注释\n\nk = "v"').top).length === 1);
ok('解析不了的行只计数、不抛错', parseCodexConfig('这行不是 TOML').unknown === 1);
ok('空输入不炸', parseCodexConfig('').top && Object.keys(parseCodexConfig('').top).length === 0);

// ---------------- 2. 找到当前 provider ----------------
const prov = resolveCodexProvider(parsed);
ok('找到 deepseek 这个 provider', prov && prov.id === 'deepseek', JSON.stringify(prov));
ok('地址带 /v1', prov.base_url === 'http://127.0.0.1:8788/v1');
ok('接口类型是 responses', prov.wire_api === 'responses');
ok('令牌读到了（但下面会检查它不外泄）', Boolean(prov.token));
ok('模型名跟着顶层 model', prov.model === 'deepseek-chat');
ok('env_key 写法也支持',
  resolveCodexProvider(parseCodexConfig('[model_providers.x]\nenv_key = "MY_KEY"\nbase_url = "http://a/v1"'), { env: { MY_KEY: 'secret' } }).token === 'secret');
ok('没有 provider 段时返回 null', resolveCodexProvider(parseCodexConfig('model = "x"')) === null);
ok('只有一个 provider 段时容错采用',
  resolveCodexProvider(parseCodexConfig('[model_providers.only]\nbase_url = "http://b/v1"')).id === 'openai');

// ---------------- 3. 掩码与对外描述（**不许泄露令牌**） ----------------
ok('掩码只留末 4 位', maskToken('sk-example000000000000') === '••••0000', maskToken('sk-example000000000000'));
ok('空令牌掩码是空串', maskToken('') === '' && maskToken(null) === '');
{
  const desc = describeLocalProvider(prov);
  const json = JSON.stringify(desc);
  ok('对外描述里没有完整令牌', !json.includes(prov.token), json);
ok('只给"有没有令牌"和掩码', desc.has_token === true && desc.token_masked === '••••0000');
  ok('认得出是本机地址', desc.local === true);
  ok('没找到时返回 {found:false}', describeLocalProvider(null).found === false);
  ok('配置文件名叫 config.toml', CODEX_CONFIG_FILE === 'config.toml');
}

// ---------------- 4. llm 层：新 provider 与请求拼装 ----------------
ok('provider 清单里有 codex-config', LLM_PROVIDERS.includes('codex-config'));
{
  const ready = llmReady({ provider: 'codex-config', base_url: 'http://127.0.0.1:8788/v1', model: 'deepseek-chat' });
  ok('有地址有模型就算就绪（令牌在调用那一刻才读）', ready.ready === true, JSON.stringify(ready));
  ok('没读到配置时明确说不就绪',
    llmReady({ provider: 'codex-config' }).ready === false
    && /Codex 配置/.test(llmReady({ provider: 'codex-config' }).why));
}
{
  const cfg = withLocalProvider({ provider: 'codex-config' }, prov);
  ok('把本机配置贴进调用配置（含令牌与接口类型）',
    cfg.base_url === prov.base_url && cfg.model === 'deepseek-chat' && cfg.api_key === prov.token && cfg.wire_api === 'responses');
  ok('显示名说明了来源', /沿用本机 Codex 配置/.test(describeLlm(cfg)) && /Responses/.test(describeLlm(cfg)), describeLlm(cfg));

  const req = buildRequest(cfg, '你好');
  ok('wire_api=responses → 打到 /responses', req.url === 'http://127.0.0.1:8788/v1/responses', req.url);
  ok('用 Bearer 令牌', req.headers.Authorization === `Bearer ${prov.token}`);
  ok('请求体是 Responses 形状（input + 非流式）', req.body.model === 'deepseek-chat' && req.body.input === '你好' && req.body.stream === false, JSON.stringify(req.body));
  const withSys = buildRequest(cfg, '你好', { system: '你是助理' });
  ok('system 映射成 instructions', withSys.body.instructions === '你是助理');

  const chatCfg = { ...cfg, wire_api: 'chat' };
  ok('wire_api=chat → 回落到 /chat/completions',
    buildRequest(chatCfg, '你好').url === 'http://127.0.0.1:8788/v1/chat/completions');

  ok('解析 output_text 形状', parseResponse('codex-config', { output_text: ' 建议一 ' }) === '建议一');
  ok('解析 output[].content[].text 形状',
    parseResponse('codex-config', { output: [{ content: [{ type: 'output_text', text: 'A' }, { text: 'B' }] }] }) === 'AB');
  // 2026-09-22 实测：推理模型的 Responses 返回是 reasoning + message 两个并列项，
  // 早先的写法把思考过程也拼进正文了（用户看到一堵"思考墙"）。
  {
    const real = {
      object: 'response',
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '我们需要回答用户。注意不要编造。' }] },
        { type: 'message', content: [{ type: 'output_text', text: '先做实验报告，因为明天截止。' }] },
      ],
    };
    const got = parseResponse('codex-config', real);
    ok('只取 message 项、跳过 reasoning 项', got === '先做实验报告，因为明天截止。', got);
    ok('思考过程没有混进正文', !/我们需要回答用户/.test(got), got);
  }
  ok('没有 output 时才用 output_text 便利字段',
    parseResponse('codex-config', { output_text: '兜底文本' }) === '兜底文本');
  ok('兼容中转返回 chat 形状', parseResponse('codex-config', { choices: [{ message: { content: 'C' } }] }) === 'C');
  ok('chat 形状下 reasoning_content 不会混进正文',
    parseResponse('codex-config', { choices: [{ message: { content: 'C', reasoning_content: '思考思考' } }] }) === 'C');
  ok('认不出的响应返回空串', parseResponse('codex-config', { 别的字段: 1 }) === '');
}

// ---------------- 5. 安全：令牌不许出现在源码的对外位置 ----------------
{
const TOKEN = 'sk-example000000000000';
  ok('错误里回显的令牌会被抹掉',
    redactToken(`HTTP 400：{"headers":{"Authorization":"Bearer ${TOKEN}"}}`, TOKEN)
      === 'HTTP 400：{"headers":{"Authorization":"Bearer ••••"}}',
    redactToken(`x${TOKEN}y`, TOKEN));
  ok('没传具体令牌时，形如 sk-xxx 的长串也会被抹掉',
    redactToken('key=sk-abcdefghijklmnop 出错', '').includes('••••')
    && !redactToken('key=sk-abcdefghijklmnop 出错', '').includes('sk-abc'));
  ok('短字符串不会被误伤', redactToken('普通文本 abc', 'abc') === '普通文本 abc');
  ok('空输入不炸', redactToken('', TOKEN) === '' && redactToken(null, null) === '');
}
{
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('server 在调用那一刻才解析本机配置', /if \(cfg\.provider === 'codex-config'\)[\s\S]{0,300}resolveLocalProvider\(\)/.test(srv));
  ok('存配置时**不写令牌**（源码里写明了）', srv.includes('不写令牌'));
  ok('对外接口只给掩码描述', srv.includes('local: describeLocalProvider(resolveLocalProvider())'));
  ok('server 没有把 codex 配置里的令牌落库',
    !/setSync\(AGENT_KEY[\s\S]{0,120}local\.token/.test(srv));

  const llm = readFileSync(join(ROOT, 'lib', 'llm.mjs'), 'utf8');
  ok('llm.mjs 里没有硬编码任何令牌', !/sk-[A-Za-z0-9]{16,}/.test(llm));
  const cfgSrc = readFileSync(join(ROOT, 'lib', 'codex-config.mjs'), 'utf8');
  ok('codex-config.mjs 里没有硬编码任何令牌', !/sk-[A-Za-z0-9]{16,}/.test(cfgSrc));
  ok('对外描述函数在导出列表里', cfgSrc.includes('export function describeLocalProvider'));
}

console.log('');
console.log(failures === 0 ? 'codex-config.test: PASS' : `codex-config.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
