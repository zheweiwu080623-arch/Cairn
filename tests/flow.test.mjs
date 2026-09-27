// 「功能 = 能力图」的验证（M2）。
//
//   node tests/flow.test.mjs
//
// 四件事：① 图本身能被校验（少节点、坏连线、有环、引用排在自己后面的节点都要拦住）；
// ② `$节点.路径` 取值正确（整个字符串是一个引用时保留原类型）；
// ③ 图执行按拓扑序走，某个节点失败就停在那一步并说清是谁；
// ④ 声明式功能跑进**真的 module 运行时**：默认演练只产 planned，--real 才交给执行器。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFlow, summarizeFlow, topoOrder, validateFlow, parseRef, resolveInput } from '../lib/flow.mjs';
import { createModuleRoutes } from '../lib/routes/modules.mjs';
import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import { scanModules, validateModule } from '../lib/modules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('flow.test.mjs');

const GOOD = {
  schema: 'flow.v1',
  nodes: [
    { id: 'scan', capability: 'course.scan', input: {} },
    { id: 'read', capability: 'course.text', input: { courses: '$scan.courses', only: '$input.only' } },
    { id: 'save', capability: 'file.write', input: { path: '$read.path', text: '$read.markdown' } },
  ],
  edges: [['scan', 'read'], ['read', 'save']],
};

// ---------- ① 校验 ----------
{
  ok('合法的图通过', validateFlow(GOOD).ok === true, validateFlow(GOOD).errors.join('；'));
  ok('空图被拦住', validateFlow({ nodes: [] }).ok === false);
  ok('节点缺 capability 被拦住', validateFlow({ ...GOOD, nodes: [{ id: 'a' }] }).errors.some((e) => e.includes('capability')));
  ok('节点 id 重复被拦住', validateFlow({ ...GOOD, nodes: [{ id: 'a', capability: 'x' }, { id: 'a', capability: 'y' }] }).errors.some((e) => e.includes('重复')));
  ok('连线写到不存在的节点被拦住',
    validateFlow({ ...GOOD, edges: [['scan', 'nope']] }).errors.some((e) => e.includes('终点不存在')));
  ok('有环被拦住',
    validateFlow({ nodes: [{ id: 'a', capability: 'x' }, { id: 'b', capability: 'y' }], edges: [['a', 'b'], ['b', 'a']] }).errors.some((e) => e.includes('环')));
  ok('引用排在后面的节点被拦住',
    validateFlow({ nodes: [{ id: 'a', capability: 'x', input: { v: '$b.v' } }, { id: 'b', capability: 'y' }], edges: [['a', 'b']] })
      .errors.some((e) => e.includes('只能来自上游')));
  ok('$input.* 是保留命名空间（不算节点引用）', validateFlow(GOOD).errors.length === 0);
  ok('连线两种写法都收', validateFlow({ ...GOOD, edges: [{ from: 'scan', to: 'read' }, { from: 'read', to: 'save' }] }).ok === true);
}

// ---------- ② 取值 ----------
{
  ok('parseRef 认得 $a.b.c', JSON.stringify(parseRef('$a.b.c')) === JSON.stringify({ node: 'a', path: ['b', 'c'] }));
  ok('不是引用的字符串原样返回', parseRef('普通文字') === null && resolveInput('普通文字', {}) === '普通文字');
  const outputs = { a: { list: [1, 2, 3], deep: { x: 'hi' } } };
  ok('整串是一个引用时保留原类型（数组还是数组）',
    JSON.stringify(resolveInput('$a.list', outputs)) === '[1,2,3]');
  ok('嵌套路径取得对', resolveInput('$a.deep.x', outputs) === 'hi');
  ok('引用不存在时给 undefined（不抛）', resolveInput('$a.nope.x', outputs) === undefined);
  ok('对象/数组里的引用会递归替换',
    JSON.stringify(resolveInput({ q: '$a.deep.x', keep: 1, list: ['$a.deep.x'] }, outputs)) === '{"q":"hi","keep":1,"list":["hi"]}');
}

// ---------- ③ 图执行 ----------
{
  const calls = [];
  const invoke = async (id, input) => {
    calls.push({ id, input });
    if (id === 'course.scan') return { ok: true, output: { courses: ['C1', 'C2'], files: 5 } };
    if (id === 'course.text') return { ok: true, output: { materials: [{ name: 'm1' }], markdown: '# 索引' , path: '/tmp/x.md' } };
    if (id === 'file.write') return { ok: true, actions: [{ type: 'file', target: { path: input.path }, payload: { text: input.text } }] };
    return { ok: false, error: '不该走到这里' };
  };
  const r = await runFlow(GOOD, { invoke, input: { only: 'DEMO' } });
  ok('整体跑通', r.ok === true, r.error);
  ok('按拓扑序调用（scan → read → save）', calls.map((c) => c.id).join(',') === 'course.scan,course.text,file.write', calls.map((c) => c.id).join(','));
  ok('上游产出真的传给了下游（courses=数组）', JSON.stringify(calls[1].input.courses) === '["C1","C2"]');
  ok('运行入参也能引用（$input.only）', calls[1].input.only === 'DEMO');
  ok('写类节点折出 action（不是自己动手）',
    r.actions.length === 1 && r.actions[0].type === 'file' && r.actions[0].target.path === '/tmp/x.md');
  ok('每个节点都有耗时记录', r.nodes.length === 3 && r.nodes.every((n) => n.ok && n.ms >= 0));
  ok('摘要能给人看', /3 个节点/.test(summarizeFlow(GOOD)), summarizeFlow(GOOD));

  const fail = await runFlow(GOOD, {
    invoke: async (id) => (id === 'course.text' ? { ok: false, error: '读课件失败' } : { ok: true, output: {} }),
  });
  ok('某个节点失败：停在那一步并说清是谁',
    fail.ok === false && fail.error.includes('read') && fail.error.includes('读课件失败') && fail.nodes.length === 2,
    JSON.stringify(fail).slice(0, 160));
  const bad = await runFlow({ nodes: [] }, { invoke });
  ok('不合法的图：直接拒绝，不去试着跑', bad.ok === false && bad.error.includes('不合法'));
}

