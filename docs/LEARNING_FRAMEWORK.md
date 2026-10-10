# 学习框架 · 以 Agent research 为中心

> 这一页是「学习区」（应用内左侧导航 `🧭 学习区`）的长文版，同源维护。
> 定位：不是"把 CS 全学一遍"，而是**以 Agent research 为中心、由项目反推基础**的一棵知识树 + 一套可执行的循环。
> 生成时间：2026-10-05（FA26 第 4 周）。

---

## 0 · 一句话定位

你的特点是：**工程实践已经跑在理论学习前面**。所以路线不该是"先花一年学完基础再做科研"，而是

```
做项目 → 遇到问题 → 不懂为什么 → 学基础 → 回项目验证 → 写下理解
      → 发现更深问题 → 阅读论文 → 找 research gap → 做实验 → 得到新问题 → 再学习
```

不要问"给我一套 AI Agent 学习路线"（那只会得到一份漂亮但无法执行的课程表）。
正确做法：**先诊断 → 再规划 → 再教学 → 再考试**。

---

## 1 · 知识树：七层 + 贯穿的 Research Method

```
                     Agent Research
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   Agent / LLM        AI Systems         AI Security
        └──────────────────┼──────────────────┘
                           ▼
                    CS / ML 基础能力
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
    Algorithms         Systems          Mathematics
        └──────────────────┼──────────────────┘
                           ▼
                   Research Methodology
```

| 层 | 内容 | 为什么 | 够用的标准 |
| --- | --- | --- | --- |
| L1 CS 基础 | 数据结构与算法 | ACM 与之后几乎所有 CS research 的入场券 | 看到一个问题能自己分析数据结构与复杂度，而不是先问 Agent |
| L2 Systems | OS / Networking / Distributed | Pigeon 已经把你拉进来了，缺的是原理 | 能解释 Pigeon 每条重试/去重为什么这么设计，并指出哪里会重复、哪里会丢 |
| L3 Software Architecture | 接口·抽象·契约·模块化 | Cairn 的 monolithic → package migration 就是典型案例 | 能回答：这个模块为什么存在？接口为什么这样设计？换一个实现会影响什么？ |
| L4 AI / ML 基础 | ML → DL → LLM → Agent | 真正进入 Agent research 的门槛 | 能解释 attention 的 O(n²) 与 KV cache 省了什么；能读懂论文方法段 |
| L5 Mathematics | 线代·微积分·概率·统计 | 数学服务于理解 ML，不单独成为主线 | 能手推反向传播的链式法则；能解释一个 metric 在估什么 |
| L6 Agent Research | planning·tool use·memory·evaluation·capability selection·multi-agent | 这一层才把你和"会调 API 的人"区分开 | 能把工程现象写成可验证问题（问题 → hypothesis → baseline → 实验 → 指标） |
| L7 Security | 认证·授权·最小权限·沙箱·capability-based security·prompt injection·trust boundary | `allowlist ≠ security` 是你亲手发现的真实问题 | 能画出 邮箱被盗 → 授权发件人 → Pigeon → 本地 Agent → 本机 的信任边界，并说清每道防线挡什么 |
| 贯穿 Research Method | 提问·假设·baseline·实验·ablation·指标·可复现·写作 | 决定你能否从工程师变成研究者 | 完成一次闭环：读懂论文 → 复现 → 找到局限 → 提小问题 → 设计实验 → 写 report |

---

## 2 · 能力诊断（14 个板块）

判定原则：**有项目经验 ≠ 理论掌握**。

