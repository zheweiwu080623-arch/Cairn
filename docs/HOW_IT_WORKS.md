# Cairn 是怎么运作的（写给"想看懂技术细节但还不想读代码"的人）

> 这份文档假设你**没有编程背景**。所有术语第一次出现时都会用大白话解释一遍。
> 想直接动手改东西，看第 6 节「常见改动怎么做」；想看懂目录，看第 2 节。

---

## 1. 一次点击背后发生了什么

你在界面上点了一下「今日」，到屏幕上出现内容，中间只走了四步：

```
① 浏览器           ② 服务端               ③ 数据库            ④ 显示层
app.js 要数据  →  server.mjs 接住请求  →  store.mjs 读文件  →  viewmodel.js 整形
（只是提问）       （决定该找谁要）        （SQLite 数据库）     （变成屏幕上要的样子）
      ↑                                                              ↓
      └──────────────── ⑤ app.js 把数据画成 HTML ←───────────────────┘
```

一句话概括：**提问 → 找数据 → 整形 → 画出来**。
这四步分别放在四个文件里，是这份项目最想守住的一件事 —— 因为
**将来换界面（做手机版、发邮件摘要、导出 Markdown）时，只有第 ⑤ 步要重写**。

> 打个比方：这就像餐厅。**点单员（app.js）**、**厨房长（server.mjs）**、
> **仓库（store.mjs + 数据库）**、**摆盘师（viewmodel.js）**。
> 摆盘师决定"菜摆成什么样"。换一个摆盘师，菜还是那道菜。

---

## 2. 目录地图：每个文件夹是干嘛的

```
codex-planner/
├─ server.mjs          服务端主程序：接请求、定时任务、发通知（约 2400 行，仍在继续拆分）
├─ launcher.mjs        用系统自带的 Edge 开一个"像本地应用"的窗口
├─ lib/                所有"纯逻辑"（不碰界面）
│   ├─ store.mjs          数据库读写（**只有它碰数据库结构**）
│   ├─ migrations.mjs     数据版本台账：换新版本时老数据怎么升级
│   ├─ connectors/        数据源（飞书 / Canvas / 邮箱 / RSS / 日历 / JSON / 本地文件…）
│   ├─ routes/            按业务分组的接口（目前有 study.mjs：养成 + 课表校历）
│   ├─ media.mjs          壁纸与本地音乐
│   ├─ relevance.mjs      信息筛选的规则（"这条跟我有关吗"）
│   ├─ peak.mjs           高峰/非高峰判断（决定什么时候可以打扰你）
│   └─ …（邮件、计划导出、命名规则、密钥加密等）
├─ public/             界面（浏览器里跑的东西）
│   ├─ index.html         页面骨架
│   ├─ app.js             界面逻辑 + 把每个页面画出来（最大的一处）
│   ├─ viewmodel.js       显示层：把数据整形成"屏幕上要的样子"
│   ├─ vm-bridge.js       把显示层挂到全局（app.js 是普通脚本，不能 import）
│   └─ styles.css         样式
├─ modules/            可插拔功能（一个目录 = 一个功能）
├─ contracts/          "接口约定"：JSON 长什么样的标准写法 + 样例
├─ tests/              验证脚本（43 个文件；整套 55 套验证）
├─ shell/              原生窗口外壳（可选，C# + WebView2）
├─ scripts/            本地小工具（提交代码、修编码问题等）
└─ data/               【不进仓库】你的数据、密钥、日志、备份、导出
```

**读代码的建议顺序**：
`public/index.html`（页面有哪些容器）→ `public/app.js` 里的 `render*` 函数（每页画什么）
→ `public/viewmodel.js`（数据从哪来）→ `server.mjs` 的路由段（接口有哪些）
→ `lib/store.mjs`（数据长什么样）。

---

## 3. 五种"零件"：加一项功能，到底要动哪里

这个项目里所有东西都能归成五类。**记住这张表，你就能自己判断"我要改的东西属于哪一类"**：

