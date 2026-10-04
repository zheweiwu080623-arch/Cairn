// anki.mjs —— **只读**读取本机 Anki 的 collection，给 Cairn 提供"今天要复习多少张"。
//
// 为什么不能直接打开 Anki 的库：
//   * Anki 运行时用的是 WAL 模式，直接开会 `database is locked`；
//   * 它的 schema 用了自定义排序规则 `unicase`，某些查询会报
//     `no such collation sequence`（Node 的 node:sqlite 没有 createCollation）。
// 做法：**先把 collection.anki2 + -wal + -shm 复制到临时目录再读**，全程不碰 Anki 的活动库；
// 查询一律不写 ORDER BY（避免触发 unicase），需要的排序在 JS 里做。
//
// 注意：这里算的是"库里到期的张数"（估算），**没有**套用 Anki 的每日上限/新卡上限，
// 所以它适合做"提醒"，不适合当成 Anki 界面上的精确数字。

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 86400000;

/** 找出第一个可用的 Anki 配置目录（默认 %APPDATA%\Anki2）。 */
export function findAnkiProfile(baseDir = join(process.env.APPDATA || '', 'Anki2')) {
  if (!baseDir || !existsSync(baseDir)) return null;
  let names = [];
  try {
    names = readdirSync(baseDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const p = join(baseDir, name, 'collection.anki2');
    try {
      if (statSync(p).isFile()) return { baseDir, name, collection: p };
    } catch { /* 不是配置目录 */ }
  }
  return null;
}

/**
 * 挑一个**真能写**的临时目录。
 * 为什么不是直接 tmpdir()：有的环境（受限沙箱、某些受管控的机器）%TEMP% 是只读的，
 * 那时 mkdtemp 直接 EPERM。这里按 CAIRN_ANKI_TMP → PLANNER_TEST_TMP → 系统临时目录依次试，
 * 全都不行就给一句人话，而不是把调用方炸掉。
 */
function pickTempBase() {
  const candidates = [process.env.CAIRN_ANKI_TMP, process.env.PLANNER_TEST_TMP, tmpdir()].filter(Boolean);
  for (const base of candidates) {
    try { return mkdtempSync(join(base, 'cairn-anki-')); } catch { /* 换下一个 */ }
  }
  return '';
}

function withReadonlyCopy(collection, fn) {
  const tmp = pickTempBase();
  if (!tmp) throw new Error('临时目录不可写（CAIRN_ANKI_TMP / PLANNER_TEST_TMP / 系统临时目录都试过了）');
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const src = collection + suffix;
      if (existsSync(src)) copyFileSync(src, join(tmp, 'collection.anki2' + suffix));
    }
    const db = new DatabaseSync(join(tmp, 'collection.anki2'));
    try {
      return fn(db);
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 读一次，返回结构化状态。任何异常都收敛成 { ok:false, error }，绝不让调用方崩。 */
export function readAnki({ baseDir, nowMs = Date.now() } = {}) {
  const profile = findAnkiProfile(baseDir);
  if (!profile) return { ok: false, error: '没找到 Anki 配置目录（还没装桌面版，或还没运行过）' };
  try {
    return withReadonlyCopy(profile.collection, (db) => {
      const col = db.prepare('select id, crt, mod, scm, usn, ls from col').get();
      // 卡组在哪儿，取决于是哪一代 schema：
      //   * 新版 Anki（26.x）：独立的 `decks` 表；
      //   * AnkiDroid / 老版 Anki：`col.decks` 一列 JSON（真的会没有 `decks` 表 —— 2026-10-02
      //     拿平板 AnkiDroid 的备份试过，直接 select decks 会报 "no such table: decks"）。
      const tableNames = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => r.name));
      const deckRows = tableNames.has('decks')
        ? db.prepare('select id, name from decks').all().map((d) => ({ id: String(d.id), name: d.name }))
        : Object.entries(JSON.parse(db.prepare('select decks from col').get().decks || '{}'))
          .map(([id, d]) => ({ id: String(id), name: (d && d.name) || String(id) }));
      const cards = db.prepare('select count(*) as n from cards').get().n;
      const notes = db.prepare('select count(*) as n from notes').get().n;

      // 按 queue 统计：-1 挂起 / 0 新卡 / 1,3 学习中 / 2 复习 / -2,-3 延后
      const byQueue = {};
      for (const r of db.prepare('select queue as q, count(*) as n from cards group by queue').all()) {
        byQueue[String(r.q)] = r.n;
      }

      // Anki 的 due 对"复习卡"是天数（相对 crt），对"学习卡"是时间戳（秒）
      const daysSinceCrt = Math.floor((nowMs - Number(col.crt) * 1000) / DAY_MS);
      const nowSec = Math.floor(nowMs / 1000);
      const dueNew = db.prepare('select count(*) as n from cards where type = 0 and queue = 0').get().n;
      const dueLearning = db.prepare('select count(*) as n from cards where queue in (1,3) and due <= ?').get(nowSec).n;
      const dueReview = db.prepare('select count(*) as n from cards where queue = 2 and due <= ?').get(daysSinceCrt).n;

      // 卡组层面的到期数
      const perDeck = db.prepare(
        'select did, '
        + "sum(case when queue = 0 and type = 0 then 1 else 0 end) as new_n, "
        + "sum(case when queue in (1,3) and due <= ? then 1 else 0 end) as learn_n, "
        + "sum(case when queue = 2 and due <= ? then 1 else 0 end) as review_n, "
        + 'count(*) as total '
        + 'from cards group by did',
      ).all(nowSec, daysSinceCrt);

      // 以卡组清单为准（没有卡的卡组也列出来，避免"库里明明有卡组却看不到"）
      const counts = new Map(perDeck.map((d) => [String(d.did), d]));
      const deckList = deckRows.map((d) => {
        const c = counts.get(d.id);
        return {
          id: d.id,
          name: d.name,
          new: c ? c.new_n : 0,
          learning: c ? c.learn_n : 0,
          review: c ? c.review_n : 0,
          total: c ? c.total : 0,
        };
      }).sort((a, b) => (b.review + b.learning + b.new) - (a.review + a.learning + a.new));

      const lastSyncMs = Number(col.ls) || 0;
      return {
        ok: true,
        profile: profile.name,
        collection: profile.collection,
        created_at: new Date(Number(col.crt) * 1000).toISOString(),
        last_sync_ms: lastSyncMs,
        last_sync_at: lastSyncMs ? new Date(lastSyncMs).toISOString() : null,
        never_synced: !lastSyncMs,
        total_cards: cards,
        total_notes: notes,
        decks: deckList,
        due: { new: dueNew, learning: dueLearning, review: dueReview, total: dueNew + dueLearning + dueReview },
        by_queue: byQueue,
        note: '按库中到期数估算，未套用 Anki 的每日上限',
      };
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 给界面用的一句话摘要。 */
export function describeAnki(a) {
  if (!a || !a.ok) return a && a.error ? `Anki 读取失败：${a.error}` : 'Anki 未接入';
  if (!a.total_cards) return a.never_synced ? 'Anki 库是空的（还没同步过）' : 'Anki 库是空的';
  const parts = [`今日待复习 ${a.due.total}`];
  if (a.due.new) parts.push(`新 ${a.due.new}`);
  if (a.due.learning) parts.push(`学习中 ${a.due.learning}`);
  if (a.due.review) parts.push(`复习 ${a.due.review}`);
  parts.push(`共 ${a.total_cards} 张`);
  return parts.join(' · ');
}
