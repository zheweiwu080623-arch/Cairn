// 能力模块：dedupe.markSeen —— 记下"报过了"（免得重复打扰）。
export const meta = {
  id: 'dedupe.markSeen',
  name: '记下"报过了"（免得重复打扰）',
  version: '1.0.0',
  kind: 'write',
  input: { type: 'object', properties: { items: { type: 'array' }, scope: { type: 'string' } }, required: ['items'] },
  output: { type: 'object', properties: { ok: { type: 'boolean' } } },
  permissions: ['fs:write:data'],
  idempotent: true,
  cost: 'none',
  ui: { label: '记一下报过了', group: '去重', icon: '🧷' },
  used_by: ['preclass-check'],
  notes: '每门课最多留 500 条指纹（自动收口）；同一条记两次结果一样 ⇒ 幂等。',
};
export const bind = { from: 'preclass', ctx: ['dedupe.markSeen'] };
export async function run(input = {}, ctx) {
  return ctx.dedupe.markSeen(input.items || [], { scope: input.scope });
}
