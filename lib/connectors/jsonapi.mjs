// 通用 JSON API 连接器（通用数据源适配器 ③·收官件）。
//
// 用途：任何返回 JSON 的公开接口 —— 填四样东西就能接：
//   ① 接口地址  ② 取哪一段（data.items 之类，可留空让它自己猜）
//   ③ 字段映射（标题 ← name / 截止 ← deadline …，留空按常见名字猜）
//   ④ 类型（当日程 / 当任务 / 当提醒）
import { mapResponse } from '../jsonmap.mjs';
import { jsonSample } from './samples.mjs';

export const meta = {
  id: 'jsonapi',
  name: '通用 JSON 接口',
  icon: '🔌',
  description: '任何返回 JSON 的接口都能接：填地址 + 字段映射（标题/时间/链接），留空会自动按常见字段名猜。',
  fields: [
    { key: 'url', label: '接口地址', type: 'text', required: true, placeholder: 'https://api.example.com/items' },
    { key: 'label', label: '给这个源的短名字（可选）', type: 'text', required: false, placeholder: '如：教务系统' },
    { key: 'method', label: '请求方式（GET / POST，默认 GET）', type: 'text', required: false, placeholder: 'GET' },
    { key: 'token', label: '访问令牌（可选，会作为 Authorization: Bearer 发出）', type: 'password', required: false, placeholder: '粘贴 Token' },
    { key: 'headers', label: '额外请求头（JSON，可留空）', type: 'text', required: false, placeholder: '{"X-Api-Version":"2"}' },
    { key: 'body', label: 'POST 请求体（JSON，可留空）', type: 'text', required: false, placeholder: '{"page":1}' },
    { key: 'list_path', label: '取哪一段（可留空自动猜）', type: 'text', required: false, placeholder: 'data.items' },
    { key: 'map_title', label: '标题字段（可留空自动猜）', type: 'text', required: false, placeholder: 'name' },
    { key: 'map_due', label: '截止/到期字段', type: 'text', required: false, placeholder: 'deadline' },
    { key: 'map_start', label: '开始时间字段', type: 'text', required: false, placeholder: 'start_time' },
    { key: 'map_end', label: '结束时间字段', type: 'text', required: false, placeholder: 'end_time' },
    { key: 'map_url', label: '原文链接字段', type: 'text', required: false, placeholder: 'link' },
    { key: 'map_id', label: '唯一 ID 字段（用于去重）', type: 'text', required: false, placeholder: 'id' },
    { key: 'map_body', label: '正文/备注字段', type: 'text', required: false, placeholder: 'description' },
    { key: 'kind', label: '当成什么：event 日程 / task 任务 / reminder 提醒（默认 task）', type: 'text', required: false, placeholder: 'task' },
    { key: 'max_results', label: '每次最多收几条（默认 100）', type: 'text', required: false, placeholder: '100' },
  ],
};

function parseJsonField(value, what) {
  const s = String(value || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { throw new Error(`${what} 不是合法的 JSON：${s.slice(0, 60)}`); }
}

async function requestJson(url, { method = 'GET', headers = {}, body = null }, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': 'Cairn/0.1 (+local planner)', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 120)}`);
    try { return JSON.parse(text); } catch { throw new Error(`返回的不是 JSON：${text.slice(0, 80)}`); }
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('aborted（等满 30 秒还没响应）');
    const code = e?.cause?.code || e?.code || '';
    if (code) throw new Error(`${code}: 无法连接 ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAll(config = {}) {
  const url = String(config.url || '').trim();
  if (!url) throw new Error('缺少接口地址');
  if (!/^https?:\/\//i.test(url)) throw new Error('接口地址要以 http:// 或 https:// 开头');

  const method = /^post$/i.test(String(config.method || 'GET').trim()) ? 'POST' : 'GET';
  const extraHeaders = parseJsonField(config.headers, '额外请求头') || {};
  const body = parseJsonField(config.body, 'POST 请求体');
  const headers = { ...extraHeaders };
  if (config.token) headers.Authorization = `Bearer ${String(config.token).trim()}`;
  if (body) headers['Content-Type'] = 'application/json';

  const json = await requestJson(url, { method, headers, body });
  const kind = ['event', 'task', 'reminder'].includes(String(config.kind || '').trim())
    ? String(config.kind).trim() : 'task';
  const result = mapResponse(json, {
    listPath: String(config.list_path || '').trim(),
    mapping: {
      title: config.map_title, due: config.map_due, start: config.map_start, end: config.map_end,
      url: config.map_url, id: config.map_id, body: config.map_body,
    },
    source: 'jsonapi',
    kind,
    label: String(config.label || '').trim(),
    maxResults: Number(config.max_results) || 100,
  });
  if (!result.items.length) {
    const looksLikeArray = Array.isArray(json) || JSON.stringify(json).includes('[');
    throw new Error(looksLikeArray
      ? '接口拿到了数据，但没映射出条目。请确认「标题字段」对不对（可以留空让它自动猜）。'
      : '这个接口没有返回条目数组。可以试着在「取哪一段」里填 json 路径（例如 data.items）。');
  }
  return { items: result.items, raw: { total: result.total, kept: result.kept, url } };
}

/** 离线示例。 */
export function fromSample() {
  const json = JSON.parse(jsonSample());
  const result = mapResponse(json, { listPath: 'data.list', kind: 'task', label: '示例接口' });
  return { items: result.items, raw: { total: result.total, kept: result.kept, demo: true } };
}
