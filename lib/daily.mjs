// daily.mjs —— 「每日 18:00 开工」的纯逻辑（D5）。
//
// 用户原话："定时 6 点非高峰时段时准时开始工作" → 改成 "晚上 18:00 开工"，并且要求
// 把这件"每天到点自己干一轮"的事做进 Cairn 自己（不只是协作层的定时任务）。
//
// 为什么是 18:00：`lib/peak.mjs` 里工作日的 09:00–12:00 与 14:00–18:00 算高峰，
// `hour < end` 的写法让 18:00 正好落在非高峰 —— 需要动脑/花钱的事放在这时更合适。
//
// 这一层只管"到点没有"，**不碰数据库、不发通知**（执行在 lib/daily-stack.mjs）。

export const DAILY_PREFS_KEY = 'daily_prefs_json';
export const DAILY_LAST_KEY = 'daily_last_json';
export const DAILY_DEFAULT_AT = '18:00';

/** 本地日期键（与界面其它地方的 hk() 同一规则）。 */
export function dateKeyOf(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 设置清洗：`at` 必须是 HH:MM，坏值退回 18:00。 */
export function normalizeDailyPrefs(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const at = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(r.at || '')) ? String(r.at) : DAILY_DEFAULT_AT;
  const [hh, mm] = at.split(':').map(Number);
  return {
    schema: 'daily.v1',
    enabled: r.enabled !== false,          // 默认开：这是"到点自己开工"，默认开才有用
    at,
    minutes: hh * 60 + mm,                 // 便于比较
    weekly: r.weekly !== false,            // 顺手生成/刷新本周巩固包（能力③）
    push: r.push === true,                 // 默认**不**推手机（只准备，不打扰）
    updated_at: Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : 0,
  };
}

/**
 * 现在该开工了吗？
 * 规则：开着 → 今天还没跑过 → 本地时间已过 `at`（错过也能补：当天任何时间都算，不挑分钟）。
 */
export function dailyDue({ prefs, last = null, now = Date.now() } = {}) {
  const p = normalizeDailyPrefs(prefs);
  if (!p.enabled) return { ok: false, reason: '每日开工已关闭' };
  const today = dateKeyOf(now);
  if (last && last.date === today) return { ok: false, reason: '今天已经开工过了' };
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes < p.minutes) {
    const wait = p.minutes - minutes;
    return { ok: false, reason: `还没到点（约 ${Math.floor(wait / 60)} 小时 ${wait % 60} 分钟后）` };
  }
  return { ok: true, reason: '' };
}
