// vm-bridge.js —— 把 ViewModel 层（public\viewmodel.js，ES 模块）挂到 window，
// 供普通脚本 app.js 使用（app.js 是 <script src>，不能用 import）。
//
// 设计要点：
//   * 这个文件加载失败或被浏览器拦掉都没关系：app.js 找不到 window.PlannerVM
//     时会走自己那份等价实现（见 app.js 里的 #region today-selection）。
//   * 挂好后广播 planner-vm-ready，app.js 收到就立刻用 ViewModel 重画「今日」。
import {
  buildTodayVM, todaySelection,
  tasksSelection,
  notificationsSelection,
  connectorsSelection,
  calendarMonthSelection,
  calendarWeekSelection,
  calendarDaySelection,
  hubSelection,
  habitsSelection,
  statsSelection,
  musicSelection,
  codexSelection,
  weekNumberOf, coursesForDay,
  buildTasksVM, buildSourcesVM, buildNotificationsVM,
  registeredViews, renderText, renderMarkdown,
} from './viewmodel.js';

window.PlannerVM = {
  buildTodayVM,
  todaySelection,
  tasksSelection,
  notificationsSelection,
  buildTasksVM,
  buildSourcesVM,
  buildNotificationsVM,
  connectorsSelection,
  calendarMonthSelection,
  calendarWeekSelection,
  calendarDaySelection,
  hubSelection,
  habitsSelection,
  statsSelection,
  musicSelection,
  codexSelection,
  weekNumberOf,
  coursesForDay,
  registeredViews,
  renderText,
  renderMarkdown,
};

window.dispatchEvent(new Event('planner-vm-ready'));
