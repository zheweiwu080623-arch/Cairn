// 能力层 S3–S6 的验证：按登记表装配（S4）/ 声明了才给（S5）/ 能力出口（S3）/ 能力展示（S6）。
//
//   node tests/capability-host.test.mjs
//
// 最关键的一条是"S4 行为等价"：新装配出来的 ctx 必须与**原来手写的那两个对象合并**
// 得到的键与形状一模一样，否则就是在偷偷改功能拿到的能力。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAPABILITIES, getCapability, listCapabilities } from '../lib/capabilities/index.mjs';
import { createCapabilityHost, declaredCapabilities } from '../lib/capabilities/host.mjs';
import { createCapabilityRoutes } from '../lib/routes/capabilities.mjs';
import { createModuleRoutes } from '../lib/routes/modules.mjs';
import { formatCapabilityUse, summarizeCapabilityUse } from '../lib/permissions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('capability-host.test.mjs');

// ---------- 假提供者：形状照抄真实的两个 stack（键与函数个数都对齐） ----------
const preclassProvider = () => ({
  canvas: { checkCourse: (o) => ({ items: [{ id: 'x', courseCode: o && o.courseCode }] }) },
  prefs: () => ({ bark: false, minutes_before: 30 }),
  dedupe: { filterNew: (items) => items, markSeen: () => ({ ok: true }) },
});
const courseProvider = () => ({
  course: {
    dir: () => '/tmp/courses',
    studyDir: () => '/tmp/data/study',
    outPath: (name) => `/tmp/data/study/${name}`,
    scan: () => ({ ok: true, courses: [{ name: 'DEMO1010J' }], files: [], week: 4 }),
    read: () => ({ materials: [{ name: 'a.pdf', text: 'hello' }] }),
    index: () => ({ markdown: '# index', stats: { files: 1 }, path: '/tmp/data/study/material-index.md' }),
    weekly: () => ({ markdown: '# week 4', stats: { files: 1 }, path: '/tmp/data/study/week-4.md' }),
    search: () => [{ name: 'a.pdf', segment: 2 }],
    currentWeek: () => 4,
  },
});
/** 模型提供者（照 server.mjs 的形状：`ctx.llm.ask(o)` → { ok, text, via }）。 */
const llmProvider = () => ({
  llm: { ask: async (o = {}) => ({ ok: true, text: `echo:${String(o.prompt || '')}`, via: 'fake' }) },
});
const host = createCapabilityHost({
  // 2026-10-02：多了第三个提供者 —— 模型（llm.ask 用它）。
  // 加提供者就要同步加进下面的 legacy，否则"逐键一致"那条守卫会红（这正是它该干的事）。
  providers: { preclass: preclassProvider, course: courseProvider, llm: llmProvider },
});

// ---------- S4 · 行为等价：与"手写合并"逐键一致 ----------
{
  const allCapIds = CAPABILITIES.filter((c) => !c.bind.executor).map((c) => c.id);
  const mod = { id: 'demo', kind: 'processor', requires: { capabilities: allCapIds } };
  const assembled = host.extraContext(mod);
  const legacy = { ...preclassProvider(), ...courseProvider(), ...llmProvider() };   // 原来 server.mjs 的写法

  const paths = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && typeof v !== 'function' ? paths(v, p) : [p];
  });
  const a = paths(assembled).sort();
  const b = paths(legacy).sort();
  ok('装配出来的 ctx 与"手写合并"的键完全一致（S4 行为等价）',
    JSON.stringify(a) === JSON.stringify(b), `assembled=${a.join(',')} legacy=${b.join(',')}`);
  ok('每个键都还是函数（形状没变）',
    paths(assembled).every((p) => typeof p.split('.').reduce((o, k) => o[k], assembled) === 'function'));
  ok('prefs 还是一个函数（没有被包成对象）', typeof assembled.prefs === 'function');
  ok('course 下 9 个入口都在',
    ['dir', 'studyDir', 'outPath', 'scan', 'read', 'index', 'weekly', 'search', 'currentWeek']
      .every((k) => typeof assembled.course[k] === 'function'));
}

