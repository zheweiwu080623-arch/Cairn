// 「本机目录 / 本机工具 / 导出格式」的验证（2026-09-28，P1「自定义补齐」）
//
//   node tests/local-tools.test.mjs
//
// 判据：
//   * 本机**工具**（pdftotext / pdftoppm）也能在界面上改：校验不能放水、
//     写回 paths.json 之后**立刻生效**（不重启）、清空 = 改回"自动找"；
//   * 光写一个命令名（`pdftotext`）时**真的去 PATH 里查**，查不到要如实说 —— 不能存个空壳；
//   * 计划导出能选格式（md / json / ics / csv），**默认仍然是 md + json**（老装机行为不变），
//     CSV 该转义的转义、该防的公式注入要防；
//   * 接线守卫：设置页里有「本机」页签、服务端有四种格式的下载口。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = process.env.PLANNER_TEST_TMP || '';
if (!TMP) {
  console.error('需要 PLANNER_TEST_TMP（run_all_suites.py / run-portable.mjs 会设置）');
  process.exit(2);
}
console.log('local-tools.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(TMP, 'local-tools-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
// **必须先设数据目录再 import store**（store.mjs 在 import 时就把库打开了）
process.env.PLANNER_DATA_DIR = dataDir;

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

const WIN = process.platform === 'win32';
const PATHSEP = WIN ? ';' : ':';
const EXE = WIN ? 'pdftotext.exe' : 'pdftotext';

const {
  LOCAL_TOOL_KEYS, checkToolInput, createLocalDirRoutes, describeLocalTool, resolveCommandInPath,
} = await import('../lib/routes/localdirs.mjs');
const { readLocalConfig, writeLocalConfig } = await import('../lib/local-config.mjs');
const { buildFilePickerScript, macFilePickerArgs, pickFile } = await import('../lib/pick-folder.mjs');
const {
  findPdftotext, getConfiguredPdftotext, setPdftotextPath,
} = await import('../lib/coursetext.mjs');
const { findRasterizer, getConfiguredRasterizer, setRasterizerPath } = await import('../lib/pdf-pages.mjs');
const {
  DEFAULT_PLAN_FORMATS, PLAN_FILE_NAMES, buildPlan, normalizePlanFormats, planToCsv, writePlanExport,
} = await import('../lib/plan-export.mjs');
const { planExportFormats, setFunctionSettings } = await import('../lib/function-settings.mjs');
const { store } = await import('../lib/store.mjs');

// ---------------- 1. 工具路径的输入校验 ----------------
{
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const exePath = join(binDir, EXE);
  writeFileSync(exePath, 'x');
  const notExe = join(root, 'notes.txt');
  writeFileSync(notExe, 'x');

  ok('空 = 清除配置（不是错误）', checkToolInput('').ok === true && checkToolInput('').path === '');
  ok('null / undefined 也当清除', checkToolInput(null).ok === true && checkToolInput(undefined).ok === true);
  ok('存在的文件 → 通过，并给出绝对路径',
    checkToolInput(exePath).ok === true && checkToolInput(exePath).path === exePath);
  ok('从资源管理器复制来的带引号路径会被去掉引号',
    checkToolInput(`"${exePath}"`).ok === true && checkToolInput(`"${exePath}"`).path === exePath);
  ok('不存在的文件 → 拒绝，并说清是哪个路径',
    checkToolInput(join(root, '没有这个.exe')).ok === false && checkToolInput(join(root, '没有这个.exe')).error.includes('不存在'));
  ok('给了一个**文件夹** → 明确说"这是文件夹，不是可执行文件"',
    checkToolInput(binDir).ok === false && checkToolInput(binDir).error.includes('文件夹'));

  // 光写命令名：真的去 PATH 里查
  const env = { PATH: binDir };
  const bare = checkToolInput(WIN ? 'pdftotext' : 'pdftotext', { env, platform: process.platform });
  ok('只写命令名 → 真的去 PATH 里查，查到了就存**绝对路径**',
    bare.ok === true && bare.resolved === true && bare.path === exePath, JSON.stringify(bare));
  const missing = checkToolInput('绝对没有这个命令', { env, platform: process.platform });
  ok('命令名在 PATH 里找不到 → 如实拒绝（不存个空壳）',
    missing.ok === false && missing.error.includes('PATH'));
  ok('resolveCommandInPath 是纯查表（找不到返回空串）',
    resolveCommandInPath('绝对没有这个命令', { env, platform: process.platform }) === '');
};

// ---------------- 2. 当前值解析：环境变量 > paths.json > 自动找到 ----------------
{
  const env = {};
  const exePath = join(root, 'bin', EXE);
  writeLocalConfig({ pdftotext_path: exePath }, { dataDir, env });
  const d = describeLocalTool('pdftotext', { dataDir, env });
  ok('工具清单里有 pdftotext 与 pdftoppm', Boolean(LOCAL_TOOL_KEYS.pdftotext) && Boolean(LOCAL_TOOL_KEYS.pdftoppm));
  ok('没环境变量时读配置文件', d.path === exePath && d.from === 'config' && d.exists === true);
  ok('环境变量优先（它的用途就是临时压过配置）',
    describeLocalTool('pdftotext', { dataDir, env: { PLANNER_PDFTOTEXT: join(root, '别处', 'x.exe') } }).from === 'env');
  ok('没配也能报出"应用自己找到的"（可选工具，不该显示成故障）',
    (() => {
      const r = describeLocalTool('pdftotext', { dataDir: join(root, '没有配置的目录'), env: {}, detect: () => exePath });
      return r.configured === false && r.auto === exePath && r.effective === exePath && r.effective_from === 'auto';
    })());
  ok('配了但文件不在了 → 如实标 exists=false',
    describeLocalTool('pdftotext', { dataDir, env: { PLANNER_PDFTOTEXT: join(root, '搬走了.exe') } }).exists === false);
  ok('不认识的键返回 null（白名单）', describeLocalTool('乱写的', { dataDir, env }) === null);
  writeLocalConfig({ pdftotext_path: null }, { dataDir, env });
};

// ---------------- 3. 路由：改工具路径 / 选文件 ----------------
{
  const env = {};
  const binDir = join(root, 'bin');
  const exePath = join(binDir, EXE);
  const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };
  const sendError = (res, code, message) => { res.code = code; res.body = { error: message }; };
  const changed = [];
  const routes = createLocalDirRoutes({
    dataDir, env, sendJson, sendError,
    readBody: async (req) => req.body || {},
    onChanged: (k, v) => changed.push([k, v]),
    pick: async () => ({ ok: true, dir: join(root, '别处') }),
    pickFileFn: async () => ({ ok: true, file: exePath }),        // 假选择框：绝不真弹窗
    detectTools: { pdftotext: () => '', pdftoppm: () => '' },
  });
  const req = (method, body) => ({ method, body });
  const urlOf = (p) => new URL('http://127.0.0.1:3210' + p);

  {
    const res = {};
    await routes.handleLocalDirs(req('GET'), res, urlOf('/api/localdirs'));
    ok('GET 同时列出目录与工具',
      res.code === 200 && Boolean(res.body.dirs.wallpaper) && Boolean(res.body.tools.pdftotext));
  }
  {
    const res = {};
    await routes.handleLocalDirs(req('POST', { key: 'pdftotext', path: join(root, '没有这个.exe') }), res, urlOf('/api/localdirs'));
    ok('POST 不存在的工具路径 → 400 且人话解释', res.code === 400 && res.body.error.includes('不存在'));
  }
  {
    const res = {};
    await routes.handleLocalDirs(req('POST', { key: 'pdftotext', path: exePath }), res, urlOf('/api/localdirs'));
    ok('POST 合法工具路径 → 200、写进配置、并通知用到它的人（立刻生效）',
      res.code === 200 && readLocalConfig(dataDir, env).pdftotext_path === exePath
      && changed.some(([k, v]) => k === 'pdftotext' && v === exePath));
    ok('回包里带的是"现在用的是什么"', res.body.tools.pdftotext.effective === exePath);
  }
  {
    const res = {};
    await routes.handleLocalDirs(req('POST', { key: 'pdftotext', path: '' }), res, urlOf('/api/localdirs'));
    ok('POST 空 = 改回"自动找"（不是把工具删了）',
      res.code === 200 && readLocalConfig(dataDir, env).pdftotext_path === undefined && existsSync(exePath));
    ok('清空后 onChanged 也通知了（值变成空）', changed.some(([k, v]) => k === 'pdftotext' && v === ''));
  }
  {
    const res = {};
    await routes.handleLocalDirs(req('POST', { key: 'pdftotext' }), res, urlOf('/api/localdirs/pick'));
    ok('选文件的框：只返回路径、**不落盘**',
      res.code === 200 && res.body.path === exePath && readLocalConfig(dataDir, env).pdftotext_path === undefined);
  }
  {
    const res = {};
    await routes.handleLocalDirs(req('POST', { key: '乱写的', path: exePath }), res, urlOf('/api/localdirs'));
    ok('不认识的 key → 400，并列出可改的有哪些',
      res.code === 400 && res.body.error.includes('pdftotext') && res.body.error.includes('wallpaper'));
  }
};

