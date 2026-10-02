// 能力模块：llm.ask —— 把一段文字交给**用户自己配置的模型**（compute 类：产出文本）。
//
// 为什么要有它：Cairn 是"个人信息环境"，模型是它接的**外部智能能力**之一。
// 图上能有一格"问模型"，才谈得上"哪些事交给模型、哪些交给确定性程序"这件事可测（RQ-B）。
//
// 四条边界：
//   * **花的是用户自己的 token**：`cost: tokens` 会显示在素材栏与权限清单里；
//   * **不猜模型是谁**：走 `ctx.llm.ask` —— 主程序按"数据源 → Agent 接入"里的配置决定走 CLI 还是 HTTP；
//   * **失败不抛**：返回 `{ ok:false, error }`，让图自己用 `when` 决定"模型不可用怎么办"；
//   * **不写任何东西**：只回文本，要落盘/发通知交给后面的节点（那些是写类，只给计划）。
export const meta = {
  id: 'llm.ask',
  name: '问一次模型',
  version: '1.0.0',
  kind: 'compute',
  input: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要问什么（可以把上游的产出拼进来）' },
      system: { type: 'string', description: '可选的系统提示（例如"只输出一句话"）' },
      timeout_ms: { type: 'number', description: '超时，默认按主程序配置' },
    },
    required: ['prompt'],
  },
  output: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, via: { type: 'string' } } },
  permissions: ['llm:ask'],
  idempotent: false,
  cost: 'tokens',
  ui: { label: '问一次模型', group: '通用', icon: '🧠' },
  model: {
    description: '当需要**理解或生成一段自然语言**（摘要、改写、判断这条消息要不要紧、把要点写成一句话）时用它。'
      + '会花用户自己的 token，别拿它做程序能做的事（算日期、比大小、取字段）。',
  },
  notes: '花用户的 token；模型由用户自己在「数据源 → Agent 接入」里配置。只回文本，不写任何东西；失败如实返回 ok:false。',
};

export const bind = { from: 'llm', ctx: ['llm.ask'] };

export async function run(input = {}, ctx = {}) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { ok: false, error: '没有要问的内容（prompt）' };
  if (!ctx || !ctx.llm || typeof ctx.llm.ask !== 'function') {
    return { ok: false, error: '这台服务器没有接模型（ctx.llm.ask 取不到）—— 到「数据源 → Agent 接入」里配一个' };
  }
  const r = await ctx.llm.ask({ prompt: prompt.slice(0, 12000), system: input.system || '', timeout_ms: input.timeout_ms });
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || '模型没有回话' };
  return { ok: true, text: String(r.text || ''), via: r.via || '' };
}
