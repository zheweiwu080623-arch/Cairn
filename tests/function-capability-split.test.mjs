// 「功能模块 / 能力模块」两层拆分的结构闸门（2026-09-26）。
//
//   node tests/function-capability-split.test.mjs
//
// 判据（来自用户的要求）：
//   * 能力：新写一段程序 + 单立的能力文件夹，**不改内核、不改主程序**；
//   * 功能：主菜单上的每一项都是功能，能被挑、能被排序；
//   * 两层各住各的地方，谁也别往内核里长。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAPABILITIES, IMPL_DIR, getCapability } from '../lib/capabilities/index.mjs';
import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import { CORE_FUNCTIONS, listFunctions } from '../lib/functions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('function-capability-split.test.mjs');

// ---------- ① 能力侧：一条能力 = 一个文件 ----------
{
  const files = readdirSync(IMPL_DIR).filter((f) => f.endsWith('.mjs'));
  ok('能力住在 lib/capabilities/impl/ 下，一个文件一条', files.length === 10 && CAPABILITIES.length === 10,
    `${files.length} 文件 / ${CAPABILITIES.length} 条`);
  ok('文件名就是能力 id（域.动作.mjs）',
    CAPABILITIES.every((c) => c.file === `${c.id}.mjs`), CAPABILITIES.map((c) => c.file).join(', '));
  ok('每条能力自己带 meta + bind + run（宿主不再有手写适配表）',
    CAPABILITIES.every((c) => c.run && typeof c.run === 'function' && c.bind));
  const hostSrc = read('lib/capabilities/host.mjs');
  ok('宿主的调用就是 cap.run(input, ctx)，没有第二张"适配表"',
    hostSrc.includes('cap.run(input || {}, c)'));
  ok('能力可以直接跑（不经过任何功能模块）', getCapability('prefs.read') && typeof getCapability('prefs.read').run === 'function');
  // 真的跑一条：拿假提供者装一个宿主，调 course.text
  const host = createCapabilityHost({ providers: { course: () => ({ course: { read: () => ({ materials: [{ name: 'a.pdf' }] }), search: () => [{ segment: 2 }] } }) } });
  const r = await host.invoke('course.text', { courses: [] });
  ok('宿主按能力文件跑出产出', r.ok === true && Array.isArray(r.output.materials), JSON.stringify(r).slice(0, 120));
}

// ---------- ② 功能侧：主菜单每一项都是功能 ----------
{
  const fns = listFunctions({ modules: [
    { id: 'course-assist-view', kind: 'view', name: '课程辅助', icon: '📚' },
    { id: 'flow-builder', kind: 'view', name: '能力搭建', icon: '🧩' },
    { id: 'settings', kind: 'view', name: '设置', icon: '⚙️' },          // 不是功能
    { id: 'onboarding', kind: 'view', name: '五步上手', boot: true },     // 不是功能
    { id: 'broken', kind: 'view', name: '坏的', error: '坏了' },          // 坏的不进清单
  ] });
  const ids = fns.map((f) => f.id);
  ok('核心页（今日/日程/任务/养成/通知/统计/音乐）都在功能清单里',
    ['today', 'calendar', 'tasks', 'habits', 'notifications', 'stats', 'music'].every((id) => ids.includes(id)), ids.join(','));
  ok('插件功能也在（课程辅助 / 能力搭建）', ids.includes('course-assist-view') && ids.includes('flow-builder'));
  ok('「设置」「五步上手」不算可选功能', !ids.includes('settings') && !ids.includes('onboarding'));
  ok('坏模块不进清单', !ids.includes('broken'));
  ok('「今日」是落地页（不可取消），其余都能取消',
    CORE_FUNCTIONS.find((f) => f.id === 'today').always === true
    && fns.find((f) => f.id === 'calendar').installable === true);
}

// ---------- ③ 边界：主程序 / 内核里不许藏能力实现 ----------
{
  const app = read('public/app.js');
  ok('主程序不知道具体能力（没有 canvas.course.check / course.text 这种字面量）',
    !app.includes('canvas.course.check') && !app.includes("'course.text'"));
  const routes = readdirSync(join(ROOT, 'lib', 'routes')).filter((f) => f.endsWith('.mjs'));
  const leaks = routes.filter((f) => /canvas\.course\.check|course\.text|dedupe\.filterNew/.test(read(`lib/routes/${f}`)));
  ok('路由层里也没有把能力写死（全靠注册表）', leaks.length === 0, leaks.join(', '));
  ok('能力层对外只有一个出口（lib/capabilities/index.mjs）',
    existsSync(join(ROOT, 'lib', 'capabilities', 'index.mjs')) && existsSync(join(ROOT, 'lib', 'capabilities', 'host.mjs')));
}

console.log('');
console.log(failures === 0 ? 'function-capability-split.test: PASS' : `function-capability-split.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
