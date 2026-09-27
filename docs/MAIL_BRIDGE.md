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
