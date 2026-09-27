// 后台心跳（调度层）的验证：搬出主程序之后，行为要**一字不差**。
//
//   node tests/notify-tick.test.mjs
//
// 用假时钟 + 假任务，不用真等 4 秒、不用起服务。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTickRunner } from '../lib/notify-tick.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('notify-tick.test.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const mkLog = () => { const lines = []; return { lines, log: (m) => lines.push(String(m)), warn: (m) => lines.push('WARN ' + String(m)) }; };

// ---------------- 1. 一轮里做完该做的事 ----------------
{
  const { lines, log, warn } = mkLog();
  const ran = [];
  let clock = 1000;
  const tick = createTickRunner({
    now: () => clock, log, warn,
    fireReminders: async () => ['n1', 'n2'],
    jobs: [
      { name: 'always', due: () => true, run: async () => { ran.push('always'); return { note: '干完了' }; } },
      { name: 'never', due: () => false, run: async () => { ran.push('never'); } },
      { name: 'boom', due: () => true, run: async () => { ran.push('boom'); throw new Error('炸了'); } },
      { name: 'after', due: () => true, run: async () => ran.push('after') },
    ],
  });
  const out = await tick.tickOnce();
  ok('提醒触发了就记一笔，并打一行日志', out.fired.length === 2 && lines.some((l) => l.includes('2 条提醒已触发')));
  ok('该跑的按顺序都跑了', JSON.stringify(ran) === JSON.stringify(['always', 'boom', 'after']), JSON.stringify(ran));
  ok('不该跑的记在 skipped 里（不是"忘了"）', JSON.stringify(out.skipped) === JSON.stringify(['never']));
  ok('一个任务炸了不影响后面的任务（这条最要紧）',
    ran.includes('after') && out.errors.some(([n]) => n === 'boom'));
  ok('任务自己写的 note 会打出来', lines.some((l) => l.includes('[always] 干完了')));
  ok('错误只留一行日志，不往上抛', lines.some((l) => l.startsWith('WARN') && l.includes('[boom]')));
}

// ---------------- 2. 提醒那一步炸了，也不影响后面的任务 ----------------
{
  const { log, warn } = mkLog();
  let ran = false;
  const tick = createTickRunner({
    log, warn,
    fireReminders: async () => { throw new Error('通知表读不到'); },
    jobs: [{ name: 'job', due: () => true, run: async () => { ran = true; } }],
  });
  const out = await tick.tickOnce();
  ok('提醒出错 → 照样往下跑任务', ran === true && out.errors.some(([n]) => n === 'reminders'));
}

// ---------------- 3. 心跳日志：每小时一行，不是每轮一行 ----------------
{
  const { log, warn } = mkLog();
  let clock = 0;
  const beats = [];
  const tick = createTickRunner({
    now: () => clock, log, warn, heartbeat: (info) => beats.push(info),
    jobs: [],
  });
  await tick.tickOnce();                       // 第 1 轮：距启动 0 分钟，不写
  clock = 10 * 60000;
  await tick.tickOnce();                       // 10 分钟：还不写
  clock = 61 * 60000;
  await tick.tickOnce();                       // 61 分钟：写一行
  clock = 62 * 60000;
  await tick.tickOnce();                       // 62 分钟：刚写过，不写
  ok('心跳每小时一行（不是每轮都刷日志）', beats.length === 1, String(beats.length));
  ok('心跳里带上"已运行多少分钟"', beats[0].uptime_minutes === 61, JSON.stringify(beats[0]));
}

// ---------------- 4. 出错也要排下一轮（否则心跳会静默死掉） ----------------
{
  const { log, warn } = mkLog();
  const pending = [];
  let cleared = 0;
  const tick = createTickRunner({
    log, warn,
    timers: { set: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clear: () => { cleared += 1; } },
    jobs: [{ name: 'boom', due: () => true, run: async () => { throw new Error('x'); } }],
  });
  tick.start();
  ok('start() 会排一轮', pending.length === 1 && pending[0].ms === 4000 && tick.hasTimer());
  await pending.shift().fn();                   // 跑一轮（里面会再排一轮）
  ok('跑完一轮之后又排上了下一轮（哪怕这一轮有任务炸了）', pending.length === 1);
  await pending.shift().fn();
  ok('连续两轮都活着', pending.length === 1);
  tick.stop();
  ok('stop() 之后没有定时器了', tick.hasTimer() === false && cleared > 0);
}

// ---------------- 5. 判断"该不该跑"时出错，跳过这个任务、继续下一个 ----------------
{
  const { log, warn } = mkLog();
  let after = false;
  const tick = createTickRunner({
    log, warn,
    jobs: [
      { name: 'bad-due', due: () => { throw new Error('due 坏了'); }, run: async () => {} },
      { name: 'ok', due: () => true, run: async () => { after = true; } },
    ],
  });
  const out = await tick.tickOnce();
  ok('due 抛异常 → 这个任务跳过，后面的照跑', after === true && out.errors.some(([n]) => n === 'bad-due'));
}

// ---------------- 6. 主程序接线守卫 ----------------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const src = readFileSync(join(ROOT, 'lib', 'notify-tick.mjs'), 'utf8');
  ok('主程序只留一张 jobs 清单（调度逻辑在 lib/notify-tick.mjs）',
    srv.includes("from './lib/notify-tick.mjs'") && srv.includes('jobs: [') && srv.includes('tick.start()'));
  ok('清单里那些"到点自动做的事"都还在（没在搬家时漏掉）',
    ['autosync', 'canvas-watch', 'semantic', 'digest', 'autopush', 'preclass', 'icloud', 'course-sync', 'backup']
      .every((n) => srv.includes(`name: '${n}'`)),
    JSON.stringify(['autosync', 'canvas-watch', 'semantic', 'digest', 'autopush', 'preclass', 'icloud', 'course-sync', 'backup'].filter((n) => !srv.includes(`name: '${n}'`))));
  ok('旧的定时器/心跳状态变量已经清掉（不留两套心跳）',
    !srv.includes('notifTimer') && !srv.includes('LAST_HEARTBEAT_TS') && !srv.includes('setNextTick'));
  ok('调度层不 import 主程序的东西（只吃注入的依赖）',
    !/from '\.\.\/server\.mjs'/.test(src) && !src.includes("from './store.mjs'"));
  ok('主程序的行数护栏重新有余量（<2200，且比修改前更小）',
    srv.split('\n').length < 2200, String(srv.split('\n').length));
}

console.log('');
console.log(failures === 0 ? 'notify-tick.test: PASS' : `notify-tick.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
