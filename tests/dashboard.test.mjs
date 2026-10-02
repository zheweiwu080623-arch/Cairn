// 首页卡片（改造项 3）的验证。
//
//   node tests/dashboard.test.mjs
//
// 四类断言：
//   ① 「插一行数据 = 多一张卡」；
//   ② 一行坏数据不该把首页弄白；
//   ③ 各卡片类型算出来的内容对不对（今日 / 作业）；
//   ④ 契约与前端接线（契约合法、前端只认标题+几行）。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  CARD_SIZES, CARD_TYPES, DEFAULT_CARDS, DASHBOARD_SCHEMA, NATIVE_CARDS, availableCardTypes, buildDashboardVM,
  handleDashboardApi, seedDashboardCards,
} from '../lib/dashboard.mjs';
import { runMigrations } from '../lib/migrations.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('dashboard.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-02T10:00:00+08:00');

/** 假 store：只实现卡片引擎会用到的那几个方法。 */
function fakeStore({ cards = [], jobRuns = [], tasks = [], courses = [], connectors = [] } = {}) {
  const rows = cards.slice();
  return {
    listDashboardCards: () => rows.slice(),
    // 和真实 store 一样：按 (module_id, card_id) 命中就更新，否则新增
    upsertDashboardCard: (c) => {
      const ex = rows.find((r) => r.module_id === c.module_id && r.card_id === c.card_id);
      if (ex) { Object.assign(ex, { size: c.size, position: c.position }); return ex.id; }
      const id = 'id-' + c.module_id + '-' + c.card_id;
      rows.push({ id, config_json: null, ...c });
      return id;
    },
    deleteDashboardCard: (id) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
    listJobRuns: () => jobRuns,
    listTasks: () => tasks,
    listCourses: () => courses,
    listConnectors: () => connectors,
    countConnectorData: () => 7,
    _rows: rows,
  };
}

const card = (card_id, position, extra = {}) => ({
  id: 'c-' + card_id, module_id: 'builtin', card_id, size: 'md', position, config_json: null, ...extra,
});

// ---------------- ① 插一行 = 多一张卡 ----------------
{
  const store = fakeStore({ cards: [card('today', 0)] });
  const vm1 = buildDashboardVM(store, { nowMs: NOW });
  ok('一行数据 → 一张卡', vm1.count === 1 && vm1.cards[0].card_id === 'today');

  const newId = store.upsertDashboardCard({ module_id: 'builtin', card_id: 'jobs', size: 'sm', position: 1 });
  const vm2 = buildDashboardVM(store, { nowMs: NOW });
  ok('再插一行 → 多一张卡（不改任何代码）', vm2.count === 2 && vm2.cards[1].card_id === 'jobs');

  store.deleteDashboardCard(newId);
  ok('删掉那行 → 卡也没了', buildDashboardVM(store, { nowMs: NOW }).count === 1);

  const many = fakeStore({ cards: [card('sources', 5), card('today', 0), card('jobs', 2)] });
  ok('按 position 从小到大排',
    buildDashboardVM(many, { nowMs: NOW }).cards.map((c) => c.card_id).join(',') === 'today,jobs,sources');
}

// ---------------- ② 坏数据不弄白首页 ----------------
{
  const store = fakeStore({ cards: [card('不存在的卡', 0)] });
  const vm = buildDashboardVM(store, { nowMs: NOW });
  ok('未知 card_id → 给一张提示卡而不是抛错',
    vm.count === 1 && /认不出/.test(vm.cards[0].rows[0].label), JSON.stringify(vm.cards[0].rows));

  const broken = {
    listDashboardCards: () => [card('today', 0)],
    listTasks: () => { throw new Error('故意炸'); },
  };
  const vm2 = buildDashboardVM(broken, { nowMs: NOW });
  ok('卡片内部报错 → 只坏这一张（首页仍渲染得出来）',
    vm2.count === 1 && vm2.cards[0].rows[0].level === 'error' && /故意炸/.test(vm2.cards[0].rows[0].value));
  ok('size 不合法时退回 md',
    buildDashboardVM(fakeStore({ cards: [card('today', 0, { size: '巨大' })] }), { nowMs: NOW }).cards[0].size === 'md');
  ok('空表 → 空数组（不是 null）',
    (() => { const v = buildDashboardVM(fakeStore(), { nowMs: NOW }); return v.count === 0 && Array.isArray(v.cards); })());
}

