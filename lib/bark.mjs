// Bark（iOS 推送 App）通道：把 planner 的通知推到 iPhone。
// 只要电脑能上网即可，不需要公网 IP、不需要服务器；密钥保存在本机设置里。
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export const BARK_DEFAULT_SERVER = 'https://api.day.app';

// 用户可能粘贴三种东西：纯 key、https://api.day.app/<key>、https://api.day.app/<key>/...
// 还可能是聊天软件里带 Markdown 的 [链接](链接) 形式，这里一并清洗掉。
export function cleanBarkInput(input) {
  let s = String(input || '').trim();
  const md = s.match(/\[[^\]]*\]\(\s*([^)\s]+)\s*\)/);
  if (md) s = md[1];
  s = s.replace(/[[\]<>]/g, '').trim();
  const url = s.match(/https?:\/\/[^\s)\]]+/);
  if (url) s = url[0];
  return s.replace(/\s+/g, '');
}

export function parseBarkInput(input, fallbackServer = BARK_DEFAULT_SERVER) {
  const raw = cleanBarkInput(input);
  if (!raw) return { server: fallbackServer, key: '' };
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const key = u.pathname.split('/').filter(Boolean)[0] || '';
      return { server: `${u.protocol}//${u.host}`, key };
    } catch {
      return { server: fallbackServer, key: raw };
    }
  }
  return { server: fallbackServer, key: raw.replace(/^\/+|\/+$/g, '') };
}

function requestJson(target, { method = 'GET', body = null, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch (e) { resolve({ ok: false, error: `地址无效：${e.message}` }); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: `${u.pathname}${u.search}`,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
        : {},
      timeout,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* 非 JSON 响应 */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed, text: data.slice(0, 300) });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 推送一条 Bark 通知。
 * @param {object} opts
 * @param {string} opts.key      Bark 密钥（或完整推送地址）
 * @param {string} [opts.server] 自建服务器地址
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {string} [opts.url]    点击跳转链接
 * @param {string} [opts.group]  通知分组
 * @param {string} [opts.level]  active | timeSensitive | passive | critical
 * @param {string} [opts.sound]
 */
export async function barkPush(opts) {
  const { server: fallback = BARK_DEFAULT_SERVER, group = 'Planner', level = 'active', sound, icon } = opts;
  const { server, key } = parseBarkInput(opts.key, fallback);
  if (!key) return { ok: false, error: '还没有填写 Bark 密钥' };
  const base = server.replace(/\/+$/, '');
  const body = {
    device_key: key,
    title: String(opts.title || 'Planner').slice(0, 200),
    body: String(opts.body || '').slice(0, 1800),
    group,
    level,
  };
  if (opts.url) body.url = opts.url;
  if (sound) body.sound = sound;
  if (opts.icon || icon) body.icon = opts.icon || icon;
  if (opts.subtitle) body.subtitle = String(opts.subtitle).slice(0, 200);

  const res = await requestJson(`${base}/push`, { method: 'POST', body });
  if (res.ok && res.data && Number(res.data.code) === 200) return { ok: true, key, server: base };
  const msg = res.error || (res.data && (res.data.message || res.data.msg)) || res.text || `HTTP ${res.status}`;
  return { ok: false, error: String(msg), server: base };
}
