// routes/prefs.mjs —— 应用偏好（主题 / 系统通知 / **显示名** / **入门清单状态** /
//                    **首次运行的向导** / **用户或开发者模式** / **主页要摆哪些功能、什么顺序**）。
//
//   GET  /api/prefs  → 当前偏好（含 brand：显示名与"是否自定义过"）
//   POST /api/prefs  → 改偏好（app_name 写 brand.json；onboarding 记"打勾/不再显示"；
//                       wizard 记"五步向导走完没有"；ui_mode 记用户/开发者模式；ui_modules 记主页摆哪些）
//
// 为什么从 server.mjs 搬出来：它本来只有 theme / os_notify，现在要管两件新事
// （#1 应用改名、#2 入门体验），主程序又贴着行数护栏 —— 搬出来是顺手的事，
// 也让"偏好"这一类读写只有一个入口，好审阅。

import { brandInfo, saveAppName } from '../brand.mjs';
import { normalizeQuiet } from '../focus.mjs';
import { describePeak, isPeak, normalizePeak } from '../peak.mjs';
import { ONBOARDING_KEY, computeSteps, normalizeOnboarding, summarize } from '../onboarding.mjs';
import { semesterInfo } from '../semester.mjs';
import { studentSignals } from '../student.mjs';

export function createPrefsRoutes({ store, sendJson, readBody, dataDir, facts = null }) {
  // 2026-09-25：五步向导 / 用户模式 / 主页功能清单以前没地方存（POST 直接被忽略），
  // 表现是"配完了下次打开还弹"。这里给它们各自一个明确的键（不开放任意 KV，仍然是白名单）。
const WIZARD_KEY = 'pref_wizard';
const UI_MODE_KEY = 'pref_ui_mode';
const HUB_CLICK_KEY = 'pref_hub_click';       // 主菜单：点一次进入 / 先选中再进入
const SEMESTER_KEY = 'pref_semester';         // 学期：开学日 + 周数（学生特化）
const STUDENT_KEY = 'pref_student_mode';      // 学生模式：''=没表态（自动判断）/ '1' / '0'
const QUIET_KEY = 'pref_quiet';               // 免打扰：{focus_mute, start, end}
const PEAK_KEY = 'pref_peak';                 // 高峰时段：{windows, weekend_free, tz_offset}
const PRIORITY_KEY = 'pref_priority_sources'; // 哪些来源算「重点」（数组）
  const UI_MODULES_KEY = 'pref_ui_modules';
  /** 读一份 JSON（坏数据当不存在，绝不让偏好把应用搞崩）。 */
  const readJson = (key) => {
    try { return JSON.parse(store.getSync(key) || 'null'); } catch { return null; }
  };

  const onboarding = () => normalizeOnboarding(readJson(ONBOARDING_KEY));

  /** 「重点来源」的缺省值：交大邮箱 + Canvas（2026-09-27 之前是写死的）。 */
  const DEFAULT_PRIORITY_SOURCES = ['email_sjtu', 'canvas'];

  /** 当前算「重点」的来源（数组）；没配过 → 缺省，配过空的 → 空的（= 没有重点）。 */
  function prioritySources() {
    const raw = readJson(PRIORITY_KEY);
    if (!Array.isArray(raw)) return [...DEFAULT_PRIORITY_SOURCES];
    return raw.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 24);
  }

  /**
   * 界面上能勾哪些来源：**这台机器上真实出现过的**（通知里带 connector: 前缀的 + 已配的数据源），
   * 一个都没有的时候退回缺省两项 —— 免得给用户列一堆他用不上的。
   */
  function availablePrioritySources() {
    const seen = new Map();
    const add = (t, n = 0) => { const k = String(t || '').split('@')[0]; if (k) seen.set(k, (seen.get(k) || 0) + n); };
    try {
      for (const n of store.listNotifications ? store.listNotifications() : []) {
        const s = String(n.source || '');
        if (s.startsWith('connector:')) add(s.slice('connector:'.length), 1);
      }
      for (const c of store.listConnectors ? store.listConnectors() : []) add(c.source, 0);
    } catch { /* 读不到就只给缺省 */ }
    if (!seen.size) for (const s of DEFAULT_PRIORITY_SOURCES) seen.set(s, 0);
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, count }));
  }

  /** 入门清单：把"真实状态"（facts）折成每一步做完没有 —— 判断逻辑在 lib/onboarding.mjs。 */
  const onboardingView = () => {
    const state = onboarding();
    let f = {};
    try { f = typeof facts === 'function' ? (facts() || {}) : {}; } catch { f = {}; }
    const steps = computeSteps(f, state);
    return { ...state, steps, summary: summarize(steps, state) };
  };

  /** 统一的返回形状：GET 与 POST 都回这一份，界面改完立刻能用新值刷新自己。 */
  const snapshot = () => ({
    theme: store.getSync('pref_theme') || 'p5',
    os_notify: store.getSync('pref_os_notify') || '0',
    brand: brandInfo({ dataDir }),
    onboarding: onboardingView(),
    wizard: readJson(WIZARD_KEY) || {},                                  // 首次运行向导的状态
    ui_mode: store.getSync(UI_MODE_KEY) === 'dev' ? 'dev' : 'user',      // 用户 / 开发者模式
    ui_modules: readJson(UI_MODULES_KEY) || { enabled: null, order: [] },// 主页摆哪些功能、什么顺序
    // 主菜单点击方式：`once`（点一次就进，默认，审核的人要的）/ `twice`（先选中、再点一次进）
    hub_click: store.getSync(HUB_CLICK_KEY) === 'twice' ? 'twice' : 'once',
    // 学期：{ start: 'YYYY-MM-DD', weeks: 18 }（学生特化：界面据此显示"第 N 周"）
    semester: readJson(SEMESTER_KEY) || { start: '', weeks: 18 },
    // 顺手把算好的"第几周 / 考试周"也带上（界面不用自己再算一遍）
    semester_info: semesterInfo(readJson(SEMESTER_KEY) || {}),
    // 学生模式：用户点过就听用户的；没点过按信号猜（分析偏好里的学生腔 / 已配 Canvas / 有课表）
    student_mode: studentView(),
    // 免打扰（2026-09-27 新增）：专注时静音 + 安静时段；到点的提醒攒着、过后补
    quiet: normalizeQuiet(readJson(QUIET_KEY) || {}),
    // 高峰时段（2026-09-27 可配）：默认还是"工作日 09–12 / 14–18、周末不算、UTC+8"
    peak: normalizePeak(readJson(PEAK_KEY) || {}),
    peak_now: isPeak(new Date(), normalizePeak(readJson(PEAK_KEY) || {})),   // 界面显示"现在是不是高峰"
    peak_label: describePeak(readJson(PEAK_KEY) || {}),
    // 哪些来源算「重点」（置顶 / ⭐ / 免打扰例外里的 starred）；默认交大邮箱 + Canvas
    priority_sources: prioritySources(),
    priority_sources_available: availablePrioritySources(),
    // 「主菜单点击方式 / 学生模式 / 学期」现在都在设置 → 偏好 这一页里
  });

  /**
   * 学生模式怎么定（用户要求"尽可能自动认出来"）：
   *   1) 用户显式点过（pref = '1' / '0'）⇒ 听用户的；
   *   2) 没点过 ⇒ 用 studentSignals 猜（分析偏好里写了学生腔、配了 Canvas、本地已有课表）；
   *   3) 猜出来的**只在"像学生"时打开**，而且会如实告诉用户"因为什么"。
   */
  function studentView() {
    const stored = store.getSync(STUDENT_KEY);
    let sig = { student: false, hits: [], why: '' };
    try {
      const prof = JSON.parse(store.getSync('profile_json') || '{}');
      const courses = store.listCourses ? store.listCourses().length : 0;
      const conns = store.listConnectors ? store.listConnectors().map((c) => c.source) : [];
      sig = studentSignals({
        notes: prof.notes || '',
        hasCanvas: conns.some((s) => String(s).split('@')[0] === 'canvas'),
        courseCount: courses,
      });
    } catch { /* 读不到就当没信号 */ }
    if (stored === '1') return { mode: 'student', explicit: true, why: '你自己设的：学生模式', hits: sig.hits };
    if (stored === '0') return { mode: 'general', explicit: true, why: '你自己设的：通用模式', hits: sig.hits };
    return {
      mode: sig.student ? 'student' : 'general',
      explicit: false,
      why: sig.student ? `${sig.why}（自动判断，想改在 设置 → 偏好 里改）` : '还没看出学生倾向（自动判断）',
      hits: sig.hits,
    };
  }

  async function handlePrefs(req, res, _url) {
    if (req.method === 'GET') return sendJson(res, 200, snapshot());
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 GET / POST' });

    const body = (await readBody(req)) || {};
    if (body.theme) store.setSync('pref_theme', String(body.theme));
    if (body.os_notify !== undefined) {
      // 注意：字符串 "0" 也是真值，这里要显式判断
      const on = body.os_notify === true || body.os_notify === 1
        || body.os_notify === '1' || body.os_notify === 'true';
      store.setSync('pref_os_notify', on ? '1' : '0');
    }
    // #1 改名：写 <数据目录>/brand.json（data/ 不进仓库，所以名字是"你这台机器的"）
    if (body.app_name !== undefined) saveAppName(dataDir, body.app_name);
    // #2 入门清单：支持 {dismissed} 与 {done:{name:true}}
    if (body.onboarding && typeof body.onboarding === 'object') {
      const cur = onboarding();
      const patch = body.onboarding;
      const next = normalizeOnboarding({
        ...cur,
        ...patch,
        done: { ...cur.done, ...(patch.done && typeof patch.done === 'object' ? patch.done : {}) },
        updated_at: Date.now(),
      });
      store.setSync(ONBOARDING_KEY, JSON.stringify(next));
    }
    // #3 首次运行的五步向导：{step, done:{id:true}, skipped:{id:true}, completed_at, dismissed}
    if (body.wizard && typeof body.wizard === 'object') {
      const cur = readJson(WIZARD_KEY) || {};
      const patch = body.wizard;
      const next = {
        ...cur,
        ...patch,
        done: { ...(cur.done || {}), ...(patch.done && typeof patch.done === 'object' ? patch.done : {}) },
        skipped: { ...(cur.skipped || {}), ...(patch.skipped && typeof patch.skipped === 'object' ? patch.skipped : {}) },
        updated_at: Date.now(),
      };
      store.setSync(WIZARD_KEY, JSON.stringify(next));
    }
    // #4 用户 / 开发者模式
    if (body.ui_mode !== undefined) store.setSync(UI_MODE_KEY, body.ui_mode === 'dev' ? 'dev' : 'user');
    // #4b 主菜单点击方式（2026-09-26 晚：审核的人说"菜单要点两下才起作用"，所以做成可选、默认点一次）
    if (body.hub_click !== undefined) store.setSync(HUB_CLICK_KEY, body.hub_click === 'twice' ? 'twice' : 'once');
    // #4c 学期（学生特化）：开学日 + 周数；空 start = 没设，界面就不显示"第 N 周"
    if (body.semester && typeof body.semester === 'object') {
      const cur = readJson(SEMESTER_KEY) || {};
      const patch = body.semester;
      const start = patch.start !== undefined ? String(patch.start).trim().slice(0, 10) : (cur.start || '');
      const weeks = patch.weeks !== undefined
        ? Math.max(1, Math.min(60, Number(patch.weeks) || 18)) : (Number(cur.weeks) || 18);
      store.setSync(SEMESTER_KEY, JSON.stringify({ start, weeks, updated_at: Date.now() }));
    }
    // #4d 学生模式：用户可以显式表态（'student' / 'general'）；给空串 = 回到"自动判断"
    if (body.student_mode !== undefined) {
      const v = String(body.student_mode || '');
      store.setSync(STUDENT_KEY, v === 'student' ? '1' : (v === 'general' ? '0' : ''));
    }
    // #4e 免打扰（2026-09-27）：只认这三个键，值先洗一遍再存
    if (body.quiet && typeof body.quiet === 'object') {
      const cur = normalizeQuiet(readJson(QUIET_KEY) || {});
      const patch = body.quiet;
      const next = normalizeQuiet({
        focus_mute: patch.focus_mute !== undefined ? patch.focus_mute : cur.focus_mute,
        start: patch.start !== undefined ? patch.start : cur.start,
        end: patch.end !== undefined ? patch.end : cur.end,
        // 例外也是"只改给到的那一个"，别把另外那个开关顺手拨回去（所以是浅合并，不是整个替换）
        exceptions: patch.exceptions !== undefined
          ? { ...(cur.exceptions || {}), ...(patch.exceptions || {}) }
          : cur.exceptions,
      });
      store.setSync(QUIET_KEY, JSON.stringify({ ...next, updated_at: Date.now() }));
    }
    // #4f 高峰时段（2026-09-27 可配）：windows / weekend_free / tz_offset，洗一遍再存
    if (body.peak && typeof body.peak === 'object') {
      const cur = normalizePeak(readJson(PEAK_KEY) || {});
      const patch = body.peak;
      const next = normalizePeak({
        windows: patch.windows !== undefined ? patch.windows : cur.windows,
        weekend_free: patch.weekend_free !== undefined ? patch.weekend_free : cur.weekend_free,
        tz_offset: patch.tz_offset !== undefined ? patch.tz_offset : cur.tz_offset,
      });
      store.setSync(PEAK_KEY, JSON.stringify({ ...next, updated_at: Date.now() }));
    }
    // #4g 哪些来源算「重点」：给数组就存数组（空数组 = 取消所有重点）
    if (Array.isArray(body.priority_sources)) {
      const list = body.priority_sources.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 24);
      store.setSync(PRIORITY_KEY, JSON.stringify(list));
    }
    // #5 主页的功能清单与顺序：{enabled:[模块 id], order:[模块 id]}
    if (body.ui_modules && typeof body.ui_modules === 'object') {
      const cur = readJson(UI_MODULES_KEY) || {};
      const patch = body.ui_modules;
      const arr = (v) => (Array.isArray(v) ? v.map(String) : undefined);
      const next = {
        enabled: patch.enabled === null ? null : (arr(patch.enabled) || cur.enabled || null),
        order: arr(patch.order) || cur.order || [],
        updated_at: Date.now(),
      };
      store.setSync(UI_MODULES_KEY, JSON.stringify(next));
    }
    return sendJson(res, 200, snapshot());
  }

  return { handlePrefs, snapshot, onboarding };
}
