// 模块：学习区（learning-hub）—— **自己的一页**（kind: view）。
//
// 为什么有这一页：`养成`页管"每天做没做"，`课程辅助`页管"这学期的课件"，
// 谁都不管**跨年份的知识树与学习路线**。这一页专门放长期框架。
//
// 设计三条：
//   1) 只读：不写库、不碰文件、不联网、不发通知；
//   2) 内容 = 纯数据 + 纯函数 `renderPage()`（方便单独 import 做测试）；
//   3) mount() 只做一件事：把标签切换接上。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

/** 「你现在在这儿」：会随学期推进而变，改这一处即可。 */
export const NOW = {
  date: '2026-10-05',
  line: 'FA26 第 4 周 · 距 research question 一页纸定稿（10/12）7 天 · 距 2027 春 ACM 校内补充选拔约 5 个月',
  note: '路线不是从零开始，也不是"把 CS 全学一遍"：以 Agent research 为中心，用项目反推基础。',
};

/** 第 1 层：知识树（7 层 + 贯穿的 Research Method）。 */
export const LAYERS = [
  { n: 1, name: 'CS 基础 · 数据结构与算法', why: 'ACM 与之后几乎所有 CS research 的入场券', is: 'Array / Linked List / Stack / Queue · Hash Table · Tree / Heap · Graph · BFS·DFS · 最短路 · DP · 贪心 · 排序 · 复杂度 · 递归', enough: '看到一个问题，能自己分析数据结构与复杂度，而不是先问 Agent' },
  { n: 2, name: 'Systems · OS / Networking / Distributed', why: 'Pigeon 已经把你拉进来了，缺的是原理', is: '进程·线程·IPC·文件系统·权限·调度·信号·生命周期·并发·锁·竞态；TCP/IP·HTTP·SMTP·IMAP·DNS·TLS·超时·重试；失败·幂等·一致性·容错·队列·事件驱动', enough: '能解释 Pigeon 每条重试/去重为什么这么设计，并指出哪里会重复、哪里会丢' },
  { n: 3, name: 'Software Architecture', why: 'Cairn 的 monolithic → package migration 就是典型案例', is: '接口与抽象 · API 设计 · 模块化 · 依赖倒置 · 适配器 · 事件驱动 · 插件架构 · 契约/schema · 版本 · 测试 · 可观测性 · 日志 · 配置管理', enough: '能回答：这个模块为什么存在？接口为什么这样设计？换一个实现会影响什么？' },
  { n: 4, name: 'AI / ML 基础', why: '真正进入 Agent research 的门槛', is: 'ML（监督/无监督·训练验证测试·损失·优化·梯度下降·过拟合·正则·评估）→ DL（神经网络·反向传播·CNN·RNN·Transformer·Attention·Embedding）→ LLM（Tokenization·预训练·指令微调·RLHF·上下文·KV cache·推理·Prompt·工具调用·结构化输出）→ Agent（Planning·Tool use·Memory·Reflection·ReAct·Multi-agent·Evaluation）', enough: '能解释 attention 为什么是 O(n²)、KV cache 省了什么；能读懂一篇 ML 论文的方法段' },
  { n: 5, name: 'Mathematics', why: '数学服务于理解 ML，不单独成为主线', is: 'Linear Algebra（向量·矩阵·特征值·特征向量·点积·范数·矩阵乘·投影）；Calculus（导数·偏导·梯度·链式法则·优化）；Probability（随机变量·分布·期望·方差·条件概率·Bayes·Markov）；Statistics（估计·假设检验·置信区间·回归·实验设计）', enough: '能手推反向传播的链式法则；能解释一个 metric 在估什么、误差从哪来' },
  { n: 6, name: 'Agent Research · 核心能力', why: '这一层才把你和"会调 API 的人"区分开', is: '不只问"怎么做 Agent"，还要问"为什么这样做"：capability selection policy、memory routing、打断时机、规划质量、agent evaluation、autonomous improvement', enough: '能把一个工程现象写成可验证问题（问题 → hypothesis → baseline → 实验 → 指标）' },
  { n: 7, name: 'Security', why: 'allowlist ≠ security：这是你亲手发现过的真实问题', is: 'Authentication · Authorization · Least privilege · Sandboxing · Capability-based security · Threat modeling · Prompt injection · Tool injection · Privilege escalation · Audit log · Secure execution · Trust boundaries', enough: '能画出 邮箱被盗 → 授权发件人 → Pigeon → 本地 Agent → 本机 的信任边界，并说清每道防线挡什么' },
  { n: 8, name: 'Research Method（贯穿全程）', why: '最容易忽视、却决定你能否从工程师变成研究者', is: 'Observation → Research Question → Hypothesis → Method → Baseline → Experiment → Evaluation → Analysis → Conclusion；读论文、找 gap、做 ablation、解释 negative result、写 proposal', enough: '完成一次闭环：读懂论文 → 复现核心实验 → 找到局限 → 提一个可验证小问题 → 设计实验 → 写 report' },
];

/** 第 2 层：能力诊断（14 个板块 + 暂时不需要）。 */
export const STATUS = {
  ok: { label: '已具备', cls: 'lh-ok' },
  proj: { label: '有项目经验 · 理论不足', cls: 'lh-proj' },
  none: { label: '完全欠缺', cls: 'lh-none' },
  later: { label: '暂时不需要', cls: 'lh-later' },
};

