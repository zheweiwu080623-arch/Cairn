# 开发者与审阅指南

> **读者**：要审这份代码的人、想二次开发的人、想接一个自己的数据源或功能模块的人。
> **如果你只想"把它用起来"**：看 [README](../README.md) 和 [它是怎么运作的](HOW_IT_WORKS.md)。
> 这一篇回答的是另一类问题：**技术上用了什么、怎么做的、为什么这么做、审的时候该盯哪里。**

---

## 0.0 本系统的本质：三段式（先看这个，再看代码）

**Cairn =「多源信息汇总 → 分析 → 再处理」**。三段之间**各由一张契约连接**（2026-09-23 新增），
所以换任何一段的实现都不影响另外两段，每段也都能单独重跑：

**两个词先对齐**（作者 2026-09-25 裁定，全项目都按这个口径说话）：

- **功能 = 再处理运算的结果** —— 用户能看见、能用的那一件事。例：「每日 18:00 生成一份课程巩固包」。
  代码里就是 `modules/<id>/`；`kind: processor` 的那个目录，就是"再处理功能"本体。
- **能力 = 再处理运算的能力** —— 可复用的原子动作。例：「读课程材料」`course.materials.read`、
  「推手机」`push.phone`、「写文件」`file.write`。三个"真正动手"的（通知 / 推手机 / 写文件）
  各自也是一种能力，只是它们会写外部世界，所以按 `kind: write | outbound` 标出来。

一句话：**功能由能力拼出来**；正在做的事就是把"能力"从硬编码的注入变成可登记、可复用的一等公民（见计划文档的 M1）。

```
        ① 汇总                        ② 分析                        ③ 再处理
   数据源 → 统一条目   ──source-item.v1──▶  判断（相关度/重要性）  ──signal.v1──▶  动作（通知/邮件/文件/任务）
   lib/connectors/*                        lib/relevance · priority                lib/mobile · autopush
   四种通用解析器                            · semantic · digest                     · ddl · course-sync · modules/*
        │                                       │                                        │
        └── 只负责"拉进来"、标准化、去重          └── 只产出判断（**无副作用**）              └── 只做"拿判断去解决现实问题"
                                                  └────────────── action.v1 ──────────────┘
                                                     （幂等键 · 权限声明 · 审计 · 可回放）
```

审阅时也可以按三段找入口：

| 段 | 回答什么问题 | 主要代码 |
| --- | --- | --- |
| **① 汇总** | 信息从哪来、怎么变成统一形状 | `lib/connectors/*`、四种通用解析器（`feed` / `ical` / `jsonmap` / `localfile`） |
| **② 分析** | 这条跟我有关吗、多重要、该怎么打扰 | `lib/relevance.mjs`、`lib/priority.mjs`、`lib/semantic.mjs`、`lib/digest.mjs` |
| **③ 再处理** | 拿判断结果去解决现实问题：发邮件 / 建任务 / 归档改名 / 推手机 / 生成文档 | `lib/mobile.mjs`、`lib/autopush*.mjs`、`lib/ddl.mjs`、`lib/course-sync.mjs`、`modules/*` |

**正在推进的方向**（作者本人的五方面判断：三段分开 / 汇总更多 / 分析更快 / 更多再处理功能 /
功能的发布·运行·创建·载入更方便 + 全面轻量化）记在工作区的《GitHub 发布前完整计划》里；
其中的架构含义是：**把「再处理功能」升格为一等公民**（`module.kind = processor`），
并让三段各由一张契约串起来（`source-item` / `signal` / `action`）。
本节先给出框架，具体实现进度以那份计划为准。

**三段各自的"身份证"**（`contracts/`，含 fixtures，可跑 `work/tools/contract_check.py` 校验）：

| 契约 | 谁产出 | 关键字段 |
| --- | --- | --- |
| `source-item.v1` | ① 汇总（连接器） | 出处 `source` + `external_id`、`kind`、时间、**`trust` 可信级**、**`content_hash` 内容指纹** |
| `signal.v1` | ② 分析（规则 / 模型 / 两者） | `verdict`（推/待确认/忽略）、`band`+`score`、**`reasons` 与 `evidence`**、`delivery` 三档、成本与耗时 |
| `action.v1` | ③ 再处理（功能 / 定时器） | `type`（通知/邮件/文件/任务/外部调用…）、`status`、**`idempotency_key`**、`permissions`、`result`、`audit` |

**能力的身份证**：`capability.v1`（M1 起）。一条"能力"（原子动作，如 `course.text`）声明自己的
入参 / 出参、**要哪些权限**、副作用类别（`read` / `compute` / `write` / `outbound`）、
能不能重放（`idempotent`）、花不花钱（`cost`）、实现在哪、单测在哪。
因为「功能 = 能力拼出来的」，能力必须**能被单独测**才敢让人组合。

---

## 0. 一句话与技术栈

**Cairn 是一个"本地优先"的个人信息汇聚与排序平台**：把散在九个来源（课程平台、邮箱、订阅、
日历、论文、本地文件……）里的信息收进一个池子，先判断"跟我有关吗"，再按"我的未来规划"
排出先后，最后决定什么时候打扰我。

技术栈刻意保持**小**：

