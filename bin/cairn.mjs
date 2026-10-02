#!/usr/bin/env node
// cairn —— 命令行入口（D3）：管"再处理功能"（processor）的建、列、测、跑、打包、安装。
//
//   node bin/cairn.mjs mod list                      看有哪些模块（processor 会附权限清单）
//   node bin/cairn.mjs mod new demo-proc             生成一个功能骨架
//   node bin/cairn.mjs mod test demo-proc            校验 + 演练跑一次（零副作用）
//   node bin/cairn.mjs mod run demo-proc [--real]    跑一次（默认演练；--real 走服务端真跑）
//   node bin/cairn.mjs mod pack demo-proc            打包成 zip（可发给别人）
//   node bin/cairn.mjs mod install <zip|目录>         看权限清单 → 装进 modules/
//   node bin/cairn.mjs cap list                       看平台现在有哪些能力（M1 · S3）
//
// 三条设计约束：
//   1) **零依赖**：只用 Node 内置能力（zip 也是自己写的，见 lib/zip.mjs）；
//   2) **默认安全**：`mod run` 默认演练；`mod install` 默认先打印权限清单，加 `--yes` 才真的装；
//   3) **不隐藏动作**：每一步都把你该知道的事打出来（装了哪些文件、要了什么权限、跑出几条动作）。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanModules, validateModule } from '../lib/modules.mjs';
import { MANIFEST_NAME, buildManifest, verifyManifest } from '../lib/module-package.mjs';
import { describePrivacy, formatCapabilityUse, formatPermissions, summarizePermissions } from '../lib/permissions.mjs';
import { normalizeActions, summarizeActions } from '../lib/processor.mjs';
import { unzipSync, zipSync } from '../lib/zip.mjs';
import { COST_LABELS, listCapabilities } from '../lib/capabilities/index.mjs';
import { declaredCapabilities } from '../lib/capabilities/host.mjs';
import { summarizeFlow, validateFlow } from '../lib/flow.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_MODULES_DIR = join(REPO, 'modules');
const SERVER_URL = process.env.CAIRN_URL || 'http://127.0.0.1:3210';

// ---------------- 小工具 ----------------
const say = (s = '') => console.log(s);
const ok = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
// 2026-10-02：以前 `bad()` 只打印、**不改退出码** ⇒ 任何失败都以 0 退出，
// 脚本里 `cairn mod install ... && next` 会以为装成功了。现在失败一律退出码 1。
const bad = (s) => { console.log(`  ❌ ${s}`); process.exitCode = 1; };

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { args.flags[k] = argv[++i]; }
      else args.flags[k] = true;
    } else args._.push(a);
  }
  return args;
}

