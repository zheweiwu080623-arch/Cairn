// 能力模块：text.template —— 往一段文字模板里填值（纯计算）。
//
// 模板里写 `{{a.b}}`，值从 data 里按同一套路径规则取；取不到就填空字符串
// （不填 "undefined"，也不报错 —— 一句话里缺一个字段不该让整张图崩）。
export const meta = {
  id: 'text.template',
  name: '套一段文字模板',
  version: '1.0.0',
  kind: 'compute',
  input: {
    type: 'object',
    properties: { template: { type: 'string' }, data: {}, fallback: { type: 'string' } },
    required: ['template'],
  },
  output: { type: 'object', properties: { text: { type: 'string' }, missing: { type: 'array' } } },
  permissions: [],
  idempotent: true,
  cost: 'none',
  ui: { label: '套文字模板', group: '通用', icon: '✏️' },
  model: { description: '当要把几个字段拼成一段给人看的话（通知正文、周报、邮件）时用它。' },
  used_by: ['web-fetch-flow'],
  notes: '`{{路径}}` 会被换掉；路径取不到时用 fallback（默认空串），并把名字列进 missing 里。',
};

export const bind = { from: 'none' };

const lookup = (data, path) => {
  let cur = data;
  for (const seg of String(path).trim().split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
};

export async function run(input = {}) {
  const tpl = String(input.template == null ? '' : input.template);
  const data = input.data;
  const fallback = input.fallback === undefined ? '' : String(input.fallback);
  const missing = [];
  const text = tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key) => {
    const v = data == null ? undefined : lookup(data, key);
    if (v === undefined || v === null) { if (!missing.includes(key)) missing.push(key); return fallback; }
    if (typeof v === 'string') return v;
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return fallback; } }
    return String(v);
  });
  return { text, missing };
}
