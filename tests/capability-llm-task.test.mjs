// 两条"把信息变成理解与行动"的能力：**llm.ask**（问模型）与 **task.create**（建任务）。
//
//   node tests/capability-llm-task.test.mjs
//
// 为什么这两条一起测：它们合起来才让图上的"邮件 → 看懂 → 变成待办"走完，
// 而且正好落在 RQ-B 的两端 —— **哪一步交给模型（花 token、不确定），哪一步交给确定性程序**。
//
// 四条要守住的边界：
//   ① llm.ask 花的是用户自己的 token（cost: tokens 要如实标出来），模型由用户自己配；
//   ② llm.ask 失败**不抛**，返回 ok:false，让图自己决定"模型不可用时怎么办"；
//   ③ task.create 只建一条、只建不改（不改/不删用户已有的任务），默认演练；
//   ④ 同一个 idempotency_key 重跑**不会建第二条**。

import { getCapability, exposeOf, modelTools } from '../lib/capabilities/index.mjs';
import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import { run as llmAsk } from '../lib/capabilities/impl/llm.ask.mjs';
import { run as taskCreate } from '../lib/capabilities/impl/task.create.mjs';
import { canExecute, normalizeActions, summarizeActions } from '../lib/processor.mjs';
import { createProcessorExecutors } from '../lib/processor-executors.mjs';
import { runFlow } from '../lib/flow.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('capability-llm-task.test.mjs');

// ---------- ① 两条能力的"身份证" ----------
{
  const llm = getCapability('llm.ask');
  const task = getCapability('task.create');
  ok('llm.ask：compute + 花 token + 要 llm:ask 权限',
    llm.kind === 'compute' && llm.cost === 'tokens' && llm.permissions.join() === 'llm:ask');
  ok('llm.ask：标成不可重放（同样的问法不一定同样的话，而且再问一次还要花钱）', llm.idempotent === false);
  ok('llm.ask：可以直接给模型调（算类）', exposeOf(llm) === 'tool');
  ok('task.create：write + 要 data:write:tasks 权限 + 只能拿计划',
    task.kind === 'write' && task.permissions.join() === 'data:write:tasks' && exposeOf(task) === 'tool_with_confirm');
  ok('task.create：写类但可重放（靠 idempotency_key 防重复）', task.idempotent === true);
  const tools = modelTools();
  ok('两条都进了工具表，描述里写了"什么时候用"',
    tools.some((t) => t.name === 'llm.ask' && t.description.includes('自然语言'))
    && tools.some((t) => t.name === 'task.create' && t.description.includes('任务清单')));
  ok('task.create 的工具描述带 ⚠️（模型知道这只给计划）',
    String(tools.find((t) => t.name === 'task.create').description).startsWith('⚠️'));
}

// ---------- ② llm.ask：跑得通、失败不抛、prompt 有上限 ----------
{
  const noCtx = await llmAsk({ prompt: '你好' }, {});
  ok('没接模型时：如实说清去哪儿配（不抛）',
    noCtx.ok === false && noCtx.error.includes('Agent 接入'), JSON.stringify(noCtx));
  const empty = await llmAsk({}, { llm: { ask: async () => ({ ok: true, text: 'x' }) } });
  ok('没给 prompt：如实报错', empty.ok === false && empty.error.includes('prompt'));

  const seen = [];
  const r = await llmAsk({ prompt: '把这句话缩短：今天有三节课', system: '只输出一句话' },
    { llm: { ask: async (o) => { seen.push(o); return { ok: true, text: '三节课。', via: 'fake' }; } } });
  ok('跑通了：回文本 + 走的是哪条通道', r.ok === true && r.text === '三节课。' && r.via === 'fake');
  ok('system 原样带过去', seen[0].system === '只输出一句话');

  const long = await llmAsk({ prompt: 'x'.repeat(20000) },
    { llm: { ask: async (o) => { seen.push(o); return { ok: true, text: 'ok' }; } } });
  ok('prompt 有长度上限（12000 字，别把整份材料塞进去）', long.ok === true && seen[1].prompt.length === 12000);

  const down = await llmAsk({ prompt: 'x' }, { llm: { ask: async () => ({ ok: false, error: '没配 key' }) } });
  ok('模型报错：原样往上抛成 ok:false（让图自己判断）',
    down.ok === false && down.error === '没配 key', JSON.stringify(down));
}

