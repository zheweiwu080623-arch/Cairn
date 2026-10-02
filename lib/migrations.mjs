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

import { randomUUID } from 'node:crypto';

import { DEFAULT_CARDS, NATIVE_CARDS } from './dashboard.mjs';

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
  {
    version: 7,
    name: '数据模型三小件：first_seen_at / is_deleted / search_text + 幂等唯一索引',
    up(db) {
      // 约定：迁移可能跑在"表还没建"的空库上（新装用户的建表语句会直接把列建好）。
      // 所以每一步都先确认表存在，缺表就整段跳过。
      if (!tableColumns(db, 'connector_data').length) return;

      // ---- 连接器数据（connector_data）----
      ensureColumn(db, 'connector_data', 'first_seen_at', 'INTEGER');
      ensureColumn(db, 'connector_data', 'is_deleted', 'INTEGER DEFAULT 0');
      ensureColumn(db, 'connector_data', 'search_text', "TEXT DEFAULT ''");

      // 老库可能缺列，回填要按"实际有什么列"来写（参考 tests/migrations.test.mjs 的 legacy 场景）
      const connCols = tableColumns(db, 'connector_data');
      const hasConnCol = (c) => connCols.includes(c);

      // first_seen_at：有 imported_at 就用它（老库里它就是"第一次导入的时间"），否则记 0（未知）
      db.exec(
        hasConnCol('imported_at')
          ? 'UPDATE connector_data SET first_seen_at = imported_at WHERE first_seen_at IS NULL'
          : 'UPDATE connector_data SET first_seen_at = 0 WHERE first_seen_at IS NULL'
      );

      // search_text：用实际存在的文本列拼
      const textParts = ['title', 'kind', 'notes'].filter(hasConnCol).map((c) => `coalesce(${c},'')`);
      db.exec(
        textParts.length
          ? `UPDATE connector_data SET search_text = lower(trim(${textParts.join(" || ' ' || ")}))
               WHERE search_text IS NULL OR search_text = ''`
          : "UPDATE connector_data SET search_text = '' WHERE search_text IS NULL"
      );

      // 幂等键 + 检索索引（键要求 source/external_id 两列都在）
      if (hasConnCol('source') && hasConnCol('external_id') && hasConnCol('id')) {
        // 空 external_id 给一个稳定的合成值：唯一索引不允许出现两个空串
        db.exec(`UPDATE connector_data SET external_id = 'row:' || id
                  WHERE external_id IS NULL OR external_id = ''`);

        // 历史重复：**保留最早的一行**，其余标软删并给 external_id 加后缀（不删任何数据）
        const dups = db.prepare(`
          SELECT id, external_id FROM connector_data
           WHERE rowid NOT IN (SELECT MIN(rowid) FROM connector_data GROUP BY source, external_id)
        `).all();
        const softDel = db.prepare('UPDATE connector_data SET is_deleted = 1, external_id = ? WHERE id = ?');
        for (const d of dups) softDel.run(`${d.external_id}#dup:${d.id}`, d.id);

        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_data_source_external ON connector_data(source, external_id)');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_connector_data_search ON connector_data(search_text)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_connector_data_first_seen ON connector_data(first_seen_at)');

      // ---- 通知（notifications）----
      if (!tableColumns(db, 'notifications').length) return;
      ensureColumn(db, 'notifications', 'first_seen_at', 'INTEGER');
      ensureColumn(db, 'notifications', 'is_deleted', 'INTEGER DEFAULT 0');
      db.exec(
        tableColumns(db, 'notifications').includes('created_at')
          ? 'UPDATE notifications SET first_seen_at = created_at WHERE first_seen_at IS NULL'
          : 'UPDATE notifications SET first_seen_at = 0 WHERE first_seen_at IS NULL'
      );
    },
  },
  {
    version: 8,
    name: 'job_runs：建「作业运行记录」表（回答"那轮跑了多久、成功没"）',
    up(db) {
      ensureTable(db, `
CREATE TABLE IF NOT EXISTS job_runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  trigger     TEXT NOT NULL,        -- tick | manual | startup
  status      TEXT NOT NULL,        -- ok | failed
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  summary     TEXT,
  error       TEXT,
  session_id  TEXT,
  meta_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, started_at);
CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
`);
    },
  },
  {
    version: 9,
    name: 'dashboard_cards：建「首页卡片」表（插一行数据 = 首页多一张卡）',
    up(db) {
      ensureTable(db, `
CREATE TABLE IF NOT EXISTS dashboard_cards (
  id          TEXT PRIMARY KEY,
  module_id   TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  size        TEXT DEFAULT 'md',
  position    INTEGER DEFAULT 0,
  config_json TEXT,
  created_at  INTEGER,
  updated_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_cards_unique ON dashboard_cards(module_id, card_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_cards_position ON dashboard_cards(position);
`);
    },
  },
  {
    version: 10,
    name: 'dashboard_cards：把首页原有的面板（今日日程 / 今天的安排 / 学生 …）也纳入卡片表',
    up(db) {
      ensureTable(db, `
CREATE TABLE IF NOT EXISTS dashboard_cards (
  id          TEXT PRIMARY KEY,
  module_id   TEXT NOT NULL,
  card_id     TEXT NOT NULL,
  size        TEXT DEFAULT 'md',
  position    INTEGER DEFAULT 0,
  config_json TEXT,
  created_at  INTEGER,
  updated_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_cards_unique ON dashboard_cards(module_id, card_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_cards_position ON dashboard_cards(position);
`);
      // 全新的库：表还是空的 ⇒ 这里**什么都不插**，交给启动时的 DEFAULT_CARDS 一次装齐。
      // （要是在这儿插了一半，seed 看到"表非空"就整批不装了 —— 版本 1 天那种坑。）
      const n = Number(db.prepare('SELECT COUNT(*) AS n FROM dashboard_cards').get()?.n || 0);
      if (!n) return;

      // 已经在用的库：把还没有的原生面板行**追加到末尾**，一次就够。
      // 之后用户删掉哪张就是哪张（这里不会再插回来），所以删除是能记住的。
      const have = new Set(
        db.prepare("SELECT card_id FROM dashboard_cards WHERE module_id = 'native'").all()
          .map((r) => r.card_id),
      );
      let pos = Number(db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM dashboard_cards').get()?.p ?? -1) + 1;
      const ins = db.prepare(`INSERT INTO dashboard_cards
        (id,module_id,card_id,size,position,config_json,created_at,updated_at)
        VALUES (?,?,?,?,?,NULL,?,?)`);
      const at = Date.now();
      for (const [card_id, t] of Object.entries(NATIVE_CARDS)) {
        if (have.has(card_id)) continue;
        ins.run(randomUUID(), 'native', card_id, t.size, pos, at, at);
        pos += 1;
      }
    },
  },
  {
    version: 11,
    name: '首页卡片：默认排布改回"原来的内容在前、新加的三张卡在后"',
    up(db) {
      // 版本 10 是把原生面板**追加**在已有的三张内置卡后面的（那时内置卡在最上面）。
      // 现在改成"原来首页的样子在前" —— 但**只动还没被用户调过的那一套默认排布**：
      // 开头三张仍然是 builtin/today,jobs,sources 才认（用户动过就一律不碰）。
      const rows = db.prepare('SELECT id, module_id, card_id, position FROM dashboard_cards ORDER BY position').all();
      const key = (r) => `${r.module_id}/${r.card_id}`;
      if (rows.slice(0, 3).map(key).join(',') !== 'builtin/today,builtin/jobs,builtin/sources') return;

      const byKey = new Map(rows.map((r) => [key(r), r]));
      const canon = DEFAULT_CARDS.map(key);
      if (!canon.every((k) => byKey.has(k))) return;        // 缺卡（用户删过）→ 不动，尊重现状

      const rest = rows.map(key).filter((k) => !canon.includes(k));   // 用户另外加的卡跟在后面
      const upd = db.prepare('UPDATE dashboard_cards SET position = ?, updated_at = ? WHERE id = ?');
      const at = Date.now();
      [...canon, ...rest].forEach((k, i) => upd.run(i, at, byKey.get(k).id));
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
