// Planner 的数据出口（P1-5）：把内部状态导出成**版本化契约**，供别的程序消费。
//
// 契约（见 contracts/）：
//   planner-notifications.v1 —— 通知/提醒导出；给外部程序读（取代「直读 SQLite」）
//   planner-snapshot.v1      —— 离线快照；Cairn 没在跑时外部程序的兜底
//
// 设计要点：快照里的 `sections` 直接复用 public/viewmodel.js 的构造器——
// 于是「浏览器里看到的今日视图」和「导出给别的程序的今日视图」是**同一份结构**，
// 这正是方案里「同一份 ViewModel 被多个显示面消费」那条验收标准。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSourcesVM, buildTodayVM } from '../public/viewmodel.js';

export const EXPORT_APP_VERSION = 'Vol.2.4';
export const NOTIFICATIONS_SCHEMA = 'planner-notifications.v1';
export const SNAPSHOT_SCHEMA = 'planner-snapshot.v1';

const pad = (n) => String(n).padStart(2, '0');

/** 带本地时区偏移的 ISO 时间，例如 2026-09-19T00:30:00+08:00 */
export function localIso(moment = new Date()) {
  const off = -moment.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`
    + `T${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 内容指纹：只反映 items 本身，跟导出时间无关，便于双方判断"数据有没有变" */
export function contentHash(items) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(items ?? [])).digest('hex').slice(0, 32);
}

const clip = (value, limit = 400) => {
  const text = value == null ? '' : String(value);
  return text.length <= limit ? text : text.slice(0, limit) + '…';
};

/** 一条通知的"时间感"：优先 created_at（可能是毫秒数），其次 trigger_at / updated_at */
function stampOf(row) {
  const num = Number(row.created_at);
  if (Number.isFinite(num) && num > 0) return num;
  for (const key of ['trigger_at', 'updated_at']) {
    const t = Date.parse(row[key] ?? '');
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

export function buildNotificationsExport(store, { source = null, days = 7, limit = 200, now = new Date() } = {}) {
  const since = now.getTime() - Math.max(1, Number(days) || 7) * 86400000;
  let rows = store.listNotifications() || [];
  if (source) {
    const needle = String(source).toLowerCase();
    rows = rows.filter((n) => String(n.source || '').toLowerCase().includes(needle));
  }
  rows = rows.filter((n) => stampOf(n) >= since || stampOf(n) === 0);
  rows.sort((a, b) => stampOf(b) - stampOf(a));
  const capped = rows.slice(0, Math.max(1, Number(limit) || 200));

  const items = capped.map((n) => ({
    id: n.id ?? null,
    title: n.title ?? '',
    message: clip(n.message),
    url: n.url ?? null,
    source: n.source ?? '',
    external_id: n.external_id ?? null,
    trigger_at: n.trigger_at ?? null,
    created_at: n.created_at ?? null,
  }));
  const payload = {
    schema: NOTIFICATIONS_SCHEMA,
    exported_at: localIso(now),
    source_version: EXPORT_APP_VERSION,
    source_pid: process.pid,
    query: { source: source ?? null, days: Number(days) || 7, limit: Number(limit) || 200 },
    count: items.length,
    items,
  };
  payload.content_hash = contentHash(items);
  return payload;
}

export function buildSnapshotExport(store, { now = new Date(), staleAfterHours = 24, days = 7 } = {}) {
  const tasks = store.listTasks() || [];
  const events = store.listEvents() || [];
  const notifications = store.listNotifications() || [];
  const courses = store.listCourses() || [];
  const pending = typeof store.listPending === 'function' ? (store.listPending() || []) : [];

  // ViewModel 层直接参与导出：浏览器和外部程序看到同一份「今日」
  const state = { tasks, events, notifications, courses, codex: null, connectors: {} };
  const sections = [
    buildTodayVM(state, now.getTime()),
    buildSourcesVM(state),
  ];

  const payload = {
    schema: SNAPSHOT_SCHEMA,
    exported_at: localIso(now),
    stale_after_hours: Number(staleAfterHours) || 24,
    source_version: EXPORT_APP_VERSION,
    source_pid: process.pid,
    days: Number(days) || 7,
    counts: {
      tasks: tasks.length,
      events: events.length,
      notifications: notifications.length,
      courses: courses.length,
      pending: pending.length,
      open_tasks: tasks.filter((t) => t.status !== 'done').length,
    },
    sections,
  };
  payload.content_hash = contentHash(sections);
  return payload;
}

/** 把两份导出写到 <dataDir>/export/，返回写出的路径；单个失败不影响其它。 */
export function writeExportFiles(store, { dataDir, now = new Date() } = {}) {
  if (!dataDir) return { paths: [], error: 'no dataDir' };
  const dir = join(dataDir, 'export');
  const paths = [];
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { paths, error: e.message };
  }
  const outputs = [
    [`${NOTIFICATIONS_SCHEMA}.json`, buildNotificationsExport(store, { now })],
    [`${SNAPSHOT_SCHEMA}.json`, buildSnapshotExport(store, { now })],
  ];
  for (const [name, payload] of outputs) {
    try {
      writeFileSync(join(dir, name), JSON.stringify(payload, null, 2), 'utf8');
      paths.push(join(dir, name));
    } catch { /* 单个失败不影响另一个 */ }
  }
  return { exported_at: localIso(now), paths };
}
