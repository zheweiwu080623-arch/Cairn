// 页头齿轮（P2「就地设置」推广，2026-09-28）
//
//   node tests/page-gear.test.mjs
//
// 判据：
//   * 一页上**只要有**"声明了 settings 的功能"（不管它是 view 还是挂在页里的 gadget），
//     页头右上角就出现「⚙ 功能设置」；一个都没有就不出现（空白按钮是纯噪音）；
//   * 抽屉按功能分段（今日页 / 任务页可能各有好几个），每段由模块自己的 settings() 画；
//   * 两个 gadget 的细项真的从卡片里搬进了抽屉，而且**卡片上不再重复一份**（一处声明）；
//   * 卡片上的"开/关"保存时不会把抽屉里的值顺手改回默认（这条踩过就会丢配置）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('page-gear.test.mjs');

const app = read('public/app.js');
const html = read('public/index.html');
const css = read('public/styles.css');
const ddlCard = read('modules/ddl-card/view.js');
const pcCard = read('modules/preclass-card/view.js');
const ddlMeta = readJson('modules/ddl-card/module.json');
const pcMeta = readJson('modules/preclass-card/module.json');
const courseMeta = readJson('modules/course-assist-view/module.json');

// ---------------- ① 页头按钮认哪几种模块 ----------------
ok('页头留了 actions 容器（应用里是真的那颗按钮的位置）', html.includes('id="page-actions"'));
ok('页头按钮改由 pageSettingsModules() 决定（不再只认"模块 id 正好等于页名"）',
  app.includes('function pageSettingsModules(') && app.includes('x.mount_into === tab'));
ok('view 类还是按 id 认（课程辅助那一页照旧）',
  app.includes("if (x.kind === 'view') return x.id === tab;"));
ok('没有任何"有专属设置"的功能时不画按钮（不留一个空按钮）',
  app.includes('if (!list.length) return;'));
ok('按钮点了开的是**这一页**的功能设置（不再是硬编码某一个模块 id）',
  app.includes('btn.onclick = () => openFunctionDrawer(list.map((x) => x.id));'));

// ---------------- ② 抽屉按功能分段 ----------------
ok('抽屉收数组（一页可能有多个功能有设置）',
  app.includes('async function openFunctionDrawer(ids)') && app.includes('Array.isArray(ids) ? ids : [ids]'));
ok('多个功能时抽屉标题是"这一页的功能设置"，单个时还是"某某 · 设置"',
  app.includes("list.length === 1 ? `${list[0].name} · 设置` : '这一页的功能设置'"));
ok('每段用模块自己的名字/图标做小标题，内容交给模块的 settings()',
  app.includes('fn-drawer-section') && app.includes('await mod.settings(slot, moduleCtx())'));
ok('样式里有分段（一页多个功能时才用得上）',
  css.includes('.fn-drawer-section {') && css.includes('.fn-drawer-section:last-child'));

// ---------------- ③ 两个 gadget 真的搬到抽屉里了 ----------------
ok('DDL 提醒声明了 settings: true', ddlMeta.settings === true);
ok('上课前检查声明了 settings: true', pcMeta.settings === true);
ok('课程辅助那条老路没被改坏（还是 settings: true 的 view）',
  courseMeta.settings === true && courseMeta.kind === 'view');

ok('DDL 卡片导出了抽屉要的 settings() 与纯函数 renderSettings()',
  /export async function settings\(host, ctx/.test(ddlCard) && /export function renderSettings\(/.test(ddlCard));
ok('DDL 抽屉里能勾档位、能选推手机',
  ddlCard.includes('ddl-set-step') && ddlCard.includes('ddl-set-bark'));
ok('DDL 卡片上**不再重复**一份档位复选框（一处声明）',
  !ddlCard.includes('class="ddl-step"') && ddlCard.includes('⚙ 功能设置'));
ok('DDL 卡片保存"开/关"时会带上原有的档位与推手机（不会顺手清掉）',
  ddlCard.includes('bark: !!(payload.prefs && payload.prefs.bark)')
  && ddlCard.includes('steps: (payload.prefs && payload.prefs.steps) || []'));

ok('课前检查卡片导出了 settings() 与 renderSettings()',
  /export async function settings\(host, ctx/.test(pcCard) && /export function renderSettings\(/.test(pcCard));
ok('课前检查抽屉里能改提前几分钟 / 只看最近多久 / 推手机',
  pcCard.includes('pc-set-lead') && pcCard.includes('pc-set-since') && pcCard.includes('pc-set-bark'));
ok('课前检查卡片上**不再重复**那三个细项（只留一行指路）',
  !pcCard.includes('id="pc-lead"') && !pcCard.includes('id="pc-since"') && !pcCard.includes('id="pc-bark"')
  && pcCard.includes('⚙ 功能设置'));
ok('课前检查卡片保存"启用/进通知"时沿用抽屉里的值',
  pcCard.includes('lead_minutes: p.lead_minutes ?? 30') && pcCard.includes('since_hours: p.since_hours ?? 48'));

// ---------------- ④ 抽屉内容是纯函数，能离线验 ----------------
{
  const { renderSettings: ddlSettings, STEP_CHOICES } = await import('../modules/ddl-card/view.js');
  const s = ddlSettings({ prefs: { steps: [STEP_CHOICES[0].ms], bark: true } });
  ok('DDL 抽屉：勾上的档位是勾上的、推手机是勾上的',
    s.includes(`data-ms="${STEP_CHOICES[0].ms}" checked`) && s.includes('id="ddl-set-bark" checked'));
  ok('DDL 抽屉：五个档位都在（选项表只有一份）',
    STEP_CHOICES.length === 5 && STEP_CHOICES.every((c) => s.includes(c.label)));
  const empty = ddlSettings({});
  ok('DDL 抽屉：没配过也能画出来（不崩、不显示 undefined）',
    !/undefined/.test(empty) && empty.includes('ddl-set-save'));
}
{
  const { renderSettings: pcSettings } = await import('../modules/preclass-card/view.js');
  const s = pcSettings({ prefs: { lead_minutes: 45, since_hours: 24, bark: false } });
  ok('课前检查抽屉：带出当前值（提前 45 分钟 / 24 小时）',
    s.includes('value="45"') && s.includes('value="24"'));
  ok('课前检查抽屉：没配过时给默认值 30 / 48，且不显示 undefined',
    !/undefined/.test(pcSettings({})) && pcSettings({}).includes('value="30"') && pcSettings({}).includes('value="48"'));
}

console.log('');
console.log(failures === 0 ? 'page-gear.test: PASS' : `page-gear.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
