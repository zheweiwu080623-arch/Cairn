// routes/course.mjs —— 「课程辅助」那一页要的数据（一个只读接口）。
//
//   GET  /api/course        → { dir, study_dir, outputs[], last_run, materials[] }
//   GET  /api/course/search → 在课件里找一段话（"这道题在哪份材料里"）
//   POST /api/course/latex  → 把一份课件的公式还原成 Markdown + LaTeX（2026-09-27 新增）
//
// 为什么单独一个接口：课程辅助现在有**自己的一页**（和今日/通知/音乐并列），
// 页面要显示"资料目录配好没有 / 已经生成了哪些文件 / 上次跑成什么样"。
// 这三件事都只是"读一下本机状态"，所以这里只读、不写 —— 写目录走 /api/localdirs，
// 跑功能走 /api/modules/course-assist/run（默认演练）。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { studyDirOf } from '../course-stack.mjs';
import { describeLocalDir } from './localdirs.mjs';

export function createCourseRoutes({
  dataDir = '', env = process.env, sendJson, sendError, runsOf = () => null, search = null,
  currentWeek = () => null,
  materials = null,                 // 材料清单（给「公式转 LaTeX」的下拉）
  convert = null,                   // 转 LaTeX 的实现（在 course-stack 里，会调模型并写入 study/）
  readBody = null,                  // POST 的请求体（只这一条接口需要）
} = {}) {
  const studyDir = studyDirOf(dataDir);

  /** 产物目录里已经生成的东西（按修改时间从新到旧）。 */
  function outputs() {
    if (!studyDir || !existsSync(studyDir)) return [];
    let names = [];
    try { names = readdirSync(studyDir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of names) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      try {
        const st = statSync(join(studyDir, e.name));
        out.push({ name: e.name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      } catch { /* 读不到就跳过，不因为一个文件让整页报错 */ }
    }
    return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  }

  async function handleCourse(req, res, url) {
    // 把一份课件转成 LaTeX（会调模型、会往 study/ 写一个 .公式.md；不是只读接口，所以是 POST）
    if (url.pathname === '/api/course/latex' && req.method === 'POST') {
      if (typeof convert !== 'function') return sendError(res, 500, '这台机器上还没有可用的转换出口');
      let b = {};
      try { b = (typeof readBody === 'function' ? await readBody(req) : null) || {}; } catch { b = {}; }
      return sendJson(res, 200, await convert({
        file: b.file || '', rel: b.rel || '', course: b.course || '',
        mode: b.mode === 'vision' ? 'vision' : 'text',
        firstPage: b.first_page, lastPage: b.last_page,
      }));
    }
    // 在课件里找一段话：`?q=...`（必填）、`?course=MATH1860J`（可选）
    if (url.pathname === '/api/course/search' && req.method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return sendError(res, 400, '要搜什么？给一个 ?q=关键词');
      if (typeof search !== 'function') return sendError(res, 500, '这台机器上没有可用的课件搜索');
      const r = search(q, { course: String(url.searchParams.get('course') || '').trim() });
      return sendJson(res, r.ok ? 200 : 400, { ...r, hits: (r.hits || []).slice(0, 30) });
    }
    if (url.pathname === '/api/course' && req.method === 'GET') {
      const mats = typeof materials === 'function' ? (materials() || { items: [] }) : { items: [] };
      return sendJson(res, 200, {
        schema: 'course.v1',
        dir: describeLocalDir('course', { dataDir, env }),
        study_dir: studyDir,
        week: currentWeek(),                  // 现在是学期第几周（没有校历就是 null，不猜）
        outputs: outputs(),
        last_run: runsOf(),
        // 「公式转 LaTeX」的下拉用：材料清单（只列扩展名/大小，不读内容）
        materials: mats.items || [],
        materials_error: mats.ok === false ? (mats.error || '读不到课程资料目录') : null,
      });
    }
    return sendError(res, 404, '没有这个接口');
  }

  return { handleCourse, outputs, studyDir };
}