// ---------------- 4. 选文件的系统对话框（只测拼出来的东西，不弹窗） ----------------
{
  const s = buildFilePickerScript({ title: '选择 pdftotext', initial: root, filter: '可执行文件 (*.exe)|*.exe' });
  ok('Windows 用 OpenFileDialog（不是选目录那个）', s.includes('System.Windows.Forms.OpenFileDialog'));
  ok('带上标题、按文件校验存在、并把 Filter 传给对话框',
    s.includes('选择 pdftotext') && s.includes('$dlg.CheckFileExists = $true') && s.includes('可执行文件 (*.exe)'));
  ok('标题里有单引号也不会把脚本弄坏', buildFilePickerScript({ title: "it's ok" }).includes("'it''s ok'"));
  ok('macOS 走 choose file（不是 choose folder）',
    /choose file with prompt/.test(macFilePickerArgs({ title: '选择 pdftotext' })[1]));

  const got = await pickFile({
    platform: 'win32',
    runner: (cmd, args, opts, cb) => { cb(null, `${join(root, 'bin', EXE)}\r\n`); },
  });
  ok('Windows：拿到文件路径（返回的是 file 而不是 dir）',
    got.ok === true && got.file === join(root, 'bin', EXE));
  const cancelled = await pickFile({ platform: 'win32', runner: (cmd, a, o, cb) => cb(null, '') });
  ok('用户取消 → cancelled（不是失败）', cancelled.ok === true && cancelled.cancelled === true && cancelled.file === null);
  const linux = await pickFile({ platform: 'linux' });
  ok('不支持的平台 → 如实说 + 给手动粘贴的退路',
    linux.ok === false && linux.error.includes('手动粘贴'));
};

