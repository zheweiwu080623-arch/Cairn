# contracts/ — Cairn ⇄ 外部程序 数据契约（Day 1）

本程序与任何外部程序（托盘 / 办公 AI / 可选的邮件桥）只通过本目录里的版本化契约交换数据。改契约的规矩：**只增不改**，破坏性变更必须同时新增 fixtures 与双方测试。

| 文件 | 方向 | 用途 |
| --- | --- | --- |
| `viewmodel.v1.schema.json` | 内部（显示层） | 所有显示面共用的 ViewModel。原生视图、Web、CLI、邮件、Markdown 都消费它 |
| `app-status.v1.schema.json` | 本程序 + 外部程序 → 托盘 | 机器可读健康状态；`status.ps1` 只读它，不再解析日志文本 |
| `planner-notifications.v1.schema.json` | Planner → 外部程序 | 通知导出（HTTP `/api/export/notifications` 或离线快照） |
| `planner-snapshot.v1.schema.json` | Planner → 外部程序 | Planner 离线时的完整只读快照（带 `exported_at` 与 `stale_after_hours`） |
| `mail-job.v1.schema.json` | Planner → 外部邮件桥 | `<桥> send-mail --json-stdin` 的入参 |
| `mail-job-result.v1.schema.json` | 外部邮件桥 → Planner | 发信结果；`lib/mail-bridge.mjs` 的返回类型 |
| `job-spec.v1.schema.json` | 外部程序内部 | 定时作业定义；`source.type=planner` 是目标形态，`sqlite` 仅排障 |

### 三段式契约（2026-09-23 新增）

系统被明确成三段：**汇总 → 分析 → 再处理**。每段的边界由一张契约定义，
这样换任何一段的实现都不影响另外两段，而且每段都能单独重跑（幂等键在第三张里）。

| 文件 | 属于 | 一句话 |
| --- | --- | --- |
| `source-item.v1.schema.json` | **① 汇总** | 任何来源抓回来的一条信息，统一成这个形状（带出处、抓取时间、可信级、内容指纹） |
| `signal.v1.schema.json` | **② 分析** | 对一条条目的判断：相关度裁决、重要性分档、**理由与证据**、投递三档；只产出判断，不产生副作用 |
| `action.v1.schema.json` | **③ 再处理** | 拿判断去解决现实问题：通知 / 发邮件 / 建任务 / 写文件 / 调外部接口……带幂等键、权限声明与审计 |

### 能力层契约（M1 · S1，2026-09-25 新增）

「功能由能力拼出来」—— 所以**能力**要先有自己的身份证，才谈得上被登记、被单独测、被声明依赖。

| 文件 | 属于 | 一句话 |
| --- | --- | --- |
| `capability.v1.schema.json` | **能力的身份证** | 一条能力（原子动作）的：显示名、入参 / 出参、**要哪些权限**、副作用类别（`kind`）、能否重放（`idempotent`）、花不花钱（`cost`）、实现在哪、单测在哪 |

命名按 2026-09-25 定的三条默认走：**点分命名**（`域.动作`，如 `course.text`）、**粒度少而稳**
（`course.*` 合并成 `course.scan` / `course.text` / `course.artifacts`）、**动作类也算能力**
（原来的"执行器"用 `kind: write|outbound` 区分，不再单算一层）。样例见 `fixtures/capability.sample.json`。

`fixtures/` 里是从真实系统抓下来的样例，用来做双向测试：给 Planner 的渲染器喂 Planner 的 fixture，给外部程序的渲染器喂它的 fixture，任何一侧改契约先跑 fixtures。

## 契约层怎么跑到仓库里（Day 1）

Planner 仓库由本会话的沙箱明确禁写（DENY ACE），所有改动先在
`work\stage\planner\**` 生成，再用 `work\ops\daily-ops.ps1 -Action apply` 镜像进仓库：
进入前逐文件比对 SHA256，只覆盖有差异的文件，被覆盖的旧版会自动备份到
`work\backups\day1-<stamp>\overwritten\`，事后写一份 `work\apply-logs\apply-<stamp>.json`。

Day 1 的改动全部是**新增**：`contracts/`、`public/viewmodel.js`、`tests/`，
没有任何既有文件的语义被修改，所以随时可以只删这几个新增文件回滚。

契约版本号写在每个文件里（`$id` 与载荷的 `schema` 字段），载荷版本与文件名一致。
