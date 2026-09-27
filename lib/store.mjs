// store.mjs —— **唯一的存储层**：SQLite 读写 + 凭据加解密 + 迁移应用。
//
// 为什么所有读写都挤在一个文件里（这是刻意的）：
//   * 表结构、字段名、迁移编号只在一个地方能看全，审阅时不用满仓库找 SQL；
//   * 凭据的"写盘即加密、读出来即解密"只在这一层做一次，调用方拿到的永远是明文，
//     不会有人忘记加密（规则见 lib/secrets.mjs）；
//   * 上层（路由层 / 领域层）只需要 `store.xxx()`，将来换存储（例如换内置库版本）
//     只需要改这一个文件。
//
// 三类成员：
//   1) 业务表 CRUD：任务 / 日程 / 通知 / 课程 / 校历 / 里程碑 / 习惯 / 专注 / 课程资料；
//   2) 连接器：配置（加密）、抓回来的条目、待批准裁决；
//   3) 杂项：`sync_state` 键值（偏好、规划文本、自动推送状态……）与迁移台账。
//
// 注意：这里不做任何业务判断（不排序、不筛选）——那是 lib/relevance.mjs / lib/priority.mjs 的事。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from './paths.mjs';
import {
  decryptConfigJson, decryptString, encryptConfigJson, encryptString, getOrCreateKey,
  isEncrypted, isSecretKey,
} from './secrets.mjs';
import {
  currentSchemaVersion, ensureColumn, listMigrations, migrationSummary, runMigrations,
} from './migrations.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
// 仓库根目录（lib/ 的上一级）；老装机在 <repo>/data 下，新装机走平台默认目录。
const REPO_DIR = dirname(__dir);
const DB_PATH = resolveDbPath({ repoDir: REPO_DIR });
// 凭据加密用的密钥：放在数据目录下（data/ 已被 .gitignore 排除）
const SECRET_KEY = getOrCreateKey(dirname(DB_PATH));

if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  notes       TEXT DEFAULT '',
  due_at      TEXT,
  priority    INTEGER DEFAULT 2,
  status      TEXT DEFAULT 'todo',
  tags        TEXT DEFAULT '',
  source      TEXT DEFAULT 'app',
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  notes       TEXT DEFAULT '',
  start_at    TEXT NOT NULL,
  end_at      TEXT,
  all_day     INTEGER DEFAULT 0,
  color       TEXT DEFAULT '#4f7cff',
  tags        TEXT DEFAULT '',
  source      TEXT DEFAULT 'app',
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  message      TEXT DEFAULT '',
  trigger_at   TEXT NOT NULL,
  repeat       TEXT DEFAULT 'none',
  enabled      INTEGER DEFAULT 1,
  last_fired_at TEXT,
  source       TEXT DEFAULT 'app',
  created_at   INTEGER,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS sync_state (
  key     TEXT PRIMARY KEY,
  value   TEXT
);

