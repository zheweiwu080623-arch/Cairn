// 跨平台适配（2026-09-27，A/B 两组）：打开链接、打开文件夹、选择文件夹、开机自启。
//
//   node tests/cross-platform.test.mjs
//
// 这台机器是 Windows，跑不了 macOS 的真机；所以这里测的是**每个平台各自会调什么命令 / 写出什么文件**，
// 以及"打不开时如实返回失败"（以前 Windows 专属的写法在 macOS 上会谎报成功）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserExeCandidates, openExternalUrl, openPath } from '../lib/server-shell.mjs';
import { macPickerArgs, pickFolder } from '../lib/pick-folder.mjs';
import {
  MAC_AGENT_LABEL, getAutostartState, macAgentPath, macAgentPlist, setAutostart, windowsShortcutScript,
} from '../lib/autostart.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

/** 假的子进程：要么立刻报 'spawn'（成功），要么报 'error'（打不开）。 */
function fakeSpawn({ fail = null } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const handlers = {};
    const child = {
      once(ev, cb) { handlers[ev] = cb; return child; },
      unref() {},
    };
    setTimeout(() => {
      if (fail) handlers.error && handlers.error(new Error(fail));
      else handlers.spawn && handlers.spawn();
    }, 0);
    return child;
  };
  fn.calls = calls;
  return fn;
}

console.log('cross-platform.test.mjs');

// ---------- 打开外部链接 ----------
{
  ok('候选浏览器：Windows 有 Edge/Chrome、macOS 有 Edge/Chrome 的 .app 路径、Linux 交给 PATH',
    browserExeCandidates('win32').some((p) => p.includes('msedge.exe'))
    && browserExeCandidates('darwin').some((p) => p.includes('/Applications/Microsoft Edge.app/'))
    && browserExeCandidates('linux').length === 0);

  const macSpawn = fakeSpawn();
  const mac = await openExternalUrl({ url: 'https://example.com', platform: 'darwin', exists: () => false, spawnFn: macSpawn });
  ok('macOS：没有 Edge/Chrome 时用 `open <url>`', mac.ok && macSpawn.calls[0].cmd === 'open'
    && macSpawn.calls[0].args[0] === 'https://example.com', JSON.stringify(macSpawn.calls[0]));

  const macEdge = fakeSpawn();
  const mac2 = await openExternalUrl({
    url: 'https://example.com', platform: 'darwin',
    exists: (p) => p.includes('Microsoft Edge.app'), spawnFn: macEdge,
  });
  ok('macOS：装了 Edge 就复用 Edge', mac2.ok && mac2.via === 'browser' && macEdge.calls[0].cmd.includes('Edge'), String(macEdge.calls[0].cmd));

  const winSpawn = fakeSpawn();
  const win = await openExternalUrl({ url: 'https://example.com', platform: 'win32', exists: () => false, spawnFn: winSpawn });
  ok('Windows：没有 Edge/Chrome 才退回 rundll32（行为与以前一致）',
    win.ok && winSpawn.calls[0].cmd === 'rundll32.exe' && winSpawn.calls[0].args[0] === 'url.dll,FileProtocolHandler');

  const linuxSpawn = fakeSpawn();
  const lin = await openExternalUrl({ url: 'https://example.com', platform: 'linux', spawnFn: linuxSpawn });
  ok('Linux：xdg-open（以前这里也会去调 Windows 的路径）', lin.ok && linuxSpawn.calls[0].cmd === 'xdg-open');

  const bad = await openExternalUrl({ url: 'javascript:alert(1)', platform: 'darwin', spawnFn: fakeSpawn() });
  ok('非 http(s) 链接直接拒绝', bad.ok === false && /http/.test(bad.error));

  const fail = await openExternalUrl({ url: 'https://example.com', platform: 'darwin', exists: () => false, spawnFn: fakeSpawn({ fail: 'spawn open ENOENT' }) });
  ok('打不开就如实 ok:false（不再谎报）', fail.ok === false && /ENOENT/.test(fail.error));
}

