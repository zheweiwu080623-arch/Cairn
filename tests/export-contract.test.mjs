// P1-5 数据出口单元测试（不碰真实数据库，用假 store）。
//
//   node tests/export-contract.test.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildNotificationsExport, buildSnapshotExport, contentHash, localIso, writeExportFiles,
} from '../lib/export-contract.mjs';

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

const NOW = new Date(2026, 8, 19, 0, 30, 0); // 2026-09-19 00:30 本地
const day = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const notifications = [
  { id: 'n1', title: 'arXiv A', message: 'x'.repeat(500), url: 'https://arxiv.org/abs/1',
    source: 'connector:arxiv', external_id: 'arxiv-1', trigger_at: iso(NOW.getTime() - 2 * day),
    created_at: NOW.getTime() - 2 * day },
  { id: 'n2', title: 'arXiv B', message: 'short', url: null,
    source: 'connector:arxiv', external_id: 'arxiv-2', trigger_at: iso(NOW.getTime() - 10 * day),
    created_at: NOW.getTime() - 10 * day },
  { id: 'n3', title: 'Canvas 作业', message: 'due', url: 'https://canvas.example.edu/x',
    source: 'connector:canvas', external_id: 'file-1', trigger_at: iso(NOW.getTime() - day),
    created_at: NOW.getTime() - day },
];
const tasks = [
  { id: 't1', title: '写报告', status: 'todo', due_at: '2026-09-19', priority: 1 },
  { id: 't2', title: '已完成的事', status: 'done', due_at: '2026-09-10', priority: 2 },
];
const store = {
  listNotifications: () => notifications,
  listTasks: () => tasks,
  listEvents: () => [{ id: 'e1', title: '班会', start_at: '2026-09-19T14:00', all_day: 0 }],
  listCourses: () => [{ id: 'c1', course: 'MATH1860J', weekday: 6, start_at: '12:00', end_at: '13:40' }],
  listPending: () => [],
};

console.log('export-contract.test.mjs');

// ---- 通知导出
const all = buildNotificationsExport(store, { now: NOW, days: 30 });
ok('通知导出：schema / 必填字段齐全',
  all.schema === 'planner-notifications.v1' && typeof all.exported_at === 'string'
  && Array.isArray(all.items) && typeof all.content_hash === 'string');
ok('通知导出：本地时区 ISO 时间', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(all.exported_at),
  all.exported_at);
ok('通知导出：条目按时间倒序', all.items.map((i) => i.id).join(',') === 'n3,n1,n2', all.items.map((i) => i.id).join(','));
ok('通知导出：message 被截断到 400 字', all.items.find((i) => i.id === 'n1').message.length === 401,
  String(all.items.find((i) => i.id === 'n1').message.length));
ok('通知导出：source 过滤生效',
  buildNotificationsExport(store, { source: 'arxiv', now: NOW, days: 30 }).items.every((i) => i.source.includes('arxiv')));
ok('通知导出：days 过滤生效（7 天内只剩 2 条）',
  buildNotificationsExport(store, { now: NOW, days: 7 }).items.map((i) => i.id).join(',') === 'n3,n1',
  buildNotificationsExport(store, { now: NOW, days: 7 }).items.map((i) => i.id).join(','));
ok('通知导出：limit 生效',
  buildNotificationsExport(store, { now: NOW, days: 30, limit: 1 }).items.length === 1);
ok('通知导出：count 与 items 一致', all.count === all.items.length);
ok('通知导出：内容不变时 content_hash 稳定',
  buildNotificationsExport(store, { now: NOW, days: 30 }).content_hash === all.content_hash);
const storePlus = { ...store, listNotifications: () => [...notifications, {
  id: 'n4', title: '新条目', message: '', url: null, source: 'connector:arxiv',
  external_id: 'arxiv-4', trigger_at: iso(NOW.getTime() - 3 * day), created_at: NOW.getTime() - 3 * day,
}] };
ok('通知导出：内容变化时 content_hash 变化',
  buildNotificationsExport(storePlus, { now: NOW, days: 30 }).content_hash !== all.content_hash);
ok('通知导出：同样内容、不同导出时间 → hash 不变（hash 只反映内容）',
  buildNotificationsExport(store, { now: new Date(NOW.getTime() + day), days: 30 }).content_hash === all.content_hash);

// ---- 快照导出
const snap = buildSnapshotExport(store, { now: NOW });
ok('快照导出：schema / 计数正确',
  snap.schema === 'planner-snapshot.v1' && snap.counts.tasks === 2 && snap.counts.events === 1
  && snap.counts.courses === 1 && snap.counts.open_tasks === 1, JSON.stringify(snap.counts));
ok('快照导出：stale_after_hours 默认 24', snap.stale_after_hours === 24);
ok('快照导出：sections 是 viewmodel.v1 对象（复用显示层构造器）',
  snap.sections.length === 2 && snap.sections.every((s) => s.schema === 'viewmodel.v1' && s.id && s.title));
ok('快照导出：「今日」section 与浏览器同源',
  snap.sections[0].id === 'today' && Array.isArray(snap.sections[0].sections));
ok('快照导出：content_hash 只看 sections（时间变→hash 不变）',
  buildSnapshotExport(store, { now: new Date(NOW.getTime() + 3600_000) }).content_hash === snap.content_hash);
ok('contentHash 是短 sha256', /^sha256:[0-9a-f]{32}$/.test(contentHash([1, 2, 3])), contentHash([1, 2, 3]));
ok('localIso 带本地偏移', localIso(NOW).endsWith('+08:00') || localIso(NOW).includes(':'), localIso(NOW));

// ---- 落盘
// %TEMP% 与本仓库在沙箱里都不可写；临时目录优先用 PLANNER_TEST_TMP 指定的位置
// （工作区可写目录），拿不到就跳过落盘检查——该路径已由服务端真实写出的
// data/export/*.json 覆盖（见 work/evidence 与契约校验）。
const tmpParent = process.env.PLANNER_TEST_TMP || join(ROOT, 'data', 'test-tmp');
let dir = null;
try {
  mkdirSync(tmpParent, { recursive: true });
  dir = mkdtempSync(join(tmpParent, 'export-'));
} catch (err) {
  if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
}
try {
  if (dir === null) {
    console.log('  SKIP 落盘检查（沙箱不允许写盘；改由服务端写出的 data/export/*.json 覆盖）');
  } else {
    const wrote = writeExportFiles(store, { dataDir: dir, now: NOW });
    ok('writeExportFiles 写出两个文件', wrote.paths.length === 2, JSON.stringify(wrote));
    const notifFile = join(dir, 'export', 'planner-notifications.v1.json');
    const snapFile = join(dir, 'export', 'planner-snapshot.v1.json');
    ok('两个文件确实存在', existsSync(notifFile) && existsSync(snapFile));
    const parsed = JSON.parse(readFileSync(notifFile, 'utf8'));
    ok('写出的 JSON 可解析且 schema 正确', parsed.schema === 'planner-notifications.v1');
  }
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'export-contract.test: PASS' : `export-contract.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
