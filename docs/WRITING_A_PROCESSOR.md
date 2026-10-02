# 怎么写一个"再处理功能"（processor）

> **读者**：想让 Cairn 帮你做点事的人（不一定是程序员）。
> 前置：先看 [它是怎么运作的](HOW_IT_WORKS.md) 里的三段式（**汇总 → 分析 → 再处理**）。
> 这一篇讲的是**第三段**：拿到判断结果之后，去做一件具体的事。

---

## 0. 一句话

一个功能就是**一个目录**，里面导出**一个函数**：

```js
// modules/我的功能/run.js
export function run(input, ctx) {
  if (没有值得做的事) return [];              // 安静是正确结果
  return [{ type: 'notify', summary: '…' }];  // 否则给出你要做的动作
}
```

**你不需要改主程序、不需要装任何依赖** —— Cairn 是零依赖项目，你的功能也只能用 Node 内置能力。

---

## 1. 最小的功能（30 秒）

```bash
node bin/cairn.mjs mod new 我的功能 --name "我的第一个功能"
# → modules/我的功能/{module.json, run.js, README.md}
node bin/cairn.mjs mod test 我的功能      # 校验 + 演练（不会打扰任何人）
```

`mod new` 生成的 `run.js` 已经是一个能跑的最小实现，改里面的逻辑即可。

---

## 2. `module.json` 写了什么

| 字段 | 意思 | 例子 |
| --- | --- | --- |
| `kind` | **必须是 `processor`** | `"processor"` |
| `entry.run` | 入口脚本（相对路径） | `"run.js"` |
| `permissions` | 你要用哪些能力（**安装时会被展示给用户**） | `["notify:app", "net:canvas"]` |
| `data.reads / writes / tables` | 你读什么、写什么 | `"reads": ["signal", "tasks"]` |
| `requires.agent` | 需不需要模型 | `false` |

常见能力代号（完整表见 `lib/permissions.mjs`）：

| 代号 | 人话 |
| --- | --- |
| `notify:app` | 发本机通知 |
| `notify:phone` | 推送到手机（**只能一句话，≤60 字**） |
| `net:outbound` / `net:canvas` / `net:mail` | 访问网络 / 只读课程平台 / 收发邮件 |
| `fs:read:data` / `fs:write:data` | 读 / 写本机数据目录（`<数据目录>/study/` 之类） |
| `llm:ask` | 调用用户自己配的模型 |

> 声明了就要用、用了就要声明：安装时那张**权限清单**就是给用户看的，`⚠️` 表示需要留意。

---

## 3. `run(input, ctx)` 的两个参数

### `input` —— 你要处理的东西

通常是**一条 signal**（第二段的产物），形状见 `contracts/signal.v1.schema.json`：

```json
{
  "schema": "signal.v1",
  "item_id": "canvas:file-123",
  "band": "high", "verdict": "push", "delivery": "now",
  "reasons": [{ "rule": "due-1d", "label": "明天内到期", "delta": 35 }],
  "evidence": [{ "kind": "page", "text": "…", "ref": "file:…#p3" }],
  "meta": { "…": "上下文（课号、剩余分钟数…）" }
}
```

`input` 也可能是定时任务或手动试跑传进来的任意对象 —— **先判空再干活**。

### `ctx` —— 你能用的东西（都是**注入**的）

| 字段 | 说明 |
| --- | --- |
| `ctx.store` | 读/写本机状态（`getSync/setSync` 等）；**不要**直接连数据库文件 |
| `ctx.now` / `ctx.dryRun` | 当前时间 / 这次是不是演练 |
| `ctx.log(msg)` | 写日志（会进服务端日志） |
| `ctx.module` | `{ id, name, dir }` |
| `ctx.canvas.checkCourse({courseCode, sinceMs})` | **只读**查一门课的 Canvas（上课前提醒那个功能在用） |
| `ctx.prefs()` | 读这个功能自己的设置 |
| `ctx.dedupe.filterNew/markSeen` | "报过的不再报"（按指纹去重） |

**没有的能力就是没有**：拿不到 shell、拿不到凭据明文、也不能绕过执行能力直接发通知。

---

## 4. 返回什么：action 列表

每条动作的形状见 `contracts/action.v1.schema.json`，常用的两条：

```js
// ① 进本机通知
{ type: 'notify', summary: '一句话标题', payload: { text: '正文' },
  idempotency_key: '我的功能:2026-09-23', target: { url: 'https://…' } }

// ② 推手机（**只发一句话**；前提是用户勾了"推手机"）
{ type: 'push', summary: 'X 快上课了', payload: { push: '25 分钟后上课｜有 3 条新东西' } }

// ③ 建任务（2026-10-02 起真的会执行；**只建一条、只建不改**，靠
//    payload.notes 里那行 `[幂等键]` 防止重跑建第二条）
{ type: 'task', summary: '交 MATH1860J 作业 3',
  payload: { title: '交 MATH1860J 作业 3', priority: 1, notes: '来自邮件' },
  target: { due_at: '2026-10-07T23:59:00+08:00' }, idempotency_key: 'MATH1860J-hw3' }
```

其它类型（`event / mail / external / archive / report`）会被登记但**暂时不执行**，
系统会如实标成 `skipped`（"还没有能执行这类动作的能力"）——不会假装做了。

四条硬规矩：

1. **默认演练**：接口不传 `dry_run:false` 时，所有动作停在 `planned`；
2. **认不出来的 type 会被标 failed**（并写清原因），不会"悄悄发出去"；
3. **没有幂等键就可能重复打扰**（给自己定一个稳定的 key，例如"课号+日期"）；
4. **安静是正确结果**：返回 `[]` 表示"这次没有值得打扰的事"，这是被鼓励的写法。

---

## 5. 测试与发布

```bash
node bin/cairn.mjs mod test 我的功能                    # 校验 + 演练（零副作用）
node bin/cairn.mjs mod run  我的功能                    # 走服务端演练（服务在跑时）
node bin/cairn.mjs mod run  我的功能 --real             # 真的执行（会进通知）
node bin/cairn.mjs mod pack 我的功能 --out 我的功能.zip  # 打包（zip，零依赖自己写的）
node bin/cairn.mjs mod install 我的功能.zip             # 先看权限清单（预览）
node bin/cairn.mjs mod install 我的功能.zip --yes        # 确认后安装
```

给别人装的时候，对方看到的是**权限清单**，而不是一堆代码 —— 这是"功能商店"的第一步。

---

## 6. 两个能照着抄的实例

| 例子 | 看它学什么 |
| --- | --- |
| `modules/hello-processor/` | 最小骨架：判空、返回一条 notify、保持安静 |
| `modules/preclass-check/` | 真功能：用 `ctx.canvas.checkCourse` 查一门课、用 `ctx.dedupe` 去重、按 `ctx.prefs()` 决定要不要推手机、失败就静默 |

---

## 7. 边界（请务必守住）

- **不代做、不提交**：功能可以整理、提醒、生成文件，但**不能替用户交作业/发消息**；
- **不越权**：只用 `module.json` 里声明过的能力；拿不到的东西不要去绕；
- **失败要安静但可查**：出错返回 `[]` 并 `ctx.log()` 一句，而不是弹一堆通知；
- **手机推送只发一句话**：长内容留给应用内通知、邮件或生成的文件。
