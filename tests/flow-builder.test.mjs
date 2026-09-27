// 能力搭建（M3）的验证：四个接口 + 页面渲染 + "试跑只演练"这条安全线。
//
//   node tests/flow-builder.test.mjs

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFlowRoutes } from '../lib/routes/flows.mjs';
import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import { renderPage, renderPalette, renderNodeCard } from '../modules/flow-builder/builder.js';
import * as fbView from '../modules/flow-builder/builder.js';
import { scanModules } from '../lib/modules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('flow-builder.test.mjs');

// ---------- ⓪ 真的把 mount 跑一遍（2026-09-26：页签绑定里用了没定义的 onAll ⇒ 整页"模块加载失败"） ----------
{
  // 两个页签做成"可点击"的假节点：点 dev 之后必须真的切到开发面板
  // （2026-09-26：点击处理器里把 state 写成了 S ⇒ 点击抛 ReferenceError、看着就是"点不动"）
  const paneNodes = ['build', 'dev'].map((id) => ({ dataset: { fbPane: id }, onclick: null }));
  const el = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '[data-fb-pane]' ? paneNodes : []),
    addEventListener: () => {},
  };
  const g = globalThis;
  const saved = { localStorage: g.localStorage, window: g.window, fetch: g.fetch };
  g.localStorage = { getItem: () => null, setItem: () => {} };
  g.window = { addEventListener: () => {} };
  // 关键：接口按真实形状返回**有能力的清单**，然后断言素材栏真的出现了按钮。
  // 2026-09-26 的根源 bug（mount 里存 caps、renderPage 读 capabilities）就是这么漏掉的。
  g.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('/api/capabilities/dev') ? { ok: true, capabilities: [], template: '// tpl' }
      : u.includes('/api/flows') ? { count: 0, flows: [] }
        : { count: 2, capabilities: [
          { id: 'course.scan', name: '扫课件目录', label: '扫课件目录', kind: 'read', kind_label: '只读', group: '课程', permissions: [], permission_labels: [], idempotent: true, cost: 'none', icon: '📂' },
          { id: 'course.text', name: '读课件', label: '读课件', kind: 'read', kind_label: '只读', group: '课程', permissions: [], permission_labels: [], idempotent: true, cost: 'none', icon: '📄' },
        ] };
    return { ok: true, status: 200, json: async () => body };
  };
  let err = '';
  try { await fbView.mount(el, { api: async () => ({}), DB: { capabilities: [] } }); }
  catch (e) { err = (e && e.message) || String(e); }
  g.localStorage = saved.localStorage; g.window = saved.window; g.fetch = saved.fetch;
  ok('mount() 不抛错（页签/开发面板绑定的助手都在）', err === '', err);
  ok('mount() 至少画出了一帧', el.innerHTML.length > 200, String(el.innerHTML.length));
  ok('mount() 之后素材栏真的有按钮（这条就是"0 条能力"根源的守卫）',
    el.innerHTML.includes('data-add="course.scan"'), el.innerHTML.slice(0, 200));
  ok('mount() 之后能切到开发页签（两个页签都在）',
    el.innerHTML.includes('data-fb-pane="build"') && el.innerHTML.includes('data-fb-pane="dev"'));
  ok('两个页签都绑上了点击处理器', typeof paneNodes[0].onclick === 'function' && typeof paneNodes[1].onclick === 'function');
  let clickErr = '';
  try { paneNodes[1].onclick({ currentTarget: paneNodes[1] }); } catch (e) { clickErr = (e && e.message) || String(e); }
  ok('点「开发 · 能力」不抛错', clickErr === '', clickErr);
  ok('点完真的切到开发面板（出现代码框与保存按钮）',
    el.innerHTML.includes('fb-dev-code') && el.innerHTML.includes('fb-dev-save'), el.innerHTML.slice(0, 120));
}

const CAPS = [
  { id: 'course.scan', name: '扫课程资料目录', label: '扫课件目录', kind: 'read', group: '课程',
    kind_label: '只读（磁盘或网络）', permissions: ['fs:read:course'], idempotent: true, icon: '📂' },
  { id: 'course.text', name: '把课程材料读成文字并检索', label: '读课件', kind: 'read', group: '课程',
    kind_label: '只读（磁盘或网络）', permissions: ['fs:read:course'], idempotent: true, icon: '📄' },
  { id: 'file.write', name: '写产物文件', label: '写产物文件', kind: 'write', group: '产物',
    kind_label: '写本机（文件 / 库 / 通知）', permissions: ['fs:write:data'], idempotent: true, icon: '💾' },
];