// ---------------- 5. 配了路径之后，模块真的用上了（不重启） ----------------
{
  const fake = join(root, 'poppler', 'pdftotext.exe');
  setPdftotextPath(fake);
  ok('setPdftotextPath 存下来了', getConfiguredPdftotext() === fake);
  ok('界面上配的路径排在"自动找"之前',
    findPdftotext({ exists: (p) => p === fake, env: { PATH: '' }, cache: false }) === fake);
  const envExe = join(root, 'env', 'pdftotext.exe');
  ok('环境变量仍然压过界面配置（临时覆盖的用途不变）',
    findPdftotext({
      exists: (p) => p === fake || p === envExe,
      env: { PLANNER_PDFTOTEXT: envExe, PATH: '' }, cache: false,
    }) === envExe);
  const candidate = join(root, '其他', 'pdftotext.exe');
  ok('配了但文件不在了 → 继续自动找（不假装配好了）',
    findPdftotext({ candidates: [candidate], exists: (p) => p === candidate, env: { PATH: '' }, cache: false }) === candidate);
  setPdftotextPath('');
  ok('清空配置 = 回到自动找', getConfiguredPdftotext() === '');

  setRasterizerPath(fake);
  ok('pdftoppm 同理：界面上配的路径最优先',
    getConfiguredRasterizer() === fake && findRasterizer({ exists: (p) => p === fake }) === fake);
  setRasterizerPath('');
  ok('pdftoppm 清空后也回到自动找', getConfiguredRasterizer() === '');
};

// ---------------- 6. 导出格式（P1.2） ----------------
{
  ok('格式只有这四种', Object.keys(PLAN_FILE_NAMES).join(',') === 'md,json,ics,csv');
  ok('默认还是 Markdown + JSON（老装机升级上来行为不变）',
    DEFAULT_PLAN_FORMATS.join(',') === 'md,json' && normalizePlanFormats('').join(',') === 'md,json');
  ok('只认认识的格式、去重、按固定顺序',
    normalizePlanFormats('csv, md,md,乱写').join(',') === 'md,csv');
  ok('没配过的功能设置就是默认两份', planExportFormats().join(',') === 'md,json');

  const bad = setFunctionSettings('plan_export', { formats: 'md,pdf' });
  ok('写了不认识的格式 → 拒掉并说清允许什么', bad.ok === false && bad.error.includes('pdf') && bad.error.includes('csv'));
  const saved = setFunctionSettings('plan_export', { formats: 'csv,ics' });
  ok('勾了 ICS + CSV → 存下来，导出时按它走', saved.ok === true && planExportFormats().join(',') === 'ics,csv');
  const cleared = setFunctionSettings('plan_export', { formats: '' });
  ok('勾全去掉 = 回到默认（不存"什么都没勾"）', cleared.ok === true && planExportFormats().join(',') === 'md,json');
  setFunctionSettings('plan_export', { formats: '' });
};

