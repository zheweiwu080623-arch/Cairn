// 行为学习：从你的动作里自动修正筛选规则（P1）。
//
// 设计原则（与 relevance.mjs 一致）：
//   1) **可解释**：每条学到的规则都写着"因为你在 X 上做了 N 次 Y"。
//   2) **可撤回**：学习记录单独存放，随时能一键清空，不影响你手填的画像。
//   3) **计数 + 阈值**，不做黑盒 ML：连续删掉同一个来源/发件人 3 次 → 以后自动忽略；
//      连续批准 2 次 → 以后自动放行。
//   4) 学习结果**合并进**画像（不是覆盖）：你手填的规则永远优先。

export const LEARNING_VERSION = 'learning.v1';

/** 阈值：删 3 次判为"不想看"，批 2 次判为"想看"。 */
export const REJECT_AT = 3;
export const ACCEPT_AT = 2;

export const DEFAULT_LEARNING = Object.freeze({
  schema: LEARNING_VERSION,
  enabled: true,
  reject: {},     // key -> 次数
  accept: {},     // key -> 次数
  applied: {},    // key -> { verdict: 'deny'|'allow', label, at, count }
  updated_at: 0,
});

const asCounter = (value) => {
  const out = {};
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) out[String(k)] = Math.floor(n);
    }
  }
  return out;
};

export function normalizeLearning(raw = {}) {
  const l = raw && typeof raw === 'object' ? raw : {};
  const applied = {};
  if (l.applied && typeof l.applied === 'object') {
    for (const [k, v] of Object.entries(l.applied)) {
      if (v && (v.verdict === 'deny' || v.verdict === 'allow')) {
        applied[String(k)] = {
          verdict: v.verdict,
          label: typeof v.label === 'string' ? v.label : String(k),
          at: Number.isFinite(v.at) ? v.at : 0,
          count: Number.isFinite(v.count) ? v.count : 0,
        };
      }
    }
  }
  return {
    schema: LEARNING_VERSION,
    enabled: l.enabled !== false,
    reject: asCounter(l.reject),
    accept: asCounter(l.accept),
    applied,
    updated_at: Number.isFinite(l.updated_at) ? l.updated_at : 0,
  };
}

/**
 * 记一次反馈。
 * action: 'approve'（你批准/推送了这条）| 'delete'（你把它删了）
 * key:    学习主体（优先发件人，其次来源），如 'spam@example.net' 或 'email'
 */
export function recordFeedback(rawLearning, { action, key, label = '' } = {}) {
  const learning = normalizeLearning(rawLearning);
  if (!learning.enabled || !key) return { learning, changed: null };
  const k = String(key);
  const name = label || k;
  let changed = null;

  if (action === 'delete') {
    learning.reject[k] = (learning.reject[k] || 0) + 1;
    delete learning.accept[k];                       // 反向计数清零，避免"又爱又恨"
    if (learning.reject[k] >= REJECT_AT && learning.applied[k]?.verdict !== 'deny') {
      learning.applied[k] = { verdict: 'deny', label: name, at: Date.now(), count: learning.reject[k] };
      changed = { verdict: 'deny', key: k, label: name, count: learning.reject[k] };
    }
  } else if (action === 'approve') {
    learning.accept[k] = (learning.accept[k] || 0) + 1;
    delete learning.reject[k];
    if (learning.accept[k] >= ACCEPT_AT && learning.applied[k]?.verdict !== 'allow') {
      learning.applied[k] = { verdict: 'allow', label: name, at: Date.now(), count: learning.accept[k] };
      changed = { verdict: 'allow', key: k, label: name, count: learning.accept[k] };
    }
  }
  learning.updated_at = Date.now();
  return { learning, changed };
}

/** 把学习结果翻译成规则 + 人话说明（用于界面显示与解释）。 */
export function learnedRules(rawLearning) {
  const learning = normalizeLearning(rawLearning);
  const denySenders = [];
  const allowSenders = [];
  const notes = [];
  for (const [key, info] of Object.entries(learning.applied)) {
    if (info.verdict === 'deny') {
      denySenders.push(key);
      notes.push(`以后忽略「${info.label}」——你删了 ${info.count} 次`);
    } else {
      allowSenders.push(key);
      notes.push(`以后优先「${info.label}」——你批准了 ${info.count} 次`);
    }
  }
  return { denySenders, allowSenders, notes };
}

/**
 * 把学习结果合并进画像（手填的规则优先；学习只做"追加"）。
 * 返回新画像 + 说明，不改动传入对象。
 */
export function mergeLearned(profile = {}, rawLearning = {}) {
  const learning = normalizeLearning(rawLearning);
  const rules = learnedRules(learning);
  if (!learning.enabled || (!rules.denySenders.length && !rules.allowSenders.length)) {
    return { profile, learned: rules, applied: 0 };
  }
  const deny = new Set([...(profile.denySenders || []).map((s) => String(s).toLowerCase())]);
  const allow = new Set([...(profile.allowSenders || []).map((s) => String(s).toLowerCase())]);
  let applied = 0;
  for (const key of rules.denySenders) {
    const k = String(key).toLowerCase();
    if (!deny.has(k)) { deny.add(k); applied += 1; }
    allow.delete(k);
  }
  for (const key of rules.allowSenders) {
    const k = String(key).toLowerCase();
    if (!allow.has(k)) { allow.add(k); applied += 1; }
    deny.delete(k);
  }
  return {
    profile: { ...profile, denySenders: [...deny], allowSenders: [...allow] },
    learned: rules,
    applied,
  };
}

/** 清空学习记录（手填画像不受影响）。 */
export function clearLearning(rawLearning) {
  return { ...normalizeLearning(rawLearning), reject: {}, accept: {}, applied: {}, updated_at: Date.now() };
}