// ---------- 页面（纯函数） ----------
{
  const html = renderPage({ capabilities: CAPS, nodes: [{ id: 'scan', capability: 'course.scan', input: {} }], flows: [] });
  ok('素材栏按分组列出能力', html.includes('课程') && html.includes('产物') && html.includes('data-add="course.scan"'));
  ok('画布有连线用的 svg 与节点列', html.includes('id="fb-lines"') && html.includes('id="fb-nodes"'));
  ok('节点卡片带能力下拉（可换能力）', html.includes('data-node-cap="0"'));
  ok('三颗按钮齐（清空 / 试跑 / 存成新功能）', ['fb-clear', 'fb-dry', 'fb-save'].every((id) => html.includes(`id="${id}"`)));
  ok('空图时给一句人话提示', renderPage({ capabilities: CAPS, nodes: [] }).includes('左边点几条能力'));
  ok('素材栏过滤掉空输入不炸', renderPalette([]).includes('没有可用的能力'));

  const card = renderNodeCard({ id: 'save', capability: 'file.write', input: { path: '$index.path' } }, 1, { ...CAPS[2], __all: CAPS });
  ok('节点卡片把入参 JSON 填进文本框（$引用原样保留）', card.includes('$index.path'));
  ok('节点卡片标出读写性质', card.includes('写'));
  ok('节点卡片有上移/下移/删除', card.includes('data-up="1"') && card.includes('data-down="1"') && card.includes('data-del="1"'));
  ok('节点可拖动（draggable）', card.includes('draggable="true"'));

  // ---- M3 第二版：任意连线（不再是"相邻即连"） ----
  const wired = renderNodeCard({ id: 'index', capability: 'course.text', input: {} }, 2, { ...CAPS[1], __all: CAPS },
    { inbound: [{ from: 'scan' }, { from: 'other' }], sources: ['save', 'extra'] });
  ok('节点上列出所有上游（可以有多条）', wired.includes('← scan') && wired.includes('← other'));
  ok('每条上游都能单独断掉', wired.includes('data-unlink="2:scan"') && wired.includes('data-unlink="2:other"'));
  ok('能从任意节点连过来（下拉 + ＋连线）', wired.includes('data-link-from="2"') && wired.includes('data-link="2"')
    && wired.includes('<option value="save">save</option>'));
  ok('没有上游的节点写清"这一条是起点"',
    renderNodeCard({ id: 'scan', capability: 'course.scan' }, 0, { ...CAPS[0], __all: CAPS }, { inbound: [], sources: ['read'] }).includes('这一条是起点'));
  const dagPage = renderPage({
    capabilities: CAPS,
    nodes: [{ id: 'scan', capability: 'course.scan' }, { id: 'read', capability: 'course.text' }],
    edges: [{ from: 'scan', to: 'read' }],
    flows: [],
  });
  ok('页面头部写出"几条连线"', dagPage.includes('1 条连线'));
  ok('连线列表按边渲染（不是按相邻）', dagPage.includes('data-unlink="1:scan"'));
}

