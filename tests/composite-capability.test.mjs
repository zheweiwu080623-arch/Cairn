// **复合能力**（一条能力由别的能力拼出来）的验证（2026-10-02 · 台阶 1）。
//
//   node tests/composite-capability.test.mjs
//
// 台阶 1 的定义：在它之前，"功能"可以是能力图（不用写代码），但"能力"必须是一段 JS ——
// 平台的模块化就卡在这一个缺口上：想加一条能力，还是得掉回代码。
// 现在 `<数据目录>/capabilities/<id>.json` 里放一张图就是一条能力，
// 它和自带能力一样出现在登记表、素材栏与图执行里。
//
// 这一套测四件事：① 存/扫/读回；② 校验拦得住坏图（含"自己调自己"）；
// ③ 跑得通（含产出节点选择与动作透传）；④ 两个复合能力互相调用时不许转死。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import {
  flowCapabilities, normalizeComposite, runUserCapability, saveUserCapabilityFlow,
  scanUserCapabilities, userCapDir, validateComposite,
} from '../lib/capabilities/user.mjs';
import { createCapabilityRoutes } from '../lib/routes/capabilities.mjs';
import { createFlowRoutes } from '../lib/routes/flows.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};
const tmpData = () => {
  const dir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'cairn-comp-'));
  mkdirSync(join(dir, 'capabilities'), { recursive: true });
  return dir;
};
const tinyFlow = (extra = {}) => ({
  schema: 'flow.v1',
  nodes: [
    { id: 'one', capability: 'text.template', input: { template: 'A{{n}}', data: '$input' } },
    { id: 'two', capability: 'text.template', input: { template: '[{{text}}]', data: '$one' } },
  ],
  edges: [['one', 'two']],
  ...extra,
});

console.log('composite-capability.test.mjs');

// ---------- ① 校验：坏图必须在保存前拦住 ----------
{
  const known = ['text.template', 'notify.app'];
  const perms = (id) => (id === 'notify.app' ? ['notify:app'] : []);
  const good = { id: 'demo.a', name: '拼的', flow: tinyFlow() };
  ok('合法的复合能力通过', validateComposite(good, { id: 'demo.a', known, permissionsOf: perms }).ok === true,
    JSON.stringify(validateComposite(good, { id: 'demo.a', known, permissionsOf: perms }).errors));
  ok('没有 flow：拦住', validateComposite({ id: 'demo.a', name: 'x' }, { id: 'demo.a', known, permissionsOf: perms })
    .errors.some((e) => e.includes('flow')));
  ok('引用了不存在的能力：拦住并点名',
    validateComposite({ ...good, flow: { ...tinyFlow(), nodes: [{ id: 'x', capability: 'nope.nope' }] } }, { id: 'demo.a', known, permissionsOf: perms })
      .errors.some((e) => e.includes('nope.nope')));
  ok('自己调自己（直接）：拦住',
    validateComposite({ id: 'demo.a', name: 'x', flow: { nodes: [{ id: 'self', capability: 'demo.a' }], edges: [] } },
      { id: 'demo.a', known: [...known, 'demo.a'], permissionsOf: perms })
      .errors.some((e) => e.includes('不能（直接）调用它自己')));
  ok('和文件名对不上：拦住',
    validateComposite(good, { id: 'demo.b', known, permissionsOf: perms }).errors.some((e) => e.includes('文件名')));
  ok('id 和平台自带的重名：拦住',
    validateComposite({ ...good, id: 'text.template' }, { id: 'text.template', known, permissionsOf: perms })
      .errors.some((e) => e.includes('重名')));
  ok('out 指向的节点不存在：拦住',
    validateComposite({ ...good, flow: tinyFlow({ out: 'nope' }) }, { id: 'demo.a', known, permissionsOf: perms })
      .errors.some((e) => e.includes('flow.out')));
  ok('图里一条能力都没用：拦住',
    validateComposite({ ...good, flow: { nodes: [], edges: [] } }, { id: 'demo.a', known, permissionsOf: perms })
      .errors.some((e) => e.includes('至少')));
  ok('权限从图里推导（用了 notify.app 就要 notify:app）',
    normalizeComposite({ ...good, flow: { nodes: [{ id: 'n', capability: 'notify.app' }], edges: [] } },
      { id: 'demo.a', lookup: perms }).permissions.join() === 'notify:app');
  ok('flowCapabilities 去重保序',
    flowCapabilities({ flow: { nodes: [{ capability: 'a.b' }, { capability: 'a.b' }, { capability: 'c.d' }] } }).join() === 'a.b,c.d');
}

