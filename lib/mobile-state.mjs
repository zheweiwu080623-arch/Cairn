// mobile-state.mjs —— 「平板 / 手机那一坨数据」的唯一产地。
//
// 为什么单独成一个文件：主程序（server.mjs）有一条 2100 行硬闸门，它只该留一行接线；
// 更重要的是，移动页与桌面 /api/state**必须同源** —— 两处各写一遍，"重点"标记迟早会飘。
import { readAnki } from './anki.mjs';

/** 「重点」按当前偏好现算（改设置立刻生效）；只重算数据源来的，别覆盖 DDL / Codex 自带的优先级。 */
export function priorityAwareNotifications(store, isPrioritySource) {
  return store.listNotifications().map((n) => {
    const src = String(n.source || '');
    if (!src.startsWith('connector:')) return n;
    const priority = isPrioritySource(src.slice(10)) ? 1 : 0;
    return priority === (n.priority || 0) ? n : { ...n, priority };
  });
}

/**
 * 移动页的 buildState：字段与 /api/state 同源，另加一条**只读**的 Anki 摘要
 * （今日待复习多少张 / 最后同步于何时）。Anki 读失败也只是一张卡显示"没接上"，
 * 绝不连累其它卡片。`anki` 可注入，方便测试。
 */
export function buildMobileState({ store, isPrioritySource, getCodexSnapshot, anki }) {
  return {
    tasks: store.listTasks(),
    events: store.listEvents(),
    notifications: priorityAwareNotifications(store, isPrioritySource),
    codex: getCodexSnapshot(),
    // 日程页要的：课表 + 校历（与 /api/state 里同名同源）
    courses: store.listCourses(),
    academic: store.listAcademic(),
    anki: anki === undefined ? readAnki() : anki,
  };
}
