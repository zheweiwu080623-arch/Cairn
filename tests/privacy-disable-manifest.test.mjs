// 台阶 B / D / E 的验证（2026-10-02）。
//
//   node tests/privacy-disable-manifest.test.mjs
//
//   B「知情同意」：装/启用之前用**一句人话**说清它会读什么、会不会写（而不是甩一串 fs:write:data）；
//   D「本机停用」：坏能力或暂时不想看见的能力能一键关掉 —— 不进素材栏、不进工具表、
//     调用**明确报"已停用"**（不是静默不跑）；
//   E「包内清单」：`mod pack` 往包里塞 MANIFEST.json（逐文件 sha256 + 能力 + 权限 + 那句人话），
//     `mod install` 逐文件核对，对不上就拒绝。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { CAPABILITIES, getCapability } from '../lib/capabilities/index.mjs';
import { createCapabilityHost } from '../lib/capabilities/host.mjs';
import { DISABLED_FILE, readDisabled, scanUserCapabilities, setDisabled } from '../lib/capabilities/user.mjs';
import { buildManifest, sha256, verifyManifest } from '../lib/module-package.mjs';
import { describePrivacy } from '../lib/permissions.mjs';
import { createCapabilityRoutes } from '../lib/routes/capabilities.mjs';
import { unzipSync, zipSync } from '../lib/zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};
const tmp = (p = 'x-') => mkdtempSync(join(tmpdir(), p));

console.log('privacy-disable-manifest.test.mjs');

// ---------- ① B：一句人话 ----------
{
  const notify = getCapability('notify.app');
  ok('自动生成的那句话把权限翻译成了人话（不是 fs:xxx 代号）',
    describePrivacy({ permissions: ['notify:app'], data: { reads: ['signal'] } }, [notify])
      === '这个功能会：要发本机通知；读 signal。',
    describePrivacy({ permissions: ['notify:app'], data: { reads: ['signal'] } }, [notify]));
  ok('权限也可以从它声明的能力里推（module.json 没写 permissions 时）',
    describePrivacy({ requires: { capabilities: ['notify.app'] } }, [notify]).includes('发本机通知'));
  ok('什么都不碰的：如实说"纯本地计算"', describePrivacy({}).includes('纯本地计算'));
  ok('写了 privacy 就以人写的为准（更准）',
    describePrivacy({ privacy: '只读你的课表，不外发。', permissions: ['notify:app'] }).startsWith('只读你的课表'));
  ok('会写的时候必须说出来', describePrivacy({ permissions: ['fs:write:data'], data: { writes: ['tasks'] } }).includes('写 tasks'));

  const routes = readFileSync(join(ROOT, 'lib', 'routes', 'modules.mjs'), 'utf8');
  ok('/api/modules 每条都带 privacy（界面据此显示）',
    routes.includes('privacy: describePrivacy(m, caps)'));
  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('主程序把 privacy 透传给设置页', app.includes('privacy: m.privacy ||'));
  const panel = readFileSync(join(ROOT, 'modules', 'settings', 'panel.js'), 'utf8');
  ok('设置 → 功能页把它显示出来（带 🧾）', panel.includes('m.privacy') && panel.includes('🧾'));
  const cli = readFileSync(join(ROOT, 'bin', 'cairn.mjs'), 'utf8');
  ok('安装预览里也打印这句话', cli.includes('它会碰什么：${describePrivacy('));
}

// ---------- ② D：本机停用 ----------
{
  const data = tmp('cairn-off-');
  mkdirSync(join(data, 'capabilities'), { recursive: true });
  ok('默认没有停用任何东西', readDisabled(data).join() === '');
  const ids = setDisabled(data, ['notify.app', 'notify.app', '  ', 'course.text']);
  ok('写进去会去重去空', ids.join() === 'notify.app,course.text', ids.join());
  ok('清单文件叫 _disabled.json（不是一条能力）', existsSync(join(data, 'capabilities', DISABLED_FILE)));
  ok('扫描自写能力时**跳过**这个清单文件', (await scanUserCapabilities(data)).length === 0);
  ok('启用（写空清单）也走得通', setDisabled(data, []).length === 0);

  const off = tmp('cairn-off2-');
  mkdirSync(join(off, 'capabilities'), { recursive: true });
  setDisabled(off, ['notify.app']);
  const host = createCapabilityHost({ providers: { dataDir: off } });
  const r = await host.invoke('notify.app', { title: '不该发出去' });
  ok('停用后：调用被宿主明确拒绝（不是静默返回空）',
    r.ok === false && String(r.error).includes('已被停用') && String(r.error).includes('重新启用'), JSON.stringify(r));
  const alive = await host.invoke('json.pick', { data: { a: 1 }, path: 'a' });
  ok('没停用的能力照常能跑', alive.ok === true && alive.output.value === 1);
}

