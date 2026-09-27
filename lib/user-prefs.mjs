// 运行时要读的几项用户偏好（2026-09-27 从 server.mjs 搬出来）。
//
// 为什么搬：`server.mjs` 有"别再长回去"的行数护栏（<2100 行），而这两件事
// （高峰时段、重点来源）本来就是"纯读一个偏好键 + 洗一遍"的小逻辑 —— 搬出来
// 既让主程序回到闸门内，也让它们能被单独测。
//
// 注意：都是**每次现读**（改设置立刻生效，不需要重启），坏值一律退回缺省。

import { normalizePeak } from './peak.mjs';

/** 缺省的重点来源：自己学校的邮箱 + 课程平台（2026-09-27 之前是写死的）。 */
export const DEFAULT_PRIORITY_SOURCES = ['email_sjtu', 'canvas'];

function readJson(store, key) {
  try { return JSON.parse(store.getSync(key) || 'null'); } catch { return null; }
}

/**
 * @param {{store: object}} deps
 * @returns {{peakPrefs: () => object, prioritySourceList: () => string[], isPrioritySource: (src?: string) => boolean}}
 */
export function createUserPrefs({ store } = {}) {
  /** 高峰时段偏好（作息/时区各人不同）；读不到就用缺省（= 原来的写死值）。 */
  const peakPrefs = () => normalizePeak(readJson(store, 'pref_peak') || {});

  /** 当前算「重点」的来源（数组）；没配过 → 缺省，配过空的 → 空的（= 没有重点）。 */
  const prioritySourceList = () => {
    const raw = readJson(store, 'pref_priority_sources');
    if (!Array.isArray(raw)) return [...DEFAULT_PRIORITY_SOURCES];
    return raw.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 24);
  };

  /** 一条来源（可能是 `rss@2` 这种实例）算不算重点。 */
  const isPrioritySource = (source) => {
    const t = String(source || '').split('@')[0];
    return !!t && prioritySourceList().includes(t);
  };

  return { peakPrefs, prioritySourceList, isPrioritySource };
}
