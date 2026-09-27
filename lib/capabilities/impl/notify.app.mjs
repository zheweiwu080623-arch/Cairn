// 能力模块：notify.app —— 发一条本机通知（写类：产出 action，交给执行器去动手）。
export const meta = {
  id: 'notify.app',
  name: '发一条本机通知',
  version: '1.0.0',
  kind: 'write',
  input: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, url: { type: ['string', 'null'] } }, required: ['title'] },
  output: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } },
  permissions: ['notify:app'],
  idempotent: false,
  cost: 'none',
  ui: { label: '发本机通知', group: '投递', icon: '🔔' },
  used_by: ['preclass-check', 'course-assist', 'hello-processor'],
  notes: '写进通知表，source 记成 processor:<功能 id>。发两次就是两条 —— 非幂等，图执行里不能盲目重放。',
};
export const bind = { from: 'executors', executor: 'notify' };
export async function run(input = {}) {
  return { actions: [{
    type: 'notify',
    summary: input.title || meta.name,
    idempotency_key: `notify.app:${input.idempotency_key || input.title || ''}`,
    payload: { text: input.text || '' },
    target: { url: input.url || null },
    permissions: meta.permissions,
  }] };
}
