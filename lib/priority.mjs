// priority.mjs —— 重要性引擎：按「你的未来规划」给收集到的信息排优先级
//
// 解决的问题（用户原话）：
//   "根据个人未来规划与搜集信息的具体内容给出重要信息的推送"
//
// 和已有的 lib/relevance.mjs 是**两件事，不冲突**：
//   * relevance 回答「这条跟我有关吗」→ 决定**要不要**打扰你（去噪）；
//   * priority  回答「这条对我多重要、有多急」→ 决定**先看哪条**（排序 + 推送强度）。
//   两者都会给出 reasons（为什么），都能解释，都不联网。
//
// 「你的未来规划」由四样东西拼成（全是你本机已有的数据，不需要额外填表）：
//   1) **自己写的规划**（可选，`data` 里的 goals 文本，比如"11 月要考托福"）
//   2) **里程碑**（milestones：考试/截止/目标 + 日期）
//   3) **校历**（academic：学期起止、考试周）
//   4) **未来 N 天的日程与任务**（events / tasks）
// 从这四样里抽出"关键词"（规划词、课程代码、考试名、事件名……），
// 再拿新来的信息去比对：命中得越多、越急，重要性越高。
//
// 设计三原则（和 relevance 保持一致）：
//   1) **可解释**：每条都给 reasons，界面能回答"为什么它重要"；
//   2) **纯函数**：不碰数据库、不联网、不读时钟以外的外部状态 → 好测试；
//   3) **不加解释不排序**：没有理由的加分一律不加（避免变成黑盒）。

import { dueMs, dueDayKey } from './duedate.mjs';

export const PRIORITY_VERSION = 'priority.v1';

/** 分档阈值：>= high 判"重要"、>= normal 判"一般"、其余"低"。 */
export const BANDS = { high: 70, normal: 45 };

/** 默认看多远（天）。 */
export const HORIZON_DAYS = 14;

export const EMPTY_GOALS = Object.freeze({ schema: 'goals.v1', goals: [], updated_at: 0 });

/** 时区无关的"本地日期键"，和界面一致（YYYY-MM-DD）。 */
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const DAY = 86400000;

/** 把"任意来源的一天"统一成毫秒：纯日期按当天 23:59（对 DDL 才合理）。 */
const whenMs = (v) => dueMs(v);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------- 未来规划

/** 规划文本的整理（一行一条，去掉空行与重复）。 */
export function normalizeGoals(raw = {}) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(g.goals) ? g.goals : [];
  const cleaned = [...new Set(list.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 40);
  return {
    schema: 'goals.v1',
    goals: cleaned,
    updated_at: Number.isFinite(g.updated_at) ? g.updated_at : 0,
  };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'you', 'your', 'are', 'was',
  'to', 'of', 'in', 'on', 'at', 'is', 'it', 'be', 'as', 'by', 'or', 'an', 'no', 'if',
  'my', 'me', 'we', 'us', 'do', 'so', 'up', 'out', 'ai', 'id', 're', 'all', 'new',
  '关于', '以及', '我们', '你的', '我的', '这个', '一个', '需要', '可以', '如果', '因为',
]);

/**
 * 从一段话里抽出"可以拿去比对"的词。
 * 中文没有空格，所以：课程代码整段认；英文按词认；中文按标点切块，
 * 块 ≥3 字时再补上相邻两字组合（"实验报告" → 实验/验报/报告），保证召回。
 */
export function termsFromText(text, { max = 24 } = {}) {
  const s = String(text || '');
  const out = new Set();
  // 课程代码：ENGR1010J / MATH1860J 这种
  for (const m of s.matchAll(/\b[A-Z]{2,5}\d{3,4}[A-Z]?\b/g)) out.add(m[0].toUpperCase());
  // 英文/数字词（≥3 个字母：两个字母的词大多是 to/of/ai 这种噪音）
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9.+#-]{2,}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP_WORDS.has(w)) out.add(w);
  }
  // 中文块
  for (const chunk of s.split(/[^\u4e00-\u9fff]+/)) {
    const t = chunk.trim();
    if (t.length < 2) continue;
    if (t.length <= 6) { out.add(t); continue; }
    out.add(t.slice(0, 6));                       // 长句取前 6 字当特征
    for (let i = 0; i + 1 < t.length && i < 12; i += 1) {
      const bi = t.slice(i, i + 2);
      if (!STOP_WORDS.has(bi)) out.add(bi);
    }
  }
  return [...out].slice(0, max);
}

