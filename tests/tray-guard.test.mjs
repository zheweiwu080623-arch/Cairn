// 托盘看门狗（2026-09-28）：托盘自己救不了自己，让服务反过来盯着它。
//
//   node tests/tray-guard.test.mjs
//
// 背景（实测）：真正会"悄悄死掉"的是托盘，不是服务 —— 当天托盘心跳停过一次，
// 之后几小时里**没有任何看门狗**。这里把"该不该拉起"的判定做成纯函数逐一钉死，
// 并验证 server.mjs 真的把它接上了。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIRM_TICKS, COOLDOWN_MS, EXITED_MARK, STALE_MS, createTrayGuard, decideTrayAction,
} from '../lib/tray-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('tray-guard.test.mjs');

// ---------------- ① 纯决策 ----------------
{
  ok('机器上从没用过托盘 → 不插手', decideTrayAction({ exists: false }) === 'off');
  ok('心跳写着 exited（托盘自己退的）→ 不拉起',
    decideTrayAction({ exists: true, text: EXITED_MARK, ageMs: 10 * STALE_MS }) === 'intentional');
  ok('exited 带换行/空格也算（Windows 写文件会带 CRLF）',
    decideTrayAction({ exists: true, text: 'exited\r\n', ageMs: 10 * STALE_MS }) === 'intentional');
  ok('心跳很新 → 托盘活着', decideTrayAction({ exists: true, text: '2026-09-28T…', ageMs: 20_000 }) === 'alive');
  ok('心跳过期 → 该拉起',
    decideTrayAction({ exists: true, text: '2026-09-28T…', ageMs: STALE_MS + 1 }) === 'respawn');
  ok('刚试过拉起 → 冷却期内不连环拉',
    decideTrayAction({ exists: true, text: 'x', ageMs: STALE_MS + 1, sinceSpawnMs: COOLDOWN_MS - 1 }) === 'cooldown');
  ok('冷却过了 → 还会再试一次',
    decideTrayAction({ exists: true, text: 'x', ageMs: STALE_MS + 1, sinceSpawnMs: COOLDOWN_MS + 1 }) === 'respawn');
  ok('时间取不到（NaN）不崩，当成"活着"（宁可不动手）',
    decideTrayAction({ exists: true, text: 'x', ageMs: Number.NaN }) === 'alive');
  ok('边界：正好等于阈值算过期（>= 就动手）',
    decideTrayAction({ exists: true, text: 'x', ageMs: STALE_MS }) === 'respawn');
  // 2026-09-29 加：休眠刚醒时不该立刻换托盘
  ok('过期但只看到一次 → pending（先确认，别急着换）',
    decideTrayAction({ exists: true, text: 'x', ageMs: STALE_MS + 1, staleStreak: 1 }) === 'pending');
  ok('连着两次都过期（同一段心跳）→ respawn',
    decideTrayAction({ exists: true, text: 'x', ageMs: STALE_MS + 1, staleStreak: CONFIRM_TICKS }) === 'respawn');
}

// ---------------- ①b 「睡一觉醒来别误杀」（2026-09-29 实测：一天换了 5 次托盘） ----------------
{
  // 机器休眠时所有线程一起冻住，心跳必然"过期很久"。醒来第一次 tick 应该只"确认"，
  // 等托盘 20 秒内把心跳写回来，第二次 tick 看到新鲜的 → 什么都不做。
  const h = makeGuard();
  h.setLauncher();
  h.setBeat('2026-09-29T09:42:00.0000000+08:00', 400_000);   // 像刚从休眠醒来：停了 400 秒
  ok('刚睡醒（第一次看到过期）→ 只 pending，不换托盘',
    h.guard.tick() === 'pending' && h.spawned.length === 0);
  ok('日志里说清是"先确认一次"（用户能在 server.log 里看到）',
    h.logs.some((l) => l.includes('先确认一次')));

  // 托盘醒了，写了新心跳（mtime 变新）
  h.setBeat('2026-09-29T09:49:00.0000000+08:00', 5_000);
  ok('托盘自己写回心跳 → alive，什么都不做',
    h.guard.tick() === 'alive' && h.spawned.length === 0);

  // 再来一次"睡醒"：仍然是先确认
  h.setBeat('2026-09-29T09:49:00.0000000+08:00', 600_000);
  ok('第二次睡醒 → 还是先 pending（不会因为"之前 pending 过"就动手）',
    h.guard.tick() === 'pending' && h.spawned.length === 0);

  // 但如果是**真的死了**（心跳一直是同一段、再也没动）：连确认两次就动手
  h.advance(61_000);
  ok('同一段过期心跳再看一次 → respawn（真死了要救）',
    h.guard.tick() === 'respawn' && h.spawned.length === 1);
  ok('拉起这件事仍然写进日志（说的是「换一个」）',
    h.logs.some((l) => l.includes('换一个')));
}

