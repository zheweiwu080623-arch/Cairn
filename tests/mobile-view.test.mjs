// 手机端界面（lib/mobile-view.mjs）的验证。
//
//   node tests/mobile-view.test.mjs
//
// 断言三件事：
//   ① 手机 VM 确实由 public/viewmodel.js 产出（同一个契约，不是另写一套）；
//   ② 页面 / 清单 / Service Worker / 图标四件套的形态正确、且对 token 做了转义；
//   ③ buildMobileVM 只读 state 的四个字段，别的字段不影响结果。

import {
  buildMobileVM, buildMobileWeekVM, mobileAppHtml, mobileIconSvg, mobileManifest, mobileServiceWorker,
} from '../lib/mobile-view.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('mobile-view.test.mjs');

const NOW = Date.parse('2026-10-02T10:00:00+08:00');
const today = '2026-10-02';

// 让"今天"这天正好有一门课（weekday 字段 1=周一 … 7=周日）
const jsDow = new Date(NOW).getDay();        // 0=周日
const monDow = (jsDow + 6) % 7;              // 0=周一
const weekdayField = monDow + 1;

const state = {
  tasks: [
    { id: 't1', title: '到期任务', due_at: `${today}T23:59:00`, priority: 1, status: 'open' },
    { id: 't2', title: '已完成任务', due_at: `${today}T12:00:00`, priority: 3, status: 'done' },
  ],
  events: [{ id: 'e1', title: '高等数学', start_at: `${today}T12:00:00`, end_at: `${today}T13:40:00` }],
  notifications: [{ id: 'n1', title: '提醒一', trigger_at: `${today}T07:00:00`, enabled: 1, source: 'email' }],
  codex: { connected: true, home: 'C:/x', automations: [] },
  courses: [{
    id: 'c1', course: '高等数学B1', weekday: weekdayField,
    start_at: '12:00', end_at: '13:40', location: 'DXY311', weeks: '1-14',
  }],
  academic: [{ id: 'a1', kind: 'term', title: '2026-2027 秋季学期', start_at: '2026-09-14', end_at: '2026-12-18' }],
};

// ---------------- ① 由 viewmodel.js 产出 ----------------
{
  const vm = buildMobileVM(state, NOW);
  ok('schema 与生成时间是明确的', vm.schema === 'mobile-vm.v1' && !Number.isNaN(Date.parse(vm.generated_at)));
  ok('三页都在（今日 / 任务 / 提醒）', !!vm.today && !!vm.tasks && !!vm.notifications);
  ok('今日页是 viewmodel 的产物（有 sections 与 badge）',
    Array.isArray(vm.today.sections) && typeof vm.today.badge === 'number');
  const focus = (vm.today.sections.find((s) => s.id === 'focus') || {}).items || [];
  ok('今天的到期任务出现在「需要关注」里', focus.some((i) => i.title === '到期任务'));
  const sched = (vm.today.sections.find((s) => s.id === 'schedule') || {}).items || [];
  ok('今天的日程出现在「今天的安排」里', sched.some((i) => i.title === '高等数学'));
  ok('纯文本兜底非空（办公室本 / 无 JS 环境用）', typeof vm.plain === 'string' && vm.plain.length > 0);
  ok('本周日程也带回来了（7 天）', !!vm.calendar && (vm.calendar.days || []).length === 7);
  const day = (vm.calendar.days || []).find((d) => d.dow === monDow) || {};
  ok('今天那天的课表进了日历（周几 + 课名 + 地点）',
    (day.courses || []).some((c) => c.course === '高等数学B1' && c.location === 'DXY311'));
}

// ---------------- ①b 任意一周（日程页的翻页）----------------
{
  const thisWeek = buildMobileWeekVM(state, 0, NOW);
  ok('日程页：本周 schema / offset / 周号',
    thisWeek.schema === 'mobile-week.v1' && thisWeek.offset === 0 && thisWeek.week_no === 3);
  const nextWeek = buildMobileWeekVM(state, 1, NOW);
  ok('日程页：下一周的周一日期往后 7 天',
    Date.parse(nextWeek.calendar.days[0].key) - Date.parse(thisWeek.calendar.days[0].key)
      === 7 * 24 * 3600 * 1000);
  ok('日程页：坏 offset 归零（不炸）', buildMobileWeekVM(state, 'abc', NOW).offset === 0);
  ok('日程页：课表在 weeks 范围外会消失（第 20 周不上课）',
    (buildMobileWeekVM(state, 20, NOW).calendar.days || []).every((d) => (d.courses || []).length === 0));
}

