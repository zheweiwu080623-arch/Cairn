// 「测试反馈」里三条小项的回归守卫（2026-09-25）。
//
//   node tests/feedback-fixes.test.mjs
//
// 这三条都是"用户体验问题"而不是崩坏：① 数据源顺序 ② 通知「测试」含义不明 ③ 倒计时删不掉。
// 用源码守卫钉住它们，免得以后重排/改文案时把用户要的顺序又改回去。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectors, listConnectorMeta } from '../lib/connectors/index.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('feedback-fixes.test.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const study = readFileSync(join(ROOT, 'lib', 'routes', 'study.mjs'), 'utf8');

// ---------------- ① 数据源顺序（用户实测反馈：常用的放前面） ----------------
{
  const ids = listConnectorMeta().map((m) => m.id);
  ok('九个数据源都还在（没有因为重排漏掉）', ids.length === 9 && new Set(ids).size === 9, JSON.stringify(ids));
  ok('第一个是邮箱（用户第一优先）', ids[0] === 'email', ids[0]);
  ok('第二个是交大邮箱', ids[1] === 'email_sjtu', ids[1]);
  ok('arXiv / RSS / 日历订阅 / JSON / 本地文件 紧跟在后面',
    JSON.stringify(ids.slice(2, 7)) === JSON.stringify(['arxiv', 'rss', 'ical', 'jsonapi', 'localfile']),
    JSON.stringify(ids.slice(2, 7)));
  ok('飞书排最后（几乎不用）', ids[ids.length - 1] === 'feishu', ids[ids.length - 1]);
  ok('顺序 = 界面卡片顺序（listConnectorMeta 用 Object.values 迭代）',
    Object.keys(connectors).join(',') === ids.join(','));
  ok('注释里写清"顺序来自用户测试反馈"（免得后人随手重排）',
    readFileSync(join(ROOT, 'lib', 'connectors', 'index.mjs'), 'utf8').includes('顺序 = 界面卡片顺序'));
}

// ---------------- ② 通知的「测试」按钮说清是什么 ----------------
{
  ok('按钮标签不再是光秃秃的「测试」', /data-test="\$\{n\.id\}"[^>]*>测试提醒</.test(app));
  ok('按钮带 title 说明（真的会响一次、不影响后续）',
    /data-test="\$\{n\.id\}"[^>]*title="[^"]*真的会响一次/.test(app));
  ok('点完的提示也说明"只响这一次"',
    app.includes('只响这一次，不影响这条通知之后的正常提醒'));
}

// ---------------- ③ 倒计时（里程碑）能在界面上删掉 ----------------
{
  ok('卡片上有删除按钮', app.includes('data-del-cd="${m.id}"'));
  ok('删除按钮带 title（说明它删的是什么）', /data-del-cd="\$\{m\.id\}"[^>]*title="删除这个倒计时"/.test(app));
  ok('点了会走 delItem → DELETE /api/milestones/:id', /delItem\('milestones', b\.dataset\.delCd/.test(app));
  ok('点 ✕ 不会连带触发卡片本身的点击（stopPropagation）',
    /data-del-cd[\s\S]{0,400}e\.stopPropagation\(\)/.test(app));
  ok('后端确实有删除接口（不是只有按钮）', /DELETE.*deleteMilestone/.test(study));
}

console.log('');
console.log(failures === 0 ? 'feedback-fixes.test: PASS' : `feedback-fixes.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
