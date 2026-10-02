// 「能力 = 给模型的工具表」的验证（2026-10-02 · 台阶 A/C）。
//
//   node tests/capability-model-tools.test.mjs
//
// 这一步在回答的问题（也是 RQ-B）：**哪些事该交给模型、哪些必须确定性程序或人来点头。**
// 三条判据：
//   ① 每条能力都有一句"什么时候该用它"（model.description），不能给模型一个空描述；
//   ② 默认按 kind 推导"给不给调"：read/compute → 可直接调；write/outbound → 只能拿计划；
//      想例外就显式写 model.expose（例如 logic.each 只能用在图里 ⇒ none）；
//   ③ **写类"只给计划"这件事由服务端保证**，不靠提示词里写"请先确认"。

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAPABILITIES, EXPOSE_VALUES, capabilityIdFromToolName, defaultExpose, exposeOf, getCapability,
  modelDescriptionOf, modelTools, validateCapability,
} from '../lib/capabilities/index.mjs';
import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import { saveUserCapabilityFlow, scanUserCapabilities } from '../lib/capabilities/user.mjs';
import { createCapabilityRoutes } from '../lib/routes/capabilities.mjs';
import { CAP_PREFIX, capabilityIdFromMcpName, formatCapabilityResult, handleMessage, mcpNameForCapability } from '../lib/mcp-server.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('capability-model-tools.test.mjs');

// ---------- ① 每条能力都有"给模型看的那一面" ----------
{
  const noDesc = CAPABILITIES.filter((c) => !(c.model && typeof c.model.description === 'string' && c.model.description.trim()));
  ok('17 条能力每条都写了 model.description', noDesc.length === 0, noDesc.map((c) => c.id).join(', '));
  const tooShort = CAPABILITIES.filter((c) => c.model.description.length < 12);
  ok('描述不是敷衍的一句话（都要说清"什么时候用"）', tooShort.length === 0, tooShort.map((c) => c.id).join(', '));
  const bad = CAPABILITIES.map((c) => ({ id: c.id, r: validateCapability({ ...c, schema: 'capability.v1' }) })).filter((x) => !x.r.ok);
  ok('带 model 段的描述符照样过 capability.v1 校验', bad.length === 0,
    bad.map((x) => `${x.id}: ${x.r.errors.join('；')}`).join(' | '));
  ok('model.expose 写了就必须是那三档之一',
    validateCapability({ id: 'a.b', name: 'x', version: '1.0.0', kind: 'read', cost: 'none', idempotent: true, permissions: [], model: { expose: '随便调' } })
      .errors.some((e) => e.includes('model.expose')));
  ok('model.description 空字符串要被拦住',
    validateCapability({ id: 'a.b', name: 'x', version: '1.0.0', kind: 'read', cost: 'none', idempotent: true, permissions: [], model: { description: '   ' } })
      .errors.some((e) => e.includes('model.description')));
}

// ---------- ② 默认推导 + 显式覆盖 ----------
{
  ok('read / compute 默认可直接给模型调', defaultExpose('read') === 'tool' && defaultExpose('compute') === 'tool');
  ok('write / outbound 默认只能拿计划', defaultExpose('write') === 'tool_with_confirm' && defaultExpose('outbound') === 'tool_with_confirm');
  ok('显式写了就听显式的', exposeOf({ kind: 'write', model: { expose: 'tool' } }) === 'tool');
  ok('logic.each 是唯一的 none（它只能用在图里）',
    exposeOf(getCapability('logic.each')) === 'none'
    && CAPABILITIES.filter((c) => exposeOf(c) === 'none').map((c) => c.id).join() === 'logic.each');
  ok('没有 model 段的老形状也推得出来（不会崩）', exposeOf({ kind: 'read' }) === 'tool' && EXPOSE_VALUES.includes(exposeOf({})));
  ok('没有描述时退回 notes / name（不给模型空描述）',
    modelDescriptionOf({ id: 'a.b', name: '某能力', notes: '边界说明' }) === '边界说明'
    && modelDescriptionOf({ id: 'a.b', name: '某能力' }).includes('某能力'));
}

