// lab-stack.mjs —— 「把 lab 讲义里的截止时间变成任务」的执行能力 + 接口（2026-10-05）
//
// 背景（用户报的问题）："大部分 assignment 的 deadline 完全没有显示在我的 cairn 上"。
// 两条原因、两条修法：
//   ① Canvas 上**有** due_at 的作业以前没进任务（被"通知类来源"那条分支提前吞掉了）→ 主程序里改一行顺序；
//   ② ENGR1010J 的 lab 在 Canvas 上**根本没有** due_at，截止时间只写在每份 lab 讲义 PDF 里
//      → 就是本文件：扫讲义 → 摘截止时间 → 建/更新任务（DDL 倒计时与提醒就自动接上了）。
//
//   GET  /api/lab-deadlines        → 上次扫描结果（每份讲义摘到没摘到、摘到了什么）
//   POST /api/lab-deadlines/run    → 立刻扫一次（{"force":true} 可跳过 6 小时节流）
//
// 四条规矩：
//   1) **幂等**：同一份讲义只对应一条任务（source = `lab-pdf:<课程>:Lab<N>`），重复扫不会建出第二条；
//   2) **抽不到不建任务**：只在结果里如实说"没摘到"（见 lib/lab-deadlines.mjs 的纪律）；
//   3) **不改用户动过的任务**：任务被标 done 之后不再自动改回 todo，只在截止时间真的变了时更新 due_at；
//   4) **不联网、不调用模型**：只读本机课程目录里的 PDF。

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { resolveCourseDir } from './course-assist.mjs';
import { extractText } from './coursetext.mjs';
import { labNoFromName, parseLabDeadline } from './lab-deadlines.mjs';

export const LAB_LAST_KEY = 'lab_deadlines_last_json';
export const LAB_SOURCE_PREFIX = 'lab-pdf';
const DEFAULT_GAP_MS = 6 * 3600 * 1000;   // 后台心跳里最多 6 小时扫一次（讲义不是分钟级变化的东西）
const MAX_DEPTH = 4;
const MAX_PDFS = 60;

/** 找课程目录下所有"文件名里带 Lab 编号"的 PDF（跳过隐藏目录与 _ 开头的目录）。 */
export function findLabPdfs(root, { maxDepth = MAX_DEPTH, maxFiles = MAX_PDFS } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let list = [];
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('_') || e.name === 'node_modules') continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!/\.pdf$/i.test(e.name)) continue;
      const lab = labNoFromName(e.name);
      if (lab == null) continue;
      out.push({ abs, rel: relative(root, abs).split(sep).join('/'), lab, name: e.name });
      if (out.length >= maxFiles) return;
    }
  };
  walk(root, 1);
  return out;
}

/** 课程代码：目录名/文件名里第一个像 `ENGR1010J` 的串。 */
function courseCodeOfPath(relPath) {
  const m = String(relPath || '').match(/\b([A-Z]{2,6}\d{3,4}[A-Z]?)\b/);
  return m ? m[1] : '';
}