| 维度 | 选择 | 为什么 |
| --- | --- | --- |
| 运行时 | **Node.js ≥ 22**（用到内置 `node:sqlite`） | 一个 `npm start` 就能跑，不需要构建 |
| 第三方依赖 | **零**（`package.json` 里没有 dependencies） | 审阅者不用先 `npm install`；也避免供应链风险 |
| 存储 | **SQLite 单文件**（`<数据目录>/codex-planner.db`） | 拷走一个文件就是完整备份 |
| 服务 | `node:http` 手写路由 + **SSE** 推通知 | 无框架、无中间件，请求路径一眼可读 |
| 前端 | 原生 ES Module + 手写渲染（`public/`） | 没有打包器；模块（`modules/`）用原生 `import()` 动态加载 |
| 加密 | `node:crypto` 的 **AES-256-GCM** | 凭据不以明文躺在磁盘上（`lib/secrets.mjs`） |
| 桌面 | 系统已装的 Edge `--app`，或 `shell/` 的 C# WebView2 外壳 | 不背 Electron |
| 可选外部件 | **外部邮件桥**（任何满足 `mail-job.v1` 协议的程序，见 [MAIL_BRIDGE.md](MAIL_BRIDGE.md)） | 让手机/办公本通过邮件与本机 agent 通信 |

---

## 1. 它解决的四类实际问题

审代码时最该先看这一节：**每个功能都对应一个真实麻烦**，而不是为了炫技。

| 实际问题 | 做法 | 关键代码 |
| --- | --- | --- |
| ① 信息散落在九个地方，各有各的登录方式 | 九种连接器 → 统一"条目"模型（`kind: task/event/reminder/file/page/module/syllabus/…`） | `lib/connectors/*`、`lib/connectors/index.mjs` |
| ② 收进来还是看不过来 | **两级判断**：先"跟我有关吗"（相关度），再"多重要多急"（重要性） | `lib/relevance.mjs`、`lib/priority.mjs` |
| ③ 该响的时候不响，不该响的时候一直响 | 三档投递 + 专注免打扰 + 高峰不调模型 + 手机只发短句 | `lib/mobile.mjs`、`lib/focus.mjs`、`lib/peak.mjs`、`lib/autopush*.mjs` |
| ④ 换台机器就废、凭据明文躺在盘上 | 路径/配置外置、凭据加密 + 掩码、版本化契约、全新安装演练 | `lib/paths.mjs`、`lib/local-config.mjs`、`lib/secrets.mjs`、`lib/credential-mask.mjs`、`contracts/` |

---

## 2. 运行时由哪些部分组成

```
浏览器 / 桌面外壳（Edge --app 或 shell/ 的 WebView2）
        │  HTTP + SSE（只连本机回环）
        ▼
主服务 server.mjs ── 路由层 lib/routes/*.mjs ── 领域层 lib/*.mjs（纯函数为主）
        │                                              │
        │                                              ├─ 连接器 lib/connectors/*（外部数据源）
        │                                              ├─ 模型通道 lib/llm.mjs（可接本机 Codex 配置）
        │                                              └─ 存储 lib/store.mjs（SQLite）
        ▼
定时心跳（4 秒一次）：提醒触发 / 自动同步 / Canvas 巡检 / 日报晚报邮件 / 自动推送 / 课程资料维护
        │
        ├── 手机只读小服务（另一端口）：只暴露日历 .ics、今日文本与说明页
└── 可选：外部邮件桥（独立进程，只通过契约文件与"发信协议"对接）
```

| 组成 | 位置 | 职责（一句话） |
| --- | --- | --- |
| 主服务 | `server.mjs` | HTTP/JSON 接口、SSE、定时心跳、静态资源与模块资源 |
| 路由层 | `lib/routes/*.mjs` | 只做"取料 → 算 → 回话"，不写业务规则 |
| 领域层 | `lib/*.mjs` | 业务规则，**尽量是纯函数**：相关度、重要性、日报、倒计时、命名、解析器…… |
| 存储层 | `lib/store.mjs` | SQLite 读写、凭据加解密、迁移应用 |
| 契约层 | `contracts/*.schema.json` | 对外数据的**版本化形状**（谁都能按它写消费者） |
| 显示层 | `public/viewmodel.js` + `public/app.js` | 取数与渲染分离；每条视图都有"旧实现"可回退 |
| 模块层 | `modules/<id>/` | 可插拔功能：一个目录 = 一个功能（见 §4.5） |
| 桌面外壳 | `shell/`、`tray.ps1`、`*.cmd/.vbs` | 托盘、开机自启、独立窗口（Windows 为主） |

---

## 3. 分层与"为什么这么分"

三条硬规矩（审阅时可以拿它当尺子）：

1. **领域层不碰 IO**。`lib/priority.mjs`、`lib/relevance.mjs`、`lib/digest.mjs`、`lib/ddl.mjs`
   这类文件不读文件、不连网、不看时钟以外的状态 —— 所以它们能被"喂假数据"直接测。
2. **路由层不含业务规则**。`lib/routes/*.mjs` 只负责从 `store` 取料、调用领域层、把结果回给界面；
   改打分规则只需要动 `lib/`，不用碰接口。
3. **纯函数优先、可解释优先**。凡是"判断"（相关度、重要性、紧急度）都返回 `reasons`：
   界面能回答"为什么它重要 / 为什么它没出现"。没有理由的加分一律不加。

---

## 4. 核心环节（重点阅读）

### 4.1 连接器与统一条目模型

- 每个数据源是一个文件：`lib/connectors/<id>.mjs`，导出 `meta`（字段定义）与 `fetchAll(config)`；
- 统一产出 **items**：`{ kind, external_id, title, due_at, start_at, url, notes, course?, download? }`；
- `lib/connectors/index.mjs` 负责注册与查找：**加新适配器不用改主程序**；
- 连接器可以在 `meta` 里声明 `notify: true`，抓回来的内容自动进"通知"池；
- 九种：飞书、Canvas、通用 IMAP 邮箱、学校邮箱、arXiv、任意 RSS/Atom、任意 ICS 日历、
  任意 JSON 接口（自带字段映射）、本地文件（CSV/JSON/ICS）。

