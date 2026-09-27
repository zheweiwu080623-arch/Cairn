// backup.mjs —— 数据目录的**自动备份 / 定期清理**（2026-09-24，审阅反馈驱动）
//
// 为什么要有它：审阅意见原话 ——「考虑本地数据与云数据库备份。可以有自动归档，自动保存，
// 定期清理之类的功能。」这条说得对：全部数据挤在一个 SQLite 文件里，坏一次就是全没，
// 而"按周自己复制一份"是纯手工习惯，程序根本没兜底（风险总结文档里自己写的"仍在"项）。
//
// 做法（**不引入任何账号、不联网**，保持"纯本地"这条底线）：
//   1) 用 SQLite 自带的 `VACUUM INTO` 生成一份**一致且紧凑**的快照（WAL 下也安全，
//      不像直接拷文件会拷到写了一半的库）；
//   2) 落在 `<数据目录>/backups/auto/`，文件名单调到分钟（`auto-YYYYMMDD-HHMM.db`）；
//   3) **只保留最近 N 份**（默认 7），更早的自动清掉 —— 这就是"定期清理"；
//   4) 备份目录可以改到**网盘同步文件夹**（OneDrive / 坚果云…）：不用任何云账号与密钥，
//      就得到一份"离开这台机器"的副本。想上真正的云数据库属于另一条路，见计划文档的评估。

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const BACKUP_PREFS_KEY = 'backup_prefs_json';
export const BACKUP_LAST_KEY = 'backup_last_json';
export const AUTO_DIRNAME = 'auto';
const NAME_RE = /^auto-\d{8}-\d{4}\.db$/;

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(v)));
};

/** 备份设置（坏值一律夹到合理区间，界面/接口都不用自己防）。 */
export function normalizeBackupPrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled !== false,                 // 默认开：这是兜底功能，默认开才叫兜底
    every_hours: clamp(r.every_hours ?? 24, 1, 24 * 14, 24),
    keep: clamp(r.keep ?? 7, 1, 60, 7),
    dir: typeof r.dir === 'string' ? r.dir.trim() : '',   // 留空 = <数据目录>/backups
  };
}

/** 快照文件名（同一分钟只可能有一个，重复就跳过，不做覆盖）。 */
export function backupName(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `auto-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`;
}

/** 该不该跑？（纯函数，好测） */
export function shouldBackup({ prefs, last = null, now = Date.now(), dbMtime = 0 } = {}) {
  const p = normalizeBackupPrefs(prefs);
  if (!p.enabled) return { ok: false, reason: '自动备份已关闭' };
  const lastAt = Number(last && last.at) || 0;
  if (lastAt && now - lastAt < p.every_hours * 3600000) {
    const mins = Math.ceil((p.every_hours * 3600000 - (now - lastAt)) / 60000);
    return { ok: false, reason: `还没到点（约 ${mins} 分钟后）` };
  }
  // 库里没变过就不重复备份（第一次、或上次备份之后又写过东西 → 才值得备）
  if (lastAt && dbMtime && Number(last.db_mtime) === dbMtime) {
    return { ok: false, reason: '数据没变化，跳过（省一份 14 MB）' };
  }
  return { ok: true, reason: '' };
}

/** 只保留最近 keep 份；返回**该清掉的**（从旧到新）。纯函数，交给调用方执行删除。 */
export function pickPrunable(names = [], { keep = 7 } = {}) {
  const k = clamp(keep, 1, 60, 7);
  const auto = names.filter((n) => NAME_RE.test(n)).sort();      // 名字带时间戳 → 字典序 = 时间序
  return auto.slice(0, Math.max(0, auto.length - k));
}

/** 备份目录（没设自定义目录就是 `<数据目录>/backups`）。 */
export function backupDirOf(dataDir, prefs = {}) {
  const p = normalizeBackupPrefs(prefs);
  return p.dir || join(dataDir, 'backups');
}