const TERM_WEIGHT = {
  goal: 8,        // 和你自己写的规划相关
  exam: 12,       // 和 7 天内的考试相关
  milestone: 10,  // 和里程碑/目标相关
  course: 10,     // 和你在上的课相关
  event: 6,       // 和未来日程相关
  task: 6,        // 和未来任务相关
  profile: 6,     // 和画像里的关注点相关
};

/**
 * 把"你的未来规划"整理成一份可比对的上下文。
 * @param {{tasks?:any[],events?:any[],milestones?:any[],academic?:any[],courses?:any[],notifications?:any[],goals?:any,profile?:any}} state
 */
export function buildPlanContext(state = {}, { now = Date.now(), horizonDays = HORIZON_DAYS } = {}) {
  const horizonMs = now + horizonDays * DAY;
  const within = (ms) => ms !== null && ms !== undefined && ms >= now - DAY && ms <= horizonMs;   // 宽一天，避免"今天就到期"被漏掉
  const daysLeftOf = (ms) => (ms == null ? null : Math.max(0, Math.ceil((ms - now) / DAY)));

  const upcoming = [];
  for (const t of state.tasks || []) {
    if (t.status === 'done') continue;
    const ms = whenMs(t.due_at);
    if (!within(ms)) continue;
    upcoming.push({ id: t.id, kind: 'task', title: t.title || '', at: t.due_at, ms, daysLeft: daysLeftOf(ms), source: 'app' });
  }
  for (const e of state.events || []) {
    const ms = whenMs(e.start_at);
    if (!within(ms)) continue;
    upcoming.push({ id: e.id, kind: 'event', title: e.title || '', at: e.start_at, ms, daysLeft: daysLeftOf(ms), source: 'app' });
  }
  for (const m of state.milestones || []) {
    if (m.done) continue;
    const ms = whenMs(m.target_at);
    if (!within(ms)) continue;
    upcoming.push({ id: m.id, kind: 'milestone', title: m.title || '', at: m.target_at, ms, daysLeft: daysLeftOf(ms), source: 'app' });
  }
  for (const a of state.academic || []) {
    const ms = whenMs(a.kind === 'exam' ? a.start_at : a.end_at);
    if (!within(ms)) continue;
    upcoming.push({ id: a.id, kind: a.kind === 'exam' ? 'exam' : 'academic', title: a.title || a.kind || '', at: a.start_at, ms, daysLeft: daysLeftOf(ms), source: 'app' });
  }
  upcoming.sort((a, b) => a.ms - b.ms);

  // 关键词表：每一条都带"它是从哪来的"，界面才能说清理由
  const terms = new Map();   // term -> { term, kind, label }
  const addTerms = (text, kind, label) => {
    for (const t of termsFromText(text)) {
      const key = String(t).toLowerCase();
      if (!terms.has(key) || TERM_WEIGHT[kind] > TERM_WEIGHT[terms.get(key).kind]) {
        terms.set(key, { term: t, lower: key, kind, label });
      }
    }
  };

  const goals = normalizeGoals(state.goals);
  for (const g of goals.goals) addTerms(g, 'goal', g);
  for (const m of state.milestones || []) if (!m.done) addTerms(m.title, 'milestone', m.title);
  for (const a of state.academic || []) {
    const ms = whenMs(a.kind === 'exam' ? a.start_at : a.end_at);
    addTerms(a.title || '', (a.kind === 'exam' && daysLeftOf(ms) !== null && daysLeftOf(ms) <= 7) ? 'exam' : 'academic', a.title);
  }
  for (const c of state.courses || []) {
    addTerms(c.course || '', 'course', c.course);
    if (c.course_code) addTerms(c.course_code, 'course', c.course_code);
  }
  for (const u of upcoming) addTerms(u.title, u.kind === 'exam' ? 'exam' : (u.kind === 'milestone' ? 'milestone' : u.kind), u.title);
  const profile = state.profile || {};
  for (const k of [...(profile.keywords || []), ...(profile.courseCodes || [])]) addTerms(k, 'profile', String(k));

  // 未来 7 天每天有几件事到期（用来发现"撞车日"）
  const perDay = {};
  for (const u of upcoming) {
    if (u.daysLeft === null || u.daysLeft > 7) continue;
    const k = dayKey(u.ms);
    perDay[k] = (perDay[k] || 0) + 1;
  }
  const crowdedDays = Object.entries(perDay)
    .filter(([, n]) => n >= 3)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    schema: PRIORITY_VERSION,
    now,
    horizonDays,
    goals,
    upcoming,
    terms: [...terms.values()],
    crowdedDays,
    examSoon: upcoming.find((u) => u.kind === 'exam' && u.daysLeft !== null && u.daysLeft <= 7) || null,
    // 规划为空时也要能工作：只是没有"规划相关"这类加分
    hasPlan: (goals.goals.length + upcoming.length) > 0,
  };
}

