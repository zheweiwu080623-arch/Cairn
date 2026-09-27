// autopush-run.mjs —— 「重要信息自动推送」的执行侧（规则在 lib/autopush.mjs，纯函数）。
//
// 为什么单独一个文件：它要碰数据库（建通知）和网络（Bark），而 `server.mjs` 有一条
// "别再长回去"的行数护栏（R2 拆完之后定的）。把这段搬出来，主程序只留一行接线。
//
// 默认**关**：`maybeRun()` 在开关关着时什么都不做（不建通知、不推手机、不读排序）。

import { AUTOPUSH_RESULT_KEY, describeAutopush, markSeen, selectAutopush } from './autopush.mjs';

/** 自己推出去的通知标记成这个来源，取料时会排除掉（否则自己喂自己）。 */
export const AUTOPUSH_SOURCE = 'priority';

/** 心跳每 4 秒一次，但"算一遍重要性"没必要那么勤 —— 默认 10 分钟看一次。 */
export const AUTOPUSH_INTERVAL_MS = 10 * 60000;

export function createAutopushRunner({
  store, priority, bark, intervalMs = AUTOPUSH_INTERVAL_MS, log = () => {}, warn = () => {},
}) {
  let lastRun = 0;

  /**
   * 跑一次。`force` 用于"现在跑一次"（绕过开关），`dry` 只预览不真的发。
   * 返回里带 items，界面可以直接显示"这次推了哪几条"。
   */
  async function run({ force = false, dry = false } = {}) {
    const cfg = priority.getAutopush();
    const { result } = priority.computePriority({ top: 12 });
    const toItems = (list) => list.map((x) => ({
      key: x.key, title: x.title, band: x.band, importance: x.importance,
      daysLeft: x.daysLeft === undefined ? null : x.daysLeft, source: x.source || '',
    }));
    // 预览：**关着也能看**（"先看会被推什么，再决定开不开"）
    if (dry) {
      const preview = selectAutopush(result.ranked, { ...cfg, enabled: true });
      return { ok: true, dry: true, count: preview.length, items: toItems(preview), describe: describeAutopush(cfg) };
    }
    if (!cfg.enabled && !force) return { ok: false, skipped: 'disabled', describe: describeAutopush(cfg) };
    if (!cfg.notify && !cfg.bark) return { ok: false, skipped: 'no-channel', describe: describeAutopush(cfg) };
    const picked = selectAutopush(result.ranked, cfg);
    const items = toItems(picked);

    let notified = 0;
    let pushed = 0;
    for (const x of picked) {
      if (cfg.notify) {
        const exists = store.listNotifications().some((n) => n.source === AUTOPUSH_SOURCE && n.external_id === x.key);
        if (!exists) {
          // 触发时间就是现在、且不预标"已触发" —— 这样它会真的弹一次提醒（这就是"进通知"）
          store.createNotification({
            title: x.title,
            message: [x.why, x.notes].filter(Boolean).join(' · '),
            trigger_at: new Date().toISOString(),
            repeat: 'none',
            source: AUTOPUSH_SOURCE,
            external_id: x.key,
            priority: 1,
            url: x.url || null,
          });
          notified += 1;
        }
      }
      if (cfg.bark) {
        try {
          const r = await bark({
            title: `⭐ ${x.title}`,
            body: String(x.why || x.notes || '').slice(0, 180),
            url: x.url || '',
            level: 'active',
            force: true,   // 你已经亲手打开了这个开关，不再受"来源过滤"拦
          });
          if (r && r.ok) pushed += 1;
        } catch { /* 单条推送失败不影响其它 */ }
      }
    }
    const next = priority.setAutopush({ seen: markSeen(cfg.seen, picked.map((x) => x.key)) });
    const out = {
      ok: true, dry: false, at: new Date().toISOString(),
      count: picked.length, notified, pushed, items, describe: describeAutopush(next),
    };
    try { store.setSync(AUTOPUSH_RESULT_KEY, JSON.stringify(out)); } catch { /* 记不上不影响本次推送 */ }
    if (picked.length) log(`[autopush] 重要信息自动推送：进通知 ${notified} 条 · 推手机 ${pushed} 条`);
    return out;
  }

  /** 心跳里调它：自带节流，没到间隔就立刻返回（连设置都不读）。 */
  async function maybeRun() {
    if (Date.now() - lastRun <= intervalMs) return { ok: false, skipped: 'throttled' };
    lastRun = Date.now();
    try {
      return await run();
    } catch (e) {
      warn(`[autopush] error ${e && e.message ? e.message : e}`);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  return { run, maybeRun, intervalMs };
}