export const DIAGNOSIS = [
  { topic: 'CS 基础（C/C++/Python、Git、测试、调试）', status: 'proj', note: '能写能跑，靠 AI/vibe coding 完成，工程实践跑在理论前面' },
  { topic: 'Algorithms / 数据结构', status: 'none', note: 'ACM 选拔最直接的短板；也是后续一切的地基' },
  { topic: 'Operating Systems / Linux', status: 'proj', note: 'Pigeon 的常驻进程、心跳、托盘、计划任务已经用到，但没系统学过' },
  { topic: 'Networking', status: 'proj', note: 'IMAP/SMTP/TLS/timeout/retry 天天在用，原理没补' },
  { topic: 'Distributed Systems', status: 'proj', note: 'outbox / 去重 / 幂等 / 失败恢复都是现成素材' },
  { topic: 'Software Architecture', status: 'proj', note: 'monolithic → package migration、契约与语义漂移' },
  { topic: 'Mathematics', status: 'proj', note: 'MATH1860J 在修（逻辑·集合·序列与收敛·度量空间·极限·连续）；线代/概率/统计/优化待补' },
  { topic: 'Machine Learning', status: 'none', note: '还没系统学过监督/无监督/评估这套语言' },
  { topic: 'Deep Learning', status: 'none', note: '反向传播、CNN、Transformer 需要正式补' },
  { topic: 'LLM', status: 'proj', note: '会用模型与工具调用，但 pretraining / RLHF / KV cache 只停在名词' },
  { topic: 'AI Agents', status: 'proj', note: 'Cairn / Pigeon / Planner 是真实实验场，但缺 research 化表达' },
  { topic: 'AI Systems', status: 'proj', note: '推理、调度、评测基础设施还没碰' },
  { topic: 'Agent Security', status: 'proj', note: 'allowlist ≠ security 是真发现，缺 threat modeling 与 capability-based security 的系统语言' },
  { topic: 'Research Methodology', status: 'none', note: '最短板，也是从 vibe coder → researcher 的关键' },
];

export const NOT_NEEDED = [
  '编译原理 / 图形学 / 竞赛级高级算法（除非 ACM 选拔明确要）',
  '证明型数学分析（"AI 是否需要偏证明的数学分析"仍是公开问题，先不把主线押上去）',
  '凸优化（Boyd）与强化学习理论（等进入 RL / representation learning 再加）',
  '大型分布式系统的工业级调优（先把 Pigeon 这一层的概念吃透）',
];