**解析器是独立纯函数**（`lib/feed.mjs`、`lib/ical.mjs`、`lib/jsonmap.mjs`、`lib/localfile.mjs`）：
这样"解析格式"与"取数据"能分开测（喂一段 RSS 文本就能断言解析结果）。

### 4.2 信息筛选：`lib/relevance.mjs`（先决定"要不要打扰你"）

四级流水线：

1. **画像**（`profile`）：关键词、课程代码、允许/屏蔽的发件人与词。三种来源 —— 长期记忆文本导入、
   手填、从课程表/邮箱自动派生；
2. **打分**（`scoreItem`）：来源权重、词命中、发件人白/黑名单……每一项都写进 `reasons`；
3. **裁决**（`push / review / drop`）：按阈值分三档，中间带留在"待批准"里等人确认；
4. **学习**（`lib/learning.mjs`）：你在"待批准"里删/留会累积成规则（删过 3 次 → 以后自动降级）；
   另有**语义兜底**（`lib/semantic.mjs`）：规则拿不准的中间带，在**非高峰**交给模型判一次。

### 4.3 重要性：`lib/priority.mjs`（再决定"先看哪条"）

- **上下文**（`buildPlanContext`）把"你的未来规划"拼成可比对的词表：
  ① 你手写的规划文本 ② 里程碑 ③ 校历/考试 ④ 未来 14 天的任务与日程；
- **打分**（`scoreImportance`）从 30 分中性起点开始加/减，每一项都带 `reasons`：
  时间紧迫度（明天内 +35 / 3 天内 +25 / 一周内 +15 / 14 天内 +8）、
  未完成任务的逾期 **+18**（纯提醒过期才 −12）、命中规划关键词最多 +30、
  标题里的行动词 +12、紧急词 +8、课程作业 +6、来源权重（课程平台/学校邮箱 +10）、
  未处理条目 +5、历史行为（保留过 +8 / 忽略过 3 次 −25）、相关度裁决（建议忽略 −20）；
- **排序**（`rankByImportance`）：分数 → 有时间的优先 → 标题稳定排序；
- **建议**（`buildAdvice`）：规则版离线可用，给出"最急的一件 / 逾期未处理 / 规划相关 / 考试临近 / 撞车日"；
  想让模型写更细的建议就点"让 agent 分析"（非高峰才调，失败自动回落规则版）。

**两个真实修复**（都是在真库上跑出来的，值得审阅时对照）：

1. **长正文会刷爆关键词**：每日简报类条目曾命中 85~181 个词 → 现在**标题权重 ×1、正文 ×0.4**，
   且"要行动 / 紧急 / 课程作业"这类措辞**只看标题**；
2. **通知太多会把"今天的"整段挤掉**：通知列表按时间**从旧到新**返回，收满上限就 `break`
   ⇒ 装进去的全是两周前的旧邮件，**当天的"周五截止"提示根本没进榜单**。
   修法：**先按"离现在多近"排序，再截断**（上限 200）。

### 4.4 投递与打扰：什么时候真的响

| 机制 | 文件 | 规则 |
| --- | --- | --- |
| 通知三档 | `lib/relevance.mjs` | 立刻 / 摘要 / 静默 |
| 专注免打扰 | `lib/focus.mjs` | 专注时段内不弹，结束后补 |
| 高峰不花模型钱 | `lib/peak.mjs` | 工作日 9–12、14–18 为高峰；语义兜底与"写建议"避开 |
| 手机推送 | `lib/bark.mjs`、`lib/mobile.mjs` | **只发标题 + 一句话**（手机上看长文很痛苦）；短时间窗口内限流防刷屏 |
| 日报 / 晚报 | `lib/digest.mjs`、`lib/mobile.mjs` | 早报看今天、晚报看明天：**最值得先看的 3 条 + 建议 + 日程**；两档各自开关（默认关） |
| 自动推送 | `lib/autopush.mjs` + `lib/autopush-run.mjs` | 默认**关**；达到阈值才进通知 / 推手机；同一件事 24 小时不重复；自己推出去的不再回榜 |
| DDL 倒计时与多级提醒 | `lib/ddl.mjs`（引擎已就绪） | 7 天 / 3 天 / 1 天 / 3 小时 / 30 分钟五档；**已提交就不再提醒** |

### 4.5 模块系统：加一个功能 = 加一个目录

```
modules/<id>/
  module.json   # 声明：id / 名称 / 挂到哪个视图 / 读写哪些数据 / 需要什么权限
  view.js       # 导出 mount(el, ctx) 与纯函数 renderCard()（便于测试）
  README.md     # 可选，给人看
```

想让功能**有自己的就地设置**（2026-09-27 新增）：`module.json` 里写 `"settings": true`，
`view.js` 再导出 `settings(host, ctx)` —— 功能页右上角就会出现「⚙ 功能设置」，点开是右侧抽屉。
值存在功能自己的键 `fn_<id>` 里（`lib/function-settings.mjs` + `lib/routes/function-settings.mjs`），
设置页只在「功能」页签留一行指路。为什么这么做：设置页收 18 个功能的细项会变成杂物间，
而"这项设置只在那一页生效"本身就该在那一页上说。

- 后端只做"发现 + 校验 + 静态资源"（`lib/modules.mjs`），**坏模块不会让整体失败**：
  出错的模块带 `error` 字段返回，界面跳过它；