// ---------------- ③ 卡片内容 ----------------
{
  const tasks = [
    { id: 't1', title: 'A', due_at: '2026-10-02T23:59:00', status: 'open' },
    { id: 't2', title: 'B', due_at: '2026-09-30T23:59:00', status: 'open' },
    { id: 't3', title: 'C', due_at: '2026-10-02T23:59:00', status: 'done' },
  ];
  const store = fakeStore({
    cards: [card('today', 0), card('jobs', 1)],
    tasks,
    jobRuns: [
      { job_id: 'autosync', status: 'ok', duration_ms: 1200, error: null },
      { job_id: 'digest', status: 'failed', duration_ms: 30, error: '网络超时' },
    ],
  });
  const vm = buildDashboardVM(store, { nowMs: NOW });
  const t = vm.cards.find((c) => c.card_id === 'today');
  const j = vm.cards.find((c) => c.card_id === 'jobs');
  ok('今日卡：今天到期 1、逾期 1、已完成不算',
    t.rows[0].value === '1' && t.rows[1].value === '1', JSON.stringify(t.rows));
  ok('作业卡：正常显示 ms、失败显示原因',
    j.rows.find((r) => r.label === 'autosync').value === '1200 ms'
    && j.rows.find((r) => r.label === 'digest').value === '失败'
    && /网络超时/.test(j.rows.find((r) => r.label === 'digest').meta), JSON.stringify(j.rows));
}

// ---------------- ④ 种子与契约 ----------------
{
  const store = fakeStore();
  ok('空表时安装默认卡片', seedDashboardCards(store) === DEFAULT_CARDS.length);
  ok('已有卡片时不重复安装', seedDashboardCards(store) === 0);
  ok('默认卡片都指向存在的类型（内置或原生面板）',
    DEFAULT_CARDS.every((c) => !!(CARD_TYPES[c.card_id] || NATIVE_CARDS[c.card_id])));
  ok('默认卡片里每种只出现一次',
    new Set(DEFAULT_CARDS.map((c) => `${c.module_id}/${c.card_id}`)).size === DEFAULT_CARDS.length);
  ok('九张原生面板都在默认卡片里（新装用户首页不会缺块）',
    Object.keys(NATIVE_CARDS).every((id) => DEFAULT_CARDS.some((c) => c.card_id === id)));
  ok('默认顺序 = 原来的首页（学生卡在最上、新加的三张内置卡在最下）',
    DEFAULT_CARDS[0].card_id === 'student'
    && DEFAULT_CARDS.slice(-3).map((c) => c.card_id).join(',') === 'today,jobs,sources',
    DEFAULT_CARDS.map((c) => c.card_id).join(','));

  const schema = JSON.parse(readFileSync(join(ROOT, 'contracts', 'dashboard.v1.schema.json'), 'utf8'));
  const need = ['id', 'module_id', 'card_id', 'size', 'position', 'kind', 'title', 'rows'];
  ok('契约是合法 JSON 且列了卡片必需字段',
    schema?.properties?.cards?.items?.required?.every((k) => need.includes(k)) === true);
  ok('契约里的 schema 名与代码一致', schema?.properties?.schema?.const === DASHBOARD_SCHEMA);
  ok('契约里的 size 枚举与代码一致',
    JSON.stringify(schema?.properties?.cards?.items?.properties?.size?.enum) === JSON.stringify(CARD_SIZES));

  const fe = readFileSync(join(ROOT, 'public', 'dashboard-cards.js'), 'utf8');
  ok('前端只拉 /api/dashboard，不认识具体业务',
    fe.includes("fetch('/api/dashboard'") && !fe.includes('listJobRuns'));
  ok('前端只按 标题 + 几行 渲染',
    fe.includes('c.title') && fe.includes('c.rows') && fe.includes('r.label') && fe.includes('r.value'));
  ok('前端脚本语法可解析（模板字符串里写正则最容易把整段搞坏）', (() => {
    try { new Function(fe); return true; } catch { return false; }
  })());
  ok('前端会搬原生面板：搬运而不是复制（同一个节点）+ 绝不清空整个网格',
    fe.includes('data-panel') && fe.includes('data-dash-gen') && fe.includes('insertBefore'));
  ok('前端带自激熔断（画太勤就停手，不再出现"狂闪"）',
    fe.includes('runaway') && fe.includes('paintTimes'));
  ok('index.html 已经挂上这个脚本',
    readFileSync(join(ROOT, 'public', 'index.html'), 'utf8').includes('/dashboard-cards.js'));
}

