// 截止时间（due_at）的统一解释规则。
//
// 用户决定（2026-09-18）：纯日期一律按「当天 23:59 结束」处理，全系统只有这一条规则。
//
// 为什么需要它：`new Date("2026-10-04")` 会被 JavaScript 解析成 UTC 零点，
// 也就是北京时间当天 08:00。于是从当天 08:00 起，一个「今天到期」的纯日期任务
// 会同时被算成「逾期」和「今天到期」，统计里被重复计数。
//
// 这个文件是规则的权威实现。浏览器里的 app.js 不能 import（它是普通 <script>），
// 所以 public/app.js 与 public/viewmodel.js 各有一份逐字相同的副本，
// 由 tests/duedate.test.mjs 强制三者行为一致——改这里必须同步改那两处。
//
// #region due-rule — single source of truth, keep byte-identical in:
//   lib/duedate.mjs · public/app.js · public/viewmodel.js
const DUE_END_OF_DAY = { hour: 23, minute: 59, second: 59, ms: 999 };
const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function hasTimeOfDay(value) {
  return typeof value === 'string' && value.includes('T');
}

export function dueMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const plain = PLAIN_DATE.exec(text);
  if (plain && !hasTimeOfDay(text)) {
    return new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]),
      DUE_END_OF_DAY.hour, DUE_END_OF_DAY.minute, DUE_END_OF_DAY.second, DUE_END_OF_DAY.ms).getTime();
  }
  const parsed = new Date(text).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function isOverdue(value, nowMs) {
  const t = dueMs(value);
  return t !== null && t < nowMs;
}

export function dueDayKey(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim();
  if (PLAIN_DATE.test(text)) return text;
  const t = dueMs(text);
  if (t === null) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dueLabel(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim();
  if (PLAIN_DATE.test(text)) return `${text} 当天截止`;
  const t = dueMs(text);
  if (t === null) return text;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// #endregion due-rule
