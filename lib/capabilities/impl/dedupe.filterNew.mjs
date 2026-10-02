// 能力模块：dedupe.filterNew —— 只留"没报过"的条目。
export const meta = {
  id: 'dedupe.filterNew',
  name: '只留"没报过"的条目',
  version: '1.0.0',
  kind: 'read',
  input: { type: 'object', properties: { items: { type: 'array' }, scope: { type: 'string' } }, required: ['items'] },
  output: { type: 'object', properties: { fresh: { type: 'array' } } },
  permissions: [],
  idempotent: true,
  cost: 'none',
  ui: { label: '报过的别报第二次', group: '去重', icon: '🧲' },
  model: { description: '当同一批信息可能被反复处理、你只想留下"还没报过"的那些时用它。' },
  used_by: ['preclass-check'],
  notes: '读同步表（sync_*），不写。同一批条目问两次，答案一样。',
};
export const bind = { from: 'preclass', ctx: ['dedupe.filterNew'] };
export async function run(input = {}, ctx) {
  return ctx.dedupe.filterNew(input.items || [], { scope: input.scope });
}
