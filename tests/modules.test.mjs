// 模块系统测试（W2）：发现 / 校验 / 资源路径安全。
//
//   node tests/modules.test.mjs

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MODULE_KINDS, moduleAssetPath, scanModules, validateModule } from '../lib/modules.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
console.log('modules.test.mjs');

// ---------- 1. 描述符合法性 ----------
const good = {
  schema: 'module.v1', id: 'demo-gadget', name: '示例组件', version: '0.1.0',
  kind: 'gadget', mount_into: 'connectors', entry: { view: 'view.js' },
};
ok('合法描述符通过', validateModule(good).ok === true, JSON.stringify(validateModule(good).errors));
ok('支持五种 kind（2026-09-23 起多了 processor：再处理功能）',
  JSON.stringify(MODULE_KINDS) === JSON.stringify(['view', 'connector', 'job', 'gadget', 'processor']));
ok('schema 不对要报错', validateModule({ ...good, schema: 'x' }).errors.some((e) => e.includes('module.v1')));
ok('id 必须小写连字符', validateModule({ ...good, id: 'Bad_ID' }).errors.some((e) => e.includes('id')));
ok('版本号要形如 1.0.0', validateModule({ ...good, version: 'v1' }).errors.some((e) => e.includes('version')));
ok('kind 必须在枚举里', validateModule({ ...good, kind: 'plugin' }).errors.some((e) => e.includes('kind')));
ok('gadget 必须有 mount_into', validateModule({ ...good, mount_into: '' }).errors.some((e) => e.includes('mount_into')));
ok('view/gadget 必须有 entry.view', validateModule({ ...good, entry: {} }).errors.some((e) => e.includes('entry.view')));
ok('空对象不会崩，且报一堆错', validateModule(null).ok === false && validateModule(null).errors.length >= 4);

// ---------- 2. 发现模块 ----------
const root = mkdtempSync(join(TMP, 'modules-'));
mkdirSync(join(root, 'good-module'), { recursive: true });
writeFileSync(join(root, 'good-module', 'module.json'), JSON.stringify(good), 'utf8');
writeFileSync(join(root, 'good-module', 'view.js'), 'export function mount() {}', 'utf8');
mkdirSync(join(root, 'broken-json'), { recursive: true });
writeFileSync(join(root, 'broken-json', 'module.json'), '{ 坏掉的', 'utf8');
mkdirSync(join(root, 'missing-entry'), { recursive: true });
writeFileSync(join(root, 'missing-entry', 'module.json'),
  JSON.stringify({ ...good, id: 'missing-entry', entry: { view: 'nope.js' } }), 'utf8');
mkdirSync(join(root, 'not-a-module'), { recursive: true });   // 没有 module.json → 跳过

const found = scanModules(root);
ok('只发现带 module.json 的目录', found.length === 3, `发现 ${found.length} 个`);
ok('好模块被识别（且没有 error）',
  found.some((m) => m.id === 'demo-gadget' && !m.error));
ok('坏 JSON 的模块带错误但不会让整体失败',
  found.some((m) => m.id === 'broken-json' && /不是合法 JSON/.test(m.error || '')));
ok('缺入口文件的模块会点名缺哪个文件',
  found.some((m) => m.id === 'missing-entry' && /nope\.js/.test(m.error || '')));
ok('没有 module.json 的目录被跳过', !found.some((m) => m.id === 'not-a-module'));
ok('目录不存在时返回空数组而不是报错', scanModules(join(root, 'nope')).length === 0);
ok('root 传空也不崩', scanModules('').length === 0);

// ---------- 3. 真实仓库里的第一个模块 ----------
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const real = scanModules(join(ROOT, 'modules'));
ok('仓库里已有可发现的模块（至少四个）', real.length >= 4 && real.every((m) => !m.error),
  JSON.stringify(real.map((m) => [m.id, m.error])));
ok('第七个模块：从这里开始（挂在「今日」页最上面，2026-09-23 新增）',
  real.some((m) => m.id === 'getting-started' && m.kind === 'gadget' && m.mount_into === 'today'));
ok('第八个模块：示例再处理功能（kind=processor，2026-09-23 新增）',
  real.some((m) => m.id === 'hello-processor' && m.kind === 'processor' && !!m.entry.run));
