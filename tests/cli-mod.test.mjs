// `cairn mod` 命令行的验证（D3）：建 / 列 / 测 / 跑 / 打包 / 安装 + 权限清单 + zip 读写。
//
//   node tests/cli-mod.test.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { crc32, normalizeEntryName, unzipSync, zipSync } from '../lib/zip.mjs';
import { describePermission, formatPermissions, summarizePermissions } from '../lib/permissions.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('cli-mod.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'cairn.mjs');
const tmp = mkdtempSync(join(process.env.PLANNER_TEST_TMP || tmpdir(), 'cli-mod-'));
const modsDir = join(tmp, 'mods');

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });

// ---------------- 1. zip 读写（自己写的，得先证明它是对的） ----------------
{
  const files = [
    { name: 'module.json', data: '{"a":1}' },
    { name: 'run.js', data: 'export function run(){ return []; }\n' },
    { name: 'sub/README.md', data: '# 标题\n中文也要对\n' },
    { name: 'big.txt', data: 'x'.repeat(5000) },        // 够大，走 deflate 分支
  ];
  const zip = zipSync(files);
  const back = unzipSync(zip);
  ok('打包再解开：四个文件都在', Object.keys(back).length === 4, Object.keys(back).join(','));
  ok('内容逐字节相同', files.every((f) => back[f.name] && back[f.name].toString('utf8') === f.data));
  ok('中文与换行都对', back['sub/README.md'].toString('utf8').includes('中文也要对'));
  ok('压缩真的生效（大文件变小）', zip.length < 5000, String(zip.length));
  ok('路径分隔符统一成 /', normalizeEntryName('a\\b\\c.txt') === 'a/b/c.txt');
  ok('crc32 对得上（标准向量）', crc32(Buffer.from('123456789')) === 0xCBF43926);
  ok('空包也能来回', Object.keys(unzipSync(zipSync([]))).length === 0);
  ok('坏数据不崩（返回空对象）', Object.keys(unzipSync(Buffer.from('not a zip at all'))).length === 0);
  // 可复现构建：同样内容打两次，字节一致（时间戳固定）
  ok('同样内容打两次字节一致（可复现）', zipSync(files).equals(zipSync(files)));
}

// ---------------- 2. 权限清单说人话 ----------------
{
  ok('认识的能力翻成人话', describePermission('net:canvas').label.includes('课程平台'));
  ok('不认识的如实说"未登记"', describePermission('wat:ever').label.includes('未登记'));
  const s = summarizePermissions({ kind: 'processor', permissions: ['notify:app', 'net:canvas'], data: { reads: ['signal'], writes: ['notifications'] } });
  ok('汇总数出"需要留意"的条数', s.permissions.length === 2 && s.risky === 1, JSON.stringify(s));
  ok('多行清单里有能力/读/写', /notify:app/.test(formatPermissions({ permissions: ['notify:app'], data: { reads: ['signal'], writes: ['notifications'] } })));
  ok('没有声明能力时也说得清楚', /没有声明任何特殊能力/.test(summarizePermissions({}).line));
}