| 零件 | 一句话 | 代码里长什么样 | 加一个要动几处 |
| --- | --- | --- | --- |
| **连接器** | 把外面某个地方的数据拉进来 | `lib/connectors/名字.mjs` | 1 个文件 + 注册 1 行 |
| **模块** | 一块可以装上/卸下的界面功能 | `modules/名字/`（含 `module.json`） | 1 个目录 |
| **显示层选择器** | 决定"某个页面需要哪些数据" | `public/viewmodel.js` 里的 `xxxSelection()` | 1 个函数 + 界面里接一行 |
| **定时任务** | 不用你动手、自己会跑的事 | `server.mjs` 里的 `xxxTick()` 等 | 1 个函数 + 挂上定时器 |
| **契约** | "接口长什么样"的书面约定 | `contracts/*.schema.json` + `fixtures/` | 1 个 schema + 样例 |

### 举例：从零接一个新的信息源（不改主程序）

1. 写 `lib/connectors/我的源.mjs`，导出三样东西：
   - `meta`：叫什么、要用户填哪些字段（每个字段有中文标签）；
   - `fetchAll(config)`：把数据拉回来，整成"标题 / 时间 / 链接"这样的统一形状；
   - `fromSample()`：**离线示例**（没网也能演示，测试也用它）。
2. 在 `lib/connectors/index.mjs` 里加一行注册。
3. 跑 `node tests/localfile.test.mjs` 那样的一份验证，确认"字段填错会报人话"。

界面上会自动出现这个数据源 —— **主程序一行都不用改**。

> 只是想**用**数据源、不打算写代码？看 **[CONNECT_SOURCES.md](CONNECT_SOURCES.md)**
> （数据源配置教程：每个字段怎么填、凭据去哪拿、报错对照表、常见问题）。

---

## 4. 数据存在哪里、长什么样

### 一个数据库文件 = 全部内容

`data/codex-planner.db`（SQLite，像"一个 Excel 文件装了一整本账"）。里面有 14 张表：

| 表 | 装什么 |
| --- | --- |
| `tasks` | 任务 |
| `events` | 日程 |
| `notifications` | 提醒与通知 |
| `dismissed_notifications` | 你手动删掉过的外部条目（防止下次同步又加回来） |
| `habits` / `habit_logs` | 习惯与打卡记录 |
| `focus_sessions` | 番茄专注记录 |
| `milestones` | 里程碑 / 考试倒计时 |
| `course_schedule` | 课表 |
| `academic_events` | 校历（学期起止、考试等） |
| `course_files` | 课程资料台账（下载 / 改名 / 推办公本的状态） |
| `connector_config` | 各数据源的配置（**凭据加密后存放**） |
| `connector_data` | 从数据源抓回来的原始条目（含"相关度裁决"结果） |
| `sync_state` | 一堆零碎的键值（音乐目录、壁纸选择、学习规则…） |
| `schema_migrations` | **数据版本台账**（见下一节） |

### `data/` 目录里的其他东西

`server.log`（日志）、`tray.log`、`backups/`（自动备份）、`export/`（导出的 Markdown/JSON）、
`plan/`（给 Codex 读的每日计划）、`.secret.key`（加密用的钥匙）、`brand.json`（本机显示名）、
`paths.json`（本机的壁纸目录 / 邮件桥目录）。
**整个 `data/` 都被排除在 Git 之外**，所以你公开仓库不会带上任何个人数据。

### 数据版本台账：为什么"换新版本不用删库"

每次改数据库结构，都在 `lib/migrations.mjs` 里加一条**有编号的迁移**。规则是：

1. 编号只增不改；2. 每条只跑一次，跑过记在 `schema_migrations` 里；
3. 老库缺列会**自己补齐**；4. 升级失败**不会被记成成功**，但**也不会让程序起不来**，
   只在状态页标一个警告。

你在应用状态里看到的 `数据版本 6（6/6 项已应用）` 就是它。

---

## 5. 几个关键机制（用大白话说）

### 显示层（ViewModel）＝ 翻译官

数据库里的一行是"任务 A、截止 2026-09-24、优先级 1"；
但屏幕上要的是"逾期 / 今天 / 本周的分组、按时间排序、显示成红色"。

**翻译官只做"翻译"**：给它一份数据，还你一份"屏幕上要的样子"。
它不碰网络、不碰数据库、不碰界面 —— 因此可以被"另一块屏幕"重复使用。
十个页面现在都走这一步（今日 / 日程 / 任务 / 通知 / 数据源 / 首页 / 养成 / 统计 / 音乐 / Codex）。

### 契约（contracts/）＝ 接口的书面约定

