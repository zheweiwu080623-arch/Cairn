// 「再处理功能」（processor）的验证：动作规范化、模块校验、run 接口（默认演练）、执行能力。
//
//   node tests/processor.test.mjs

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_TYPES, canExecute, normalizeAction, normalizeActions, summarizeActions,
} from '../lib/processor.mjs';
import { MODULE_KINDS, scanModules, validateModule } from '../lib/modules.mjs';
import { createModuleRoutes } from '../lib/routes/modules.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('processor.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'processor-'));

// ---------------- 1. 动作规范化（纯函数） ----------------
{
  const a = normalizeAction(
    { type: 'notify', summary: '上课前提醒', idempotency_key: 'p:1' },
    { moduleId: 'demo', dryRun: true, now: 1_700_000_000_000 },
  );
  ok('补齐 schema / created_at / audit', a.schema === 'action.v1' && !!a.created_at && a.audit.actor === 'processor:demo');
  ok('**演练时一律停在 planned**', a.status === 'planned' && a.dry_run === true);
  ok('幂等键原样保留', a.idempotency_key === 'p:1');
  ok('认得出所有合法 type', ACTION_TYPES.every((t) => normalizeAction({ type: t }).type === t));
}
{
  const bad = normalizeAction({ type: '乱写的类型' }, { moduleId: 'demo' });
  ok('不认识的 type → failed，并写清原因',
    bad.status === 'failed' && bad.problems.join(' ').includes('不认识的 type'), JSON.stringify(bad.problems));
  const inObject = normalizeActions({ actions: [{ type: 'push' }] }, { moduleId: 'demo', dryRun: true });
  ok('{actions:[…]} 这种形状也认', inObject.length === 1 && inObject[0].type === 'push');
  const single = normalizeActions({ type: 'notify' }, { moduleId: 'demo' });
  ok('直接返回单条也认', single.length === 1);
  ok('返回空数组 → 0 条动作（"没有值得打扰的事"）', normalizeActions([], { moduleId: 'demo' }).length === 0);
}
ok('汇总说人话', /2 条动作（1 notify \/ 1 push）/.test(summarizeActions([{ type: 'notify' }, { type: 'push' }], { dryRun: false })));
ok('演练会在汇总里注明', /演练/.test(summarizeActions([{ type: 'notify' }], { dryRun: true })));
{
  ok('演练时不能执行', canExecute({ type: 'notify', status: 'planned' }, { dryRun: true }).ok === false);
  ok('真跑时 notify / push 可执行',
    canExecute({ type: 'notify', status: 'planned' }, { dryRun: false }).ok === true
    && canExecute({ type: 'push', status: 'planned' }, { dryRun: false }).ok === true);
  ok('还没实现的动作会如实说"没实现"',
    /还没实现/.test(canExecute({ type: 'mail', status: 'planned' }, { dryRun: false }).reason));
}

// ---------------- 2. 模块校验：processor 要 entry.run ----------------
{
  ok('MODULE_KINDS 里有 processor', MODULE_KINDS.includes('processor'));
  const base = { schema: 'module.v1', id: 'demo-proc', name: 'x', version: '0.1.0', kind: 'processor' };
  ok('processor 缺 entry.run 会被点名',
    validateModule({ ...base, entry: {} }).errors.some((e) => e.includes('entry.run')));
  ok('带 entry.run 就合法', validateModule({ ...base, entry: { run: 'run.js' } }).ok === true);

  const dir = join(tmp, 'missing-run');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ ...base, id: 'missing-run', entry: { run: 'nope.js' } }), 'utf8');
  const found = scanModules(tmp).find((m) => m.id === 'missing-run');
  ok('声明的 run.js 不存在 → 模块带 error', !!found && /nope\.js/.test(found.error || ''), JSON.stringify(found && found.error));
}

// ---------------- 3. run 接口：默认演练、真跑才执行 ----------------
function makeFakeModule(dir, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify({
    schema: 'module.v1', id: 'fake-proc', name: '假再处理功能', version: '0.1.0',
    kind: 'processor', entry: { run: 'run.js' },
  }), 'utf8');
  writeFileSync(join(dir, 'run.js'), body, 'utf8');
}
const modsDir = join(tmp, 'mods');
const fakeBody = [
  'export function run(input, ctx) {',
  "  if (input.explode) throw new Error('再处理功能内部炸了');",
  '  if (input.nothing) return [];',
  '  return [',
  "    { type: 'notify', summary: '一条通知', idempotency_key: 'k:' + (input.tag || 'x') },",
  "    { type: input.badType ? 'wat' : 'push', summary: '一条推送', payload: { push: '极短一句' } },",
  '  ];',
  '}',
].join('\n');
makeFakeModule(join(modsDir, 'fake-proc'), fakeBody);

