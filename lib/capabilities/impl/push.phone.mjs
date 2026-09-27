// 能力模块：push.phone —— 推一条手机短句（对外发送，非幂等）。
export const meta = {
  id: 'push.phone',
  name: '推一条手机短句',
  version: '1.0.0',
  kind: 'outbound',
  input: { type: 'object', properties: { title: { type: 'string' }, push: { type: 'string' }, url: { type: ['string', 'null'] } }, required: ['push'] },
  output: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } },
  permissions: ['notify:phone'],
  idempotent: false,
  cost: 'none',
  ui: { label: '推手机', group: '投递', icon: '📱' },
  used_by: ['preclass-check'],
  notes: '走既有 Bark 通道，受来源过滤约束。非幂等：推两次就是两条。手机只发短句（≤60 字）。',
};
export const bind = { from: 'executors', executor: 'push' };
export async function run(input = {}) {
  return { actions: [{
    type: 'push',
    summary: input.title || meta.name,
    idempotency_key: `push.phone:${input.idempotency_key || input.push || ''}`,
    payload: { push: String(input.push || '').slice(0, 60) },
    target: { url: input.url || null },
    permissions: meta.permissions,
  }] };
}
