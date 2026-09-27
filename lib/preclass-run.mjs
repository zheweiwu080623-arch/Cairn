// preclass-run.mjs —— 「上课前 Canvas 检查」的**执行侧**：找课 → 跑功能 → 记账。
//
// 分工（和自动推送那一套一致）：
//   * lib/preclass.mjs        纯函数：算"接下来 N 分钟有哪节课"、折成 signal
//   * modules/preclass-check/ 功能：查这门课的 Canvas、决定要不要通知
//   * 本文件                  调度：调上面两个，管"一节课只查一次"和"报过的不再报"
//
// 三条纪律：
//   1) **一节课只查一次**（`preclass_checked_json` 记 key，30 天后自动清）；
//   2) **报过的不再报**（`preclass_seen_json` 记条目指纹，每门课最多留 500 条）；
//   3) 查不到就只留日志，**不打扰**（失败不是"有新东西"）。

import { buildSignal, normalizePreclass, upcomingSessions } from './preclass.mjs';

export const PRECLASS_PREFS_KEY = 'preclass_prefs_json';
export const PRECLASS_CHECKED_KEY = 'preclass_checked_json';
export const PRECLASS_SEEN_KEY = 'preclass_seen_json';

const readJson = (store, key, fallback) => {
  try {
    const raw = store.getSync(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch { return fallback; }
};

/** "报过的不再报"：按 `<type>:<id>` 记指纹，作用域是课程代码。 */
export function createSeenStore(store, { key = PRECLASS_SEEN_KEY, maxPerScope = 500 } = {}) {
  const fingerprint = (item) => `${item && item.type}:${item && item.id}`;
  const read = () => readJson(store, key, {}) || {};
  const write = (map) => { try { store.setSync(key, JSON.stringify(map)); } catch { /* 记不上不致命 */ } };
  return {
    fingerprint,
    read,
    filterNew(items = [], { scope = '' } = {}) {
      const seen = new Set(read()[scope] || []);
      return (Array.isArray(items) ? items : []).filter((i) => !seen.has(fingerprint(i)));
    },
    markSeen(items = [], { scope = '' } = {}) {
      const map = read();
      const seen = new Set(map[scope] || []);
      for (const i of (Array.isArray(items) ? items : [])) seen.add(fingerprint(i));
      map[scope] = [...seen].slice(-maxPerScope);
      write(map);
    },
  };
}

/**
 * 调度器。心跳里调 `maybeRun()`；内部自带节流（默认 60 秒），到点才真的算。
 */
export function createPreclassRunner({
  store, courses, runModule, prefs = () => readJson(store, PRECLASS_PREFS_KEY, {}),
  termStart = () => null, intervalMs = 60000, now = Date.now, log = () => {}, warn = () => {},
}) {
  let last = 0;

  /** 界面上那张卡要的：设置 + 接下来 N 分钟内的课 + 上次每节课的结果。 */
  function upcoming({ at = now() } = {}) {
    const p = normalizePreclass(prefs() || {});
    const sessions = upcomingSessions(courses() || [], {
      now: at, leadMinutes: p.lead_minutes, termStart: termStart(), checked: [],
    });
    const checkedMap = readJson(store, PRECLASS_CHECKED_KEY, {}) || {};
    return sessions.map((s) => ({ ...s, checked: !!checkedMap[s.key] }));
  }

  async function maybeRun() {
    const t = now();
    if (t - last <= intervalMs) return { ok: false, skipped: 'throttled' };
    last = t;
    const p = normalizePreclass(prefs() || {});
    if (!p.enabled) return { ok: false, skipped: 'disabled' };

    const checked = readJson(store, PRECLASS_CHECKED_KEY, {}) || {};
    const sessions = upcomingSessions(courses() || [], {
      now: t, leadMinutes: p.lead_minutes, termStart: termStart(), checked: Object.keys(checked),
    });
    if (!sessions.length) return { ok: true, checked: 0, results: [] };

    const results = [];
    for (const s of sessions) {
      const signal = buildSignal(s, { now: t, sinceMs: t - p.since_hours * 3600000 });
      let r = null;
      try {
        // 真跑（dry_run:false）—— 功能自己会决定"没有新东西就安静"；演练模式由接口层默认
        r = await runModule('preclass-check', { input: signal, dryRun: false });
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      checked[s.key] = t;                       // 不管成功失败都记一笔：一节课只查一次
      results.push({
        key: s.key, courseCode: s.courseCode, minutesLeft: s.minutesLeft,
        ok: !!r.ok, actions: (r && r.actions ? r.actions.length : 0), error: (r && r.error) || null,
      });
      if (r && r.ok) log(`[preclass] ${s.courseCode}（${s.minutesLeft} 分钟后上课）${r.summary || ''}`);
      else warn(`[preclass] ${s.courseCode} 检查失败：${(r && r.error) || '未知'}`);
    }

    const cutoff = t - 30 * 86400000;           // 只留最近 30 天的"已检查"记录
    for (const [k, v] of Object.entries(checked)) if (Number(v) < cutoff) delete checked[k];
    try { store.setSync(PRECLASS_CHECKED_KEY, JSON.stringify(checked)); } catch { /* ignore */ }

    return { ok: true, at: new Date(t).toISOString(), checked: sessions.length, results };
  }

  return { maybeRun, upcoming, lastRunAt: () => last };
}