// ---------- 接口 ----------
{
  const TMP = process.env.PLANNER_TEST_TMP || tmpdir();
  let modulesDir = '';
  try { modulesDir = mkdtempSync(join(TMP, 'flowbuilder-')); } catch { modulesDir = ''; }
  if (!modulesDir) {
    console.log('  SKIP 临时目录不可写（没设 PLANNER_TEST_TMP）—— 接口那几条跳过');
  } else {
    const host = createCapabilityHost({ providers: {} });
    const calls = [];
    const capabilities = {
      ...host,
      invoke: async (id, input) => {
        calls.push(id);
        if (id === 'course.scan') return { ok: true, output: { courses: [{ name: 'DEMO1010J' }] } };
        if (id === 'course.text') return { ok: true, output: { materials: [{ name: 'a.pdf' }] } };
      if (id === 'file.write') return { ok: true, actions: [{ type: 'file', target: { path: input.path }, payload: { text: input.text } }] };
      if (id === 'notify.app') return { ok: true, actions: [{ type: 'notify', summary: input.title, payload: { text: '' } }] };
      return { ok: false, error: `没接 ${id}` };
      },
      allContext: () => ({}),
    };
    const routes = createFlowRoutes({
      modulesDir,
      sendJson: (res, code, body) => { res.code = code; res.body = body; },
      sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
      readBody: async (req) => req.body,
      capabilities,
    });
    const spec = {
      schema: 'flow.v1',
      nodes: [
        { id: 'scan', capability: 'course.scan' },
        { id: 'read', capability: 'course.text', input: { courses: '$scan.courses' } },
        { id: 'save', capability: 'file.write', input: { path: 'C:/tmp/x.md', text: 'hi' } },
      ],
      edges: [['scan', 'read'], ['read', 'save']],
    };
    // 菱形图（M3 第二版的目标形态）：scan 同时喂给 read 与 notify，read 再喂给 save
    const dag = {
      schema: 'flow.v1',
      nodes: [
        { id: 'scan', capability: 'course.scan' },
        { id: 'read', capability: 'course.text', input: { courses: '$scan.courses' } },
        { id: 'save', capability: 'file.write', input: { path: 'C:/tmp/y.md', text: 'hi' } },
        { id: 'tell', capability: 'notify.app', input: { title: '扫完了' } },
      ],
      edges: [['scan', 'read'], ['read', 'save'], ['scan', 'tell']],
    };

    const v = {};
    await routes.handleFlows({ method: 'POST', body: { spec } }, v, { pathname: '/api/flows/validate' });
    ok('校验接口：合法图 ok，并给出拓扑序', v.body.ok === true && v.body.order.join(',') === 'scan,read,save', JSON.stringify(v.body).slice(0, 160));
    const bad = {};
    await routes.handleFlows({ method: 'POST', body: { spec: { nodes: [{ id: 'a', capability: 'x' }], edges: [['a', 'a']] } } }, bad, { pathname: '/api/flows/validate' });
    ok('校验接口：坏图给出人话错误', bad.body.ok === false && bad.body.errors.join('；').includes('环'), JSON.stringify(bad.body).slice(0, 160));

    const dry = {};
    await routes.handleFlows({ method: 'POST', body: { spec } }, dry, { pathname: '/api/flows/dry-run' });
    ok('试跑接口：跑通并列出节点', dry.body.ok === true && dry.body.nodes.length === 3, JSON.stringify(dry.body).slice(0, 200));
    ok('试跑接口：动作只有 planned（这条是安全线）',
      dry.body.planned.length === 1 && dry.body.planned.every((a) => a.status === 'planned'), JSON.stringify(dry.body.planned));
    ok('试跑接口：响应里没有"已执行"的痕迹', !/done/.test(JSON.stringify(dry.body.planned)));

    const saved = {};
    await routes.handleFlows({ method: 'POST', body: { id: 'my-flow', name: '我的流程', spec } }, saved, { pathname: '/api/flows/save' });
    ok('保存接口：写出模块目录', saved.body.ok === true && existsSync(join(modulesDir, 'my-flow', 'flow.json')), JSON.stringify(saved.body));
    ok('保存出来的 module.json 自动声明了能力与权限',
      saved.body.capabilities.join(',') === 'course.scan,course.text,file.write'
      && saved.body.permissions.join(',') === 'fs:read:course,fs:write:data', JSON.stringify(saved.body));
    ok('存出来的模块能被模块系统发现（kind=processor + entry.flow）',
      scanModules(modulesDir).some((m) => m.id === 'my-flow' && m.entry.flow && !m.error));

    const again = {};
    await routes.handleFlows({ method: 'POST', body: { id: 'my-flow', spec } }, again, { pathname: '/api/flows/save' });
    ok('同名默认拒绝覆盖（要覆盖得显式说）', again.code === 409, JSON.stringify(again.body));
    const badId = {};
    await routes.handleFlows({ method: 'POST', body: { id: '../坏 名字', spec } }, badId, { pathname: '/api/flows/save' });
    ok('坏 id（含路径/空格）被拦下', badId.code === 400, JSON.stringify(badId.body));
    const evil = {};
    await routes.handleFlows({ method: 'POST', body: { id: 'ok-id', spec: { ...spec, nodes: [...spec.nodes, { id: 'x', capability: 'nope.nope' }], edges: [...spec.edges, ['save', 'x']] } } }, evil, { pathname: '/api/flows/save' });
    ok('图里用了不存在的能力 → 拒绝保存', evil.code === 400 && evil.body.error.includes('nope.nope'), JSON.stringify(evil.body));

    const list = {};
    await routes.handleFlows({ method: 'GET' }, list, { pathname: '/api/flows' });
    ok('列表接口列出刚存的那个功能（带节点数与能力）',
      list.body.count === 1 && list.body.flows[0].id === 'my-flow' && list.body.flows[0].nodes === 3,
      JSON.stringify(list.body).slice(0, 200));

    // ---- 任意 DAG：一个节点可以喂多个下游 ----
    const vDag = {};
    await routes.handleFlows({ method: 'POST', body: { spec: dag } }, vDag, { pathname: '/api/flows/validate' });
    ok('菱形图（一个节点喂两个下游）能通过校验',
      vDag.body.ok === true && vDag.body.order.includes('tell'), JSON.stringify(vDag.body).slice(0, 200));
    const dryDag = {};
    await routes.handleFlows({ method: 'POST', body: { spec: dag } }, dryDag, { pathname: '/api/flows/dry-run' });
    ok('菱形图能跑通：4 个节点、2 条写动作（file + notify）全部 planned',
      dryDag.body.ok === true && dryDag.body.nodes.length === 4 && dryDag.body.planned.length === 2
      && dryDag.body.planned.every((a) => a.status === 'planned'),
      JSON.stringify({ nodes: dryDag.body.nodes && dryDag.body.nodes.length, planned: dryDag.body.planned }).slice(0, 240));
    const savedDag = {};
    await routes.handleFlows({ method: 'POST', body: { id: 'my-dag', spec: dag } }, savedDag, { pathname: '/api/flows/save' });
    const savedSpec = JSON.parse(readFileSync(join(modulesDir, 'my-dag', 'flow.json'), 'utf8'));
    ok('存出来的图把"任意连线"原样写进 flow.json（不是偷偷改成链）',
      savedDag.body.ok === true && savedSpec.edges.length === 3
      && savedSpec.edges.some((e) => e[0] === 'scan' && e[1] === 'tell'),
      JSON.stringify(savedSpec.edges));
    const cyclic = {};
    await routes.handleFlows({ method: 'POST', body: { id: 'cyclic-flow', spec: { ...dag, edges: [...dag.edges, ['tell', 'scan']] } } }, cyclic, { pathname: '/api/flows/save' });
    ok('连成环就拒绝保存（图上可以连，但不许连出环）', cyclic.code === 400 && cyclic.body.error.includes('环'), JSON.stringify(cyclic.body).slice(0, 160));
  }
}

