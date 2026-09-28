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
  COOLDOWN_MS, EXITED_MARK, STALE_MS, createTrayGuard, decideTrayAction,
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
    advance(ms) { clock += ms; },
  };
}

{
  const h = makeGuard();
  h.setLauncher();
  ok('没有心跳文件 → off，且不 spawn', h.guard.tick() === 'off' && h.spawned.length === 0);

  h.setBeat('2026-09-28T10:00:00.0000000+08:00', 15_000);
  ok('心跳新鲜 → alive，不 spawn', h.guard.tick() === 'alive' && h.spawned.length === 0);

  h.setBeat('2026-09-28T10:00:00.0000000+08:00', STALE_MS + 60_000);
  ok('心跳过期 → respawn', h.guard.tick() === 'respawn');
  ok('拉起用的是 wscript.exe + start-tray.vbs（隐藏窗口、脱离父进程）',
    h.spawned.length === 1 && h.spawned[0].cmd === 'wscript.exe'
    && h.spawned[0].args[0] === h.guard.launcher
    && h.spawned[0].o.detached === true && h.spawned[0].o.windowsHide === true,
    JSON.stringify(h.spawned[0] && h.spawned[0].args));
  ok('拉起这件事写进了日志（用户能在 server.log 里看到）',
    h.logs.some((l) => l.includes('tray-guard') && l.includes('拉起')));

  ok('紧接着再来一轮 → cooldown（不连环开进程）',
    h.guard.tick() === 'cooldown' && h.spawned.length === 1);

  h.advance(COOLDOWN_MS + 1000);
  ok('冷却过了还在过期 → 再拉一次', h.guard.tick() === 'respawn' && h.spawned.length === 2);

  h.advance(COOLDOWN_MS + 1000);
  h.setLauncher(false);
  ok('找不到 start-tray.vbs → 不假装成功，如实记 no-launcher',
    h.guard.tick() === 'no-launcher' && h.spawned.length === 2
    && h.logs.some((l) => l.includes('找不到 start-tray.vbs')));
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
    h.guard.tick() === 'spawn-failed' && h.logs.some((l) => l.includes('拉起托盘失败')));
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
}

console.log('');
console.log(failures === 0 ? 'tray-guard.test: PASS' : `tray-guard.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