const sync = new Map();
const store = {
  getSync: (k) => (sync.has(k) ? sync.get(k) : null),
  setSync: (k, v) => sync.set(k, v),
  createNotification: (n) => ({ id: 'n1', ...n }),
};
const executed = [];
const routes = createModuleRoutes({
  modulesDir: modsDir, store,
  sendJson: (res, code, obj) => { res.code = code; res.body = obj; },
  sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
  readBody: async (r) => r.body || {},
  executors: {
    notify: (a, mod) => { executed.push(['notify', a.summary, mod.id]); return { ok: true, detail: '通知已建' }; },
    push: (a) => { executed.push(['push', a.summary]); return { ok: true, detail: '已推送' }; },
  },
  log: () => {},
});
const mkRes = () => ({ code: null, body: null });
const url = (p) => new URL('http://127.0.0.1:3210' + p);
const req = (method, body) => ({ method, body });

{
  const res = mkRes();
  await routes.handleModules(req('POST', { input: { tag: 'a' } }), res, url('/api/modules/fake-proc/run'));
  ok('**不带 dry_run:false → 默认演练**', res.body.dry_run === true);
  ok('演练也会把动作列出来，但停在 planned',
    res.body.actions.length === 2 && res.body.actions.every((a) => a.status === 'planned'));
  ok('演练**没有**真的执行（执行能力一次都没被调用）', executed.length === 0);
  ok('汇总里写明演练', /演练/.test(res.body.summary), res.body.summary);
}
{
  const res = mkRes();
  await routes.handleModules(req('POST', { dry_run: false, input: { tag: 'b' } }), res, url('/api/modules/fake-proc/run'));
  ok('真跑时两条动作都执行', executed.length === 2 && res.body.actions.every((a) => a.status === 'done'));
  ok('执行结果写回动作里', res.body.actions[0].result.ok === true && /通知已建/.test(res.body.actions[0].result.detail));
  ok('记账：上次运行写进了 sync_state', !!sync.get('module_runs_json') && /fake-proc/.test(sync.get('module_runs_json')));
}
{
  const res = mkRes();
  await routes.handleModules(req('POST', { dry_run: false, input: { badType: true } }), res, url('/api/modules/fake-proc/run'));
  const bad = res.body.actions.find((a) => a.type === 'wat');
  ok('不认识的类型不会被执行，标 failed 并说原因',
    !!bad && bad.status === 'failed' && /不认识的 type/.test(bad.problems.join(' ')));
}
{
  const res = mkRes();
  await routes.handleModules(req('POST', { input: { nothing: true } }), res, url('/api/modules/fake-proc/run'));
  ok('功能返回空数组 → 0 条动作（安静是合法结果）', res.body.ok === true && res.body.actions.length === 0);
}
{
  const res = mkRes();
  await routes.handleModules(req('POST', { input: { explode: true } }), res, url('/api/modules/fake-proc/run'));
  ok('功能抛异常不会 500，而是 ok:false + 原因',
    res.code === 400 && res.body.ok === false && /炸了/.test(res.body.error));
}
{
  const res = mkRes();
  await routes.handleModules(req('GET'), res, url('/api/modules'));
  ok('GET /api/modules 照旧给清单（还多了"上次运行"）',
    res.code === 200 && Array.isArray(res.body.modules) && !!res.body.runs);
  const nope = mkRes();
  await routes.handleModules(req('POST', {}), nope, url('/api/modules/nope/run'));
  ok('不存在的模块 → ok:false', nope.body.ok === false);
}

// ---------------- 4. 真实仓库里的示例 processor 与接线 ----------------
{
  const mods = scanModules(join(ROOT, 'modules'));
  const hello = mods.find((m) => m.id === 'hello-processor');
  ok('仓库里的示例 processor 能被发现且没有错误', !!hello && !hello.error && hello.kind === 'processor');
  ok('示例 processor 声明了 entry.run', !!hello && hello.entry.run === 'run.js');
  const impl = await import('../modules/hello-processor/run.js');
  ok('示例 processor 导出 run()', typeof impl.run === 'function');
  ok('没有可处理内容时它保持安静', impl.run({}, { dryRun: true }).length === 0);
  ok('有内容时产出一条 notify', impl.run({ title: '试一下' }, { dryRun: true })[0].type === 'notify');

  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const execSrc = readFileSync(join(ROOT, 'lib', 'processor-executors.mjs'), 'utf8');
  ok('主程序接了模块接口（清单 + run）',
    srv.includes("from './lib/routes/modules.mjs'") && srv.includes('moduleRoutes.handleModules(req, res, url)'));
  ok('执行能力是注入的、且已经搬到 lib/processor-executors.mjs（主程序只传依赖）',
    srv.includes('createProcessorExecutors') && execSrc.includes('source: `processor:${mod.id}`') && execSrc.includes('barkNotify({'));
  ok('写文件（file）也有执行能力，且是唯一的"动磁盘"入口',
    execSrc.includes('file: (a)') && srv.includes('writeFile: (a) => course.writeFile(a)'));
  ok('接口文件里默认就是演练（只有显式 false 才真跑）',
    /const dryRun = body\.dry_run !== false;/.test(readFileSync(join(ROOT, 'lib', 'routes', 'modules.mjs'), 'utf8')));
}

console.log('');
console.log(failures === 0 ? 'processor.test: PASS' : `processor.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