// ---------------------------------------------------------------- 打分

/** 需要行动的措辞（出现就该往前排）。 */
const ACTION_RE = /(截止|提交|交作业|提交作业|报名|选课|确认|签字|签署|付款|缴费|上传|面试|面谈|答辩|考核|deadline|submit|due|register|rsvp|confirm|upload|interview|payment)/i;
/**
 * 明确紧急的措辞。
 * 注意不要只写"重要"两个字：像「最近重要变化」这种标题会被误判（2026-09-22 修正）。
 */
const URGENT_RE = /(紧急|重要通知|重要变更|重要提醒|重要更新|务必|必须|尽快|立即|马上|今天内|最迟|only today|urgent|asap|immediately)/i;
/** 课程资料/作业类。 */
const COURSEWORK_RE = /(作业|实验|报告|论文|项目|小组|测验|小测|期中|期末|assignment|homework|lab|project|quiz|midterm|final|essay|paper)/i;
/** 纯告知类（降权）。 */
const AMBIENT_RE = /(通知|提醒|公告|newsletter|digest|update|已发布|已更新)/i;

/** 来源权重：学校邮箱与课程平台最贴你的事。 */
export const SOURCE_IMPORTANCE = {
  email_sjtu: 10,
  canvas: 10,
  email: 5,
  feishu: 5,
  arxiv: 2,
  rss: 2,
  ical: 4,
  jsonapi: 4,
  localfile: 4,
};

/** 分数 → 档位。 */
export const bandOf = (score) => (score >= BANDS.high ? 'high' : (score >= BANDS.normal ? 'normal' : 'low'));

/**
 * 给一条信息算重要性。
 * @param {{title?:string, notes?:string, source?:string, due_at?:string, start_at?:string, kind?:string, sender?:string}} item
 * @param {ReturnType<typeof buildPlanContext>} ctx
 * @param {{learning?:{accept?:number,reject?:number}, now?:number, relevance?:{verdict?:string}}} [opts]
 */
