// course-assist.mjs —— 课程辅助的**纯逻辑**（D4：资料信息整理整合）
//
// 为什么要有它：课程辅助那六件事（资料索引 / 作业估时 / 每周巩固 / 常见错误 /
// 考前抱佛脚 / 练习反馈）听起来是六个功能，其实是**同一件事的不同出口** ——
// 先把"课程材料是什么、讲了什么、在哪一段"变成结构化的事实，再在上面做加工。
// 这一层就负责那个"变成事实"的部分，而且全部是纯函数：
// 给一个目录 → 得到课程、周次、每份材料的类型/大小/能不能读/关键词。
//
// 三条刻意的做法：
//   1) **只读**：只扫目录 + 读文件，不写、不改、不移动任何课程材料；
//   2) **读不出来就说读不出来**：扫描版 PDF / 图片 / 压缩包/ 视频 → 如实标
//      `needs_ocr` / `unsupported`，绝不假装抽到了内容（审核者是学生本人，最恨编的）；
//   3) **不调用模型**：关键词是本地启发式（`coursetext.keywordsOf`），零成本、离线可用。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { classifyFile, extractText, keywordsOf, looksGarbled } from './coursetext.mjs';
import { localPath } from './local-config.mjs';

/** 课程资料总目录：环境变量 > `<数据目录>/paths.json` 的 course_dir > 未配置。 */
export function resolveCourseDir({ dataDir = '', env = process.env } = {}) {
  return localPath({
    envKey: ['PLANNER_COURSE_DIR'],
    configKey: ['course_dir', 'course_materials_dir'],
    dataDir, env,
  });
}

/** 能读成文字的格式（其余只能登记、不能抽内容）。 */
export const READABLE_KINDS = ['text', 'notebook', 'slides', 'doc', 'pdf'];

/** 从文件名里读周次：`..._Week3_...` / `Week 3` / `W3` / `第3周` 都认。 */
export function weekOf(name) {
  const s = String(name || '');
  let m = s.match(/week[\s_-]*(\d{1,2})/i);
  if (m) return Number(m[1]);
  m = s.match(/第\s*(\d{1,2})\s*周/);
  if (m) return Number(m[1]);
  m = s.match(/\bw(\d{1,2})\b/i);
  return m ? Number(m[1]) : null;
}

/** 从文件夹名或文件名里读课程代码，例如 `MATH1860J`。 */
export function courseCodeOf(name) {
  const m = String(name || '').match(/\b([A-Z]{2,6}\d{3,4}[A-Z]?)\b/);
  return m ? m[1] : null;
}

const DIR_SKIP = new Set(['__MACOSX', '.ipynb_checkpoints', 'node_modules']);
const isHidden = (n) => String(n).startsWith('.') || String(n).startsWith('_');

/**
 * 扫一遍课程资料目录。
 *
 * 约定：**一级子文件夹 = 一门课**（例如 `MATH1860J 高等数学B1/`），
 * 文件夹里直接放材料；`_`、`.` 开头的目录（例如 `_重名或重复（可删）`、`__MACOSX`）跳过。
 *
 * @returns {{ok:boolean, root:string, courses:Array, files:number, skipped:string[], error?:string}}
 */
export function scanCourseMaterials(root, { maxDepth = 3, maxFiles = 2000 } = {}) {
  if (!root) return { ok: false, root: '', courses: [], files: 0, skipped: [], error: '还没配置课程资料目录' };
  if (!existsSync(root)) return { ok: false, root, courses: [], files: 0, skipped: [], error: `目录不存在：${root}` };

  const courses = [];
  const skipped = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  for (const e of entries) {
    if (DIR_SKIP.has(e.name) || isHidden(e.name)) { if (e.isDirectory()) skipped.push(e.name); continue; }
    if (!e.isDirectory()) continue;                       // 总目录里的散文件不归任何课，先忽略
    const courseDir = join(root, e.name);
    const files = [];
    const walk = (d, depth) => {
      if (depth > maxDepth || files.length >= maxFiles) return;
      let list = [];
      try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const f of list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
        if (DIR_SKIP.has(f.name) || isHidden(f.name)) continue;
        const full = join(d, f.name);
        if (f.isDirectory()) { walk(full, depth + 1); continue; }
        let st = null;
        try { st = statSync(full); } catch { continue; }
        if (st.size === 0) continue;
        files.push({
          name: f.name,
          rel: relative(root, full).split('\\').join('/'),
          abs: full,
          kind: classifyFile(f.name),
          ext: extname(f.name).toLowerCase(),
          size: st.size,
          week: weekOf(f.name),
        });
      }
    };
    walk(courseDir, 1);
    courses.push({
      name: e.name,
      code: courseCodeOf(e.name) || courseCodeOf(files[0]?.name || '') || null,
      dir: courseDir,
      files,
      weeks: [...new Set(files.map((f) => f.week).filter((w) => w != null))].sort((a, b) => a - b),
    });
  }
  return { ok: true, root, courses, files: courses.reduce((a, c) => a + c.files.length, 0), skipped };
}

