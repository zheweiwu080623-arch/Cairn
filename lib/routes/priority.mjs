// routes/priority.mjs —— 「按未来规划给重要信息排序 + 给建议」的接口
//
//    GET  /api/priority         → 未来规划上下文 + 排序后的重要信息 + 规则版建议
//    GET  /api/plan/goals       → 读你自己写的未来规划
//    POST /api/plan/goals       → 写未来规划（一行一条）
//    POST /api/priority/advice  → 让 agent 写一份"分析 + 建议"（非高峰才跑；高峰用规则版兜底）
//    GET|POST /api/priority/autopush → 「重要 ≥ 阈值自动进通知 / 推手机」开关与预览（默认关）
//
// 为什么单独一个文件：这是新功能的第一块，逻辑集中在 lib/priority.mjs（纯函数），
// 这里只做"从数据库取料 → 算 → 回话"。想改打分规则去改 lib/priority.mjs，不用动接口。
//
// 两条设计约束：
//   1) **不改变现有行为**：这条链路只"读 + 排序 + 解释"，不自动推送、不改通知；
//      （想让高重要性的自动进通知，是下一步的事，会单独做成开关。）
//   2) **不联网也能用**：规则版建议离线可用；只有你点"让 agent 分析"才联网，且只在非高峰。

import {
  EMPTY_GOALS, HORIZON_DAYS, buildAdvice, buildPlanContext, normalizeGoals, rankByImportance,
} from '../priority.mjs';
import {
  AUTOPUSH_KEY, AUTOPUSH_RESULT_KEY, describeAutopush, normalizeAutopush, selectAutopush,
} from '../autopush.mjs';

export const GOALS_KEY = 'plan_goals_json';

/** 参与排序的条目上限（名单太长也没意义，界面只展示前几十条）。 */
const MAX_ITEMS = 200;
const DEFAULT_TOP = 12;

