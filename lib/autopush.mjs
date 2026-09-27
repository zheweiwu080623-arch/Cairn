// autopush.mjs —— 「重要（≥阈值）自动进通知 / 推手机」的规则（纯函数）。
//
// 用户原话要的是"重要信息的推送"。在「重要信息」只排序、日报/晚报要你点开看之后，
// 这一步才真正把高分信息**主动送到你面前** —— 所以它默认是**关的**：
// 打扰策略应该由你亲手打开，而不是程序替你决定。
//
// 这个文件只管"该推哪几条"（纯函数，好测试）；真正建通知 / 发 Bark 在 server.mjs 里，
// 因为那两件事要碰数据库和网络。
//
// 四条防刷屏规则（都是真库上会咬人的地方）：
//   1. **同一件事只推一次**：按 `来源|标题` 记 seen，冷却期内不重复推（默认 24 小时）；
//   2. **一次最多几条**：默认 3 条（`max_per_run`），不能一开就把 50 条糊你脸上；
//   3. **太远的不推**：默认只看未来 7 天（`window_days`），"下个月的事"现在推没有意义；
//   4. **已经过期的不推**：过期的另有"逾期未完成"那一栏，不需要再打扰一次。

export const AUTOPUSH_KEY = 'priority_autopush_json';
export const AUTOPUSH_RESULT_KEY = 'priority_autopush_result';
export const AUTOPUSH_SCHEMA = 'autopush.v1';

/** 默认值：**关**。开了之后"进通知"默认开、"推手机"要你另外勾。 */
export const AUTOPUSH_DEFAULT = Object.freeze({
  schema: AUTOPUSH_SCHEMA,
  enabled: false,
  notify: true,
  bark: false,
  threshold: 70,
  max_per_run: 3,
  window_days: 7,
  cooldown_hours: 24,
  seen: {},
  updated_at: 0,
});

const bool = (v, d) => (v === undefined || v === null ? d : (v === true || v === '1' || v === 1 || v === 'true'));

const intIn = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
};

/** 清洗一份设置（界面/数据库里来的东西都当不可信）。 */
export function normalizeAutopush(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const seen = {};
  const src = r.seen && typeof r.seen === 'object' ? r.seen : {};
  for (const [k, v] of Object.entries(src)) {
    const t = Number(v);
    const key = String(k || '').slice(0, 160);
    if (key && Number.isFinite(t) && t > 0) seen[key] = Math.round(t);
  }
  return {
    schema: AUTOPUSH_SCHEMA,
    enabled: bool(r.enabled, AUTOPUSH_DEFAULT.enabled),
    notify: bool(r.notify, AUTOPUSH_DEFAULT.notify),
    bark: bool(r.bark, AUTOPUSH_DEFAULT.bark),
    threshold: intIn(r.threshold, 45, 100, AUTOPUSH_DEFAULT.threshold),
    max_per_run: intIn(r.max_per_run, 1, 10, AUTOPUSH_DEFAULT.max_per_run),
    window_days: intIn(r.window_days, 1, 60, AUTOPUSH_DEFAULT.window_days),
    cooldown_hours: intIn(r.cooldown_hours, 1, 24 * 30, AUTOPUSH_DEFAULT.cooldown_hours),
    seen,
    updated_at: Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : 0,
  };
}

/** 同一条信息的稳定标识（和「重要信息」的去重口径一致：来源 + 标题）。 */
export function autopushKey(item = {}) {
  const source = String(item.source || 'app');
  const title = String(item.title || '').trim().slice(0, 120);
  return `${source}|${title}`;
}

/**
 * 挑出这次该推的几条。
 * @param {any[]} ranked  lib/priority.mjs 排好序的列表
 * @param {object} cfg    设置（会先过 normalizeAutopush）
 * @param {{now?:number}} [opts]
 */
export function selectAutopush(ranked = [], cfg = {}, { now = Date.now() } = {}) {
  const c = normalizeAutopush(cfg);
  const out = [];
  if (!c.enabled) return out;
  const cooldownMs = c.cooldown_hours * 3600000;
  const list = Array.isArray(ranked) ? ranked : [];
  for (const x of list) {
    if (!x || !String(x.title || '').trim()) continue;
    // 我们自己推出去的通知不再进榜（否则会自己喂自己，无限循环）
    if (String(x.source || '') === 'priority') continue;
    if (!(Number(x.importance) >= c.threshold)) continue;
    const days = x.daysLeft;
    if (Number.isFinite(days) && days < 0) continue;              // 已过期
    if (Number.isFinite(days) && days > c.window_days) continue;  // 还太远
    const key = autopushKey(x);
    const last = Number(c.seen[key] || 0);
    if (last && now - last < cooldownMs) continue;                // 冷却期内推过
    out.push({ ...x, key });
    if (out.length >= c.max_per_run) break;
  }
  return out;
}

/** 记下"这几条推过了"，并顺手清掉太老的记录（默认留 60 天）。 */
export function markSeen(seen = {}, keys = [], now = Date.now(), { ttlDays = 60 } = {}) {
  const next = { ...(seen || {}) };
  for (const k of (Array.isArray(keys) ? keys : [])) {
    const key = String(k || '').slice(0, 160);
    if (key) next[key] = now;
  }
  const cutoff = now - ttlDays * 86400000;
  for (const [k, v] of Object.entries(next)) if (Number(v) < cutoff) delete next[k];
  return next;
}

/** 给界面/日志用的一句话说明（不含任何数据内容）。 */
export function describeAutopush(cfg) {
  const c = normalizeAutopush(cfg);
  if (!c.enabled) return '自动推送：关闭（打开后，重要信息会自己进通知 / 推手机）';
  const chans = [c.notify ? '进通知' : '', c.bark ? '推手机' : ''].filter(Boolean).join(' + ') || '（没勾渠道）';
  return `自动推送：开启 · ≥${c.threshold} 分 · ${chans} · 每次最多 ${c.max_per_run} 条 · ${c.cooldown_hours} 小时内不重复`;
}