export function scoreImportance(item = {}, ctx = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : (ctx.now || Date.now());
  const reasons = [];
  const add = (rule, label, delta) => { if (delta) reasons.push({ rule, label, delta }); return delta; };

  let score = 30;   // 中性起点：既非"一定重要"，也非"不重要"
  // **标题与正文分开看**（2026-09-22 修正）：每日简报那类长正文几乎含所有词，
  // 之前让"命中规划"被刷到 85~181 个词，等于是没命中。现在：
  //   * 措辞判断（要行动/紧急/课程作业）**只看标题** —— 标题才是作者想让人看到的那句；
  //   * 规划关键词标题、正文都算，但**正文命中权重 ×0.4**。
  const title = String(item.title || '');
  const body = String(item.notes || '');
  const lowerTitle = title.toLowerCase();
  const lowerBody = body.toLowerCase();
  const titleText = title;

  // ---- 时间紧迫度（最重要的一项）----
  const at = whenMs(item.due_at || item.start_at);
  let daysLeft = null;
  if (at !== null) {
    daysLeft = Math.ceil((at - now) / DAY);
    // 过期要分情况看（2026-09-22 修正）：
    //   * **还没做完的任务**过期 → 更该处理，加分；
    //   * **纯提醒/信息**过期几天 → 已经没用了，减分。
    // 之前一律 -15，会把"逾期作业"和"上礼拜的旧公告"当成同一件事。
    if (at < now) {
      const late = Math.max(1, Math.ceil((now - at) / DAY));
      if (item.kind === 'task') score += add('overdue-task', `已经过期 ${late} 天但还没做完`, 18);
      else if (late > 3) score += add('stale', `这条提醒已经过去 ${late} 天`, -12);
      else score += add('overdue', '已经过期/正在进行', -8);
    }
    else if (daysLeft <= 1) score += add('due-1d', '明天内到期', 35);
    else if (daysLeft <= 3) score += add('due-3d', '3 天内到期', 25);
    else if (daysLeft <= 7) score += add('due-7d', '一周内到期', 15);
    else if (daysLeft <= ctx.horizonDays) score += add('due-horizon', `${ctx.horizonDays} 天内到期`, 8);
  }

  // ---- 命中"未来规划"关键词 ----
  let planGain = 0;
  const hits = [];
  for (const t of ctx.terms || []) {
    if (!t.lower || t.lower.length < 2) continue;
    const inTitle = lowerTitle.includes(t.lower);
    const inBody = !inTitle && lowerBody.includes(t.lower);
    if (!inTitle && !inBody) continue;
    const weight = (TERM_WEIGHT[t.kind] || 4) * (inTitle ? 1 : 0.4);
    hits.push({ ...t, inTitle, weight });
    planGain = Math.min(30, planGain + weight);
  }
  if (planGain) {
    hits.sort((a, b) => b.weight - a.weight);
    const top = hits[0];
    const whyKind = { goal: '命中你写的规划', exam: '和最近的考试有关', milestone: '和你的里程碑有关', course: '和你在上的课有关', event: '和未来日程有关', task: '和未来任务有关', profile: '命中你的关注点' };
    const extra = hits.slice(1, 3).map((h) => h.term).join('、');
    score += add('plan-hit',
      `${whyKind[top.kind] || '和你的规划有关'}「${top.label || top.term}」${extra ? `，另外还有 ${extra}` : ''}`
      + (top.inTitle ? '' : '（出现在正文里）'),
      Math.round(planGain));
  }

  // ---- 措辞 ----
  if (ACTION_RE.test(titleText)) score += add('action', '标题里就有"提交/报名/确认"这类要行动的词', 12);
  if (URGENT_RE.test(titleText)) score += add('urgent', '标题里明确写了紧急/务必', 8);
  if (COURSEWORK_RE.test(titleText)) score += add('coursework', '标题和课程作业/考试相关', 6);
  // 纯告知类降权：**只有在你跟它本来没关系时才降**（命中了规划/关注点的不算噪音）
  if (!at && !planGain && AMBIENT_RE.test(titleText) && !ACTION_RE.test(titleText)) {
    score += add('ambient', '像是纯告知类内容，且与你现在的规划无关', -10);
  }

  // ---- 来源 ----
  const sw = SOURCE_IMPORTANCE[String(item.source || '')];
  if (Number.isFinite(sw) && sw) score += add('source', `来自 ${item.source}`, sw);

  // ---- 还没处理过的外部条目：优先让你先过一眼 ----
  if (opts.origin === 'pending' || item.origin === 'pending') {
    score += add('unhandled', '还没处理过的外部条目', 5);
  }

  // ---- 你的历史行为（学过的偏好）----
  // 两种传法：learning 直接给一组计数；learningFor(item) 按条目各自取（接口里用后者）
  const l = (typeof opts.learningFor === 'function' ? opts.learningFor(item) : opts.learning) || {};
  if (Number(l.reject) >= 3) score += add('learned-reject', `你以前忽略过 ${l.reject} 次`, -25);
  if (Number(l.accept) >= 2) score += add('learned-accept', `你以前保留过 ${l.accept} 次`, 8);

  // ---- 已有的相关度裁决：被判"建议忽略"的，重要性也应下调 ----
  if (opts.relevance?.verdict === 'drop') score += add('relevance-drop', '相关度裁决：建议忽略', -20);
  if (opts.relevance?.verdict === 'review') score += add('relevance-review', '相关度裁决：待你确认', -5);

  score = clamp(Math.round(score), 0, 100);
  return {
    score,
    band: bandOf(score),
    daysLeft,
    reasons,
    why: reasons.length ? reasons.map((r) => `${r.label}（${r.delta > 0 ? '+' : ''}${r.delta}）`).join(' · ') : '没有明显的重要特征',
  };
}