/**
 * 把扫到的材料读成"每份一行"的事实。
 * 只对能读的格式抽文字；抽不动或本来就是图片/视频/压缩包 → 如实标记。
 */
export function readMaterials(courses = [], { maxChars = 20000, maxFiles = 400 } = {}) {
  const out = [];
  let n = 0;
  for (const c of courses) {
    for (const f of c.files) {
      if (n >= maxFiles) { out.push({ ...f, course: c.name, status: 'skipped', note: '这次只读了前一批' }); continue; }
      n += 1;
      if (!READABLE_KINDS.includes(f.kind)) {
        out.push({ ...f, course: c.name, status: f.kind === 'image' ? 'needs_ocr' : 'unsupported', note: f.kind === 'image' ? '图片没有文字层' : '这类文件不抽文字' });
        continue;
      }
      let r = null;
      try { r = extractText(f.abs, { maxChars }); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
      if (!r || r.ok !== true) {
        out.push({ ...f, course: c.name, status: r && r.needsOcr ? 'needs_ocr' : 'unreadable', note: (r && r.error) || '读不出来', segments: null });
        continue;
      }
      if (r.garbled) {
        // 乱码文件里常常还有"正常字体的那几段"（标题、页眉、书目信息）——
        // 把它们救回来，搜索至少还能命中标题；其余照实标"要自己看原文"。
        const salvaged = (r.segments || []).filter((s) => String(s).length > 24 && !looksGarbled(s));
        out.push({
          ...f, course: c.name, status: 'garbled',
          note: salvaged.length
            ? `大部分是乱码（特殊字体/子集字体），只认出 ${salvaged.length} 段能读的（多半是标题）`
            : '抽出来是乱码（多半是特殊数学字体/子集字体），这份要自己看原文',
          chars: r.chars || 0, pages: r.pages || null,
          keywords: salvaged.length ? keywordsOf(salvaged.join('\n'), { max: 6 }) : [],
          text: salvaged.length ? salvaged.join('\n') : undefined,
          segments: salvaged.length ? salvaged : null,
        });
        continue;
      }
      out.push({
        ...f, course: c.name,
        status: r.lowQuality ? 'low_quality' : 'ok',
        note: r.lowQuality ? '文字抽出来了但不太清楚（建议对一下原文）' : '',
        chars: r.chars || 0, pages: r.pages || null, truncated: !!r.truncated,
        keywords: keywordsOf(r.text, { max: 8 }),
        text: r.text,
        segments: r.segments || null,
      });
    }
  }
  return out;
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/**
 * 生成「课程资料索引」（Markdown）。
 * 内容只来自扫到的文件与抽出来的文字 —— 没有的东西不写、不编。
 */
export function buildMaterialIndex({
  root = '', materials = [], generatedAt = '', courseFilter = '', courseNames = [],
} = {}) {
  const rows = courseFilter
    ? materials.filter((m) => String(m.course || '').toLowerCase().includes(String(courseFilter).toLowerCase()))
    : materials;
  const stats = {
    files: rows.length,
    ok: rows.filter((m) => m.status === 'ok').length,
    low_quality: rows.filter((m) => m.status === 'low_quality').length,
    garbled: rows.filter((m) => m.status === 'garbled').length,
    needs_ocr: rows.filter((m) => m.status === 'needs_ocr').length,
    unreadable: rows.filter((m) => m.status === 'unreadable').length,
    unsupported: rows.filter((m) => m.status === 'unsupported').length,
    skipped: rows.filter((m) => m.status === 'skipped').length,
    by_kind: rows.reduce((a, m) => { a[m.kind] = (a[m.kind] || 0) + 1; return a; }, {}),
  };
  const byCourse = new Map();
  for (const m of rows) {
    if (!byCourse.has(m.course)) byCourse.set(m.course, []);
    byCourse.get(m.course).push(m);
  }
  // 空文件夹也要如实列出来（"这门课还没有材料"是有用的信息，不该悄悄消失）
  for (const n of courseNames) if (!byCourse.has(n)) byCourse.set(n, []);

  const L = [];
  L.push('# 课程资料索引');
  L.push('');
  L.push(`> ${generatedAt ? `生成时间：${generatedAt} · ` : ''}目录：\`${root || '（未配置）'}\`${courseFilter ? ` · 只看：${courseFilter}` : ''}`);
  L.push(`> 共 ${byCourse.size} 门课 / ${stats.files} 份材料 —— 可读 ${stats.ok} · 不太清楚 ${stats.low_quality} · **乱码** ${stats.garbled} · 需 OCR ${stats.needs_ocr} · 读不了 ${stats.unreadable} · 不抽文字 ${stats.unsupported}${stats.skipped ? ` · 这批没读 ${stats.skipped}` : ''}`);
  L.push('> 判定标准：抽不出文字层的（扫描版 PDF / 图片）标"需 OCR"；抽出来是字形编号的标"乱码"（数学字体很常见，要自己看原文）；视频、压缩包这类本来就不抽文字，单列在最后。');
  L.push('');
  L.push('这份索引只做一件事：**让你知道每门课有哪些材料、各自讲什么、哪一份在第几周**。');
  L.push('它不会替你总结内容、也不会猜——读不出来的（扫描件、图片、压缩包、视频）在这里如实标出来。');
  L.push('');

  L.push('## 课程总览');
  L.push('');
  L.push('| 课程 | 材料 | 可读 | 需 OCR | 覆盖周次 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const [name, list] of [...byCourse.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    const weeks = [...new Set(list.map((m) => m.week).filter((w) => w != null))].sort((a, b) => a - b);
    L.push(`| ${cell(name)} | ${list.length} | ${list.filter((m) => m.status === 'ok' || m.status === 'low_quality').length} | ${list.filter((m) => m.status === 'needs_ocr').length} | ${weeks.length ? weeks.map((w) => `W${w}`).join('、') : '—'} |`);
  }
  L.push('');

  for (const [name, list] of [...byCourse.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    L.push(`## ${cell(name)}`);
    L.push('');
    if (!list.length) {
      L.push('（这个文件夹里还没有材料。）');
      L.push('');
      continue;
    }
    const weeks = [...new Set(list.map((m) => m.week).filter((w) => w != null))].sort((a, b) => a - b);
    for (const w of [...weeks, null]) {
      // `week` 是 null 或干脆没有 → 都归到「未标注周次」，不能因为字段缺失就把材料丢掉
      const inWeek = list.filter((m) => (m.week == null ? null : m.week) === w);
      if (!inWeek.length) continue;
      L.push(`### ${w == null ? '未标注周次' : `Week ${w}`}`);
      L.push('');
      L.push('| 材料 | 类型 | 大小 | 文字 | 主题关键词 |');
      L.push('| --- | --- | --- | --- | --- |');
      for (const m of inWeek.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
        const textCol = m.status === 'ok' ? `${Math.round((m.chars || 0) / 1000)}k 字` : (
          m.status === 'low_quality' ? '不太清楚' : (
            m.status === 'garbled' ? '乱码·看原文' : (
              m.status === 'needs_ocr' ? '需 OCR' : (m.status === 'unsupported' ? '不抽文字' : (m.status === 'skipped' ? '这批没读' : '读不出来')))));
        L.push(`| \`${cell(m.name)}\` | ${m.kind}${m.pages ? ` ${m.pages} 页段` : ''} | ${fmtSize(m.size)} | ${textCol} | ${cell((m.keywords || []).slice(0, 6).join('、'))} |`);
      }
      L.push('');
    }
  }

  const problems = rows.filter((m) => ['needs_ocr', 'unreadable', 'garbled'].includes(m.status));
  if (problems.length) {
    L.push('## 机器读不进去的（要你自己翻）');
    L.push('');
    for (const m of problems) L.push(`- \`${cell(m.rel || m.name)}\` —— ${cell(m.note) || '读不出来'}`);
    L.push('');
  }
  return { markdown: `${L.join('\n').trimEnd()}\n`, stats };
}

/** 一句话汇总（进通知/日志用）。 */
export function summarizeIndex(stats = {}) {
  return `${stats.files || 0} 份材料：可读 ${stats.ok || 0}，乱码 ${stats.garbled || 0}，需 OCR ${stats.needs_ocr || 0}，读不了 ${(stats.unreadable || 0) + (stats.unsupported || 0)}`;
}

// ---------------------------------------------------------------- 能力③：每周巩固

/** 从正文里挑"像标题/像题目/像要记的东西"的行（纯启发式，只摘不编）。 */
export function pickLines(text, { pattern, max = 8, minLen = 8 } = {}) {
  const out = [];
  for (const raw of String(text || '').split(/\n+/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < minLen || line.length > 220) continue;
    if (!pattern.test(line)) continue;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

const RE_EXERCISE = /(\bexercise\b|\bproblem\b|\bexample\b|\bsolution\b|\btask\b|例\s*\d|习题|练习|例题)/i;
const RE_QUESTION = /(\?|？)\s*$/;
const RE_HEADING = /^(chapter|section|lecture|week|part|outline|summary|remark|theorem|definition|lemma|proposition|定义|定理|引理|性质|小结|要点)\b/i;

/** 今天是学期第几周（按校历的开学日算；没有校历就返回 null，不猜）。 */
export function weekNumberFrom(termStart, now = Date.now()) {
  const t0 = Date.parse(String(termStart || ''));
  if (!Number.isFinite(t0)) return null;
  const d0 = new Date(t0);
  d0.setHours(0, 0, 0, 0);
  const d1 = new Date(now);
  d1.setHours(0, 0, 0, 0);
  const n = Math.floor((d1.getTime() - d0.getTime()) / (7 * 86400000)) + 1;
  return n >= 1 ? n : null;
}

/**
 * 生成「第 N 周巩固包」（Markdown）。
 *
 * 一条**最重要的原则**：只从材料里**摘**，不替材料**编**。
 *   * 考点 = 该周材料里的标题行 + 关键词（机器读得出来的那些材料）；
 *   * 例题 / 自测题 = 材料里带 `Exercise / Problem / Example / ?` 的行；
 *   * 摘不到就**如实写"材料里没找到"**，并指出该自己翻哪份材料 —— 绝不自己造题。
 */
export function buildWeeklyPack({
  course = '', week = 1, materials = [], generatedAt = '',
  errors = [], practice = [],
} = {}) {
  const wk = Number(week) || 1;
  const inWeek = materials.filter((m) => Number(m.week) === wk);
  // 一节课一门课、一周一堆课：**按课程分开写**，不然"这门课"到底指哪门都说不清。
  const isReadable = (m) => (m.status === 'ok' || m.status === 'low_quality') && m.text;
  const groups = new Map();
  for (const m of inWeek) {
    const key = m.course || course || '（未标课程）';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  if (course && groups.size > 1) {                 // 指定了课程 → 只算这门
    for (const k of [...groups.keys()]) if (!k.toLowerCase().includes(String(course).toLowerCase())) groups.delete(k);
  }

  const allReadable = inWeek.filter(isReadable);
  const topKeywords = [...new Set(allReadable.flatMap((m) => (m.keywords || []).slice(0, 5)))].slice(0, 14);

  const L = [];
  L.push(`# 第 ${wk} 周巩固包${course ? ` · ${course}` : '（各科）'}`);
  L.push('');
  L.push(`> ${generatedAt ? `生成时间：${generatedAt} · ` : ''}来源：第 ${wk} 周的 ${inWeek.length} 份材料（${groups.size} 门课，机器读得出来 ${allReadable.length} 份）`);
  L.push('> 这份东西**只从你自己的课件里摘**：摘不到的会明说"没找到"，不会替你编题、编考点。');
  L.push('');

  L.push('## 这周有什么（按课程）');
  L.push('');
  L.push('| 课程 | 材料 | 机器读得出来 | 需要你自己翻 |');
  L.push('| --- | --- | --- | --- |');
  for (const [name, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    L.push(`| ${cell(name)} | ${list.length} | ${list.filter(isReadable).length} | ${list.filter((m) => !isReadable(m)).length} |`);
  }
  L.push('');
  L.push(`**这周材料里的高频词**：${topKeywords.length ? topKeywords.join('、') : '（没有抽到关键词）'}`);
  L.push('');

  const totals = { topics: 0, examples: 0, questions: 0, unreadable: 0, readable: 0, materials: inWeek.length };
  for (const [name, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    const readable = list.filter(isReadable);
    const unreadable = list.filter((m) => !isReadable(m));
    const topics = [];
    const examples = [];
    const questions = [];
    for (const m of readable) {
      for (const line of pickLines(m.text, { pattern: RE_HEADING, max: 6 })) topics.push({ file: m.name, line });
      for (const line of pickLines(m.text, { pattern: RE_EXERCISE, max: 6 })) {
        examples.push({ file: m.name, line });
        if (RE_QUESTION.test(line) || /^\s*(exercise|problem|习题|练习|例)/i.test(line)) questions.push({ file: m.name, line });
      }
    }
    const quiz = questions.slice(0, 8);
    totals.topics += topics.length; totals.examples += examples.length; totals.questions += quiz.length;
    totals.unreadable += unreadable.length; totals.readable += readable.length;

    L.push(`## ${cell(name)}`);
    L.push('');
    L.push(`### ① 考点 / 讲了什么（从材料里摘的标题行）`);
    L.push('');
    if (topics.length) for (const t of topics.slice(0, 10)) L.push(`- ${t.line}　<span>（${t.file}）</span>`);
    else L.push('- （机器没从这门课这周的材料里认出标题行 —— 大概率是字体抽不出来，见下面"要自己翻的"）');
    L.push('');
    L.push('### ② 例题 / 习题（原文摘录，附出处）');
    L.push('');
    if (examples.length) examples.slice(0, 10).forEach((e, i) => L.push(`${i + 1}. ${e.line}　<span>（${e.file}）</span>`));
    else L.push('- 没能从材料里摘出例题（多半是扫描件 / 数学字体，正文抽不出来）。');
    L.push('');
    L.push('### ③ 自测题（摘录，不是编的）');
    L.push('');
    if (quiz.length) quiz.forEach((q, i) => L.push(`- [ ] ${i + 1}. ${q.line}　<span>（${q.file}）</span>`));
    else L.push('- 材料里没有可自动摘出的题目。**与其编几道假的，不如照下面"要自己翻的"过一遍原文。**');
    L.push('');
    L.push('### ④ 要自己翻的');
    L.push('');
    if (unreadable.length) for (const m of unreadable) L.push(`- \`${m.name}\` —— ${m.status === 'garbled' ? '正文是乱码（数学字体），要自己看原文' : (m.status === 'needs_ocr' ? '没有文字层，需要 OCR' : '这类文件不抽文字')}`);
    else L.push('- 这门课这周的材料机器都读得出来。');
    L.push('');
  }

  L.push('## 易错点 / 我错过的地方');
  L.push('');
  if (Array.isArray(practice) && practice.length) {
    for (const p of practice.slice(0, 10)) L.push(`- ${String(p.text || p.title || '').trim()}`);
  } else {
    L.push('- 还没有错题/练习记录（这块要等你用「练习反馈」记过几次才有料）。');
  }
  if (Array.isArray(errors) && errors.length) {
    L.push('');
    L.push('作业反馈里提到的：');
    for (const e of errors.slice(0, 8)) L.push(`- ${String(e).trim()}`);
  }
  L.push('');

  L.push('---');
  L.push('');
  L.push('### 怎么用这份东西');
  L.push('');
  L.push('1. 先把「要自己翻的」那几份原文过一遍（机器读不了，只能你来）；');
  L.push('2. 把「自测题」当检验：**做不出来**的，就是这周没懂的；');
  L.push('3. 做不出来的题记进「练习反馈」（下一步会做），考前"抱佛脚"文档就是从那里长出来的。');

  return {
    markdown: `${L.join('\n').trimEnd()}\n`,
    stats: {
      week: wk, courses: groups.size, materials: inWeek.length, readable: totals.readable,
      topics: totals.topics, examples: totals.examples, questions: totals.questions,
      unreadable: totals.unreadable, keywords: topKeywords.length,
    },
  };
}

/**
 * 在**已经读过的材料**里找一段话（不重新读盘）。
 * 命中就给出"哪门课、哪个文件、第几段（≈第几页）附近"。
 *
 * 先找**文件名**、再找正文：真课件里有相当一部分 PDF 的正文抽不出来（数学字体 / 扫描件），
 * 但"Lec 02 - Association and Casality.pdf"这样的文件名本身就把主题写在脸上 ——
 * 只搜正文的话，这些材料等于不存在。命中的地方会如实标出来（`where`）。
 */
export function searchMaterials(materials = [], query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];
  const hits = [];
  for (const m of materials) {
    if (String(m.name || '').toLowerCase().includes(needle)
      || String(m.rel || '').toLowerCase().includes(needle)
      || String(m.course || '').toLowerCase().includes(needle)) {
      hits.push({
        course: m.course, name: m.name, rel: m.rel, segment: null, where: '文件名',
        context: String(m.rel || m.name || ''),
      });
      if (!m.text) continue;
    }
    if (!m.text) continue;
    const inText = m.text.toLowerCase().indexOf(needle);
    if (inText < 0) continue;
    let segment = null;
    if (Array.isArray(m.segments)) {
      const idx = m.segments.findIndex((s) => String(s || '').toLowerCase().includes(needle));
      if (idx >= 0) segment = idx + 1;
    }
    const from = Math.max(0, inText - 60);
    hits.push({
      course: m.course, name: m.name, rel: m.rel, segment, where: '正文',
      context: m.text.slice(from, from + 160).replace(/\s+/g, ' ').trim(),
    });
  }
  return hits;
}