/** 第 3 层：学习路线（按依赖 + 项目 + 科研目标排序，不按大学课程顺序）。 */
export const PHASES = [
  {
    tag: '阶段 0', when: '现在 → 2027 春（ACM 校内补充选拔前）', title: '补算法与系统地基',
    learn: '数据结构与算法（数组/链表/栈队列/哈希/树堆/图/BFS·DFS/最短路/DP/贪心/排序/复杂度/递归）；Linux 与 OS 基础（进程/线程/IPC/文件系统/权限/调度/信号/并发/锁/竞态）；Python 工程化 + C/C++ 基础；Git / 测试 / 调试',
    why: '这是唯一带硬 deadline 的一段（准备期约 5 个月），也是后面所有阶段的地基',
    enough: '中等题能自己选数据结构、估复杂度、写出可读实现；能读懂 Pigeon 的进程/线程/信号代码并解释为什么；看报错栈能自己定位',
    map: 'Pigeon 的 pythonw 常驻、心跳、托盘、任务计划；Planner 的定时任务与采集',
    impact: 'ACM 选拔；之后所有 CS research 的入场券；读系统代码不再靠猜',
    next: '阶段 1 的网络与分布式直接依赖它（复杂度、并发、进程）',
  },
  {
    tag: '阶段 1', when: '大一上 → 寒假，与 Pigeon 同步', title: '把 Pigeon 变成 Systems 实验场',
    learn: 'Networking（TCP/IP·HTTP·SMTP·IMAP·DNS·TLS·请求响应·连接与超时·重试）；Distributed Systems（失败·重试·超时·重复请求·幂等·exactly-once vs at-least-once·状态同步·一致性·容错·队列·事件驱动）；Concurrency & Reliability；Software Architecture（接口/抽象·API 设计·模块化·依赖倒置·适配器·契约与 schema·版本·测试·可观测性·日志·配置）',
    why: '这些问题你正在 Pigeon 里真实遇到——先有困惑再学理论，吸收率最高',
    enough: '能解释 Pigeon 每条重试/超时/去重为什么这样设计，能指出哪里会重复执行、哪里会丢；能画出失败路径与恢复路径',
    map: 'IMAP/SMTP、Message-ID 去重、outbox、heartbeat、auth.json 备份恢复、pigeon-mail.v1 契约、pigeon.py 的包化迁移',
    impact: '暑研面试"你做过什么系统、为什么这样设计"的可讲内容；Agent 评测也需要这套系统思维',
    next: '阶段 3 的 AI Systems 与 Agent 评测需要容错/一致性概念',
  },
  {
    tag: '阶段 2', when: '大一下起，与科研同步', title: '补数学与 ML / DL / LLM',
    learn: 'Linear Algebra → Calculus（偏导/梯度/链式法则/优化）→ Probability → Statistics（估计/假设检验/置信区间/回归/实验设计）→ ML → DL → Transformer / LLM',
    why: '没有这层，Agent research 只能停在"调 API"；数学服务于理解 ML，不单独成为主线',
    enough: '能手推反向传播的链式法则；能解释 attention 的 O(n²) 与 KV cache 省了什么；能读懂一篇 ML 论文的方法段',
    map: 'Planner 的语义兜底、LLM 调用、优先级排序与 digest',
    impact: '暑研与 PhD 申请的核心门槛；2+2 课程的对接',
    next: 'prerequisite = 阶段 1 的工程直觉 + 阶段 0 的复杂度分析',
  },
  {
    tag: '阶段 3', when: '大二起', title: '进入核心方向：Agent / AI Systems / Agent Security',
    learn: 'Agent（Planning·Tool use·Memory·Reflection·ReAct·Multi-agent·Agent evaluation·Capability selection·Tool selection·Agent environment·Autonomous improvement）；AI Systems（推理·KV cache·调度·批处理·评测基础设施）；Agent Security（Authentication/Authorization·Least privilege·Sandboxing·Capability-based security·Threat modeling·Prompt injection·Tool injection·Privilege escalation·Audit log·Secure execution·Trust boundaries）',
    why: '这是你要形成的不可替代性；Cairn / Pigeon 已经是这个方向的现成实验场',
    enough: '能把一个现象写成可验证问题：从 100 个 capability 里选 5 个 → 能否学习 selection policy → 能否从执行结果更新 → 如何评价它优于人工设计',
    map: 'Cairn 的 capability selection / 记忆路由 / 打扰时机 / 规划质量；Pigeon 的 allowlist ≠ security 信任链',
    impact: '论文与暑研选题；PhD 的 research identity',
    next: '依赖阶段 2 的 ML/LLM 与阶段 1 的系统概念',
  },
  {
    tag: '阶段 4', when: '大二下 → 大三', title: '研究者转型（Research Method）',
    learn: 'Research question · Hypothesis · Baseline · Dataset / environment · Experiment · Ablation · Evaluation metric · Reproducibility · Error analysis · Literature review · Paper writing',
    why: '从"我觉得这个 idea 很酷"变成"这是一个已有工作没有解决的问题"',
    enough: '完成一次闭环：读懂一篇 Agent/AI Systems 论文 → 复现核心实验 → 找到局限 → 提出一个可验证的小问题 → 设计实验 → 实现 prototype → 分析结果 → 写成 research report',
    map: '§1.3.1 的 RQ-A / RQ-B 与四条行为线；10/12 前先定一条',
    impact: '论文、推荐信、SOP',
    next: '之后是持续迭代，不再有"学完"这一步',
  },
];

export const THREAD = {
  tag: '贯穿', when: '一直', title: '非技术线与英语（不并入技术路线，但同样算学习）',
  learn: '视频剪辑(MAD) · 电吉他 · 羽毛球 · 新事物探索 · 坚持学习 · 英语（TOEFL 已考 103，之后未持续训练，需确认是否恢复）',
  why: '核心矛盾不是"要不要学"，是既想成为研究者、又不想把四年过成另一个高三；这条线是可持续四年的另一半',
  enough: '每项只要求一个最小闭环，不求同时推进',
  map: '养成页的习惯与连续天数；Planner 里程碑；MAD 项目文件夹',
  impact: '生活可持续性；也是面试里"你是个什么样的人"的真实材料',
  next: '与阶段 0～4 并行，不占用科研硬块',
};