| 板块 | 状态 | 依据 |
| --- | --- | --- |
| CS 基础（C/C++/Python、Git、测试、调试） | 有项目经验 · 理论不足 | 能写能跑，靠 AI/vibe coding 完成 |
| Algorithms / 数据结构 | 完全欠缺 | ACM 选拔最直接的短板 |
| Operating Systems / Linux | 有项目经验 · 理论不足 | Pigeon 常驻进程 / 心跳 / 托盘 / 计划任务 |
| Networking | 有项目经验 · 理论不足 | IMAP/SMTP/TLS/timeout/retry 天天在用 |
| Distributed Systems | 有项目经验 · 理论不足 | outbox / 去重 / 幂等 / 失败恢复 |
| Software Architecture | 有项目经验 · 理论不足 | 包化迁移、契约与语义漂移 |
| Mathematics | 部分具备 · 待补 | MATH1860J 在修；线代/概率/统计/优化待补 |
| Machine Learning | 完全欠缺 | 还没系统学过 ML 的语言 |
| Deep Learning | 完全欠缺 | 反向传播、CNN、Transformer 待正式补 |
| LLM | 有项目经验 · 理论不足 | 会用工具调用，pretraining / RLHF / KV cache 停在名词 |
| AI Agents | 有项目经验 · 理论不足 | Cairn / Pigeon / Planner 是真实实验场 |
| AI Systems | 有项目经验 · 理论不足 | 推理、调度、评测基础设施还没碰 |
| Agent Security | 有项目经验 · 理论不足 | 有真发现，缺系统语言 |
| Research Methodology | 完全欠缺 | 最短板，也是转型关键 |

**现在不用学**（明确写出来，是为了把时间留给上面）：

- 编译原理 / 图形学 / 竞赛级高级算法（除非 ACM 选拔明确要求）；
- 证明型数学分析（"AI 是否需要偏证明的数学分析"仍是公开问题，先不押主线）；
- 凸优化（Boyd）与强化学习理论（等进入 RL / representation learning 再加）；
- 大型分布式系统的工业级调优（先把 Pigeon 这一层的概念吃透）。

---

## 3 · 学习路线（按依赖 + 项目 + 科研目标）

### 阶段 0 · 现在 → 2027 春（ACM 校内补充选拔前）· 补算法与系统地基

- **学什么**：数据结构与算法（数组/链表/栈队列/哈希/树堆/图/BFS·DFS/最短路/DP/贪心/排序/复杂度/递归）；Linux 与 OS 基础（进程/线程/IPC/文件系统/权限/调度/信号/并发/锁/竞态）；Python 工程化 + C/C++ 基础；Git / 测试 / 调试。
- **为什么现在学**：唯一带硬 deadline 的一段（准备期约 5 个月），也是后面一切的地基。
- **学到什么程度就够**：中等题能自己选数据结构、估复杂度、写出可读实现；能读懂 Pigeon 的进程/线程/信号代码并解释为什么；看报错栈能自己定位。
- **对应 Cairn / Pigeon**：Pigeon 的 pythonw 常驻、心跳、托盘、任务计划；Planner 的定时任务与采集。
- **对 ACM / 2+2 / 暑研 / Agent research 的作用**：ACM 选拔；之后所有 CS research 的入场券；读系统代码不再靠猜。
- **下一阶段 prerequisite**：阶段 1 的网络与分布式直接依赖它。

### 阶段 1 · 大一上 → 寒假，与 Pigeon 同步 · 把 Pigeon 变成 Systems 实验场

- **学什么**：Networking（TCP/IP·HTTP·SMTP·IMAP·DNS·TLS·请求响应·连接与超时·重试）；Distributed Systems（失败·重试·超时·重复请求·幂等·exactly-once vs at-least-once·状态同步·一致性·容错·队列·事件驱动）；Concurrency & Reliability；Software Architecture。
- **为什么现在学**：这些问题你正在 Pigeon 里真实遇到——先有困惑再学理论，吸收率最高。
- **学到什么程度就够**：能解释每条重试/超时/去重为什么这样设计，能指出哪里会重复执行、哪里会丢；能画出失败路径与恢复路径。
- **对应 Cairn / Pigeon**：IMAP/SMTP、Message-ID 去重、outbox、heartbeat、auth.json 备份恢复、pigeon-mail.v1 契约、pigeon.py 的包化迁移。
- **作用**：暑研面试"你做过什么系统、为什么这样设计"的可讲内容；Agent 评测也需要这套系统思维。
- **下一阶段 prerequisite**：阶段 3 的 AI Systems 与 Agent 评测需要容错/一致性概念。

