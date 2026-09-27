// 高峰时段判断（与计价口径同一套规则）—— **可配置**（2026-09-27 从写死改成偏好）。
//
// 缺省（= 原来的写死值，别人的习惯不一样就可以改）：
//   **工作日 09:00–12:00 与 14:00–18:00 是高峰，周末全天非高峰**，按北京时间（UTC+8）算。
// 用途：需要花模型调用的事情（语义兜底 / 让 agent 分析）只在**非高峰**批处理，成本直接减半。
// 偏好存在 `pref_peak`：{ windows: [[540,720],[840,1080]], weekend_free: true, tz_offset: 8 }
//   · windows 用**当天的分钟数**（540 = 09:00），所以 08:30–11:30 这种也能表达；
//   · windows 留空数组 = 没有高峰时段（永远按非高峰算）；
//   · tz_offset 是**你所在时区**（-12~14），所以人不在国内也不用把作息换算成北京时间；
//   · 坏值一律退回默认，绝不让偏好把调度搞崩。

export const PEAK_DEFAULTS = Object.freeze({
  windows: [[540, 720], [840, 1080]],   // 09:00–12:00 与 14:00–18:00
  weekend_free: true,
  tz_offset: 8,
});

const bool = (v, dflt) => (v === undefined ? dflt : !(v === false || v === 0 || v === '0' || v === 'false' || v === ''));

/** 把任意输入洗成 { windows, weekend_free, tz_offset }。 */
export function normalizePeak(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawWindows = Array.isArray(src.windows) ? src.windows : PEAK_DEFAULTS.windows;
  const windows = rawWindows
    .map((w) => (Array.isArray(w) ? [Number(w[0]), Number(w[1])] : null))
    .filter((w) => w && Number.isFinite(w[0]) && Number.isFinite(w[1])
      && w[0] >= 0 && w[1] <= 1440 && w[0] < w[1])
    .map((w) => [Math.round(w[0]), Math.round(w[1])])
    .slice(0, 4);
  const tz = Number(src.tz_offset);
  const tz_offset = Number.isFinite(tz) ? Math.max(-12, Math.min(14, Math.round(tz))) : PEAK_DEFAULTS.tz_offset;
  return { windows, weekend_free: bool(src.weekend_free, PEAK_DEFAULTS.weekend_free), tz_offset };
}

/** 把任意时刻换算成"某个时区的墙上时间"（不依赖本机时区）。 */
export function localParts(date = new Date(), tzOffsetHours = PEAK_DEFAULTS.tz_offset) {
  const d = date instanceof Date ? date : new Date(date);
  const asUtc = d.getTime() + d.getTimezoneOffset() * 60000;      // 本机墙上时间 → 假装是 UTC
  const wall = new Date(asUtc + Number(tzOffsetHours) * 3600000); // 再挪到目标时区
  return { hour: wall.getHours(), minute: wall.getMinutes(), weekday: wall.getDay() }; // 0=周日
}

/** 是否高峰（按配置的时区与时段）。 */
export function isPeak(date = new Date(), prefs = {}) {
  const p = normalizePeak(prefs);
  const { hour, minute, weekday } = localParts(date, p.tz_offset);
  if (p.weekend_free && (weekday === 0 || weekday === 6)) return false;   // 周末全天非高峰
  const m = hour * 60 + minute;
  return p.windows.some(([start, end]) => m >= start && m < end);
}

/** 给界面/日志用的说明。 */
export function bandLabel(date = new Date(), prefs = {}) {
  return isPeak(date, prefs) ? '高峰（单价翻倍）' : '非高峰（半价）';
}

/** 给人看的一句话描述（设置页用）。 */
export function describePeak(prefs = {}) {
  const p = normalizePeak(prefs);
  if (!p.windows.length) return '没有高峰时段（一直按非高峰算）';
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${p.windows.map(([s, e]) => `${hhmm(s)}–${hhmm(e)}`).join(' / ')} 是高峰`
    + `${p.weekend_free ? '（周末全天不算）' : '（周末也算）'} · UTC${p.tz_offset >= 0 ? '+' : ''}${p.tz_offset}`;
}

/** 界面用：把一个 "HH:MM" 转成当天的分钟数（空串/坏值 → null）。 */
export function hmToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 界面用：分钟数 → "HH:MM"。 */
export function minutesToHm(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n) || n < 0 || n > 1440) return '';
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