/** 第 4 层：资料地图（每主题最多 1 主教材 + 1 辅助 + 2~5 篇论文）。 */
export const RESOURCES = [
  { topic: '数据结构与算法', main: 'Competitive Programmer’s Handbook（Antti Laaksonen，免费 PDF）', aux: 'UC Berkeley CS61B（Data Structures）', papers: ['不需要论文；用 CSES Problem Set 与 Codeforces Div.3/4 练手'] },
  { topic: 'Operating Systems / Linux', main: 'OSTEP《Operating Systems: Three Easy Pieces》（Arpaci-Dusseau，免费）', aux: 'MIT 6.1810（原 6.S081）xv6 labs', papers: ['The UNIX Time-Sharing System（Ritchie & Thompson, CACM 1974）'] },
  { topic: 'Networking', main: 'Kurose & Ross《Computer Networking: A Top-Down Approach》', aux: 'Beej’s Guide to Network Programming', papers: ['RFC 5321（SMTP）', 'RFC 3501（IMAP4rev1）', 'RFC 8446（TLS 1.3）', 'A Protocol for Packet Network Intercommunication（Cerf & Kahn, 1974）'] },
  { topic: 'Distributed Systems', main: 'MIT 6.5840（原 6.824）Distributed Systems', aux: 'Kleppmann《Designing Data-Intensive Applications》', papers: ['Time, Clocks, and the Ordering of Events（Lamport, 1978）', 'MapReduce（Dean & Ghemawat, 2004）', 'Dynamo（DeCandia et al., 2007）', 'In Search of an Understandable Consensus Algorithm / Raft（Ongaro & Ousterhout, 2014）'] },
  { topic: 'Software Architecture', main: 'Ousterhout《A Philosophy of Software Design》', aux: 'Fowler《Refactoring》', papers: ['On the Criteria To Be Used in Decomposing Systems into Modules（Parnas, 1972）', 'Out of the Tar Pit（Moseley & Marks, 2006）'] },
  { topic: 'Mathematics', main: 'MIT 18.06 Linear Algebra（Strang）', aux: 'Blitzstein & Hwang《Introduction to Probability》（Stat 110）', papers: ['用 MATH1860J 现成教材（Abbott / Spivak / Tao）；统计用 Wasserman《All of Statistics》', '优化留到阶段 2 后期再看 Boyd《Convex Optimization》'] },
  { topic: 'Machine Learning', main: 'Stanford CS229', aux: 'Bishop《Pattern Recognition and Machine Learning》', papers: ['A Few Useful Things to Know About Machine Learning（Domingos, 2012）'] },
  { topic: 'Deep Learning', main: 'Goodfellow / Bengio / Courville《Deep Learning》', aux: 'Stanford CS231n 或 d2l.ai', papers: ['ImageNet Classification with Deep CNNs（Krizhevsky et al., 2012）', 'Deep Residual Learning（He et al., 2015）'] },
  { topic: 'Transformer / LLM', main: 'Stanford CS336：Language Modeling from Scratch', aux: 'Karpathy《Let’s build GPT》+《The Illustrated Transformer》', papers: ['Attention Is All You Need（Vaswani et al., 2017）', 'Language Models are Few-Shot Learners / GPT-3（Brown et al., 2020）', 'Training language models to follow instructions / InstructGPT（Ouyang et al., 2022）'] },
  { topic: 'AI Agents', main: '暂无成熟教材 → 以论文为主', aux: 'Lilian Weng《LLM Powered Autonomous Agents》', papers: ['ReAct（Yao et al., 2022）', 'Toolformer（Schick et al., 2023）', 'Reflexion（Shinn et al., 2023）', 'Generative Agents（Park et al., 2023）', 'AgentBench / SWE-bench（评测方向）'] },
  { topic: 'AI Systems', main: 'Stanford CS336（与 LLM 同源，偏系统那半）', aux: '各推理框架官方文档（vLLM 等）', papers: ['Megatron-LM（Shoeybi et al., 2019）', 'FlashAttention（Dao et al., 2022）', 'Efficiently Scaling Transformer Inference（Pope et al., 2022）', 'PagedAttention / vLLM（Kwon et al., 2023）'] },
  { topic: 'Agent Security', main: 'OWASP Top 10 for LLM Applications', aux: 'NIST AI 100-2（Adversarial Machine Learning taxonomy）', papers: ['Not what you’ve signed up for: Indirect Prompt Injection（Greshake et al., 2023）', 'Universal and Transferable Adversarial Attacks on Aligned Language Models（Zou et al., 2023）', 'The Instruction Hierarchy（Wallace et al., 2024）'] },
  { topic: 'Research Methodology', main: 'Booth 等《The Craft of Research》', aux: 'Simon Peyton Jones《How to Write a Great Research Paper》（讲座）', papers: ['The Science of Scientific Writing（Gopen & Swan, 1990）'] },
];

/** 第 5 层：项目驱动学习（知识 ↔ 你已有的系统）。 */
export const PROJECT_MAP = [
  { know: 'Process / Thread / 信号', proj: 'Pigeon execution model：pythonw 常驻、心跳超时重启、托盘、计划任务' },
  { know: 'Networking', proj: 'IMAP/SMTP 失败分析：连接超时、重试、TLS、发信受限' },
  { know: 'Distributed Systems', proj: 'retry / idempotency / outbox：重复请求与丢信的边界' },
  { know: 'Security', proj: 'allowlist + Agent execution boundary：邮箱被盗后还能不能执行' },
  { know: 'Agent', proj: 'Cairn capability selection：从一堆 capability 里选哪几个' },
  { know: 'Research Methodology', proj: '把 Cairn / Pigeon 的工程问题改写成 research question' },
  { know: 'Software Architecture', proj: '契约 source-item.v1 → signal.v1 → action.v1；新增能力不动核心' },
  { know: 'Mathematics / ML', proj: 'Planner 的语义兜底与优先级排序：规则 vs LLM vs 混合' },
];

/** 第 6 层：每周计划（必须 / 应该 / 以后）。 */
export const WEEKLY = {
  must: [
    '算法：每周 2 个专题 + 8~12 道题（对应 2027 春 ACM 选拔准备）',
    '课程当天清：ENGR1010J / MATH1860J / STAT1000J（数学当天清已是既有习惯）',
    '科研三块（Planner 已排）：周一 09:30–11:30 深度块 / 周六 09:00–11:30 收口块 / 周日 17:00–20:00 复盘块，共 7.5 h',
  ],
  should: [
    '文献精读 ≥1 篇/周（养成页已有习惯）',
    'research log ≥3 次/周（养成页已有习惯）',
    '英语 30 分钟/天（养成页已有习惯）',
    '把本周遇到的一个系统问题写成 10 行：现象 → 猜测 → 验证 → 结论',
  ],
  later: [
    '凸优化、强化学习理论、证明型数学分析 —— 等方向收敛再加，现在不用学',
    '编译原理 / 图形学 / 竞赛级高级算法 —— 除非 ACM 选拔明确要求',
    'AI Systems 的工程调优 —— 阶段 3 之前的"看"即可，不动手',
  ],
};