// ---------- ② 存 / 扫 / 读回 ----------
{
  const data = tmpData();
  const saved = await saveUserCapabilityFlow(data, { id: 'demo.hello', name: '拼出来的', spec: { flow: tinyFlow() } });
  ok('存成 capabilities/<id>.json', saved.ok === true && saved.file.endsWith('demo.hello.json'), JSON.stringify(saved));
  const raw = JSON.parse(readFileSync(join(userCapDir(data), 'demo.hello.json'), 'utf8'));
  ok('文件里是 {schema, id, flow}', raw.schema === 'capability.v1' && raw.id === 'demo.hello' && !!raw.flow);
  const all = await scanUserCapabilities(data);
  ok('扫描能读回来，且认得它是复合能力', all.length === 1 && all[0].composite === true && !all[0].error, JSON.stringify(all));
  ok('扫出来的形状能直接给界面用（有 ui.group / label）',
    all[0].meta.ui.group === '自写' && !!all[0].meta.ui.label);
  ok('id 不合法（带连字符）：拒绝', (await saveUserCapabilityFlow(data, { id: 'demo-bad', spec: { flow: tinyFlow() } })).ok === false);
  ok('id 和自带能力重名：拒绝',
    (await saveUserCapabilityFlow(data, { id: 'course.text', spec: { flow: tinyFlow() } })).ok === false);
  ok('图用了不存在的能力：拒绝，且**不留下半成品**',
    (await saveUserCapabilityFlow(data, { id: 'demo.bad', spec: { flow: { nodes: [{ id: 'x', capability: 'nope.nope' }], edges: [] } } })).ok === false
    && !(await scanUserCapabilities(data)).some((c) => c.id === 'demo.bad'));
  ok('没通过校验的文件不留在盘上（不然能力清单里会一直挂条坏的）',
    (await scanUserCapabilities(data)).length === 1);
}

// ---------- ③ 跑得通：调别的能力、选产出节点、动作透传 ----------
{
  const data = tmpData();
  await saveUserCapabilityFlow(data, { id: 'demo.hello', spec: { flow: tinyFlow() } });
  const calls = [];
  const invoke = async (id, input) => {
    calls.push({ id, input });
    if (id === 'text.template') {
      const data2 = input.data || {};
      const text = String(input.template).replace('{{n}}', data2.n || '').replace('{{text}}', data2.text || '');
      return { ok: true, output: { text } };
    }
    if (id === 'notify.app') return { ok: true, actions: [{ type: 'notify', summary: input.title }] };
    return { ok: false, error: `没有这个能力：${id}` };
  };
  const r = await runUserCapability(data, 'demo.hello', { n: 5 }, {}, { invoke });
  ok('复合能力跑得通：默认拿**最后一个跑完的节点**当产出',
    r.ok === true && r.output && String(r.output.text).includes('['), JSON.stringify(r));
  ok('节点入参里的 $input 也换对了（$one 的产出喂给了 $two）',
    calls.length === 2 && String(calls[1].input.data.text).includes('A5'), JSON.stringify(calls));
  ok('跑完会带上节点轨迹（界面要显示谁跑了）', Array.isArray(r.nodes) && r.nodes.length === 2);
  await saveUserCapabilityFlow(data, {
    id: 'demo.out',
    spec: { flow: { schema: 'flow.v1', nodes: [{ id: 'n', capability: 'notify.app', input: { title: '嗨' } }], edges: [], out: 'n' } },
  });
  const withAction = await runUserCapability(data, 'demo.out', {}, {}, { invoke });
  ok('写类能力产出的动作原样透传（dry-run 照样只演练）',
    withAction.ok === true && Array.isArray(withAction.actions) && withAction.actions[0].type === 'notify',
    JSON.stringify(withAction));
  ok('复合能力可以只用一条节点（不是必须多步）', withAction.ok === true);
  const bad = await runUserCapability(data, 'demo.hello', {}, {}, {});
  ok('没给调用器时明确报错（而不是静默返回空）', bad.ok === false && bad.error.includes('invoke'), JSON.stringify(bad));
}