/**
 * 排序 + 分档。返回 { ranked, counts }。
 * 排序规则：分数高的在前；同分时**有时间的排前面**（时间近的优先），再按标题稳定排序。
 */
export function rankByImportance(items = [], ctx = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : (ctx.now || Date.now());
  const ranked = (items || []).map((item) => {
    const r = scoreImportance(item, ctx, { ...opts, now });
    return { ...item, importance: r.score, band: r.band, daysLeft: r.daysLeft, reasons: r.reasons, why: r.why };
  }).sort((a, b) => (b.importance - a.importance)
    || ((a.daysLeft ?? 9999) - (b.daysLeft ?? 9999))
    || String(a.title || '').localeCompare(String(b.title || ''), 'zh'));

  const counts = { high: 0, normal: 0, low: 0 };
  for (const r of ranked) counts[r.band] += 1;
  return { ranked, counts, schema: PRIORITY_VERSION, context: { goals: ctx.goals?.goals || [], upcoming: ctx.upcoming || [], crowdedDays: ctx.crowdedDays || [] } };
}

/**
 * 规则版建议（不依赖任何模型，离线可用）。
 * 想更进一步可以让 agent 基于同一份上下文写建议（见 server 的 /api/priority/advice）。
 */
export function buildAdvice(result, ctx = {}, { max = 4 } = {}) {
  const ranked = result?.ranked || [];
  const high = ranked.filter((x) => x.band === 'high');
  const out = [];

  const daysOf = (x) => (x.daysLeft === null || x.daysLeft === undefined ? null : x.daysLeft);

  // ① 最急的一件（**还没到期的**才算"只剩几天"）
  const urgent = [...high, ...ranked].find((x) => {
    const d = daysOf(x);
    return d !== null && d >= 0 && d <= 2;
  });
  if (urgent) {
    out.push({
      id: 'urgent',
      level: 'high',
      text: `「${urgent.title}」${urgent.daysLeft === 0 ? '今天到期' : `只剩 ${urgent.daysLeft} 天`}，建议今天先处理这一件。`,
      refs: [urgent.id],
    });
  }

  // ①' 没有"还没到期的急事"时：看看有没有**放了几天还没处理**的外部条目
  if (!urgent) {
    const stale = ranked.find((x) => x.origin === 'pending' && daysOf(x) !== null && daysOf(x) < 0);
    if (stale) {
      const late = Math.abs(daysOf(stale));
      out.push({
        id: 'unhandled-stale',
        level: 'warn',
        text: `「${stale.title}」已经放了 ${late} 天还没处理 —— 要么今天扫一眼，要么直接忽略掉它。`,
        refs: [stale.id],
      });
    }
  }

  // ② 规划对齐：命中了你自己写的规划
  const goalHit = high.find((x) => (x.reasons || []).some((r) => r.rule.startsWith('plan-hit')));
  if (goalHit) {
    out.push({
      id: 'goal-aligned',
      level: 'info',
      text: `「${goalHit.title}」和你写的规划直接相关 —— 这类信息以后我会优先提醒你。`,
      refs: [goalHit.id],
    });
  }

  // ③ 考试临近
  if (ctx.examSoon) {
    const related = ranked.filter((x) => (x.reasons || []).some((r) => r.rule.startsWith('plan-hit'))).length;
    out.push({
      id: 'exam-soon',
      level: 'high',
      text: `离「${ctx.examSoon.title}」还有 ${ctx.examSoon.daysLeft} 天${related ? `，其中 ${related} 条信息与它相关` : ''}。`,
      refs: [ctx.examSoon.id],
    });
  }

  // ④ 撞车日（分析型建议）
  if (ctx.crowdedDays?.length) {
    const d = ctx.crowdedDays[0];
    const [, mm, dd] = d.date.split('-');
    out.push({
      id: 'crowded',
      level: 'warn',
      text: `${Number(mm)}/${Number(dd)} 同一天有 ${d.count} 件事到期，建议提前一天做掉其中一件。`,
      refs: [],
    });
  }

  // ⑤ 兜底：高重要性较多时给一句"怎么排"
  if (!out.length && high.length >= 3) {
    out.push({
      id: 'triage',
      level: 'info',
      text: `现在有 ${high.length} 条高重要性，建议按截止时间从近到远处理（列表已经帮你排好了）。`,
      refs: [],
    });
  }

  return out.slice(0, max);
}
