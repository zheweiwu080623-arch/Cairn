// tray-guard.mjs —— 服务端反过来盯着"托盘"（看门狗自己也得有人看着）。
//
// 为什么需要它（2026-09-28 实测）：
//   这个应用里真正会"悄悄死掉"的是**托盘**，不是服务 —— `data/tray.log` 显示当天
//   托盘心跳停过一次，直到有人手动再开一个托盘才恢复（日志原文「发现旧的托盘记录
//   （心跳已停）：接管」）；而托盘不在的那几个小时里，服务是**没有看门狗**的
//   （服务真崩了就没人拉）。托盘又看不了自己（进程没了就什么都没了），
//   所以让更稳的那一方 —— 服务（node）—— 反过来看着托盘。
//
// 判定规则（纯函数，离线可测）：
//   · 没有 data/tray.heartbeat   → 这台机器从没用过托盘，不插手
//   · 心跳内容是 'exited'        → 托盘是**自己退出的**（用户主动），不拉起
//   · 心跳是时间戳但已过期        → 托盘死了 → 拉起
//   · 心跳还很新                 → 托盘活着
//   · 刚试过拉起（冷却期内）      → 先等着，别连环拉
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const EXITED_MARK = 'exited';
/** 心跳超过 3 分钟没更新就算死了（托盘每 20 秒写一次，容错很大）。 */
export const STALE_MS = 180_000;
/** 一次拉起之后 5 分钟内不再试（拉不起来时别刷屏、别连环开进程）。 */
export const COOLDOWN_MS = 300_000;
export const HEARTBEAT_FILE = 'tray.heartbeat';

/**
 * 纯决策：现在该对托盘做什么？
 * @returns {'off'|'intentional'|'alive'|'cooldown'|'respawn'}
 */
export function decideTrayAction({
  exists = false, text = '', ageMs = Number.POSITIVE_INFINITY,
  sinceSpawnMs = Number.POSITIVE_INFINITY, staleMs = STALE_MS, cooldownMs = COOLDOWN_MS,
} = {}) {
  if (!exists) return 'off';                       // 从没用过托盘 → 不插手
  if (String(text).trim() === EXITED_MARK) return 'intentional';
  if (!(ageMs >= staleMs)) return 'alive';         // NaN/新鲜都算活着
  if (sinceSpawnMs < cooldownMs) return 'cooldown';
  return 'respawn';
}

/**
 * 每分钟看一眼心跳；该拉就拉。
 * 所有外部动作都能注入（spawn / 读文件 / 取时间），所以逻辑能在任何平台离线测。
 */
export function createTrayGuard({
  dataDir = '', repoDir = '', platform = process.platform, env = process.env,
  intervalMs = 60_000,
  exists = existsSync, readFile = (p) => readFileSync(p, 'utf8'), stat = statSync,
  spawnFn = spawn, now = () => Date.now(), log = () => {}, setTimer = setInterval,
} = {}) {
  const beatPath = dataDir ? join(dataDir, HEARTBEAT_FILE) : '';
  const launcher = repoDir ? join(repoDir, 'start-tray.vbs') : '';
  let lastSpawnMs = Number.NEGATIVE_INFINITY;
  let timer = null;

  /** 跑一轮，返回决策（测试直接调它）。 */
  function tick() {
    if (platform !== 'win32') return 'off';          // 只有 Windows 有托盘
    if (String(env.PLANNER_TRAY_GUARD || '') === '0') return 'off';
    if (!beatPath) return 'off';

    const has = exists(beatPath);
    let text = '';
    let ageMs = Number.POSITIVE_INFINITY;
    if (has) {
      try { text = String(readFile(beatPath) || ''); } catch { text = ''; }
      try { ageMs = now() - stat(beatPath).mtimeMs; } catch { ageMs = Number.POSITIVE_INFINITY; }
    }

    const action = decideTrayAction({
      exists: has, text, ageMs, sinceSpawnMs: now() - lastSpawnMs,
    });
    if (action !== 'respawn') return action;

    if (!launcher || !exists(launcher)) {
      lastSpawnMs = now();
      log('[tray-guard] 托盘心跳过期了，但找不到 start-tray.vbs，跳过');
      return 'no-launcher';
    }
    lastSpawnMs = now();
    try {
      const child = spawnFn('wscript.exe', [launcher], { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && typeof child.unref === 'function') child.unref();
      log(`[tray-guard] 托盘心跳已过期（${Math.round(ageMs / 1000)} 秒没更新）→ 已尝试把它重新拉起`);
      return 'respawn';
    } catch (e) {
      log('[tray-guard] 拉起托盘失败：' + (e && e.message));
      return 'spawn-failed';
    }
  }

  function start() {
    if (timer || platform !== 'win32') return false;
    if (String(env.PLANNER_TRAY_GUARD || '') === '0') return false;
    timer = setTimer(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log(`[tray-guard] 已开启：每 ${Math.round(intervalMs / 1000)} 秒看一次托盘心跳，过期 ${Math.round(STALE_MS / 1000)} 秒就把它重新拉起`);
    return true;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, start, stop, beatPath, launcher };
}