// ---------------- ② 注入式跑一轮 ----------------
function makeGuard(opts = {}) {
  const spawned = [];
  const logs = [];
  let clock = 1_000_000_000_000;
  const files = new Map();       // path -> { text, mtimeMs }
  const guard = createTrayGuard({
    dataDir: 'D:\\data',
    repoDir: 'D:\\repo',
    platform: 'win32',
    env: {},
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p).text,
    stat: (p) => ({ mtimeMs: files.get(p).mtimeMs }),
    spawnFn: (cmd, args, o) => { spawned.push({ cmd, args, o }); return { unref() {} }; },
    now: () => clock,
    log: (m) => logs.push(m),
    ...opts,
  });
  return {
    guard, spawned, logs, files,
    setBeat(text, ageMs) { files.set(guard.beatPath, { text, mtimeMs: clock - ageMs }); },
    setLauncher(v = true) { if (v) files.set(guard.launcher, { text: '', mtimeMs: clock }); else files.delete(guard.launcher); },
    setRestarter(v = true) { if (v) files.set(guard.restarter, { text: '', mtimeMs: clock }); else files.delete(guard.restarter); },
    advance(ms) { clock += ms; },
    /** 走完"连续确认"：第一拍 pending → 过一分钟 → 第二拍（返回两拍的结果）。 */
    confirmStale() {
      const first = this.guard.tick();
      this.advance(61_000);
      const second = this.guard.tick();
      return { first, second };
    },
  };
}

{
  const h = makeGuard();
  h.setLauncher();
  ok('没有心跳文件 → off，且不 spawn', h.guard.tick() === 'off' && h.spawned.length === 0);

  h.setBeat('2026-09-28T10:00:00.0000000+08:00', 15_000);
  ok('心跳新鲜 → alive，不 spawn', h.guard.tick() === 'alive' && h.spawned.length === 0);

  h.setBeat('2026-09-28T10:00:00.0000000+08:00', STALE_MS + 60_000);
  ok('心跳过期第一拍 → 先 pending（连续确认：睡醒时不误杀）',
    h.guard.tick() === 'pending' && h.spawned.length === 0);
  h.advance(61_000);
  ok('同一段过期心跳再看一次 → respawn', h.guard.tick() === 'respawn');
  ok('主流路径是 wscript.exe + start-tray.vbs（隐藏窗口、脱离父进程）',
    h.spawned.length === 1 && h.spawned[0].cmd === 'wscript.exe'
    && h.spawned[0].args[0] === h.guard.launcher
    && h.spawned[0].o.detached === true && h.spawned[0].o.windowsHide === true,
    JSON.stringify(h.spawned[0] && h.spawned[0].args));
  ok('拉起这件事写进了日志（用户能在 server.log 里看到）',
    h.logs.some((l) => l.includes('tray-guard') && l.includes('换一个')));

  ok('紧接着再来一轮 → cooldown（不连环开进程）',
    h.guard.tick() === 'cooldown' && h.spawned.length === 1);

  h.advance(COOLDOWN_MS + 1000);
  ok('冷却过了还在过期 → 再拉一次', h.guard.tick() === 'respawn' && h.spawned.length === 2);

  h.advance(COOLDOWN_MS + 1000);
  h.setLauncher(false);
  ok('两个启动器都找不到 → 不假装成功，如实记 no-launcher',
    h.guard.tick() === 'no-launcher' && h.spawned.length === 2
    && h.logs.some((l) => l.includes('既没有 tray.ps1 也没有 start-tray.vbs')));
}

// ---------------- ②b 「换一个」而不是「再加一个」+ 退路 + 静默失败（2026-09-28） ----------------
{
  // 没有 start-tray.vbs 时退到 tray.ps1 -Action restart
  const h = makeGuard();
  h.setRestarter();
  h.setBeat('2026-09-28T10:00:00.0000000+08:00', STALE_MS + 1);
  ok('找不到 start-tray.vbs → 退到 tray.ps1 -Action restart（它会先收掉旧托盘）',
    h.confirmStale().second === 'respawn' && h.spawned.length === 1 && h.spawned[0].cmd === 'powershell.exe'
    && h.spawned[0].args.includes(h.guard.restarter) && h.spawned[0].args.at(-1) === 'restart',
    JSON.stringify(h.spawned[0] && h.spawned[0].args));
}
{
  // 两个启动器都在时，**主路径是 start-tray.vbs**（实测更可靠那条）
  const h = makeGuard();
  h.setLauncher(); h.setRestarter();
  h.setBeat('2026-09-28T10:00:00.0000000+08:00', STALE_MS + 1);
  h.confirmStale();
  ok('两个启动器都在 → 走 start-tray.vbs（把"换"交给新托盘的接管逻辑）',
    h.spawned.length === 1 && h.spawned[0].cmd === 'wscript.exe');
  ok('日志说明了"新托盘会收掉更早那个"', h.logs.some((l) => l.includes('收掉更早那个')));
}
{
  // spawn 的 error 事件必须被接住（否则"命令起不来"就是静默失败 —— 2026-09-28 真撞上过）
  const logs = [];
  const h = makeGuard({
    log: (m) => logs.push(m),
    spawnFn: () => {
      const fake = { unref() {}, on(evt, fn) { if (evt === 'error') setTimeout(() => fn(new Error('spawn powershell.exe ENOENT')), 0); } };
      return fake;
    },
  });
  h.setLauncher(); h.setBeat('x', STALE_MS + 1);
  ok('spawn 失败不再是静默的', h.confirmStale().second === 'respawn');
  await new Promise((r) => setTimeout(r, 10));
  ok('起不来会写进日志（含原因）', logs.some((l) => l.includes('起不来') && l.includes('ENOENT')), JSON.stringify(logs.slice(-2)));
}