// ---------- ④ 定义：声明式模块能被发现、校验、并跑进真运行时 ----------
{
  const real = scanModules(join(ROOT, 'modules')).find((m) => m.id === 'course-index-flow');
  ok('仓库里那个"能力图版"功能被扫出来了', !!real && !real.error, real && real.error);
  ok('它声明了要用的能力（含写类）',
    (real?.requires?.capabilities || []).includes('file.write') && (real?.requires?.capabilities || []).includes('notify.app'));
  ok('validateModule 接受 entry.flow（processor 的第二种写法）',
    validateModule({ schema: 'module.v1', id: 'f', name: 'x', version: '0.1.0', kind: 'processor', entry: { flow: 'flow.json' } }).ok === true);
  ok('同时给 run 和 flow 要报错（二选一）',
    validateModule({ schema: 'module.v1', id: 'f', name: 'x', version: '0.1.0', kind: 'processor', entry: { run: 'r.js', flow: 'f.json' } })
      .errors.some((e) => e.includes('二选一')));

  const TMP = process.env.PLANNER_TEST_TMP || tmpdir();
  let root = '';
  try { root = mkdtempSync(join(TMP, 'flow-')); } catch { root = ''; }
  if (!root) {
    console.log('  SKIP 临时目录不可写（没设 PLANNER_TEST_TMP）—— 跑进 module 运行时那两条跳过');
  } else {
    // 一个假的能力宿主：scan/read 给产出，file/notify 折成 action
    const calls = [];
    const host = createCapabilityHost({ providers: {} });
    const fakeInvoke = async (id, input) => {
      calls.push({ id, input });
      if (id === 'course.scan') return { ok: true, output: { courses: [{ name: 'DEMO1010J' }], files: 1, week: 4 } };
      if (id === 'course.text') return { ok: true, output: { materials: [{ name: 'a.pdf' }] } };
      if (id === 'course.artifacts') return { ok: true, output: { markdown: '# 索引', stats: { files: 1 }, path: join(root, 'study', 'material-index.md') } };
      if (id === 'file.write') return { ok: true, actions: [{ type: 'file', target: { kind: 'file', path: input.path }, payload: { text: input.text } }] };
      if (id === 'notify.app') return { ok: true, actions: [{ type: 'notify', summary: input.title, payload: { text: input.text || '' } }] };
      return { ok: false, error: `假宿主不认识 ${id}` };
    };
    const written = [];
    const routes = createModuleRoutes({
      modulesDir: join(ROOT, 'modules'),
      store: { getSync: () => null, setSync: () => {} },
      sendJson: () => {}, sendError: () => {}, readBody: async () => ({}),
      extraContext: () => ({}),
      capabilities: { ...host, invoke: fakeInvoke, allContext: () => ({}) },
      executors: {
        file: (a) => { written.push(a.target.path); return { ok: true, detail: '已写入' }; },
        notify: () => ({ ok: true, detail: '通知已建' }),
      },
    });

    const dry = await routes.runModule('course-index-flow', { dryRun: true, input: { only: 'DEMO1010J' } });
    ok('声明式功能默认演练：跑完全部节点、动作停在 planned',
      dry.ok === true && dry.actions.length === 2 && dry.actions.every((a) => a.status === 'planned'),
      JSON.stringify(dry).slice(0, 220));
    ok('演练不落盘（执行器一次都没被叫）', written.length === 0);
    ok('节点参数真的传进了能力（only=DEMO1010J）',
      calls.some((c) => c.id === 'course.text' && c.input.only === 'DEMO1010J'));

    const real2 = await routes.runModule('course-index-flow', { dryRun: false, input: {} });
    ok('--real 才交给执行器：文件写了、通知发了',
      real2.ok === true && written.length === 1 && real2.actions.filter((a) => a.status === 'done').length === 2,
      JSON.stringify({ written, summary: real2.summary, actions: real2.actions.map((a) => a.type + ':' + a.status) }));
  }
}

console.log('');
console.log(failures === 0 ? 'flow.test: PASS' : `flow.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