export function createLabStack({
  store, dataDir = '', log = () => {}, warn = () => {}, now = () => Date.now(),
  extract = extractText, sendJson = null, sendError = null, readBody = null,
  gapMs = DEFAULT_GAP_MS,
} = {}) {
  const readLast = () => {
    try { return JSON.parse(store.getSync(LAB_LAST_KEY) || 'null'); } catch { return null; }
  };
  const saveLast = (report) => {
    const next = JSON.stringify(report);
    if (typeof store.setSync === 'function') store.setSync(LAB_LAST_KEY, next);
    return report;
  };

  /** 扫一遍课程目录里的 lab 讲义（dryRun 只报告、不写库）。 */
  function scan({ dryRun = false } = {}) {
    const startedAt = now();
    const root = resolveCourseDir({ dataDir });
    const report = {
      at: new Date(startedAt).toISOString(), dry_run: dryRun, root: root || '',
      scanned: 0, created: 0, updated: 0, unchanged: 0, no_deadline: 0, items: [],
    };
    if (!root || !existsSync(root)) {
      report.error = '还没配置「课程资料目录」（设置 → 本机 → 课程资料目录），所以读不到 lab 讲义';
      warn(`[lab-deadlines] ${report.error}`);
      return dryRun ? report : saveLast(report);
    }
    const pdfs = findLabPdfs(root);
    report.scanned = pdfs.length;
    for (const pdf of pdfs) {
      const course = courseCodeOfPath(pdf.rel) || courseCodeOfPath(root) || '课程';
      const item = { file: pdf.rel, course, lab: pdf.lab, due_at: null, evidence: '', via: '', note: '' };
      let parsed = null;
      try {
        const r = extract(pdf.abs, {});
        item.via = (r && r.via) || '';
        if (!r || !r.ok) item.note = (r && r.error) || '读不出文字层';
        else parsed = parseLabDeadline(r.text);
      } catch (e) {
        item.note = `读取失败：${e.message}`;
      }
      if (parsed && !parsed.ok) item.note = parsed.reason;
      if (parsed && parsed.ok) {
        item.due_at = parsed.due_at;
        item.evidence = parsed.evidence;
        item.time_assumed = !!parsed.time_assumed;
        const source = `${LAB_SOURCE_PREFIX}:${course}:Lab${pdf.lab}`;
        const existing = store.listTasks().find((t) => t && t.source === source);
        const notes = [
          `截止时间从 lab 讲义里读出来的：${pdf.rel}`,
          item.evidence ? `原文：「${item.evidence}」` : '',
          item.time_assumed ? '（讲义只写了日期、没写几点，按全系统规则＝当天 23:59）' : '',
        ].filter(Boolean).join('\n');
        if (!existing) {
          item.note = '新建任务';
          if (!dryRun) {
            store.createTask({
              title: `${course} Lab${pdf.lab} 提交（截止时间取自 lab 讲义）`,
              notes, due_at: parsed.due_at, priority: 1, tags: course,
              source, status: 'todo',
            });
          }
          report.created += 1;
        } else if (String(existing.due_at || '') !== parsed.due_at) {
          item.note = `截止时间更新：${existing.due_at || '（原来没有）'} → ${parsed.due_at}`;
          if (!dryRun) store.updateTask(existing.id, { due_at: parsed.due_at, notes });
          report.updated += 1;
        } else {
          item.note = '没有变化';
          report.unchanged += 1;
        }
      } else {
        report.no_deadline += 1;
      }
      report.items.push(item);
    }
    log(`[lab-deadlines] 扫了 ${report.scanned} 份 lab 讲义：新建 ${report.created} / 更新 ${report.updated} / 无变化 ${report.unchanged} / 没摘到 ${report.no_deadline}`);
    return dryRun ? report : saveLast(report);
  }

  /** 后台心跳调这个：内部节流，最多 6 小时真扫一次。 */
  function maybeRun() {
    const last = readLast();
    const lastAt = last && last.at ? Date.parse(last.at) : 0;
    if (lastAt && now() - lastAt < gapMs) return { ok: true, ran: false };
    const r = scan();
    return {
      ok: true, ran: true,
      note: `lab 讲义扫描：${r.scanned} 份（新建 ${r.created} / 更新 ${r.updated} / 没摘到 ${r.no_deadline}）`,
    };
  }

  /** GET /api/lab-deadlines · POST /api/lab-deadlines/run */
  async function handleLab(req, res, url) {
    const action = url.pathname.replace(/\/+$/, '').split('/')[3] || '';
    if (req.method === 'GET' && !action) {
      return sendJson(res, 200, { ok: true, last: readLast(), root: resolveCourseDir({ dataDir }) || '' });
    }
    if (req.method === 'POST' && action === 'run') {
      const body = await readBody(req).catch(() => ({}));
      return sendJson(res, 200, scan({ dryRun: body && body.dry_run === true }));
    }
    return sendError(res, 404, 'not found');
  }

  return { scan, maybeRun, handleLab, last: readLast, resolveRoot: () => resolveCourseDir({ dataDir }) };
}
