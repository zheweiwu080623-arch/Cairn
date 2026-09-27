// functions.mjs —— 「功能」这一层的统一清单（2026-09-26 拆分）
//
// 用户的判据：「功能 = 再处理运算的结果」「主菜单上的每一项都是一个功能」。
// 在这之前，"功能"分成两半过日子：
//   * 核心页（今日 / 日程 / 任务 / 养成 / 通知 / 统计 / 音乐）**写死在 public/app.js 的 MODULES 里**；
//   * 插件功能（课程辅助 / 能力搭建 / 设置 / 五步上手…）住在 `modules/<id>/`，由模块系统发现。
// 于是"挑功能、排序、隐藏"只能各做一半。这里把两半合成**一份清单**：
//
//   listFunctions({ modules }) → [{ id, name, icon, sub, core, installable }]
//
// 谁在用：主程序的 applyModuleLayout()（决定导航里有什么、什么顺序）、设置页的「功能」页签、
// 以及五步向导的第③步。加一个**插件功能**仍然只是"在 modules/ 下加一个目录"；
// 加一个**核心页**要在 app.js 的 CORE_PAGES 里登记一行（那是平台自己的界面，不打散）。

/** 核心页（平台自带界面）：id 与 app.js 的 MODULES 一一对应；today 是落地页不可取消。 */
export const CORE_FUNCTIONS = [
  { id: 'today', name: '今日', icon: '◇', sub: '总览', core: true, always: true },
  { id: 'calendar', name: '日程', icon: '▦', sub: '月 · 周 · 日', core: true },
  { id: 'tasks', name: '任务', icon: '✓', sub: '待办与进展', core: true },
  { id: 'habits', name: '养成', icon: '△', sub: '习惯 · 番茄', core: true },
  { id: 'notifications', name: '通知', icon: '◉', sub: '提醒', core: true },
  { id: 'stats', name: '统计', icon: '▤', sub: '洞察', core: true },
  { id: 'music', name: '音乐', icon: '♪', sub: '本地音乐', core: true },
];

/** 「设置」与「五步上手」不是可选功能：前者走右上角齿轮，后者是首次运行的向导。 */
const NOT_A_FUNCTION = ['settings', 'onboarding'];

/**
 * 统一的功能清单。
 * @param {{modules?: object[]}} opts modules = `/api/modules` 里的模块数组（或 scanModules 的结果）
 */
export function listFunctions({ modules = [] } = {}) {
  const plugins = (modules || [])
    .filter((m) => !m.error && m.kind === 'view' && !NOT_A_FUNCTION.includes(m.id) && m.boot !== true)
    .map((m) => ({ id: m.id, name: m.name, icon: m.icon || '◆', sub: m.sub || '功能模块', core: false, installable: true }));
  return [...CORE_FUNCTIONS.map((f) => ({ ...f, installable: !f.always })), ...plugins];
}

/** 默认顺序：核心页在前（今日永远第一），插件按名字。 */
export function defaultFunctionOrder(functions = []) {
  return functions.map((f) => f.id);
}
