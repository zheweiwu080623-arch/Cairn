// 四件"跟别人习惯有关、以前写死"的东西做成可配（2026-09-27）：
//   ① 「+ 快速添加」先选类型（任务 / 日程 / 提醒），并记住上次
//   ② 哪些来源算「重点」（置顶 / 「重点」标记 / 免打扰的重点例外）
//   ⑤ 「每日开工」补界面入口（时间 / 开关 / 顺手刷新 / 推手机）
//   ⑥ 高峰时段可配（时段 + 周末算不算 + 时区）
//
//   node tests/customizable.test.mjs
//
// 纯函数 + /api/prefs 往返 + 源码闸门（这三层能覆盖的都在这里；界面本身靠真机点过）。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PEAK_DEFAULTS, describePeak, hmToMinutes, isPeak, localParts, minutesToHm, normalizePeak,
} from '../lib/peak.mjs';
import { createPrefsRoutes } from '../lib/routes/prefs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

console.log('customizable.test.mjs');

// ---------- ⑥ 高峰时段 ----------
{
  ok('缺省 = 原来的写死值（工作日 09–12 / 14–18 · 周末不算 · UTC+8）',
    JSON.stringify(normalizePeak()) === JSON.stringify({ ...PEAK_DEFAULTS, windows: PEAK_DEFAULTS.windows.map((w) => [...w]) })
    && JSON.stringify(PEAK_DEFAULTS.windows) === '[[540,720],[840,1080]]');
  ok('坏值退回默认', normalizePeak({ windows: '乱写', tz_offset: 'abc', weekend_free: '也许' }).tz_offset === 8
    && normalizePeak({ windows: [['a', 'b'], [600, 600], [1200, 1300]] }).windows.length === 1);
  ok('空数组 = 没有高峰时段（不被默认值吃掉）', normalizePeak({ windows: [] }).windows.length === 0);
  ok('时区夹在 -12~14', normalizePeak({ tz_offset: 99 }).tz_offset === 14 && normalizePeak({ tz_offset: -99 }).tz_offset === -12);
  ok('HH:MM ↔ 分钟互转', hmToMinutes('09:30') === 570 && minutesToHm(570) === '09:30'
    && hmToMinutes('') === null && minutesToHm(-1) === '');

  // 同一瞬间（UTC 02:00 周一）在 UTC+8 是 10:00 周一、在 UTC+0 是 02:00 周一
  const utcMon2 = new Date('2026-09-28T02:00:00Z');       // 周一
  ok('按时区换算墙上时间（UTC+8 → 10 点）', localParts(utcMon2, 8).hour === 10);
  ok('按时区换算墙上时间（UTC+0 → 2 点）', localParts(utcMon2, 0).hour === 2);
  ok('UTC+8 的周一 10:00 是高峰', isPeak(utcMon2, { tz_offset: 8 }) === true);
  ok('同一瞬间换成 UTC+0 → 2 点，不是高峰', isPeak(utcMon2, { tz_offset: 0 }) === false);
  ok('改了时段就按新时段算（10:00 不在 20:00–22:00 里）',
    isPeak(utcMon2, { tz_offset: 8, windows: [[1200, 1320]] }) === false
    && isPeak(utcMon2, { tz_offset: 8, windows: [[540, 720]] }) === true);
  ok('没有高峰时段 → 永远非高峰', isPeak(utcMon2, { windows: [] }) === false);

  const utcSat2 = new Date('2026-09-26T02:00:00Z');       // 周六
  ok('周末默认不算高峰', isPeak(utcSat2, { tz_offset: 8 }) === false);
  ok('勾上"周末也算" → 周末照样高峰', isPeak(utcSat2, { tz_offset: 8, weekend_free: false }) === true);
  ok('描述是人话', /09:00–12:00/.test(describePeak({}))
    && /周末全天不算/.test(describePeak({})) && /不设|没有高峰时段/.test(describePeak({ windows: [] })));
}