### 阶段 2 · 大一下起，与科研同步 · 补数学与 ML / DL / LLM

- **学什么**：Linear Algebra → Calculus（偏导/梯度/链式法则/优化）→ Probability → Statistics → ML → DL → Transformer / LLM。
- **为什么现在学**：没有这层，Agent research 只能停在"调 API"；数学服务于理解 ML。
- **学到什么程度就够**：能手推反向传播的链式法则；能解释 attention 的 O(n²) 与 KV cache 省了什么；能读懂一篇 ML 论文的方法段。
- **对应**：Planner 的语义兜底、LLM 调用、优先级排序与 digest。
- **作用**：暑研与 PhD 申请的核心门槛；2+2 课程的对接。
- **prerequisite**：阶段 1 的工程直觉 + 阶段 0 的复杂度分析。

### 阶段 3 · 大二起 · 进入核心方向：Agent / AI Systems / Agent Security

- **学什么**：Agent（Planning·Tool use·Memory·Reflection·ReAct·Multi-agent·Agent evaluation·Capability selection·Tool selection·Agent environment·Autonomous improvement）；AI Systems；Agent Security。
- **为什么现在学**：这是你要形成的不可替代性；Cairn / Pigeon 已经是现成实验场。
- **学到什么程度就够**：能把一个现象写成可验证问题——从 100 个 capability 里选 5 个 → 能否学习 selection policy → 能否从执行结果更新 → 如何评价它优于人工设计。
- **对应**：Cairn 的 capability selection / 记忆路由 / 打扰时机 / 规划质量；Pigeon 的 allowlist ≠ security 信任链。
- **作用**：论文与暑研选题；PhD 的 research identity。

### 阶段 4 · 大二下 → 大三 · 研究者转型

- **学什么**：Research question · Hypothesis · Baseline · Dataset / environment · Experiment · Ablation · Evaluation metric · Reproducibility · Error analysis · Literature review · Paper writing。
- **为什么现在学**：从"我觉得这个 idea 很酷"变成"这是一个已有工作没有解决的问题"。
- **学到什么程度就够**：读懂一篇 Agent/AI Systems 论文 → 复现核心实验 → 找到局限 → 提出一个可验证的小问题 → 设计实验 → 实现 prototype → 分析结果 → 写成 research report。
- **对应**：§1.3.1 的 RQ-A / RQ-B 与四条行为线；**10/12 前先定一条**。

### 贯穿 · 非技术线与英语

视频剪辑(MAD) · 电吉他 · 羽毛球 · 新事物探索 · 坚持学习 · 英语。
每项只要求一个最小闭环，不求同时推进——这是"不想把四年过成另一个高三"的落地方式。

---

## 4 · 资料地图

规则：每个主题最多 **1 个主教材 + 1 个辅助 + 2~5 篇关键论文**。优先大学课程 / 经典教材 / 官方文档 / lecture / 原始论文。
凡无法确认存在的东西不写——所以下面会有"先留着，别堆资源"的空缺。