// ---------- 打开文件夹 ----------
{
  const cases = [['win32', 'explorer'], ['darwin', 'open'], ['linux', 'xdg-open']];
  for (const [platform, cmd] of cases) {
    const sp = fakeSpawn();
    const r = await openPath('/tmp/某目录', { platform, spawnFn: sp });
    ok(`${platform}：用 ${cmd} 打开文件夹`, r.ok && sp.calls[0].cmd === cmd && sp.calls[0].args[0] === '/tmp/某目录');
  }
  const weird = await openPath('/tmp/x', { platform: 'aix', spawnFn: fakeSpawn() });
  ok('不认识的平台：如实说"不支持"，不假装打开', weird.ok === false && /不支持/.test(weird.error));
  const empty = await openPath('  ', { platform: 'win32', spawnFn: fakeSpawn() });
  ok('空路径直接拒绝', empty.ok === false);
  const missing = await openPath('/tmp/x', { platform: 'darwin', spawnFn: fakeSpawn({ fail: 'spawn open ENOENT' }) });
  ok('命令不存在 → ok:false（界面才有机会提示路径）', missing.ok === false && /ENOENT/.test(missing.error));
}

// ---------- 选择文件夹（macOS 走 osascript） ----------
{
  const args = macPickerArgs({ title: '选择课件目录', initial: '/Users/x/Docs' });
  ok('macOS 用 osascript 的 Finder 选择框', args[0] === '-e' && /choose folder/.test(args[1])
    && /POSIX path/.test(args[1]) && /default location/.test(args[1]), args[1]);
  ok('标题里的引号会被转义（不会把 AppleScript 搞坏）',
    macPickerArgs({ title: '带"引号"的标题' })[1].includes('\\"'));

  const runnerOf = (out, err) => {
    const calls = [];
    const fn = (cmd, a, opts, cb) => { calls.push({ cmd, a }); setTimeout(() => cb(out === null ? Object.assign(new Error(err || 'fail'), { message: err || 'fail' }) : null, out || '', err || ''), 0); };
    fn.calls = calls;
    return fn;
  };
  const r1 = runnerOf('/Users/x/选中的目录/\n', '');
  const picked = await pickFolder({ platform: 'darwin', runner: r1 });
  ok('macOS：拿到路径（去掉结尾斜杠）', picked.ok && picked.dir === '/Users/x/选中的目录' && r1.calls[0].cmd === 'osascript');

  const r2 = runnerOf(null, 'execution error: User canceled. (-128)');
  const cancelled = await pickFolder({ platform: 'darwin', runner: r2 });
  ok('macOS：用户取消 → cancelled（不是失败）', cancelled.ok === true && cancelled.cancelled === true && cancelled.dir === null);

  const r3 = runnerOf(null, 'osascript: command not found');
  const broken = await pickFolder({ platform: 'darwin', runner: r3 });
  ok('macOS：真出问题就如实失败并给退路', broken.ok === false && /手动粘贴路径/.test(broken.error));

  const r4 = runnerOf('C:\\Users\\x\\Docs\n', '');
  const winPick = await pickFolder({ platform: 'win32', runner: r4 });
  ok('Windows 行为没变（还是 powershell + WinForms 选择框）', winPick.ok && winPick.dir === 'C:\\Users\\x\\Docs' && r4.calls[0].cmd === 'powershell.exe');

  const r5 = runnerOf('x', '');
  const linPick = await pickFolder({ platform: 'linux', runner: r5 });
  ok('Linux：如实说不提供（提示手动粘贴）', linPick.ok === false && /手动粘贴/.test(linPick.error));
}