// ---------------- ② 四件套的形态 ----------------
{
  const html = mobileAppHtml({ token: 'tok-123', appName: 'Cairn' });
  ok('页面引用了自己的 vm.json（基路径从当前地址推导，兼容 /m/ 与 /p/）',
    html.includes('var TOKEN = "tok-123"') && html.includes("BASE + 'vm.json'")
    && html.includes('location.pathname.replace'));
  ok('页面仍然挂着 manifest（PWA 入口不变）', html.includes('manifest.webmanifest'));
  ok('页面**不再注册** Service Worker（这是"永远旧版"的根源）',
    !/serviceWorker\.register/.test(html));
  ok('页面带自愈逻辑：发现旧 SW 就注销 + 清缓存 + 硬刷新一次',
    html.includes('purgeOldServiceWorker') && html.includes('cairn-sw-purged')
    && html.includes('caches.delete') && html.includes('location.reload'));
  ok('页面带界面版本号（一眼看出还在不在旧版）', /SHELL_VERSION = 'v\d+'/.test(html));
  ok('版本号同时出现在标签页标题与页头徽章（不开页面就能核对）',
    new RegExp("手机版 v\\d+</title>").test(html) && /class="ver">v\d+</.test(html));
  ok('页面是自包含的（不引外部资源）', !/<script[^>]+src=/.test(html) && !/<link[^>]+href="http/.test(html));
  ok('页面有错误态与下一步指引', html.includes('加载失败') && html.includes('同一个 Wi-Fi'));
  ok('页面有独立的「日程」页签与翻周控件',
    html.includes('data-tab="schedule"') && html.includes("BASE + 'week.json?offset='") && html.includes('上一周'));

  // 回归守卫：页面里的内联脚本**必须能被解析**。
  // （踩过一次：模板字符串把正则里的 `\/` `\d` 吃掉，整个脚本变成语法错误，
  //   页面只剩静态骨架 —— 这条断言就是为了以后不再出现。）
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  let scriptOk = true;
  let scriptErr = '';
  try {
    // eslint-disable-next-line no-new-func
    new Function(m ? m[1] : '');
  } catch (e) {
    scriptOk = false;
    scriptErr = String((e && e.message) || e);
  }
  ok('内联脚本语法正确（可被解析）', !!m && scriptOk, scriptErr);
  ok('脚本里的正则没被模板转义吃掉', (m ? m[1] : '').includes('^schedule\\/(-?\\d+)$'));
  ok('日程页顶部固定放「今天」区块', html.includes("todayCard()") && html.includes("'今天'"));
  ok('每一行都带时间列与地点标签', html.includes("el('span', 'tm'") && html.includes("el('span', 'loc'"));
  ok('今日页也补了「今天的课」', html.includes("todayCard('course')"));
  ok('token 被转义进脚本（不会造成注入）',
    !mobileAppHtml({ token: '</script><b>', appName: 'Cairn' }).includes('</script><b>'));

  const man = mobileManifest({ token: 'tok-123', appName: 'Cairn' });
  ok('manifest：start_url / scope 都锁在这个 token 下',
    man.start_url === '/m/tok-123/' && man.scope === '/m/tok-123/');
  ok('manifest：新入口 /p/ 下 start_url 也跟着走（不会被老 Service Worker 的作用域覆盖）',
    mobileManifest({ token: 'tok-123', family: 'p' }).start_url === '/p/tok-123/');
  ok('manifest：可独立运行且带图标', man.display === 'standalone' && man.icons.length === 1);

  const sw = mobileServiceWorker();
  ok('sw.js 是自毁脚本：清空缓存 + 注销自己 + 让受控页面重新导航',
    sw.includes('install') && sw.includes('activate')
    && sw.includes('caches.delete') && sw.includes('self.registration.unregister')
    && sw.includes('clients.matchAll') && sw.includes('c.navigate'));
  ok('自毁脚本不再注册 fetch 处理（不再有机会钉住旧外壳）',
    !sw.includes("addEventListener('fetch'"));
  ok('图标是 SVG', mobileIconSvg().trimStart().startsWith('<svg'));
}

// ---------------- ③ 只读四个字段 ----------------
{
  const a = buildMobileVM({ ...state }, NOW);
  const b = buildMobileVM({ ...state, secret_field: 'x', connectors: { counts: { a: 1 } } }, NOW);
  ok('多出来的字段不影响结果',
    JSON.stringify(a.today) === JSON.stringify(b.today)
    && JSON.stringify(a.tasks) === JSON.stringify(b.tasks));
  const empty = buildMobileVM({}, NOW);
  ok('空 state 也不炸（返回空结构而不是抛错）',
    empty.schema === 'mobile-vm.v1' && Array.isArray(empty.today.sections) && empty.today.sections.length > 0);
}

console.log('');
console.log(failures === 0 ? 'mobile-view.test: PASS' : `mobile-view.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