// ---------- ④ 嵌套：复合能力调复合能力；互相调用不许转死 ----------
{
  const data = tmpData();
  await saveUserCapabilityFlow(data, { id: 'demo.inner', spec: { flow: tinyFlow() } });
  await saveUserCapabilityFlow(data, {
    id: 'demo.outer',
    spec: {
      flow: {
        schema: 'flow.v1',
        nodes: [{ id: 'in', capability: 'demo.inner', input: { n: '$input.n' } }],
        edges: [],
        out: 'in',
      },
    },
  });
  const host = createCapabilityHost({ providers: { dataDir: data } });
  const r = await host.invoke('demo.outer', { n: 7 });
  ok('复合能力里可以再用另一条复合能力（嵌套）', r.ok === true && String(r.output.text).includes('A7'), JSON.stringify(r).slice(0, 160));
  const data2 = tmpData();
  writeFileSync(join(userCapDir(data2), 'a.loop.json'), JSON.stringify({
    schema: 'capability.v1', id: 'a.loop', name: '环 A', version: '1.0.0', kind: 'compute',
    permissions: [], idempotent: true, cost: 'none', ui: { label: '环 A', group: '自写' },
    flow: { schema: 'flow.v1', nodes: [{ id: 'x', capability: 'b.loop' }], edges: [] },
  }), 'utf8');
  writeFileSync(join(userCapDir(data2), 'b.loop.json'), JSON.stringify({
    schema: 'capability.v1', id: 'b.loop', name: '环 B', version: '1.0.0', kind: 'compute',
    permissions: [], idempotent: true, cost: 'none', ui: { label: '环 B', group: '自写' },
    flow: { schema: 'flow.v1', nodes: [{ id: 'x', capability: 'a.loop' }], edges: [] },
  }), 'utf8');
  const host2 = createCapabilityHost({ providers: { dataDir: data2 } });
  const loop = await host2.invoke('a.loop', {});
  ok('两个复合能力互相调用：不会一直转下去，而是明确报"层数太深"',
    loop.ok === false && String(loop.error).includes('层数'), JSON.stringify(loop).slice(0, 200));
}

// ---------- ⑤ 接口：同一张图，存成功能 / 存成能力 ----------
{
  const data = tmpData();
  const modulesDir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'cairn-mod-'));
  const res = {};
  const sendJson = (_res, code, body) => { res.code = code; res.body = body; };
  const sendError = (_res, code, msg) => { res.code = code; res.body = { error: msg }; };
  let payload = {};
  const readBody = async () => payload;
  const flows = createFlowRoutes({ sendJson, sendError, readBody, modulesDir, dataDir: data });
  payload = { id: 'demo-flow', name: '拼的功能', spec: tinyFlow() };
  await flows.handleFlows({ method: 'POST' }, res, { pathname: '/api/flows/save' });
  ok('默认还是"存成功能"（modules/<id>/）', res.code === 200 && res.body.target === undefined && res.body.id === 'demo-flow',
    JSON.stringify(res.body));
  payload = { id: 'demo.flow2', name: '拼的能力', spec: tinyFlow(), target: 'capability' };
  await flows.handleFlows({ method: 'POST' }, res, { pathname: '/api/flows/save' });
  ok('target=capability：存成能力（capabilities/<id>.json）',
    res.code === 200 && res.body.target === 'capability' && String(res.body.file).endsWith('demo.flow2.json'), JSON.stringify(res.body));
  ok('存成能力时权限从图里推出来', Array.isArray(res.body.permissions) && res.body.permissions.length === 0);
  payload = { id: 'demo-bad', spec: tinyFlow(), target: 'capability' };
  await flows.handleFlows({ method: 'POST' }, res, { pathname: '/api/flows/save' });
  ok('能力 id 带连字符：明确拒绝并说清该怎么写', res.code === 400 && res.body.error.includes('点分'));
  payload = { id: 'demo.nope', spec: { schema: 'flow.v1', nodes: [{ id: 'x', capability: 'nope.nope' }], edges: [] }, target: 'capability' };
  await flows.handleFlows({ method: 'POST' }, res, { pathname: '/api/flows/save' });
  ok('图里用了不存在的能力：拒绝', res.code === 400 && res.body.error.includes('nope.nope'));
  payload = { spec: { schema: 'flow.v1', nodes: [{ id: 'u', capability: 'demo.flow2', input: { n: 2 } }], edges: [] }, input: {} };
  const host = createCapabilityHost({ providers: { dataDir: data } });
  const dry = createFlowRoutes({ sendJson, sendError, readBody, modulesDir, dataDir: data, capabilities: host });
  await dry.handleFlows({ method: 'POST' }, res, { pathname: '/api/flows/dry-run' });
  ok('复合能力能被别的图当节点用（试跑通过）', res.code === 200 && res.body.ok === true, JSON.stringify(res.body).slice(0, 160));
}