/** 学习循环（不是清单，是环）。 */
export const LOOP = ['做项目', '遇到问题', '不懂为什么', '学基础', '回项目验证', '写下理解', '发现更深问题', '阅读论文', '找 research gap', '做实验', '得到新问题', '再学习'];

/** 三个可复用 Prompt。 */
export const PROMPTS = [
  {
    id: 'tutor', title: '① 学习导师 Prompt', use: '让它先诊断，再规划，再教学，再考试——不要一次性要"大而全课程"',
    text: [
      '你现在是我的长期 CS + AI Agent 科研导师。',
      '',
      '我的背景：上海交通大学浦江国际学院 CS 本科生；长期目标顶尖 CS PhD，方向倾向 AI Agent / LLM / AI Systems / Agent Security / Personal AI。已独立完成 Cairn（模块化个人信息与能力组合平台）与 Pigeon（Email 连接远程意图与本地 Agent 的执行桥，涉及 IMAP/SMTP、Agent execution、sandbox、权限、retry、timeout、outbox、heartbeat、fault tolerance）。软件实现能力较强，但很多系统由 AI/vibe coding 完成，工程实践领先于理论理解。计划参加 ACM 班选拔，争取大一/大二进正式科研组，未来考虑 SJTU → Michigan 2+2 → 暑研 → 顶尖 CS PhD。',
      '',
      '按八个阶段工作：① 能力诊断（把知识分成 CS fundamentals / Algorithms / OS / Networking / Distributed Systems / Software Architecture / Mathematics / ML / DL / LLM / AI Agents / AI Systems / Agent Security / Research Methodology，并对每项标"已具备 / 有项目经验但理论不足 / 完全欠缺 / 暂时不需要"）；② 建立按依赖+项目+科研目标排序的路线；③ 每个主题最多 1 主教材 + 1 辅助 + 2~5 篇论文，优先大学课程/经典教材/官方文档/lecture/原始论文；④ 项目驱动（映射到 Cairn/Pigeon）；⑤ 每周计划（必须掌握 / 应该理解 / 可以以后学）；⑥ 主动学习（先让我解释概念，再给小问题，再让我分析真实代码，最后给没见过的问题）；⑦ 知识检验（概念 / 推理 / 代码与系统分析 / 新问题迁移四类，不只选择题；答错要判断是概念错、推理错、数学基础错还是工程经验不足，指出 prerequisite，给最小补课，再重测）；⑧ 科研训练（读论文、找 gap、提 hypothesis、设计 baseline/ablation、选 metric、解释 negative result、写 proposal）。',
      '',
      '当我问一个知识点时，先判断它在学习树的位置，并告诉我：为什么现在值得学 / 学到什么程度 / 不学会影响什么。如果当前不重要，直接说"现在不用学"。不要默认我是零基础，也不要因为我会写代码就默认我懂理论。',
    ].join('\n'),
  },
  {
    id: 'examiner', title: '② 能力考官 Prompt', use: '定期让另一个 Agent 当考官——你的风险不是"学不会"，是"以为学会了"',
    text: [
      '你现在是我的 CS / AI Agent 科研能力考官。不要教我知识，负责判断我到底会不会。',
      '',
      '我的当前学习主题是：【填写主题】',
      '我的目标是：【填写目标，例如：理解 Distributed Systems 中 retry、idempotency、outbox 的关系】',
      '',
      '请设计一次 30~60 分钟的能力测试，必须包含：① 基础概念（用自己的话解释关键概念）；② 对比与推理（给两个容易混淆的方案，解释差异、trade-off、适用场景）；③ 工程问题（真实系统问题，分析原因并给方案）；④ 代码/架构分析（给代码、伪代码或架构，指出问题）；⑤ 未见过的问题（不能靠背答案，测迁移）；⑥ 科研问题（说明是否有 research value、如何建 baseline、如何设计实验、如何评价结果）。',
      '',
      '评分分别评价 Conceptual understanding / Problem solving / Implementation understanding / System thinking / Research thinking。不要因为答案最终正确就直接判定我掌握。重点检查：是否真正理解因果关系、能否解释"为什么"、能否迁移到陌生问题、能否识别自己的假设、能否指出 solution 的 trade-off。',
      '',
      '最后输出：A 已掌握 / B 表面理解 / C 明显缺陷 / D prerequisite 缺口 / E 下一步最值得学的 3 个主题。如果我水平不足，不要继续加学习材料，先让我补 prerequisite。',
    ].join('\n'),
  },
  {
    id: 'map', title: '③ 课程设计 + 文献地图 Prompt', use: '不要让一个 Agent 既当老师又当推荐算法；先建依赖关系，再给最小路径',
    text: [
      '我准备进入以下研究方向：【例如：Agent capability selection / tool-use / agent security】',
      '',
      '请不要直接给我一个长书单。先建立这个领域的知识地图：① 最核心的问题是什么？② 需要哪些 prerequisite？③ 有哪些主要 research directions？④ 每个方向最经典的 3~5 篇论文？⑤ 哪些是历史基础、哪些代表当前前沿？⑥ 每篇论文我该重点看什么？⑦ 如果我是本科生，哪些内容可以暂时跳过？⑧ 哪些论文适合复现？⑨ 哪些问题仍然开放？⑩ 我的 Cairn / Pigeon 经验哪些能转化成研究问题？',
      '',
      '然后给我一条最小学习路径：Prerequisite → Foundational Paper → Modern Paper → Reproduction → Research Question。不要追求资料数量，要追求知识之间的依赖关系。如果某个资料已经过时，明确说明。如果你无法确认论文/课程是否真实存在，不要编造。',
    ].join('\n'),
  },
];

