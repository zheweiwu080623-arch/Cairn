// course-stack.mjs —— 课程辅助的**接线层**（和 preclass-stack.mjs 同一个套路）。
//
// 三件事：
//   1) 给 `modules/course-assist/run.js` 注入能力（`ctx.course.*`）：读目录、读材料、生成索引；
//   2) 提供 **`file` 动作的执行能力**：把产物写进 `<数据目录>/study/`，**只准写这里**；
//   3) 把"写文件"这条边界单独放在一个文件里，方便审阅者一眼看全 —— 这是唯一一处
//      会动磁盘的地方（而且只写自己的输出目录，绝不碰你的课程材料）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import {
  buildMaterialIndex, buildWeeklyPack, readMaterials, resolveCourseDir, scanCourseMaterials,
  searchMaterials, weekNumberFrom,
} from './course-assist.mjs';
import { extractText } from './coursetext.mjs';
import {
  LATEX_MAX_CHARS, cleanLatexReply, isNoTextReply, latexOutName, latexPrompt,
  pickReadableMaterials, reviewExtract, visionPrompt,
} from './course-latex.mjs';
import { findRasterizer, renderPdfPages } from './pdf-pages.mjs';
import { createCourseRoutes } from './routes/course.mjs';

export const STUDY_SUBDIR = 'study';

/** 产物目录：`<数据目录>/study/`。 */
export function studyDirOf(dataDir) {
  return join(dataDir, STUDY_SUBDIR);
}

/** 取一个"干净的文件名"（只允许文件名本身，不许带目录、不许 ..）。 */
export function studyPath(studyDir, name) {
  const n = String(name || '').trim();
  if (!n || n.includes('/') || n.includes('\\') || n.includes('..') || n.startsWith('.')) return null;
  return join(studyDir, n);
}

/** 某个绝对路径是不是在产物目录里面（写文件前的最后一道闸）。 */
export function insideStudy(studyDir, fullPath) {
  const base = resolve(studyDir);
  const full = resolve(String(fullPath || ''));
  return full === base || full.startsWith(base + sep);
}

/**
 * `file` 动作的执行能力：把内容写进 `<数据目录>/study/`。
 *
 * 拒绝的三种情况（都不抛，返回 `ok:false` 让动作标成失败并写清原因）：
 *   * 没给路径 / 没给内容；
 *   * 路径在产物目录**外面**（这是安全边界，别改成"看着更短"的写法）；
 *   * 磁盘写失败（权限、被占用）。
 */
export function writeStudyFile(action = {}, { studyDir, dataDir = '' } = {}) {
  const dir = studyDir || studyDirOf(dataDir);
  const raw = action.target?.path || action.payload?.path || '';
  const text = action.payload?.text;
  if (!raw) return { ok: false, error: '动作里没说写到哪个文件' };
  if (typeof text !== 'string' || !text) return { ok: false, error: '动作里没有要写的内容' };
  const full = resolve(String(raw));
  if (!insideStudy(dir, full)) return { ok: false, error: `只允许往 ${resolve(dir)} 里写文件` };
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
    return { ok: true, detail: `已写入 ${full}（${Buffer.byteLength(text, 'utf8')} 字节）` };
  } catch (e) {
    return { ok: false, error: `写不进去：${(e && e.message) || e}` };
  }
}