// ---------- ② 续：接口层 ----------
{
  const data = tmp('cairn-off3-');
  mkdirSync(join(data, 'capabilities'), { recursive: true });
  const res = {};
  let payload = {};
  const routes = createCapabilityRoutes({
    sendJson: (_r, code, body) => { res.code = code; res.body = body; },
    sendError: (_r, code, msg) => { res.code = code; res.body = { error: msg }; },
    readBody: async () => payload,
    dataDir: data,
    capabilities: createCapabilityHost({ providers: { dataDir: data } }),
  });
  const url = (p) => ({ pathname: p, searchParams: new URLSearchParams('') });

  await routes.handleCapabilities({ method: 'GET' }, res, url('/api/capabilities/disabled'));
  ok('GET 停用清单：一开始是空的', res.code === 200 && res.body.disabled_capabilities.length === 0);
  payload = { id: 'notify.app', disabled: true };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/disabled'));
  ok('POST 停用一条：回显状态', res.code === 200 && res.body.disabled === true);

  await routes.handleCapabilities({ method: 'GET' }, res, url('/api/capabilities'));
  const offCap = (res.body.capabilities || []).find((c) => c.id === 'notify.app');
  const onCap = (res.body.capabilities || []).find((c) => c.id === 'json.pick');
  ok('能力清单里标出停用状态（界面要能显示）', offCap.disabled === true && onCap.disabled === false);

  await routes.handleCapabilities({ method: 'GET' }, res, url('/api/capabilities/model-tools'));
  ok('停用的能力**不进工具表**（不给模型看见）',
    !(res.body.tools || []).some((t) => t.name === 'notify.app')
    && res.body.count === CAPABILITIES.length - 2, String(res.body.count));

  payload = { id: 'notify.app', input: { title: 'x' } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('直接调停用的能力：403 且说清怎么恢复',
    res.code === 403 && String(res.body.error).includes('已被停用'), JSON.stringify(res.body));

  payload = { id: 'notify.app', disabled: false };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/disabled'));
  ok('再启用：回到可用', res.body.disabled === false && readDisabled(data).length === 0);
  payload = { id: 'notify.app', input: { title: 'x' } };
  await routes.handleCapabilities({ method: 'POST' }, res, url('/api/capabilities/invoke'));
  ok('启用后又能拿到计划了（写类依然只给计划）',
    res.code === 200 && res.body.requires_confirmation === true);

  const fb = readFileSync(join(ROOT, 'modules', 'flow-builder', 'builder.js'), 'utf8');
  ok('界面上有停用/启用按钮，且停用的不出现在素材栏',
    fb.includes('data-fb-toggle') && fb.includes("filter((c) => !c.disabled)") && fb.includes('已停用'));
}

// ---------- ③ E：包内清单 ----------
{
  const dir = tmp('cairn-pkg-');
  const modDir = join(dir, 'demo-pkg');
  mkdirSync(modDir, { recursive: true });
  const descriptor = {
    schema: 'module.v1', id: 'demo-pkg', name: '示例包', version: '0.1.0', kind: 'processor',
    entry: { run: 'run.js' }, permissions: ['notify:app'], data: { reads: ['signal'], writes: [] },
    requires: { capabilities: ['notify.app'] },
  };
  writeFileSync(join(modDir, 'module.json'), JSON.stringify(descriptor, null, 2), 'utf8');
  writeFileSync(join(modDir, 'run.js'), 'export function run() { return []; }\n', 'utf8');
  const files = ['module.json', 'run.js'];
  const manifest = buildManifest(modDir, descriptor, files, [getCapability('notify.app')], () => '2026-10-02T00:00:00.000Z');
  ok('清单里带 id/版本/能力/权限/那句人话',
    manifest.id === 'demo-pkg' && manifest.version === '0.1.0'
    && manifest.capabilities.join() === 'notify.app' && manifest.permissions.join() === 'notify:app'
    && manifest.privacy.includes('发本机通知'), JSON.stringify(manifest).slice(0, 200));
  ok('每个文件都有 sha256 与字节数',
    manifest.files.length === 2 && manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0));
  const asFiles = Object.fromEntries(files.map((f) => [f, readFileSync(join(modDir, f))]));
  ok('核对通过', verifyManifest(manifest, asFiles).ok === true);
  const tampered = { ...asFiles, 'run.js': Buffer.from('export function run() { return [1]; }\n') };
  const v = verifyManifest(manifest, tampered);
  ok('文件被改过：核对不过，并指出是哪个文件',
    v.ok === false && v.bad.join() === 'run.js', JSON.stringify(v));
  const missing = { 'module.json': asFiles['module.json'] };
  ok('缺文件也报出来', verifyManifest(manifest, missing).missing.join() === 'run.js');
  ok('sha256 函数与清单一致', sha256(Buffer.from('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  // 真的走一遍 CLI：pack → install（拒绝重复）→ 篡改后 install 被拒
  const out1 = join(dir, 'demo-pkg.zip');
  const pack = spawnSync(process.execPath, [join(ROOT, 'bin', 'cairn.mjs'), 'mod', 'pack', 'demo-pkg', '--dir', dir, '--out', out1], { encoding: 'utf8' });
  ok('mod pack：打出来的包里有 MANIFEST.json',
    pack.status === 0 && !!unzipSync(readFileSync(out1))['MANIFEST.json']);
  const target = join(dir, 'installed');
  mkdirSync(target, { recursive: true });
  const inst = spawnSync(process.execPath, [join(ROOT, 'bin', 'cairn.mjs'), 'mod', 'install', out1, '--dir', target], { encoding: 'utf8' });
  ok('mod install：预览里逐文件核对通过',
    /包内清单核对通过：2 个文件/.test(inst.stdout || ''), inst.stdout);
  ok('mod install：没加 --yes 不会真装（先给清单）', !existsSync(join(target, 'demo-pkg')));

  // 篡改包里的 run.js → 清单对不上 → 拒绝
  const inner = unzipSync(readFileSync(out1));
  const badZip = zipSync(Object.entries(inner).map(([name, data]) => ({
    name, data: name === 'run.js' ? Buffer.from('export function run() { return [2]; }\n') : data,
  })));
  const badPath = join(dir, 'tampered.zip');
  writeFileSync(badPath, badZip);
  const bad = spawnSync(process.execPath, [join(ROOT, 'bin', 'cairn.mjs'), 'mod', 'install', badPath, '--dir', target, '--yes'], { encoding: 'utf8' });
  ok('被改过的包：**拒绝安装**（不是只警告一句）',
    bad.status !== 0 && /对不上/.test(bad.stdout || '') && /拒绝安装/.test(bad.stdout || ''), bad.stdout);
  const forced = spawnSync(process.execPath, [join(ROOT, 'bin', 'cairn.mjs'), 'mod', 'install', badPath, '--dir', target, '--yes', '--force'], { encoding: 'utf8' });
  ok('显式 --force 才允许装（人的决定优先，但要留下痕迹）',
    forced.status === 0 && existsSync(join(target, 'demo-pkg', 'run.js')), forced.stdout);
  // 换一个干净的目标目录（不然会先撞上"目标已存在"）
  const target2 = join(dir, 'installed2');
  mkdirSync(target2, { recursive: true });
  // modDir 是**没有清单**的老包样子（真正的目录源，里面只有 module.json + run.js）
  const old = spawnSync(process.execPath, [join(ROOT, 'bin', 'cairn.mjs'), 'mod', 'install', modDir, '--dir', target2], { encoding: 'utf8' });
  ok('老包（没有清单）照装，但如实说"没有逐文件校验和"',
    /没有 MANIFEST.json/.test(old.stdout || ''), old.stdout);
  ok('CLI 失败时退出码非 0（以前 bad() 只打印不改退出码，脚本会误判成功）',
    spawnSync(process.execPath, [join(ROOT, 'bin', 'cairn.mjs'), 'mod', 'install', badPath, '--dir', target2, '--yes'], { encoding: 'utf8' }).status === 1);
}

console.log('');
console.log(failures === 0 ? 'privacy-disable-manifest.test: PASS' : `privacy-disable-manifest.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