| 主题 | 主 | 辅助 | 关键论文 |
| --- | --- | --- | --- |
| 数据结构与算法 | Competitive Programmer's Handbook（Laaksonen） | UC Berkeley CS61B | 用 CSES Problem Set + Codeforces 练手，不需论文 |
| Operating Systems / Linux | OSTEP（Arpaci-Dusseau） | MIT 6.1810（原 6.S081）xv6 labs | The UNIX Time-Sharing System（Ritchie & Thompson, 1974） |
| Networking | Kurose & Ross《Computer Networking: A Top-Down Approach》 | Beej's Guide to Network Programming | RFC 5321（SMTP）· RFC 3501（IMAP4rev1）· RFC 8446（TLS 1.3）· Cerf & Kahn 1974 |
| Distributed Systems | MIT 6.5840（原 6.824） | Kleppmann《Designing Data-Intensive Applications》 | Lamport 1978 · MapReduce 2004 · Dynamo 2007 · Raft 2014 |
| Software Architecture | Ousterhout《A Philosophy of Software Design》 | Fowler《Refactoring》 | Parnas 1972 · Out of the Tar Pit 2006 |
| Mathematics | MIT 18.06（Strang） | Blitzstein & Hwang《Introduction to Probability》 | 沿用 MATH1860J 教材（Abbott / Spivak / Tao）；统计：Wasserman《All of Statistics》 |
| Machine Learning | Stanford CS229 | Bishop《Pattern Recognition and Machine Learning》 | A Few Useful Things to Know About Machine Learning（Domingos, 2012） |
| Deep Learning | Goodfellow / Bengio / Courville《Deep Learning》 | Stanford CS231n 或 d2l.ai | AlexNet 2012 · ResNet 2015 |
| Transformer / LLM | Stanford CS336：Language Modeling from Scratch | Karpathy《Let's build GPT》 | Attention Is All You Need 2017 · GPT-3 2020 · InstructGPT 2022 |
| AI Agents | 暂无成熟教材 → 以论文为主 | Lilian Weng《LLM Powered Autonomous Agents》 | ReAct 2022 · Toolformer 2023 · Reflexion 2023 · Generative Agents 2023 · AgentBench / SWE-bench |
| AI Systems | Stanford CS336（系统那半） | 推理框架官方文档（vLLM 等） | Megatron-LM 2019 · FlashAttention 2022 · Efficiently Scaling Transformer Inference 2022 · PagedAttention / vLLM 2023 |
| Agent Security | OWASP Top 10 for LLM Applications | NIST AI 100-2 | Indirect Prompt Injection（Greshake et al., 2023）· Universal and Transferable Adversarial Attacks（Zou et al., 2023）· The Instruction Hierarchy（Wallace et al., 2024） |
| Research Methodology | Booth 等《The Craft of Research》 | Simon Peyton Jones《How to Write a Great Research Paper》 | The Science of Scientific Writing（Gopen & Swan, 1990） |

---

## 5 · 项目驱动学习

| 知识 | 落到哪个真实问题 |
| --- | --- |
| Process / Thread / 信号 | Pigeon execution model：pythonw 常驻、心跳超时重启、托盘、计划任务 |
| Networking | IMAP/SMTP 失败分析：连接超时、重试、TLS、发信受限 |
| Distributed Systems | retry / idempotency / outbox：重复请求与丢信的边界 |
| Security | allowlist + Agent execution boundary：邮箱被盗后还能不能执行 |
| Agent | Cairn capability selection：从一堆 capability 里选哪几个 |
| Research Methodology | 把 Cairn / Pigeon 的工程问题改写成 research question |
| Software Architecture | 契约 source-item.v1 → signal.v1 → action.v1；新增能力不动核心 |
| Mathematics / ML | Planner 的语义兜底与优先级排序：规则 vs LLM vs 混合 |

---

## 6 · 每周计划（必须 / 应该 / 以后）

**必须掌握**

- 算法：每周 2 个专题 + 8~12 道题（对应 2027 春 ACM 选拔准备）；
- 课程当天清：ENGR1010J / MATH1860J / STAT1000J（数学当天清已是既有习惯）；
- 科研三块（Planner 已排）：周一 09:30–11:30 / 周六 09:00–11:30 / 周日 17:00–20:00，共 7.5 h。

**应该理解**

- 文献精读 ≥1 篇/周（养成页已有习惯）；
- research log ≥3 次/周（养成页已有习惯）；
- 英语 30 分钟/天（养成页已有习惯）；
- 把本周遇到的一个系统问题写成 10 行：现象 → 猜测 → 验证 → 结论。

**可以以后学**

- 凸优化、强化学习理论、证明型数学分析；
- 编译原理 / 图形学 / 竞赛级高级算法；
- AI Systems 的工程调优（阶段 3 之前"看"即可）。

