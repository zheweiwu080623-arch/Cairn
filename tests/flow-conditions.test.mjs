// 能力图的**条件**（"如果…就…"）与跳过传播的验证（2026-10-02 · 台阶 2）。
//
//   node tests/flow-conditions.test.mjs
//
// 这一层为什么值得单独测：图上原来没有条件，所以只要需求里出现"如果……就……"，
// 就只能去写代码 —— 这是"必须写代码"的最大来源。加了条件之后，
// **"条件不成立"必须是安静跳过，而不是失败**；而且"上游没跑 ⇒ 下游也不跑"要自动传下去，
// 否则每加一个条件都得给所有下游重写一遍。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evalWhen, isTruthy, runFlow, summarizeFlow, validateFlow, whenRefs } from '../lib/flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('flow-conditions.test.mjs');

// ---------- ① 校验：条件写错了要在保存前就拦住 ----------
{
  const base = (when) => ({ schema: 'flow.v1', nodes: [{ id: 'a', capability: 'x', when }], edges: [] });
  ok('$引用 当条件：合法', validateFlow(base('$input.n')).ok === true);
  ok('true / false：合法', validateFlow(base(true)).ok === true && validateFlow(base(false)).ok === true);
  ok('{ref,op,value}：合法', validateFlow(base({ ref: '$input.n', op: 'gt', value: 0 })).ok === true);
  ok('数组当条件：拦住', validateFlow(base([1, 2])).errors.some((e) => e.includes('when 看不懂')));
  ok('认识不了的 op：拦住并列出可用的',
    validateFlow(base({ ref: '$input.n', op: 'bigger', value: 1 })).errors.some((e) => e.includes('bigger')));
  ok('条件引用了不存在的节点：拦住',
    validateFlow(base('$nope.x')).errors.some((e) => e.includes('不存在的节点')));
  ok('条件引用了"排在后面"的节点：拦住（值只能来自上游）',
    validateFlow({
      schema: 'flow.v1',
      nodes: [{ id: 'a', capability: 'x', when: '$b.v' }, { id: 'b', capability: 'y' }],
      edges: [['a', 'b']],
    }).errors.some((e) => e.includes('只能来自上游')));
  ok('whenRefs 把 ref 与 value 里的引用都收出来',
    whenRefs({ ref: '$a.b', op: 'eq', value: '$c.d' }).map((r) => r.node).join() === 'a,c');
}

// ---------- ② 求值：一堆比较，全是纯函数 ----------
{
  const out = { a: { n: 3, list: [1, 2], s: 'hello', empty: [], zero: 0, no: false } };
  const pass = (when) => evalWhen(when, out).pass;
  ok('空条件 = 成立（节点照跑）', evalWhen(undefined, out).pass === true);
  ok('$a.n 有值 ⇒ 成立', pass('$a.n') === true);
  ok('$a.empty 空数组 ⇒ 不成立', pass('$a.empty') === false);
  ok('$a.zero / $a.no ⇒ 不成立', pass('$a.zero') === false && pass('$a.no') === false);
  ok('取不到的路径 ⇒ 不成立（不抛）', pass('$a.nope.deep') === false);
  ok('gt / gte / lt / lte', pass({ ref: '$a.n', op: 'gt', value: 2 }) === true
    && pass({ ref: '$a.n', op: 'gte', value: 3 }) === true
    && pass({ ref: '$a.n', op: 'lt', value: 3 }) === false
    && pass({ ref: '$a.n', op: 'lte', value: 3 }) === true);
  ok('eq / ne（数字与字符串都对得上）',
    pass({ ref: '$a.n', op: 'eq', value: 3 }) === true && pass({ ref: '$a.n', op: 'ne', value: 4 }) === true);
  ok('contains：数组里找得到 / 文字里有这段',
    pass({ ref: '$a.list', op: 'contains', value: 2 }) === true
    && pass({ ref: '$a.s', op: 'contains', value: 'ell' }) === true
    && pass({ ref: '$a.s', op: 'contains', value: 'zzz' }) === false);
  ok('empty / notEmpty', pass({ ref: '$a.empty', op: 'empty' }) === true
    && pass({ ref: '$a.s', op: 'notEmpty' }) === true);
  ok('matches：正则匹配', pass({ ref: '$a.s', op: 'matches', value: '^he' }) === true);
  ok('value 也可以是引用（和上游比较）', pass({ ref: '$a.n', op: 'eq', value: '$a.n' }) === true);
  const bad = evalWhen({ ref: '$a.s', op: 'matches', value: '([' }, out);
  ok('坏正则：如实报错而不是抛', bad.ok === false && bad.reason.includes('正则'));
  const badOp = evalWhen({ ref: '$a.n', op: 'nope' }, out);
  ok('坏 op：如实报错', badOp.ok === false && badOp.reason.includes('不认识的条件 op'));
  ok('isTruthy：0 / "" / [] / false / null 都不成立，对象算成立',
    !isTruthy(0) && !isTruthy('') && !isTruthy([]) && !isTruthy(false) && !isTruthy(null) && isTruthy({}));
}