/** 非技术线：同样是"学习内容"，用同一套最小闭环要求。 */
export const NON_TECH = [
  { name: '视频剪辑（MAD）', now: 'AE / PR 已装，「新项目MAD」7 个文件夹已补齐，groovy MAD 议题已定（§3.7）', goal: '每学期 5~6 个里，先只要求跑通 1 个 30 秒小样（milestone 10/05）', closed: '四层结构各一次 + 8 拍不切 + 迟拍一致' },
  { name: '电吉他', now: '完全零基础；正式课 10/11 开始', goal: '先上一节体验课 + 至少两周每天摸琴，再决定买琴；不买"琴+音箱+配件"套餐', closed: '两周后能完整弹出一段和弦进行（能录音给自己听）' },
  { name: '羽毛球', now: '每周 2~3 次（§3.5 大一理想节奏）', goal: '把它当"恢复"而不是任务；和 23:30 前睡一起，构成能撑四年的身体基础', closed: '一周打满 2 次即为达成，不追强度' },
  { name: '新事物探索', now: '目前没有固定机制，容易变成"想起来才做"', goal: '每学期 1 个"两周小实验"：一个没碰过的东西，两周内做出 1 个可展示结果', closed: '产出 1 个能给别人看的东西（录屏/短文/作品）' },
  { name: '坚持学习新东西', now: '养成页已有 6 个习惯（锻炼/英语/数学/睡眠/文献/research log），但没有覆盖"新东西"', goal: '用养成页的 target + 连续天数，规则是"不断"，不是"每天"', closed: '连续打卡看养成页；断了就当天重启，不追讨' },
];

const TABS = [
  { id: 'tree', name: '知识树', ico: '🌳' },
  { id: 'diag', name: '能力诊断', ico: '🩺' },
  { id: 'route', name: '学习路线', ico: '🗺' },
  { id: 'res', name: '资料地图', ico: '📚' },
  { id: 'project', name: '项目驱动', ico: '🔗' },
  { id: 'weekly', name: '每周计划', ico: '📅' },
  { id: 'loop', name: '学习循环 · 检验', ico: '🔁' },
  { id: 'prompts', name: '三个 Prompt', ico: '✍️' },
  { id: 'life', name: '非技术线', ico: '🏸' },
];

const chip = (s) => `<span class="lh-chip ${s.cls}">${esc(s.label)}</span>`;

function renderTree() {
  return `
    <div class="lh-note">${esc(NOW.note)}</div>
    <div class="lh-tree">
      ${LAYERS.map((l) => `
        <div class="lh-layer">
          <div class="lh-layer-n">L${l.n}</div>
          <div class="lh-layer-body">
            <div class="lh-layer-name">${esc(l.name)}</div>
            <div class="lh-dim"><b>为什么</b>：${esc(l.why)}</div>
            <div class="lh-dim"><b>学什么</b>：${esc(l.is)}</div>
            <div class="lh-dim"><b>够用的标准</b>：${esc(l.enough)}</div>
          </div>
        </div>`).join('')}
    </div>
    <div class="lh-note">${esc(NOW.date)} · ${esc(NOW.line)}</div>`;
}