{
  const h = makeGuard({ platform: 'darwin', spawnFn: () => { throw new Error('不该被调用'); } });
  h.setLauncher(); h.setBeat('x', STALE_MS + 1);
  ok('macOS 上不插手（那边的存活由 LaunchAgent KeepAlive 管）', h.guard.tick() === 'off');
}
{
  const h = makeGuard({ env: { PLANNER_TRAY_GUARD: '0' } });
  h.setLauncher(); h.setBeat('x', STALE_MS + 1);
  ok('PLANNER_TRAY_GUARD=0 → 明确关掉这个兜底', h.guard.tick() === 'off' && h.spawned.length === 0);
}
{
  const h = makeGuard({ spawnFn: () => { throw new Error('wscript 起不来'); } });
  h.setLauncher(); h.setBeat('x', STALE_MS + 1);
  ok('拉起失败如实记 spawn-failed（不崩、不假装）',
    h.confirmStale().second === 'spawn-failed' && h.logs.some((l) => l.includes('拉起托盘失败')));
}
{
  const h = makeGuard();
  h.setLauncher(); h.setBeat(EXITED_MARK, STALE_MS * 10);
  ok('托盘是自己退出的 → 永远不自动拉起', h.guard.tick() === 'intentional' && h.spawned.length === 0);
}

// ---------------- ③ 接线（server.mjs / tray.ps1） ----------------
{
  const srv = read('server.mjs');
  ok('server.mjs 真的创建并启动了托盘看门狗',
    srv.includes("import { createTrayGuard } from './lib/tray-guard.mjs'")
    && srv.includes('createTrayGuard({ dataDir: DATA_DIR, repoDir: __dir')
    && srv.includes('trayGuard.start()'));
  const tray = read('tray.ps1');
  ok('托盘退出时写 exited 标记 + 记原因（两处都在）',
    tray.includes("$script:BeatExitedMark = 'exited'")
    && tray.includes('托盘退出（未捕获异常）')
    && tray.includes('Set-Content -LiteralPath $beatPath -Value $script:BeatExitedMark'));
  ok('单实例判断认 exited（否则新托盘会被旧标记挡回去）',
    tray.includes('eq $script:BeatExitedMark) { return $false }'));
  // 2026-09-28 实测攒出三个图标之后补的三条：
  ok('接管时**真的**收掉更早的托盘进程（不再只改写 tray.pid）',
    tray.includes('function Get-OlderTrayProcesses')
    && tray.includes('Stop-Process -Id $o.Id -Force')
    && tray.includes('只结束比我先启动的'));
  ok('心跳交给独立线程写（UI 线程卡住也不会停跳）',
    tray.includes('public sealed class CairnTrayBeat')
    && tray.includes('$script:beat.Start($beatPath, 20000)')
    && tray.includes('已交给独立线程'));
  ok('退出前先停心跳线程，再写 exited（不然标记会被覆盖）',
    /if \(\$script:beat\) \{ \$script:beat\.Stop\(\) \}/.test(tray)
    && tray.indexOf('$script:beat.Stop()') < tray.indexOf("$script:BeatExitedMark -Encoding ascii"));
  ok('心跳写失败/停跳会留日志（不再是静默 catch）',
    tray.includes('写心跳失败：') && tray.includes('心跳异常：已经'));
  ok('接管原因如实分开写（进程没了 / 心跳文件没了 / 标了退出 / 心跳停了）',
    tray.includes('function Get-TrayTakeoverReason')
    && tray.includes('已经不在了') && tray.includes('心跳文件不见了')
    && tray.includes('标了「已退出」') && tray.includes('的心跳停了'));
}

console.log('');
console.log(failures === 0 ? 'tray-guard.test: PASS' : `tray-guard.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