// ---------------- 3. mod new / list / test ----------------
{
  const made = cli('mod', 'new', 'demo-proc', '--name', '演示功能', '--dir', modsDir);
  ok('mod new 生成三个文件',
    made.status === 0
    && ['module.json', 'run.js', 'README.md'].every((f) => existsSync(join(modsDir, 'demo-proc', f))), made.stdout);
  const desc = JSON.parse(readFileSync(join(modsDir, 'demo-proc', 'module.json'), 'utf8'));
  ok('生成的是 processor 且声明了 entry.run', desc.kind === 'processor' && desc.entry.run === 'run.js');
  ok('生成的 run.js 是合法 JS（能被 import 并跑）', (() => {
    // Windows 上必须用 file:// URL 才能动态 import（直接给 C:/… 会被当成协议 c:）
    const url = pathToFileURL(join(modsDir, 'demo-proc', 'run.js')).href;
    const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then(m=>console.log(typeof m.run))`], { encoding: 'utf8' });
    return r.stdout.trim() === 'function';
  })());

  const listed = cli('mod', 'list', '--dir', modsDir);
  ok('mod list 列出模块并标出 processor', /demo-proc/.test(listed.stdout) && /processor/.test(listed.stdout), listed.stdout);
  const listPerm = cli('mod', 'list', '--dir', modsDir, '--permissions');
  ok('加 --permissions 会打印权限清单', /权限清单/.test(listPerm.stdout) && /notify:app/.test(listPerm.stdout));

  const tested = cli('mod', 'test', 'demo-proc', '--dir', modsDir);
  ok('mod test 校验 + 演练通过', tested.status === 0 && /演练通过/.test(tested.stdout), tested.stdout + tested.stderr);
  ok('演练结果标成 planned（没有副作用）', /planned/.test(tested.stdout));
  const badId = cli('mod', 'test', 'no-such-module', '--dir', modsDir);
  ok('不存在的模块会明确报错', /没有这个模块/.test(badId.stdout));
}

// ---------------- 4. mod pack / install ----------------
{
  const zipPath = join(tmp, 'demo-proc.zip');
  const packed = cli('mod', 'pack', 'demo-proc', '--dir', modsDir, '--out', zipPath);
  ok('mod pack 生成 zip', packed.status === 0 && existsSync(zipPath), packed.stdout);
  ok('打包时也打印权限清单', /权限清单/.test(packed.stdout));
  const entries = Object.keys(unzipSync(readFileSync(zipPath)));
  ok('zip 里是模块的三个文件', entries.length === 3 && entries.includes('module.json') && entries.includes('run.js'), entries.join(','));

  const target = join(tmp, 'installed');
  const preview = cli('mod', 'install', zipPath, '--dir', target);
  ok('install 默认只预览（不装）', /预览/.test(preview.stdout) && !existsSync(join(target, 'demo-proc')));
  ok('预览里能看到权限清单与模块信息', /权限清单/.test(preview.stdout) && /demo-proc/.test(preview.stdout));

  const installed = cli('mod', 'install', zipPath, '--dir', target, '--yes');
  ok('加 --yes 真的装上（三个文件）',
    installed.status === 0 && ['module.json', 'run.js', 'README.md'].every((f) => existsSync(join(target, 'demo-proc', f))), installed.stdout);
  const again = cli('mod', 'install', zipPath, '--dir', target, '--yes');
  ok('重复安装会拒绝（除非 --force）', /已存在/.test(again.stdout));
  const listed = cli('mod', 'list', '--dir', target);
  ok('装上的模块能被列出', /demo-proc/.test(listed.stdout));
}

// ---------------- 5. mod run（服务在跑就走服务端；否则本地演练） ----------------
{
  const r = cli('mod', 'run', 'hello-processor', '--input', '{"title":"CLI 验收"}');
  ok('mod run 默认演练', /演练/.test(r.stdout), r.stdout + r.stderr);
  ok('演练结果不会真执行（打印 planned 或"没有动作"）', /planned|没有产生动作|0 条动作/.test(r.stdout));
  // 注意：这里**故意不跑 --real** —— 测试不该往用户的通知表里写东西。
  // "真跑"这条路径用源码守卫 + 不存在的模块来验（下面两条）。
  const missing = cli('mod', 'run', 'no-such-module', '--input', '{}');
  ok('跑不存在的模块会明确报错（不会静默）', /没有这个模块|服务端说/.test(missing.stdout), missing.stdout + missing.stderr);
  const cliSrc = readFileSync(CLI, 'utf8');
  ok('"--real 必须由服务端执行"这条规矩写在代码里',
    /--real.*必须由服务端执行|必须由服务端执行/.test(cliSrc) && /dry_run: !real/.test(cliSrc));
}

// ---------------- 6. 接线与文档 ----------------
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  ok('package.json 暴露了 cairn 命令', pkg.bin && pkg.bin.cairn === 'bin/cairn.mjs');
  ok('npm run cli 也能用', pkg.scripts && pkg.scripts.cli === 'node bin/cairn.mjs');
  const doc = readFileSync(join(ROOT, 'docs', 'WRITING_A_PROCESSOR.md'), 'utf8');
  ok('《怎么写一个再处理功能》在位且讲了关键点',
    doc.includes('export function run(input, ctx)') && doc.includes('dry_run') && doc.includes('权限清单'));
  ok('文档里没有出现删除类动词式的危险建议', !/\brm -rf\b/.test(doc));
  const help = cli('--help');
  ok('--help 列出全部子命令',
    ['mod list', 'mod new', 'mod test', 'mod run', 'mod pack', 'mod install'].every((c) => help.stdout.includes(c)));
}

console.log('');
console.log(failures === 0 ? 'cli-mod.test: PASS' : `cli-mod.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
