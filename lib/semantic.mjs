// 语义兜底：规则拿不准的"中间带"条目，交给 agent 判一次（P2）。
//
// 三条边界（刻意的）：
//   1) **只在非高峰批处理** —— 花模型调用的事排到半价时段（见 lib/peak.mjs）。
//   2) **只处理中间带** —— 规则已经能判 push/drop 的不再问，省调用也省时间。
//   3) **理由必须写回来** —— 结果回填到条目上，界面上仍能看到"为什么"。
//
// 本文件是纯函数：拼提示词 / 解析回复 / 套用结果。真正的模型调用由 server.mjs 里的 askCodex 完成。

export const SEMANTIC_VERSION = 'semantic.v1';
export const MAX_ITEMS_PER_RUN = 10;

/** 拼提示词：给 agent 一份"我是谁" + 一批候选条目，要它逐条判。 */
export function buildSemanticPrompt(profile = {}, items = []) {
  const lines = [];
  lines.push('你在帮一个人筛选外部信息。只做判断，不要执行任何操作，不要读写文件。');
  lines.push('');
  lines.push('【这个人的画像】');
  lines.push(`- 关注的关键词：${(profile.keywords || []).join('、') || '（未填）'}`);
  lines.push(`- 他的课程代码：${(profile.courseCodes || []).join('、') || '（未填）'}`);
  lines.push(`- 关注的人/组织：${(profile.allowSenders || []).join('、') || '（未填）'}`);
  lines.push(`- 不想看的：${(profile.denyKeywords || []).join('、') || '（未填）'}`);
  lines.push('');
  lines.push('【候选条目】');
  items.forEach((it, i) => {
    const meta = [it.source, it.due_at || it.start_at].filter(Boolean).join(' · ');
    lines.push(`${i + 1}. 标题：${String(it.title || '').slice(0, 120)}${meta ? `（${meta}）` : ''}`);
    if (it.notes) lines.push(`   摘要：${String(it.notes).slice(0, 160)}`);
  });
  lines.push('');
  lines.push('【输出要求】');
  lines.push('只输出一个 JSON 数组，不要任何解释或代码块标记。每个元素形如：');
  lines.push('[{"n":1,"relevant":true,"reason":"一句话理由"}]');
  lines.push('relevant=true 表示"这个人会在意，值得提醒"；false 表示"可忽略"。');
  return lines.join('\n');
}

/** 从 agent 回复里抠出判断结果。容错：代码块/前后废话/行式输出都能认。 */
export function parseSemanticReply(text = '') {
  const raw = String(text);
  // 1) 先试 JSON 数组（允许被 ``` 包住）
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced ? fenced[1] : null, raw].filter(Boolean);
  for (const c of candidates) {
    const start = c.indexOf('[');
    const end = c.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const arr = JSON.parse(c.slice(start, end + 1));
        const out = normalizeArray(arr);
        if (out.length) return out;
      } catch { /* 继续尝试下一种 */ }
    }
  }
  // 2) 行式兜底：形如 "3. yes - 理由" / "3: 不相关：理由"
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[.、:：-]?\s*(是|否|相关|不相关|yes|no|true|false|relevant|irrelevant)?\s*[：:\-—]?\s*(.*)$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const word = String(m[2] || '').toLowerCase();
    let relevant = null;
    if (['是', '相关', 'yes', 'true', 'relevant'].includes(word)) relevant = true;
    if (['否', '不相关', 'no', 'false', 'irrelevant'].includes(word)) relevant = false;
    if (relevant === null) continue;
    out.push({ n, relevant, reason: String(m[3] || '').trim().slice(0, 120) });
  }
  return out;
}

function normalizeArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((row, idx) => {
    if (!row || typeof row !== 'object') return null;
    const n = Number(row.n ?? row.index ?? row.id ?? idx + 1);
    const rel = row.relevant ?? row.related ?? row.keep;
    if (!Number.isFinite(n)) return null;
    if (typeof rel !== 'boolean') return null;
    return { n, relevant: rel, reason: String(row.reason || row.why || '').slice(0, 120) };
  }).filter(Boolean);
}

/**
 * 把判断套到条目上：相关 → 建议放行；不相关 → 建议忽略。
 * 返回 [{ item, verdict, score, reasons }]，供写库使用。
 */
export function applySemanticResults(items = [], results = []) {
  const byIndex = new Map(results.map((r) => [Number(r.n), r]));
  const out = [];
  items.forEach((item, idx) => {
    const hit = byIndex.get(idx + 1);
    if (!hit) return;
    const verdict = hit.relevant ? 'push' : 'drop';
    const score = hit.relevant ? 4 : -4;
    out.push({
      item,
      verdict,
      score,
      reasons: [{ rule: 'semantic', delta: hit.relevant ? 4 : -4, note: `语义判断：${hit.reason || (hit.relevant ? '与你相关' : '与你无关')}` }],
    });
  });
  return out;
}
