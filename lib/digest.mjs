// digest.mjs —— 「日报 / 晚报」：把"最值得先看的 3 条 + 建议"合成一段能一眼扫完的摘要。
//
// 它和 lib/mobile.mjs 的 buildDigestText 分工不同，但用的是**同一套排序结果**：
//   * buildDigestText = **日程清单**（几点上课、今天到期的任务、被筛选拦下的条目）→ 每天发到手机/办公本的邮件；
//   * buildBrief      = **信息摘要**（最值得先看的几条 + 为什么 + 建议）→ 早报看今天、晚报看明天。
// 「哪条重要」只由 lib/priority.mjs 决定，这里只负责"挑哪几条、怎么说人话"。
//
// 三条不变量（跟 relevance / priority 保持一致）：
//   1) **可解释**：每一条都带理由（why），用户能问"凭什么把它排第一"；
//   2) **纯函数**：不读数据库、不联网、只吃传入的数据 → 好测试、换界面不用改；
//   3) **没依据就说没有**：不硬编"重要"，宁可真话（"未来几天没有明确要优先处理的信息"）。

export const DIGEST_SCHEMA = 'digest.v1';

/** 一次摘要最多列几条"最值得先看"。 */
export const TOP_N = 3;

export const KINDS = ['morning', 'evening'];

export const KIND_META = {
  morning: { key: 'morning', label: '早报', icon: '🌅', focus: '今天' },
  evening: { key: 'evening', label: '晚报', icon: '🌙', focus: '明天' },
};

const BAND_LABEL = { high: '重要', normal: '一般', low: '低' };

const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const mdLabel = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;

/** 16:00 之后更该看晚报（明天要准备什么）；否则看早报。 */
export function kindForHour(hour) {
  return Number(hour) >= 16 ? 'evening' : 'morning';
}

export function kindForDate(date = new Date()) {
  return kindForHour(date.getHours());
}

/** 把任意输入（'auto' / 空 / 拼错）收成两种之一。 */
export function normalizeKind(kind, { now = Date.now() } = {}) {
  const k = String(kind || '').toLowerCase();
  if (KINDS.includes(k)) return k;
  return kindForDate(new Date(now));
}

/** 时间的人话说法（和「重要信息」模块保持一致的口径）。 */
export function whenText(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return '无时间';
  if (daysLeft < 0) return `已过期 ${Math.abs(daysLeft)} 天`;
  if (daysLeft === 0) return '今天';
  if (daysLeft === 1) return '明天';
  return `${daysLeft} 天后`;
}

const clip = (s, n = 60) => {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * 从排序结果里挑"最值得先看的几条"。两条判据（都是为了"宁缺毋滥"）：
 *
 *   1) **不要过期的**：过期条目另有专门的一行（今天没做完 / 逾期），
 *      混进"最值得先看"会让榜单不可信（上礼拜的旧公告不该排第一）；
 *   2) **不要低分又不急的**：分档已经是"低"、又不是今明两天到期，
 *      说明它既不重要也不着急 —— 2026-09-22 在真库上实测：不过滤的话
 *      "GitHub 验证码"这类邮件会被列成第 2 条，等于把这个榜单废掉。
 *      （低分但**今明到期**的仍然保留：急事优先于分数。）
 *
 * 一条都没有时返回空数组 —— 由调用方诚实地说"未来几天没有明确要优先处理的信息"。
 */
export function pickTop(ranked = [], { max = TOP_N } = {}) {
  const list = (Array.isArray(ranked) ? ranked : []).filter((x) => x && String(x.title || '').trim());
  const fresh = list.filter((x) => x.daysLeft === null || x.daysLeft === undefined || x.daysLeft >= 0);
  const soon = (x) => Number.isFinite(x.daysLeft) && x.daysLeft >= 0 && x.daysLeft <= 1;
  const worth = fresh.filter((x) => x.band !== 'low' || soon(x));
  return worth.slice(0, max).map((x) => ({
    id: x.id,
    title: String(x.title).trim(),
    band: x.band || null,
    importance: Number.isFinite(x.importance) ? x.importance : null,
    daysLeft: x.daysLeft === undefined ? null : x.daysLeft,
    source: x.source || '',
    why: x.why || '',
  }));
}

/**
 * 把某一天的安排压成几行（课程 / 日程 / 截止 / 提醒 / 里程碑 / 校历）。
 * 这是**纯文本**，直接进摘要；没有安排就说没有。
 */