// ---------------- 7. CSV 与"按格式导出" ----------------
{
  const now = new Date();
  store.createTask({ title: '带,逗号 和"引号"的任务', due_at: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 20, 0).toISOString(), priority: 1 });
  store.createTask({ title: '=cmd|\' /C calc\'!A1', due_at: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0).toISOString() });
  store.createTask({ title: '没排期的任务' });
  const plan = buildPlan(store, { days: 2 });
  const csv = planToCsv(plan);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  ok('表头是那十列', lines[0] === '日期,星期,类型,开始,结束,标题,地点,状态,优先级,备注', lines[0]);
  ok('带逗号的标题被整格引起来（不会把表格撑错位）',
    csv.includes('"带,逗号 和""引号""的任务"'));
  ok('公式开头的标题被加上单引号（不让 Excel 当公式执行）',
    csv.includes("'=cmd|"), csv.slice(0, 200));
  ok('逾期 / 未排期也各有一行',
    csv.includes('未排期任务') && csv.includes('没排期的任务'));

  const out = join(root, 'plan-out');
  const r = writePlanExport(store, { dataDir: out, formats: ['md', 'ics'] });
  ok('勾了哪几种就写哪几种', r.formats.join(',') === 'md,ics'
    && existsSync(join(out, 'plan', 'daily-plan.md')) && existsSync(join(out, 'plan', 'daily-plan.ics'))
    && !existsSync(join(out, 'plan', 'plan.json')) && !existsSync(join(out, 'plan', 'daily-plan.csv')));
  const icsText = readFileSync(join(out, 'plan', 'daily-plan.ics'), 'utf8');
  ok('写出来的 .ics 是能导进日历的（有 VCALENDAR / VEVENT 头）',
    icsText.includes('BEGIN:VCALENDAR') && icsText.includes('BEGIN:VEVENT'));

  const r2 = writePlanExport(store, { dataDir: join(root, 'plan-out2') });
  ok('不传格式 = 默认那两份（老调用点不用改）',
    r2.formats.join(',') === 'md,json'
    && existsSync(join(root, 'plan-out2', 'plan', 'daily-plan.md'))
    && existsSync(join(root, 'plan-out2', 'plan', 'plan.json')));
};

// ---------------- 8. 接线守卫 ----------------
{
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const srv = read('server.mjs');
  const panel = read('modules/settings/panel.js');
  const app = read('public/app.js');

  ok('server.mjs 启动时把配置注入给取字 / 转图两个模块',
    srv.includes('setPdftotextPath(localPath(') && srv.includes('setRasterizerPath(localPath('));
  ok('server.mjs 改完立刻生效（onChanged 里三条线）',
    srv.includes("if (key === 'pdftotext') setPdftotextPath(value)") && srv.includes("if (key === 'pdftoppm') setRasterizerPath(value)"));
  ok('server.mjs 报得出"应用自己找到的"（工具清单靠它显示）',
    srv.includes("pdftotext: () => findPdftotext()") && srv.includes('pdftoppm: () => findRasterizer()'));
  ok('四种格式都有下载口', /\\\/api\\\/plan\\\.\(md\|json\|ics\|csv\)/.test(srv) || srv.includes('|json|ics|csv'), srv.includes('/api/plan.') ? 'ok' : 'missing');
  ok('导出的格式取自设置（不是写死两份）', srv.includes('planExportFormats()'));
  ok('设置页有「本机」页签，装着三块',
    panel.includes("id: 'local'") && panel.includes('export function renderLocal(')
    && panel.includes('本机目录') && panel.includes('本机工具（可选）') && panel.includes('计划导出'));
  ok('设置页走同一套接口（不另开小路）',
    panel.includes("'/api/localdirs'") && panel.includes("'/api/localdirs/pick'") && panel.includes("'/api/fn-settings'"));
  ok('应用里原有的"预览 Markdown"链接还在（旧入口没被删）',
    app.includes('/api/plan.md') && app.includes('daily-plan.md'));
}

console.log('');
console.log(failures === 0 ? 'local-tools.test: PASS' : `local-tools.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