// ---------- S5 · 声明了才给；没声明就用 → 明确报错 ----------
{
  const only = host.extraContext({ requires: { capabilities: ['course.scan'] } });
  ok('声明过的能力装配成真函数',
    typeof only.course.scan === 'function' && typeof only.course.currentWeek === 'function');
  let msg = '';
  try { only.course.read({ courses: [] }); } catch (e) { msg = String(e && e.message); }
  ok('调用没声明的能力 → 报错里写清是哪个能力、该怎么声明',
    msg.includes('course.text') && msg.includes('requires') && msg.includes('capabilities'), msg);
  let msg2 = '';
  try { only.prefs(); } catch (e) { msg2 = String(e && e.message); }
  ok('没声明的 prefs 也拦得住（不是 undefined 崩）', msg2.includes('prefs.read'), msg2);
  ok('写类能力不进 ctx（它们走 action）',
    !('notify' in only) && !('push' in only) && !('file' in only));
  const d = host.describe({ requires: { capabilities: ['course.scan', 'nope.nope'] } });
  ok('describe 把认识的与不认识的都列清楚',
    d.known.join() === 'course.scan' && d.unknown.join() === 'nope.nope', JSON.stringify(d));
  ok('declaredCapabilities 去重去空',
    declaredCapabilities({ requires: { capabilities: ['course.scan', 'course.scan', ''] } }).ids.join() === 'course.scan');
}

// ---------- M2 的接口：统一 invoke ----------
{
  const r1 = await host.invoke('course.scan', {});
  ok('读类能力：invoke 直接返回产出', r1.ok === true && r1.output.courses.length === 1, JSON.stringify(r1).slice(0, 120));
  const r2 = await host.invoke('notify.app', { title: '嗨', text: '内容' });
  ok('写类能力：invoke 返回一条 action（交给执行器，dry-run 照样生效）',
    r2.ok === true && r2.actions.length === 1 && r2.actions[0].type === 'notify', JSON.stringify(r2).slice(0, 160));
  const r3 = await host.invoke('file.write', { path: '/tmp/data/study/x.md', text: 'hi' });
  ok('写文件折成 file 动作，路径原样带着',
    r3.actions[0].type === 'file' && r3.actions[0].target.path === '/tmp/data/study/x.md');
  const r4 = await host.invoke('nope.nope', {});
  ok('不认识的能力：报错而不是抛', r4.ok === false && r4.error.includes('nope.nope'));
  const r5 = await host.invoke('course.text', { q: 'hello' });
  ok('检索式调用也走同一个入口（q → search）', r5.ok === true && Array.isArray(r5.output.hits));
}

// ---------- S3 · GET /api/capabilities ----------
{
  const routes = createCapabilityRoutes({
    sendJson: (res, code, body) => { res.code = code; res.body = body; },
    sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
    listModules: () => [
      { id: 'preclass-check', requires: { capabilities: ['canvas.course.check', 'nope.nope'] } },
      { id: 'course-assist', requires: { capabilities: ['course.scan'] } },
    ],
  });
  const res = {};
  await routes.handleCapabilities({ method: 'GET' }, res, { pathname: '/api/capabilities', searchParams: new URLSearchParams('') });
  // 2026-10-02：登记表从 10 条长到 17 条（加了"通用原子 + 逐条处理"）⇒ 断言改成
  // "接口列全了登记表里的每一条"，不再钉死一个数字。
  ok('接口 200 且列全登记表里的每一条',
    res.code === 200 && res.body.count === CAPABILITIES.length && res.body.builtin_count === CAPABILITIES.length,
    JSON.stringify(res.body).slice(0, 160));
  ok('带上分组（M3 画布的分栏）', Array.isArray(res.body.groups) && res.body.groups.includes('课程'));
  ok('权限翻成了人话',
    res.body.capabilities.find((c) => c.id === 'course.text').permission_labels[0].label.includes('课程资料'));
  ok('算出了"哪些功能声明了它"',
    res.body.capabilities.find((c) => c.id === 'course.scan').declared_by.join() === 'course-assist');
  const one = {};
  await routes.handleCapabilities({ method: 'GET' }, one, { pathname: '/api/capabilities', searchParams: new URLSearchParams('id=course.text') });
  ok('按 id 取一条', one.code === 200 && one.body.id === 'course.text');
  const missing = {};
  await routes.handleCapabilities({ method: 'GET' }, missing, { pathname: '/api/capabilities', searchParams: new URLSearchParams('id=nope.nope') });
  ok('不认识的 id → 404', missing.code === 404);
  const readOnly = {};
  await routes.handleCapabilities({ method: 'POST' }, readOnly, { pathname: '/api/capabilities', searchParams: new URLSearchParams('') });
  ok('只读接口：写方法一律 405', readOnly.code === 405);
}

