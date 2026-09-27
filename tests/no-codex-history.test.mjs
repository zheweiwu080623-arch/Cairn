// 闸门：Cairn **不记录、不读取、不删改** Codex 的历史会话（2026-09-27 用户要求删除该功能）
//
//   node tests/no-codex-history.test.mjs
//
// 背景（用户原话）：「planner 有在记录 codex 历史会话吗，如果有的话就删掉这个功能」。
// 查证结果：确实有 —— ① `readThreads()` 读 `<CODEX_HOME>/state_5.sqlite` 的 threads 表
// （标题、**第一条用户消息原文**、token、工作目录），存进 Cairn 自己的库并显示；
// ② 「清理历史」功能会**改** Codex 的 `thread_history_1.sqlite`（先整份备份进 `data/backups/` 再删条目）。
// 两条都已删除。这个文件防止它们悄悄回来。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('no-codex-history.test.mjs');

// ---------------- ① 领域层：不再有"读会话"这件事 ----------------
{
  const mod = await import('../lib/codex.mjs');
  ok('lib/codex.mjs 不再导出 readThreads()', typeof mod.readThreads === 'undefined');
  ok('但"自动化"那部分照旧（功能只删了会话，没删 Codex 连接）',
    typeof mod.readAutomations === 'function' && typeof mod.detectCodexHome === 'function');
  const src = read('lib/codex.mjs');
  ok('源码里也不再有 Codex 会话库的痕迹',
    !src.includes('state_5.sqlite') || /已移除 readThreads/.test(src),
    'state_5 只应出现在"已移除"的说明注释里');
  ok('不再 import node:sqlite（读会话是唯一用它的地方）', !src.includes("from 'node:sqlite'"));
}

// ---------------- ② 服务端：快照里没有 threads，也不再提供"清理历史" ----------------
{
  const srv = read('server.mjs');
  ok('服务端不再 import readThreads', !/readAutomations, readThreads/.test(srv) && !srv.includes('readThreads('));
  ok('codex 快照里不再有 threads 字段（界面与 /api/state 都拿不到会话）',
    !/threads,/.test(srv) && !/threads:\s*\[\]/.test(srv));
  ok('「清理历史」接口已下线（那条会改 Codex 的库）',
    !srv.includes('/api/codex/history/clean') && !srv.includes('cleanLongHistory') && !srv.includes('thread_history_1'));
  ok('留了一次性清理：把以前存进本机库的旧会话记录抹掉',
    srv.includes('function purgeStoredCodexThreads()') && srv.includes('purgeStoredCodexThreads();'));
  const lines = srv.split('\n').length;
  ok('主程序还在 <2100 行闸门内（删掉清理功能后反而更宽松了）', lines < 2100, String(lines));
}

// ---------------- ③ 界面：不再显示会话，也没有"清理历史"卡片 ----------------
{
  const app = read('public/app.js');
  const vm = read('public/viewmodel.js');
  ok('界面不再统计/显示 Codex 会话',
    !app.includes('threads.length') && !app.includes('threads: c.threads') && !vm.includes('codex.threads'));
  ok('「清理历史」卡片与它的接线都没了',
    !app.includes('clean-history') && !app.includes('cleanHistory') && !app.includes('/api/codex/history/clean'));
  ok('但 Codex 自动化那一块还在（只删会话那部分）',
    app.includes('Codex 自动化') && app.includes('cx.automations'));
}

console.log('');
console.log(failures === 0 ? 'no-codex-history.test: PASS' : `no-codex-history.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