const modulesDirOf = (flags = {}) => (flags.dir ? resolve(String(flags.dir)) : DEFAULT_MODULES_DIR);

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function walkFiles(root, base = '') {
  const out = [];
  for (const name of readdirSync(join(root, base)).sort()) {
    const rel = base ? `${base}/${name}` : name;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) out.push(...walkFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

async function serverUp() {
  try {
    const res = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

/** 演练用的"内存 store"：跑功能时**完全不碰真数据库**。 */
function memoryStore() {
  const mem = new Map();
  return { getSync: (k) => (mem.has(k) ? mem.get(k) : null), setSync: (k, v) => mem.set(k, v) };
}

// ---------------- mod list ----------------
function cmdList(flags) {
  const dir = modulesDirOf(flags);
  const mods = scanModules(dir);
  say(`模块目录：${dir}`);
  if (!mods.length) return void say('  （一个模块都没有）');
  for (const m of mods) {
    if (m.error) { bad(`${m.id}：${m.error}`); continue; }
    const perm = summarizePermissions(m);
    ok(`${m.id}  [${m.kind}]  ${m.name || ''}${m.kind === 'processor' ? `  · ${perm.line}` : ''}`);
    if (flags.permissions && m.kind === 'processor') {
      say(formatPermissions(m).split('\n').map((l) => `     ${l}`).join('\n'));
      say(formatCapabilityUse(m, capsOfModule(m)).split('\n').map((l) => `     ${l}`).join('\n'));
    }
  }
  const broken = mods.filter((m) => m.error).length;
  say(`共 ${mods.length} 个模块${broken ? `，其中 ${broken} 个有问题` : ''}。`);
}

/** 模块声明的能力 → 登记表里的描述符（没登记的会变成 undefined，由 formatCapabilityUse 报出来）。 */
function capsOfModule(descriptor) {
  const { known } = declaredCapabilities(descriptor);
  return known.map((id) => listCapabilities().find((c) => c.id === id)).filter(Boolean);
}

// ---------------- cap list（M1 · S3） ----------------
function cmdCapList(flags) {
  const dir = modulesDirOf(flags);
  const declaredBy = {};
  for (const m of scanModules(dir)) {
    if (m.error) continue;
    for (const id of declaredCapabilities(m).known) (declaredBy[id] = declaredBy[id] || []).push(m.id);
  }
  const caps = listCapabilities({ group: flags.group, kind: flags.kind, q: flags.q });
  if (flags.json) return void say(JSON.stringify({ count: caps.length, capabilities: caps }, null, 2));
  for (const c of caps) {
    ok(`${c.id}  [${c.kind}]  ${c.name}`);
    const perms = c.permissions.length ? c.permissions.join(', ') : '无额外权限';
    say(`     ${perms} ｜ ${c.idempotent ? '可重放' : '⚠️ 不能重放'} ｜ ${COST_LABELS[c.cost] || c.cost}`);
    say(`     谁在用：${(c.used_by || []).join(', ') || '—'} ｜ 谁声明了：${(declaredBy[c.id] || []).join(', ') || '—'}`);
  }
  say(`共 ${caps.length} 条能力（按 ${flags.kind || '全部'} / ${flags.group || '全部分组'} 过滤后）。`);
}

// ---------------- mod new ----------------
function cmdNew(args) {
  const id = args._[0];
  if (!id) return bad('用法：cairn mod new <id> [--name 显示名] [--dir 模块目录]');
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return bad('id 只能是小写字母/数字/连字符，且以字母开头');
  const dir = modulesDirOf(args.flags);
  const target = join(dir, id);
  if (existsSync(target) && !args.flags.force) return bad(`已经存在：${target}（要覆盖加 --force）`);
  mkdirSync(target, { recursive: true });
  const name = String(args.flags.name || id);
  writeFileSync(join(target, 'module.json'), `${JSON.stringify({
    schema: 'module.v1', id, name, version: '0.1.0', kind: 'processor', icon: '🧩', order: 50,
    author: { name: '（你的名字）' }, license: 'MIT',
    entry: { run: 'run.js', readme: 'README.md' },
    data: { reads: ['signal'], writes: [], tables: [] },
    permissions: ['notify:app'], config: [],
    requires: { app: '>=1.0', agent: false },
  }, null, 2)}\n`, 'utf8');
  // 生成的 run.js 用**普通字符串拼接**写（不用模板字面量，免得二次转义踩坑）
  writeFileSync(join(target, 'run.js'), [
    '// ' + name + '（' + id + '）—— 一个再处理功能。约定：export function run(input, ctx) → actions[]',
    '//',
    '// input：一条 signal（或任何入口数据）；ctx：{ store, now, dryRun, log, module, ...注入的能力 }',
    '// 返回：action 数组（type 见 lib/processor.mjs）。**没有值得做的事就返回空数组** —— 安静是正确结果。',
    'export function run(input = {}, ctx = {}) {',
    '  const { dryRun = true, log } = ctx;',
    '  if (!input.title && !input.meta) {',
    "    if (log) log('没有需要处理的内容');",
    '    return [];',
    '  }',
    '  return [{',
    "    type: 'notify',",
    "    summary: (input.title || '一条新信息') + '（来自 ' + ((ctx.module && ctx.module.id) || '" + id + "') + '）',",
    "    idempotency_key: '" + id + ":' + (input.id || input.title || 'x'),",
    "    payload: { text: dryRun ? '（演练）' : '真跑时写你想要的正文' },",
    "    permissions: ['notify:app'],",
    '  }];',
    '}',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(target, 'README.md'), [
    `# ${name}（${id}）`,
    '',
    '`kind: processor`。约定导出 `run(input, ctx) → actions[]`：',
    '- 有值得做的事 → 返回 action（`notify` / `push` / `file` / `mail` / `task` …）；',
    '- 没有 → 返回空数组（**不要为了刷存在感硬造通知**）；',
    '- 默认演练：`POST /api/modules/' + id + '/run` 不带 `dry_run:false` 时不会产生副作用。',
    '',
    '自测：`node bin/cairn.mjs mod test ' + id + '`；跑一次：`node bin/cairn.mjs mod run ' + id + '`。',
    '',
  ].join('\n'), 'utf8');
  ok(`已生成功能骨架：${target}`);
  say('   下一步：改 run.js → `node bin/cairn.mjs mod test ' + id + '` → `mod run`');
}

// ---------------- mod test / run ----------------
async function loadModuleForRun(id, dir) {
  const mod = scanModules(dir).find((m) => m.id === id);
  if (!mod) return { error: `没有这个模块：${id}` };
  if (mod.error) return { error: `模块有问题：${mod.error}` };
  if (mod.kind !== 'processor') return { error: `模块 ${id} 不是 processor（kind=${mod.kind}）` };
  return { mod };
}

async function runInProcess(id, dir, input) {
  const { mod, error } = await loadModuleForRun(id, dir);
  if (error) return { ok: false, error };
  if (mod.entry.flow) {
    return { ok: false, error: `这是声明式功能（能力图 ${mod.entry.flow}）—— 图里的节点要读真数据，请用 cairn mod run ${id}（由服务端演练）` };
  }
  const impl = await import(new URL(`file://${join(mod.dir, mod.entry.run).replace(/\\/g, '/')}`).href);
  if (typeof impl.run !== 'function') return { ok: false, error: 'entry.run 没有导出 run()' };
  const raw = await impl.run(input, { store: memoryStore(), now: Date.now(), dryRun: true, log: () => {}, module: { id: mod.id, name: mod.name, dir: mod.dir } });
  const actions = normalizeActions(raw, { moduleId: mod.id, dryRun: true, now: Date.now() });
  return { ok: true, dry_run: true, actions, summary: summarizeActions(actions, { dryRun: true }) };
}

async function cmdTest(args) {
  const id = args._[0];
  if (!id) return bad('用法：cairn mod test <id> [--input <json>] [--dir 模块目录]');
  const dir = modulesDirOf(args.flags);
  const { mod, error } = await loadModuleForRun(id, dir);
  if (error) return bad(error);
  const { ok: valid, errors } = validateModule(mod);
  if (!valid) return bad(`描述符不合法：${errors.join('；')}`);
  ok(`描述符合法（kind=${mod.kind}，入口 ${mod.entry.run || `能力图 ${mod.entry.flow}`}）`);
  say(formatPermissions(mod));
  say(formatCapabilityUse(mod, capsOfModule(mod)));
  // 声明式功能（M2）：本地只校验那张图并把节点列出来 —— 真跑要服务端（节点要读真数据）
  if (mod.entry.flow) {
    let spec = null;
    try { spec = JSON.parse(readFileSync(join(mod.dir, mod.entry.flow), 'utf8')); }
    catch (e) { return bad(`读不出能力图：${(e && e.message) || e}`); }
    const v = validateFlow(spec);
    if (!v.ok) return bad(`能力图不合法：${v.errors.join('；')}`);
    ok(`能力图校验通过：${summarizeFlow(spec)}`);
    for (const n of spec.nodes) say(`     · ${n.id} → ${n.capability}`);
    warn('本地不跑图（节点要读真数据）——用 `cairn mod run ' + mod.id + '` 让服务端演练。');
    return;
  }
  const input = args.flags.input ? JSON.parse(String(args.flags.input)) : { title: '自测输入' };
  const r = await runInProcess(id, dir, input);
  if (!r.ok) return bad(`演练失败：${r.error}`);
  ok(`演练通过：${r.summary}`);
  for (const a of r.actions) say(`     · ${a.type} ${a.status} —— ${a.summary}`);
}

async function cmdRun(args) {
  const id = args._[0];
  if (!id) return bad('用法：cairn mod run <id> [--real] [--input <json>] [--dir 模块目录]');
  const dir = modulesDirOf(args.flags);
  const input = args.flags.input ? JSON.parse(String(args.flags.input)) : {};
  const real = !!args.flags.real;

  if (await serverUp()) {
    const res = await fetch(`${SERVER_URL}/api/modules/${id}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: !real, input }),
    });
    const r = await res.json();
    if (!r.ok) return bad(`服务端说：${r.error || '未知错误'}`);
    ok(`${real ? '真跑' : '演练'}完成（服务端）：${r.summary}`);
    for (const a of r.actions || []) say(`     · ${a.type} ${a.status} —— ${a.summary}`);
    if (!real) say('   提示：想真的执行加 --real（会进通知 / 推手机）。');
    return;
  }
  if (real) return bad(`服务没在跑（${SERVER_URL}）—— "真跑"必须由服务端执行（它才持有通知与推送通道）。`);
  warn('服务没在跑，退回到本地演练（零副作用）。');
  const r = await runInProcess(id, dir, input);
  if (!r.ok) return bad(`演练失败：${r.error}`);
  ok(`演练完成（本地）：${r.summary}`);
  for (const a of r.actions) say(`     · ${a.type} ${a.status} —— ${a.summary}`);
}

// ---------------- mod pack / install ----------------

function cmdPack(args) {
  const id = args._[0];
  if (!id) return bad('用法：cairn mod pack <id> [--out xxx.zip] [--dir 模块目录]');
  const dir = modulesDirOf(args.flags);
  const modDir = join(dir, id);
  if (!existsSync(modDir)) return bad(`没有这个模块目录：${modDir}`);
  const descriptor = readJsonFile(join(modDir, 'module.json'));
  if (!descriptor) return bad('module.json 缺失或不是合法 JSON');
  const { ok: valid, errors } = validateModule(descriptor);
  if (!valid) return bad(`描述符不合法，先修好再打包：${errors.join('；')}`);
  const files = walkFiles(modDir).filter((f) => !f.startsWith('.') && !f.includes('/.'));
  const manifest = buildManifest(modDir, descriptor, files, capsOfModule(descriptor));
  const zip = zipSync([
    ...files.map((f) => ({ name: f, data: readFileSync(join(modDir, f)) })),
    { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
  ]);
  const out = resolve(String(args.flags.out || join(process.cwd(), `${id}-${descriptor.version || '0.0.0'}.zip`)));
  writeFileSync(out, zip);
  ok(`已打包 ${files.length} 个文件 → ${out}（${(zip.length / 1024).toFixed(1)} KB）`);
  say(`包内清单：MANIFEST.json（${manifest.file_count} 个文件的 sha256 + 能力 + 权限）`);
  say(`它会碰什么：${manifest.privacy}`);
  say(formatPermissions(descriptor));
}

function readPackage(srcPath) {
  const st = statSync(srcPath);
  if (st.isDirectory()) {
    const files = walkFiles(srcPath);
    return { files: Object.fromEntries(files.map((f) => [f, readFileSync(join(srcPath, f))])), from: '目录' };
  }
  return { files: unzipSync(readFileSync(srcPath)), from: 'zip' };
}

function cmdInstall(args) {
  const src = args._[0];
  if (!src) return bad('用法：cairn mod install <zip|目录> [--dir 模块目录] [--yes]');
  const srcPath = resolve(src);
  if (!existsSync(srcPath)) return bad(`找不到：${srcPath}`);
  const dir = modulesDirOf(args.flags);

  const { files, from } = readPackage(srcPath);
  const names = Object.keys(files);
  if (!names.length) return bad('包里没有文件（或者压缩方式不支持）');
  // module.json 可能在根，也可能在一层子目录里
  let prefix = '';
  if (!files['module.json']) {
    const guess = names.find((n) => n.endsWith('/module.json'));
    if (!guess) return bad('包里找不到 module.json —— 不像一个 Cairn 模块');
    prefix = guess.slice(0, -'module.json'.length);
  }
  const descriptor = JSON.parse(files[`${prefix}module.json`].toString('utf8'));
  const { ok: valid, errors } = validateModule(descriptor);
  say(`来源：${from} ${srcPath}`);
  say(`模块：${descriptor.id} · ${descriptor.name || ''} · ${descriptor.kind} · v${descriptor.version}`);
  // 一句话讲清"它会读你什么、会不会写"（2026-10-02 · 台阶 B）——装之前最想知道的是这个
  say(`它会碰什么：${describePrivacy(descriptor, capsOfModule(descriptor))}`);
  // 包内清单（台阶 E）：有就逐文件核对校验和 —— 装的东西和作者打的东西必须是同一份
  let manifestChecked = null;
  const manifestRaw = files[`${prefix}${MANIFEST_NAME}`];
  if (manifestRaw) {
    let manifest = null;
    try { manifest = JSON.parse(manifestRaw.toString('utf8')); } catch { manifest = null; }
    if (!manifest || !Array.isArray(manifest.files)) {
      warn('包里有 MANIFEST.json 但读不出来 —— 跳过校验（老包格式？）');
    } else {
      const v = verifyManifest(manifest, files, prefix);
      manifestChecked = v;
      if (v.ok) ok(`包内清单核对通过：${v.checked} 个文件逐一比对 sha256`);
      else {
        warn(`包内清单**对不上**：内容变过的 ${v.bad.length} 个${v.bad.length ? `（${v.bad.slice(0, 3).join('、')}）` : ''}`
          + `，缺文件 ${v.missing.length} 个${v.missing.length ? `（${v.missing.slice(0, 3).join('、')}）` : ''}`);
      }
    }
  } else {
    say('这个包没有 MANIFEST.json（老包）—— 装之前只有权限清单可看，没有逐文件校验和。');
  }
  say(formatPermissions(descriptor));
  say(formatCapabilityUse(descriptor, capsOfModule(descriptor)));
  if (!valid) return bad(`描述符不合法，拒绝安装：${errors.join('；')}`);
  if (manifestChecked && !manifestChecked.ok && !args.flags.force) {
    return bad('包内清单对不上（文件被改过或压坏了）—— 拒绝安装；确认没问题再加 --force');
  }
  const needEntry = descriptor.entry && (descriptor.entry.run || descriptor.entry.flow);
  if (descriptor.kind === 'processor' && (!needEntry || !files[`${prefix}${needEntry}`])) {
    return bad(`包里缺少入口文件 ${needEntry || '（描述符里既没有 entry.run 也没有 entry.flow）'} —— 拒绝安装`);
  }
  const target = join(dir, descriptor.id);
  if (existsSync(target) && !args.flags.force) return bad(`目标已存在：${target}（要覆盖加 --force）`);
  if (!args.flags.yes) {
    warn('这是预览（没有装）。确认无误后加 --yes 真的安装。');
    return;
  }
  mkdirSync(target, { recursive: true });
  let n = 0;
  for (const [name, buf] of Object.entries(files)) {
    if (!name.startsWith(prefix) || name.endsWith('/')) continue;
    const rel = name.slice(prefix.length);
    if (!rel || rel.includes('..')) continue;                  // 防目录穿越
    const full = join(target, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buf);
    n++;
  }
  ok(`已安装到 ${target}（${n} 个文件）`);
  say('   试一下：node bin/cairn.mjs mod test ' + descriptor.id);
}

// ---------------- 入口 ----------------
function usage() {
  say('cairn —— 模块（尤其是"再处理功能"）的命令行工具');
  say('');
  say('  cairn mod list   [--dir 模块目录] [--permissions]   看有哪些模块');
  say('  cairn mod new    <id> [--name 显示名]               生成一个功能骨架');
  say('  cairn mod test   <id> [--input JSON]                校验 + 演练（零副作用）');
  say('  cairn mod run    <id> [--real] [--input JSON]       跑一次（默认演练）');
  say('  cairn mod pack   <id> [--out x.zip]                 打包（可发给别人）');
  say('  cairn mod install <zip|目录> [--yes] [--force]       看权限清单 → 安装');
  say('  cairn cap list   [--group 分组] [--kind read] [--json]  看平台有哪些能力');
  say('');
  say(`  默认模块目录：${DEFAULT_MODULES_DIR}`);
  say(`  服务地址：${SERVER_URL}（可用环境变量 CAIRN_URL 改）`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return usage();
  if (argv[0] === 'cap') {
    const sub = argv[1];
    const capArgs = parseArgs(argv.slice(2));
    if (!sub || sub === '--help' || sub === 'list') return cmdCapList(capArgs.flags);
    bad(`不认识的子命令：cap ${sub}`);
    return usage();
  }
  if (argv[0] !== 'mod') {
    bad(`不认识的命令：${argv[0]}`);
    return usage();
  }
  const sub = argv[1];
  const args = parseArgs(argv.slice(2));
  if (!sub || sub === '--help') return usage();
  if (sub === 'list') return cmdList(args.flags);
  if (sub === 'new') return cmdNew(args);
  if (sub === 'test') return cmdTest(args);
  if (sub === 'run') return cmdRun(args);
  if (sub === 'pack') return cmdPack(args);
  if (sub === 'install') return cmdInstall(args);
  bad(`不认识的子命令：mod ${sub}`);
  usage();
}

main().catch((e) => { bad(e && e.message ? e.message : String(e)); process.exitCode = 1; });
