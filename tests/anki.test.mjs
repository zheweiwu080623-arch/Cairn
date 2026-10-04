// Anki 只读接入的验证（lib/anki.mjs）。
//
//   node tests/anki.test.mjs
//
// 用**合成的 Anki 库**当夹具：不碰用户真实的 collection，也不需要装 Anki。
// 断言三件事：
//   ① 能从一个模拟的 %APPDATA%\Anki2\<profile>\ 里找到库；
//   ② 今日到期数按 queue/type/due 正确分类（新卡 / 学习中 / 复习）；
//   ③ 库不存在或缺表时收敛成 { ok:false }，不抛错。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describeAnki, findAnkiProfile, readAnki } from '../lib/anki.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('anki.test.mjs');

const DAY = 86400000;
const CRT_SEC = Math.floor((Date.now() - 10 * DAY) / 1000);   // 夹具库"创建于 10 天前"
const NOW = CRT_SEC * 1000 + 10 * DAY;                        // 正好第 10 天
const base = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'cairn-anki-test-'));
const profileDir = join(base, '账户 1');
mkdirSync(profileDir, { recursive: true });
const dbPath = join(profileDir, 'collection.anki2');

{
  const db = new DatabaseSync(dbPath);
  db.exec('create table col (id integer primary key, crt integer, mod integer, scm integer, usn integer, ls integer)');
  db.exec('create table decks (id integer primary key, name text)');
  db.exec('create table notes (id integer primary key)');
  db.exec('create table cards (id integer primary key, did integer, queue integer, type integer, due integer)');
  db.prepare('insert into col values (1, ?, 0, 0, 0, ?)').run(CRT_SEC, 0);
  db.prepare('insert into decks values (1, ?)').run('系统默认');
  db.prepare('insert into decks values (2, ?)').run('MATH1860J');
  for (let i = 0; i < 5; i += 1) db.prepare('insert into cards values (?, 2, 0, 0, ?)').run(100 + i, i);        // 5 张新卡
  for (let i = 0; i < 3; i += 1) db.prepare('insert into cards values (?, 2, 1, 1, ?)').run(200 + i, Math.floor(NOW / 1000) - 60); // 3 张学习中到期
  for (let i = 0; i < 4; i += 1) db.prepare('insert into cards values (?, 2, 2, 2, ?)').run(300 + i, 9);       // 4 张复习到期（第 10 天）
  db.prepare('insert into cards values (?, 2, 2, 2, ?)').run(400, 99);                                          // 1 张未来才到期
  db.prepare('insert into cards values (?, 2, -1, 2, ?)').run(401, 0);                                          // 1 张挂起（不算）
  db.prepare('insert into notes values (1)').run();
  db.close();
}

ok('能在模拟的 Anki2 目录里找到配置', (findAnkiProfile(base) || {}).name === '账户 1');

const a = readAnki({ baseDir: base, nowMs: NOW });
ok('读取成功', a.ok === true, a.error);
ok('卡组读到 2 个（按到期数排序）', a.decks.length === 2 && a.decks[0].name === 'MATH1860J');
ok('新卡 5 张', a.due.new === 5, String(a.due.new));
ok('学习中到期 3 张', a.due.learning === 3, String(a.due.learning));
ok('复习到期 4 张（未来 1 张与挂起 1 张都不算）', a.due.review === 4, String(a.due.review));
ok('今日合计 = 12', a.due.total === 12, String(a.due.total));
ok('总卡片数 14 / 笔记 1', a.total_cards === 14 && a.total_notes === 1);
ok('没同步过时 never_synced=true', a.never_synced === true);
ok('摘要里给出待复习张数', /今日待复习 12/.test(describeAnki(a)), describeAnki(a));

{
  const empty = join(base, '空目录');
  mkdirSync(empty, { recursive: true });
  const r = readAnki({ baseDir: empty });
  ok('找不到库时收敛为 ok:false（不抛错）', r.ok === false && typeof r.error === 'string');
}

{
  const brokenDir = join(base, '坏库');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'collection.anki2'), 'not a sqlite file');
  const r = readAnki({ baseDir: join(base, '..', '不存在') });
  ok('目录不存在也不炸', r.ok === false);
}

// ---------------- 老 schema：AnkiDroid / 老版 Anki 没有 decks 表 ----------------
// 2026-10-02 真踩过：拿平板 AnkiDroid 的备份读，报 "no such table: decks"。
// 它们的卡组存在 col.decks 那一列 JSON 里，所以要两条路都认。
{
  const legacyDir = join(base, 'AnkiDroid', '老库');
  mkdirSync(legacyDir, { recursive: true });
  const db = new DatabaseSync(join(legacyDir, 'collection.anki2'));
  db.exec('create table col (id integer primary key, crt integer, mod integer, scm integer, usn integer, ls integer, decks text)');
  db.exec('create table notes (id integer primary key)');
  db.exec('create table cards (id integer primary key, did integer, queue integer, type integer, due integer)');
  db.prepare('insert into col values (1, ?, 0, 0, 0, 0, ?)').run(
    CRT_SEC,
    JSON.stringify({ 1: { id: 1, name: '默认' }, 77: { id: 77, name: 'STAT1000J' } }),
  );
  db.prepare('insert into cards values (?, 77, 0, 0, 0)').run(500);                    // 1 张新卡
  db.prepare('insert into cards values (?, 77, 2, 2, 9)').run(501);                    // 1 张复习到期
  db.prepare('insert into notes values (1)').run();
  db.close();

  const r = readAnki({ baseDir: join(base, 'AnkiDroid'), nowMs: NOW });
  ok('老 schema（没有 decks 表）也读得出来', r.ok === true, r.error);
  ok('老 schema：卡组名从 col.decks 的 JSON 里取', r.ok && r.decks.length === 2 && r.decks[0].name === 'STAT1000J',
    r.ok ? JSON.stringify(r.decks) : r.error);
  ok('老 schema：今日待复习 2（新 1 + 复习 1）', r.ok && r.due.total === 2 && r.due.new === 1 && r.due.review === 1,
    r.ok ? JSON.stringify(r.due) : r.error);
}

console.log('');
console.log(failures === 0 ? 'anki.test: PASS' : `anki.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
