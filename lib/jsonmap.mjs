// 通用 JSON API 的「取数 + 字段映射」引擎（适配器③）。
//
// 目标：让"接一个 JSON 接口"变成**填一张表**，而不是写代码。
//   取哪一段：list_path，例如 `data.items` / `results` / 留空=整个响应
//   字段映射：map_title ← name / map_due ← deadline / map_url ← link …
//
// 全是纯函数：不联网、不碰文件，方便测试与复用（本地文件导入也用它）。

/** 按点路径取值：`data.items.0.title` 也支持（数组下标）。 */
export function getByPath(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const part of String(path).split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) { cur = cur[Number(part)]; continue; }
    cur = cur[part];
  }
  return cur;
}

/** 依次尝试多个路径，返回第一个有值的（用于"这个字段可能叫 name 也可能叫 title"）。 */
export function pickFirst(obj, paths = []) {
  for (const p of paths) {
    const v = getByPath(obj, p);
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

const COMMON_LIST_KEYS = ['data', 'items', 'results', 'list', 'entries', 'records', 'rows', 'content'];

/**
 * 从响应里取出"条目数组"。
 * list_path 为空时：根就是数组就用根；否则在常见键里找一个数组。
 */
export function extractList(json, listPath = '') {
  if (json === null || json === undefined) return [];
  if (listPath) {
    const v = getByPath(json, listPath);
    return Array.isArray(v) ? v : [];
  }
  if (Array.isArray(json)) return json;
  if (typeof json === 'object') {
    for (const key of COMMON_LIST_KEYS) {
      if (Array.isArray(json[key])) return json[key];
    }
    // 再往下一层找：像 { code, data: { list: [...] } } 这种"包一层"的接口非常常见
    for (const key of COMMON_LIST_KEYS) {
      const inner = json[key];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        for (const innerKey of COMMON_LIST_KEYS) {
          if (Array.isArray(inner[innerKey])) return inner[innerKey];
        }
      }
    }
    // 再退一步：只有一个数组字段时就用它
    const arrays = Object.values(json).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
  }
  return [];
}

/** 时间归一化：秒级时间戳 / 毫秒时间戳 / ISO / 纯日期 都要认。 */
export function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;         // 秒 → 毫秒
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;              // 纯日期原样保留（平台规则：当天 23:59）
  if (/^\d{10}$/.test(s)) return normalizeTime(Number(s));
  if (/^\d{13}$/.test(s)) return normalizeTime(Number(s));
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;                        // 认不出就原样留着，别丢信息
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 常见字段名的猜测表（当用户没填映射时用）。 */
export const FIELD_GUESSES = {
  title: ['title', 'name', 'subject', 'summary', 'headline', 'display_name'],
  due: ['due_at', 'due', 'deadline', 'dueDate', 'due_date', 'end_time', 'endTime'],
  start: ['start_at', 'start', 'start_time', 'startTime', 'begin', 'date'],
  end: ['end_at', 'end', 'end_time', 'endTime', 'finish'],
  url: ['url', 'link', 'permalink', 'html_url', 'web_url', 'href'],
  id: ['id', 'uuid', 'guid', 'key', 'external_id'],
  body: ['notes', 'body', 'description', 'content', 'text', 'detail', 'summary_text'],
};

/** 把一条记录映射成平台条目。mapping 里没给的字段会走猜测表。 */
export function mapRecordToItem(record, mapping = {}, { source = 'jsonapi', kind = 'task', label = '' } = {}) {
  const asPaths = (v, guesses) => {
    if (typeof v === 'string' && v.trim()) return v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    return guesses;
  };
  const title = pickFirst(record, asPaths(mapping.title, FIELD_GUESSES.title));
  if (title === undefined) return null;                     // 连标题都没有的条目没法用
  const body = pickFirst(record, asPaths(mapping.body, FIELD_GUESSES.body));
  const startRaw = pickFirst(record, asPaths(mapping.start, FIELD_GUESSES.start));
  const endRaw = pickFirst(record, asPaths(mapping.end, FIELD_GUESSES.end));
  const dueRaw = pickFirst(record, asPaths(mapping.due, FIELD_GUESSES.due));
  const url = pickFirst(record, asPaths(mapping.url, FIELD_GUESSES.url));
  const id = pickFirst(record, asPaths(mapping.id, FIELD_GUESSES.id));

  const item = {
    kind,
    external_id: id !== undefined ? String(id) : null,
    title: label ? `${label}: ${String(title)}` : String(title),
    start_at: normalizeTime(startRaw),
    end_at: normalizeTime(endRaw),
    due_at: normalizeTime(dueRaw),
    url: url !== undefined ? String(url) : null,
    notes: body !== undefined ? String(body).slice(0, 800) : '',
    payload: { from: source },
  };
  if (item.kind === 'event' && !item.start_at) item.kind = 'reminder';   // 日程必须有开始时间
  if (item.kind === 'task' && !item.due_at && !item.start_at) item.kind = 'reminder';
  return item;
}

/** 整段响应的映射（入口函数）。 */
export function mapResponse(json, { listPath = '', mapping = {}, source = 'jsonapi', kind = 'task', label = '', maxResults = 100 } = {}) {
  const list = extractList(json, listPath);
  const items = [];
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    const item = mapRecordToItem(rec, mapping, { source, kind, label });
    if (item) items.push(item);
    if (items.length >= Math.max(1, maxResults)) break;
  }
  return { items, total: list.length, kept: items.length };
}