- 前端按 `mount_into` 把 gadget 挂进对应视图（`public/app.js` 的 `mountGadgets`），
  模块拿到 `{ api, esc, toast, refresh, DB, state, nav }`；
- **`kind: view` 的模块自己占一整页**（2026-09-24 补上挂载）：它的 `id` 就是那个页面的
  tab，导航与主菜单里自动出现，**切过去时才 import**（启动不为它多花时间）；
  页面标题/导航名也跟着 `module.json` 的 `name` 走。举例：`course-assist-view`（📚 课程辅助）；
- 十四个模块分五类：今日页 4（从这里开始 / 重要信息 / 日报晚报 / 上课前检查）、
  独立页 1（课程辅助）、**任务页 1（⏳ DDL 提醒）**、**统计页 1（💾 数据备份）**、
  数据源页 4（连接向导 / Agent 接入 / 我关心什么 / 摘要预览）、
  processor 3（示例功能 / 上课前 Canvas 检查 / 课程辅助）。

### 4.5.2 后台心跳：「到点自动做的事」都在一张 jobs 清单里

`lib/notify-tick.mjs`（2026-09-24 从主程序整块搬出来）负责**调度**，每件事的实现都在别处。
加一件"到点自动做的事" = 在 `server.mjs` 的 jobs 数组里加一行：

```js
{ name: 'daily', due: () => daily.status().due.ok, run: () => daily.runOnce({ dryRun: false }) }
```

三条被测试钉住的行为：**一个任务炸了不影响其它任务**、**一轮跑完一定排下一轮**（否则心跳会静默死掉）、
**每小时一行 `[heartbeat]` 日志**（事后能确认后台整晚都在跑）。当前清单：
`autosync / canvas-watch / semantic / digest / autopush / preclass / icloud / course-sync / backup / ddl / daily`。

另外两个"到点自动做"的东西各有自己的纯逻辑 + 执行能力：

- **DDL 提醒**：`lib/ddl.mjs`（五档 / 倒计时 / 去重键，纯函数）+ `lib/ddl-stack.mjs`（执行能力 + 接口 + 卡片）——
  每档只响一次、做完的不提醒、睡醒 15 分钟内补上、默认不推手机；
- **每日 18:00 开工**：`lib/daily.mjs`（到点判断，纯函数）+ `lib/daily-stack.mjs`——到点刷新本周巩固包、
  数今天的事、汇总成**一条**通知；一天一次、一天一条，默认不推手机。

**每周巩固包**（能力③）在 `lib/course-assist.mjs` 的 `buildWeeklyPack()`：按课程分节，
考点/例题/自测题**只从材料里摘**（附出处），摘不到就明说"材料里没有"，并单列"要自己翻的"。

### 4.5.1 课程辅助的三层（新功能长什么样：从纯逻辑到落盘）

```
lib/coursetext.mjs     ① 读课件：PDF / pptx / docx / ipynb → 文字（零依赖）
                       读不出来就如实说：needsOcr / garbled（字形编号）/ unsupported
lib/course-assist.mjs  ② 认材料：认课程与周次、抽关键词、生成索引、在材料里找话
lib/course-stack.mjs   ③ 接线：给功能注入能力 + **写文件的闸门**（只准写 <数据目录>/study）
modules/course-assist/       功能本体（processor）：吃 signal → 吐 action(file)
modules/course-assist-view/  那一页（view）：选目录 / 生成 / 搜索 / 看产物
lib/routes/localdirs.mjs     本机目录（壁纸 / 课程资料）：读、改、弹系统选择框
```

两条可复用的经验（都是真课件上踩出来的，写在代码注释里也写在测试里）：

1. **解析器要防"指数级回溯"**：PDF 里充满"有 `[` 但没有 `TJ`"的二进制流，
   一个写得小心的正则能让一份课件的解析几分钟不返回（`tests/coursetext.test.mjs` 有回归用例）；
2. **"抽到文字"不等于"读到内容"**：数学字体/子集字体抽出来是字形编号
   （`IIII IIIIII PAB:=fx:`），按字符统计反而像人话 —— 所以要有一层
   `looksGarbled()`，索引里如实标"乱码·看原文"，绝不假装读到。

### 4.6 凭据与隐私（安全边界，重点审这一节）

三条规则，缺一不可：

1. **写盘即加密**：`lib/secrets.mjs` 用 AES-256-GCM，密钥在 `<数据目录>/.secret.key`；
   存储层遇到凭据类键名自动加密，读出来自动解密；
2. **对外只给掩码**：`lib/credential-mask.mjs` —— 读一律给掩码（`••••` 加末四位）；
   界面把掩码传回来时**沿用已存真值**（否则掩码会被当成新密码存进去）；密码框留空也算"没改"；
3. **不进仓库**：`data/`（含数据库、密钥、日志）、个人壁纸素材、课程资料一律被 `.gitignore` 排除；
   发布前还有一道"隐私体检"脚本扫描整棵树。

### 4.7 数据版本迁移：老库不能因为升级而报废

`lib/migrations.mjs` 给每次结构改动一个**编号**，只跑一次、跑过留痕；
启动时自动补齐缺列（自愈），失败不会让服务起不来，而是在 `/api/status` 里标成警告。
当前版本号与已应用条数会显示在应用状态里（例如"数据版本 6（6/6 项已应用）"）。

### 4.8 契约与出口

