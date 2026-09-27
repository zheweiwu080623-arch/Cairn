// backup-stack.mjs —— 「自动备份」的接线层（执行能力 + 四个接口装在一起）。
//
//   GET  /api/backups         → 设置 / 现有快照清单 / 上次结果
//   POST /api/backups         → 改设置（开关、间隔小时、保留份数、备份目录）
//   POST /api/backups/run     → 立即备份（**默认演练**，`{"dry_run":false}` 才真备）
//   POST /api/backups/check   → 让调度器按节流判断一次（心跳内部也调它）
//
// 纯逻辑在 lib/backup.mjs（好测）；真正落盘用存储层的 `VACUUM INTO`（见 lib/store.mjs）。

import { statSync } from 'node:fs';

import { createBackupRunner, listBackups, normalizeBackupPrefs, backupDirOf, AUTO_DIRNAME } from './backup.mjs';

export function createBackupStack({ store, dataDir, sendJson, sendError, readBody, log = () => {} }) {
  const dbMtimeOf = () => {
    try { return statSync(store.path ? store.path() : '').mtimeMs; } catch { return 0; }
  };
  const snapshot = (file) => store.backupTo(file);
  const runner = createBackupRunner({ store, dataDir, snapshot, log });
  /** 节流：心跳 4 秒一次，真判断（含 stat 数据库）没必要那么勤 */
  let lastCheck = 0;
  const CHECK_GAP_MS = 10 * 60 * 1000;

  function status() {
    const prefs = runner.readPrefs();
    const last = runner.readLast();
    const dir = backupDirOf(dataDir, prefs);
    const files = listBackups(`${dir}/${AUTO_DIRNAME}`);
    return {
      schema: 'backup.v1',
      prefs, dir, auto_dir: `${dir}\\${AUTO_DIRNAME}`,
      last: last || null,
      count: files.length,
      bytes: files.reduce((a, f) => a + f.size, 0),
      files: files.slice(0, 20),
    };
  }

  function maybeRun({ forceGap = false } = {}) {
    const t = Date.now();
    if (!forceGap && t - lastCheck < CHECK_GAP_MS) return { ok: true, ran: false, reason: '刚看过，跳过' };
    lastCheck = t;
    return runner.maybeRun({ dbMtime: dbMtimeOf() });
  }

  async function handleBackups(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    if (p === '/api/backups' && method === 'GET') return sendJson(res, 200, status());
    if (p === '/api/backups' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const prefs = runner.savePrefs(body.prefs || body || {});
      log(`[backup] 设置已更新：${prefs.enabled ? '开' : '关'} · 每 ${prefs.every_hours} 小时 · 留 ${prefs.keep} 份`);
      return sendJson(res, 200, { ...status(), saved: prefs });
    }
    if (p === '/api/backups/run' && method === 'POST') {
      const body = (await readBody(req)) || {};
      const dryRun = body.dry_run !== false;                 // 与功能同一条规矩：默认演练
      const r = runner.runOnce({ force: true, dryRun, dbMtime: dbMtimeOf() });
      return sendJson(res, r.ok ? 200 : 400, { ...r, status: status() });
    }
    if (p === '/api/backups/check' && method === 'POST') {
      const r = maybeRun({ forceGap: true });
      return sendJson(res, 200, { ...r, status: status() });
    }
    return sendError(res, 404, '没有这个接口');
  }

  return { runner, handleBackups, status, maybeRun, prefs: () => runner.readPrefs(), normalizeBackupPrefs };
}
