// 品牌名解析测试（Cairn 改名步骤）。
//
//   node tests/brand.test.mjs
//
// 规则：环境变量 > <数据目录>/brand.json > 默认 'Cairn'
// 这条规则的用途：作者本机显示自己的名字，别人 clone 下来显示 Cairn。

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appName, brandInfo, DEFAULT_APP_NAME } from '../lib/brand.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('brand.test.mjs');

ok('默认名是 Cairn', DEFAULT_APP_NAME === 'Cairn', DEFAULT_APP_NAME);
ok('没有数据目录时返回默认名', appName({ dataDir: '', env: {} }) === 'Cairn',
  appName({ dataDir: '', env: {} }));

const dir = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'brand-'));

ok('目录里没有 brand.json 时用默认名', appName({ dataDir: dir, env: {} }) === 'Cairn');

writeFileSync(join(dir, 'brand.json'), JSON.stringify({ app_name: '空庭Coterie的Planner' }), 'utf8');
ok('brand.json 能覆盖默认名', appName({ dataDir: dir, env: {} }) === '空庭Coterie的Planner',
  appName({ dataDir: dir, env: {} }));
ok('环境变量优先级最高',
  appName({ dataDir: dir, env: { PLANNER_APP_NAME: '临时名' } }) === '临时名');

writeFileSync(join(dir, 'brand.json'), '{ 坏掉的 JSON', 'utf8');
ok('brand.json 坏了也不会让应用崩（回退默认名）',
  appName({ dataDir: dir, env: {} }) === 'Cairn');

writeFileSync(join(dir, 'brand.json'), JSON.stringify({ app_name: '   ' }), 'utf8');
ok('空白的 app_name 视为没填', appName({ dataDir: dir, env: {} }) === 'Cairn');

const info = brandInfo({ dataDir: dir, env: {} });
ok('brandInfo 返回契约形状', info.app_name === 'Cairn' && info.default_app_name === 'Cairn',
  JSON.stringify(info));

// 防回归：界面文件里不该再写死作者的名字
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
ok('index.html 里没有写死作者名字', !html.includes('空庭Coterie'));
ok('index.html 带上了可被脚本替换的品牌节点',
  html.includes('id="app-name-brand"') && html.includes('id="app-name-wb"'));
const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
ok('app.js 不再把作者名字写进常量', !/const APP_TITLE = '空庭/.test(app));
ok('app.js 会从 /api/state 取品牌名', /data\.brand\.app_name/.test(app));

console.log('');
console.log(failures === 0 ? 'brand.test: PASS' : `brand.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