function renderDiag() {
  return `
    <div class="lh-note">判定原则：<b>有项目经验 ≠ 理论掌握</b>。斜体说明只写事实，不替你下结论。</div>
    <div class="lh-rows">
      ${DIAGNOSIS.map((d) => `
        <div class="lh-row">
          <div class="lh-row-t">${esc(d.topic)}</div>
          <div class="lh-row-s">${chip(STATUS[d.status])}</div>
          <div class="lh-row-n">${esc(d.note)}</div>
        </div>`).join('')}
    </div>
    <div class="lh-sub">现在不用学（写了"暂时不需要"，是为了把有限时间留给上面的）</div>
    <ul class="lh-list">${NOT_NEEDED.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

function renderRoute() {
  const card = (p) => `
    <div class="lh-phase">
      <div class="lh-phase-head"><span class="lh-tag">${esc(p.tag)}</span><b>${esc(p.title)}</b><span class="lh-dim">${esc(p.when)}</span></div>
      <div class="lh-dim"><b>学什么</b>：${esc(p.learn)}</div>
      <div class="lh-dim"><b>为什么现在学</b>：${esc(p.why)}</div>
      <div class="lh-dim"><b>学到什么程度就够</b>：${esc(p.enough)}</div>
      <div class="lh-dim"><b>对应 Cairn / Pigeon</b>：${esc(p.map)}</div>
      <div class="lh-dim"><b>对 ACM / 2+2 / 暑研 / Agent research</b>：${esc(p.impact)}</div>
      <div class="lh-dim"><b>下一阶段 prerequisite</b>：${esc(p.next)}</div>
    </div>`;
  return `<div class="lh-note">排序原则：按<b>依赖关系 + 你的实际项目 + 科研目标</b>，不按传统大学课程顺序。阶段可以并行，但不要同时推进过多主题。</div>
    ${PHASES.map(card).join('')}
    ${card(THREAD)}`;
}

function renderRes() {
  return `
    <div class="lh-note">每个主题最多 1 个主教材 + 1 个辅助 + 2~5 篇关键论文。优先大学课程 / 经典教材 / 官方文档 / lecture / 原始论文。</div>
    <div class="lh-note">凡我不能确认存在的东西，这里就不写——所以序号之间会有空缺，那是"先留着，别堆资源"。</div>
    ${RESOURCES.map((r) => `
      <div class="lh-res">
        <div class="lh-res-topic">${esc(r.topic)}</div>
        <div class="lh-dim"><b>主</b>：${esc(r.main)}</div>
        <div class="lh-dim"><b>辅</b>：${esc(r.aux)}</div>
        ${r.papers.map((p) => `<div class="lh-dim">📄 ${esc(p)}</div>`).join('')}
      </div>`).join('')}`;
}

function renderProject() {
  return `
    <div class="lh-note">让项目暴露问题 → 学知识 → 回项目验证 → 抽象成研究问题。下面每一条都是你已经在做的。</div>
    <table class="lh-table">
      <thead><tr><th>知识</th><th>落到哪个真实问题</th></tr></thead>
      <tbody>${PROJECT_MAP.map((p) => `<tr><td>${esc(p.know)}</td><td>${esc(p.proj)}</td></tr>`).join('')}</tbody>
    </table>`;
}

function renderWeekly() {
  const block = (title, cls, items) => `
    <div class="lh-week">
      <div class="lh-week-t ${cls}">${esc(title)}</div>
      <ul class="lh-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>`;
  return `<div class="lh-note">每周只安排有限内容。不要让我同时推进过多主题——所以每周计划分三档。</div>
    ${block('必须掌握', 'must', WEEKLY.must)}
    ${block('应该理解', 'should', WEEKLY.should)}
    ${block('可以以后学', 'later', WEEKLY.later)}`;
}

function renderLoop() {
  return `
    <div class="lh-note">最终要形成的不是一张清单，而是一个环：</div>
    <div class="lh-loop">${LOOP.map((x, i) => `${i ? '<span class="lh-arrow">→</span>' : ''}<span class="lh-step">${esc(x)}</span>`).join('')}</div>
    <div class="lh-note" style="margin-top:10px">你已经不是"做 100 道 LeetCode 才知道 CS 是什么"的学生了——你有真实系统当实验场。</div>
    <div class="lh-sub">主动学习（每学完一个主题）</div>
    <ol class="lh-list">
      <li>先让我用自己的话解释概念</li>
      <li>再给我一个小问题</li>
      <li>再让我分析真实代码 / 系统</li>
      <li>最后给一个新的、没见过的问题</li>
    </ol>
    <div class="lh-note">如果我只会背定义而不会应用，直接指出来。</div>
    <div class="lh-sub">知识检验（四类，不只选择题）</div>
    <div class="lh-know">A 概念理解 · B 推理题 · C 代码/系统分析 · D 新问题迁移</div>
    <div class="lh-note">答错时：判断是概念错误 / 推理错误 / 数学基础错误 / 工程经验不足 → 指出 prerequisite → 给最小补课 → 再重测。</div>
    <div class="lh-sub">科研训练（掌握一定基础后）</div>
    <div class="lh-dim">读论文 · 找 research gap · 提 hypothesis · 设计 baseline · 设计 ablation · 选 evaluation metric · 解释 negative result · 写 research proposal。最终目标是完成：读懂论文 → 复现核心实验 → 找到局限 → 提一个可验证小问题 → 设计实验 → 实现 prototype → 分析结果 → 写成 research report。</div>`;
}

function renderPrompts() {
  return `
    <div class="lh-note">三个 Prompt 分工不同：<b>教</b>、<b>考</b>、<b>画地图</b>。不要让一个 Agent 既当老师又当推荐算法。</div>
    ${PROMPTS.map((p) => `
      <div class="lh-prompt">
        <div class="lh-prompt-head"><b>${esc(p.title)}</b>
          <button class="btn small" data-lh-copy="${esc(p.id)}">复制</button>
        </div>
        <div class="lh-dim">${esc(p.use)}</div>
        <pre class="lh-pre" id="lh-p-${esc(p.id)}">${esc(p.text)}</pre>
      </div>`).join('')}
    <div class="lh-note">学会一个主题后，把标题里的【填写主题】换成它，直接丢给能力考官 Prompt。</div>`;
}

function renderLife() {
  return `
    <div class="lh-note">这一线和阶段 0～4 并行。每项只要求一个最小闭环，不求同时推进——这也是"不想把大学过成另一个高三"的落地方式。</div>
    ${NON_TECH.map((x) => `
      <div class="lh-life">
        <div class="lh-life-t">${esc(x.name)}</div>
        <div class="lh-dim"><b>现状</b>：${esc(x.now)}</div>
        <div class="lh-dim"><b>目标</b>：${esc(x.goal)}</div>
        <div class="lh-dim"><b>最小闭环</b>：${esc(x.closed)}</div>
      </div>`).join('')}`;
}