// ---------------- ⑤ 接口：添加 / 换位 / 改宽度 / 删除 ----------------
{
  const store = fakeStore({ cards: [card('today', 0), card('jobs', 1)] });
  const hit = async (method, path, body = {}) => {
    let res = null;
    const handled = await handleDashboardApi(
      { method, body }, {}, new URL('http://x' + path), store,
      { sendJson: (_r, code, obj) => { res = { code, obj }; }, readBody: async () => body },
    );
    return { handled, ...(res || {}) };
  };

  ok('不认领别的路径（返回 false 让主程序继续）', (await hit('GET', '/api/other')).handled === false);
  const avail = await hit('GET', '/api/dashboard/available');
  ok('可用类型 = 内置卡 + 原生面板',
    avail.code === 200
    && avail.obj.types.length === Object.keys(CARD_TYPES).length + Object.keys(NATIVE_CARDS).length
    && avail.obj.types.filter((t) => t.kind === 'native').length === Object.keys(NATIVE_CARDS).length);
  ok('可用类型带默认宽度（删了再加回来不会换宽度）',
    avail.obj.types.every((t) => CARD_SIZES.includes(t.size))
    && avail.obj.types.find((t) => t.id === 'sources').size === 'sm');

  const added = await hit('POST', '/api/dashboard/cards', { card_id: 'sources' });
  ok('添加：新卡默认排到最后',
    added.obj.dashboard.cards.map((c) => c.card_id).join(',') === 'today,jobs,sources');
  ok('添加：不带宽度就用这张卡的默认宽度（数据源=1/3）',
    added.obj.dashboard.cards.find((c) => c.card_id === 'sources').size === 'sm');
  ok('添加不存在的类型 → 400（不写脏数据）',
    (await hit('POST', '/api/dashboard/cards', { card_id: '不存在' })).code === 400);

  const ids = added.obj.dashboard.cards.map((c) => c.id);
  const moved = await hit('POST', `/api/dashboard/cards/${ids[2]}/move`, { delta: -1 });
  ok('上移：和上一张交换位置',
    moved.obj.dashboard.cards.map((c) => c.card_id).join(',') === 'today,sources,jobs');

  const stillFirst = await hit('POST', `/api/dashboard/cards/${ids[0]}/move`, { delta: -1 });
  ok('已经在最前面再上移 → 原地不动、不报错',
    stillFirst.obj.dashboard.cards.map((c) => c.card_id).join(',') === 'today,sources,jobs');

  const resized = await hit('POST', `/api/dashboard/cards/${ids[0]}/resize`, { size: 'lg' });
  ok('改宽度生效', resized.obj.dashboard.cards.find((c) => c.id === ids[0]).size === 'lg');

  const removed = await hit('POST', `/api/dashboard/cards/${ids[0]}/remove`);
  ok('删除生效', removed.obj.dashboard.count === 2);
  ok('对不存在的卡操作 → 404', (await hit('POST', '/api/dashboard/cards/nope/remove')).code === 404);
  ok('未知子路径 → 404', (await hit('GET', '/api/dashboard/whatever')).code === 404);
}

