// 能力模块：text.extract —— 用正则从文字里捞出东西（纯计算）。
//
// 典型用法：邮件正文 / 网页里那一小段有用的信息（日期、课号、金额），
// 一条正则捞出来，再交给 text.template 拼成通知。
export const meta = {
  id: 'text.extract',
  name: '用正则捞内容',
  version: '1.0.0',
  kind: 'compute',
  input: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      pattern: { type: 'string' },
      flags: { type: 'string' },
      group: { type: 'number' },
      all: { type: 'boolean' },
    },
    required: ['text', 'pattern'],
  },
  output: { type: 'object', properties: { first: { type: ['string', 'null'] }, matches: { type: 'array' }, count: { type: 'number' } } },
  permissions: [],
  idempotent: true,
  cost: 'none',
  ui: { label: '正则捞内容', group: '通用', icon: '🔎' },
  model: { description: '当要从一段自由文本（邮件正文、网页）里捞出特定内容——日期、课号、金额——时用它。' },
  notes: 'group 是要第几个括号（默认 0 = 整段匹配）。all=true 时把所有匹配都收进 matches。',
};

export const bind = { from: 'none' };

export async function run(input = {}) {
  const text = String(input.text == null ? '' : input.text);
  const pattern = String(input.pattern || '');
  if (!pattern) return { first: null, matches: [], count: 0, error: '没有 pattern' };
  const flags = String(input.flags || 'g').replace(/[^gimsuy]/g, '') || 'g';
  const g = Number.isFinite(Number(input.group)) ? Number(input.group) : 0;
  let re;
  try { re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g'); }
  catch (e) { return { first: null, matches: [], count: 0, error: `pattern 不是合法正则：${(e && e.message) || e}` }; }
  const matches = [];
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    matches.push(m[g] === undefined ? null : m[g]);
    if (!re.global) break;
    if (m.index === re.lastIndex) re.lastIndex += 1;      // 零宽匹配防死循环
    if ((guard += 1) > 5000) break;
  }
  const out = input.all === false ? matches.slice(0, 1) : matches;
  return { first: out.length ? out[0] : null, matches: out, count: out.length };
}
