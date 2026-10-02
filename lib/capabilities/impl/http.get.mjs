// 能力模块：http.get —— 取一个网址的内容（读类：只取，不写）。
//
// 这是「通用原子」里的第一条（2026-10-02）：以前想接一个新的 JSON 接口就得写代码，
// 现在"取一个网址"是一条能力，跟 json.pick / text.template 拼起来就能干完。
//
// 三条边界（对着"敢让别人拼"这件事）：
//   * **只认 http/https**（file:// 之类一律拒绝，不给图留后门）；
//   * **有超时、有大小上限**（默认 15 秒 / 20 万字符），不会因为对方不回应把整张图卡死；
//   * **失败不抛**：返回 `{ ok:false, error }`，让图自己用 `when` 决定"失败怎么办"。
export const meta = {
  id: 'http.get',
  name: '取一个网址（GET）',
  version: '1.0.0',
  kind: 'read',
  input: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      headers: { type: 'object' },
      mode: { type: 'string', enum: ['auto', 'json', 'text'] },
      timeout_ms: { type: 'number' },
      max_chars: { type: 'number' },
    },
    required: ['url'],
  },
  output: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, status: { type: 'number' }, text: { type: 'string' }, json: { type: ['object', 'array', 'null'] } },
  },
  permissions: ['net:outbound'],
  idempotent: true,
  cost: 'none',
  ui: { label: '取一个网址', group: '通用', icon: '🌐' },
  model: { description: '当需要去网上取一份内容（JSON 接口、网页正文、RSS）时用它。只读，不改任何东西；取不到会如实返回失败原因。' },
  used_by: ['web-fetch-flow'],
  notes: 'GET 一个 http/https 网址；mode=auto 时按 Content-Type 判断要不要解析成 JSON。'
    + '只读、可重放（同一个网址取两次结果一样）。失败如实返回 ok:false，不抛。',
};

export const bind = { from: 'none' };

export async function run(input = {}, ctx = {}) {
  const url = String(input.url || '').trim();
  if (!url) return { ok: false, error: '没有 url' };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: `看不懂这个网址：${url}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `只允许 http/https，收到 ${u.protocol}` };
  }
  const timeoutMs = Math.max(1000, Math.min(Number(input.timeout_ms) || 15000, 60000));
  const maxChars = Math.max(500, Math.min(Number(input.max_chars) || 200000, 2000000));
  const mode = ['auto', 'json', 'text'].includes(input.mode) ? input.mode : 'auto';

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  if (timer && timer.unref) timer.unref();
  let res;
  try {
    res = await fetch(u.href, {
      method: 'GET',
      headers: { 'User-Agent': 'Cairn/1.0 (+local)', ...(input.headers && typeof input.headers === 'object' ? input.headers : {}) },
      signal: ctrl ? ctrl.signal : undefined,
      redirect: 'follow',
    });
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `超过 ${timeoutMs}ms 没回应` : ((e && e.message) || String(e));
    ctx.log?.(`[http.get] ${u.href} 取不到：${msg}`);
    return { ok: false, error: msg, url: u.href };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const contentType = String(res.headers.get('content-type') || '');
  let raw = '';
  try { raw = await res.text(); } catch (e) { return { ok: false, status: res.status, error: `读回应失败：${(e && e.message) || e}` }; }
  const truncated = raw.length > maxChars;
  const text = truncated ? raw.slice(0, maxChars) : raw;
  const looksJson = mode === 'json' || (mode === 'auto' && /json/i.test(contentType));
  let json = null;
  let parseError = '';
  if (looksJson) {
    try { json = JSON.parse(text); } catch (e) { parseError = `回应不是合法 JSON：${(e && e.message) || e}`; }
  }
  if (!res.ok) {
    return {
      ok: false, status: res.status, url: u.href, contentType, text, json, truncated,
      error: `对方回了 HTTP ${res.status}`,
    };
  }
  return {
    ok: true, status: res.status, url: u.href, contentType, text, json, truncated,
    error: parseError || undefined,
  };
}