// ---------------- ⑥ 原生面板：内容在前端手里，位置在表里 ----------------
{
  const nativeRow = (card_id, position) => ({
    id: 'n-' + card_id, module_id: 'native', card_id, size: NATIVE_CARDS[card_id].size, position, config_json: null,
  });
  const store = fakeStore({ cards: [card('today', 0), nativeRow('codex', 1)] });
  const vm = buildDashboardVM(store, { nowMs: NOW });
  ok('原生面板：kind=native、标题来自登记表、不产出行（行是 app.js 画的）',
    vm.cards[1].kind === 'native' && vm.cards[1].title === NATIVE_CARDS.codex.title && vm.cards[1].rows.length === 0,
    JSON.stringify(vm.cards[1]));
  ok('内置卡：kind=builtin', vm.cards[0].kind === 'builtin');
  ok('认不出的 card_id：kind=unknown（只坏这一张）',
    buildDashboardVM(fakeStore({ cards: [card('???', 0)] }), { nowMs: NOW }).cards[0].kind === 'unknown');
  ok('module_id="native" 但 id 没登记过 → 仍然当成 unknown，不冒充面板',
    buildDashboardVM(fakeStore({ cards: [{ id: 'x', module_id: 'native', card_id: '没登记', size: 'md', position: 0 }] }),
      { nowMs: NOW }).cards[0].kind === 'unknown');
  ok('原生面板也在"添加卡片"的列表里（删掉了还能加回来）',
    availableCardTypes().some((t) => t.id === 'student' && t.kind === 'native'));

  const hit = async (method, path, body = {}) => {
    let res = null;
    await handleDashboardApi(
      { method, body }, {}, new URL('http://x' + path), store,
      { sendJson: (_r, code, obj) => { res = { code, obj }; }, readBody: async () => body },
    );
    return res;
  };
  const back = await hit('POST', '/api/dashboard/cards', { card_id: 'student' });
  const stu = store.listDashboardCards().find((c) => c.card_id === 'student');
  ok('把删掉的面板加回来：归到 module_id="native"、用登记表里的宽度（不是 custom/md）',
    back.code === 200 && stu.module_id === 'native' && stu.size === NATIVE_CARDS.student.size,
    JSON.stringify(stu));
  await hit('POST', '/api/dashboard/cards', { card_id: 'student' });
  ok('再加一次不会变成两张同名卡',
    store.listDashboardCards().filter((c) => c.card_id === 'student').length === 1);
}

