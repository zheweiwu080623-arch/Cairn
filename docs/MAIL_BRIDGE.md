# 外部邮件桥（可选组件）

> **读者**：想知道"Cairn 为什么有时候要跟另一个程序说话"、以及怎么接一个自己的人。
> 一句话：**Cairn 不自己发邮件**。需要发信时，它把一张 JSON 契约递给本机的一个
> **邮件桥程序**，由桥去发。桥是**可选的外部程序**：不装、不配，其它功能一样照常。

---

## 1. 为什么要有这一层

Cairn 有两条路会把信"发出去"：

1. **课程资料同步**：Canvas 有新课件，而办公本（讯飞 X5）没插着 → 发一封邮件说明 + 附 PDF；
2. **自动化报告回流**：本机跑完的定时任务，把报告发一份到手机 / 办公本邮箱。

Cairn 只监听本机回环地址（`127.0.0.1`），而且**故意不碰邮箱凭据**。于是它把"发信"这件事
外包给本机的一个独立程序 —— 这就是**邮件桥**。

好处很直接：

| 好处 | 说明 |
| --- | --- |
| 凭据不进 Cairn | Cairn 进程里没有邮箱账号/授权码，接口只回掩码 |
| 换实现不用改 Cairn | 桥可以是 Python / Node / 任何语言，只要能跑下面那两条命令 |
| 不要它也行 | 不配置 → 那两条路如实返回"没配邮件桥"，其它功能不受影响 |

---

## 2. 两条命令就是全部接口

桥只需要实现两条子命令（Cairn 侧代码：`lib/mail-bridge.mjs`）：

```bash
# ① 发一封
<桥命令> send-mail --json-stdin [--outbox <目录>]
#   stdin : mail-job.v1（见 contracts/mail-job.v1.schema.json）
#   stdout: 最后一行是 mail-job-result.v1（见 contracts/mail-job-result.v1.schema.json）

# ② 报个状态（界面用它显示"通道通不通"）
<桥命令> status --json --root <桥目录>
#   stdout: 一个 JSON；Cairn 只读 extra.mailbox（发件人）与 extra.allow_senders（默认收件人）
```

`send-mail` 的入参长这样（正文、附件路径、`dry_run`）：

```json
{
  "schema": "mail-job.v1",
  "to": ["someone@example.com"],
  "subject": "Canvas 新课件",
  "text": "……",
  "attachments": [{ "path": "C:\\Users\\example\\Temp\\x.pdf", "name": "x.pdf" }],
  "dry_run": false,
  "source": "planner:mail-bridge"
}
```

`dry_run: true` 时桥**只把 .eml 落盘、不连 SMTP** —— 这是本地验证用的，也是 Cairn 自测走的路径。

---

## 3. 怎么接上你自己的桥

桥在哪、怎么启动，**都不写进代码**（`data/` 被 `.gitignore` 排除，仓库里不含任何一台机器的路径）：

| 配置项 | 优先级 | 说明 |
| --- | --- | --- |
| `MAIL_BRIDGE_DIR` | 环境变量 > `data/paths.json` 的 `mail_bridge_dir` | 桥的安装目录（`send-mail` 的工作目录，也是 `status --root` 的默认值） |
| `MAIL_BRIDGE_CMD` | 环境变量 > `data/paths.json` 的 `mail_bridge_cmd` | 怎么启动桥，例如 `python -X utf8 -m your_bridge`；缺省是 `python -X utf8 -m mail_bridge` |
| `MAIL_BRIDGE_SCHEMA` | 环境变量 > `data/paths.json` 的 `mail_bridge_schema` | 请求体里的契约名，缺省 `mail-job.v1`。**有的桥会校验自己的版本名** —— 那就把它配在这里（属于对方的实现细节，不进 Cairn 的代码） |

`data/paths.json` 形如：

```json
{
  "mail_bridge_dir": "<桥装在哪>",
  "mail_bridge_cmd": "python -X utf8 -m your_bridge",
  "mail_bridge_schema": "mail-job.v1"
}
```

配好之后，在「数据源 → 课程资料自动同步」那张卡上点**测试邮件通道**
（`POST /api/course-sync/mail-bridge-test`）就能验证：先问状态，再发一封 `dry_run` 的活；
勾了"真发"才会真发一封给你自己。

