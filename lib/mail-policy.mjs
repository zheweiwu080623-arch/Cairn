// mail-policy.mjs —— 「哪些邮件还允许发」的闸门（2026-10-01 按用户口径新增）
//
// 用户 2026-10-01 的原话：「发信确实需要降载，一天早上汇总一封，每一次 cairn 进行 canvas 检查出
// 有新增的时候再来一封就够了」。
//
// 背景：中转邮箱（163）两天里被服务商风控两次，根子是自动发信量偏大 ——
// 两周真发 47 封、附件 274 个（09-21 一天 128 个附件）。降载以后**只留两类外发邮件**：
//
//   morning  早上汇总：一天最多 1 封（默认只在 05:00–11:59 之间发）
//   canvas   Canvas 有新增：**必须有新增才发**，一天最多 canvas_per_day 封（默认 8）
//
// 其它一切（晚报、自动化简报的转发、课程材料的兜底提醒…）**不再单独发邮件** ——
// 它们照旧进应用内的「通知」页；需要上办公本看的内容，由早上那封汇总带上标题索引。
// 唯一不受策略管的是**手动发送**（界面上点"发到办公本"、`POST /api/send/file`）——
// 那是人明确的动作，不该被自动策略拦。
//
// 账本存在 sync_state 的一个键里（`mail_policy_ledger`），跨重启有效，按本地日期自动翻篇。

export const MAIL_POLICY_KEY = 'mail_policy_ledger';

/** 各类邮件的默认配额（可以在设置里覆盖；`perDay: 0` = 默认不发）。 */
export const MAIL_KINDS = {
  morning: { label: '早上汇总', perDay: 1, windowFrom: 5, windowTo: 12, needsNew: false },
  canvas: { label: 'Canvas 有新增', perDay: 8, needsNew: true },
  evening: { label: '晚报', perDay: 0 },
  report: { label: '自动化简报', perDay: 0 },
  manual: { label: '手动发送', perDay: Number.POSITIVE_INFINITY },
};

const pad = (n) => String(n).padStart(2, '0');
export const localDateKey = (when = new Date()) =>
  `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;

/** 读账本（跨天自动清空）。 */
export function readLedger(store, when = new Date()) {
  const today = localDateKey(when);
  let raw = {};
  try { raw = JSON.parse(store.getSync(MAIL_POLICY_KEY) || '{}') || {}; } catch { raw = {}; }
  if (raw.date !== today) return { date: today, counts: {}, last: {} };
  return { date: today, counts: raw.counts || {}, last: raw.last || {} };
}

function writeLedger(store, ledger) {
  try { store.setSync(MAIL_POLICY_KEY, JSON.stringify({ ...ledger, updated_at: Date.now() })); } catch { /* 存不下也不拦发信 */ }
}

/** 覆盖默认配额（都从 kv 读，缺省用上面的默认值）。 */
export function policyLimits(store) {
  const out = {};
  for (const [kind, spec] of Object.entries(MAIL_KINDS)) out[kind] = { ...spec };
  try {
    const raw = JSON.parse(store.getSync('mail_policy') || '{}') || {};
    for (const [kind, patch] of Object.entries(raw || {})) {
      if (!out[kind] || !patch || typeof patch !== 'object') continue;
      if (patch.per_day !== undefined) out[kind].perDay = Math.max(0, Number(patch.per_day) || 0);
      if (patch.window_from !== undefined) out[kind].windowFrom = Number(patch.window_from);
      if (patch.window_to !== undefined) out[kind].windowTo = Number(patch.window_to);
    }
  } catch { /* 配置坏了就用默认 */ }
  return out;
}

/**
 * 现在允许发这一类邮件吗？
 * @param {string} kind morning / canvas / evening / report / manual
 * @param {{store:object, now?:Date, hasNew?:boolean}} opts
 *        `hasNew` 只有 canvas 用得上：这一轮**确实有新东西**才允许发（用户原话"有新增的时候"）。
 * @returns {{allow:boolean, reason:string, label:string, todayCount:number, limit:number}}
 */
export function decideMail(kind, { store, now = new Date(), hasNew = false } = {}) {
  const limits = policyLimits(store);
  const spec = limits[kind];
  const ledger = readLedger(store, now);
  const todayCount = Number(ledger.counts[kind] || 0);
  if (!spec) {
    return { allow: false, reason: `不认识的邮件类别：${kind}`, label: kind, todayCount, limit: 0 };
  }
  const allow = (reason) => ({ allow: true, reason, label: spec.label, todayCount, limit: spec.perDay });
  const deny = (reason) => ({ allow: false, reason, label: spec.label, todayCount, limit: spec.perDay });

  if (spec.needsNew && !hasNew) return deny('这一轮没有新增（按发信策略：Canvas 有新增才发）');
  if (spec.perDay === 0) return deny('按发信策略：这类邮件不再单独发（内容照旧在应用「通知」里）');
  if (Number.isFinite(spec.perDay) && todayCount >= spec.perDay) {
    return deny(`今天这类已经发了 ${todayCount} 封（上限 ${spec.perDay}）`);
  }
  if (spec.windowFrom !== undefined && spec.windowTo !== undefined) {
    const hour = now.getHours();
    if (hour < spec.windowFrom || hour >= spec.windowTo) {
      return deny(`不在发送时段内（${spec.windowFrom}:00–${spec.windowTo}:00，现在是 ${hour}:00）`);
    }
  }
  return allow(`今天第 ${todayCount + 1} 封（上限 ${Number.isFinite(spec.perDay) ? spec.perDay : '不限'}）`);
}

/** 记一笔"发出去了"（发信成功之后调用；失败不要记，否则配额会被白白吃掉）。 */
export function noteMailSent(kind, { store, now = new Date(), ref = '' } = {}) {
  const ledger = readLedger(store, now);
  ledger.counts[kind] = Number(ledger.counts[kind] || 0) + 1;
  if (ref) ledger.last[kind] = String(ref).slice(0, 120);
  writeLedger(store, ledger);
  return { date: ledger.date, counts: ledger.counts };
}

/** 给接口/界面看的一份状态：规则 + 今天已经发了几封。 */
export function mailPolicyState(store, now = new Date()) {
  const limits = policyLimits(store);
  const ledger = readLedger(store, now);
  const kinds = {};
  for (const [kind, spec] of Object.entries(limits)) {
    const used = Number(ledger.counts[kind] || 0);
    kinds[kind] = {
      label: spec.label, per_day: Number.isFinite(spec.perDay) ? spec.perDay : null,
      used, remaining: Number.isFinite(spec.perDay) ? Math.max(0, spec.perDay - used) : null,
      window: spec.windowFrom !== undefined ? [spec.windowFrom, spec.windowTo] : null,
    };
  }
  return { schema: 'mail-policy.v1', date: ledger.date, kinds };
}
