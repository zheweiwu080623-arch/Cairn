// 通用 agent / 模型接入（W4-3）：不再只认"本机的 Codex CLI"。
//
// 支持四种 provider，覆盖"有 agent"和"只有一个 API Key"两类人：
//   codex-cli  本机 Codex CLI（原路径，由 server.mjs 直接 spawn，不改动）
//   openai     OpenAI 兼容接口（OpenAI / DeepSeek / Moonshot / vLLM / LM Studio…）
//   anthropic  Anthropic Messages API
//   ollama     本地模型（默认 http://127.0.0.1:11434，不需要 Key）
//   codex-config **沿用本机 Codex 的模型配置**（2026-09-22 新增）——
//               很多人的"agent"其实是别的模型跑在 Codex 壳子里（例如 DeepSeek + 本机中转），
//               这条通道直接读 ~/.codex/config.toml，不用再粘一次 Key。
//
// 本文件是纯函数 + 一个薄薄的 fetch 调用：拼请求、解析响应都不碰全局状态，方便测试。

export const LLM_SCHEMA = 'llm.v1';
export const LLM_PROVIDERS = ['codex-cli', 'codex-config', 'openai', 'anthropic', 'ollama'];

export const DEFAULT_LLM = Object.freeze({
  schema: LLM_SCHEMA,
  enabled: true,
  provider: 'codex-cli',
  base_url: '',
  model: '',
  api_key: '',
  timeout_ms: 60000,
  wire_api: '',        // codex-config 通道用：responses | chat
  local_provider: '',  // codex-config 通道用：本机配置里的 provider id（便于显示与排查）
  updated_at: 0,
});

/** 各 provider 的默认地址与默认模型（用户只填 Key 也能跑）。 */
export const PROVIDER_DEFAULTS = {
  openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needs_key: true, label: 'OpenAI 兼容接口' },
  anthropic: { base_url: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', needs_key: true, label: 'Anthropic' },
  ollama: { base_url: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', needs_key: false, label: '本地模型（Ollama）' },
  'codex-cli': { base_url: '', model: '', needs_key: false, label: '本机 Codex CLI' },
  'codex-config': { base_url: '', model: '', needs_key: false, label: '沿用本机 Codex 配置' },
};

export function normalizeLlm(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const provider = LLM_PROVIDERS.includes(r.provider) ? r.provider : 'codex-cli';
  const defaults = PROVIDER_DEFAULTS[provider];
  const trim = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    schema: LLM_SCHEMA,
    enabled: r.enabled !== false,
    provider,
    base_url: trim(r.base_url) || defaults.base_url,
    model: trim(r.model) || defaults.model,
    api_key: typeof r.api_key === 'string' ? r.api_key : '',
    wire_api: typeof r.wire_api === 'string' ? r.wire_api : '',
    local_provider: typeof r.local_provider === 'string' ? r.local_provider : '',
    timeout_ms: Number.isFinite(r.timeout_ms) && r.timeout_ms > 1000 ? r.timeout_ms : DEFAULT_LLM.timeout_ms,
    updated_at: Number.isFinite(r.updated_at) ? r.updated_at : 0,
  };
}

/** 这个配置能不能直接用（CLI 不需要 Key；其它 provider 需要 base_url，按需 Key）。 */
export function llmReady(raw) {
  const cfg = normalizeLlm(raw);
  if (!cfg.enabled) return { ready: false, why: '未启用' };
  if (cfg.provider === 'codex-cli') return { ready: true, why: '' };
  if (cfg.provider === 'codex-config') {
    // 这条通道的地址与令牌在**调用那一刻**从本机 Codex 配置里读（见 server.mjs），
    // 所以这里只要求"本机确实有那份配置"。
    if (!cfg.base_url) return { ready: false, why: '没读到本机 Codex 配置（~/.codex/config.toml）' };
    if (!cfg.model) return { ready: false, why: '本机 Codex 配置里没有 model' };
    return { ready: true, why: '' };
  }
  const d = PROVIDER_DEFAULTS[cfg.provider];
  if (!cfg.base_url) return { ready: false, why: '缺少接口地址' };
  if (d.needs_key && !cfg.api_key && !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(cfg.base_url)) {
    return { ready: false, why: '缺少 API Key' };
  }
  return { ready: true, why: '' };
}

export function describeLlm(raw) {
  const cfg = normalizeLlm(raw);
  if (cfg.provider === 'codex-cli') return '本机 Codex CLI';
  const d = PROVIDER_DEFAULTS[cfg.provider];
  if (cfg.provider === 'codex-config') {
    return `沿用本机 Codex 配置 · ${cfg.model}${/responses/i.test(cfg.wire_api || '') ? '（Responses 接口）' : ''}`;
  }
  return `${d.label} · ${cfg.model}${cfg.api_key ? '' : '（无 Key）'}`;
}

