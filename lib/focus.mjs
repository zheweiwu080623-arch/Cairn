// 专注与免打扰（P1：专注时段不打扰；2026-09-27：免打扰从"番茄钟的副作用"改成**可调的偏好**）。
//
// 为什么放在这里：`focus_sessions` 表里每行都有 started_at / ended_at，
// 所以"现在是否正在专注"是**纯计算**，不需要额外状态。抽成纯函数便于测试与复用。
//
// 免打扰 = 到点的提醒**不弹、也不推手机**，也不标记"已触发"；等免打扰结束后一起补上（不会丢）。
// 两个旋钮（存在偏好 `pref_quiet` 里）：
//   · focus_mute：专注时免打扰（默认开 —— 就是原来的行为）
//   · start / end：安静时段（例如 22:00 → 07:00，留空 = 不设；起止相同视为没设）
//   · exceptions：**重要例外**（2026-09-27 晚加）—— 免打扰期间仍然照响的几类：
//       ddl_final（默认开）：DDL 最后一档（剩 30 分钟以内）与「已逾期」
//       starred  （默认关）：标了「重点」的提醒（交大邮箱 / Canvas 这类来源）

import { DDL_FINAL_STEP_MS } from './ddl.mjs';

/** "HH:MM" → 当天的分钟数；不合法返回 null（同时接受 9:05 这种写法）。 */
export function parseHm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 某一行是否覆盖 nowMs。 */
export function coversNow(row, nowMs = Date.now()) {
  const start = Date.parse(String(row?.started_at || ''));
  const end = Date.parse(String(row?.ended_at || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= nowMs && nowMs <= end;
}

/** 现在是否有正在进行的专注时段。 */
export function isFocusRunning(rows = [], nowMs = Date.now()) {
  return (Array.isArray(rows) ? rows : []).some((r) => coversNow(r, nowMs));
}

/** 返回当前那段专注（没有就是 null），界面可以显示"正在专注，攒着"。 */
export function activeFocus(rows = [], nowMs = Date.now()) {
  return (Array.isArray(rows) ? rows : []).find((r) => coversNow(r, nowMs)) || null;
}

// ---------------- 免打扰（可调偏好） ----------------

/** 缺省：专注时免打扰开着（保持原有行为），不设安静时段，DDL 最后一档破例、重点不破例。 */
export const QUIET_DEFAULTS = {
  focus_mute: true,
  start: '',
  end: '',
  exceptions: { ddl_final: true, starred: false },
};

/** 例外种类（界面上一个一个开关）。 */
export const EXCEPTION_KINDS = ['ddl_final', 'starred'];

const truthy = (v) => !(v === false || v === 0 || v === '0' || v === 'false' || v === '' || v === null || v === undefined);

/** 把任意输入洗成 { focus_mute, start, end }：坏值一律退回默认，绝不让偏好把提醒搞崩。 */
export function normalizeQuiet(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mute = src.focus_mute;
  const focus_mute = !(mute === false || mute === 0 || mute === '0' || mute === 'false');
  const start = parseHm(src.start) === null ? '' : String(src.start).trim();
  const end = parseHm(src.end) === null ? '' : String(src.end).trim();
  const ex = src.exceptions && typeof src.exceptions === 'object' ? src.exceptions : {};
  const exceptions = {
    ddl_final: ex.ddl_final === undefined ? QUIET_DEFAULTS.exceptions.ddl_final : truthy(ex.ddl_final),
    starred: ex.starred === undefined ? QUIET_DEFAULTS.exceptions.starred : truthy(ex.starred),
  };
  return { ...QUIET_DEFAULTS, focus_mute, start, end, exceptions };
}

/** 这一类例外是不是被用户打开了。 */
export function exceptionEnabled(quiet = {}, kind = '') {
  if (!kind) return false;
  const ex = normalizeQuiet(quiet).exceptions;
  return kind === 'ddl_final' ? ex.ddl_final : (kind === 'starred' ? ex.starred : false);
}

/** 从 DDL 提醒的去重键 `ddl:<任务 id>:<档位毫秒>` 里取出档位；认不出返回 null。 */
export function ddlStepOf(externalId) {
  const parts = String(externalId || '').split(':');
  if (parts[0] !== 'ddl' || parts.length < 3) return null;
  const ms = Number(parts[parts.length - 1]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * 这条提醒算不算"重要的"（免打扰期间可以破例）。
 * @returns {''|'ddl_final'|'starred'} 命中的例外种类（用户没开那种例外就返回 ''）
 */
export function importantKind(notif = {}, quiet = {}) {
  const id = String(notif.external_id || notif.id || '');
  const source = String(notif.source || '');
  const isDdl = source === 'ddl' || id.startsWith('ddl:');
  if (isDdl) {
    const step = ddlStepOf(id);
    const overdue = /已逾期/.test(String(notif.message || ''));
    if (overdue || (step !== null && step <= DDL_FINAL_STEP_MS)) {
      return exceptionEnabled(quiet, 'ddl_final') ? 'ddl_final' : '';
    }
  }
  if (notif.priority) return exceptionEnabled(quiet, 'starred') ? 'starred' : '';
  return '';
}

/**
 * 现在是不是落在"安静时段"里（跨夜也行：22:00 → 07:00）。
 * 起止相同 / 缺一个 / 空 → 视为没设，返回 false。
 */
export function inQuietHours(quiet = {}, nowMs = Date.now()) {
  const q = normalizeQuiet(quiet);
  const s = parseHm(q.start);
  const e = parseHm(q.end);
  if (s === null || e === null || s === e) return false;
  const d = new Date(nowMs);
  const m = d.getHours() * 60 + d.getMinutes();
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

/**
 * 这一轮要不要"攒着"（不弹、不推、也不标记已触发）。
 * @returns {{defer: boolean, why: ''|'focus'|'quiet'}}
 */
export function notifyGate({ quiet = {}, focusRows = [], kind = '' } = {}, nowMs = Date.now()) {
  const q = normalizeQuiet(quiet);
  const why = (q.focus_mute && isFocusRunning(focusRows, nowMs)) ? 'focus'
    : (inQuietHours(q, nowMs) ? 'quiet' : '');
  if (!why) return { defer: false, why: '', excepted: false };
  // 命中免打扰，但这一条属于"重要例外"且用户开着那种例外 → 放行（并如实标出来）
  if (kind && exceptionEnabled(q, kind)) return { defer: false, why, excepted: true };
  return { defer: true, why, excepted: false };
}