CREATE TABLE IF NOT EXISTS connector_config (
  source      TEXT PRIMARY KEY,
  config_json TEXT DEFAULT '{}',
  status      TEXT DEFAULT 'never',
  last_sync   INTEGER,
  last_error  TEXT,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS connector_data (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- event | task | reminder
  external_id  TEXT,
  title        TEXT NOT NULL,
  start_at     TEXT,
  end_at       TEXT,
  due_at       TEXT,
  url          TEXT,
  notes        TEXT,
  payload      TEXT,
  imported_at  INTEGER,
  approved     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_schedule (
  id          TEXT PRIMARY KEY,
  course      TEXT NOT NULL,
  weekday     INTEGER NOT NULL,      -- 1=Mon .. 7=Sun
  start_at    TEXT NOT NULL,         -- "HH:MM"
  end_at      TEXT NOT NULL,
  location    TEXT DEFAULT '',
  platform    TEXT DEFAULT '',       -- 上课平台：Zoom / Teams / 线下教室 …
  teacher     TEXT DEFAULT '',
  weeks       TEXT DEFAULT '',       -- "1-16" or "1,3,5" or list
  color       TEXT DEFAULT '#4f7cff',
  source      TEXT DEFAULT 'manual',
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS academic_events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  start_at    TEXT NOT NULL,         -- YYYY-MM-DD
  end_at      TEXT,
  kind        TEXT DEFAULT 'general',-- term/holiday/exam/semester
  notes       TEXT DEFAULT '',
  color       TEXT DEFAULT '#ffd166',
  source      TEXT DEFAULT 'manual',
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS habits (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT DEFAULT '🎯',
  color       TEXT DEFAULT '#e60012',
  target      INTEGER DEFAULT 1,     -- 目标次数/周
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id          TEXT PRIMARY KEY,
  habit_id    TEXT NOT NULL,
  date        TEXT NOT NULL,         -- YYYY-MM-DD
  done        INTEGER DEFAULT 0,
  created_at  INTEGER,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id          TEXT PRIMARY KEY,
  label       TEXT DEFAULT '',
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL,
  minutes     INTEGER NOT NULL,
  created_at  INTEGER
);

CREATE TABLE IF NOT EXISTS milestones (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  target_at   TEXT NOT NULL,         -- YYYY-MM-DD or datetime
  kind        TEXT DEFAULT 'date',   -- date|exam|deadline
  note        TEXT DEFAULT '',
  done        INTEGER DEFAULT 0,
  created_at  INTEGER,
  updated_at  INTEGER
);
`);

// ---------------- 结构自愈（与 lib/migrations.mjs 共用同一套实现） ----------------
// 这里做的和迁移台账 #2/#3 是同一件事。**故意重复一次**：老库哪怕把台账丢了，
// 启动时也能自己补齐；台账那份负责"记下来，以后不重跑"。
//
// 记录每条外部数据的"相关度裁决"（分数 / 三档判定 / 命中理由），
// 让界面能回答"为什么这条被拦下来"（信息筛选 P0）。
ensureColumn(db, 'connector_data', 'approved', 'INTEGER DEFAULT 0');
ensureColumn(db, 'connector_data', 'score', 'REAL');
ensureColumn(db, 'connector_data', 'verdict', 'TEXT');
ensureColumn(db, 'connector_data', 'reasons', 'TEXT');

// notifications：external_id（外部同步条目用 来源+id 去重）/ priority（1 = 重点来源）/
// url（点击提醒可直接跳到邮件 / Canvas 内容）。
ensureColumn(db, 'notifications', 'external_id', 'TEXT');
ensureColumn(db, 'notifications', 'priority', 'INTEGER DEFAULT 0');
ensureColumn(db, 'notifications', 'url', 'TEXT');

// 用户手动删掉的同步条目记在这里，避免下次同步又把它加回来。
db.exec(`
CREATE TABLE IF NOT EXISTS dismissed_notifications (
  key          TEXT PRIMARY KEY,   -- "<source>:<external_id>"
  source       TEXT DEFAULT '',
  dismissed_at INTEGER
);
`);

// 课程资料台账（2026-09-15 新增）：Canvas 上的新文件 → 桌面课程文件夹 → 办公本 X5。
// 一条记录就是一份材料，记录它有没有下载成功、有没有推进办公本，避免重复推送。
db.exec(`
CREATE TABLE IF NOT EXISTS course_files (
  id            TEXT PRIMARY KEY,
  external_id   TEXT UNIQUE,        -- canvas 的 file-<courseId>-<fileId>
  source        TEXT DEFAULT 'canvas',
  course        TEXT DEFAULT '',
  course_code   TEXT DEFAULT '',
  filename      TEXT NOT NULL,
  local_name    TEXT,               -- 本机落盘名：FA26_<课程号>_Week<n>_<去掉教授课程号的文件名>
  file_date     INTEGER,            -- 该材料在 Canvas 上的日期（毫秒），用来算文件名里的 Week 段
  url           TEXT DEFAULT '',
  size          INTEGER DEFAULT 0,
  rel_path      TEXT DEFAULT '',
  abs_path      TEXT DEFAULT '',
  status        TEXT DEFAULT 'queued',   -- queued | downloaded | error
  error         TEXT,
  attempts      INTEGER DEFAULT 0,
  device_status TEXT DEFAULT 'pending',  -- pending | synced | error | skipped
  device_name   TEXT,
  device_error  TEXT,
  downloaded_at INTEGER,
  synced_at     INTEGER,
  created_at    INTEGER,
  updated_at    INTEGER
);
`);

// 课程资料台账：local_name（filename 仍保留 Canvas 上的原始文件名，用于和通知标题对齐）
// 与 file_date（Canvas 侧日期 —— Week 段按它算，老记录回退到 created_at）。
ensureColumn(db, 'course_files', 'local_name', 'TEXT');
ensureColumn(db, 'course_files', 'file_date', 'INTEGER');

// 课表：platform（上课平台：Zoom / Teams / 线下教室 …）。
// 2026-09-17 新增：MATH1860J 等线上课除了「在哪上」（location），还需要记「用什么平台上」。
ensureColumn(db, 'course_schedule', 'platform', "TEXT DEFAULT ''");

const now = () => Date.now();
const rowToTask = (r) => ({ ...r, priority: r.priority ?? 2, all_day: undefined });
const rowToEvent = (r) => ({ ...r, all_day: !!(r.all_day) });
const rowToNotif = (r) => ({ ...r, enabled: !!r.enabled });

// Migration: 把老数据里的**明文凭据**加密（W4-1）。幂等：已经加密的会跳过。
// 这一步只动"凭据字段"，配置里的 host/port/user 等照旧可读，方便排错。
try {
  if (SECRET_KEY) {
    let converted = 0;
    for (const row of db.prepare('SELECT source, config_json FROM connector_config').all()) {
      const enc = encryptConfigJson(row.config_json, SECRET_KEY);
      if (enc !== row.config_json) {
        db.prepare('UPDATE connector_config SET config_json = ? WHERE source = ?').run(enc, row.source);
        converted += 1;
      }
    }
    for (const row of db.prepare('SELECT key, value FROM sync_state').all()) {
      if (!isSecretKey(row.key) || !row.value || isEncrypted(row.value)) continue;
      db.prepare('UPDATE sync_state SET value = ? WHERE key = ?')
        .run(encryptString(row.value, SECRET_KEY), row.key);
      converted += 1;
    }
    if (converted) console.log(`[secrets] 已把 ${converted} 处明文凭据加密存储`);
    db.prepare('INSERT INTO sync_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('secrets_version', '1');
  }
} catch (e) {
  console.warn('[secrets] 加密迁移失败（不影响使用）：', e.message);
}

// ---------------- 数据版本台账（2026-09-21 新增） ----------------
// 放在上面那些"结构自愈"之后跑：先保证结构是对的，再登记"这个库已经到第几版"。
// 迁移失败**不让程序起不来**（结构自愈已经兜住底线），但会大声报出来，
// 并在 /api/status 的「数据」一节里标成警告 —— 装死比报错更危险。
let MIGRATION_STATE = { version: 0, applied: 0, total: 0, ran: [], error: null };
try {
  const r = runMigrations(db, { log: (m) => console.log(m) });
  MIGRATION_STATE = { ...r, error: null };
  if (r.ran.length) console.log(`[migrate] 数据版本 ${r.version}（本次新应用 ${r.ran.length} 项）`);
} catch (e) {
  MIGRATION_STATE = { ...MIGRATION_STATE, error: e.message };
  console.error('[migrate] 数据迁移失败（程序继续运行）：', e.message);
}

export const store = {
  db,

  // ---------- 数据版本 ----------
  schemaVersion() {
    return currentSchemaVersion(db);
  },
  migrations() {
    return listMigrations(db);
  },
  migrationState() {
    return { ...MIGRATION_STATE, ...migrationSummary(db) };
  },

  // ---------- Tasks ----------
  listTasks() {
    return db.prepare('SELECT * FROM tasks ORDER BY (due_at IS NULL), due_at ASC, priority ASC, created_at DESC').all();
  },
  getTask(id) {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  },
  createTask(t) {
    const id = randomUUID();
    const ts = now();
    db.prepare(`INSERT INTO tasks (id,title,notes,due_at,priority,status,tags,source,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, t.title, t.notes ?? '', t.due_at ?? null, t.priority ?? 2, t.status ?? 'todo',
        t.tags ?? '', t.source ?? 'app', ts, ts);
    return this.getTask(id);
  },
  updateTask(id, p) {
    const cur = this.getTask(id);
    if (!cur) return null;
    const next = { ...cur, ...p, updated_at: now() };
    db.prepare(`UPDATE tasks SET title=?,notes=?,due_at=?,priority=?,status=?,tags=?,updated_at=? WHERE id=?`)
      .run(next.title, next.notes, next.due_at, next.priority, next.status, next.tags, next.updated_at, id);
    return this.getTask(id);
  },
  deleteTask(id) {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  },

  // ---------- Events ----------
  listEvents(from, to) {
    if (from && to) {
      return db.prepare('SELECT * FROM events WHERE start_at < ? AND (end_at IS NULL OR end_at >= ?) ORDER BY start_at ASC')
        .all(to, from);
    }
    return db.prepare('SELECT * FROM events ORDER BY start_at ASC').all();
  },
  getEvent(id) {
    return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  },
  createEvent(e) {
    const id = randomUUID();
    const ts = now();
    db.prepare(`INSERT INTO events (id,title,notes,start_at,end_at,all_day,color,tags,source,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, e.title, e.notes ?? '', e.start_at, e.end_at ?? null, e.all_day ? 1 : 0,
        e.color ?? '#4f7cff', e.tags ?? '', e.source ?? 'app', ts, ts);
    return this.getEvent(id);
  },
  updateEvent(id, p) {
    const cur = this.getEvent(id);
    if (!cur) return null;
    const next = { ...cur, ...p, all_day: p.all_day === undefined ? cur.all_day : p.all_day, updated_at: now() };
    db.prepare(`UPDATE events SET title=?,notes=?,start_at=?,end_at=?,all_day=?,color=?,tags=?,updated_at=? WHERE id=?`)
      .run(next.title, next.notes, next.start_at, next.end_at, next.all_day ? 1 : 0,
        next.color, next.tags, next.updated_at, id);
    return this.getEvent(id);
  },
  deleteEvent(id) {
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
  },

  // ---------- Notifications ----------
  listNotifications() {
    return db.prepare('SELECT * FROM notifications ORDER BY priority DESC, trigger_at ASC, created_at DESC').all();
  },
  getNotification(id) {
    return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  },
  createNotification(n) {
    const id = randomUUID();
    const ts = now();
    const enabled = n.enabled === undefined ? 1 : (n.enabled ? 1 : 0);
    db.prepare(`INSERT INTO notifications (id,title,message,trigger_at,repeat,enabled,last_fired_at,external_id,priority,url,source,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, n.title, n.message ?? '', n.trigger_at, n.repeat ?? 'none', enabled,
        n.last_fired_at ?? null, n.external_id ?? null, Number(n.priority ?? 0), n.url ?? null,
        n.source ?? 'app', ts, ts);
    return this.getNotification(id);
  },
  updateNotification(id, p) {
    const cur = this.getNotification(id);
    if (!cur) return null;
    const next = { ...cur, ...p, enabled: p.enabled === undefined ? cur.enabled : (p.enabled ? 1 : 0), updated_at: now() };
    db.prepare(`UPDATE notifications SET title=?,message=?,trigger_at=?,repeat=?,enabled=?,updated_at=? WHERE id=?`)
      .run(next.title, next.message, next.trigger_at, next.repeat, next.enabled, next.updated_at, id);
    return this.getNotification(id);
  },
  markFired(id, firedAt) {
    db.prepare('UPDATE notifications SET last_fired_at = ? WHERE id = ?').run(firedAt, id);
  },
  deleteNotification(id) {
    db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
  },
  // ---------- 被删掉的同步条目（防止每日同步又加回来） ----------
  listDismissedNotificationKeys() {
    return db.prepare('SELECT key FROM dismissed_notifications').all().map((r) => r.key);
  },
  dismissNotificationKey(key, source = '') {
    if (!key) return;
    db.prepare('INSERT INTO dismissed_notifications (key,source,dismissed_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING')
      .run(String(key), source, now());
  },

  // ---------- 课程资料台账（Canvas 文件 → 桌面 → 办公本） ----------
  listCourseFiles() {
    return db.prepare('SELECT * FROM course_files ORDER BY created_at DESC').all();
  },
  getCourseFile(id) {
    return db.prepare('SELECT * FROM course_files WHERE id = ?').get(id) || null;
  },
  getCourseFileByExternal(externalId) {
    if (!externalId) return null;
    return db.prepare('SELECT * FROM course_files WHERE external_id = ?').get(String(externalId)) || null;
  },
  createCourseFile(row) {
    const id = randomUUID();
    const ts = now();
    db.prepare(`INSERT INTO course_files
      (id,external_id,source,course,course_code,filename,url,size,rel_path,abs_path,status,error,attempts,
       device_status,device_name,device_error,downloaded_at,synced_at,local_name,file_date,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, row.external_id ?? null, row.source ?? 'canvas', row.course ?? '', row.course_code ?? '',
        row.filename, row.url ?? '', Number(row.size) || 0, row.rel_path ?? '', row.abs_path ?? '',
        row.status ?? 'queued', row.error ?? null, Number(row.attempts) || 0,
        row.device_status ?? 'pending', row.device_name ?? null, row.device_error ?? null,
        row.downloaded_at ?? null, row.synced_at ?? null, row.local_name ?? null,
        Number(row.file_date) || null, ts, ts);
    return this.getCourseFile(id);
  },
  updateCourseFile(id, patch = {}) {
    const cur = this.getCourseFile(id);
    if (!cur) return null;
    const allowed = ['external_id', 'source', 'course', 'course_code', 'filename', 'url', 'size',
      'rel_path', 'abs_path', 'status', 'error', 'attempts', 'device_status', 'device_name',
      'device_error', 'downloaded_at', 'synced_at', 'local_name', 'file_date'];
    const fields = [];
    const values = [];
    for (const k of allowed) {
      if (patch[k] === undefined) continue;
      fields.push(`${k} = ?`);
      values.push(patch[k]);
    }
    if (fields.length) {
      fields.push('updated_at = ?');
      values.push(now());
      db.prepare(`UPDATE course_files SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.getCourseFile(id);
  },
  deleteCourseFile(id) {
    db.prepare('DELETE FROM course_files WHERE id = ?').run(id);
  },

  // ---------- 每日清理：删除存在超过 N 天的历史记录 ----------
  /**
   * 只删「已经成为过去」的记录：已触发的通知、数据源导入的历史条目、被删通知的标记、
   * 专注记录，以及（可选）已完成的任务。未来的提醒 / 未完成任务不会被碰到。
   */
  purgeHistory({ days = 10, notifications = true, connectorData = true, dismissed = true,
    focus = true, doneTasks = false, now: ref = Date.now() } = {}) {
    const cutoff = ref - Math.max(1, Number(days) || 10) * 86400000;
    const iso = new Date(ref).toISOString();
    const out = { days, cutoff: new Date(cutoff).toISOString(), notifications: 0, connector_data: 0,
      dismissed: 0, focus: 0, done_tasks: 0 };
    if (notifications) {
      // trigger_at <= 现在（已经提醒过的）+ 创建时间早于 cutoff —— 未来的提醒绝不删。
      out.notifications = db.prepare(
        'DELETE FROM notifications WHERE COALESCE(created_at, 0) < ? AND COALESCE(trigger_at, ?) <= ?'
      ).run(cutoff, iso, iso).changes;
    }
    if (connectorData) {
      out.connector_data = db.prepare('DELETE FROM connector_data WHERE COALESCE(imported_at, 0) < ?').run(cutoff).changes;
    }
    if (dismissed) {
      out.dismissed = db.prepare('DELETE FROM dismissed_notifications WHERE COALESCE(dismissed_at, 0) < ?').run(cutoff).changes;
    }
    if (focus) {
      out.focus = db.prepare('DELETE FROM focus_sessions WHERE COALESCE(created_at, 0) < ?').run(cutoff).changes;
    }
    if (doneTasks) {
      out.done_tasks = db.prepare("DELETE FROM tasks WHERE status = 'done' AND COALESCE(updated_at, created_at, 0) < ?")
        .run(cutoff).changes;
    }
    out.total = out.notifications + out.connector_data + out.dismissed + out.focus + out.done_tasks;
    return out;
  },

  // ---------- Sync state ----------
  getSync(key, def = null) {
    const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    if (!r) return def;
    // 凭据类键：读出来时解密（已加密才处理，明文老数据原样返回）
    if (isSecretKey(key) && isEncrypted(r.value)) return decryptString(r.value, SECRET_KEY);
    return r.value;
  },
  setSync(key, value) {
    // 凭据类键：写进去时加密
    const stored = (isSecretKey(key) && typeof value === 'string' && value && !isEncrypted(value))
      ? encryptString(value, SECRET_KEY)
      : value;
    db.prepare('INSERT INTO sync_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, stored);
  },

  // ---------- Connector config ----------
  getConnector(source) {
    const row = db.prepare('SELECT * FROM connector_config WHERE source = ?').get(source) || null;
    if (!row) return null;
    // 对外始终给明文：加密只发生在磁盘上
    try { return { ...row, config_json: decryptConfigJson(row.config_json, SECRET_KEY) }; } catch { return row; }
  },
  setConnector(source, configJson, status, lastError = null) {
    const ts = now();
    db.prepare(`INSERT INTO connector_config (source,config_json,status,last_sync,last_error,updated_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(source) DO UPDATE SET
                  config_json=excluded.config_json,status=excluded.status,last_sync=excluded.last_sync,
                  last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .run(source, encryptConfigJson(configJson, SECRET_KEY), status, ts, lastError, ts);
    return this.getConnector(source);
  },
  listConnectors() {
    return db.prepare('SELECT * FROM connector_config ORDER BY source').all()
      .map((row) => { try { return { ...row, config_json: decryptConfigJson(row.config_json, SECRET_KEY) }; } catch { return row; } });
  },
  /** 删掉一个数据源的配置行（它导入的数据用 clearConnectorData 另删）。返回删掉了几行。 */
  deleteConnector(source) {
    return db.prepare('DELETE FROM connector_config WHERE source = ?').run(source).changes;
  },

  // ---------- Connector data ----------
  listConnectorData(source) {
    if (source) return db.prepare('SELECT * FROM connector_data WHERE source = ? ORDER BY COALESCE(start_at, due_at) ASC').all(source);
    return db.prepare('SELECT * FROM connector_data ORDER BY source, COALESCE(start_at, due_at) ASC').all();
  },
  countConnectorData(source) {
    const r = db.prepare('SELECT COUNT(*) c FROM connector_data WHERE source = ?').get(source);
    return r ? r.c : 0;
  },
  clearConnectorData(source) {
    db.prepare('DELETE FROM connector_data WHERE source = ?').run(source);
  },
  // meta: { score, verdict, reasons[] } —— 相关度裁决（信息筛选 P0）
  insertConnectorData(source, item, approved = 1, meta = {}) {
    const id = randomUUID();
    db.prepare(`INSERT INTO connector_data (id,source,kind,external_id,title,start_at,end_at,due_at,url,notes,payload,imported_at,approved,score,verdict,reasons)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, source, item.kind, item.external_id || null, item.title, item.start_at || null,
        item.end_at || null, item.due_at || null, item.url || null, item.notes || null,
        JSON.stringify(item.payload || {}), now(), approved ? 1 : 0,
        Number.isFinite(meta.score) ? meta.score : null,
        typeof meta.verdict === 'string' ? meta.verdict : null,
        meta.reasons ? JSON.stringify(meta.reasons) : null);
    return id;
  },
  listPending() {
    return db.prepare('SELECT * FROM connector_data WHERE approved = 0 ORDER BY COALESCE(start_at, due_at) ASC').all();
  },
  /** 回填某条外部数据的裁决（语义兜底用）。 */
  updateConnectorVerdict(id, { verdict, score, reasons } = {}) {
    db.prepare('UPDATE connector_data SET verdict = ?, score = ?, reasons = ? WHERE id = ?')
      .run(verdict ?? null, Number.isFinite(score) ? score : null,
        reasons ? JSON.stringify(reasons) : null, id);
    return db.prepare('SELECT * FROM connector_data WHERE id = ?').get(id);
  },
  approveConnectorData(id) {
    db.prepare('UPDATE connector_data SET approved = 1 WHERE id = ?').run(id);
    return db.prepare('SELECT * FROM connector_data WHERE id = ?').get(id);
  },
  deleteConnectorData(id) {
    db.prepare('DELETE FROM connector_data WHERE id = ?').run(id);
  },

  // ---------- Course schedule (课表) ----------
  listCourses() {
    return db.prepare('SELECT * FROM course_schedule ORDER BY weekday, start_at').all();
  },
  getCourse(id) {
    return db.prepare('SELECT * FROM course_schedule WHERE id = ?').get(id);
  },
  createCourse(c) {
    const id = randomUUID();
    const ts = now();
    db.prepare(`INSERT INTO course_schedule (id,course,weekday,start_at,end_at,location,platform,teacher,weeks,color,source,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, c.course, c.weekday, c.start_at, c.end_at, c.location ?? '', c.platform ?? '',
        c.teacher ?? '', c.weeks ?? '', c.color ?? '#4f7cff', c.source ?? 'manual', ts, ts);
    return this.getCourse(id);
  },
  updateCourse(id, p) {
    const cur = this.getCourse(id); if (!cur) return null;
    const next = { ...cur, ...p, updated_at: now() };
    db.prepare(`UPDATE course_schedule SET course=?,weekday=?,start_at=?,end_at=?,location=?,platform=?,teacher=?,weeks=?,color=?,updated_at=? WHERE id=?`)
      .run(next.course, next.weekday, next.start_at, next.end_at, next.location, next.platform ?? null,
        next.teacher, next.weeks, next.color, next.updated_at, id);
    return this.getCourse(id);
  },
  deleteCourse(id) {
    db.prepare('DELETE FROM course_schedule WHERE id = ?').run(id);
  },
  clearCourses() {
    db.prepare('DELETE FROM course_schedule').run();
  },
  bulkInsertCourses(rows) {
    let n = 0;
    for (const c of rows) { this.createCourse(c); n++; }
    return n;
  },

  // ---------- Academic calendar (校历) ----------
  listAcademic() {
    return db.prepare('SELECT * FROM academic_events ORDER BY start_at').all();
  },
  getAcademic(id) {
    return db.prepare('SELECT * FROM academic_events WHERE id = ?').get(id);
  },
  createAcademic(a) {
    const id = randomUUID();
    const ts = now();
    db.prepare(`INSERT INTO academic_events (id,title,start_at,end_at,kind,notes,color,source,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, a.title, a.start_at, a.end_at ?? null, a.kind ?? 'general', a.notes ?? '',
        a.color ?? '#ffd166', a.source ?? 'manual', ts, ts);
    return this.getAcademic(id);
  },
  updateAcademic(id, p) {
    const cur = this.getAcademic(id); if (!cur) return null;
    const next = { ...cur, ...p, updated_at: now() };
    db.prepare(`UPDATE academic_events SET title=?,start_at=?,end_at=?,kind=?,notes=?,color=?,updated_at=? WHERE id=?`)
      .run(next.title, next.start_at, next.end_at, next.kind, next.notes, next.color, next.updated_at, id);
    return this.getAcademic(id);
  },
  deleteAcademic(id) {
    db.prepare('DELETE FROM academic_events WHERE id = ?').run(id);
  },
  clearAcademic() {
    db.prepare('DELETE FROM academic_events').run();
  },
  bulkInsertAcademic(rows) {
    let n = 0;
    for (const a of rows) { this.createAcademic(a); n++; }
    return n;
  },

  // ---------- Habits ----------
  listHabits() { return db.prepare('SELECT * FROM habits ORDER BY created_at').all(); },
  getHabit(id) { return db.prepare('SELECT * FROM habits WHERE id = ?').get(id); },
  createHabit(h) {
    const id = randomUUID(); const ts = now();
    db.prepare('INSERT INTO habits (id,name,icon,color,target,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, h.name, h.icon ?? '🎯', h.color ?? '#e60012', h.target ?? 1, ts, ts);
    return this.getHabit(id);
  },
  updateHabit(id, p) {
    const cur = this.getHabit(id); if (!cur) return null;
    const next = { ...cur, ...p, updated_at: now() };
    db.prepare('UPDATE habits SET name=?,icon=?,color=?,target=?,updated_at=? WHERE id=?')
      .run(next.name, next.icon, next.color, next.target, next.updated_at, id);
    return this.getHabit(id);
  },
  deleteHabit(id) {
    db.prepare('DELETE FROM habits WHERE id = ?').run(id);
    db.prepare('DELETE FROM habit_logs WHERE habit_id = ?').run(id);
  },
  listHabitLogs(habitId) {
    if (habitId) return db.prepare('SELECT * FROM habit_logs WHERE habit_id = ? ORDER BY date').all(habitId);
    return db.prepare('SELECT * FROM habit_logs ORDER BY date').all();
  },
  logFor(habitId, date) {
    return db.prepare('SELECT * FROM habit_logs WHERE habit_id = ? AND date = ?').get(habitId, date);
  },
  toggleHabitLog(habitId, date) {
    const cur = this.logFor(habitId, date);
    const ts = now();
    if (cur) {
      db.prepare('UPDATE habit_logs SET done=?,updated_at=? WHERE id=?').run(cur.done ? 0 : 1, ts, cur.id);
      return this.logFor(habitId, date);
    }
    const id = randomUUID();
    db.prepare('INSERT INTO habit_logs (id,habit_id,date,done,created_at,updated_at) VALUES (?,?,?,1,?,?)')
      .run(id, habitId, date, ts, ts);
    return this.logFor(habitId, date);
  },

  // ---------- Focus sessions ----------
  listFocus() { return db.prepare('SELECT * FROM focus_sessions ORDER BY started_at DESC').all(); },
  createFocus(f) {
    const id = randomUUID();
    db.prepare('INSERT INTO focus_sessions (id,label,started_at,ended_at,minutes,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, f.label ?? '', f.started_at, f.ended_at, f.minutes, now());
    return db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(id);
  },
  deleteFocus(id) { db.prepare('DELETE FROM focus_sessions WHERE id = ?').run(id); },

  // ---------- Milestones ----------
  listMilestones() { return db.prepare('SELECT * FROM milestones ORDER BY target_at').all(); },
  createMilestone(m) {
    const id = randomUUID(); const ts = now();
    db.prepare('INSERT INTO milestones (id,title,target_at,kind,note,done,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, m.title, m.target_at, m.kind ?? 'date', m.note ?? '', m.done ? 1 : 0, ts, ts);
    return db.prepare('SELECT * FROM milestones WHERE id = ?').get(id);
  },
  updateMilestone(id, p) {
    const cur = db.prepare('SELECT * FROM milestones WHERE id = ?').get(id); if (!cur) return null;
    const next = { ...cur, ...p, updated_at: now() };
    db.prepare('UPDATE milestones SET title=?,target_at=?,kind=?,note=?,done=?,updated_at=? WHERE id=?')
      .run(next.title, next.target_at, next.kind, next.note, next.done ? 1 : 0, next.updated_at, id);
    return db.prepare('SELECT * FROM milestones WHERE id = ?').get(id);
  },
  deleteMilestone(id) { db.prepare('DELETE FROM milestones WHERE id = ?').run(id); },

  // ---------- 备份（2026-09-24）----------
  /** 数据库文件在哪（备份要判断"库里有没有变过"）。 */
  path() { return DB_PATH; },
  /**
   * 生成一份**一致**的快照：SQLite 自带的 `VACUUM INTO`（WAL 下也安全，
   * 不像直接拷文件可能拷到写了一半的库）。目标文件已存在会失败 —— **不覆盖**。
   */
  backupTo(file) {
    try {
      db.prepare('VACUUM INTO ?').run(String(file));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  },
};

export { DB_PATH };