/** 纯函数：给状态，返回整页 HTML（方便测试与单独渲染）。 */
export function renderPage(state = {}) {
  const tab = TABS.some((t) => t.id === state.tab) ? state.tab : 'tree';
  const body = {
    tree: renderTree, diag: renderDiag, route: renderRoute, res: renderRes,
    project: renderProject, weekly: renderWeekly, loop: renderLoop,
    prompts: renderPrompts, life: renderLife,
  }[tab]();
  return `
  <style>
    .lh-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 12px}
    .lh-tab{border:1px solid var(--line,#2a2a2a);background:transparent;color:inherit;border-radius:999px;padding:5px 12px;cursor:pointer;font-size:13px}
    .lh-tab.active{background:#e60012;border-color:#e60012;color:#fff}
    .lh-note{font-size:13px;opacity:.82;margin:6px 0}
    .lh-sub{font-weight:700;margin:14px 0 6px}
    .lh-dim{font-size:13px;opacity:.86;margin:3px 0;line-height:1.65}
    .lh-chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;white-space:nowrap}
    .lh-ok{background:#123d24;color:#7ee2a8}.lh-proj{background:#3d3410;color:#ffd166}
    .lh-none{background:#3d1414;color:#ff9b9b}.lh-later{background:#22262c;color:#aab}
    .lh-layer{display:flex;gap:10px;padding:10px 0;border-bottom:1px dashed var(--line,#2a2a2a)}
    .lh-layer-n{font-weight:800;color:#e60012;min-width:34px}
    .lh-layer-name{font-weight:700;margin-bottom:4px}
    .lh-row{display:grid;grid-template-columns:1.3fr 150px 2fr;gap:8px;align-items:start;padding:8px 0;border-bottom:1px dashed var(--line,#2a2a2a)}
    .lh-row-t{font-weight:600}.lh-row-n{font-size:13px;opacity:.84;line-height:1.6}
    .lh-phase{border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:10px 12px;margin:10px 0}
    .lh-phase-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
    .lh-tag{background:#e60012;color:#fff;border-radius:6px;padding:1px 8px;font-size:12px}
    .lh-res{border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:9px 12px;margin:8px 0}
    .lh-res-topic{font-weight:700;margin-bottom:4px}
    .lh-table{width:100%;border-collapse:collapse;font-size:13px}
    .lh-table th,.lh-table td{border:1px solid var(--line,#2a2a2a);padding:7px 9px;text-align:left;vertical-align:top}
    .lh-week{border-left:3px solid var(--line,#2a2a2a);padding-left:10px;margin:10px 0}
    .lh-week-t{font-weight:700}.lh-week-t.must{color:#ff6b6b}.lh-week-t.should{color:#ffd166}.lh-week-t.later{color:#8ab4f8}
    .lh-list{margin:4px 0 4px 18px;font-size:13px;line-height:1.75}
    .lh-loop{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}
    .lh-step{background:var(--line,#2a2a2a);border-radius:6px;padding:3px 8px}
    .lh-arrow{opacity:.5}
    .lh-know{font-size:13px;opacity:.9}
    .lh-prompt{border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:10px 12px;margin:10px 0}
    .lh-prompt-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
    .lh-pre{white-space:pre-wrap;font-size:12.5px;line-height:1.6;max-height:340px;overflow:auto;background:rgba(127,127,127,.08);border-radius:8px;padding:10px;margin:8px 0 0}
    .lh-life{border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:9px 12px;margin:8px 0}
    .lh-life-t{font-weight:700;margin-bottom:4px}
  </style>
  <div class="card">
    <div class="flex" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">🧭 学习区 · 以 Agent research 为中心</h3>
      <a class="btn small" href="/docs/LEARNING_FRAMEWORK.md" target="_blank" rel="noopener">📄 打开长文版</a>
    </div>
    <div class="lh-dim" style="margin-top:6px">${esc(NOW.date)} · ${esc(NOW.line)}</div>
    <div class="lh-tabs" style="margin-top:10px">
      ${TABS.map((t) => `<button class="lh-tab ${t.id === tab ? 'active' : ''}" data-lh-tab="${esc(t.id)}">${esc(t.ico)} ${esc(t.name)}</button>`).join('')}
    </div>
    <div id="lh-body">${body}</div>
  </div>`;
}

/** 挂载：只做标签切换与复制按钮。 */
export async function mount(el, ctx = {}) {
  const { toast = () => {} } = ctx;
  let tab = 'tree';
  const draw = () => {
    el.innerHTML = renderPage({ tab });
    el.querySelectorAll('[data-lh-tab]').forEach((b) => {
      b.onclick = () => { tab = b.dataset.lhTab; draw(); };
    });
    el.querySelectorAll('[data-lh-copy]').forEach((b) => {
      b.onclick = async () => {
        const p = PROMPTS.find((x) => x.id === b.dataset.lhCopy);
        if (!p) return;
        try { await navigator.clipboard.writeText(p.text); toast('已复制到剪贴板', 'green'); }
        catch { toast('复制失败：可以手动选中下面的文本', 'red'); }
      };
    });
  };
  draw();
}