// ---------- ③ task.create：产出的动作长什么样 ----------
{
  const r = await taskCreate({ title: '交 MATH1860J 作业 3', notes: '来自邮件', due_at: '2026-10-05T23:59:00+08:00', priority: 1, tags: '课程', idempotency_key: 'MATH1860J-hw3' });
  ok('产出一条 task 动作（不是直接写库）', Array.isArray(r.actions) && r.actions.length === 1 && r.actions[0].type === 'task');
  const a = r.actions[0];
  ok('标题/备注/截止/优先级都带上了',
    a.payload.title === '交 MATH1860J 作业 3' && a.payload.notes === '来自邮件'
    && a.target.due_at === '2026-10-05T23:59:00+08:00' && a.payload.priority === 1, JSON.stringify(a));
  ok('幂等键稳定（带上前缀，避免和别的能力撞）', a.idempotency_key === 'task.create:MATH1860J-hw3');
  const noKey = await taskCreate({ title: '没给 key 的任务' });
  ok('没给 key 时用标题兜底（同一件事重跑也不会刷屏）', noKey.actions[0].idempotency_key.includes('没给 key 的任务'));
  ok('没标题：如实报错，不产出动作', (await taskCreate({})).ok === false);
}

// ---------- ④ 执行器：真的建任务，且不重复建 ----------
{
  const tasks = [];
  const store = {
    listTasks: () => tasks.slice(),
    createTask: (t) => { const row = { ...t, id: `t${tasks.length + 1}` }; tasks.push(row); return row; },
  };
  const exec = createProcessorExecutors({ store, log: () => {} });
  const actions = normalizeActions([{
    type: 'task', summary: '交作业', idempotency_key: 'task.create:MATH-HW3',
    payload: { title: '交作业', priority: 1, notes: '来自邮件' }, target: { due_at: '2026-10-05T23:59:00+08:00' },
  }], { moduleId: 'mail-to-task', dryRun: false });
  ok('canExecute 现在认得 task 了（以前会被标"还没实现"）', canExecute(actions[0], { dryRun: false }).ok === true);
  const r1 = exec.task(actions[0], { id: 'mail-to-task', name: '邮件转任务' });
  ok('真跑：任务进了清单，且带来源', r1.ok === true && tasks.length === 1 && tasks[0].source === 'processor:mail-to-task');
  ok('优先级/截止时间都落进去了', tasks[0].priority === 1 && tasks[0].due_at === '2026-10-05T23:59:00+08:00');
  const r2 = exec.task(actions[0], { id: 'mail-to-task', name: '邮件转任务' });
  ok('同一个幂等键再跑一次：**不重复建**',
    r2.ok === true && tasks.length === 1 && String(r2.detail).includes('没重复建'), JSON.stringify({ n: tasks.length, r2 }));
  const bad = exec.task(normalizeActions([{ type: 'task', summary: '' }], { moduleId: 'x', dryRun: false })[0], { id: 'x', name: 'x' });
  ok('没标题的动作：报错而不是建一条空任务', bad.ok === false && tasks.length === 1);
  const dry = normalizeActions([{ type: 'task', summary: '交作业', payload: { title: '交作业' } }], { moduleId: 'x', dryRun: true });
  ok('演练：动作停在 planned（不会偷偷建任务）',
    dry[0].status === 'planned' && summarizeActions(dry, { dryRun: true }).includes('演练'));
  ok('task 没标题时 canExecute 也拦得住',
    canExecute({ type: 'task', status: 'planned', payload: {}, summary: '' }, { dryRun: false }).ok === false);
}

// ---------- ⑤ 一张真图：邮件 → 问模型 → 建任务（演练） ----------
{
  const host = createCapabilityHost({
    providers: {
      llm: () => ({ llm: { ask: async (o) => ({ ok: true, text: `【要点】${String(o.prompt).slice(-4)}`, via: 'fake' }) } }),
    },
  });
  const spec = {
    schema: 'flow.v1',
    nodes: [
      { id: 'ask', capability: 'llm.ask', input: { prompt: '把这条邮件总结成一句话：$input.mail' } },
      { id: 'mk', capability: 'task.create', when: '$ask.ok', input: { title: '$ask.text', notes: '来自邮件', idempotency_key: 'mail-digest' } },
    ],
    edges: [['ask', 'mk']],
  };
  const dry = await runFlow(spec, { invoke: (id, i, c) => host.invoke(id, i, c), ctx: host.allContext(), input: { mail: '老师说明天交作业' } });
  ok('图上跑通：llm.ask 的产出被 task.create 用上了',
    dry.ok === true && dry.actions.length === 1 && dry.actions[0].type === 'task'
    && String(dry.actions[0].payload.title).includes('【要点】'), JSON.stringify(dry.actions).slice(0, 200));
  const noModel = createCapabilityHost({ providers: {} });
  const fail = await runFlow(spec, { invoke: (id, i, c) => noModel.invoke(id, i, c), ctx: noModel.allContext(), input: { mail: 'x' } });
  ok('模型不可用时：ask 返回 ok:false ⇒ mk 这一条**安静跳过**（不会建一条空任务）',
    fail.ok === true && fail.skipped.join() === 'mk' && fail.actions.length === 0, JSON.stringify(fail.skipped));
}

console.log('');
console.log(failures === 0 ? 'capability-llm-task.test: PASS' : `capability-llm-task.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