export function createCourseStack({
  dataDir = '', env = process.env, log = () => {},
  sendJson = null, sendError = null, runsOf = () => null,
  termStart = () => null,                    // 校历开学日（算"第几周"用；没有就如实返回 null）
  askAgent = null,                           // 模型出口（把抽出来的文字还原成 LaTeX 用；没有就如实说做不了）
  readBody = null,                           // POST /api/course/latex 的请求体
} = {}) {
  const studyDir = studyDirOf(dataDir);
  const currentWeek = () => weekNumberFrom(termStart(), Date.now());

  /**
   * 在课件里找一段话（"这道题在哪份材料里"）。
   * 每次现扫现读 —— 换来的是"你刚放进来的材料立刻能搜到"，代价是几秒钟。
   */
  function search(query, { course = '', maxChars = 20000 } = {}) {
    const dir = resolveCourseDir({ dataDir, env });
    const scan = scanCourseMaterials(dir);
    if (!scan.ok) return { ok: false, error: scan.error, hits: [], dir };
    const courses = course
      ? scan.courses.filter((c) => `${c.name} ${c.code || ''}`.toLowerCase().includes(String(course).toLowerCase()))
      : scan.courses;
    const materials = readMaterials(courses, { maxChars });
    const hits = searchMaterials(materials, query);
    return {
      ok: true, dir, course: course || '', query: String(query || ''),
      scanned: materials.length, scanned_courses: courses.length, hits,
    };
  }

  /** 给 `modules/course-assist/run.js` 的能力。 */
  const extraContext = () => ({
    course: {
      dir: () => resolveCourseDir({ dataDir, env }),
      studyDir: () => studyDir,
      outPath: (name) => studyPath(studyDir, name),
      scan: (o) => scanCourseMaterials(resolveCourseDir({ dataDir, env }), o),
      read: (o = {}) => {
        const courses = o.only
          ? (o.courses || []).filter((c) => `${c.name} ${c.code || ''}`.toLowerCase().includes(String(o.only).toLowerCase()))
          : (o.courses || []);
        return readMaterials(courses, o);
      },
      index: (o) => buildMaterialIndex(o),
      weekly: (o) => buildWeeklyPack(o),
      search: (materials, q) => searchMaterials(materials, q),
      currentWeek,
    },
  });

  /** 课件目录里的材料清单（给「公式转 LaTeX」的下拉；不读内容，只看扩展名/大小）。 */
  function materials() {
    const dir = resolveCourseDir({ dataDir, env });
    const scan = scanCourseMaterials(dir, { maxFiles: 800 });
    if (!scan.ok) return { ok: false, dir, error: scan.error, items: [] };
    return { ok: true, dir, items: pickReadableMaterials(scan, { limit: 80 }) };
  }

  /**
   * 把一份课件**转成 Markdown + LaTeX**（公式还原）。
   *
   * 三档如实告知（判断在 lib/course-latex.mjs 的 reviewExtract）：
   *   blocked —— 没有文字层（扫描件）/ 抽出来的字太少：不转，说清为什么、给退路（截图给 Codex）；
   *   warn    —— 文字层有损（LaTeX 排版丢空格、符号被换）：转，但**明确说这是模型重建的**，请对着原 PDF 核；
   *   ok      —— 文字层干净：正常转。
   * 写文件只经过 writeStudyFile（唯一一处落盘，且只允许写 study 目录）。
   */
  async function convertToLatex({
    file = '', rel = '', course = '', maxChars = LATEX_MAX_CHARS,
    mode = 'text',                // 'text' = 读文字层（快、便宜）；'vision' = 渲染成图交给视觉模型（能救"字形编号"的 PDF）
    firstPage = 1, lastPage = 3,  // vision 模式：只渲染这几页（一页一次调用，别一口气把整本塞进去）
  } = {}) {
    const wanted = String(file || '').trim();
    const wantedRel = String(rel || '').trim();
    if (!wanted && !wantedRel) return { ok: false, error: '没说转哪一份材料' };
    if (typeof askAgent !== 'function') return { ok: false, error: '这台机器上没有可用的模型出口（设置 → 数据源 → Agent 接入 里配一下）' };

    const list = materials();
    if (!list.ok) return { ok: false, error: list.error || '读不到课程资料目录', dir: list.dir };
    const pool = course ? list.items.filter((m) => `${m.course} ${m.code}`.toLowerCase().includes(String(course).toLowerCase())) : list.items;
    const hit = (wantedRel && pool.find((m) => m.rel === wantedRel))
      || pool.find((m) => m.file === wanted)
      || pool.find((m) => m.file.toLowerCase() === wanted.toLowerCase());
    if (!hit) return { ok: false, error: `课程资料里找不到这份材料：${wantedRel || wanted}`, dir: list.dir };

    // 真读一遍（这里才可能发现是扫描件 / 乱码）
    // 注意：材料可能在 Week01/ 这类子文件夹里 —— 优先用扫描时记下的绝对路径
    const abs = hit.abs || join(list.dir, hit.rel || join(hit.course, hit.file));

    // ---- 视觉路线：把页面渲染成图 → 视觉模型看着图转（文字层是字形编号的 PDF 只有这条路）----
    if (mode === 'vision') {
      if (!/\.pdf$/i.test(hit.file)) {
        return { ok: false, level: 'blocked', course: hit.course, file: hit.file, error: '视觉路线只对 PDF 有效（其它格式直接读文字层就行）' };
      }
      if (!findRasterizer()) {
        return {
          ok: false, level: 'blocked', course: hit.course, file: hit.file,
          error: '这台机器上没有 PDF 渲染工具（pdftoppm），视觉路线走不了',
          how_to: '退路：把这几页截图发到 Codex 里，让它看着图转 —— 效果一样。',
        };
      }
      const first = Math.max(1, Number(firstPage) || 1);
      const last = Math.max(first, Math.min(first + 4, Number(lastPage) || first));   // 一次最多 5 页
      // 临时目录用 <数据目录>/tmp：服务进程（可能在受限环境里）对 %TEMP% 不一定有写权限
      const shot = await renderPdfPages(abs, { first, last, tmpBase: dataDir ? join(dataDir, 'tmp') : '' });
      if (!shot.ok) {
        return { ok: false, level: 'blocked', course: hit.course, file: hit.file, error: shot.error, how_to: shot.howToInstall || '' };
      }
      const parts = [];
      const failedPages = [];
      for (const p of shot.pages) {
        const images = [{ mime: 'image/png', base64: p.png.toString('base64') }];
        let r = null;
        try {
          r = await askAgent(visionPrompt({ course: hit.course, file: hit.file, page: p.index, total: shot.pages.length }),
            { images, timeoutMs: 180000 });
        } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
        if (!r || !r.ok) { failedPages.push({ page: p.index, error: (r && r.error) || '未知错误' }); continue; }
        const md = cleanLatexReply(r.text || '');
        if (!md || isNoTextReply(md)) { failedPages.push({ page: p.index, error: '这一页没有可读内容（模型答 NO_TEXT）' }); continue; }
        parts.push(`## 第 ${p.index} 页\n\n${md}`);
      }
      if (!parts.length) {
        return {
          ok: false, level: 'blocked', course: hit.course, file: hit.file,
          error: `这 ${first}~${last} 页都没读出来（${failedPages.map((f) => `第 ${f.page} 页：${f.error}`).join('；')}）`,
        };
      }
      const outName = latexOutName(hit.file).replace(/\.公式\.md$/, `.页${first}-${first + parts.length - 1}.公式.md`);
      const vHeader = [
        `# ${hit.file} · 公式还原（视觉模型 · 第 ${first}~${last} 页）`,
        '',
        `- 课程：${hit.course}`,
        `- 来源：\`${abs}\``,
        '- 做法：把这几页**渲染成图**，交给视觉模型看着图转 —— 绕开了"PDF 文字层是字形编号"这个坑。',
        '- 仍然是模型读出来的：**关键公式请对着原 PDF 核一遍**。',
        `- 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        failedPages.length ? `- ⚠️ 有 ${failedPages.length} 页没读出来：${failedPages.map((f) => `第 ${f.page} 页（${f.error}）`).join('；')}` : '',
        '',
        '---',
        '',
      ].filter((x) => x !== '').join('\n');
      const wroteV = writeStudyFile({ target: { path: studyPath(studyDir, outName) }, payload: { text: `${vHeader}${parts.join('\n\n')}\n` } }, { studyDir });
      if (!wroteV.ok) return { ok: false, error: wroteV.error, level: 'warn' };
      log(`[course-latex] 视觉路线：${hit.file} 第 ${first}~${last} 页 → ${outName}`);
      return {
        ok: true, level: 'warn', mode: 'vision', course: hit.course, file: hit.file,
        out: outName, path: studyPath(studyDir, outName),
        pages: shot.pages.map((p) => p.index), failed_pages: failedPages,
        note: '这是**视觉模型看着渲染出来的页面**转的：比读文字层可靠得多，但仍请对着原 PDF 抽核几处。',
        markdown: parts.join('\n\n').slice(0, 20000),
      };
    }

    const ex = extractText(abs, { maxChars: Math.max(LATEX_MAX_CHARS, Number(maxChars) || LATEX_MAX_CHARS) });
    const review = reviewExtract(ex);
    if (!review.canConvert) {
      return {
        ok: false, error: review.note, level: 'blocked', course: hit.course, file: hit.file, kind: hit.kind, quality: ex.quality ?? null,
        // 文字层救不回来时告诉界面"可以改用视觉路线"（PDF + 本机有渲染工具才有意义）
        suggest_vision: /\.pdf$/i.test(hit.file) && !!findRasterizer(),
      };
    }

    const text = String(ex.text || '').slice(0, Number(maxChars) || LATEX_MAX_CHARS);
    const truncated = String(ex.text || '').length > text.length;
    const prompt = latexPrompt({ course: hit.course, file: hit.file, text, truncated, chars: text.length });
    let reply = '';
    try {
      const r = await askAgent(prompt);
      if (!r || r.ok === false) {
        return { ok: false, error: `模型没能转（${(r && r.error) || '未知原因'}）`, level: review.level, course: hit.course, file: hit.file };
      }
      reply = r.text || '';
    } catch (e) {
      return { ok: false, error: `模型调用失败：${(e && e.message) || e}`, level: review.level };
    }
    const markdown = cleanLatexReply(reply);
    if (!markdown) return { ok: false, error: '模型返回了空内容', level: review.level };
    if (isNoTextReply(markdown)) {
      return {
        ok: false, level: 'blocked', course: hit.course, file: hit.file,
        error: '这份材料的文字层是字形编号，读文字这条路认不出内容',
        suggest_vision: /\.pdf$/i.test(hit.file) && !!findRasterizer(),
      };
    }

    const outName = latexOutName(hit.file);
    const header = [
      `# ${hit.file} · 公式还原（LaTeX）`,
      '',
      `- 课程：${hit.course}`,
      `- 来源：\`${abs}\``,
      `- 由本机 agent 从 PDF 抽取的文字还原；**抽取有损**，公式是重建的${review.level === 'warn' ? '（这份材料空格/符号有丢失，请对着原 PDF 核）' : ''}`,
      `- 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      truncated ? `- ⚠️ 原文较长，只转了前 ${text.length} 字（后略）` : '',
      '',
      '---',
      '',
    ].filter((x) => x !== '').join('\n');
    const wrote = writeStudyFile({ target: { path: studyPath(studyDir, outName) }, payload: { text: header + markdown + '\n' } }, { studyDir });
    if (!wrote.ok) return { ok: false, error: wrote.error, level: review.level };
    log(`[course-latex] ${hit.file} → ${outName}（${markdown.length} 字）`);
    return {
      ok: true, level: review.level, note: review.note,
      course: hit.course, file: hit.file, out: outName, path: studyPath(studyDir, outName),
      chars: text.length, truncated, quality: ex.quality ?? null, garbled: !!ex.garbled,
      markdown: markdown.slice(0, 20000),
    };
  }

  return {
    studyDir,
    extraContext,
    search,
    materials,
    convertToLatex,
    writeFile: (action) => writeStudyFile(action, { studyDir }),
    // 那一页的接口也装在这里：主程序只留一行接线（它有条"别再长回去"的行数护栏）
    routes: createCourseRoutes({
      dataDir, env, sendJson, sendError, runsOf,
      search: (q, o) => search(q, o),
      currentWeek,
      materials,
      convert: (o) => convertToLatex(o),
      readBody,
    }),
    log,
  };
}