`contracts/*.schema.json` 定义对外形状（通知导出、离线快照、邮件桥请求/结果、作业定义、
健康状态、显示层 ViewModel、三段式 `source-item`/`signal`/`action`、能力 `capability.v1`……）。
规矩是**只增不改**；破坏性变更必须同时新增 fixture 与双侧测试。
`lib/export-contract.mjs` 负责生成，`lib/app-status.mjs` 把健康状态折成托盘可读的一份 JSON。

### 4.9 验证体系（三层 + 证据）

| 层 | 位置 | 例子 |
| --- | --- | --- |
| ① 纯函数单测 | `tests/*.test.mjs` | `relevance` / `priority` / `digest-brief` / `ddl` / `onboarding` |
| ② 接口与模块（替身） | `tests/*-routes.test.mjs`、`*-module.test.mjs` | 用假 store / 假 fetch / 假 DOM 跑真实代码路径 |
| ③ 活服务与打包演练 | `work/tools/*.py`、`*.mjs` | 上线冒烟、全新安装、审阅包解压即用、隐私体检、跨平台子集 |

**证据文化**：每轮改动的全套结果都会写成 `work/evidence/验证输出_<时间>.md`
（含每条命令、输出尾部、耗时、结论），写报告时直接引用文件名。

### 4.10 能力层：能力是**登记**出来的，不是手写的

**能力**（= 再处理运算的原子动作，如读课件、推手机）登记在 `lib/capabilities/index.mjs`，
每条都按 `contracts/capability.v1.schema.json` 说明：入参 / 出参、要哪些权限、副作用类别
（`kind`：`read` / `compute` / `write` / `outbound`）、能不能重放（`idempotent`）、
花不花钱（`cost`）、实现在哪（`entry`）、单测在哪（`tests`）。

加一条能力的规矩：**一个文件一条**（`lib/capabilities/impl/<域.动作>.mjs`，导出 `meta` + `bind` + `run`），
注册表靠**扫目录**发现它，`validateCapability()` 会拦住拼错的 id 与没登记过的权限码。
命名用点分「域.动作」（`course.text` / `canvas.course.check`），粒度少而稳。

**三条粒度，从"算"到"拼"**（2026-10-02）：

1. **自带能力**（`lib/capabilities/impl/`）：真正的原子动作，其中最通用的一批是
   `http.get` / `json.pick` / `text.template` / `text.split` / `text.extract` / `csv.parse` / `logic.each`
   —— 有这几条，"接一个新接口"这类事在图上连一连就能做完，不用写代码；
2. **复合能力**（`<数据目录>/capabilities/<id>.json`）：`{ meta, flow }`，一条能力 = 一张小图，
   由其它能力拼出来（`lib/capabilities/user.mjs` 的 `validateComposite` / `runUserCapability`）；
3. **手写能力**（`<数据目录>/capabilities/<id>.mjs`）：`meta` + `run(input, ctx)`，兜底用。

复合能力与手写能力都**不进仓库、不进版本控制** —— 它们在数据目录里，随装随删，
平台启动/每次读取时扫描、校验、登记（坏的能力会带着错误原因列出来，而不是静默丢掉）。
控制类能力（`logic.each`）通过 `ctx.invoke` 调别的能力，宿主有**层数护栏**（第 8 层停下），
所以两个互相调用的复合能力不会把进程转死。

图上的**条件**（`when`）由 `lib/flow.mjs` 求值：不成立 = 安静跳过，并且"上游没跑 ⇒ 下游也不跑"
自动往下传（`tests/flow-conditions.test.mjs`）。

⚠️ **装配方式（M1 · S4/S5，已完成）**：`server.mjs` 用 `createCapabilityHost` 按登记表装配，
功能在 `module.json` 的 `requires.capabilities` 里声明了哪几条就拿到哪几条；
**手写的 `extraContext` 合并已经删掉**（`tests/capabilities.test.mjs` 有断言盯着）。

---

## 5. 代码地图（文件 → 职责 → 关键函数）

### 5.1 领域层 `lib/`

