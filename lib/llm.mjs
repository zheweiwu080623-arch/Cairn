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
//
// 【改造项 4】各家的差异（地址、默认模型、怎么拼请求、怎么取正文、有什么特殊要求）
// 已经全部搬进 `lib/llm-providers/`：**一家一个文件**，这里只留"共同逻辑 + 门面"。
// 加一家供应商 = 加一个 provider 文件 + 在 `lib/llm-providers/index.mjs` 注册一行，
// 本文件与所有调用方都不用改。

import { getProvider, providerDefaults, providerIds } from './llm-providers/index.mjs';

export const LLM_SCHEMA = 'llm.v1';
export const LLM_PROVIDERS = providerIds();

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

/** 各 provider 的默认地址与默认模型（用户只填 Key 也能跑）——由注册表生成。 */
export const PROVIDER_DEFAULTS = providerDefaults();

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
  const p = getProvider(cfg.provider);
  if (p?.ready) return p.ready(cfg);       // 这家自己有要求（如"沿用本机 Codex 配置"）
  const d = PROVIDER_DEFAULTS[cfg.provider];
  if (!cfg.base_url) return { ready: false, why: '缺少接口地址' };
  if (d.needs_key && !cfg.api_key && !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(cfg.base_url)) {
    return { ready: false, why: '缺少 API Key' };
  }
  return { ready: true, why: '' };
}

export function describeLlm(raw) {
  const cfg = normalizeLlm(raw);
  const p = getProvider(cfg.provider);
  if (p?.describe) return p.describe(cfg);
  const d = PROVIDER_DEFAULTS[cfg.provider];
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
  // 各家的差异都在 lib/llm-providers/ 里；这里只准备共同上下文再问它。
  const p = getProvider(cfg.provider);
  if (!p?.build) return null;
  return p.build({ cfg, base, text, images: imgs, system, openAiContent });
}

/** 从各家响应里取出正文（纯函数）。 */
export function parseResponse(provider, json) {
  try {
    const p = getProvider(provider);
    if (p?.parse) return p.parse(json);
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