// ---------- 开机自启：macOS LaunchAgent ----------
{
  const plist = macAgentPlist({ repoDir: '/Users/x/Cairn', nodePath: '/usr/local/bin/node', port: 3210, logPath: '/Users/x/Library/Logs/cairn.log' });
  ok('LaunchAgent 内容齐全（Label / 参数 / 工作目录 / 端口 / RunAtLoad / KeepAlive / 日志）',
    plist.includes(`<string>${MAC_AGENT_LABEL}</string>`) && plist.includes('<string>/usr/local/bin/node</string>')
    && plist.includes('<string>/Users/x/Cairn/server.mjs</string>') && plist.includes('<key>RunAtLoad</key>')
    && plist.includes('<key>KeepAlive</key>') && plist.includes('<key>WorkingDirectory</key>')
    && plist.includes('<string>3210</string>') && plist.includes('cairn.log'), plist.slice(0, 120));
  ok('plist 里的 XML 特殊字符会转义', macAgentPlist({ repoDir: '/a&b', nodePath: 'node' }).includes('/a&amp;b'));

  const st0 = getAutostartState({ platform: 'darwin', env: { HOME: '/Users/x' }, exists: () => false });
  ok('macOS 状态：支持、未开启、路径在 ~/Library/LaunchAgents',
    st0.supported === true && st0.enabled === false && st0.path === macAgentPath({ env: { HOME: '/Users/x' } })
    && st0.how === 'launchagent');
  const st1 = getAutostartState({ platform: 'linux', exists: () => false });
  ok('Linux：如实说"不支持"（而不是给个点了没反应的按钮）', st1.supported === false && st1.enabled === false);

  // 开启：写 plist + launchctl bootstrap
  const writes = []; const runs = [];
  let onDisk = false;
  const r = await setAutostart({
    enabled: true, platform: 'darwin', repoDir: '/Users/x/Cairn', nodePath: '/usr/local/bin/node',
    env: { HOME: '/Users/x' }, logPath: '/Users/x/cairn.log', log: () => {},
    exists: () => onDisk,
    mkdir: () => {}, writeFile: (p, c) => { writes.push({ p, c }); onDisk = true; }, removeFile: () => { onDisk = false; },
    run: async (args) => { runs.push(args); return { ok: true, out: '', err: '' }; },
  });
  ok('macOS 开自启：plist 写在 LaunchAgents 里，并用 launchctl 加载',
    r.ok === true && r.enabled === true && writes.length === 1
    && writes[0].p === '/Users/x/Library/LaunchAgents/com.cairn.planner.plist'
    && runs.some((a) => a[0] === 'bootstrap'), JSON.stringify({ writes: writes.map((w) => w.p), runs }));

  // 关闭：bootout + 删文件
  const r2 = await setAutostart({
    enabled: false, platform: 'darwin', env: { HOME: '/Users/x' }, log: () => {},
    exists: () => onDisk, mkdir: () => {}, writeFile: () => {}, removeFile: () => { onDisk = false; },
    run: async (args) => { runs.push(args); return { ok: true, out: '', err: '' }; },
  });
  ok('macOS 关自启：bootout + 删掉 plist，状态读到"未开启"', r2.ok === true && r2.enabled === false
    && runs.some((a) => a[0] === 'bootout'));

  // launchctl 失败要如实报
  const r3 = await setAutostart({
    enabled: true, platform: 'darwin', repoDir: '/x', env: { HOME: '/Users/x' }, log: () => {},
    exists: () => false, mkdir: () => {}, writeFile: () => {}, removeFile: () => {},
    run: async () => ({ ok: false, out: '', err: 'launchctl: Bootstrap failed' }),
  });
  ok('launchctl 加载失败 → ok:false 且带原因（不谎报成功）', r3.ok === false && /Bootstrap failed/.test(r3.error), String(r3.error));

  // 不支持的平台
  const r4 = await setAutostart({ enabled: true, platform: 'linux', exists: () => false, run: async () => ({ ok: true }) });
  ok('Linux 开自启 → 明确"不支持"', r4.ok === false && r4.supported === false && /不支持/.test(r4.error));

  // Windows 的脚本内容（行为与搬走之前一致）
  const wscript = windowsShortcutScript({
    enabled: true, lnk: 'C:\\Startup\\CodexPlanner.lnk', allLnks: ['C:\\Startup\\CodexPlanner.lnk'],
    repoDir: 'C:\\app', vbsPath: 'C:\\app\\start-tray.vbs', iconPath: 'C:\\app\\app.ico',
  });
  // 2026-09-28：原来用 WScript.Shell.CreateShortcut()，它走 **ANSI 代码页** ——
  // 路径/参数/备注里的中文会被写成 '????'，路径本身含中文时连 .lnk 都存不下来。
  // 现在改用 Unicode 版 IShellLinkW（Add-Type 内嵌 C#），并明确不许再退回 WScript.Shell。
  ok('Windows 脚本用 Unicode 版 IShellLinkW 建快捷方式（不再走 ANSI 的 WScript.Shell）',
    wscript.includes('IShellLinkW') && wscript.includes('CairnShortcut')
    && wscript.includes('CodexPlanner.lnk') && wscript.includes('start-tray.vbs')
    && !wscript.includes('WScript.Shell'));
    ok('Windows 关闭时是删快捷方式', windowsShortcutScript({ enabled: false, lnk: 'x', allLnks: ['x'] }).includes('Remove-Item'));

    // 2026-09-28：这行原来用双引号而不是反引号，`${esc(lnk)}` 没被替换、原样写进 PowerShell，
    // 于是它去 Test-Path 一个真的叫 ${esc(lnk)} 的路径 → 永远失败 → 应用永远报「设置失败」，
    // 哪怕快捷方式已经建好了（假红）。凡是生成的脚本都不许留下没替换的模板占位符。
    const unresolved = (s) => /\$\{[A-Za-z_]/.test(s);
    ok('Windows 开启脚本里没有漏替换的 ${…} 占位符',
      !unresolved(wscript) && wscript.includes("Test-Path -LiteralPath 'C:\\Startup\\CodexPlanner.lnk'"));
    ok('Windows 关闭脚本里也没有漏替换的 ${…} 占位符',
      !unresolved(windowsShortcutScript({ enabled: false, lnk: 'x', allLnks: ['x'] })));
}

// ---------- 源码闸门（别回退成写死 Windows） ----------
{
  const mobile = read('lib/routes/mobile.mjs');
  ok('open-folder 不再写死 explorer.exe，改成跨平台 openPath',
    !mobile.includes("execFile('explorer.exe'") && mobile.includes('openPath(dir)')
    && mobile.includes('ok: !!r.ok'));
  const srv = read('server.mjs');
  ok('/api/open 改走跨平台的 openExternalUrl，server.mjs 里不再有 Windows 盘符',
    srv.includes('await openExternalUrl({ url: target })') && !srv.includes('C:\\\\Program Files'));
  ok('自启逻辑已搬到 lib/autostart.mjs（server 只是接线）',
    srv.includes('createAutostart(') && !srv.includes('AUTOSTART_LNK ='));
  const panel = read('modules/settings/panel.js');
  ok('设置页认 supported：不支持的平台显示"暂不支持"、且不再弹假的绿字',
    panel.includes('autostartSupported') && panel.includes('这个平台暂不支持')
    && panel.includes("if (r.supported === false) toast('这个平台暂不支持开机自启', 'red')"));
  const pick = read('lib/pick-folder.mjs');
  ok('macOS 的 osascript 选择框在（且取消被当成取消）',
    pick.includes('export function macPickerArgs') && pick.includes("platform === 'darwin'")
    && pick.includes('User canceled'));
}

console.log('');
console.log(failures === 0 ? 'cross-platform.test: PASS' : `cross-platform.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