| 文件 | 职责 | 关键函数 / 常量 |
| --- | --- | --- |
| `relevance.mjs` | 相关度：画像 → 打分 → 三档裁决 | `scoreItem`、`deriveProfileFromState`、`normalizeProfile` |
| `learning.mjs` | 行为学习：从删/留里学规则 | `recordFeedback`、`learnedRules` |
| `semantic.mjs` | 语义兜底（只对中间带、只在非高峰） | `buildSemanticPrompt`、`parseSemanticReply`、`applySemanticResults` |
| `priority.mjs` | 重要性：未来规划上下文 + 打分 + 排序 + 建议 | `buildPlanContext`、`scoreImportance`、`rankByImportance`、`buildAdvice` |
| `digest.mjs` | 日报/晚报：挑条 + 说人话 + 手机短句 | `buildBrief`、`pickTop`、`scheduleLines`、`buildPushBody` |
| `autopush.mjs` / `autopush-run.mjs` | 自动推送：规则（纯函数）/ 执行（建通知、推手机、节流） | `selectAutopush`、`markSeen`、`createAutopushRunner` |
| `ddl.mjs` | 倒计时文案 + 多级提醒档位 | `countdownText`、`dueLevel`、`planSteps`、`stepsDueNow` |
| `onboarding.mjs` | 入门清单：步骤定义 + 从真实状态推导打勾 | `ONBOARDING_STEPS`、`computeSteps`、`summarize` |
| `brand.mjs` | 应用显示名的唯一来源（env > brand.json > 默认） | `appName`、`saveAppName`、`brandInfo` |
| `mobile.mjs` | 手机侧：Bark 推送、早报/晚报邮件、日历订阅、文件中转 | `getMobilePrefs`、`buildDigestText`、`sendDueDigests`、`writeMobileFiles` |
| `bark.mjs` / `smtp.mjs` | 两个零依赖外发通道（HTTPS 推送 / SSL SMTP） | `barkPush`、`sendMail` |
| `caldav.mjs` / `ics.mjs` | 日历：写进 iCloud（CalDAV）与生成 `.ics` | `discover`、`syncEvents`、`buildIcs` |
| `connectors/*.mjs` | 九种数据源适配器 + 注册表 | `fetchAll`、`listConnectorMeta` |
| `feed.mjs` / `ical.mjs` / `jsonmap.mjs` / `localfile.mjs` | 四种通用解析器 | `parseFeed`、`parseIcal`、`mapJson`、`readLocalFile` |
| `course-sync.mjs` / `naming.mjs` | 课程资料：自动下载、统一命名、推办公本/邮件 | `queueCanvasFile`、`runCourseSync`、`buildCourseFileName` |
| `workbook.mjs` | 办公本联动：检测设备、读书架、拷 PDF | `listWorkbookContainer`、`sendToWorkbook` |
| `mail-bridge.mjs` | 发信通道：把 `mail-job.v1` 契约交给本机的外部邮件桥 | `sendViaMailBridge`、`mailBridgeStatus`、`testMailBridge` |
| `llm.mjs` / `codex-config.mjs` / `codex.mjs` | 模型接入：OpenAI 兼容 / Anthropic / Ollama / **沿用本机 Codex 配置** | `askLlm`、`llmReady`、`resolveLocalProvider` |
| `secrets.mjs` / `credential-mask.mjs` | 凭据加密与脱敏（安全边界） | `encryptString`、`shouldKeepStoredSecret`、`maskMobilePrefs` |
| `store.mjs` / `migrations.mjs` / `paths.mjs` / `local-config.mjs` | 存储、迁移、路径外置 | `getSync`、`runMigrations`、`resolveDbPath`、`localPath` |
| `modules.mjs` / `peak.mjs` / `focus.mjs` / `duedate.mjs` | 模块发现、高峰、专注、截止语义 | `scanModules`、`isPeak`、`isFocusRunning`、`dueMs` |
| `function-settings.mjs` / `routes/function-settings.mjs` | **功能自己的设置**：一个功能一套键 `fn_<id>` + 命名模板预览 + 三个接口 | `getFunctionSettings`、`setFunctionSettings`、`courseAssistNamePreview` |
| `plan-export.mjs` / `export-contract.mjs` / `app-status.mjs` | 数据出口与健康状态 | `buildPlan`、`writeExportFiles`、`buildPlannerAppStatus` |
| `md-lite.mjs` / `media.mjs` / `wallpapers.mjs` | 应用内文档渲染、壁纸与音乐（含目录穿越防护） | `markdownPage`、`createMedia` |
| `coursetext.mjs` | **读课件**：PDF / pptx / docx / ipynb / 文本 → 文字（零依赖；诚实标记读不出来的） | `extractText`、`classifyFile`、`looksGarbled`、`keywordsOf`、`locateText` |
| `course-assist.mjs` | **课程辅助的纯逻辑**：认课程/周次、读材料、生成资料索引、在材料里找话 | `scanCourseMaterials`、`readMaterials`、`buildMaterialIndex`、`searchMaterials` |
| `course-stack.mjs` | 课程辅助接线 + **写文件的闸门**（只准写 `<数据目录>/study`） | `createCourseStack`、`writeStudyFile`、`studyPath` |
| `processor.mjs` / `processor-executors.mjs` | 再处理功能：动作规范化（纯函数）与三个执行能力（通知 / 手机短句 / 写文件） | `normalizeActions`、`canExecute`、`createProcessorExecutors` |
| `notify-tick.mjs` | **后台心跳的调度层**：jobs 清单、一个任务炸了不连坐、每小时一行心跳 | `createTickRunner` |
| `ddl.mjs` / `ddl-stack.mjs` | **DDL 提醒**：五档 / 倒计时（纯函数）+ 执行能力 / 接口 / 卡片 | `stepsDueNow`、`reminderKey`、`createDdlStack` |
| `daily.mjs` / `daily-stack.mjs` | **每日 18:00 开工**：到点判断（纯函数）+ 执行能力 / 接口 | `dailyDue`、`dateKeyOf`、`createDailyStack` |

### 5.2 接口层 `lib/routes/`

| 文件 | 负责的路径 |
| --- | --- |
| `connectors.mjs` | `/api/connectors/*`（配置读写、测试连接、导入/推送、待批准） |
| `study.mjs` | `/api/courses`、`/api/academic`、`/api/habits`、`/api/focus`、`/api/milestones`、`/api/insights` |
| `priority.mjs` | `/api/priority`、`/api/plan/goals`、`/api/priority/advice`、`/api/priority/autopush` |
| `digest.mjs` | `/api/digest`、`/api/digest/push`、`/api/digest/advice` |
| `docs.mjs` | `/docs/*`（只读渲染 `docs/*.md`，挡目录穿越） |
| `prefs.mjs` | `/api/prefs`（主题 / 系统通知 / **显示名** / **入门清单**） |
| `mcp.mjs` | `/api/mcp/*`（给外部 AI agent 的**只读**数据：今日 / 任务与 DDL / 重要信息 / 课件检索 / 学习产物） |
| `localdirs.mjs` | `/api/localdirs`、`/api/localdirs/pick`（**本机目录**：壁纸目录 / 课程资料目录，含系统选择框） |
| `course.mjs` | `/api/course`、`/api/course/search`（课程辅助那一页的数据与"在课件里找一段话"） |
| `modules.mjs` | `/api/modules`、`/api/modules/:id/run`（功能清单与运行，**默认演练**） |
| `ddl.mjs` | `/api/ddl`、`/api/ddl/check`、`/api/ddl/reset`（DDL 提醒设置与立刻检查） |
| `daily.mjs` | `/api/daily`、`/api/daily/run`（每日开工设置与立刻开工，**默认演练**） |
| `backup.mjs`（lib/backup-stack.mjs） | `/api/backups`、`/api/backups/run`、`/api/backups/check`（自动备份） |

