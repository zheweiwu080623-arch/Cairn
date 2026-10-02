// processor.mjs —— 「再处理功能」的**纯函数**部分：把功能吐出来的东西规范成 action.v1。
//
// 为什么要这一层：再处理功能是别人写的模块（甚至可以来自"功能商店"），它们返回的东西
// 不能直接信。这里只做四件事，全是纯计算：
//   1) **补齐形状**：缺 schema / created_at / status 的，补上默认值；
//   2) **拒绝野值**：type 不认识、status 不认识 → 标成 failed 并写清原因（而不是悄悄发出去）；
//   3) **dry-run**：只要不是明确"真跑"，一切动作停在 `planned`；
//   4) **汇总**：给运行日志/界面用的一句话统计。
//
// 真正"执行"（发通知 / 推手机 / 写文件）在 routes/modules.mjs 里，用注入的执行能力完成 ——
// 这样纯逻辑可以离线测，执行能力可以单独审。

export const PROCESSOR_SCHEMA = 'action.v1';

/** 与 contracts/action.v1.schema.json 的枚举保持一致。 */
export const ACTION_TYPES = ['notify', 'push', 'task', 'event', 'mail', 'file', 'external', 'archive', 'report'];
export const ACTION_STATUS = ['planned', 'done', 'failed', 'skipped'];

/**
 * 已经有执行能力的类型（其它类型如实标"未执行"，不假装做了）。
 *   notify / push —— 本机通知 / 手机短句（server.mjs 里注入）
 *   file           —— 写文件，只允许写 `<数据目录>/study/`（见 lib/course-stack.mjs）
 *   task           —— 在本机建一条任务（2026-10-02 加：让"把邮件里的 DDL 变成任务"这类流程能真的落地）
 */
export const IMPLEMENTED_TYPES = ['notify', 'push', 'file', 'task'];

const str = (v) => (v === undefined || v === null ? null : String(v));

/**
 * 规范化单条动作。
 * @param {object} raw 功能返回的原始动作
 * @param {{moduleId?:string, dryRun?:boolean, now?:number}} opts
 */
export function normalizeAction(raw = {}, { moduleId = '', dryRun = true, now = Date.now() } = {}) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const problems = [];
  const type = ACTION_TYPES.includes(a.type) ? a.type : null;
  if (!type) problems.push(`不认识的 type：${String(a.type)}`);
  let status = ACTION_STATUS.includes(a.status) ? a.status : (type ? 'planned' : 'failed');
  if (dryRun && status !== 'failed') status = 'planned';       // 演练：一律停在"计划"这一步
  if (!type && status !== 'failed') status = 'failed';

  return {
    schema: PROCESSOR_SCHEMA,
    id: str(a.id) || `${moduleId}:${now}:${type || 'unknown'}`,
    signal_id: str(a.signal_id),
    created_at: str(a.created_at) || new Date(now).toISOString(),
    type: type || str(a.type) || 'unknown',
    status,
    dry_run: dryRun,
    summary: str(a.summary) || (type ? `${type} 动作` : '无法识别的动作'),
    target: a.target && typeof a.target === 'object' ? a.target : {},
    idempotency_key: str(a.idempotency_key),
    permissions: Array.isArray(a.permissions) ? a.permissions.map(String) : [],
    payload: a.payload && typeof a.payload === 'object' ? a.payload : {},
    result: a.result && typeof a.result === 'object' ? a.result : null,
    audit: {
      actor: `processor:${moduleId}`,
      at: new Date(now).toISOString(),
      duration_ms: Number.isFinite(Number(a.audit?.duration_ms)) ? Number(a.audit.duration_ms) : null,
    },
    replay_of: str(a.replay_of),
    problems,
  };
}

/** 规范化一批动作；非数组一律当成一条 `failed`。 */
export function normalizeActions(raw, { moduleId = '', dryRun = true, now = Date.now() } = {}) {
  const list = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && (raw.actions || raw.type) ? (raw.actions || [raw]) : []);
  return list.map((a) => normalizeAction(a, { moduleId, dryRun, now }));
}

/** 给日志/界面的一句话统计：`2 条动作（1 通知 / 1 推送）· 演练`。 */
export function summarizeActions(actions = [], { dryRun = true } = {}) {
  const by = {};
  for (const a of actions) by[a.type] = (by[a.type] || 0) + 1;
  const parts = Object.entries(by).map(([k, n]) => `${n} ${k}`);
  const head = `${actions.length} 条动作${parts.length ? `（${parts.join(' / ')}）` : ''}`;
  return dryRun ? `${head} · 演练（未执行）` : head;
}

/** 能不能真的执行这条动作？演练、未实现、缺幂等键都会给出"为什么不行"。 */
export function canExecute(action, { dryRun = true } = {}) {
  if (dryRun) return { ok: false, reason: 'dry-run：只规划不执行' };
  if (action.status === 'failed') return { ok: false, reason: '动作本身不合法' };
  // 三个执行能力之外的动作（例如 mail / task）**如实说"还没实现"**，不假装做了。
  if (!IMPLEMENTED_TYPES.includes(action.type)) return { ok: false, reason: `还没有能执行这类动作的能力（${action.type}），这类动作还没实现` };
  if (action.type === 'file' && !action.payload?.text) return { ok: false, reason: 'file 动作没有内容（payload.text）' };
  if (action.type === 'file' && !(action.target?.path || action.payload?.path)) return { ok: false, reason: 'file 动作没说写到哪个文件' };
  // 只认 payload.title：不让"自动补的默认摘要"变成一条垃圾任务
  if (action.type === 'task' && !action.payload?.title) return { ok: false, reason: 'task 动作没有标题（payload.title）' };
  return { ok: true, reason: '' };
}
