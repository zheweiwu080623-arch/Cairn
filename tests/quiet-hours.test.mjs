// 免打扰（2026-09-27）：从"番茄钟的副作用"变成可调偏好 —— 专注时静音 开/关 + 安静时段。
//
//   node tests/quiet-hours.test.mjs
//
// 三块：① 纯函数（时段判断 / 跨夜 / 坏值）；② /api/prefs 的读写往返；③ 源码闸门（别回退成硬编码）。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUIET_DEFAULTS, ddlStepOf, exceptionEnabled, importantKind, inQuietHours, normalizeQuiet, notifyGate, parseHm,
} from '../lib/focus.mjs';
import { createPrefsRoutes } from '../lib/routes/prefs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('quiet-hours.test.mjs');

// ---------- ① 纯函数 ----------
{
  ok('HH:MM 解析（含 9:05 这种写法）', parseHm('22:00') === 1320 && parseHm('9:05') === 545);
  ok('坏时间一律 null', parseHm('25:00') === null && parseHm('12:60') === null && parseHm('') === null && parseHm(null) === null);

  ok('没配置 → 专注静音默认开、不设安静时段',
    JSON.stringify(normalizeQuiet()) === JSON.stringify(QUIET_DEFAULTS));
  ok('坏值不崩、退回默认（focus_mute 只认显式的假值）',
    normalizeQuiet({ focus_mute: '0', start: '晚上十点', end: '07:00' }).focus_mute === false
    && normalizeQuiet({ start: '晚上十点' }).start === ''
    && normalizeQuiet(null).focus_mute === true);

  const at = (s) => new Date(`2026-09-21T${s}:00+08:00`).getTime();
  ok('同一天内的时段：09:00–12:00', inQuietHours({ start: '09:00', end: '12:00' }, at('10:30')) === true
    && inQuietHours({ start: '09:00', end: '12:00' }, at('12:00')) === false
    && inQuietHours({ start: '09:00', end: '12:00' }, at('08:59')) === false);
  ok('跨夜时段：22:00–07:00', inQuietHours({ start: '22:00', end: '07:00' }, at('23:30')) === true
    && inQuietHours({ start: '22:00', end: '07:00' }, at('06:59')) === true
    && inQuietHours({ start: '22:00', end: '07:00' }, at('12:00')) === false);
  ok('起止相同 = 没设（不把整天静音）', inQuietHours({ start: '09:00', end: '09:00' }, at('09:30')) === false);
  ok('只填一个时间 = 没设', inQuietHours({ start: '09:00', end: '' }, at('09:30')) === false
    && inQuietHours({ start: '', end: '12:00' }, at('09:30')) === false);

  const h = 3600000;
  const focusRunning = [{ label: '番茄 45', started_at: new Date(at('23:00') - h / 2).toISOString(), ended_at: new Date(at('23:00') + h / 2).toISOString() }];
  ok('专注中 + 开关开 → 攒着（why=focus）',
    notifyGate({ quiet: { focus_mute: true }, focusRows: focusRunning }, at('23:00')).why === 'focus');
  ok('专注中但开关关掉 → 照常提醒',
    notifyGate({ quiet: { focus_mute: false }, focusRows: focusRunning }, at('23:00')).defer === false);
  ok('安静时段内 → 攒着（why=quiet）',
    notifyGate({ quiet: { start: '22:00', end: '07:00' }, focusRows: [] }, at('23:00')).why === 'quiet');
  ok('都不命中 → 不攒', notifyGate({ quiet: { start: '22:00', end: '07:00' }, focusRows: [] }, at('12:00')).defer === false);
  ok('专注关掉 + 在安静时段 → 仍然按安静时段攒（两个旋钮各自独立）',
    notifyGate({ quiet: { focus_mute: false, start: '22:00', end: '07:00' }, focusRows: focusRunning }, at('23:00')).why === 'quiet');
}