export function scheduleLines(day, { max = 6 } = {}) {
  if (!day) return ['（没有这一天的数据）'];
  const out = [];
  for (const a of day.academic || []) out.push(`校历：${a.title}`);
  for (const c of day.courses || []) out.push(`${c.start}  ${c.course}${c.location ? ` @${c.location}` : ''}`);
  for (const e of day.events || []) out.push(`${e.all_day ? '全天' : String(e.start || '').slice(11)}  ${e.title}`);
  for (const t of (day.due_tasks || []).filter((t) => t.status !== 'done')) out.push(`[截止] ${t.title}`);
  for (const r of day.reminders || []) out.push(`[提醒] ${String(r.at || '').slice(11)} ${r.title}`);
  for (const m of day.milestones || []) out.push(`[里程碑] ${m.title}`);
  if (!out.length) return ['（没有固定安排）'];
  if (out.length > max) return [...out.slice(0, max), `…还有 ${out.length - max} 条`];
  return out;
}

/** 今天到期的任务里，哪些做完了、哪些还没（晚报要用）。 */
export function todayProgress(day) {
  const due = (day?.due_tasks || []);
  const done = due.filter((t) => t.status === 'done');
  const open = due.filter((t) => t.status !== 'done');
  return { done, open, total: due.length };
}

/** 手机推送的正文（短，能一眼看完）。 */
export function buildPushBody(top = [], advice = [], { maxChars = 200 } = {}) {
  const L = [];
  top.forEach((x, i) => L.push(`${i + 1}. ${clip(x.title, 34)}（${whenText(x.daysLeft)}）`));
  const first = Array.isArray(advice) ? (advice[0] && advice[0].text) : null;
  if (first) L.push(`建议：${clip(first, 60)}`);
  if (!L.length) L.push('未来几天没有明确要优先处理的信息。');
  let text = L.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}

/**
 * 生成一份日报 / 晚报。
 *
 * @param {{kind?:'morning'|'evening', now?:number, appName?:string, plan?:object, ranked?:any[], advice?:any[]}} opts
 *   plan   = lib/plan-export.mjs 的 buildPlan() 结果（days[] / backlog / stats）
 *   ranked = lib/priority.mjs 的 rankByImportance() 结果（已按重要性排好）
 *   advice = lib/priority.mjs 的 buildAdvice() 结果（规则版建议）
 */
