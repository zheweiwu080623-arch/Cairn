// 示例再处理功能（processor）—— 给"写一个功能"的人当模板，也是这套机制的活体测试。
//
// 约定（见 contracts/module.v1.schema.json 与 action.v1.schema.json）：
//   export function run(input, ctx) → actions[]
//     input：一条 signal（或任意入口数据）
//     ctx  ：{ store, now, dryRun, log, module, ...注入的能力（canvas / prefs / …） }
//   返回：action 数组（type 见 lib/processor.mjs 的 ACTION_TYPES）
//
// 这个小功能只做一件事：如果 signal 带着 `always_hello`，就产出一条"问好"通知；
// 否则 **什么都不做**（返回空数组 —— "没有值得打扰的事"也是一种正确结果）。

export function run(input = {}, ctx = {}) {
  const { dryRun = true, module = {} } = ctx;
  if (!input.always_hello && !input.title) {
    ctx.log?.(`[${module.id}] 没有需要处理的内容`);
    return [];
  }
  return [{
    type: 'notify',
    summary: `示例功能跑通了：${input.title || 'hello'}`,
    target: { kind: 'notification' },
    idempotency_key: `hello-processor:${input.title || 'hello'}`,
    permissions: ['notify:app'],
    payload: { text: dryRun ? '（这次是演练）' : '这是示例再处理功能发出的通知。' },
  }];
}
