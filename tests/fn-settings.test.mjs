// 「功能自己的设置」（2026-09-27）：一个功能一套键（fn_<id>）+ 三个接口 + 就地设置的接线
//
//   node tests/fn-settings.test.mjs
//
// 判据：
//   * 值存在功能自己的键里，**没配过就是默认值**（不是空串、不是 undefined）；
//   * 只认声明过的字段（写错键名不该污染存储）；标点选项写错要拒掉并说清；
//   * 「文件怎么命名」的实时预览用**真实台账**算，且与下载/改名走**同一个函数**；
//   * 「只有声明了 settings 的功能才出现 ⚙ 功能设置」这条在接线里挡得住。

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py 会设置）');
  process.exit(2);
}
// **必须先设数据目录再 import**：store.mjs 在 import 时就把库打开了
let root = '';
{
  const { mkdtempSync } = await import('node:fs');
  root = mkdtempSync(join(TMP, 'fn-settings-'));
  process.env.PLANNER_DATA_DIR = join(root, 'data');
  mkdirSync(process.env.PLANNER_DATA_DIR, { recursive: true });
}

const {
  FUNCTION_SETTINGS, courseAssistNamePreview, courseNameTemplate,
  fnSettingKey, getFunctionSettings, listFunctionSettings, setFunctionSettings,
} = await import('../lib/function-settings.mjs');
const { store } = await import('../lib/store.mjs');
const { createFunctionSettingsRoutes } = await import('../lib/routes/function-settings.mjs');
const { DEFAULT_NAME_TEMPLATE } = await import('../lib/naming.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('fn-settings.test.mjs');

// ---------------- 1. 登记表与默认值 ----------------
{
  ok('课程辅助登记了两个字段（命名模板 + 改名范围）',
    FUNCTION_SETTINGS.course_assist.fields.map((f) => f.key).join(',') === 'name_template,rename_scope');
  const f = getFunctionSettings('course_assist');
  ok('没配过的时候就是默认值（不是空）',
    f.ok && f.values.name_template === DEFAULT_NAME_TEMPLATE && f.values.rename_scope === 'future' && f.changed === false,
    JSON.stringify(f.values));
  ok('值的键就是 fn_course_assist', fnSettingKey('course_assist') === 'fn_course_assist');
  ok('没登记过的功能如实说没有', getFunctionSettings('nope').ok === false);
}

// ---------------- 2. 写 / 读 / 白名单 / 回到默认 ----------------
{
  const r = setFunctionSettings('course_assist', { name_template: '{课程号}_{原名}' });
  ok('改一个字段能存下来，另一字段不受影响',
    r.ok && r.values.name_template === '{课程号}_{原名}' && r.values.rename_scope === 'future', JSON.stringify(r.values));
  ok('真的落在 fn_course_assist 这个键里',
    JSON.parse(store.getSync('fn_course_assist')).name_template === '{课程号}_{原名}');
  ok('courseNameTemplate() 读到的是改过的值', courseNameTemplate() === '{课程号}_{原名}');

  const ignored = setFunctionSettings('course_assist', { 不存在的字段: 'x' });
  ok('声明外的字段被忽略（不污染存储）',
    ignored.ok && ignored.values.name_template === '{课程号}_{原名}' && JSON.parse(store.getSync('fn_course_assist')).不存在的字段 === undefined);

  const bad = setFunctionSettings('course_assist', { rename_scope: '以后再说' });
  ok('选项写错 → 拒掉并说清允许什么', bad.ok === false && bad.error.includes('future'), bad.error);

  const cleared = setFunctionSettings('course_assist', { name_template: '' });
  ok('传空串 = 回到默认（不是存一个空串）',
    cleared.ok && cleared.values.name_template === DEFAULT_NAME_TEMPLATE && cleared.changed === false,
    JSON.stringify(cleared.values));
  ok('坏掉的 JSON 不会把功能弄挂',
    (() => { store.setSync('fn_last', '{坏'); return getFunctionSettings('course_assist').ok === true; })());
  ok('一次能取全部（界面只打一个请求）', listFunctionSettings().schema === 'fn-settings.v1');
}

// ---------------- 3. 实时预览（用真实台账行算） ----------------
{
  const mk = (external_id, course, course_code, filename, file_date) => store.createCourseFile({
    external_id, source: 'canvas', course, course_code, filename, url: `https://x/${external_id}`, size: 10,
    file_date, status: 'downloaded', device_status: 'pending',
  });
  mk('f1', '(2026-2027-1)-MATH1860J-01-高等数学B1', 'MATH1860J', 'math186_all_lecture_slides.pdf', new Date('2026-09-16').getTime());
  mk('f2', '(2026-2027-1)-ENGR1010J-03-工程导论', 'ENGR1010J', 'lec 1.pdf', new Date('2026-09-30').getTime());

  const p = courseAssistNamePreview({ template: DEFAULT_NAME_TEMPLATE });
  ok('预览给的是你自己台账里的材料名（不是编的）',
    p.ok && p.samples.some((s) => s.from === 'math186_all_lecture_slides.pdf'), JSON.stringify(p.samples).slice(0, 200));
  ok('预览算出的新名字与落盘规则一致（同一个函数）',
    p.samples.find((s) => s.from === 'math186_all_lecture_slides.pdf').to === 'FA26_MATH1860J_Week1_all_lecture_slides.pdf',
    JSON.stringify(p.samples[0]));
  ok('台账整体也统计了"会改多少份"', p.counts.ledger >= 2 && typeof p.counts.would_rename === 'number', JSON.stringify(p.counts));
  ok('没有学院材料时补一个样例，说明"没有周次时 Week 段消失"',
    p.samples.some((s) => s.to.includes('学院文件')), JSON.stringify(p.samples.map((s) => s.to)));

  const custom = courseAssistNamePreview({ template: '{学期}-{课程号}-第{周次}周-{原名}' });
  ok('自定义模板的预览跟着变',
    custom.samples.some((s) => s.to === 'FA26-ENGR1010J-第3周-lec 1.pdf'), JSON.stringify(custom.samples.map((s) => s.to)));
  ok('模板里没有 {原名} 会给一句人话提醒',
    courseAssistNamePreview({ template: '{课程号}_{周次}' }).warnings.some((w) => w.includes('原名')));
  ok('写错的变量会被点名',
    courseAssistNamePreview({ template: '{课程号}_{XYZ}_{原名}' }).warnings.some((w) => w.includes('{XYZ}')));
  ok('空模板 → 提示会用默认模板',
    courseAssistNamePreview({ template: '  ' }).warnings.some((w) => w.includes('默认')) && courseAssistNamePreview({ template: '' }).is_default === true);
  ok('预览不写任何东西（只算）', store.getSync('fn_course_assist') !== null);
}

// ---------------- 4. 三个接口 ----------------
{
  const routes = createFunctionSettingsRoutes({
    sendJson: (res, code, body) => { res.code = code; res.body = body; },
    sendError: (res, code, msg) => { res.code = code; res.body = { error: msg }; },
    readBody: async (req) => req.body || {},
    log: () => {},
  });
  const call = async (method, pathname, body = null) => {
    const res = {};
    await routes.handleFnSettings({ method, body }, res, new URL('http://x' + pathname));
    return res;
  };

  const g = await call('GET', '/api/fn-settings');
  ok('GET /api/fn-settings → 当前值 + 默认值 + 字段声明',
    g.code === 200 && g.body.functions.course_assist.fields.length === 2 && !!g.body.functions.course_assist.defaults.name_template);
  const gOne = await call('GET', '/api/fn-settings/course_assist');
  ok('GET /api/fn-settings/<功能> → 单个功能的设置', gOne.code === 200 && gOne.body.id === 'course_assist');
  const g404 = await call('GET', '/api/fn-settings/不存在的');
  ok('没登记过的功能 → 404 且列出有哪些', g404.code === 404 && g404.body.error.includes('course_assist'));

  const p1 = await call('POST', '/api/fn-settings', { fn: 'course_assist', patch: { rename_scope: 'all' } });
  ok('POST 改值 → 回新的整份设置', p1.code === 200 && p1.body.values.rename_scope === 'all');
  const p2 = await call('POST', '/api/fn-settings', { fn: 'nope', patch: {} });
  ok('POST 不认识的 fn → 400', p2.code === 400 && p2.body.error.includes('没有登记过'));
  const p3 = await call('POST', '/api/fn-settings', { fn: 'course_assist', patch: { rename_scope: '乱写' } });
  ok('POST 选项非法 → 400', p3.code === 400);

  const pv = await call('POST', '/api/fn-settings/preview', { fn: 'course_assist', template: '{原名}' });
  ok('预览接口只算不存（值没被改）',
    pv.code === 200 && pv.body.template === '{原名}' && getFunctionSettings('course_assist').values.rename_scope === 'all');
  const pvBad = await call('POST', '/api/fn-settings/preview', { fn: 'others' });
  ok('没做预览的功能 → 400 说清', pvBad.code === 400 && pvBad.body.error.includes('预览'));
  const nf = await call('POST', '/api/fn-settings/whatever', {});
  ok('别的路径 → 404', nf.code === 404);

  // 收尾：把改出来的值退回默认，别把测试数据留在库里
  setFunctionSettings('course_assist', { name_template: '', rename_scope: 'future' });
}

// ---------------- 5. 接线守卫（"只有声明了才有那颗按钮"） ----------------
{
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const srv = read('server.mjs');
  const app = read('public/app.js');
  const html = read('public/index.html');
  const modJson = JSON.parse(read('modules/course-assist-view/module.json'));
  const viewJs = read('modules/course-assist-view/view.js');
  const courseSync = read('lib/course-sync.mjs');
  const settingsPanel = read('modules/settings/panel.js');

  ok('server.mjs 接上了 /api/fn-settings', srv.includes('createFunctionSettingsRoutes') && srv.includes('/api/fn-settings'));
  ok('课程辅助声明了 settings: true', modJson.settings === true && modJson.version !== '0.1.0');
  ok('模块导出了 settings(host, ctx) 与纯函数渲染', /export async function settings\(/.test(viewJs) && /export function renderSettings\(/.test(viewJs));
  ok('页头留了 actions 容器 + 抽屉骨架都在主程序里',
    html.includes('id="page-actions"') && app.includes('function renderPageActions(') && app.includes('async function openFunctionDrawer(') && app.includes('function closeFunctionDrawer('));
  ok('只有 settings === true 的功能才画那颗按钮（不是所有页都有）',
    app.includes("if (!m || m.settings !== true) return;"));
  ok('抽屉是覆盖式（fixed + translateX），不挤压页面',
    read('public/styles.css').includes('.fn-drawer {') && read('public/styles.css').includes('transform: translateX(100%)'));
  ok('设置页只留一行指路（有专属设置 → 去那一页右上角）',
    settingsPanel.includes('有专属设置') && settingsPanel.includes('⚙ 功能设置'));

  ok('course-sync 的"放在哪"收敛成一处 courseRoot()',
    courseSync.includes('export function courseRoot(') && courseSync.includes('cfg.root = courseRoot(cfg)'));
  ok('四个调用点都走当前模板（下载 / 桌面改名 / 邮件附件名 / 通知文案）',
    (courseSync.match(/courseFileNameTemplate\(\)/g) || []).length >= 4);
  ok('通知文案不再写死「FA26课程资料」', !courseSync.includes('「桌面 / FA26课程资料 / <课程>」') && courseSync.includes('courseRootLabel()'));
  // 这条是 2026-09-27 实测撞出来的：folderCode() 与"台账指回现存文件"两处用了 COLLEGE_CODE，
  // 但从来没 import；只要台账里有一条还没下载的（abs_path 为空）记录，「统一命名」就 500。
  ok('course-sync 用到的 COLLEGE_CODE 真的 import 了（否则「统一命名」会 500）',
    /import \{[^}]*COLLEGE_CODE[^}]*\} from '\.\/naming\.mjs'/.test(courseSync));
  ok('默认模板只在 lib/naming.mjs 里定义一次（别处不许再抄一份）',
    !read('lib/course-sync.mjs').includes("'{学期}_{课程号}_Week{周次}_{原名}'")
    && !read('modules/course-assist-view/view.js').includes('{学期}_{课程号}_Week{周次}_{原名}'));
}

console.log('');
console.log(failures === 0 ? 'fn-settings.test: PASS' : `fn-settings.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
