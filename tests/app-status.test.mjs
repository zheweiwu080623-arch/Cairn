// P1-8 单元测试：Planner 的 app-status.v1 映射。
//
//   node tests/app-status.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildPlannerAppStatus } from '../lib/app-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// ROOT = …\Documents\Codex\2026-09-08\gou\outputs\codex-planner → 上溯 4 层到 Documents\Codex
const WORK = join(ROOT, '..', '..', '..', '..', '2026-09-17', 'xian', 'work');

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('app-status.test.mjs');

const healthy = {
  ok: true, app: 'codex-planner', pid: 12345, port: 3210, node: 'v24', platform: 'win32',
  started_at: '2026-09-19T00:10:04.123Z', uptime_sec: 3600, log_path: 'data/server.log',
  canvas_watch: { enabled: true, interval_hours: 3, last_run: '2026-09-19T00:00:00.000Z',
    next_run: '2026-09-19T03:00:00.000Z', last_error: null, last_result: null },
  autostart: { supported: true, enabled: true, path: 'C:\\...\\CodexPlanner.lnk' },
  counts: { tasks: 117, notifications: 141, pending: 0 },
};

const status = buildPlannerAppStatus(healthy, {
  courseSync: { counts: { pending_device: 2, failed: 0 } },
  planExport: { exported_at: '2026-09-19T08:50:00+08:00' },
  now: new Date('2026-09-19T08:50:00+08:00'),
});

ok('schema / app / running 正确',
  status.schema === 'app-status.v1' && status.app === 'planner' && status.running === true);
ok('pid 与 started_at 透传', status.pid === 12345 && status.started_at === healthy.started_at);
ok('heartbeat_at 是带时区的 ISO', /^\d{4}-\d{2}-\d{2}T.*Z$/.test(status.heartbeat_at), status.heartbeat_at);
ok('整体状态 ok', status.state === 'ok', status.state);
ok('包含 core / canvas_watch / autostart 三段',
  ['core', 'canvas_watch', 'autostart'].every((id) => status.sections.some((s) => s.id === id)));
ok('course_sync / plan_export 可选段被带上',
  status.sections.some((s) => s.id === 'course_sync') && status.sections.some((s) => s.id === 'plan_export'));
ok('每段都有 id/label/state', status.sections.every((s) => s.id && s.label && s.state));
ok('状态取值都在契约枚举内',
  ['ok', 'warn', 'error', 'idle', 'running', 'down'].includes(status.state)
  && status.sections.every((s) => ['ok', 'warn', 'error', 'idle', 'running', 'down'].includes(s.state)));
ok('canvas_watch 有 last_run / next_run',
  (() => { const s = status.sections.find((x) => x.id === 'canvas_watch'); return s.last_run && s.next_run; })());
ok('metrics 带 counts',
  status.metrics.tasks === 117 && status.metrics.notifications === 141);

// 有错的场景要标 warn / error
const warn = buildPlannerAppStatus({ ...healthy, canvas_watch: { ...healthy.canvas_watch, last_error: 'fetch failed' } });
ok('Canvas 上次失败 → 整体 warn', warn.state === 'warn', warn.state);
ok('失败详情写进 section', warn.sections.find((s) => s.id === 'canvas_watch').state === 'warn');
const noAuto = buildPlannerAppStatus({ ...healthy, autostart: { supported: true, enabled: false } });
ok('未开机自启 → warn', noAuto.state === 'warn');
const busy = buildPlannerAppStatus(healthy, { courseSync: { counts: { pending_device: 1, failed: 3 } } });
ok('课程同步有失败 → warn', busy.state === 'warn', busy.state);
const down = buildPlannerAppStatus({ ...healthy, ok: false });
ok('health.ok=false → running=false', down.running === false);
ok('对空对象也能兜底（不抛错）', !!buildPlannerAppStatus({}).schema);

// 与"别的程序"写的机器状态互认：schema 必须一致，app 用各自的小写短名区分
const externalFile = join(WORK, 'evidence', 'app-status.external.json');
if (existsSync(externalFile)) {
  const external = JSON.parse(readFileSync(externalFile, 'utf8'));
  ok('外部写的那份也是同一个 schema', external.schema === status.schema, external.schema);
  ok('两个应用的 app 字段都能过同一条正则，且互不相同',
    /^[a-z][a-z0-9-]{1,31}$/.test(external.app) && /^[a-z][a-z0-9-]{1,31}$/.test(status.app)
    && external.app !== status.app);
  ok('两边的段结构与状态枚举一致',
    external.sections.every((s) => s.id && s.label && s.state)
    && typeof external.running === 'boolean' && typeof status.running === 'boolean');
} else {
  console.log('  SKIP 与外部程序的互认检查（找不到 evidence/app-status.external.json）');
}

console.log('');
console.log(failures === 0 ? 'app-status.test: PASS' : `app-status.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