// ---------- ③ 工具表 ----------
{
  const tools = modelTools();
  ok('工具表里没有 none 的那条（19 条能力 → 18 个工具）', tools.length === CAPABILITIES.length - 1, String(tools.length));
  const confirm = tools.filter((t) => t.expose === 'tool_with_confirm').map((t) => t.name);
  ok('6 条写类/外发类标成"要确认"',
    confirm.join() === 'course.artifacts,dedupe.markSeen,file.write,notify.app,push.phone,task.create', confirm.join());
  ok('llm.ask 可以直接给模型调（算类），并在描述里说清"花 token"',
    tools.find((t) => t.name === 'llm.ask').expose === 'tool'
    && tools.find((t) => t.name === 'llm.ask').description.includes('token'));
  ok('task.create 是写类：只给计划，描述里说清"不改也不删"',
    tools.find((t) => t.name === 'task.create').expose === 'tool_with_confirm'
    && tools.find((t) => t.name === 'task.create').description.includes('不改也不删'));
  const notify = tools.find((t) => t.name === 'notify.app');
  ok('写类工具的描述里带⚠️（模型一眼看出"这只会给计划"）', String(notify.description).startsWith('⚠️'), notify.description.slice(0, 30));
  ok('每条工具都带 inputSchema（MCP 要）', tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  ok('不想要写类时可以只要读类', modelTools({ includeConfirm: false }).every((t) => t.expose === 'tool'));
  ok('能力 id ↔ 工具名双向唯一（id 里不许下划线，所以不会撞）',
    CAPABILITIES.every((c) => capabilityIdFromToolName(c.id, CAPABILITIES.map((x) => x.id)) === c.id
      && capabilityIdFromToolName(c.id.replace(/\./g, '_'), CAPABILITIES.map((x) => x.id)) === c.id));
  ok('认不出来的名字返回 null', capabilityIdFromToolName('不存在的', ['course.text']) === null);
}

// ---------- ④ 接口：工具表 + 调一条能力 ----------
{
  const dataDir = mkdtempSync(join(tmpdir(), 'cairn-model-'));
  mkdirSync(join(dataDir, 'capabilities'), { recursive: true });
  const res = {};
  let payload = {};
  const routes = createCapabilityRoutes({
    sendJson: (_r, code, body) => { res.code = code; res.body = body; },
    sendError: (_r, code, msg) => { res.code = code; res.body = { error: msg }; },
    readBody: async () => payload,
    dataDir,
    capabilities: createCapabilityHost({ providers: { dataDir } }),
  });
  const url = (p) => ({ pathname: p, searchParams: new URLSearchParams('') });

  await routes.handleCapabilities({ method: 'GET' }, res, url('/api/capabilities/model-tools'));
  ok('GET /api/capabilities/model-tools 给出工具表',
    res.code === 200 && res.body.count === CAPABILITIES.length - 1 && res.body.note.includes('只返回计划'),
    JSON.stringify(res.body).slice(0, 160));

  // 读类：直接给产出
  payload = { id: 'json.pick', input: { data: { a: { b: 7 } }, path: 'a.b' } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('读类能力直接返回产出', res.code === 200 && res.body.ok === true
    && res.body.requires_confirmation === false && res.body.output.value === 7, JSON.stringify(res.body).slice(0, 160));

  // 用下划线别名也认
  payload = { id: 'json_pick', input: { data: { a: { b: 8 } }, path: 'a.b' } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('工具名用下划线写法也认（对严格校验的 MCP 客户端友好）', res.code === 200 && res.body.output.value === 8);

  // 写类：只给计划，绝不执行
  payload = { id: 'notify.app', input: { title: '你好', text: '正文' } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('写类能力：只回"计划"，并明确标 requires_confirmation',
    res.code === 200 && res.body.requires_confirmation === true && res.body.planned[0].type === 'notify'
    && String(res.body.note).includes('还没有真的执行'), JSON.stringify(res.body).slice(0, 200));
  ok('写类的回应里没有 output（避免调用方以为已经做完了）', res.body.output === undefined);

  // none 的调不动
  payload = { id: 'logic.each', input: { items: [], capability: 'x' } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('expose=none 的能力明确拒绝（403）', res.code === 403 && res.body.error.includes('没有对外开放'));

  payload = { id: 'nope.nope' };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('不认识的能力：404', res.code === 404);

  // 自写（复合）能力也进工具表
  const spec = {
    schema: 'flow.v1',
    nodes: [{ id: 'n', capability: 'json.pick', input: { data: '$input', path: 'k' } }],
    edges: [], out: 'n',
  };
  await saveUserCapabilityFlow(dataDir, { id: 'demo.tool', name: '拼的工具', spec: { flow: spec, notes: '当用户要试一下拼出来的能力时用它。' } });
  await routes.handleCapabilities({ method: 'GET' }, res, url('/api/capabilities/model-tools'));
  ok('自写（复合）能力也进工具表，并且带上了它的说明',
    res.body.count === CAPABILITIES.length && res.body.tools.some((t) => t.name === 'demo.tool' && t.description.includes('试一下')));
  payload = { id: 'demo.tool', input: { k: 42 } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('自写能力能被当工具调（产出就是对的下游结果）', res.code === 200 && res.body.output.value === 42, JSON.stringify(res.body).slice(0, 160));
  const all = await scanUserCapabilities(dataDir);
  ok('自写能力的 model 段是从 notes 派生的（不写也有话说）', String(all[0].meta.model.description).includes('试一下'));
}

// ---------- ⑤ MCP 那一侧 ----------
{
  ok('能力 id → MCP 工具名（点分换下划线、加前缀）',
    mcpNameForCapability('course.text') === 'cairn_cap_course_text'
    && mcpNameForCapability('canvas.course.check') === 'cairn_cap_canvas_course_check');
  ok('MCP 工具名 → 能力 id（还原成下划线写法，服务端两种都认）',
    capabilityIdFromMcpName('cairn_cap_course_text') === 'course_text'
    && capabilityIdFromToolName(capabilityIdFromMcpName('cairn_cap_course_text'), CAPABILITIES.map((c) => c.id)) === 'course.text');
  ok('cairn_cap_ 前缀才认（五个固定工具不会被误当能力）',
    capabilityIdFromMcpName('cairn_today') === null && String(mcpNameForCapability('a.b')).startsWith(CAP_PREFIX));

  // 假 Cairn：只答复这两个接口
  const seen = [];
  const fakeFetch = async (u) => {
    seen.push(String(u));
    if (String(u).endsWith('/api/capabilities/model-tools')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ count: 2, tools: [
        { name: 'json.pick', title: '取 JSON 字段', description: '当要取字段时用它。', inputSchema: { type: 'object', properties: {} }, expose: 'tool' },
        { name: 'notify.app', title: '发本机通知', description: '⚠️ 写操作：调用只会得到"计划"，真执行由用户确认。当要告诉用户时用它。', inputSchema: { type: 'object', properties: {} }, expose: 'tool_with_confirm' },
      ] }) };
    }
    if (String(u).endsWith('/api/mcp/today')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ error: '没接' }) };
    }
    if (String(u).endsWith('/api/capabilities/invoke')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: 'notify.app', expose: 'tool_with_confirm', requires_confirmation: true, planned: [{ type: 'notify', summary: '你好' }] }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { fetchImpl: fakeFetch });
  ok('initialize 里说清了"写类只给计划"', String(init.result.instructions).includes('只会得到"计划"'));
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { fetchImpl: fakeFetch });
  const names = list.result.tools.map((t) => t.name);
  ok('tools/list = 五个固定工具 + 能力工具',
    names.includes('cairn_today') && names.includes('cairn_cap_json_pick') && names.includes('cairn_cap_notify_app'), names.join(','));
  const capTool = list.result.tools.find((t) => t.name === 'cairn_cap_notify_app');
  ok('能力工具的 inputSchema 补上了 MCP 要的 type/additionalProperties',
    capTool.inputSchema.type === 'object' && capTool.inputSchema.additionalProperties === true);

  const call = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cairn_cap_notify_app', arguments: { title: '你好' } } }, { fetchImpl: fakeFetch });
  const text = call.result.content[0].text;
  ok('调写类能力：回的是"计划、还没执行"', text.includes('还没有执行') && text.includes('notify'));
  ok('走的是 /api/capabilities/invoke（不是直连数据库）', seen.some((u) => u.endsWith('/api/capabilities/invoke')));

  const off = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  ok('服务没起时：只给固定工具，不编造能力表', off.result.tools.length === 5, String(off.result.tools.length));
  ok('formatCapabilityResult 对读类给原文、对写类给计划',
    formatCapabilityResult({ ok: true, id: 'json.pick', output: { value: 1 } }).includes('"value": 1')
    && formatCapabilityResult({ ok: true, id: 'x', requires_confirmation: true, planned: [{ type: 'file', summary: '写 a.md' }] }).includes('写 a.md'));
}

console.log('');
console.log(failures === 0 ? 'capability-model-tools.test: PASS' : `capability-model-tools.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
