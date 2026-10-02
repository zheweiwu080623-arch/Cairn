// 能力注册表测试（M1 · S2）：整张表的结构闸门 + 三条命名决定。
//
//   node tests/capabilities.test.mjs
//
// 这一份管"整张表"，每个能力自己的测试在 tests/capability-*.test.mjs 里。
// 三条决定（2026-09-25，用户没回，按设计稿默认走）在这里落成断言：
//   ① 点分命名；② course.* 合并成 scan / text / artifacts；③ 动作类（原"执行器"）也算能力。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITIES, CAPABILITY_KINDS, getCapability, listCapabilities, capabilityGroups,
  summarizeCapability, validateCapability,
} from '../lib/capabilities/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('capabilities.test.mjs');

// ---- ① 整张表 ----
// 2026-10-02：10 条（课程/去重/设置/投递/产物）→ 17 条。新增的 7 条是**通用原子**：
//   http.get / json.pick / text.template / text.split / text.extract / csv.parse / logic.each
// 目的：把"想接一个新数据源就得写代码"这件事压下去（拼图就能做，见「能力搭建」）。
// 2026-10-02 下午又加了两条：llm.ask（问模型，花 token）与 task.create（建任务）——
// 它们让"信息 → 理解 → 行动"这条链在图上能走完。
const GENERIC = ['http.get', 'json.pick', 'text.template', 'text.split', 'text.extract', 'csv.parse', 'logic.each', 'llm.ask', 'task.create'];
ok('登记了 19 条能力（10 条业务/动作 + 9 条通用）', CAPABILITIES.length === 19, String(CAPABILITIES.length));
ok('9 条通用能力都在，且都在「通用」组里',
  GENERIC.every((id) => getCapability(id) && getCapability(id).ui.group === '通用'),
  GENERIC.filter((id) => !getCapability(id)).join(', '));
const ids = CAPABILITIES.map((c) => c.id);
ok('id 不重复', new Set(ids).size === ids.length, ids.join(', '));
const bad = CAPABILITIES.map((c) => ({ id: c.id, r: validateCapability(c) })).filter((x) => !x.r.ok);
ok('每条都过 capability.v1 校验（含权限词表）', bad.length === 0,
  bad.map((x) => `${x.id}: ${x.r.errors.join('；')}`).join(' | '));
for (const c of CAPABILITIES) {
  ok(`  ${c.id}：entry 文件在`, existsSync(join(ROOT, c.entry || '')), c.entry);
  ok(`  ${c.id}：自己的单测在`, existsSync(join(ROOT, c.tests || '')), c.tests);
}
ok('每条都有 ui.label / ui.group（可视化搭建要按它分栏）',
  CAPABILITIES.every((c) => c.ui && c.ui.label && c.ui.group));
// 通用原子是"给拼图用的"，还没有哪个功能声明它 ⇒ 允许 used_by 为空，
// 但必须在 notes 里写清它是干什么的（不许有一条"没人知道它干嘛"的能力）。
ok('每条都写清了现在谁在用（通用原子要有 notes）',
  CAPABILITIES.every((c) => (Array.isArray(c.used_by) && c.used_by.length > 0)
    || ((c.ui && c.ui.group === '通用') && typeof c.notes === 'string' && c.notes.length > 0)));

// ---- ② 命名风格：点分「域.动作」 ----
ok('id 都是点分段（每段以字母开头，段内允许驼峰，如 course.text / dedupe.filterNew）',
  ids.every((id) => /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(id)), ids.join(', '));
ok('没有下划线风格（course_read）', !ids.some((id) => id.includes('_')), ids.filter((i) => i.includes('_')).join(', '));
ok('没有连字符风格（course-read）', !ids.some((id) => id.includes('-')), ids.filter((i) => i.includes('-')).join(', '));

// ---- ③ 粒度：course.* 由 6 条并成 3 条 ----
const LEGACY = ['course.materials.scan', 'course.materials.read', 'course.index', 'course.weekly', 'course.search', 'course.week'];
ok('细粒度的旧名不再单独登记', LEGACY.every((id) => !ids.includes(id)), LEGACY.filter((id) => ids.includes(id)).join(', '));
ok('合并成 course.scan / course.text / course.artifacts',
  ['course.scan', 'course.text', 'course.artifacts'].every((id) => ids.includes(id)));
ok('course.text 把"读成文字 + 搜索"放一起', !!getCapability('course.text')?.input?.properties?.q);

