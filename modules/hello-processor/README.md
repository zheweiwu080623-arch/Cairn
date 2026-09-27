# 示例再处理功能（hello-processor）

`kind: processor` 的最小样板：**吃一条 signal，吐一组 action**。

```js
// run.js
export function run(input, ctx) {
  if (!input.title) return [];            // 没有值得处理的东西 → 什么都不做
  return [{ type: 'notify', summary: `…`, idempotency_key: '…' }];
}
```

三条约定：

1. **默认演练**：`POST /api/modules/hello-processor/run` 不带 `dry_run:false` 时，
   所有动作停在 `planned`，不会有任何副作用；
2. **动作会被规范化**（`lib/processor.mjs`）：认得 `notify / push / task / event / mail / file / external / archive / report`；
   认不出来的会被标成 `failed` 并写清原因；
3. **想静默就返回空数组**："没有值得打扰的事"是正确结果，不要为了刷存在感硬造通知。

试一下：

```bash
curl -X POST http://127.0.0.1:3210/api/modules/hello-processor/run \
  -H 'Content-Type: application/json' \
  -d '{"input":{"title":"第一次跑"}}'          # 默认演练
curl -X POST … -d '{"dry_run":false,"input":{"title":"真的来一条"}}'   # 真跑（会进通知）
```
