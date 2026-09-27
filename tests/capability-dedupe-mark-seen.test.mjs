// 能力单测：dedupe.markSeen（M1 · S2 起就有；2026-09-26 拆分后改成"查能力自己的文件"）。
//
//   node tests/capability-dedupe-mark-seen.test.mjs
//
// 拆分后的规矩：**一条能力 = lib/capabilities/impl/dedupe.markSeen.mjs 一个文件**，导出 meta + bind + run。
// 所以这条测试就查四件事：登记表里有它、过校验、承诺（kind/权限）与实情相符、能力文件真的在且绑到对的实现。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCapability, validateCapability } from '../lib/capabilities/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('capability-dedupe-mark-seen.test.mjs');

const cap = getCapability('dedupe.markSeen');
ok('登记表里有这条能力', !!cap);
ok('过 capability.v1 校验（含权限词表）', !!cap && validateCapability(cap).ok,
  cap ? validateCapability(cap).errors.join('；') : '');
ok('承诺的副作用类别对得上（kind = write）', cap?.kind === 'write', cap?.kind);
ok('承诺的权限对得上（fs:write:data）',
  JSON.stringify(cap?.permissions) === JSON.stringify(["fs:write:data"]), JSON.stringify(cap?.permissions));
ok('能力文件就在它自己的位置上（lib/capabilities/impl/dedupe.markSeen.mjs）',
  cap?.entry === 'lib/capabilities/impl/dedupe.markSeen.mjs', cap?.entry);
ok('能力文件真的在', existsSync(join(ROOT, cap?.entry || '')), cap?.entry);
ok('能力文件自带 meta + bind + run，并绑到真实现', (() => {
  const s = readFileSync(join(ROOT, cap.entry), 'utf8');
  return s.includes('export const meta') && s.includes('export const bind')
    && /export async function run/.test(s) && s.includes("dedupe.markSeen");
})());
ok('run 是函数（宿主直接调它）', typeof cap?.run === 'function');

console.log('');
console.log(failures === 0 ? 'capability-dedupe-mark-seen.test: PASS' : `capability-dedupe-mark-seen.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