export function buildBrief({
  kind = 'morning', now = Date.now(), appName = 'Cairn',
  plan = {}, ranked = [], advice = [],
} = {}) {
  const when = new Date(now);
  const k = KINDS.includes(kind) ? kind : 'morning';
  const meta = KIND_META[k];
  const days = Array.isArray(plan.days) ? plan.days : [];
  const today = days[0] || null;
  const tomorrow = days[1] || null;
  const focusDay = k === 'morning' ? today : tomorrow;

  const top = pickTop(ranked, { max: TOP_N });
  const counts = { high: 0, normal: 0, low: 0 };
  for (const r of Array.isArray(ranked) ? ranked : []) {
    if (counts[r?.band] !== undefined) counts[r.band] += 1;
  }
  const stats = {
    open_tasks: Number(plan?.stats?.open_tasks || 0),
    events: Number(plan?.stats?.events || 0),
    overdue: Array.isArray(plan?.backlog?.overdue) ? plan.backlog.overdue.length : 0,
  };
  const { done: doneToday, open: openToday, total: dueToday } = todayProgress(today);

  const L = [];
  L.push(`${appName} · ${meta.label} · ${ymd(when)} 周${WEEK[when.getDay()]} ${hm(when)}`);
  L.push('='.repeat(34));
  if (k === 'morning') {
    L.push(`今天最值得先看 ${top.length} 条 · 未完成 ${stats.open_tasks} 项 · 逾期 ${stats.overdue} 项`);
  } else {
    L.push(`今天完成 ${doneToday.length} 项 · 今天还没做完 ${openToday.length} 项 · 逾期 ${stats.overdue} 项`);
  }
  L.push('');

  if (k === 'evening') {
    L.push('【今天做完 / 没做完】');
    if (!dueToday) L.push('  今天没有到期的任务。');
    else {
      if (doneToday.length) {
        L.push(`  已完成 ${doneToday.length} 项：`);
        for (const t of doneToday.slice(0, 5)) L.push(`    ✓ ${clip(t.title, 40)}`);
      }
      if (openToday.length) {
        L.push(`  还没做完 ${openToday.length} 项：`);
        for (const t of openToday.slice(0, 5)) L.push(`    ✗ ${clip(t.title, 40)}`);
        if (openToday.length > 5) L.push(`    …还有 ${openToday.length - 5} 项`);
      } else L.push('  今天到期的都做完了。');
    }
    L.push('');
  }

  L.push(`【最值得先看的 ${top.length} 条】`);
  if (!top.length) {
    L.push('  未来几天没有明确要优先处理的信息。');
  } else {
    top.forEach((x, i) => {
      const tag = x.band ? `${BAND_LABEL[x.band] || x.band}${x.importance != null ? ` ${x.importance}` : ''}` : '待看';
      const where = [whenText(x.daysLeft), x.source].filter(Boolean).join(' · ');
      L.push(`  ${i + 1}. [${tag}] ${clip(x.title)}${where ? `（${where}）` : ''}`);
      if (x.why) L.push(`     · 为什么：${clip(x.why, 90)}`);
    });
  }
  L.push('');

  L.push(`【${meta.focus}的安排】${focusDay ? ` ${focusDay.date} 周${focusDay.weekday}` : ''}`);
  for (const line of scheduleLines(focusDay)) L.push(`  ${line}`);
  L.push('');

  L.push('【建议】');
  if (Array.isArray(advice) && advice.length) {
    for (const a of advice.slice(0, 4)) L.push(`  · ${clip(a?.text || '', 100)}`);
  } else {
    L.push('  · 没有需要特别提醒的；按上面顺序处理就好。');
  }
  L.push('');
  L.push('本摘要由本机 Cairn 生成；排序依据是「你的未来规划」。');

  const text = L.join('\n');
  const brief = {
    schema: DIGEST_SCHEMA,
    kind: k,
    label: meta.label,
    icon: meta.icon,
    focus: meta.focus,
    title: `${meta.label} · ${mdLabel(when)}`,
    generated_at: when.toISOString(),
    date: ymd(when),
    weekday: `周${WEEK[when.getDay()]}`,
    counts,
    stats: { ...stats, today_due: dueToday, today_done: doneToday.length, today_open: openToday.length },
    top,
    schedule: { date: focusDay?.date || null, weekday: focusDay ? `周${focusDay.weekday}` : null, lines: scheduleLines(focusDay) },
    advice: (Array.isArray(advice) ? advice : []).slice(0, 4),
    lines: L,
    text,
  };
  brief.push = { title: brief.title, body: buildPushBody(top, brief.advice) };
  return brief;
}

/**
 * 给 agent 的提示词（日报/晚报的"更细的分析"）。
 * 硬约束和重要性那套一致：**只依据给出的内容，不要编造**，并且要求输出标记便于只取结论。
 */
export function buildBriefPrompt(brief = {}) {
  const top = (brief.top || []).map((x, i) => `- ${i + 1}. ${x.title}（${whenText(x.daysLeft)}${x.source ? `，${x.source}` : ''}）${x.why ? `｜理由：${x.why}` : ''}`).join('\n') || '（没有排在前面的信息）';
  const sched = (brief.schedule?.lines || []).join('\n') || '（没有安排）';
  const rules = (brief.advice || []).map((a) => `- ${a.text}`).join('\n') || '（规则版没有给出建议）';

  return [
    `你是一个谨慎的个人助理。现在是${brief.label || '摘要'}（${brief.focus || ''}）：${brief.date || ''} ${brief.weekday || ''}。`,
    '下面是这个人本机收集到的真实数据。',
    '',
    '要求（必须遵守）：',
    '1. **只依据下面的内容**，不要编造任何不存在的时间、事件或信息；',
    '2. 用中文，最多 3 条，每条不超过 40 字，写"做什么 + 为什么"；',
    '3. 要具体到能立刻执行的下一步（例如"今晚先写实验报告的引言"）；',
    '4. 如果信息不足以给出建议，就直接说"信息不足，建议先补充 X"。',
    '',
    `【${brief.focus || ''}的安排】`,
    sched,
    '',
    '【最值得先看的几条（按重要性排序）】',
    top,
    '',
    '【规则版已经给出的建议（可以参考，但不必重复）】',
    rules,
    '',
    '请给出你的分析与建议。',
    '',
    '【输出格式（必须严格遵守）】',
    '第一行只写： 【建议】',
    '然后最多 3 行，每行以 "- " 开头，每条不超过 40 字；',
    '最后一行只写： 【结束】',
    '除了这三部分，**不要输出任何其它内容**（尤其是你的思考过程、推理、字数统计、格式检查）。',
  ].join('\n');
}
