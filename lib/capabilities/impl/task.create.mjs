// 能力模块：task.create —— 在本机任务清单里加一条任务（写类：产出 action，交给执行器动手）。
//
// 为什么值得单列一条：这是"把信息变成行动"最常见的一步 ——
// 邮件里的 DDL、公告里的报名截止、课上说的作业，最后都该落到任务清单里。
//
// 三条边界：
//   * **只建一条、只建不改**：不改已有任务、不删任务、不替你勾完成（那要你自己点）；
//   * **幂等靠 external_id**：同一个 idempotency_key 再来一次不会建第二条（重跑/重试安全）；
//   * **默认演练**：走的还是 action 那套 —— 不传 dry_run:false 时只会"计划"，不会真的进清单。
export const meta = {
  id: 'task.create',
  name: '在本机建一条任务',
  version: '1.0.0',
  kind: 'write',
  input: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题（必填）' },
      notes: { type: 'string', description: '备注（可以写清楚它从哪来）' },
      due_at: { type: ['string', 'null'], description: '截止时间（ISO 字符串，可空）' },
      priority: { type: 'number', description: '1 最急 / 2 普通 / 3 不急，默认 2' },
      tags: { type: 'string' },
      idempotency_key: { type: 'string', description: '稳定指纹（例如"课号+作业号"），用来防重复建' },
    },
    required: ['title'],
  },
  output: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } },
  permissions: ['data:write:tasks'],
  idempotent: true,
  cost: 'none',
  ui: { label: '建一条任务', group: '通用', icon: '📝' },
  model: {
    description: '当用户提到一个"以后要做的事"（截止日期、要交的东西、要约的时间）时用它，把它变成任务清单里的一条。'
      + '只加一条、不要重复加（给 idempotency_key）；**不改也不删**用户已有的任务。',
  },
  notes: '写类：默认只产出 action（演练），真跑才进任务清单。只建不改、不删、不替用户勾完成。',
};

export const bind = { from: 'executors', executor: 'task' };

export async function run(input = {}) {
  const title = String(input.title || '').trim();
  if (!title) return { ok: false, error: '要建的任务得有个标题（title）' };
  return {
    actions: [{
      type: 'task',
      summary: title.slice(0, 60),
      idempotency_key: input.idempotency_key ? `task.create:${input.idempotency_key}` : `task.create:${title.slice(0, 40)}`,
      target: { kind: 'task', due_at: input.due_at || null },
      payload: {
        title,
        notes: input.notes || '',
        priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 2,
        tags: input.tags || '',
      },
      permissions: meta.permissions,
    }],
  };
}