### 5.3 其他

| 位置 | 说明 |
| --- | --- |
| `public/viewmodel.js` | 显示层：每条视图一个 selection 函数；程序里保留等价旧实现，`?vm=0` 或加载失败时回退 |
| `public/app.js` | 视图渲染、交互绑定、模块加载与挂载（`mountGadgets`） |
| `public/styles.css`、`public/assets/` | 主题与素材（个人壁纸不进仓库） |
| `modules/<id>/` | 14 个可插拔功能（10 个 gadget + 1 个 view + 3 个 processor，见 §4.5） |
| `shell/`、`tray.ps1`、`*.cmd`、`*.vbs` | Windows 托盘与独立窗口外壳 |
| `tests/` | 跨平台子集的 80 套测试都在这里 |
| `lib/capabilities/` | 能力注册表（`index.mjs`，见 §4.10）—— 能力在这里登记 |
| `contracts/` | 版本化契约与 fixtures |

---

## 6. 三条主流程走查

### 6.1 从"新增一个 RSS"到"出现在重要信息里"

1. 界面填网址 → 配置加密落盘（连接器配置表）；
2. 点"测试连接"或到点自动同步 → `lib/connectors/rss.mjs` 取数 → `lib/feed.mjs` 解析；
3. 每条进连接器数据表，带裁决（推给你 / 待确认 / 建议忽略）——由 `lib/relevance.mjs` 判定；
4. "待确认"的留在"待批准"里，"推给你"的进通知 / 任务 / 日程；
5. `/api/priority` 把待处理条目 + 通知按"未来规划"排序 → 界面「重要信息」卡片；
6. 达到阈值且你开了「自动推送」→ `lib/autopush-run.mjs` 到点进通知 / 推手机；
7. 早报 / 晚报邮件把"最值得先看的 3 条 + 建议"送到邮箱。

### 6.2 改名与入门清单（2026-09-23 新增）

1. 「今日」页最上面的 `getting-started` 卡片 → `GET /api/prefs` 拿到品牌与清单；
2. 清单的勾不是"点过就算"：`lib/onboarding.mjs` 用**真实状态**推导
   （名字是否自定义过、是否配过数据源、模型是否就绪）；"看过文档"只能人自己点；
3. 改名写进 `<数据目录>/brand.json` —— `data/` 不进仓库，所以**名字是本机的**，
   别人 clone 下来仍然看到默认名；
4. 点"不再显示"写进本机偏好，之后不再出现。

### 6.3 日报/晚报：从排序到邮件（含模型兜底）

1. `priority.computePriority()` 出排序结果（与「重要信息」**同一套**，绝不重复实现）；
2. `lib/digest.mjs` 的 `buildBrief()` 挑最值得先看的 3 条（**宁缺毋滥**：过期的不挑、
   "分档低且不急"的不挑），再排版并生成手机短句；
3. `lib/mobile.mjs` 的 `buildDigestText()` 把它拼进邮件正文（早报 07:00 / 晚报 21:00，各自开关）；
4. 想让模型写建议 → `POST /api/digest/advice`：非高峰才调，且**只取结论**：
   推理模型会把"我们需要回答……"这类思考也放进正文，这里有一层 `extractAdviceText` 兜底。

---

## 7. 扩展指南

**加一个数据源**：复制任一 `lib/connectors/*.mjs` → 写 `meta.fields` 与 `fetchAll()` →
在 `index.mjs` 注册 → 写一个"喂假输入 → 断言条目"的测试。（教程：[CONNECT_SOURCES.md](CONNECT_SOURCES.md)）

**加一个功能模块**：复制 `modules/digest-preview/`（最小示例）→ 改 `module.json` 与 `view.js` →
导出纯函数 `renderCard()` 便于测试 → 放进 `modules/` 即被发现。（指南：[WRITING_A_MODULE.md](WRITING_A_MODULE.md)）

**改打分规则**：只动 `lib/relevance.mjs` 或 `lib/priority.mjs`，并把新判据写进对应测试；
不要改接口层 —— 接口只负责"取料 → 算 → 回话"。

**加一份对外数据**：先在 `contracts/` 加 schema 与 fixture（**只增不改**），
再在 `lib/export-contract.mjs` 里实现，最后让契约校验通过。

**加一套验证**：写 `tests/xxx.test.mjs`（跑完打印 `xxx.test: PASS` 并以退出码表态），
然后登记到 `tests/run-portable.mjs`（跨平台）与 `work/tools/run_all_suites.py`（全套）。

---

## 8. 失败与降级（都是踩过的）