export function createPriorityRoutes(ctx) {
  const {
    store, sendJson, sendError, readBody,
    getProfile, getLearning, learningKeyOf, isPeak, askAgent,
  } = ctx;

  function getGoals() {
    try { return normalizeGoals(JSON.parse(store.getSync(GOALS_KEY) || 'null') || EMPTY_GOALS); } catch { return { ...EMPTY_GOALS }; }
  }

  function setGoals(next) {
    const g = normalizeGoals({ ...next, updated_at: Date.now() });
    store.setSync(GOALS_KEY, JSON.stringify(g));
    return g;
  }

  /**
   * 收集"要排序的料"：**还没处理的外部条目** + **还没过期的提醒**（去重）。
   *
   * 为什么要挑：库里可能有几百条历史通知，全塞进来会把真正要紧的挤下去。
   * 规则（2026-09-22）：提醒只收「启用中的」且「触发时间在最近 14 天 ~ 未来 30 天之间」，
   * 另外"重要来源"（priority=1）不受时间窗口限制。
   */
  function collectItems() {
    const out = [];
    const seen = new Set();
    const now = Date.now();
    const from = now - 14 * 86400000;
    const to = now + 30 * 86400000;
    const push = (row, origin) => {
      const title = String(row.title || '').trim();
      if (!title) return;
      const key = `${row.source || ''}|${title}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        id: `${origin}:${row.id}`,
        origin,
        source: row.source || 'app',
        kind: row.kind || 'reminder',
        title,
        notes: row.notes || row.message || '',
        due_at: row.due_at || row.trigger_at || null,
        start_at: row.start_at || null,
        url: row.url || null,
        verdict: row.verdict || null,
        score: Number.isFinite(row.score) ? row.score : null,
      });
    };
    for (const row of store.listPending() || []) push(row, 'pending');
    const notifRows = [];
    for (const n of store.listNotifications() || []) {
      // 「自动推送」自己建的通知（source=priority）不再进榜 —— 否则会自己喂自己，
      // 推出去的那条下次又被算成"新信息"，无限循环。
      if (String(n.source || '') === 'priority') continue;
      if (n.enabled === false || n.enabled === 0) continue;       // 关掉的提醒不算
      const t = Date.parse(String(n.trigger_at || '')) || 0;
      const inWindow = t >= from && t <= to;
      if (!inWindow && !n.priority) continue;                     // 陈旧的普通提醒直接不收
      notifRows.push(n);
    }
    // **先按"离现在多近"排序，再截断**（2026-09-23 真库踩到的坑）：
    // 库里有 295 条通知，而 listNotifications() 是按时间**从旧到新**返回的；
    // 直接 `if (out.length >= MAX_ITEMS) break` 会把最老的 150 条装满，
    // 今天/明天的条目（例如"选 ENGR1010J Lab 组，周五截止"）整段被挤掉 ——
    // 界面于是只显示旧邮件，看起来像"没有重要的事"。
    const closeness = (n) => {
      const t = Date.parse(String(n.trigger_at || '')) || 0;
      return t > 0 ? Math.abs(t - now) : Number.MAX_SAFE_INTEGER;
    };
    notifRows.sort((a, b) => closeness(a) - closeness(b));
    for (const n of notifRows) {
      push(n, 'notification');
      if (out.length >= MAX_ITEMS) break;
    }
    return out.slice(0, MAX_ITEMS);
  }

  function computePriority({ top = DEFAULT_TOP } = {}) {
    const goals = getGoals();
    const now = Date.now();
    const context = buildPlanContext({
      tasks: store.listTasks(),
      events: store.listEvents(),
      milestones: store.listMilestones(),
      academic: store.listAcademic(),
      courses: store.listCourses(),
      profile: getProfile(),
      goals,
    }, { now, horizonDays: HORIZON_DAYS });

    const learning = getLearning();
    const items = collectItems();
    const result = rankByImportance(items, context, {
      now,
      learningFor: (item) => {
        const key = learningKeyOf(item);
        return { accept: learning.accept?.[key] || 0, reject: learning.reject?.[key] || 0 };
      },
    });
    return { context, result, advice: buildAdvice(result, context), learning };
  }

  // ---- 自动推送（重要 ≥ 阈值 → 进通知 / 推手机）----
  // 这里只管"设置读写 + 预览哪几条会被推"；真正建通知与发 Bark 在 server.mjs
  // （那两件事要碰数据库和网络，不适合放在这个只读排名的文件里）。
  function getAutopush() {
    try { return normalizeAutopush(JSON.parse(store.getSync(AUTOPUSH_KEY) || 'null')); } catch { return normalizeAutopush(null); }
  }

  function setAutopush(patch = {}) {
    const next = normalizeAutopush({ ...getAutopush(), ...(patch || {}), updated_at: Date.now() });
    store.setSync(AUTOPUSH_KEY, JSON.stringify(next));
    return next;
  }

  function lastAutopushResult() {
    try { return JSON.parse(store.getSync(AUTOPUSH_RESULT_KEY) || 'null'); } catch { return null; }
  }

  /** 预览：**不管开没开**都算一份名单，方便你"先看会被推什么，再决定开不开"。 */
  function previewAutopush(cfg = getAutopush(), ranked = null) {
    const list = ranked || computePriority({ top: DEFAULT_TOP }).result.ranked;
    return selectAutopush(list, { ...cfg, enabled: true })
      .map((x) => ({ key: x.key, title: x.title, band: x.band, importance: x.importance, daysLeft: x.daysLeft ?? null, source: x.source || '' }));
  }

  async function handlePriority(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    // ---- 未来规划（自己写的）----
    if (p === '/api/plan/goals' && method === 'GET') {
      return sendJson(res, 200, { goals: getGoals() });
    }
    if (p === '/api/plan/goals' && method === 'POST') {
      const body = await readBody(req);
      const next = Array.isArray(body?.goals) ? body.goals : [];
      return sendJson(res, 200, { ok: true, goals: setGoals({ goals: next }) });
    }

    // ---- 自动推送设置（读 / 写 + 预览）----
    if (p === '/api/priority/autopush' && method === 'GET') {
      const cfg = getAutopush();
      return sendJson(res, 200, {
        ok: true, cfg, describe: describeAutopush(cfg),
        preview: previewAutopush(cfg), last: lastAutopushResult(),
      });
    }
    if (p === '/api/priority/autopush' && method === 'POST') {
      const body = await readBody(req);
      const patch = body && typeof body === 'object' ? body : {};
      // 「清空已推记录」：只想重推一遍时用（例如你换了一批规划词）
      const cfg = setAutopush(patch.clear_seen === true ? { ...patch, seen: {} } : patch);
      return sendJson(res, 200, {
        ok: true, cfg, describe: describeAutopush(cfg),
        preview: previewAutopush(cfg), last: lastAutopushResult(),
      });
    }

    // ---- 主接口 ----
    if (p === '/api/priority' && method === 'GET') {
      const top = Number(url.searchParams.get('top')) || DEFAULT_TOP;
      const { context, result, advice } = computePriority({ top });
      return sendJson(res, 200, {
        schema: 'priority.v1',
        generated_at: new Date().toISOString(),
        context: {
          goals: context.goals.goals,
          goals_updated_at: context.goals.updated_at,
          horizonDays: context.horizonDays,
          upcoming: context.upcoming.slice(0, 12),
          crowdedDays: context.crowdedDays,
          examSoon: context.examSoon,
          term_terms: context.terms.length,
        },
        counts: result.counts,
        ranked: result.ranked.slice(0, Math.max(1, Math.min(50, top))),
        advice,
        advice_source: 'rules',
        autopush: (() => {
          const cfg = getAutopush();
          return { cfg, describe: describeAutopush(cfg), preview: previewAutopush(cfg, result.ranked), last: lastAutopushResult() };
        })(),
      });
    }

    // ---- 让 agent 写分析与建议（非高峰才跑）----
    if (p === '/api/priority/advice' && method === 'POST') {
      const { context, result } = computePriority({ top: DEFAULT_TOP });
      const rules = buildAdvice(result, context);
      const peak = isPeak(new Date());
      if (peak) {
        return sendJson(res, 200, {
          ok: false, skipped: 'peak', advice: rules, advice_source: 'rules',
          message: '现在是高峰时段，先给你规则版建议（等非高峰再让 agent 做更细的分析）。',
        });
      }
      const prompt = buildAdvicePrompt({ context, result });
      let r;
      try {
        r = await askAgent(prompt);
      } catch (e) {
        r = { ok: false, error: e.message };
      }
      if (!r || r.ok !== true) {
        return sendJson(res, 200, {
          ok: false, error: (r && r.error) || 'agent 没有返回内容',
          advice: rules, advice_source: 'rules',
          message: explainAgentFailure(r && r.error),
        });
      }
      const text = extractAdviceText(r.text);
      if (!text) {
        // 模型只吐了一堆思考过程 → 不把垃圾给用户看，回落规则版并说明
        return sendJson(res, 200, {
          ok: false, via: r.via || null, advice: rules, advice_source: 'rules',
          message: '模型这次只返回了思考过程、没有给出结论（这类推理模型偶尔会这样）。先给你规则版建议。',
        });
      }
      return sendJson(res, 200, { ok: true, text, via: r.via || null, advice_source: 'agent' });
    }

    return sendError(res, 404, '没有这个接口');
  }

  return {
    handlePriority, getGoals, setGoals, computePriority, collectItems,
    getAutopush, setAutopush, previewAutopush, lastAutopushResult,
  };
}

/**
 * agent 失败时给一句"能照着做"的话（而不是丢一串英文错误）。
 * 2026-09-22 实测：多数机器上装的是 Codex **桌面版**，没有 `codex` 命令行，
 * 于是报 `spawn codex ENOENT` —— 这话对用户毫无意义。
 */
export function explainAgentFailure(error) {
  const raw = String(error || '').trim();
  if (/ENOENT|not recognized|不是内部或外部命令|command not found|no such file/i.test(raw)) {
    return '本机没有找到 `codex` 命令行（你用的可能是 Codex 桌面版）。'
      + '两条路：① 到「数据源 → Agent 接入」把模型换成 OpenAI 兼容 / Anthropic / Ollama 里的任意一个；'
      + '② 直接用下面这份规则版建议 —— 它不联网，判断依据和 agent 看到的是同一份数据。';
  }
  if (/timeout|timed out|超时/i.test(raw)) {
    return 'agent 这次等超时了（可能机器正忙或网络慢）。下面这份规则版建议先用着，稍后可以再点一次。';
  }
  if (!raw) return 'agent 没有返回内容，先给你规则版建议；可以到「数据源 → Agent 接入」看看配置。';
  return `agent 这次没答上来（${raw.slice(0, 120)}）。先给你规则版建议，可以到「数据源 → Agent 接入」检查配置。`;
}

/**
 * 给 agent 的提示词。
 * 硬约束写在最前面：**只依据给出的内容，不要编造**（否则它会开始"替你想"不存在的事）。
 */
export function buildAdvicePrompt({ context = {}, result = {} } = {}) {
  const goals = (context.goals?.goals || []).map((g, i) => `${i + 1}. ${g}`).join('\n') || '（还没有写过规划）';
  const upcoming = (context.upcoming || []).slice(0, 12)
    .map((u) => `- ${u.daysLeft} 天后（${u.title}｜${u.kind}）`).join('\n') || '（未来 14 天没有安排）';
  const top = (result.ranked || []).slice(0, 8)
    .map((x) => `- [${x.band} ${x.importance}] ${x.title}（来源 ${x.source}${x.daysLeft != null ? `，${x.daysLeft} 天后` : ''}）｜理由：${x.why}`)
    .join('\n') || '（没有信息）';
  const crowded = (context.crowdedDays || []).map((d) => `- ${d.date} 有 ${d.count} 件事到期`).join('\n') || '（没有撞车日）';

  return [
    '你是一个谨慎的个人助理。下面是一个人的「未来规划」和「刚刚收集到的信息」。',
    '',
    '要求（必须遵守）：',
    '1. **只依据下面的内容**，不要编造任何不存在的时间、事件或信息；',
    '2. 用中文，总长度不超过 200 字，最多 3 条；',
    '3. 每条给"做什么 + 为什么"，具体到能立刻执行的下一步（例如"今晚先写实验报告的引言"）；',
    '4. 如果信息不足以给出建议，就直接说"信息不足，建议先补充 X"。',
    '',
    '【他的未来规划】',
    goals,
    '',
    '【未来 14 天的安排】',
    upcoming,
    '',
    '【同一天挤在一起的截止日】',
    crowded,
    '',
    '【按重要性排过的信息（最多 8 条）】',
    top,
    '',
    '请给出你的分析与建议。',
    '',
    '【输出格式（必须严格遵守）】',
    '第一行只写： 【建议】',
    '然后最多 3 行，每行以 "- " 开头，每条不超过 60 字，写"做什么 + 为什么"；',
    '最后一行只写： 【结束】',
    '除了这三部分，**不要输出任何其它内容**（尤其是你的思考过程、推理、字数统计、格式检查）。',
  ].join('\n');
}

/** 看起来像"模型自己嘀咕"的行（推理过程），不该给用户看。 */
const THINKING_LINE_RE = /^(我们|需要|要|注意|可能|可以|应该|总字数|字数|输出|格式|要求|检查|分析|考虑|首先|然后|接下来|另外|但|所以|因此|这里|示例|例[:：]|让我|我会|我将|回答|建议格式)/;

/**
 * 从模型返回的原文里**只取结论**（2026-09-22 新增，因为实测踩到了坑）。
 *
 * 实测：DeepSeek 这类推理模型经本机中转返回时，会把"我们需要回答…需要不超过200字…
 * 注意不要编造…"这种思考过程也放在正文里。直接展示等于把一堵墙糊到用户脸上。
 * 所以：
 *   1. 优先取 `【建议】…【结束】` 之间的内容（提示词要求它这么包）；
 *   2. 没有标记时，从后往前找**最后一段连续的要点行**（`- ` / `1.` 开头）；
 *   3. 都不行就返回空串 —— 由调用方回落到规则版建议，而不是硬塞一堵墙。
 */
export function extractAdviceText(raw, { maxChars = 600 } = {}) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  // ① 有标记就取标记之间
  const marked = /【建议】([\s\S]*?)(?:【结束】|$)/.exec(text);
  let body = marked ? marked[1] : '';

  // ② 没有标记：从后往前找最后一段连续的要点行
  if (!body.trim()) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const isPoint = (l) => /^([-*·]|\d+[.、)])\s*\S/.test(l);
    let end = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) { if (isPoint(lines[i])) { end = i; break; } }
    if (end >= 0) {
      let start = end;
      while (start - 1 >= 0 && isPoint(lines[start - 1])) start -= 1;
      body = lines.slice(start, end + 1).join('\n');
    } else {
      // ③ 再退一步：逐行剔除明显的"思考行"，只留不像嘀咕的短句
      body = lines.filter((l) => !THINKING_LINE_RE.test(l) && l.length <= 80).join('\n');
    }
  }

  const cleaned = body
    .split('\n')
    .map((l) => l.replace(/^【建议】|【结束】$/g, '').trim())
    .filter((l) => l && !/^【(建议|结束)】$/.test(l) && !THINKING_LINE_RE.test(l))
    .join('\n')
    .trim();
  return cleaned.slice(0, maxChars);
}