---

## 3.5 备用通道：邮件发不出去时，内容进「通知」页（2026-10-01）

桥的服务商会风控。2026-10-01 实测过一次：163 突然开始拒绝 SMTP 认证
（`535 Error: authentication failed`），**收信正常、发信全挂** —— 回信与课程材料邮件都卡在桥的
`outbox/` 里等人。于是 Cairn 给"发不出去的东西"开了一个**只走本机**的落点：

```text
桥发信失败 → POST http://127.0.0.1:3210/api/local-drop → 进「通知」页（source = pigeon）
                                                      → 可选推一条 Bark 到手机
```

- 接口在 `lib/routes/local-drop.mjs`（`GET` = 就绪探测，给桥的 `--doctor` 用；`POST` = 投递）；
- **只接受 loopback**（`127.0.0.1` / `::1`）来的请求 —— 这是本机互投，不是对外接口；
- **不做任何外发**：不像 `/api/automation/report` 那样再转发一次邮件（邮件正是坏的，
  转发只会再失败一次）；
- 通知正文里会如实写明"这条走的是备用通道 + 为什么"，并注明"邮件恢复后仍会照常补发" ——
  **不假装邮件发出去了**；
- 手机推送**绕过"重点来源"过滤**（故障兜底必须看得见），但**仍然尊重免打扰**；
  投递时带 `urgent: true` 才连免打扰一起绕过。
- 去重：带 `ref`（桥那边是 outbox 文件名）时按 `external_id` 去重，重试不会在通知页刷屏。

## 3.6 发信降载策略：只留「早上汇总」+「Canvas 有新增」（2026-10-01）

用户 2026-10-01 的口径：「发信确实需要降载，一天早上汇总一封，每一次 cairn 进行 canvas 检查出
有新增的时候再来一封就够了」。规则实现在 `lib/mail-policy.mjs`，账本存在 `sync_state` 的
`mail_policy_ledger` 键里（跨重启有效、按本地日期自动翻篇）：

| 类别 | 谁在用 | 默认配额 |
| --- | --- | --- |
| `morning` 早上汇总 | 每日邮件摘要的**早报** | **一天 1 封**，默认只在 05:00–11:59 发 |
| `canvas` Canvas 有新增 | 课程材料没进办公本时的邮件 | **必须有新增才发**，一天最多 8 封 |
| `evening` 晚报 | 每日邮件摘要的晚报 | **0（不发邮件）** —— 内容照旧在应用里看 |
| `report` 自动化简报 | Codex 定时任务报告的邮件转发 | **0（不单独发）** —— 标题会进早上那封汇总 |
| `manual` 手动发送 | 界面「发到办公本」/ `POST /api/send/file` | 不限（人明确的动作不受策略管） |

几条刻意的细节：

- **失败不记账**：只有发送成功才 `noteMailSent` —— 否则邮件桥被风控那天，一天的配额会被白吃光；
- **被策略拦下不算失败**：日志一小时最多一行（不然每 4 秒刷一次），应用内通知照旧；
- **配额可改**：往 `sync_state` 里写一个 `mail_policy`（JSON，例如 `{"canvas":{"per_day":4}}`）即可覆盖默认值；
- **能查状态**：`GET /api/mail-policy` 返回今天的规则与已用配额。

## 4. 另外两处顺带用到外部程序的地方

- **契约化出口**：`data/export/*.json`（`planner-snapshot.v1` / `planner-notifications.v1`）
  给任何外部消费者读 —— HTTP 优先、离线快照兜底，快照过期会标注，不把旧数据当新的用；
- **健康状态**：`contracts/app-status.v1.schema.json` 是机器可读的健康状态，托盘脚本只读这份
  JSON，不解析日志文本（历史上解析日志的版本很脆）。写入方用它自己的 `app` 短名标识自己。

---

## 5. Cairn 侧不做什么（边界）

- 不读、不存、不打印任何邮箱凭据；
- 不规定桥用什么语言、什么邮箱、什么轮询策略；
- 桥不在、命令跑不起来、返回不合法 —— 一律**如实报错**，不假装发过；
- 发信只走上面那条 CLI 协议；Cairn 不会去猜桥的内部结构，也不共享数据库。