| 场景 | 现在的行为 |
| --- | --- |
| 网络不通 / 站点改版 | 单个连接器失败不影响其它；错误翻成"人话 + 下一步"（`lib/connector-errors.mjs`） |
| 模型没配 / 报错 / 只吐思考 | 自动回落规则版并说明原因；绝不把思考过程当结论显示 |
| 数据库结构升级 | 迁移台账自动补齐缺列；失败标警告，不让服务起不来 |
| 静态文件读取失败 | 明确区分"文件不存在"与"句柄耗尽"，并写日志 |
| 模块写坏 | 只让那个模块带 `error`，其余照常 |
| 凭据文件损坏 | 名字回退默认；密文解不开就要求重填，绝不崩 |

**三条历史教训**（审阅时值得对照代码）：

1. **流不销毁会漏句柄**：视频用 `pipe` 时中断不关读流，攒够导致 `EMFILE` → 改用 `pipeline`；
2. **通知窗口别用"从旧到新 + 截断"**：会挤掉当天的条目（见 §4.3）；
3. **测试别写死日期**：跨零点会假红 → 夹具改成"相对今天"。

---

## 9. 已知限制与明确不做的事

- **手机端不是 App**：只有 Bark 短推送、`.ics` 订阅、今日文本与邮件摘要；
- **OAuth2 类数据源没做**（需要跳浏览器同意的那类，例如某些日历服务）；
- **Windows 专属**：托盘、开机自启、办公本 MTP、课程表 XLSX（依赖 Office/WPS）；
- **不做自动提交作业**（2026-09-24 评审后**永久砍掉**，不再排期）：审阅意见是"风险太高、用处不大"，
  作者同意。程序只做整理、提示与提醒；**提交永远由人来点**。
- **数据备份已经是程序兜底**（同一次评审提出）：`lib/backup.mjs` + `lib/backup-stack.mjs`
  每天用 SQLite 的 `VACUUM INTO` 存一份一致快照，只留最近 N 份；备份目录可以指到网盘同步文件夹
  ⇒ 不引入任何云账号也有一份"离开这台机器"的副本。界面在「统计」页的 💾 数据备份卡片。
- **不代做作业、不代写代码**：只做整理、提示与提醒。
- **数学字体 / 扫描版 PDF 抽不出正文**（2026-09-24 在真课件上实测）：LaTeX 特殊字体、
  PPT 子集字体抽出来是字形编号，扫描件根本没有文字层。处理方式 = **如实标记**
  （索引里写"乱码·看原文"/"需 OCR"），`looksGarbled()` 还会从乱码里抢救出正常字体的那几段；
  彻底解决要 OCR 或解析字体映射，**明确留到发布之后**（不阻塞发布，也不假装已经支持）。
- **索引与搜索是"现扫现读"**：62 份材料约 3～4 秒（本地、零成本）。不建向量库、不训练模型 ——
  关键词与定位都是本地启发式，找不到就说找不到。

---

## 10. 路线图（发布前）

| 阶段 | 内容 |
| --- | --- |
| P0 | 把"手机通道"路由搬出主程序（当前主程序贴着行数护栏） |
| P1 | 校内工具面板（课程平台与校内 AI 工具的一键入口） |
| P2 | DDL 倒计时 + 多级提醒（手机只发短句；已提交就不再提醒） |
| ~~P3~~ | ~~提交保险~~ —— **2026-09-24 评审后砍掉**（风险高、用处不大；理由见 §9） |
| P4 | 课程辅助（课件文字索引 → 题单/考前整理 → 错题本） |

---

## 附录 A · 常用命令

```bash
npm start                                     # 启动（无需 npm install）
node tests/run-portable.mjs                   # 跨平台子集（CI 入口）
node tests/priority.test.mjs                  # 单套：打分规则
python -X utf8 work/tools/run_all_suites.py   # 全套 + 写证据
```

## 附录 B · 术语表

| 词 | 含义 |
| --- | --- |
| **功能** | 再处理运算的**结果**：用户能看见、能用的那一件事（代码里 = `modules/<id>/`，`kind: processor` 即"再处理功能"） |
| **能力** | 再处理运算的**能力**：可复用的原子动作（`course.materials.read`、`push.phone`…）；三个会写外部世界的按 `kind: write \| outbound` 标 |
| 执行能力 | 真正动手那三个：通知进本机通知表 / 推手机（Bark 短句）/ 写文件（只准写 `<数据目录>/study`） |
| 条目 / item | 连接器抓回来的一条数据（任务 / 日程 / 提醒 / 文件 / 页面……） |
| 裁决 / verdict | 相关度结论：推给你 / 待确认 / 建议忽略 |
| 分档 / band | 重要性结论：重要（≥70）/ 一般（≥45）/ 低 |
| 挂载点 / mount_into | 模块显示的位置（如今日页 `today`、数据源页 `connectors`） |
| 未来规划 | 参与排序的四样东西：手写规划 + 里程碑 + 校历/考试 + 未来 14 天安排 |
| 摘要档 | 被筛选拦下、集中放进每日摘要让你确认的条目 |

## 附录 C · 文档地图

| 想了解 | 看这篇 |
| --- | --- |
| 怎么用、能接什么 | [README](../README.md) |
| 每一层在干嘛（非程序员） | [HOW_IT_WORKS.md](HOW_IT_WORKS.md) |
| 数据源怎么填、报错怎么办 | [CONNECT_SOURCES.md](CONNECT_SOURCES.md) |
| 信息怎么排优先级 | [PRIORITY.md](PRIORITY.md) |
| 日报 / 晚报怎么来的 | [DIGEST.md](DIGEST.md) |
| 怎么写一个模块 | [WRITING_A_MODULE.md](WRITING_A_MODULE.md) |
| 外部邮件桥（可选） | [MAIL_BRIDGE.md](MAIL_BRIDGE.md) |
