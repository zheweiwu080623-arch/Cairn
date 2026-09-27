// 「应用改名（#1）+ 入门体验（#2）」的验证：品牌读写、清单推导、模块渲染与接线。
//
//   node tests/onboarding.test.mjs

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME_MAX, appName, brandInfo, normalizeAppName, saveAppName } from '../lib/brand.mjs';
import { ONBOARDING_STEPS, computeSteps, normalizeOnboarding, summarize } from '../lib/onboarding.mjs';
import { createPrefsRoutes } from '../lib/routes/prefs.mjs';
import { scanModules } from '../lib/modules.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('onboarding.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'onboard-'));

// ---------------- 1. #1 应用改名 ----------------
ok('名字清洗：去控制字符 / 去首尾空白 / 限长',
  normalizeAppName('  空庭  ') === '空庭'
  && normalizeAppName('a\u0000b') === 'ab'
  && normalizeAppName('长'.repeat(99)).length === APP_NAME_MAX);
ok('空值/空串都当"没填"', normalizeAppName('') === '' && normalizeAppName(null) === '');
{
  const r = saveAppName(tmp, '  空庭Coterie的Planner  ');
  ok('写进 brand.json 并回读一致', r.ok === true && appName({ dataDir: tmp, env: {} }) === '空庭Coterie的Planner');
  const raw = readFileSync(join(tmp, 'brand.json'), 'utf8');
  ok('文件里只有 app_name（形状简单、好手改）', JSON.parse(raw).app_name === '空庭Coterie的Planner', raw.trim());
  ok('brandInfo 告诉界面"改过名了"', brandInfo({ dataDir: tmp, env: {} }).custom === true);

  const back = saveAppName(tmp, '');
  ok('传空 = 恢复默认名（不删文件）', back.ok === true && back.app_name === 'Cairn'
    && appName({ dataDir: tmp, env: {} }) === 'Cairn');
  ok('恢复默认后又变回 custom=false', brandInfo({ dataDir: tmp, env: {} }).custom === false);
  ok('环境变量永远优先级最高',
    appName({ dataDir: tmp, env: { PLANNER_APP_NAME: '临时' } }) === '临时');
  ok('没有数据目录时给错误而不是抛异常', saveAppName('', 'x').ok === false);
}
{
  // 名字里的引号/尖括号不该影响 JSON 或界面
  const weird = '<img src=x onerror=1> "引号"';
  saveAppName(tmp, weird);
  ok('怪名字也能存能读（按清洗+限长后的结果）',
    appName({ dataDir: tmp, env: {} }) === normalizeAppName(weird)
    && normalizeAppName(weird).length <= APP_NAME_MAX);
  saveAppName(tmp, '');
}

// ---------------- 2. #2 入门清单 ----------------
ok('四个步骤、id 稳定', ONBOARDING_STEPS.map((s) => s.id).join(',') === 'name,source,agent,docs');
ok('只有"接模型"是可选的', ONBOARDING_STEPS.filter((s) => s.optional).map((s) => s.id).join(',') === 'agent');
ok('状态清洗只留已知步骤',
  Object.keys(normalizeOnboarding({ done: { name: true, 乱写: true } }).done).join(',') === 'name');
{
  const steps = computeSteps({ brand: { custom: true }, connectors: { configured: 1 }, agent: { ready: false } }, {});
  const by = Object.fromEntries(steps.map((s) => [s.id, s]));
  ok('改过名 → name 自动打勾', by.name.done === true && by.name.auto === true);
  ok('配过数据源 → source 自动打勾', by.source.done === true);
  ok('模型没就绪 → agent 不打勾（但它是可选的）', by.agent.done === false && by.agent.optional === true);
  ok('"看过文档"只能靠人说（不自动猜）', by.docs.done === false);
  const sum = summarize(steps, {});
  ok('汇总只算必做项：2/3', sum.required_done === 2 && sum.required_total === 3, JSON.stringify(sum));
  ok('下一步指向没做完的必做项', sum.next.id === 'docs');
  ok('没做完 → 卡片显示', sum.show === true && sum.complete === false);
}
{
  const steps = computeSteps({ brand: { custom: true }, connectors: { configured: 1 } }, { done: { docs: true } });
  const sum = summarize(steps, { done: { docs: true } });
  ok('必做项都做完 → 卡片自己消失', sum.complete === true && sum.show === false);
  ok('点了"不再显示" → 即使没做完也不显示',
    summarize(computeSteps({}, {}), { dismissed: true }).show === false);
  ok('空状态不崩', summarize(computeSteps({}, null), null).show === true);
}