// ---------- ③ 跑图：条件不成立 = 安静跳过，并且往下游传 ----------
{
  const seen = [];
  const invoke = async (id, input) => {
    seen.push(id);
    if (id === 'count') return { ok: true, output: { n: Number(input.n ?? 0) } };
    if (id === 'say') return { ok: true, actions: [{ type: 'notify', summary: 'hi' }] };
    return { ok: true, output: {} };
  };
  const spec = (n) => ({
    schema: 'flow.v1',
    nodes: [
      { id: 'c', capability: 'count', input: { n } },
      { id: 'talk', capability: 'say', when: { ref: '$c.n', op: 'gt', value: 0 }, input: {} },
      { id: 'after', capability: 'say', input: { from: '$talk' } },   // 上游没跑 ⇒ 它也不跑
    ],
    edges: [['c', 'talk'], ['talk', 'after']],
  });

  const zero = await runFlow(spec(0), { invoke });
  ok('条件不成立：整个图仍然 ok（不是失败）', zero.ok === true);
  ok('条件不成立：那个节点标成 skipped，并写清原因',
    zero.nodes.find((x) => x.id === 'talk').skipped === true
    && String(zero.nodes.find((x) => x.id === 'talk').reason).includes('$c.n'),
    JSON.stringify(zero.nodes));
  ok('上游没跑 ⇒ 下游自动也不跑（不用自己重写条件）',
    zero.nodes.find((x) => x.id === 'after').skipped === true
    && String(zero.nodes.find((x) => x.id === 'after').reason).includes('上游'));
  ok('跳过的节点没被调用过', !seen.includes('say') || zero.actions.length === 0, String(seen));
  ok('汇总里带上"哪些节点被跳过"', zero.skipped.join() === 'talk,after', JSON.stringify(zero.skipped));
  ok('跳过时不产生任何动作', zero.actions.length === 0);

  seen.length = 0;
  const three = await runFlow(spec(3), { invoke });
  ok('条件成立：照常跑，动作也照常计划出来',
    three.ok === true && three.actions.length === 2 && three.skipped.length === 0, JSON.stringify(three.actions));

  // 坏 op 会在保存前被 validateFlow 拦住；**只有坏正则**这类"要真值才能判"的错误才留到运行时
  const broken = await runFlow({
    schema: 'flow.v1',
    nodes: [{ id: 'a', capability: 'count', when: { ref: '$input.x', op: 'matches', value: '([' }, input: {} }],
    edges: [],
  }, { invoke });
  ok('保存时查不出来的条件错误（坏正则）留到运行时：明确失败并指出是哪个节点',
    broken.ok === false && broken.error.includes('节点 a') && broken.error.includes('条件'), broken.error);
}

// ---------- ④ 一句话摘要要说清"有几个条件" ----------
{
  const s = summarizeFlow({
    nodes: [
      { id: 'a', capability: 'x' },
      { id: 'b', capability: 'y', when: '$a.v' },
    ],
  });
  ok('摘要里带条件数', s.includes('1 个条件'), s);
}

console.log('');
console.log(failures === 0 ? 'flow-conditions.test: PASS' : `flow-conditions.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