---

## 7 · 主动学习与知识检验

每学完一个主题，按四步走：

1. 先让我用自己的话解释概念；
2. 再给我一个小问题；
3. 再让我分析真实代码 / 系统；
4. 最后给一个新的、没见过的问题。

如果只会背定义而不会应用，直接指出。检验分四类，不只选择题：

**A 概念理解 · B 推理题 · C 代码/系统分析 · D 新问题迁移**

答错时：判断是概念错误 / 推理错误 / 数学基础错误 / 工程经验不足 → 指出 prerequisite → 给最小补课 → 再重测。
水平不足时**不要继续加材料**，先补 prerequisite。

---

## 8 · 三个可复用 Prompt

### ① 学习导师 Prompt

```
你现在是我的长期 CS + AI Agent 科研导师。

我的背景：上海交通大学浦江国际学院 CS 本科生；长期目标顶尖 CS PhD，方向倾向 AI Agent / LLM / AI Systems / Agent Security / Personal AI。已独立完成 Cairn（模块化个人信息与能力组合平台）与 Pigeon（Email 连接远程意图与本地 Agent 的执行桥，涉及 IMAP/SMTP、Agent execution、sandbox、权限、retry、timeout、outbox、heartbeat、fault tolerance）。软件实现能力较强，但很多系统由 AI/vibe coding 完成，工程实践领先于理论理解。计划参加 ACM 班选拔，争取大一/大二进正式科研组，未来考虑 SJTU → Michigan 2+2 → 暑研 → 顶尖 CS PhD。

按八个阶段工作：① 能力诊断（把知识分成 CS fundamentals / Algorithms / OS / Networking / Distributed Systems / Software Architecture / Mathematics / ML / DL / LLM / AI Agents / AI Systems / Agent Security / Research Methodology，并对每项标"已具备 / 有项目经验但理论不足 / 完全欠缺 / 暂时不需要"）；② 建立按依赖+项目+科研目标排序的路线；③ 每个主题最多 1 主教材 + 1 辅助 + 2~5 篇论文，优先大学课程/经典教材/官方文档/lecture/原始论文；④ 项目驱动（映射到 Cairn/Pigeon）；⑤ 每周计划（必须掌握 / 应该理解 / 可以以后学）；⑥ 主动学习（先让我解释概念，再给小问题，再让我分析真实代码，最后给没见过的问题）；⑦ 知识检验（概念 / 推理 / 代码与系统分析 / 新问题迁移四类，不只选择题；答错要判断是概念错、推理错、数学基础错还是工程经验不足，指出 prerequisite，给最小补课，再重测）；⑧ 科研训练（读论文、找 gap、提 hypothesis、设计 baseline/ablation、选 metric、解释 negative result、写 proposal）。

当我问一个知识点时，先判断它在学习树的位置，并告诉我：为什么现在值得学 / 学到什么程度 / 不学会影响什么。如果当前不重要，直接说"现在不用学"。不要默认我是零基础，也不要因为我会写代码就默认我懂理论。
```

### ② 能力考官 Prompt

```
你现在是我的 CS / AI Agent 科研能力考官。不要教我知识，负责判断我到底会不会。

我的当前学习主题是：【填写主题】
我的目标是：【填写目标，例如：理解 Distributed Systems 中 retry、idempotency、outbox 的关系】

请设计一次 30~60 分钟的能力测试，必须包含：① 基础概念（用自己的话解释关键概念）；② 对比与推理（给两个容易混淆的方案，解释差异、trade-off、适用场景）；③ 工程问题（真实系统问题，分析原因并给方案）；④ 代码/架构分析（给代码、伪代码或架构，指出问题）；⑤ 未见过的问题（不能靠背答案，测迁移）；⑥ 科研问题（说明是否有 research value、如何建 baseline、如何设计实验、如何评价结果）。

评分分别评价 Conceptual understanding / Problem solving / Implementation understanding / System thinking / Research thinking。不要因为答案最终正确就直接判定我掌握。重点检查：是否真正理解因果关系、能否解释"为什么"、能否迁移到陌生问题、能否识别自己的假设、能否指出 solution 的 trade-off。

最后输出：A 已掌握 / B 表面理解 / C 明显缺陷 / D prerequisite 缺口 / E 下一步最值得学的 3 个主题。如果我水平不足，不要继续加学习材料，先让我补 prerequisite。
```

