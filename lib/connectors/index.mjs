// 这里的**顺序 = 界面卡片顺序**（listConnectorMeta 用 Object.values 迭代）。
// 2026-09-25 按用户实测反馈重排：常用的放前面、几乎不用的放最后。
//   邮箱（Zimbra 校内邮箱 / 通用 IMAP）→ arXiv → 通用 RSS → 通用日历订阅
//   → 通用 JSON 接口 → 本地文件导入 → Canvas → 飞书
// 说明：「课程资料自动同步」不是连接器，它是数据源页上单独的一张卡片（按用户要求排在最前）。
import * as email from './email.mjs';
import * as emailSjtu from './email_sjtu.mjs';
import * as arxiv from './arxiv.mjs';
import * as rss from './rss.mjs';
import * as ical from './ical.mjs';
import * as jsonapi from './jsonapi.mjs';
import * as localfile from './localfile.mjs';
import * as canvas from './canvas.mjs';
import * as feishu from './feishu.mjs';

export const connectors = {
  email,
  email_sjtu: emailSjtu,
  arxiv,
  rss,
  ical,
  jsonapi,
  localfile,
  canvas,
  feishu,
};

export function listConnectorMeta() {
  return Object.values(connectors).map((c) => c.meta);
}

export function getConnector(id) {
  return connectors[id] || null;
}

// Normalize a connector item and save into the store (shared by real + demo imports).
export function normalizeForStore(item, source) {
  return {
    kind: item.kind || 'event',
    external_id: item.external_id || null,
    title: item.title || '（未命名）',
    start_at: item.start_at || null,
    end_at: item.end_at || null,
    due_at: item.due_at || null,
    url: item.url || null,
    notes: item.notes || '',
    // submit_state：Canvas 作业的提交状态（unsubmitted / submitted / graded）—— 学生特化要用
    payload: { calendar: item.calendar, course: item.course, from: item.from, submit_state: item.submit_state },
    source,
  };
}

// Default planner kind when pushing connector data into the planner.
export function plannerKindFor(item) {
  if (item.kind === 'event') return 'event';
  if (item.kind === 'task') return 'task';
  return 'reminder';
}