ok('第九个模块：上课前 Canvas 检查（processor）',
  real.some((m) => m.id === 'preclass-check' && m.kind === 'processor' && !!m.entry.run));
ok('第十个模块：上课前检查卡片（挂「今日」页）',
  real.some((m) => m.id === 'preclass-card' && m.kind === 'gadget' && m.mount_into === 'today'));
ok('第十一个模块：课程辅助功能（processor，2026-09-24 新增）',
  real.some((m) => m.id === 'course-assist' && m.kind === 'processor' && !!m.entry.run));
ok('第十二个模块：课程辅助那一页（**kind=view**，与今日/通知/音乐并列）',
  real.some((m) => m.id === 'course-assist-view' && m.kind === 'view' && !!m.entry.view && !m.mount_into));
ok('第十三个模块：数据备份卡片（挂「统计」页，2026-09-24 审阅反馈驱动）',
  real.some((m) => m.id === 'backup-card' && m.kind === 'gadget' && m.mount_into === 'stats'));
ok('第十四个模块：DDL 提醒卡片（挂「任务」页，2026-09-24 D5）',
  real.some((m) => m.id === 'ddl-card' && m.kind === 'gadget' && m.mount_into === 'tasks'));
ok('第六个模块：日报 / 晚报（挂在「今日」页，2026-09-22 新增）',
  real.some((m) => m.id === 'daily-brief' && m.kind === 'gadget' && m.mount_into === 'today'));
ok('第五个模块：重要信息（挂在「今日」页，2026-09-22 新增）',
  real.some((m) => m.id === 'priority-feed' && m.kind === 'gadget' && m.mount_into === 'today'));
ok('第四个模块：Agent 接入（W4-3）',
  real.some((m) => m.id === 'agent-connect' && m.kind === 'gadget' && m.mount_into === 'connectors'));
ok('第三个模块：连接向导（W4-2）',
  real.some((m) => m.id === 'connect-wizard' && m.kind === 'gadget' && m.mount_into === 'connectors'));
ok('第二个模块证明"加一个目录就够了"（digest-preview）',
  real.some((m) => m.id === 'digest-preview' && m.kind === 'gadget' && m.mount_into === 'connectors'));
ok('它是个挂在「数据源」页的 gadget',
  real.some((m) => m.id === 'filter-profile' && m.kind === 'gadget' && m.mount_into === 'connectors'));
