// 能力模块：prefs.read —— 读这个功能自己的设置。
export const meta = {
  id: 'prefs.read',
  name: '读这个功能自己的设置',
  version: '1.0.0',
  kind: 'read',
  input: { type: 'object', properties: {} },
  output: { type: 'object', properties: { bark: { type: 'boolean' }, minutes_before: { type: 'number' } } },
  permissions: [],
  idempotent: true,
  cost: 'none',
  ui: { label: '读功能设置', group: '设置', icon: '⚙️' },
  used_by: ['preclass-check'],
  notes: '没存过 / JSON 坏了 / 字段越界，都回落到默认值，不抛异常（设置坏了不该让功能停摆）。',
};
export const bind = { from: 'preclass', ctx: ['prefs'] };
export async function run(_input, ctx) {
  return ctx.prefs();
}
