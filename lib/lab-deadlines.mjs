// lab-deadlines.mjs —— 从「lab 讲义 PDF」的正文里摘出截止时间（2026-10-05）
//
// 用户原话："每一个 ENGR1010J 的 lab session 的 deadline 留存在每一个 lab 的 pdf 中，
//            ENGR1010J 的 deadline 从这里摘取。"
//
// 为什么必须走这条路：ENGR1010J 的 lab 在 Canvas 上**没有 due_at** —— 真正的截止时间只写在
// 讲义正文里（实测 Lab1：「The deadline for online submission is Friday, 2026/10/16, at 23:59」）。
// Canvas 接口给不出这个信息，只能读讲义。
//
// 三条原则（和项目里其它"从材料里读东西"的地方同一条纪律）：
//   ① **要有语义词**：只有当"截止/到期/提交"这类词与一个**完整日期**出现在同一小段里才认 —— 宁可漏，不可编；
//   ② **抽不到就说抽不到**：返回 `ok:false` + 原因，绝不猜一个日期；没有年份的 `10/16` 一律不认；
//   ③ **时间的解释只有一条规则**：原文写了几点就用几点；只写了日期就按全系统规则＝**当天 23:59**
//      （与 lib/duedate.mjs 完全一致，并在结果里用 `time_assumed` 标出来，界面能如实说"时间是我补的"）。

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** "这是不是一句在说截止时间"的语义词。中英文都认，但必须和日期同时出现（见 parseLabDeadline）。 */
export const DEADLINE_KEYWORD = /(deadline|due\s+date|due\s+time|\bdue\b|submit|submission|截止|提交|上交)/i;

/** 语义词往后看多少字符找日期。太短会漏"…is Friday, 2026/10/16"这种隔了一个星期的写法；太长会串到下一段。 */
const WINDOW_AFTER = 200;
/** 语义词往前看多少字符（"截止时间是 10/16" 这种日期可能在词前面）。 */
const WINDOW_BEFORE = 40;

const pad = (n) => String(n).padStart(2, '0');

/** 把 PDF 正文压成一行：换行/多空格不影响"同一个小段里找日期"这件事。 */
export function normalizeLabText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** `FA26_ENGR1010J_Week3_Lab1.pdf` → 1；`lab_02-xxx.pdf` → 2；认不出返回 null。 */
export function labNoFromName(name) {
  const m = String(name || '').match(/(?:^|[^A-Za-z])lab[\s_-]*0*(\d{1,2})/i);
  return m ? Number(m[1]) : null;
}

/** 真实的年月日（挡掉 2026/02/31 这种）。合法返回 {y,m,d}，否则 null。 */
function checkDate(y, m, d) {
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return { y, m, d };
}

/** 在这一小段里找"完整日期"。**没有年份的一律不认**（猜年份就是编）。 */
export function pickDate(window) {
  const text = String(window || '');
  let m = text.match(/\b(20\d{2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\b/);   // 2026/10/16 · 2026-10-16
  if (m) { const c = checkDate(+m[1], +m[2], +m[3]); if (c) return { ...c, raw: m[0] }; }
  m = text.match(/\b(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);                  // 2026年10月16日
  if (m) { const c = checkDate(+m[1], +m[2], +m[3]); if (c) return { ...c, raw: m[0] }; }
  m = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/);   // October 16, 2026
  if (m && MONTHS[m[1].toLowerCase()]) {
    const c = checkDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    if (c) return { ...c, raw: m[0] };
  }
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/);   // 16 October 2026
  if (m && MONTHS[m[2].toLowerCase()]) {
    const c = checkDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    if (c) return { ...c, raw: m[0] };
  }
  return null;
}

/** 在这一小段里找时刻。认 `23:59` / `11:59 pm` / `midnight` / `noon`；没有返回 null。 */
export function pickTime(window) {
  const text = String(window || '');
  let m = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) return { h, min, raw: m[0] };
  }
  m = text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[2].toLowerCase() === 'pm') h += 12;
    return { h, min: 0, raw: m[0] };
  }
  if (/\bmidnight\b/i.test(text)) return { h: 23, min: 59, raw: 'midnight' };
  if (/\bnoon\b/i.test(text)) return { h: 12, min: 0, raw: 'noon' };
  return null;
}

/** 取包含某个位置的"一句"（给界面显示证据用；只做展示，不参与判定）。 */
function sentenceAt(flat, index) {
  const start = Math.max(0, flat.lastIndexOf('.', index) + 1);
  let end = flat.indexOf('.', index);
  if (end === -1) end = Math.min(flat.length, index + 160);
  return flat.slice(start, end + 1).trim().slice(0, 220);
}

/**
 * 从一段讲义正文里摘截止时间。
 *
 * @returns {{ok:true, due_at:string, time_assumed:boolean, evidence:string, raw_date:string, raw_time:string}}
 *        | {{ok:false, reason:string}}
 *        `due_at` 形如 `2026-10-16T23:59`（本地时间，给任务用）。
 */
export function parseLabDeadline(text) {
  const flat = normalizeLabText(text);
  if (!flat) return { ok: false, reason: '这份 PDF 没有文字层（扫描件 / 图片版）—— 要读它得走 OCR 或视觉模型' };
  const re = new RegExp(DEADLINE_KEYWORD.source, 'gi');
  let hit;
  while ((hit = re.exec(flat))) {
    // 「due to」是"因为"，不是截止 —— 跳过这一处，别把它当语义词
    if (/^due$/i.test(hit[0]) && /^\s*to\b/i.test(flat.slice(hit.index + hit[0].length))) continue;
    const window = flat.slice(Math.max(0, hit.index - WINDOW_BEFORE), hit.index + WINDOW_AFTER);
    const date = pickDate(window);
    if (!date) continue;
    const time = pickTime(window);
    return {
      ok: true,
      due_at: `${date.y}-${pad(date.m)}-${pad(date.d)}T${pad(time ? time.h : 23)}:${pad(time ? time.min : 59)}`,
      time_assumed: !time,
      evidence: sentenceAt(flat, hit.index),
      raw_date: date.raw,
      raw_time: time ? time.raw : '',
    };
  }
  return { ok: false, reason: '正文里没有「截止语义词 + 完整日期」的组合（宁可漏也不猜）' };
}