### ③ 课程设计 + 文献地图 Prompt

```
我准备进入以下研究方向：【例如：Agent capability selection / tool-use / agent security】

请不要直接给我一个长书单。先建立这个领域的知识地图：① 最核心的问题是什么？② 需要哪些 prerequisite？③ 有哪些主要 research directions？④ 每个方向最经典的 3~5 篇论文？⑤ 哪些是历史基础、哪些代表当前前沿？⑥ 每篇论文我该重点看什么？⑦ 如果我是本科生，哪些内容可以暂时跳过？⑧ 哪些论文适合复现？⑨ 哪些问题仍然开放？⑩ 我的 Cairn / Pigeon 经验哪些能转化成研究问题？

然后给我一条最小学习路径：Prerequisite → Foundational Paper → Modern Paper → Reproduction → Research Question。不要追求资料数量，要追求知识之间的依赖关系。如果某个资料已经过时，明确说明。如果你无法确认论文/课程是否真实存在，不要编造。
```

---

## 9 · 非技术线

| 内容 | 现状 | 目标 | 最小闭环 |
| --- | --- | --- | --- |
| 视频剪辑（MAD） | AE/PR 已装，7 个项目文件夹已补齐，groovy MAD 议题已定 | 每学期 5~6 个里先跑通 1 个 30 秒小样 | 四层结构各一次 + 8 拍不切 + 迟拍一致 |
| 电吉他 | 完全零基础，正式课 10/11 开始 | 先体验课 + ≥2 周每天摸琴再决定买琴 | 两周后能完整弹出一段和弦进行并录音 |
| 羽毛球 | 每周 2~3 次 | 当"恢复"而不是任务，与 23:30 前睡一起 | 一周打满 2 次即达成 |
| 新事物探索 | 没有固定机制 | 每学期 1 个"两周小实验" | 产出 1 个能给别人看的东西 |
| 坚持学习新东西 | 养成页已有 6 个习惯，但不覆盖"新东西" | 规则是"不断"，不是"每天" | 连续打卡看养成页，断了当天重启 |

---

## 10 · 接下来一年最重要的优先级（砍到最核心的版本）

1. **现在就补**：数据结构与算法 · Linux/OS · Networking · Python/C++ · Git/测试/调试
2. **跟 Pigeon 同步**：Distributed Systems · Concurrency · Reliability · Security · Software Architecture
3. **跟未来科研同步**：Linear Algebra · Probability · Optimization · ML · DL · Transformer/LLM
4. **核心方向**：Agent architecture · Tool use · Planning · Memory · Evaluation · Capability selection · Multi-agent · Agent security · AI systems
5. **决定能否从工程师变成研究者**：Paper reading · Research question · Experimental design · Baseline · Ablation · Evaluation · Scientific writing

特别提醒：**不要等第四层全部学完才找老师**。掌握第一、二层的一部分、同时开始进第三层，就可以接触老师、参加科研见习——科研会反过来告诉你第三、四层究竟该学什么。

---

## 11 · 你现在在这儿

**2026-10-05（FA26 第 4 周）**

- 距 **research question 一页纸定稿（10/12）7 天**：候选池四条（工具/数据源自主选择 · 主动打扰时机 · 记忆路由 · 规划质量评估），先定一条；
- 距 **2027 春 ACM 校内补充选拔约 5 个月**：这 5 个月的算法投入是硬需求；
- 已发布：Cairn（2026-09-28，GitHub public + MIT，CI 9/9）；Pigeon 仍是进行中的工作流（口径见 §1.3.2）。