const modView = readFileSync(join(ROOT, 'modules', 'filter-profile', 'view.js'), 'utf8');
ok('模块导出 mount 与纯函数 renderCard',
  /export (async )?function mount\(/.test(modView) && /export function renderCard\(/.test(modView));

// 真正把模块代码 import 进来（语法错、导出缺失都会在这里现形）
const mod = await import('../modules/filter-profile/view.js');
ok('模块能被 import（没有语法错误）', typeof mod.mount === 'function' && typeof mod.renderCard === 'function');
const escStub = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const card = mod.renderCard({
  enabled: true, keywords: ['TOEFL', 'ACM'], courseCodes: ['MATH1860J'], allowSenders: ['advisor@example.edu'],
  denyKeywords: ['促销'], denySenders: [], pushAt: 1, dropAt: -3, semantic: 'batch', origin: 'derived',
}, { enabled: true, notes: ['以后忽略「x」（你删了 3 次）'] }, escStub);
ok('renderCard：面板主体在', card.includes('我关心什么') && card.includes('id="profile-card"'));
ok('renderCard：两条画像入口都在',
  card.includes('id="pf-derive"') && card.includes('id="pf-import"'), '缺按钮');
ok('renderCard：画像被回填（关键词/课程/阈值/来源）',
  card.includes('TOEFL, ACM') && card.includes('MATH1860J')
  && card.includes('id="pf-push-at" value="1"') && card.includes('自动派生'));
ok('renderCard：语义兜底下拉会按当前值选中', /id="pf-semantic"[\s\S]{0,160}value="batch" selected/.test(card));
ok('renderCard：学习记录显示成人话', card.includes('已从你的操作里学到') && card.includes('你删了 3 次'));
ok('renderCard：没有学习记录时给出提示',
  mod.renderCard({}, { enabled: true, notes: [] }, escStub).includes('就会开始学'));
ok('renderCard：HTML 转义生效', mod.renderCard({ keywords: ['<script>'] }, {}, escStub).includes('&lt;script&gt;'));
ok('renderCard：缺字段时用默认值', mod.renderCard(null, null, escStub).includes('id="pf-push-at" value="3"'));

// ---------- 5. 真的调用 mount()（框架的调用方式） ----------
function fakeEl() {
  const kids = new Map();
  return {
    innerHTML: '', dataset: {},
    querySelector: (s) => { if (!kids.has(s)) kids.set(s, { value: '', checked: false, onclick: null, innerHTML: '', textContent: '' }); return kids.get(s); },
  };
}
const el = fakeEl();
const calls = [];
const ctx = {
  api: async (method, path) => { calls.push(`${method} ${path}`); return { draft: { keywords: ['x'], courseCodes: [], denyKeywords: [] }, ok: true, skipped: 'disabled' }; },
  esc: escStub,
  toast: () => {},
  refresh: async () => {},
  DB: {
    profile: { enabled: true, keywords: ['TOEFL'], pushAt: 1, origin: 'manual', semantic: 'off' },
    profile_learned: { enabled: true, notes: [] },
  },
};
let mountError = null;
let handle = null;
try { handle = await mod.mount(el, ctx); } catch (e) { mountError = e; }
ok('mount() 不抛异常', mountError === null, String(mountError));
ok('mount() 把卡片写进了容器', el.innerHTML.includes('id="profile-card"') && el.innerHTML.includes('TOEFL'));
ok('mount() 返回 rerender 句柄（框架刷新时用）', typeof handle?.rerender === 'function');
ok('mount() 之后按钮已经绑好 onclick',
  typeof el.querySelector('#pf-save').onclick === 'function'
  && typeof el.querySelector('#pf-derive').onclick === 'function'
  && typeof el.querySelector('#pf-import').onclick === 'function'
  && typeof el.querySelector('#pf-semantic-run').onclick === 'function'
  && typeof el.querySelector('#pf-learn-clear').onclick === 'function');
// 点一下"自动派生"：应当只调接口、把草稿显示出来，不直接改线上数据
await el.querySelector('#pf-derive').onclick();
ok('点「自动派生」走的是 /api/profile/derive（先出草稿）',
  calls.some((c) => c === 'POST /api/profile/derive'), JSON.stringify(calls));
ok('草稿显示在面板里，并提供「用这份草稿」按钮',
  el.querySelector('#pf-draft').innerHTML.includes('草稿') && el.querySelector('#pf-draft').innerHTML.includes('pf-accept'));
const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
ok('app.js 通过 /api/modules 发现模块', app.includes("api('GET', '/api/modules')"));
ok('app.js 通过动态 import 加载模块入口', app.includes("await import('/modules/'"));
ok('app.js 不再内联「我关心什么」卡片（已搬进模块）',
  !app.includes('我关心什么 <span class="muted">') && !app.includes('function profileCardHtml'));
ok('renderConnectors 里留下了挂载点', /mountGadgets\('connectors'\)/.test(app));
const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
ok('server 暴露 /api/modules', srv.includes("p === '/api/modules'"));
ok('server 能服务 /modules/ 静态资源（实现已搬进 lib/server-shell.mjs，主程序只接线）',
  srv.includes('createStaticHandler({')
  && readFileSync(join(ROOT, 'lib', 'server-shell.mjs'), 'utf8').includes("pathname.startsWith('/modules/')"));

// ---------- 4. 资源路径安全（防目录穿越） ----------
const assetRoot = join(ROOT, 'modules');
ok('正常路径能解析', moduleAssetPath(assetRoot, 'filter-profile', 'view.js')?.endsWith('view.js') === true);
ok('用 .. 想跑出去会被拒', moduleAssetPath(assetRoot, 'filter-profile', '../../server.mjs') === null);
ok('绝对路径注入会被拒', moduleAssetPath(assetRoot, 'filter-profile', '/etc/passwd')?.startsWith(assetRoot) === true
  || moduleAssetPath(assetRoot, 'filter-profile', '/etc/passwd') === null);
ok('非法的模块 id 被拒', moduleAssetPath(assetRoot, '../..', 'x') === null);
ok('空的模块 id 被拒', moduleAssetPath(assetRoot, '', 'x') === null);

console.log('');
console.log(failures === 0 ? 'modules.test: PASS' : `modules.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
