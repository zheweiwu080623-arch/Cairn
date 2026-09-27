// migrations.mjs —— 数据版本迁移登记处
//
// 为什么需要这个文件：
//   这个平台已经在真实使用中（库里有真数据），以后发布新版本时**不能要求用户"删库重来"**。
//   所以每一次对数据库结构的改动都要：**有编号、只跑一次、跑过留痕**。
//
// 约定（很重要，写在最前面）：
//   1. `version` 只增不改。已经发布过的迁移不要再改内容 —— 要改就新开一个号。
//   2. `up(db)` 必须**幂等**：万一台账丢了（手工拷库、旧版本回滚），重跑不能出错、不能丢数据。
//   3. 这里**只做结构变更与安全回填**，不做删除。
//   4. 用户能在 `/api/status` 的「数据」一节里看到 `数据版本 N（M 项已应用）`。
//
// 这个文件不依赖 store.mjs，可以被测试单独拿来在临时库上跑。

/** 取一张表现有的列名（表不存在返回 []） */
export function tableColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * 加列（已经有了就跳过）。
 * @param {string} definition 列定义，例如 'TEXT' / "INTEGER DEFAULT 0"
 * @returns {boolean} 是否真的加了
 */
export function ensureColumn(db, table, column, definition) {
  const cols = tableColumns(db, table);
  if (!cols.length) return false;              // 表都没有：交给建表语句处理，别在这里造半个表
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/** 建表（已经存在就跳过）；ddl 里请自带 IF NOT EXISTS */
export function ensureTable(db, ddl) {
  db.exec(ddl);
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------- 迁移清单
//
// 1～6 是"补登记"：这些改动在台账出现之前就已经在 store.mjs 里做了，
// 所以下面的 up() 全部写成幂等形式 —— 老库跑一遍等于确认"确实有了"，
// 新库跑一遍等于把结构补齐。**从 7 开始，每条迁移都必须是真正的新改动。**
export const MIGRATIONS = [
  {
    version: 1,
    name: '基线：核心表（tasks / events / notifications / sync_state …）',
    up() { /* 基线由 store.mjs 的建表语句负责 */ },
  },
  {
    version: 2,
    name: 'connector_data：加裁决列 score / verdict / reasons',
    up(db) {
      ensureColumn(db, 'connector_data', 'score', 'REAL');
      ensureColumn(db, 'connector_data', 'verdict', 'TEXT');
      ensureColumn(db, 'connector_data', 'reasons', 'TEXT');
      ensureColumn(db, 'connector_data', 'approved', 'INTEGER DEFAULT 0');
    },
  },
  {
    version: 3,
    name: 'notifications：加 external_id / priority / url',
    up(db) {
      ensureColumn(db, 'notifications', 'external_id', 'TEXT');
      ensureColumn(db, 'notifications', 'priority', 'INTEGER DEFAULT 0');
      ensureColumn(db, 'notifications', 'url', 'TEXT');
    },
  },
  {
    version: 4,
    name: 'course_files：加 local_name / file_date',
    up(db) {
      ensureColumn(db, 'course_files', 'local_name', 'TEXT');
      ensureColumn(db, 'course_files', 'file_date', 'INTEGER');
    },
  },
  {
    version: 5,
    name: 'course_schedule：加 platform（线上上课平台）',
    up(db) {
      ensureColumn(db, 'course_schedule', 'platform', "TEXT DEFAULT ''");
    },
  },
  {
    version: 6,
    name: 'dismissed_notifications：建「已忽略通知」表',
    up(db) {
      ensureTable(db, `
CREATE TABLE IF NOT EXISTS dismissed_notifications (
  key          TEXT PRIMARY KEY,
  source       TEXT DEFAULT '',
  dismissed_at INTEGER
);
`);
    },
  },
];

/** 当前数据版本 = 已应用的最大编号（一条都没应用时为 0） */
export function currentSchemaVersion(db) {
  ensureTable(db, LEDGER_DDL);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return Number(row?.v || 0);
}

/** 每条迁移的应用情况，给界面/接口看 */
export function listMigrations(db) {
  ensureTable(db, LEDGER_DDL);
  const applied = new Map(
    db.prepare('SELECT version, name, applied_at FROM schema_migrations').all()
      .map((r) => [Number(r.version), r]),
  );
  return MIGRATIONS.map((m) => ({
    version: m.version,
    name: m.name,
    applied: applied.has(m.version),
    applied_at: applied.get(m.version)?.applied_at ?? null,
  }));
}

/**
 * 跑所有还没跑的迁移。**只跑没跑过的**，跑过的绝不重跑。
 * @returns {{version:number, applied:number, ran:{version:number,name:string}[], total:number}}
 */
export function runMigrations(db, { log = () => {} } = {}) {
  ensureTable(db, LEDGER_DDL);
  const done = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => Number(r.version)),
  );
  const ran = [];
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    try {
      m.up(db);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, Date.now());
      ran.push({ version: m.version, name: m.name });
      log(`[migrate] 已应用 #${m.version} ${m.name}`);
    } catch (e) {
      // 一条迁移失败就停下，但**不要把失败的那条记成已应用** —— 下次启动会重试
      throw new Error(`数据迁移 #${m.version}（${m.name}）失败：${e.message}`);
    }
  }
  return {
    version: currentSchemaVersion(db),
    applied: done.size + ran.length,
    ran,
    total: MIGRATIONS.length,
  };
}

/** 一句话摘要，给 /api/status 用 */
export function migrationSummary(db) {
  const rows = listMigrations(db);
  const applied = rows.filter((r) => r.applied).length;
  return {
    version: currentSchemaVersion(db),
    applied,
    total: rows.length,
    pending: rows.filter((r) => !r.applied).map((r) => r.version),
    detail: `数据版本 ${currentSchemaVersion(db)}（${applied}/${rows.length} 项已应用）`,
  };
}