/**
 * 把本机 Codex 配置里的 provider 信息贴到一份 agent 配置上（**不落库**）。
 * 这是"沿用 Codex 配置"通道的关键：地址、模型、令牌都在调用时才从 config.toml 取。
 */
export function withLocalProvider(cfg, local) {
  const base = normalizeLlm(cfg);
  if (!local || !local.base_url) return base;
  return {
    ...base,
    provider: 'codex-config',
    base_url: String(local.base_url).replace(/\/+$/, ''),
    model: base.model || local.model || '',
    api_key: local.token || base.api_key || '',
    wire_api: local.wire_api || 'chat',
    local_provider: local.id || '',
  };
}

/**
 * 拼一个请求（纯函数，测试直接比对 URL/头/体）。
 *
 * @param {object} raw 模型配置
 * @param {string} prompt 文本提示词
 * @param {{system?:string, images?:{mime:string, base64:string}[]}} opts
 *   images：给**视觉模型**看的图（2026-09-27 新增，PDF→LaTeX 的"视觉路线"要用）。
 *   不传 images 时输出与以前**逐字节相同**（老测试不受影响）。
 */
export function buildRequest(raw, prompt, { system = '', images = [] } = {}) {
  const cfg = normalizeLlm(raw);
  const base = cfg.base_url.replace(/\/+$/, '');
  const text = String(prompt ?? '');
  const imgs = Array.isArray(images) ? images.filter((x) => x && x.base64) : [];
  // OpenAI 风格：content 数组里放 text + image_url(data URL)
  const openAiContent = imgs.length
    ? [{ type: 'text', text }, ...imgs.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/png'};base64,${im.base64}` } }))]
    : text;
  if (cfg.provider === 'openai') {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: openAiContent });
    return {
      url: `${base}/chat/completions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
      body: { model: cfg.model, messages, temperature: 0, stream: false },
      images_ok: true,
    };
  }
  if (cfg.provider === 'anthropic') {
    const anthropicContent = imgs.length
      ? [
        ...imgs.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime || 'image/png', data: im.base64 } })),
        { type: 'text', text },
      ]
      : text;
    return {
      url: `${base}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.api_key,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: cfg.model, max_tokens: 1024, temperature: 0,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: anthropicContent }],
      },
      images_ok: true,
    };
  }
  if (cfg.provider === 'ollama') {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    // Ollama 的 chat 接口认 images:[base64]（不带 data: 前缀）
    messages.push({ role: 'user', content: text, ...(imgs.length ? { images: imgs.map((im) => im.base64) } : {}) });
    return {
      url: `${base}/api/chat`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { model: cfg.model, messages, stream: false },
      images_ok: true,
    };
  }
  if (cfg.provider === 'codex-config') {
    // Codex 壳子通常用 Responses 接口（wire_api = "responses"）；
    // 也有中转只支持 chat/completions，所以按配置里写的来。
    const wantResponses = /responses/i.test(cfg.wire_api || '');
    if (wantResponses) {
      // Responses 接口的图：content 里放 input_text + input_image（data URL）。
      // 2026-09-27 实测：不给图它会回"本轮消息未包含可读取的截图" —— 那是图根本没送出去。
      return {
        url: `${base}/responses`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body: {
          model: cfg.model,
          input: imgs.length
            ? [{
              role: 'user',
              content: [
                { type: 'input_text', text },
                ...imgs.map((im) => ({ type: 'input_image', image_url: `data:${im.mime || 'image/png'};base64,${im.base64}` })),
              ],
            }]
            : text,
          ...(system ? { instructions: system } : {}),
          stream: false,
        },
        images_ok: true,
      };
    }
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: openAiContent });
    return {
      url: `${base}/chat/completions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
      body: { model: cfg.model, messages, temperature: 0, stream: false },
      images_ok: true,
    };
  }
  return null;   // codex-cli 不走 HTTP
}

/** 从各家响应里取出正文（纯函数）。 */
export function parseResponse(provider, json) {
  try {
    if (provider === 'openai') {
      const c = json?.choices?.[0];
      return String(c?.message?.content ?? c?.text ?? '').trim();
    }
    if (provider === 'anthropic') {
      const parts = Array.isArray(json?.content) ? json.content : [];
      return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
    }
    if (provider === 'ollama') {
      return String(json?.message?.content ?? json?.response ?? '').trim();
    }
    if (provider === 'codex-config') {
      // Responses 接口（2026-09-22 实测修正）：
      // 推理模型的返回里，`output` 是**两个并列项** —— 先 reasoning（思考过程）、后 message（真正的回答）。
      // 早先的写法把所有 content.text 拼在一起，于是用户看到一堵"思考墙"。
      // 正确做法：**只取 message 项里的 output_text**，跳过 reasoning。
      const parts = [];
      for (const item of Array.isArray(json?.output) ? json.output : []) {
        if (item?.type && item.type !== 'message') continue;         // 跳过 reasoning 等非回答项
        for (const c of Array.isArray(item?.content) ? item.content : []) {
          if (c?.type === 'reasoning_text' || c?.type === 'reasoning') continue;
          if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
      if (parts.length) return parts.join('').trim();
      // 有些中转会额外给一个 output_text 便利字段（没有 output 时才用它）
      if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
      // 兼容中转实际返回 chat/completions 形状的情况
      const c0 = json?.choices?.[0];
      return String(c0?.message?.content ?? c0?.text ?? '').trim();
    }
  } catch { /* 下面统一返回空串 */ }
  return '';
}

/** 把模型接口的报错也翻译成人话。 */
/**
 * 从任意文本里抹掉令牌（2026-09-22 新增）。
 * 为什么需要：有些中转/网关在报错时会把**整个请求**回显出来，里面就带着 Authorization 头。
 * 我们要保证任何路径下令牌都不会出现在界面或日志里。
 */
export function redactToken(text, token) {
  const t = String(token || '');
  let out = String(text ?? '');
  if (t && t.length >= 8) out = out.split(t).join('••••');
  // 顺手把形如 sk-xxxx / Bearer xxxx 的长串也打码，防止"令牌在别处被拼出来"
  return out.replace(/\b(sk-[A-Za-z0-9_-]{12,})/g, '••••')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, '$1••••');
}

export function humanizeLlmError(error, raw) {
  const cfg = normalizeLlm(raw);
  const msg = String(error?.message || error || '');
  if (/ECONNREFUSED/i.test(msg)) {
    if (cfg.provider === 'codex-config') {
      return '连不上本机 Codex 用的那个中转地址。请先确认 Codex 自己能正常对话（说明中转在跑），再回来重试。';
    }
    return cfg.provider === 'ollama'
      ? '连不上本地模型服务。请确认 Ollama 已经启动（命令行运行 `ollama serve`），地址默认是 http://127.0.0.1:11434'
      : '连不上这个接口地址：确认地址与端口写对了，且服务在运行。';
  }
  if (/\b401\b|invalid api key|unauthorized|authentication/i.test(msg)) {
    return 'API Key 无效或没有权限。请到服务商后台重新生成一个 Key，注意别带空格。';
  }
  if (/\b403\b|forbidden/i.test(msg)) return 'Key 有效但被拒绝：可能是该模型未开通或额度用尽。';
  if (/\b404\b|model.*not.*found|no such model/i.test(msg)) {
    return `接口或模型名不对：请检查「接口地址」（OpenAI 一般是 …/v1）与「模型名」（当前填的是 ${cfg.model || '（空）'}）。`;
  }
  if (/\b429\b|rate limit|quota/i.test(msg)) return '被限流或额度用尽，稍后再试或换一个模型。';
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) return '请求超时。本地模型第一次加载会比较慢，可以再试一次或换更小的模型。';
  return msg ? `调用失败：${msg.slice(0, 160)}` : '调用失败（没有错误信息）';
}

/**
 * 真的调一次模型。fetchImpl 可注入（测试用），默认用全局 fetch。
 * codex-cli 不走这里（由 server.mjs 直接 spawn），会明确返回失败而不是假装成功。
 */
export async function askLlm(raw, prompt, { fetchImpl, system = '', images = [], timeoutMs = 0 } = {}) {
  const cfg = normalizeLlm(raw);
  const ready = llmReady(cfg);
  if (!ready.ready) return { ok: false, error: ready.why };
  if (cfg.provider === 'codex-cli') return { ok: false, error: 'codex-cli 由本机 CLI 处理，不走 HTTP' };
  if (cfg.provider === 'codex-config' && !cfg.api_key && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(cfg.base_url)) {
    // 本机中转一般需要令牌；没有令牌也让它试一次（有些本地中转不需要）
  }
  const req = buildRequest(cfg, prompt, { system, images });
  // 要发图但这个通道不支持 → **如实报错**，不能悄悄只发文字（2026-09-27 实测：图被丢掉时
  // 模型会回一句"本轮消息未包含可读取的截图"，看着像模型不行，其实是请求里没图）。
  if (images.length && req && req.images_ok !== true) {
    return { ok: false, error: '这个模型通道发不了图（当前 provider 不支持图片输入）—— 视觉路线需要在「数据源 → Agent 接入」里选一个支持图片的接口。' };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) return { ok: false, error: '当前运行环境没有 fetch' };
  const controller = new AbortController();
  // 带图的请求（PDF 一页 100KB 级别的 base64）会明显更慢，允许调用方要求更长的超时
  const budget = Number(timeoutMs) > 1000 ? Number(timeoutMs) : cfg.timeout_ms;
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const res = await doFetch(req.url, {
      method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}：${text.slice(0, 200)}`, status: res.status };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { return { ok: false, error: `返回的不是 JSON：${text.slice(0, 120)}` }; }
    const out = parseResponse(cfg.provider, json);
    if (!out) return { ok: false, error: '模型返回了空内容', json };
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'ETIMEDOUT 请求超时' : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