// ---------- ①b 重要例外（2026-09-27 晚加） ----------
{
  const at = (s) => new Date(`2026-09-21T${s}:00+08:00`).getTime();
  ok('默认：DDL 最后一档破例、重点不破例',
    JSON.stringify(normalizeQuiet().exceptions) === JSON.stringify({ ddl_final: true, starred: false }));
  ok('例外开关能被单独改，坏值退回默认',
    normalizeQuiet({ exceptions: { starred: '1' } }).exceptions.starred === true
    && normalizeQuiet({ exceptions: { ddl_final: '0' } }).exceptions.ddl_final === false
    && normalizeQuiet({ exceptions: { ddl_final: '0' } }).exceptions.starred === false
    && normalizeQuiet({ exceptions: '乱写' }).exceptions.ddl_final === true);
  ok('exceptionEnabled 认得两种例外', exceptionEnabled({}, 'ddl_final') === true
    && exceptionEnabled({}, 'starred') === false && exceptionEnabled({}, '不存在') === false);

  ok('从去重键里取档位（ddl:<任务>:<毫秒>）', ddlStepOf('ddl:abc:1800000') === 1800000
    && ddlStepOf('ddl:abc') === null && ddlStepOf('别的:abc:1800000') === null);

  const ddl30 = { source: 'ddl', external_id: 'ddl:t1:1800000', message: '还有 25 分钟 · 截止 2026-09-21 23:00' };
  const ddl3h = { source: 'ddl', external_id: 'ddl:t1:10800000', message: '还有 2 小时 59 分钟' };
  const ddlLate = { source: 'ddl', external_id: 'ddl:t1:1800000', message: '已逾期 20 分钟 · 截止 …' };
  const starred = { source: 'canvas', priority: 1, message: 'Canvas 有新动态' };
  const plain = { source: 'codex', message: '周报跑完了' };

  ok('DDL 最后一档 → 算重要（默认开着）', importantKind(ddl30, {}) === 'ddl_final');
  ok('DDL 早档（3 小时）→ 不算重要', importantKind(ddl3h, {}) === '');
  ok('已逾期的 DDL → 算重要（哪怕档位号认不出）',
    importantKind({ source: 'ddl', external_id: 'x', message: '已逾期 2 小时' }, {}) === 'ddl_final');
  ok('重点提醒：默认不破例，打开后算重要',
    importantKind(starred, {}) === ''
    && importantKind(starred, { exceptions: { starred: true } }) === 'starred');
  ok('普通提醒永远不算重要', importantKind(plain, {}) === ''
    && importantKind(plain, { exceptions: { ddl_final: true, starred: true } }) === '');
  ok('用户关掉 ddl_final → 最后一档也不再破例',
    importantKind(ddl30, { exceptions: { ddl_final: false } }) === '');

  ok('免打扰里带例外 → 放行且标出除外的种类',
    JSON.stringify(notifyGate({ quiet: { start: '22:00', end: '07:00' }, kind: 'ddl_final' }, at('23:00')))
      === JSON.stringify({ defer: false, why: 'quiet', excepted: true }));
  ok('免打扰里带"没打开的例外" → 照旧攒着',
    notifyGate({ quiet: { start: '22:00', end: '07:00' }, kind: 'starred' }, at('23:00')).defer === true);
  ok('不在免打扰时段 → 例外标志不影响（正常响）',
    notifyGate({ quiet: { start: '22:00', end: '07:00' }, kind: 'ddl_final' }, at('12:00')).excepted === false);
}

