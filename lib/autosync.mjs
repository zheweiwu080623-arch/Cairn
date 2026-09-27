// 每日自动同步：把"开着的那些数据源"挨个拉一遍，按画像裁决，再决定推不推到日程/任务。
//
// 2026-09-26 从 server.mjs 里整块搬出来（两个原因）：
//   1) 主程序有行数上限的结构闸门，实例化那批改动把它顶爆了；
//   2) 它本来就只依赖"传进来的那几样东西"，挪出来反而更好读。
//
// 依赖全部从 ctx 注入，这个文件自己不 import 任何运行时单例。

import { instanceType } from './connectors/instances.mjs';

export function createAutoSync(ctx = {}) {
  const {
    store, getConnector, normalizeForStore, scoreItem, summarizeVerdicts,
    effectiveProfile, pushItemToPlanner, getAutoSync, setAutoSync,
  } = ctx;

  /**
   * 跑一轮自动同步。
   *
   * 一个**类型**可能在库里有多条实例（`rss` / `rss@2`）：开关是按类型给的，
   * 真跑的时候每条实例各跑各的、数据也各归各的；结果的键是**实例 id**
   *（只有一条时它就等于类型 id，历史和界面都没变）。
   */
  async function runAutoSync(cfg = getAutoSync()) {
    const profile = effectiveProfile();   // 手填画像 + 学到 的规则
    const results = {};
    let total = 0;
    let pushed = 0;
    const allInstances = store.listConnectors().map((c) => c.source);
    for (const [id, on] of Object.entries(cfg.connectors || {})) {
      if (!on) continue;
      const conn = getConnector(id);
      if (!conn) continue;
      const targets = allInstances.filter((x) => instanceType(x) === id);
      if (!targets.length) targets.push(id);   // 还没配过也照样走一遍（历史行为：至少报个错）
      for (const target of targets) {
        try {
          const stored = store.getConnector(target);
          const result = cfg.demo
            ? conn.fromSample()
            : await conn.fetchAll(JSON.parse((stored && stored.config_json) || '{}'));
          store.clearConnectorData(target);
          let inserted = 0;
          const verdicts = [];
          for (const it of result.items) {
            const norm = normalizeForStore(it, target);
            const scored = scoreItem({
              source: target, title: norm.title, notes: norm.notes,
              sender: norm.sender || norm.from || '',
              due_at: norm.due_at, start_at: norm.start_at, kind: norm.kind,
            }, profile);
            // 画像启用 → 由裁决决定；未启用 → 沿用历史的 auto_approve 开关（行为完全不变）
            const autoPush = profile.enabled ? scored.verdict === 'push' : Boolean(cfg.auto_approve);
            if (autoPush) pushed += pushItemToPlanner({ ...norm, source: target });
            store.insertConnectorData(target, norm, autoPush ? 1 : 0,
              { score: scored.score, verdict: scored.verdict, reasons: scored.reasons });
            verdicts.push({ verdict: scored.verdict, reasons: scored.reasons });
            inserted++;
          }
          results[target] = { type: id, inserted, pushed, relevance: summarizeVerdicts(verdicts), raw: result.raw };
          total += inserted;
        } catch (e) {
          results[target] = { type: id, error: e.message };
        }
      }
    }
    const nowIso = new Date().toISOString();
    setAutoSync({ ...cfg, last_run: nowIso, last_result: { total, results } });
    return { total, pushed, results };
  }

  return { runAutoSync };
}