// ---------- ⑥ 「开发 · 能力」接口：目录 / 拼存 / 试跑 ----------
{
  const data = tmpData();
  const res = {};
  let payload = {};
  let opened = '';
  const routes = createCapabilityRoutes({
    sendJson: (_r, code, body) => { res.code = code; res.body = body; },
    sendError: (_r, code, msg) => { res.code = code; res.body = { error: msg }; },
    readBody: async () => payload,
    dataDir: data,
    capabilities: createCapabilityHost({ providers: { dataDir: data } }),
    openDir: async (dir) => { opened = dir; return { ok: true, cmd: 'explorer' }; },
  });
  const url = (p) => ({ pathname: p, searchParams: new URLSearchParams('') });
  await routes.handleCapabilities({ method: 'GET' }, res, url('/api/capabilities/dev'));
  ok('开发接口带上目录与"本地编辑"的说明',
    res.body.dir === userCapDir(data) && String(res.body.note).includes('重新扫'), JSON.stringify(res.body).slice(0, 200));
  ok('还带一份"拼一条能力"的模板', !!res.body.flow_template && Array.isArray(res.body.flow_template.flow.nodes));
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/dev/open'));
  ok('打开目录：走的是跨平台 openPath（Windows explorer / macOS open / Linux xdg-open）',
    res.code === 200 && opened === userCapDir(data) && res.body.via === 'explorer', JSON.stringify(res.body));
  payload = { id: 'demo.api', name: '接口拼的', flow: tinyFlow() };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/dev/save'));
  ok('把 flow 从接口存成一条能力', res.code === 200 && res.body.ok === true, JSON.stringify(res.body));
  payload = { id: 'demo.api', input: { n: 4 } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/dev/run'));
  ok('试跑复合能力：真跑（零副作用的那部分）并回产出',
    res.code === 200 && res.body.ok === true && String(res.body.output.text).includes('A4'), JSON.stringify(res.body).slice(0, 160));
  await routes.handleCapabilities({ method: 'GET' }, res, url('/api/capabilities'));
  const mine = (res.body.capabilities || []).find((c) => c.id === 'demo.api');
  ok('它出现在能力清单里，和自带能力同一种形状',
    !!mine && mine.source === 'user' && mine.composite === true && mine.group === '自写', JSON.stringify(mine).slice(0, 160));
}

// ---------- ⑦ 主程序别落后（接线是真的接上了） ----------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const stack = readFileSync(join(ROOT, 'lib', 'capability-stack.mjs'), 'utf8');
  // 2026-10-02：接线搬进了 lib/capability-stack.mjs（主程序有 2100 行护栏），
  // 所以守卫改成"主程序挂上这个 stack + stack 里把宿主与数据目录都接给能力层"。
  ok('主程序把能力宿主也交给了能力接口（复合能力才能跑）',
    srv.includes('createCapabilityStack(') && /createCapabilityRoutes\(\{[\s\S]*?capabilities,/.test(stack));
  ok('主程序把数据目录交给了能力搭建（复合能力才有地方存）',
    /createFlowStack\(\{[^}]*dataDir,/.test(stack) && /createCapabilityStack\(\{[\s\S]*?dataDir:\s*DATA_DIR/.test(srv));
}

console.log('');
console.log(failures === 0 ? 'composite-capability.test: PASS' : `composite-capability.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
