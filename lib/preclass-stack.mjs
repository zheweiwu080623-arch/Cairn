// preclass-stack.mjs —— 把「上课前 Canvas 检查」的三块**一次性装好**（接线层）。
//
// 为什么单列一个文件：这一套由三块组成（调度 `preclass-run` + 功能 `preclass-check` +
// 接口 `routes/preclass`），主程序里逐块接线要十几行，而且互相有先后依赖；
// 装在这里，主程序只留三行（创建 stack → 交给模块系统当额外能力 → 挂接口）。
//
// 依赖方向（注意那个 `runModule` 是**懒引用**）：
//   主程序 → 本文件 → （运行时）模块系统的 runModule
// 因为模块系统也要用本文件提供的 `extraContext`（canvas / prefs / dedupe），两者互相需要。

import { canvasConfigFromStore, checkCourseForNewMaterial } from './canvas-check.mjs';
import { normalizePreclass } from './preclass.mjs';
import { PRECLASS_PREFS_KEY, PRECLASS_SEEN_KEY, createPreclassRunner, createSeenStore } from './preclass-run.mjs';
import { createPreclassRoutes } from './routes/preclass.mjs';

export function createPreclassStack({
  store, sendJson, sendError, readBody,
  runModule,                    // (id, opts) => Promise —— 懒引用：调用时才用
  runsOf = () => null,          // () => 上次运行摘要（懒引用）
  log = () => {}, warn = () => {},
}) {
  const seen = createSeenStore(store, { key: PRECLASS_SEEN_KEY });

  const runner = createPreclassRunner({
    store,
    courses: () => store.listCourses(),
    termStart: () => (store.listAcademic() || []).find((a) => a.kind === 'term')?.start_at || null,
    runModule: (id, opts) => runModule(id, opts),
    log, warn,
  });

  const routes = createPreclassRoutes({
    store, sendJson, sendError, readBody, runner,
    runsOf: () => runsOf(),
  });

  /** 给 `modules/<id>/run.js` 的能力：查一门课、读设置、报过的不再报。 */
  const extraContext = () => ({
    canvas: { checkCourse: (o) => checkCourseForNewMaterial({ store, ...o, config: canvasConfigFromStore(store) }) },
    prefs: () => {
      try { return normalizePreclass((JSON.parse(store.getSync(PRECLASS_PREFS_KEY) || 'null')) || {}); } catch { return normalizePreclass({}); }
    },
    dedupe: seen,
  });

  return { runner, routes, extraContext, seen };
}