// ---------- ② + ⑤ + ⑥ 的 /api/prefs 往返 ----------
{
  const kv = new Map();
  const notes = [
    { source: 'connector:canvas', priority: 1 },
    { source: 'connector:email_sjtu@2', priority: 1 },
    { source: 'connector:arxiv', priority: 0 },
    { source: 'ddl', priority: 1 },
  ];
  const store = {
    getSync: (k) => (kv.has(k) ? kv.get(k) : null),
    setSync: (k, v) => { kv.set(k, String(v)); },
    listCourses: () => [],
    listConnectors: () => [{ source: 'canvas' }, { source: 'arxiv' }],
    listNotifications: () => notes,
  };
  const dataDir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'custom-'));
  const sent = [];
  const routes = createPrefsRoutes({
    store, dataDir,
    sendJson: (_res, code, body) => sent.push({ code, body }),
    readBody: async () => current,
    facts: () => ({}),
  });
  let current = {};
  const last = () => sent.at(-1).body;

  current = {};
  await routes.handlePrefs({ method: 'GET' }, {});
  ok('GET 带出 peak（缺省）+ 现在是不是高峰 + 人话描述',
    last().peak && last().peak.tz_offset === 8 && typeof last().peak_now === 'boolean' && !!last().peak_label);
  ok('GET 带出 priority_sources 缺省（交大邮箱 + Canvas）',
    JSON.stringify(last().priority_sources) === '["email_sjtu","canvas"]');
  ok('GET 带出"这台机器上能勾的来源"（含计数）',
    last().priority_sources_available.some((s) => s.id === 'canvas' && s.count === 1)
    && last().priority_sources_available.some((s) => s.id === 'arxiv'));

  current = { peak: { windows: [[1200, 1320]], tz_offset: 0 } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST peak：只给 windows/tz 也能存，weekend_free 保留默认',
    last().peak.windows[0][0] === 1200 && last().peak.tz_offset === 0 && last().peak.weekend_free === true);
  current = { peak: { weekend_free: false } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST peak：只给一个字段，其它字段不被冲掉',
    last().peak.weekend_free === false && last().peak.windows[0][0] === 1200 && last().peak.tz_offset === 0);
  current = { peak: { windows: [['坏', '值']] } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST peak 坏值 → 洗掉（没有高峰时段，而不是整天高峰）', last().peak.windows.length === 0);

  current = { priority_sources: ['arxiv', 'canvas'] };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST priority_sources → 存下来并回读', JSON.stringify(last().priority_sources) === '["arxiv","canvas"]');
  current = { priority_sources: [] };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST 空数组 = 谁都不算重点（不是"用回默认"）', JSON.stringify(last().priority_sources) === '[]');
  current = { peak: { tz_offset: 8 } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('改 A 不冲 B：存 peak 之后 priority_sources 还是空的',
    JSON.stringify(last().priority_sources) === '[]');
}

// ---------- 源码闸门 ----------
{
  const srv = read('server.mjs');
  ok('⑥ 高峰时段：三处调用都带上偏好（不再用写死值）',
    srv.includes('bandLabel(new Date(), peakPrefs())')
    && srv.includes('isPeak(new Date(), peakPrefs())')
    && srv.includes('!isPeak(new Date(), peakPrefs())'));
  ok('⑥ 注入给路由的 isPeak 也是"读偏好版"',
    srv.includes('const isPeakNow = (d) => isPeak(d || new Date(), peakPrefs());')
    && srv.includes('isPeak: isPeakNow'));
  ok('② 重点来源：不再有写死的 PRIORITY_SOURCES 集合，只有可配的 isPrioritySource()',
    !/const PRIORITY_SOURCES = new Set/.test(srv)
    && read('lib/user-prefs.mjs').includes('export function createUserPrefs(')
    && srv.includes('const { peakPrefs, isPrioritySource } = userPrefs;')
    && srv.includes('priority: isPrioritySource(r.source) ? 1 : 0')
    && srv.includes("important: isPrioritySource(r.source) ? 'starred' : ''"));
  ok('② 通知列表里的「重点」按当前偏好现算（改设置立刻生效），但不动 ddl/codex 自己的优先级',
    /notifications: store\.listNotifications\(\)\.map\(\(n\) => \{[\s\S]{0,260}if \(!src\.startsWith\('connector:'\)\) return n;/.test(srv));

  const panel = read('modules/settings/panel.js');
  ok('⑥ 偏好页有「高峰时段」卡片（两个时段 + 时区 + 周末开关 + 保存）',
    panel.includes('id="set-peak-0a"') && panel.includes('id="set-peak-tz"')
    && panel.includes('id="set-peak-weekend"') && panel.includes("on('#set-peak-save'"));
  ok('② 偏好页有「哪些提醒算重点」卡片（按来源勾选 + 保存）',
    panel.includes('data-prio-src=') && panel.includes("on('#set-prio-save'"));
  ok('⑤ 后台页有「每日开工」卡片（时间 / 开关 / 顺手刷新 / 推手机 / 演练）',
    panel.includes('id="set-daily-at"') && panel.includes('id="set-daily-save"')
    && panel.includes('id="set-daily-dry"') && panel.includes("api('POST', '/api/daily'"));
  ok('⑤ 面板会去读 /api/daily', panel.includes("readJson('/api/daily')"));

  const app = read('public/app.js');
  ok('① 「+ 快速添加」弹的是类型选择（不再是直接 openModal(\'task\')）',
    /function openQuickAdd\(\) \{[\s\S]{0,400}openModal\('quick'\);/.test(app));
  ok('① 三种类型都在，且写进 localStorage 记住上次',
    app.includes("data-quick=\"${o.id}\"") && app.includes("localStorage.setItem('planner-quick-add', t)"));
  ok('① 选择器上没有「保存」按钮（没有要填的字段），选完直接进对应表单',
    app.includes("saveBtn.style.display = isQuick ? 'none' : ''"));
}

console.log('');
console.log(failures === 0 ? 'customizable.test: PASS' : `customizable.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