// ---------------- 3. 接口（/api/prefs：改名 + 入门状态） ----------------
const sync = new Map();
const store = {
  getSync: (k) => (sync.has(k) ? sync.get(k) : null),
  setSync: (k, v) => sync.set(k, v),
};
const mkRes = () => ({ code: null, body: null });
const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };
const routes = createPrefsRoutes({
  store, sendJson, readBody: async (r) => r.body || {}, dataDir: tmp,
  facts: () => ({ brand: brandInfo({ dataDir: tmp, env: {} }), connectors: { configured: 1 }, agent: { ready: false } }),
});
const req = (method, body) => ({ method, body });
{
  const res = mkRes();
  await routes.handlePrefs(req('GET'), res, new URL('http://x/api/prefs'));
  ok('GET 返回偏好 + 品牌 + 入门清单',
    res.code === 200 && res.body.theme && res.body.brand && Array.isArray(res.body.onboarding.steps));
  ok('入门清单带汇总（界面不用自己算）', !!res.body.onboarding.summary && res.body.onboarding.summary.required_total === 3);
  ok('主题默认 p5、系统通知默认关', res.body.theme === 'p5' && res.body.os_notify === '0');
}
{
  const res = mkRes();
  await routes.handlePrefs(req('POST', { app_name: '我的计划本' }), res, new URL('http://x/api/prefs'));
  ok('POST 改名立刻生效并回读', res.body.brand.app_name === '我的计划本' && res.body.brand.custom === true);
  ok('改名后 name 这一步自动打勾', res.body.onboarding.steps.find((s) => s.id === 'name').done === true);
}
{
  const res = mkRes();
  await routes.handlePrefs(req('POST', { onboarding: { done: { docs: true } } }), res, new URL('http://x/api/prefs'));
  ok('手动打勾"看过文档"能存下', res.body.onboarding.done.docs === true);
  const again = mkRes();
  await routes.handlePrefs(req('POST', { onboarding: { dismissed: true } }), again, new URL('http://x/api/prefs'));
  ok('"不再显示"能存下，且不会把 done 冲掉',
    again.body.onboarding.dismissed === true && again.body.onboarding.done.docs === true);
  ok('存过之后卡片就该收起来', again.body.onboarding.summary.show === false);
}
{
  const res = mkRes();
  await routes.handlePrefs(req('POST', { theme: 'p3r', os_notify: '0' }), res, new URL('http://x/api/prefs'));
  ok('老字段（主题 / 系统通知）行为不变',
    res.body.theme === 'p3r' && res.body.os_notify === '0');
  ok('字符串 "0" 不会被当成真', store.getSync('pref_os_notify') === '0');
}

// ---------------- 4. 模块与接线 ----------------
{
  const mods = scanModules(join(ROOT, 'modules'));
  const mine = mods.find((m) => m.id === 'getting-started');
  ok('模块能被发现且没有错误', !!mine && !mine.error, JSON.stringify(mine && mine.error));
  ok('挂在「今日」页、排在最前', mine && mine.mount_into === 'today' && mine.order === 0);
  ok('七个模块都在（含"从这里开始"）', mods.filter((m) => !m.error).length >= 7, String(mods.length));

  const mod = await import('../modules/getting-started/view.js');
  ok('模块导出 mount 与纯函数 renderCard/stepAction',
    typeof mod.mount === 'function' && typeof mod.renderCard === 'function' && typeof mod.stepAction === 'function');
  const payload = {
    brand: { app_name: '空庭Coterie的Planner', custom: true },
    onboarding: {
      done: {}, dismissed: false,
      steps: [
        { id: 'name', icon: '🏷️', title: '给它起个名字', hint: 'x', done: true, auto: true },
        { id: 'source', icon: '🔌', title: '连一个数据源', hint: 'y', done: false },
        { id: 'agent', icon: '🤖', title: '接上你自己的模型', hint: 'z', done: false, optional: true },
        { id: 'docs', icon: '📖', title: '看一遍文档', hint: 'w', done: false },
      ],
      summary: { show: true, required_done: 1, required_total: 3, percent: 33, next: { id: 'source', title: '连一个数据源' } },
    },
  };
  const html = mod.renderCard(payload);
  ok('卡片标题与进度在', html.includes('从这里开始') && html.includes('完成 1/3') && html.includes('建议下一步：连一个数据源'));
  ok('四个步骤都渲染出来', ['给它起个名字', '连一个数据源', '接上你自己的模型', '看一遍文档'].every((t) => html.includes(t)));
  ok('做完的标"完成"、没做的给动作', html.includes('✓ 完成') && html.includes('id="gs-name"') === false && html.includes('data-gs-nav="connectors"'));
  ok('模型那步标了"可选"', html.includes('（可选）'));
  ok('文档链接指向应用内文档', html.includes('/docs/HOW_IT_WORKS.md') && html.includes('/docs/CONNECT_SOURCES.md'));
  ok('有"不再显示"按钮', html.includes('id="gs-dismiss"'));
  ok('名字被转义（防注入）',
    !mod.renderCard({ ...payload, brand: { app_name: '<img src=x>' } }).includes('<img'));
  ok('看完后卡片返回空串（不占位置）', mod.renderCard({ onboarding: { summary: { show: false }, steps: [] } }) === '');
  ok('没数据也不崩', mod.renderCard({}) === '' && mod.renderCard() === '');

  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  // 2026-09-26：所有挂载点改成统一走 moduleCtx()（以前每个地方各写一份，漏过字段）
  ok('模块拿到了切页出口 nav（在统一的 moduleCtx 里）',
    /await mod\.mount\(box, moduleCtx\(\)\)/.test(app)
    && /function moduleCtx\(\) \{[\s\S]{0,200}nav: switchTab/.test(app));
  const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('偏好接口已接线（并搬到独立文件）',
    srv.includes("from './lib/routes/prefs.mjs'") && srv.includes("if (p === '/api/prefs') return prefsRoutes.handlePrefs(req, res, url);"));
  ok('入门"事实"来自真实状态（品牌/数据源/模型）',
    srv.includes('const onboardingFacts = ()') && srv.includes('store.listConnectors()') && srv.includes('agentPublic()'));
}

console.log('');
console.log(failures === 0 ? 'onboarding.test: PASS' : `onboarding.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
