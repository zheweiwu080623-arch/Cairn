// 相关度裁决：决定"外部进来的一条信息，值不值得打扰你"。
//
// 为什么要有它：在此之前，所有连接器条目都被当成同等重要 —— 实测 126 条提醒里
// 101 条被标成"重点"（80% 都是重点 = 没有重点）。根因是系统里没有"我是谁"的可计算表示。
//
// 设计三原则：
//   1) **可解释**：每条判决都带 reasons（命中了哪条规则、加减多少分），不用黑盒。
//   2) **不惊动现状**：画像没启用时，一切与今天完全一样（verdict 恒为 push）。
//   3) **纯函数**：不碰数据库、不联网，方便测试与复用（CLI / 邮件 / agent 都能用）。
//
// 画像（profile）的形状见 contracts/profile.v1.schema.json

export const PROFILE_VERSION = 'profile.v1';

export const DEFAULT_PROFILE = Object.freeze({
  schema: PROFILE_VERSION,
  enabled: false,
  // 关注什么
  keywords: [],
  courseCodes: [],
  allowSenders: [],
  sourceWeights: {},
  // 不想看什么
  denyKeywords: [],
  denySenders: [],
  // 阈值：>= pushAt 自动放行；<= dropAt 判为"建议忽略"
  pushAt: 3,
  dropAt: -3,
  // 语义兜底：off=不用；batch=只对"拿不准"的中间带条目、且只在非高峰跑（P2）
  semantic: 'off',
  updated_at: 0,
  origin: 'empty',   // manual | derived | longterm-memory | empty
});

const COURSE_CODE_RE = /\b([A-Z]{2,5}\d{3,4}[A-Z]?)\b/g;
const BULK_SENDER_RE = /(no-?reply|donotreply|newsletter|notification|mailer|bounce|marketing)/i;
const PROMO_TITLE_RE = /(促销|优惠|折扣|限时|订阅|推广|discount|sale|promotion|unsubscribe|webinar)/i;

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim())
  .map((x) => x.trim()) : []);
const uniq = (list) => [...new Set(list)];

/** 把任意来源的原始画像整理成统一形状（缺项补默认值，脏数据不致命）。 */
export function normalizeProfile(raw = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    schema: PROFILE_VERSION,
    enabled: p.enabled === true,
    keywords: uniq(asArray(p.keywords)),
    courseCodes: uniq(asArray(p.courseCodes).map((c) => c.toUpperCase())),
    allowSenders: uniq(asArray(p.allowSenders).map((s) => s.toLowerCase())),
    sourceWeights: (p.sourceWeights && typeof p.sourceWeights === 'object') ? { ...p.sourceWeights } : {},
    denyKeywords: uniq(asArray(p.denyKeywords)),
    denySenders: uniq(asArray(p.denySenders).map((s) => s.toLowerCase())),
    // 2026-09-26（五步上手 · 分析偏好）：允许用户写一整段自述，最长 4000 字。
    // 它不进打分公式，但会留给"让 agent 分析"与将来的语义判断做上下文；空字符串表示没写。
    notes: typeof p.notes === 'string' ? p.notes.slice(0, 4000) : '',
    pushAt: Number.isFinite(p.pushAt) ? p.pushAt : DEFAULT_PROFILE.pushAt,
    dropAt: Number.isFinite(p.dropAt) ? p.dropAt : DEFAULT_PROFILE.dropAt,
    semantic: p.semantic === 'batch' ? 'batch' : 'off',
    updated_at: Number.isFinite(p.updated_at) ? p.updated_at : 0,
    origin: typeof p.origin === 'string' && p.origin ? p.origin : 'manual',
  };
}

// 统一在这一层做小写化：调用方传什么大小写都行（课程代码是大写、标题里可能是小写）
const hitCount = (text, needles) => {
  const hay = String(text).toLowerCase();
  return needles.reduce((n, needle) => {
    const pin = String(needle || '').toLowerCase();
    return n + (pin && hay.includes(pin) ? 1 : 0);
  }, 0);
};

/**
 * 给一条外部条目打分。
 * item: { source, title, notes, sender, due_at, start_at, kind }
 * 返回 { score, verdict, reasons: [{rule, delta, note}] }
 */