界面和后台之间传的 JSON 长什么样，写成了文件（`contracts/*.schema.json`）。
好处是：**改坏了会当场报错**，而不是"过两天某个页面莫名其妙空白"。
仓库里有 `contract_check.py` 专门校验这些样例还符不符合约定。

### 模块（modules/）＝ 乐高

一个功能就是一个目录：`module.json`（我叫什么、装到界面的哪个位置、要读写什么、需要什么权限）+
`view.js`（长什么样）。放进 `modules/` 就会被自动发现。
界面里的关键位置会声明"我接受谁来挂"（`mount_into`），所以模块之间不会互相踩。
写法见 [WRITING_A_MODULE.md](WRITING_A_MODULE.md)。

### 高峰 / 非高峰（lib/peak.mjs）＝ 什么时候可以打扰你

高峰 = 工作日 9–12 点、14–18 点。非高峰时系统才做"要动脑子"的事
（比如语义筛选、批量整理），并且在非高峰才允许给你推摘要 ——
**因为你上课的时候不需要它插嘴**。

### 信息筛选（lib/relevance.mjs）＝ 判断"这条跟我有关吗"

输入是"你关心什么"（画像）与"这条内容"，输出是三个判定之一：
**推给你 / 待你确认 / 建议忽略**，并且**附上理由**（哪条规则命中的）。
理由很重要 —— 界面里悬停能看到"为什么这条被拦下来"，你还能反过来教它
（删 3 次就忽略、留 2 次就优先）。

### 重要信息（lib/priority.mjs）＝ 判断"这条对我多重要"

和上一条是**两件事**：上一条决定"要不要打扰你"，这一条决定"先看哪条、有多急"。
它把「未来规划」（你自己写的目标 + 里程碑 + 考试 + 未来 14 天安排）抽成关键词，
再加上时间紧迫度、要不要行动、来源权重、你以前的行为，合成 0~100 分与三档，
**每一项加减分都带理由**（所以界面能回答"凭什么它排第一"）。
用法与完整判据见 [PRIORITY.md](PRIORITY.md)。

---

## 6. 常见改动怎么做（照着改就行）

| 你想做的事 | 改哪里 | 改完跑什么 |
| --- | --- | --- |
| 改一句界面文案 | `public/app.js` 里对应 `render*` 函数的字符串 | `node tests/r4-html.test.mjs` 会提醒你"外观变了" |
| 加一个新数据源 | 见第 3 节的例子 | 该连接器的 `*.test.mjs` |
| 加一个可插拔功能 | 新建 `modules/你的名字/` | `node tests/modules.test.mjs` |
| 改信息筛选规则 | `lib/relevance.mjs` | `node tests/relevance.test.mjs` |
| 给数据库加一列 | `lib/store.mjs` 建表语句 + `lib/migrations.mjs` **新增一个编号** | `node tests/migrations.test.mjs` |
| 改某个页面的数据来源 | `public/viewmodel.js` 的 `xxxSelection()` + `public/app.js` 里对应的 `#region xxx-selection` | 该页面的 `*-html.test.mjs`（HTML 逐字节比对） |
| 加一个接口 | `lib/routes/你的组.mjs` 新建 + `server.mjs` 里接线 | 该组的 `*.test.mjs` |

> **一个重要的习惯**：改完**先跑验证，再打开界面看**。
> 因为这个项目里的验证是"逐字节比对"式的 —— 它比肉眼更早知道你改坏了什么。

---

## 7. 怎么验证（这套东西靠什么保证没坏）

### 三层验证

| 层 | 是什么 | 命令 |
| --- | --- | --- |
| **单元 / 解析器** | 纯函数，比如"ICS 时间怎么解析""CSV 引号怎么算" | `node tests/xxx.test.mjs` |
| **接线（HTML 级）** | 在 Node 里加载**真实的 app.js**，把页面渲染出来逐字节比对 | `node tests/r4-html.test.mjs` |
| **端到端 / 真环境** | 起本地假站点、真连外网、真启动服务、三平台 CI | `python work/tools/run_all_suites.py` |

### 跨平台 CI（换台机器还灵不灵）

`tests/run-portable.mjs` 是**只能在仓库内跑**的那一批（41 套），
GitHub 上每次提交都会在 **Windows / macOS / Linux × Node 22/24** 跑一遍。
需要"活的 Planner 服务""本机邮件桥""PowerShell"的测试故意不进 CI，在文件里列着名单。