/** 列出现有快照（读不到就当空，绝不抛）。 */
export function listBackups(dir) {
  if (!dir || !existsSync(dir)) return [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !NAME_RE.test(e.name)) continue;
    try {
      const st = statSync(join(dir, e.name));
      out.push({ name: e.name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    } catch { /* 单个文件读不到不影响清单 */ }
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));         // 新 → 旧
}

/**
 * 造一个"该跑就跑"的执行能力。真正落盘靠注入的 `snapshot(targetFile)` ——
 * 由存储层用 `VACUUM INTO` 实现（见 lib/store.mjs 的 backupTo）。
 */
export function createBackupRunner({
  store, dataDir, snapshot, now = () => Date.now(), log = () => {},
  prefsKey = BACKUP_PREFS_KEY, lastKey = BACKUP_LAST_KEY,
} = {}) {
  const readPrefs = () => {
    try { return normalizeBackupPrefs(JSON.parse(store.getSync(prefsKey) || 'null')); }
    catch { return normalizeBackupPrefs({}); }
  };
  const readLast = () => {
    try { return JSON.parse(store.getSync(lastKey) || 'null'); } catch { return null; }
  };
  const savePrefs = (patch) => {
    const next = normalizeBackupPrefs({ ...readPrefs(), ...(patch || {}) });
    store.setSync(prefsKey, JSON.stringify(next));
    return next;
  };

  /** 跑一次（`{force}` = 无视节流；`{dryRun}` = 只说会做什么）。 */
  function runOnce({ force = false, dryRun = false, dbMtime = 0 } = {}) {
    const prefs = readPrefs();
    const last = readLast();
    const t = now();
    const due = force ? { ok: true, reason: '' } : shouldBackup({ prefs, last, now: t, dbMtime });
    const dir = backupDirOf(dataDir, prefs);
    const file = join(dir, AUTO_DIRNAME, backupName(t));
    if (!due.ok) return { ok: true, ran: false, reason: due.reason, dir, file, prefs };
    if (dryRun) return { ok: true, ran: false, dry_run: true, reason: '演练：只说了会备份到哪', dir, file, prefs };

    try {
      mkdirSync(join(dir, AUTO_DIRNAME), { recursive: true });
      if (existsSync(file)) return { ok: true, ran: false, reason: '这个分钟已经备过一份了', dir, file, prefs };
      const r = snapshot ? snapshot(file) : { ok: false, error: '没有可用的备份能力' };
      if (!r || r.ok === false) return { ok: false, error: (r && r.error) || '备份失败', dir, file, prefs };
      const bytes = (() => { try { return statSync(file).size; } catch { return 0; } })();
      store.setSync(lastKey, JSON.stringify({ at: t, file, bytes, db_mtime: dbMtime || 0 }));

      // 定期清理：只留最近 keep 份
      const pruned = [];
      for (const name of pickPrunable(listBackups(join(dir, AUTO_DIRNAME)).map((b) => b.name), { keep: prefs.keep })) {
        try { unlinkSync(join(dir, AUTO_DIRNAME, name)); pruned.push(name); } catch { /* 清不掉就留着 */ }
      }
      log(`[backup] 已备份 ${file}（${Math.round(bytes / 1024)} KB）${pruned.length ? `，清掉 ${pruned.length} 份旧的` : ''}`);
      return { ok: true, ran: true, file, bytes, pruned, dir, prefs };
    } catch (e) {
      return { ok: false, error: `备份出错：${(e && e.message) || e}`, dir, file, prefs };
    }
  }

  /** 心跳里调：该跑就跑，出问题只留一行日志（不影响其它功能）。 */
  function maybeRun(opts = {}) {
    try {
      const r = runOnce(opts);
      if (r && r.ok === false) log(`[backup] 跳过：${r.error}`);
      return r;
    } catch (e) {
      log(`[backup] 出错：${(e && e.message) || e}`);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  return { readPrefs, savePrefs, readLast, runOnce, maybeRun, dir: () => backupDirOf(dataDir, readPrefs()) };
}