// ---------------- ⑦ 迁移 10/11：老库自动接上原生面板，并排回"原来的样子" ----------------
{
  const dir = mkdtempSync(join(tmpdir(), 'cairndash-'));
  const db = new DatabaseSync(join(dir, 't.sqlite'));
  const order = () => db.prepare('SELECT module_id, card_id FROM dashboard_cards ORDER BY position').all()
    .map((r) => `${r.module_id}/${r.card_id}`);
  const markApplied = (v) => db.prepare('INSERT OR IGNORE INTO schema_migrations (version,name,applied_at) VALUES (?,?,?)')
    .run(v, '人工置为已应用', Date.now());
  runMigrations(db);
  ok('全新库：迁移 10 一行都不插（留给 DEFAULT_CARDS 一次装齐）',
    Number(db.prepare('SELECT COUNT(*) AS n FROM dashboard_cards').get().n) === 0);

  // 假装这是一个"已经在用"的库：先摆上 3 张内置卡，再让第 10 条重跑一次（第 11 条先按住）
  db.prepare('DELETE FROM schema_migrations WHERE version IN (10, 11)').run();
  const ins = db.prepare(`INSERT INTO dashboard_cards
    (id,module_id,card_id,size,position,config_json,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?)`);
  const at = Date.now();
  ['today', 'jobs', 'sources'].forEach((id, i) => ins.run('b-' + id, 'builtin', id, 'md', i, at, at));
  markApplied(11);
  runMigrations(db);

  const rows = db.prepare(
    "SELECT card_id, size, position FROM dashboard_cards WHERE module_id = 'native' ORDER BY position",
  ).all();
  ok('老库：迁移 10 把九张原生面板接到已有卡片后面（位置从 3 开始）',
    rows.length === Object.keys(NATIVE_CARDS).length && Number(rows[0].position) === 3, JSON.stringify(rows));
  ok('老库：接上来的宽度按登记表来',
    rows.find((r) => r.card_id === 'codex').size === NATIVE_CARDS.codex.size);
  ok('老用户原来那三张卡一张不少',
    db.prepare("SELECT COUNT(*) AS n FROM dashboard_cards WHERE module_id = 'builtin'").get().n === 3);

  // 11：把"内置卡在最上面"的默认排布改回原来的样子（只动没被用户调过的）
  db.prepare('DELETE FROM schema_migrations WHERE version = 11').run();
  runMigrations(db);
  ok('迁移 11：默认排布改回"学生卡在最上、三张内置卡在最下"',
    order().join(',') === DEFAULT_CARDS.map((c) => `${c.module_id}/${c.card_id}`).join(','), order().join(','));

  // 用户自己调过顺序之后再重启 → 迁移不许再动它
  const mine = order();
  db.prepare('DELETE FROM schema_migrations WHERE version = 11').run();
  db.prepare("UPDATE dashboard_cards SET position = 99 WHERE card_id = 'stat-done'").run();
  const customized = order();
  runMigrations(db);
  ok('迁移 11 只认"原封未动"的默认排布：用户调过就一律不碰',
    order().join(',') === customized.join(',') && customized.length === mine.length);

  // 用户删掉一张 → 再启动一次不许自己长回来
  db.prepare("DELETE FROM dashboard_cards WHERE card_id = 'student'").run();
  runMigrations(db);
  ok('删掉的原生面板不会被迁移再插回来（删除是能记住的）',
    !db.prepare("SELECT id FROM dashboard_cards WHERE card_id = 'student'").get());

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ---------------- ⑤ 「Anki 复习」卡（只读，数据由调用方注入） ----------------
// 真读 Anki 库那部分在 tests/anki.test.mjs；这里只管"数字怎么摆"和"读不到时别把人吓到"。
{
  const mk = (anki, extra = {}) => buildDashboardVM(
    fakeStore({ cards: [card('anki', 0, extra)] }),
    { nowMs: NOW, anki },
  ).cards[0];

  const good = mk({
    ok: true, never_synced: false, last_sync_at: '2026-10-02T02:00:00.000Z',
    total_cards: 30, total_notes: 28, due: { new: 5, learning: 3, review: 4, total: 12 },
  });
  ok('Anki 卡：今日待复习写在第一行，且是有事要做的颜色',
    good.rows[0].label === '今日待复习' && good.rows[0].value === '12 张' && good.rows[0].level === 'warn',
    JSON.stringify(good.rows[0]));
  ok('Anki 卡：新 / 学 / 复习 三项都摊开',
    good.rows[1].value === '5 / 3 / 4', good.rows[1].value);
  ok('Anki 卡：同步过就写最后同步时间 + 总量',
    /2026/.test(good.rows[2].value) && good.rows[2].meta.includes('30 张卡'), JSON.stringify(good.rows[2]));

  const never = mk({
    ok: true, never_synced: true, last_sync_at: null, total_cards: 0, total_notes: 0,
    due: { new: 0, learning: 0, review: 0, total: 0 },
  });
  ok('Anki 卡：从没同步过 → 直接说清"去电脑上登录 AnkiWeb 点一次同步"',
    never.rows[2].level === 'error' && never.rows[2].meta.includes('AnkiWeb'), JSON.stringify(never.rows[2]));

  const broken = mk({ ok: false, error: '没找到 Anki 配置目录' });
  ok('Anki 卡：读不到库时给一句人话，不是空白卡',
    broken.rows.length === 1 && broken.rows[0].value === '—' && broken.rows[0].meta.includes('没找到'), JSON.stringify(broken.rows));
}

console.log('');
console.log(failures === 0 ? 'dashboard.test: PASS' : `dashboard.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