export function scoreItem(item = {}, rawProfile = DEFAULT_PROFILE) {
  const p = normalizeProfile(rawProfile);
  const reasons = [];
  const add = (rule, delta, note) => { reasons.push({ rule, delta, note }); return delta; };

  // 画像没启用 → 与历史行为完全一致
  if (!p.enabled) {
    return { score: 0, verdict: 'push', reasons: [{ rule: 'profile-disabled', delta: 0, note: '画像未启用，保持原有行为' }] };
  }

  const title = String(item.title || '').toLowerCase();
  const notes = String(item.notes || '').toLowerCase();
  const sender = String(item.sender || '').toLowerCase();
  const source = String(item.source || '');
  const text = `${title} ${notes}`;
  let score = 0;

  // ---- 一票否决 ----
  if (sender && p.denySenders.some((s) => sender.includes(s))) {
    add('deny-sender', -100, `发件人在屏蔽清单：${sender}`);
    return { score: -100, verdict: 'drop', reasons };
  }
  const denyHits = hitCount(text, p.denyKeywords);
  if (denyHits) score += add('deny-keyword', -2 * Math.min(denyHits, 3), `命中屏蔽词 ${denyHits} 个`);

  // ---- 正向 ----
  if (sender && p.allowSenders.some((s) => sender.includes(s))) score += add('allow-sender', 3, `发件人在关注清单：${sender}`);
  const kwHits = hitCount(text, p.keywords);
  if (kwHits) score += add('keyword', 2 * Math.min(kwHits, 3), `命中关注关键词 ${kwHits} 个`);
  const codeHits = hitCount(text, p.courseCodes);
  if (codeHits) score += add('course-code', 3, `命中你的课程代码 ${codeHits} 个`);

  const weight = Number(p.sourceWeights[source]);
  if (Number.isFinite(weight) && weight) score += add('source-weight', weight, `来源 ${source} 的权重 ${weight}`);

  // ---- 时间紧迫 ----
  const when = item.due_at || item.start_at;
  if (when) {
    const ms = Date.parse(String(when)) - Date.now();
    if (Number.isFinite(ms) && ms >= 0 && ms <= 7 * 86400000) score += add('due-soon', 1, '7 天内到期');
  }

  // ---- 批量/推广特征（降权） ----
  if (sender && BULK_SENDER_RE.test(sender)) score += add('bulk-sender', -2, '像是自动通知类发件人');
  if (PROMO_TITLE_RE.test(`${title} ${notes}`)) score += add('promo-tone', -2, '标题像推广/订阅类内容');

  const verdict = score >= p.pushAt ? 'push' : (score <= p.dropAt ? 'drop' : 'review');
  return { score, verdict, reasons };
}

/** 从应用已有的数据里派生一份画像（不需要 agent，也不需要你手填）。 */
export function deriveProfileFromState(state = {}) {
  const courses = Array.isArray(state.courses) ? state.courses : [];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const notifications = Array.isArray(state.notifications) ? state.notifications : [];
  const codeSet = new Set();
  for (const c of courses) {
    const text = `${c.course || ''} ${c.title || ''} ${c.notes || ''}`;
    for (const m of text.matchAll(COURSE_CODE_RE)) codeSet.add(m[1].toUpperCase());
  }
  // 任务标题里也常带课程代码 / 项目名（如 ACM、TOEFL）
  const keywords = new Set();
  for (const t of tasks) {
    for (const m of String(t.title || '').matchAll(COURSE_CODE_RE)) codeSet.add(m[1].toUpperCase());
    if (/TOEFL|托福/i.test(t.title || '')) keywords.add('TOEFL');
    if (/ACM|竞赛/i.test(t.title || '')) keywords.add('ACM');
  }
  // 来源权重：近一段时间哪类来源你留着、哪类你经常清掉（先用"条数占比"做粗估）
  const bySource = {};
  for (const n of notifications) {
    const s = String(n.source || '').replace(/^connector:/, '');
    if (s) bySource[s] = (bySource[s] || 0) + 1;
  }
  return normalizeProfile({
    enabled: false,                      // 派生结果默认**不启用**，要你点一下才生效
    keywords: [...keywords],
    courseCodes: [...codeSet],
    sourceWeights: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v > 20 ? 1 : 0])),
    origin: 'derived',
    updated_at: Date.now(),
  });
}

/**
 * 从"长期记忆 / 任意 markdown 文本"里解析一份画像草稿。
 * 给有 agent + longterm memory 的人用：把那段文本粘进来就行，不用手填字段。
 * 只做**规则化提取**（课程代码、关键词行、屏蔽词行），不做语义猜测 —— 提取结果要你确认后才保存。
 */
export function parseProfileFromText(text = '') {
  const src = String(text);
  const courseCodes = uniq([...src.matchAll(COURSE_CODE_RE)].map((m) => m[1].toUpperCase()));

  const pickLines = (headingRe) => {
    const lines = src.split(/\r?\n/);
    const out = [];
    let on = false;
    for (const line of lines) {
      if (/^#{1,6}\s/.test(line)) { on = headingRe.test(line); continue; }
      if (!on) continue;
      const m = line.match(/^\s*(?:[-*•]|\d+\.)\s*(.+?)\s*$/);
      if (m) out.push(m[1]);
    }
    return out;
  };

  const interestLines = pickLines(/兴趣|关注|方向|领域|interest|focus/i);
  const goalLines = pickLines(/目标|计划|规划|goal|plan/i);
  const avoidLines = pickLines(/不想|屏蔽|避免|忽略|avoid|mute/i);

  // 注意也要在 "：" / ":" 上切开 —— 长期记忆里常见 "科研：agent 记忆与工具调用" 这种写法
  const keywords = uniq([...interestLines, ...goalLines]
    .flatMap((line) => line.split(/[，,、/|;；:：]+/))
    .map((w) => w.replace(/[（(].*?[)）]/g, '').trim())
    .filter((w) => w.length >= 2 && w.length <= 20 && !/^\d+$/.test(w)));

  const denyKeywords = uniq(avoidLines
    .flatMap((line) => line.split(/[，,、/|;；:：]+/))
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && w.length <= 20));

  return normalizeProfile({
    enabled: false,
    keywords,
    courseCodes,
    denyKeywords,
    origin: 'longterm-memory',
    updated_at: Date.now(),
  });
}

/** 汇总一次同步的裁决结果，用于回给界面（"这次拦下了什么、为什么"）。 */
export function summarizeVerdicts(rows = []) {
  const out = { push: 0, review: 0, drop: 0, topReasons: {} };
  for (const r of rows) {
    out[r.verdict] = (out[r.verdict] || 0) + 1;
    for (const reason of r.reasons || []) {
      if (!reason.delta) continue;
      out.topReasons[reason.rule] = (out.topReasons[reason.rule] || 0) + 1;
    }
  }
  return out;
}
