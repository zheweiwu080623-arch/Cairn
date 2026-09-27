// 本地文件导入（适配器④）：把 CSV / JSON / ICS 文件读进来。
//
// 为什么需要它：别人从别的应用（Excel、Notion、Todoist、Google 日历）迁移过来时，
// 手里通常就是一个文件 —— 不该要求他们写脚本。
//
// 安全边界（诚实说明）：
//   * 只读**单个文件**、只认 .csv/.json/.ics，且**限制大小**（默认 5 MB）；
//   * 应用只监听 127.0.0.1，所以"读本机文件"这件事只有在这台电脑上的人能做；
//   * 不写、不改、不删任何文件。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import { icsEventToPlanner, icsEventsInWindow, parseIcs } from './ical.mjs';
import { mapRecordToItem, mapResponse } from './jsonmap.mjs';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_EXT = ['.csv', '.json', '.ics', '.ical'];

/** 按扩展名/内容猜格式。 */
export function detectFormat(path, content = '') {
  const ext = extname(String(path || '')).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  if (ext === '.ics' || ext === '.ical') return 'ics';
  const text = String(content).trim();
  if (text.startsWith('BEGIN:VCALENDAR')) return 'ics';
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  if (text.includes(',')) return 'csv';
  return 'unknown';
}

/**
 * 极简 CSV 解析：支持双引号包裹、引号内逗号/换行、双引号转义（""）、CRLF。
 * 返回 { headers, rows }（rows 是对象数组）。
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => String(h).trim());
  return {
    headers,
    rows: nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
  };
}

/** 中文表头也认：把"标题/截止/链接"这类中文列名映射到平台的英文字段。 */
export const CSV_HEADER_ALIASES = {
  title: ['标题', '任务', '名称', '事项', 'title', 'name', 'subject'],
  due: ['截止', '截止时间', '到期', 'ddl', 'due', 'deadline'],
  start: ['开始', '开始时间', 'start', 'begin'],
  end: ['结束', '结束时间', 'end', 'finish'],
  url: ['链接', '网址', 'url', 'link'],
  id: ['编号', 'id', '序号'],
  body: ['备注', '说明', '描述', 'notes', 'description', 'body'],
};

export function guessMappingFromHeaders(headers = []) {
  const mapping = {};
  for (const [field, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    const hit = headers.find((h) => aliases.includes(String(h).trim().toLowerCase()));
    if (hit) mapping[field] = hit;
  }
  return mapping;
}

/** 读一个文件并转成平台条目。 */
export function importLocalFile(path, { format = '', mapping = {}, kind = 'task', label = '', maxResults = 200 } = {}) {
  const p = String(path || '').trim();
  if (!p) throw new Error('缺少文件路径');
  if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
  const st = statSync(p);
  if (!st.isFile()) throw new Error('这个路径不是文件（如果是文件夹，请选里面的某个文件）');
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)} MB），上限 ${MAX_FILE_BYTES / 1048576} MB`);
  }
  const content = readFileSync(p, 'utf8');
  const fmt = String(format || '').trim().toLowerCase() || detectFormat(p, content);

  if (fmt === 'json') {
    let json = null;
    try { json = JSON.parse(content); } catch (e) { throw new Error(`不是合法的 JSON：${e.message}`); }
    const result = mapResponse(json, { listPath: mapping.list_path || '', mapping, source: 'localfile', kind, label, maxResults });
    if (!result.items.length) throw new Error('文件读到了，但没映射出条目（可以指定"标题字段"）');
    return { items: result.items, raw: { format: 'json', total: result.total, kept: result.kept, path: p } };
  }

  if (fmt === 'ics') {
    const parsed = parseIcs(content);
    if (!parsed.events.length) throw new Error('这个 .ics 里没有解析出日程');
    const now = Date.now();
    const picked = icsEventsInWindow(parsed, { fromMs: now - 365 * 86400000, toMs: now + 365 * 86400000, max: maxResults });
    return {
      items: picked.map((ev) => icsEventToPlanner(ev, { source: 'localfile' })),
      raw: { format: 'ics', calendar: parsed.calendarName, total: parsed.events.length, kept: picked.length, path: p },
    };
  }

  if (fmt === 'csv') {
    const { headers, rows } = parseCsv(content);
    if (!headers.length) throw new Error('这个 CSV 看起来是空的');
    const auto = guessMappingFromHeaders(headers);
    const useMapping = Object.keys(mapping).length ? mapping : auto;
    const items = [];
    for (const row of rows) {
      const item = mapRecordToItem(row, useMapping, { source: 'localfile', kind, label });
      if (item) items.push(item);
      if (items.length >= Math.max(1, maxResults)) break;
    }
    if (!items.length) {
      throw new Error(`CSV 里没映射出条目。认到的列是：${headers.join(' / ')}；请指定"标题字段"。`);
    }
    return { items, raw: { format: 'csv', headers, total: rows.length, kept: items.length, path: p } };
  }

  throw new Error('认不出文件格式（支持 .csv / .json / .ics）');
}