// ---------- S6 · 能力展示（安装 / 列表时给人看的那份） ----------
{
  const mod = { id: 'demo', requires: { capabilities: ['course.scan', 'file.write', 'typo.here'] } };
  const caps = ['course.scan', 'file.write'].map((id) => getCapability(id));
  const s = summarizeCapabilityUse(mod, caps);
  ok('数出 2 项能力、其中 1 项碰磁盘', s.count === 2 && s.risky === 1, JSON.stringify(s).slice(0, 140));
  ok('声明了但登记表里没有的，如实列进 missing', s.missing.join() === 'typo.here');
  const text = formatCapabilityUse(mod, caps);
  ok('清单里有人话的名字与授权', text.includes('写产物文件') && text.includes('fs:write:data'));
  ok('拼错的能力会给出提示', text.includes('typo.here') && text.includes('cairn cap list'));
}

// ---------- S5 · 真跑一遍 module 运行时（声明对 → 跑通；声明错 → 明确报错） ----------
{
  const TMP = process.env.PLANNER_TEST_TMP || tmpdir();
  let root = '';
  try { root = mkdtempSync(join(TMP, 'cap-host-')); } catch { root = ''; }
  if (!root) {
    console.log('  SKIP 临时目录不可写（没设 PLANNER_TEST_TMP）—— module 运行时那三条跳过');
  } else {
    const mk = (id, requires) => {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'module.json'), JSON.stringify({
        schema: 'module.v1', id, name: `演示 ${id}`, version: '0.1.0', kind: 'processor',
        entry: { run: 'run.js' },
        permissions: ['notify:app'],
        requires: { app: '>=1.0', agent: false, capabilities: requires },
      }), 'utf8');
      writeFileSync(join(dir, 'run.js'), [
        'export function run(input, ctx) {',
        '  const scan = ctx.course.scan({});',
        "  return [{ type: 'notify', summary: `扫到 ${scan.courses.length} 门课`, payload: { text: 'ok' } }];",
        '}',
      ].join('\n'), 'utf8');
    };
    mk('declared-ok', ['course.scan', 'notify.app']);
    mk('declared-bad', ['nope.nope']);
    mk('declared-none', []);

    const storeStub = { getSync: () => null, setSync: () => {}, createNotification: () => ({ id: 'n1' }) };
    const routes = createModuleRoutes({
      modulesDir: root, store: storeStub,
      sendJson: () => {}, sendError: () => {}, readBody: async () => ({}),
      extraContext: (mod) => host.extraContext(mod),
      executors: { notify: () => ({ ok: true, detail: '通知已建' }) },
    });

    const runOk = await routes.runModule('declared-ok', { dryRun: true });
    ok('声明对了：正常跑（默认演练，动作停在 planned）',
      runOk.ok === true && runOk.actions[0].status === 'planned' && runOk.actions[0].summary.includes('门课'),
      JSON.stringify(runOk).slice(0, 200));
    const runBad = await routes.runModule('declared-bad', { dryRun: true });
    ok('声明了不存在的能力：当场报清楚，不去跑',
      runBad.ok === false && runBad.error.includes('nope.nope'), JSON.stringify(runBad).slice(0, 160));
    const runNone = await routes.runModule('declared-none', { dryRun: true });
    ok('一条都没声明却调用能力：报错里写清该加什么',
      runNone.ok === false && runNone.error.includes('course.scan') && runNone.error.includes('requires'),
      JSON.stringify(runNone).slice(0, 220));
  }
}

// ---------- 命令行 ----------
{
  const cli = readFileSync(join(ROOT, 'bin', 'cairn.mjs'), 'utf8');
  ok('cli 里有 cap list', cli.includes('function cmdCapList') && cli.includes("argv[0] === 'cap'"));
  ok('帮助里写了 cap list', /cairn cap list/.test(cli));
  ok('mod list --permissions 会带能力清单', cli.includes('formatCapabilityUse(m, capsOfModule(m))'));
  ok('安装预览也会带能力清单', cli.includes('formatCapabilityUse(descriptor, capsOfModule(descriptor))'));
  ok('登记表就是注册表（listCapabilities 不多不少）', listCapabilities().length === CAPABILITIES.length);
}

console.log('');
console.log(failures === 0 ? 'capability-host.test: PASS' : `capability-host.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
