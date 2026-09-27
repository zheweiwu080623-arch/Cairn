// 显示层接线自检（2026-09-20 新增）
//
//   node tests/vm-bridge.test.mjs
//
// 防的是一种很隐蔽的坏味道：vm-bridge.js 里 `import { notificationsSelection }`
// 写了，但忘了把它写进 `window.PlannerVM = { ... }` 的对象字面量。
// 这时文件里"出现过这个名字"，只检查字符串的断言全部通过，
// 但页面运行到那一刻会直接取数失败（window.PlannerVM.xxx is not a function）。
//
// 所以这里不看字符串，而是三向对齐：
//   1) app.js 里实际用到的 window.PlannerVM.<名字>
//   2) vm-bridge.js 真正挂载的名字
//   3) viewmodel.js 真正导出的名字

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as viewmodel from '../public/viewmodel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const appSrc = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
const bridgeSrc = readFileSync(join(ROOT, 'public/vm-bridge.js'), 'utf8');

const used = new Set([...appSrc.matchAll(/window\.PlannerVM\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

const literal = /window\.PlannerVM\s*=\s*\{([\s\S]*?)\};/.exec(bridgeSrc);
if (!literal) {
  console.error('找不到 window.PlannerVM = { ... } —— vm-bridge.js 结构变了');
  process.exit(2);
}
const mountList = literal[1].split(',').map((s) => s.trim()).filter(Boolean);
const mounted = new Set(mountList);

const importBlock = /import\s*\{([\s\S]*?)\}\s*from/.exec(bridgeSrc);
const imported = new Set((importBlock ? importBlock[1] : '').split(',').map((s) => s.trim()).filter(Boolean));

console.log('vm-bridge.test.mjs');
console.log(`  app.js 用到 ${used.size} 个取数函数，bridge 挂载 ${mounted.size} 个`);

ok('app.js 确实通过 window.PlannerVM 取数（不是空扫描）', used.size >= 4, `used=${[...used].join(',')}`);

for (const name of [...used].sort()) {
  ok(`[${name}] vm-bridge 真的挂载了它（import 过不算）`, mounted.has(name),
    mounted.has(name) ? '' : `已挂载：${[...mounted].join(', ')}`);
  ok(`[${name}] viewmodel.js 真的导出了它`, typeof viewmodel[name] === 'function',
    `typeof=${typeof viewmodel[name]}`);
}

for (const name of mountList) {
  ok(`[挂载项 ${name}] 在 import 列表里（否则运行时报未定义）`, imported.has(name),
    `imported=${[...imported].join(', ')}`);
}

ok('vm-bridge 里有中文注释而不是一行魔法赋值', /设计要点|这个文件加载失败/.test(bridgeSrc));

console.log('');
console.log(failures === 0 ? 'vm-bridge.test: PASS' : `vm-bridge.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
