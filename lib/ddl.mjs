// ddl.mjs —— 截止时间的「倒计时 + 多级提醒」（纯函数）。
//
// 用户原话："ddl 的时候提醒和倒计时其实也可以加上……不然有可能就真的忘了。"
//
// 和已有东西的分工：
//   * 任务本身（due_at）早就在库里；`lib/duedate.mjs` 管"纯日期算当天 23:59"；
//   * 这里管两件事：**倒计时怎么说人话**、**提前几档提醒**（7 天 / 3 天 / 1 天 / 3 小时 / 30 分钟）。
//
// 纯函数：不碰数据库、不发通知、不看时钟以外的东西 —— 方便测试，也方便换界面。

export const DDL_SCHEMA = 'ddl.v1';

/** 默认提醒档位（毫秒）：提前 7 天 / 3 天 / 1 天 / 3 小时 / 30 分钟。 */
export const DDL_DEFAULT_STEPS = [
  7 * 86400000, 3 * 86400000, 86400000, 3 * 3600000, 30 * 60000,
];

/**
 * 「最后一档」的门槛（2026-09-27）：**免打扰的例外**用它判断哪条 DDL 提醒算重要 ——
 * 剩 30 分钟以内（含用户自己加的更小档）以及「已逾期」的，安静时段里也照响。
 */
export const DDL_FINAL_STEP_MS = 30 * 60000;

export const DDL_STEP_LABEL = {
  [7 * 86400000]: '还剩 7 天',
  [3 * 86400000]: '还剩 3 天',
  [86400000]: '还剩 1 天',
  [3 * 3600000]: '还剩 3 小时',
  [30 * 60000]: '还剩 30 分钟',
};

/** 一档提醒的短标签：优先用表，认不出来就按大小写一个。 */
export function stepLabel(step) {
  const ms = Number(step);
  if (DDL_STEP_LABEL[ms]) return DDL_STEP_LABEL[ms];
  if (!Number.isFinite(ms) || ms <= 0) return '提醒';
  if (ms >= 86400000) return `还剩 ${Math.round(ms / 86400000)} 天`;
  if (ms >= 3600000) return `还剩 ${Math.round(ms / 3600000)} 小时`;
  return `还剩 ${Math.round(ms / 60000)} 分钟`;
}

/** 设置清洗：开关 + 走不走手机 + 档位（去重、从大到小、限制 1~8 档）。 */
export function normalizeDdlPrefs(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rawSteps = Array.isArray(r.steps) ? r.steps : DDL_DEFAULT_STEPS;
  const steps = [...new Set(rawSteps
    .map((x) => Math.round(Number(x)))
    .filter((x) => Number.isFinite(x) && x >= 60000 && x <= 60 * 86400000))]
    .sort((a, b) => b - a)
    .slice(0, 8);
  return {
    schema: DDL_SCHEMA,
    enabled: r.enabled === undefined ? true : r.enabled === true || r.enabled === '1' || r.enabled === 1,
    bark: r.bark === true || r.bark === '1' || r.bark === 1,
    steps: steps.length ? steps : [...DDL_DEFAULT_STEPS],
    updated_at: Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : 0,
  };
}

/** 倒计时的人话说法：还有 X / 今天截止 / 已逾期 X。没有截止时间就给空串。 */
export function countdownText(dueAt, now = Date.now()) {
  const t = Date.parse(String(dueAt || ''));
  if (!Number.isFinite(t)) return '';
  const diff = t - now;
  if (diff <= 0) {
    const late = -diff;
    if (late < 3600000) return `已逾期 ${Math.max(1, Math.round(late / 60000))} 分钟`;
    if (late < 86400000) return `已逾期 ${Math.round(late / 3600000)} 小时`;
    return `已逾期 ${Math.round(late / 86400000)} 天`;
  }
  if (diff < 60 * 60000) return `还有 ${Math.max(1, Math.round(diff / 60000))} 分钟`;
  if (diff < 3600000) return `还有 ${Math.round(diff / 60000)} 分钟`;
  if (diff < 86400000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.round((diff % 3600000) / 60000);
    return m ? `还有 ${h} 小时 ${m} 分钟` : `还有 ${h} 小时`;
  }
  const d = Math.floor(diff / 86400000);
  const h = Math.round((diff % 86400000) / 3600000);
  return h ? `还有 ${d} 天 ${h} 小时` : `还有 ${d} 天`;
}

/** 紧急度分档（界面配色 / 排序用）。 */
export function dueLevel(dueAt, now = Date.now()) {
  const t = Date.parse(String(dueAt || ''));
  if (!Number.isFinite(t)) return 'none';
  const diff = t - now;
  if (diff <= 0) return 'overdue';
  if (diff <= 3600000) return 'urgent';
  if (diff <= 86400000) return 'today';
  if (diff <= 3 * 86400000) return 'soon';
  if (diff <= 7 * 86400000) return 'week';
  return 'later';
}

/**
 * 这条任务接下来该在哪几个时间点提醒（只给**还没到**的档位）。
 * 返回从近到远排序，方便界面显示"下一次提醒"。
 */
export function planSteps(dueAt, now = Date.now(), steps = DDL_DEFAULT_STEPS) {
  const t = Date.parse(String(dueAt || ''));
  if (!Number.isFinite(t)) return [];
  return [...new Set((steps || []).map((s) => Math.round(Number(s))).filter((s) => Number.isFinite(s) && s > 0))]
    .sort((a, b) => a - b)
    .map((step) => ({ step, at: t - step, label: stepLabel(step) }))
    .filter((x) => x.at > now)
    .sort((a, b) => a.at - b.at);
}

/** 下一次提醒（没有就 null）。 */
export function nextStep(dueAt, now = Date.now(), steps = DDL_DEFAULT_STEPS) {
  return planSteps(dueAt, now, steps)[0] || null;
}

/**
 * 到点了没有？给服务端用：判断"这一档提醒是不是刚该发"。
 *
 * 规则：档位时间 `at` 落在 `(now - window, now]` 之间就算"刚该发"。
 * window 默认 15 分钟 —— 比心跳（4 秒）宽得多，所以电脑休眠/重启后也能补上一次，
 * 又不会把三天前那一档翻出来重发（那是 `seen` 的活）。
 */
export function stepsDueNow(dueAt, now = Date.now(), steps = DDL_DEFAULT_STEPS, { windowMs = 15 * 60000 } = {}) {
  const t = Date.parse(String(dueAt || ''));
  if (!Number.isFinite(t)) return [];
  return [...new Set((steps || []).map((s) => Math.round(Number(s))).filter((s) => Number.isFinite(s) && s > 0))]
    .sort((a, b) => a - b)
    .map((step) => ({ step, at: t - step, label: stepLabel(step), key: `ddl:${step}` }))
    .filter((x) => x.at <= now && x.at > now - windowMs);
}

/** 提醒去重键（写进 sync_state，跨重启有效）。 */
export function reminderKey(taskId, step) {
  return `ddl:${String(taskId || '')}:${Math.round(Number(step) || 0)}`;
}

/** 清掉太老的"已提醒"记录（默认留 60 天）。 */
export function pruneReminded(map = {}, now = Date.now(), { ttlDays = 60 } = {}) {
  const cutoff = now - ttlDays * 86400000;
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const t = Number(v);
    if (Number.isFinite(t) && t >= cutoff) out[String(k).slice(0, 160)] = Math.round(t);
  }
  return out;
}