---

## 8. 术语表（中文 ↔ 代码里的名字）

| 平时怎么说 | 代码里叫什么 | 一句话解释 |
| --- | --- | --- |
| 数据源 / 接口 | `connector`（`lib/connectors/`） | 把外面的数据拉进来 |
| **功能** | `module`（`modules/`），`kind: processor` 时叫"再处理功能" | 再处理运算的**结果**：用户能看见、能用的那一件事，比如"生成每周巩固包" |
| **能力** | `capability`（M1 之后进入注册表） | 再处理运算的**能力**：可复用的原子动作，比如"读课程材料""推手机"。**功能由能力拼出来** |
| 执行能力 | `lib/processor-executors.mjs` | 真正动手那三个：发通知 / 推手机 / 写文件（只准写 `<数据目录>/study`） |
| 零件模块 | `module`（`modules/`） | 一小块可以装卸的界面或功能 |
| 显示层 / 翻译官 | `ViewModel`（`public/viewmodel.js`） | 把数据变成屏幕上要的样子 |
| 取数器 | `xxxSelection()` | 某个页面需要哪些数据 |
| 接口约定 | `contract`（`contracts/`） | JSON 长什么样的书面标准 |
| 数据版本台账 | `migrations`（`lib/migrations.mjs`） | 换版本时老数据怎么升级的记录 |
| 高峰 / 非高峰 | `peak`（`lib/peak.mjs`） | 什么时候可以打扰你 |
| 相关度裁决 | `relevance`（`lib/relevance.mjs`） | 判断"这条跟我有关吗" |
| 投递三档 | push / review / drop | 推给你 / 待确认 / 建议忽略 |

---

## 9. 已知的坑（写在这里省得你以后踩）

1. **托盘图标、原生窗口外壳、讯飞办公本（MTP）同步、课程表 XLSX 是 Windows 专属**；
   macOS / Linux 上用浏览器打开就完整可用，这些功能会自动跳过（不会报错）。
   开机自启两个平台都有：Windows 用「启动」文件夹的快捷方式，macOS 写 LaunchAgent
   （`~/Library/LaunchAgents/com.cairn.planner.plist`，同时充当"挂了自动拉起"的看门狗）；
   「打开原文 / 打开文件夹 / 选择文件夹」都已跨平台（`open` / `xdg-open` / `osascript`）。
2. **个人大素材不进仓库**：`public/assets/wallpapers/` 被 `.gitignore` 排除，
   所以别人 clone 下来只有 4 张内置壁纸的"壳"，没有你本机的素材文件。这是有意的。
3. **Windows 上的 `.ps1` 脚本必须带 UTF-8 BOM**，否则中文会乱码报语法错。
   本仓库有 `work/ops/ensure-ps1-bom.py --all` 用来批量修（在你自己的工作区里）。
4. **改名前的备份**（`*.bak-*`、`*.snapshot-*`）都留在你本机、不进仓库 —— 写 `.gitignore` 就是为了这个。
5. **`lib/workbook.mjs`（办公本）在非 Windows 上只会优雅降级**（返回"仅支持 Windows"），
   不会尝试做 MTP 的纯 JS 重写 —— 那件事性价比太低（见 CHANGELOG 的说明）。

---

## 10. 别的 AI 能不能用 Cairn 的数据？能，但只读

2026-09-24 起，Cairn 对外开了两个**只读**口子，给"办公 AI"用（细节见 `docs/CONNECT_AGENTS.md`）：

1. **MCP 服务器**（`bin/cairn-mcp.mjs`）—— Qoder 这类支持 MCP 的工具可以直接挂上，
   拿到五个工具：今日 / 任务与 DDL / 重要信息 / 课件检索 / 已生成的学习产物；
2. **导出目录**（`POST /api/agent-export`）—— 把结论写成 `<数据目录>\for-agents\` 里的六份纯文本，
   按"文件夹授权"给千问办公那类办公 Agent 读。

两条边界的说法要记住：

- **只读**：外部 agent 不能写库、不能发通知、不能替你提交作业；要改数据请回到 Cairn 里点；
- **不直连数据库**：MCP 服务器是去问 `http://127.0.0.1:3210` 的只读接口 —— 永远只有一个进程写库。