// ---------- ② /api/prefs 读写往返 ----------
{
  const kv = new Map();
  const store = {
    getSync: (k) => (kv.has(k) ? kv.get(k) : null),
    setSync: (k, v) => { kv.set(k, String(v)); },
    listCourses: () => [],
    listConnectors: () => [],
  };
  const dataDir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'quiet-'));
  const sent = [];
  const routes = createPrefsRoutes({
    store, dataDir,
    sendJson: (_res, code, body) => sent.push({ code, body }),
    readBody: async () => current,
    facts: () => ({}),
  });
  let current = {};

  await routes.handlePrefs({ method: 'GET' }, {});
  ok('GET /api/prefs 里带上 quiet（默认）',
    sent.at(-1).body.quiet && sent.at(-1).body.quiet.focus_mute === true && sent.at(-1).body.quiet.start === '');

  current = { quiet: { start: '22:30', end: '07:15' } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST 只给时段 → 存下来，且 default 的"专注静音"没被冲掉',
    sent.at(-1).body.quiet.start === '22:30' && sent.at(-1).body.quiet.end === '07:15'
    && sent.at(-1).body.quiet.focus_mute === true);

  current = { quiet: { focus_mute: false } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST 只给开关 → 时段保留、开关变假',
    sent.at(-1).body.quiet.focus_mute === false
    && sent.at(-1).body.quiet.start === '22:30' && sent.at(-1).body.quiet.end === '07:15');

  current = { quiet: { start: '乱写', end: '99:99' } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST 坏时间 → 洗成空（不会把整天静音）',
    sent.at(-1).body.quiet.start === '' && sent.at(-1).body.quiet.end === '');
  ok('存的是 JSON（含 updated_at），不是裸字符串',
    (() => { const raw = kv.get('pref_quiet'); const j = JSON.parse(raw); return typeof j.updated_at === 'number'; })());

  current = { quiet: { exceptions: { starred: true } } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('POST 只改一个例外 → 另一个（ddl_final）没被顺手拨回去',
    sent.at(-1).body.quiet.exceptions.starred === true
    && sent.at(-1).body.quiet.exceptions.ddl_final === true);
  current = { quiet: { exceptions: { ddl_final: false } } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('再改另一个例外 → 上一个（starred=true）还留着',
    sent.at(-1).body.quiet.exceptions.ddl_final === false
    && sent.at(-1).body.quiet.exceptions.starred === true);
  current = { quiet: { focus_mute: false } };
  await routes.handlePrefs({ method: 'POST' }, {});
  ok('只改"专注静音"时，例外设置原样保留',
    sent.at(-1).body.quiet.focus_mute === false
    && sent.at(-1).body.quiet.exceptions.starred === true
    && sent.at(-1).body.quiet.exceptions.ddl_final === false);
}

// ---------- ③ 源码闸门（防回退） ----------
{
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');
  const srv = read('server.mjs');
  ok('notifTick 走 notifyGate（不再自己硬编码"专注就不弹"）',
    srv.includes('const quiet = readQuietPref();')
    && srv.includes('notifyGate({ quiet, focusRows: store.listFocus() }, now)')
    && !/if \(isFocusRunning\(store\.listFocus\(\), now\)\)/.test(srv));
  ok('免打扰命中时**不标记已触发**（跳在 markFired 之前，所以能补弹）',
    /if \(gate\.defer && !kind\) continue;\s*\n\s*const firedAt[\s\S]{0,160}store\.markFired\(n\.id, firedAt\)/.test(srv));
  ok('手机推送也被同一道闸挡住（force=true 时放行 = 你自己点"推到手机"照做）',
    /async function barkNotify\([\s\S]{0,700}notifyGate\(\{ quiet: readQuietPref\(\), focusRows: store\.listFocus\(\), kind: important \}\)[\s\S]{0,200}skipped: gate\.why === 'focus' \? 'focus' : 'quiet'/.test(srv));
  ok('免打扰期间逐条判"重要例外"（不重要的 continue，不标记）',
    /const kind = gate\.defer \? importantKind\(n, quiet\) : '';\s*\n\s*if \(gate\.defer && !kind\) continue;/.test(srv));
  ok('推手机时把"例外种类"带过去（last 一档 / 重点）',
    srv.includes('important: f.important') && srv.includes("important: isPrioritySource(r.source) ? 'starred' : ''"));
  const ddlStack = read('lib/ddl-stack.mjs');
  ok('DDL 推手机也带例外标记',
    ddlStack.includes("important: isFinal ? 'ddl_final' : ''")
    && ddlStack.includes('d.step <= DDL_FINAL_STEP_MS'));

  const prefs = read('lib/routes/prefs.mjs');
  ok('偏好里存了 pref_quiet，并且 GET 会带出去',
    prefs.includes("const QUIET_KEY = 'pref_quiet'") && prefs.includes('quiet: normalizeQuiet(')
    && prefs.includes('if (body.quiet && typeof body.quiet === \'object\')'));

  const panel = read('modules/settings/panel.js');
  ok('设置 → 偏好 里有"专注时免打扰"两个按钮',
    panel.includes('data-quiet-focus="1"') && panel.includes('data-quiet-focus="0"'));
  ok('设置 → 偏好 里有安静时段的起止与保存/清空',
    panel.includes('id="set-quiet-start"') && panel.includes('id="set-quiet-end"')
    && panel.includes("on('#set-quiet-save'") && panel.includes("on('#set-quiet-clear'"));
  ok('面板从 /api/prefs 读回 quiet 状态', panel.includes('S.quiet = prefs.quiet'));
  ok('偏好页有两个例外开关（ddl_final / starred）',
    panel.includes('data-quiet-ex="ddl_final"') && panel.includes('data-quiet-ex="starred"')
    && panel.includes("onAll('[data-quiet-ex]'"));
}

console.log('');
console.log(failures === 0 ? 'quiet-hours.test: PASS' : `quiet-hours.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
