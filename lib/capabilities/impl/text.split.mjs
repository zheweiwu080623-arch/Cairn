// 能力模块：text.split —— 把一段文字切成很多条（纯计算）。
//
// 用在"把邮件正文切成分行""把一句话按逗号拆开"这类地方：切完是个数组，
// 可以直接喂给 logic.each 逐条处理。
export const meta = {
  id: 'text.split',
  name: '把文字切开',
  version: '1.0.0',
  kind: 'compute',
  input: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      by: { type: 'string' },
      regex: { type: 'boolean' },
      limit: { type: 'number' },
      trim: { type: 'boolean' },
      drop_empty: { type: 'boolean' },
    },
    required: ['text'],
  },
  output: { type: 'object', properties: { items: { type: 'array' }, count: { type: 'number' } } },
  permissions: [],
  idempotent: true,
  cost: 'none',
  ui: { label: '切分文字', group: '通用', icon: '✂️' },
  model: { description: '当一段文字需要先切成多行/多段、再逐条处理时用它（配合"逐条处理"）。' },
  notes: 'by 默认按换行切；regex=true 时 by 当成正则（例如 `\\n{2,}`）。默认去空白、丢空行。',
};

export const bind = { from: 'none' };

export async function run(input = {}) {
  const text = String(input.text == null ? '' : input.text);
  const by = input.by === undefined ? '\n' : String(input.by);
  const regex = input.regex === true;
  const trim = input.trim !== false;
  const dropEmpty = input.drop_empty !== false;
  const limit = Number.isFinite(Number(input.limit)) && Number(input.limit) > 0 ? Number(input.limit) : 0;
  let parts;
  if (regex) {
    try { parts = text.split(new RegExp(by)); }
    catch (e) { return { items: [], count: 0, error: `by 不是合法正则：${(e && e.message) || e}` }; }
  } else {
    parts = text.split(by);
  }
  let items = parts.map((s) => (trim ? String(s).trim() : String(s)));
  if (dropEmpty) items = items.filter((s) => s !== '');
  if (limit) items = items.slice(0, limit);
  return { items, count: items.length };
}