// ---------- 接线与页面源码守卫 ----------
{
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  const view = readFileSync(join(ROOT, 'modules', 'flow-builder', 'builder.js'), 'utf8');
  ok('主程序挂了 /api/flows', srv.includes("'/api/flows'") && srv.includes('createFlowStack('));
  ok('view 模块能被"切过去才 import"那套挂上（导出了 mount）', /export async function mount\(/.test(view));
  ok('页面用的是四个约定接口',
    view.includes("readJson('/api/capabilities')") && view.includes("readJson('/api/flows')")
    && view.includes("api('POST', '/api/flows/dry-run'") && view.includes("api('POST', '/api/flows/save'"));
  ok('两个读取显式不缓存（2026-09-25 踩过：浏览器的缓存让素材栏一直是空的）',
    view.includes("cache: 'no-store'"));
  ok('读不出来会说出来（不给一张空素材栏让人猜）',
    view.includes('能力清单没读出来'));
  ok('连线是 SVG 曲线，而且按**每一条连线**画（不再按相邻）',
    view.includes('C ${x1} ${mid}') && view.includes('stroke-dasharray') && view.includes('for (const e of state.edges)'));
  // 2026-09-26 用户报"开发能力点不动"：页签画了但没绑点击（保存/试跑同样漏了）
  ok('两个页签（搭功能 / 开发 · 能力）都绑了点击',
    view.includes("onAll('[data-fb-pane]'") && view.includes("state.pane = e.currentTarget.dataset.fbPane === 'dev' ? 'dev' : 'build'"));
  ok('开发面板的三个动作都绑了（保存并注册 / 试跑 / 打开）',
    view.includes("on('#fb-dev-save'") && view.includes("on('#fb-dev-run'")
    && view.includes("onAll('[data-fb-dev-run]'") && view.includes("onAll('[data-fb-dev-load]'"));
  ok('节点拖动换顺序（HTML5 拖拽）', view.includes('ondragstart') && view.includes('ondrop'));
  ok('app.js 会给 kind=view 的模块建页面并挂载（不需要为主程序加特例）',
    app.includes("m.kind === 'view' && !MODULES.some((x) => x.tab === m.id)") && app.includes('await mod.mount(box,'));
  ok('样式里有搭建页的类', readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8').includes('.fb-nodecol'));
}

console.log('');
console.log(failures === 0 ? 'flow-builder.test: PASS' : `flow-builder.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
