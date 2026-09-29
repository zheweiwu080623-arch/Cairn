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
/**
 * 心跳过期要**连续看到几次**才动手（2026-09-29 加）。
 *
 * 为什么：这台笔记本一天里会睡好几次（上课路上合盖）。**休眠时谁都写不了心跳**
 * （所有线程一起冻住），醒来第一次 tick 看到的就是一段"过期很久"的心跳 ——
 * 旧规则立刻把**还活着的**托盘换掉：2026-09-29 一天换了 5 次
 * （09:48 / 09:56 / 12:07 / 15:55 / 18:14），每次都收掉一个健康托盘、还顺带多拉一次服务。
 * 现在要求"下一次 tick 心跳还是没动"才动手 —— 睡醒后托盘 20 秒内就会重新写心跳，
 * 于是第二次 tick 看到的是新鲜的，不动手。
 */
export const CONFIRM_TICKS = 2;
export const HEARTBEAT_FILE = 'tray.heartbeat';

/**
 * 纯决策：现在该对托盘做什么？
 * `staleStreak` = "连续第几次看到同一段过期心跳"（由 createTrayGuard 数），
 * 默认按"已经确认过"处理，方便直接调用这个纯函数的地方（测试、诊断脚本）。
 * @returns {'off'|'intentional'|'alive'|'cooldown'|'pending'|'respawn'}
 */
export function decideTrayAction({
  exists = false, text = '', ageMs = Number.POSITIVE_INFINITY,
  sinceSpawnMs = Number.POSITIVE_INFINITY, staleMs = STALE_MS, cooldownMs = COOLDOWN_MS,
  staleStreak = CONFIRM_TICKS, confirmTicks = CONFIRM_TICKS,
} = {}) {
  if (!exists) return 'off';                       // 从没用过托盘 → 不插手
  if (String(text).trim() === EXITED_MARK) return 'intentional';
  if (!(ageMs >= staleMs)) return 'alive';         // NaN/新鲜都算活着
  if (sinceSpawnMs < cooldownMs) return 'cooldown';
  if (staleStreak < confirmTicks) return 'pending'; // 先确认一次（大概刚睡醒），别急着换
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
  const restarter = repoDir ? join(repoDir, 'tray.ps1') : '';
  let lastSpawnMs = Number.NEGATIVE_INFINITY;
  let timer = null;
  // 「连续确认」用：上一次看到过期心跳时的 mtime，以及连续第几次
  // （mtime 变了就说明托盘又活过来了 —— 睡醒后它 20 秒内就会写一次）
  let lastStaleMtime = null;
  let staleStreak = 0;

  /**
   * 把托盘拉起来。**优先"换一个"而不是"再加一个"**（2026-09-28 修"三个图标"那次）：
   * 旧版只 `spawn start-tray.vbs`，而托盘自己又只按心跳判断单实例 ——
   * 于是"进程活着但心跳停了"的托盘会被留在那里，图标一个接一个攒（实测攒到 3 个）。
   *
   * 现在"换"这件事由**新托盘自己的接管逻辑**保证（tray.ps1 里 `Get-OlderTrayProcesses`
   * 会收掉更早的托盘进程，2026-09-28 实测：3 个 → 1 个）。
   * 启动器顺序按"实测哪条更稳"排：
   *   ① `start-tray.vbs`（wscript 拉起，装了这么久一直可靠）；
   *   ② `tray.ps1 -Action restart`（它会先结束 tray.pid 里的旧托盘再拉新的）—— ① 不在时才用。
   * 为什么把 ② 降到退路：2026-09-28 实测过，服务端用 detached 方式 spawn ② 时，
   * 有一次它**什么都没做就退出**了（托盘没起来、日志里也没有一行），事后三种起法又都能起来 ——
   * 查不出确定原因的那种失败，不该放在主路径上。
   *
   * 另外：spawn 的 `error` 事件一定要接住 —— 那是"命令根本不存在/起不来"的唯一提示，
   * 不接就等于静默失败（这一条 2026-09-28 真的撞上过）。
   */
  function spawnTray(ageMs) {
    const mins = Math.round(ageMs / 1000);
    const watch = (child) => {
      if (child && typeof child.on === 'function') {
        child.on('error', (e) => log(`[tray-guard] 拉起托盘的进程起不来：${(e && e.message) || e}`));
      }
      if (child && typeof child.unref === 'function') child.unref();
    };
    if (launcher && exists(launcher)) {
      watch(spawnFn('wscript.exe', [launcher], { detached: true, stdio: 'ignore', windowsHide: true }));
      log(`[tray-guard] 托盘心跳已过期（${mins} 秒没更新）→ 已请求**换一个**托盘（新托盘的接管逻辑会收掉更早那个，不会多留图标）`);
      return 'respawn';
    }
    if (restarter && exists(restarter)) {
      watch(spawnFn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', restarter, '-Action', 'restart',
      ], { detached: true, stdio: 'ignore', windowsHide: true }));
      log(`[tray-guard] 托盘心跳已过期（${mins} 秒没更新）→ 已请求重启托盘（走 tray.ps1 -Action restart；找不到 start-tray.vbs 时的退路）`);
      return 'respawn';
    }
    return 'no-launcher';
  }

  /** 跑一轮，返回决策（测试直接调它）。 */
  function tick() {
    if (platform !== 'win32') return 'off';          // 只有 Windows 有托盘
    if (String(env.PLANNER_TRAY_GUARD || '') === '0') return 'off';
    if (!beatPath) return 'off';

    const has = exists(beatPath);
    let text = '';
    let ageMs = Number.POSITIVE_INFINITY;
    let mtimeMs = null;
    if (has) {
      try { text = String(readFile(beatPath) || ''); } catch { text = ''; }
      try {
        mtimeMs = stat(beatPath).mtimeMs;
        ageMs = now() - mtimeMs;
      } catch { ageMs = Number.POSITIVE_INFINITY; }
    }
    // 数「连续第几次看到同一段过期心跳」：mtime 一动就归零（说明托盘又写上了）
    const staleNow = has && String(text).trim() !== EXITED_MARK && ageMs >= STALE_MS;
    if (staleNow) {
      staleStreak = (mtimeMs !== null && mtimeMs === lastStaleMtime) ? staleStreak + 1 : 1;
      lastStaleMtime = mtimeMs;
    } else {
      staleStreak = 0;
      lastStaleMtime = null;
    }

    const action = decideTrayAction({
      exists: has, text, ageMs, sinceSpawnMs: now() - lastSpawnMs, staleStreak,
    });
    if (action === 'pending') {
      log(`[tray-guard] 托盘心跳过期（${Math.round(ageMs / 1000)} 秒没更新）—— 先确认一次再动手（刚睡醒时谁都写不了心跳）`);
      return action;
    }
    if (action !== 'respawn') return action;

    lastSpawnMs = now();
    try {
      const r = spawnTray(ageMs);
      if (r === 'no-launcher') log('[tray-guard] 托盘心跳过期了，但既没有 tray.ps1 也没有 start-tray.vbs，跳过');
      return r;
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
    log(`[tray-guard] 已开启：每 ${Math.round(intervalMs / 1000)} 秒看一次托盘心跳；过期 ${Math.round(STALE_MS / 1000)} 秒后**再确认一次**（连续 ${CONFIRM_TICKS} 次），确认还停着才换一个`);
    return true;
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, start, stop, beatPath, launcher, restarter };
}