// ---- ④ 动作类（原"执行器"）也算能力 ----
ok('notify.app / push.phone / file.write 都是能力',
  ['notify.app', 'push.phone', 'file.write'].every((id) => ids.includes(id)));
ok('它们靠 kind 区分：文件类写本机、推手机是对外发送',
  getCapability('notify.app')?.kind === 'write' && getCapability('file.write')?.kind === 'write'
  && getCapability('push.phone')?.kind === 'outbound');
ok('没有再单列"执行器"这一层（没有 executor.* 的能力）', !ids.some((id) => id.startsWith('executor.')));
ok('非幂等的四条都被如实标出来（notify / push / logic.each / llm.ask）',
  CAPABILITIES.filter((c) => c.idempotent === false).map((c) => c.id).sort().join(',')
  === 'llm.ask,logic.each,notify.app,push.phone', CAPABILITIES.filter((c) => c.idempotent === false).map((c) => c.id).join(','));

// ---- ⑤ 查表接口 ----
ok('按 id 取得到', getCapability('course.text')?.name === '把课程材料读成文字并检索');
ok('取不存在的 id 返回 null（不抛）', getCapability('nope.nope') === null);
ok('按 kind 过滤：6 条只读（多了 http.get）', listCapabilities({ kind: 'read' }).length === 6, String(listCapabilities({ kind: 'read' }).length));
ok('按分组过滤：课程组 4 条', listCapabilities({ group: '课程' }).length === 4, String(listCapabilities({ group: '课程' }).length));
ok('按关键字搜（"课件"）能找到课程材料那两条以上', listCapabilities({ q: '课件' }).length >= 2, String(listCapabilities({ q: '课件' }).length));
ok('分组是 6 组（课程/通用/去重/产物/投递/设置）', capabilityGroups().length === 6, capabilityGroups().join(' / '));
ok('每种 kind 都是登记表认识的', CAPABILITIES.every((c) => CAPABILITY_KINDS.includes(c.kind)));
ok('一行摘要能生成', summarizeCapability(getCapability('course.text')).startsWith('course.text —— '), summarizeCapability(getCapability('course.text')));

// ---- ⑥ 接线（S4 起）：只许"照登记表装配"，不许回到手写注入 ----
// （S2 时这里写的是"主程序不许引用注册表"；S4 接线后改成下面这两条，
//   用意变了一个方向：**装配方式只许来自登记表**，手写的那两个对象不许再回来。）
const srv = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
ok('主程序用能力宿主装配（createCapabilityHost）', srv.includes('createCapabilityHost('));
ok('手写的 extraContext 合并已经删掉（不会再漂移）',
  !srv.includes('...preclass.extraContext(mod)') && !srv.includes('...course.extraContext(mod)'));
ok('主程序挂上了 /api/capabilities（S3）', srv.includes("'/api/capabilities'"));
// 2026-09-26 拆分后：注册表是**发现式**的 —— 它扫 lib/capabilities/impl/ 目录，
// 自己不再写任何一条能力（手写登记表已经删掉了；加能力 = 加一个文件）。
const regSrc = readFileSync(join(ROOT, 'lib', 'capabilities', 'index.mjs'), 'utf8');
ok('注册表靠"扫目录"发现能力（读 impl 目录）',
  regSrc.includes("IMPL_DIR") && regSrc.includes('readdirSync(IMPL_DIR)') && regSrc.includes('await discover()'));
ok('注册表里不再手写任何一条能力（没有 id: \'xxx\' 这种字面量）',
  !/id:\s*'[a-z]+\.[a-zA-Z]+'/.test(regSrc), (regSrc.match(/id:\s*'[^']+'/g) || []).join(' | '));
ok('每条能力的实现都单独成文件（impl/ 下 19 个）',
  readdirSync(join(ROOT, 'lib', 'capabilities', 'impl')).filter((f) => f.endsWith('.mjs')).length === 19);
ok('每个实现文件都导出 meta + bind + run',
  readdirSync(join(ROOT, 'lib', 'capabilities', 'impl')).filter((f) => f.endsWith('.mjs')).every((f) => {
    const t = readFileSync(join(ROOT, 'lib', 'capabilities', 'impl', f), 'utf8');
    return t.includes('export const meta') && t.includes('export const bind') && /export async function run/.test(t);
  }));

console.log('');
console.log(failures === 0 ? 'capabilities.test: PASS' : `capabilities.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
