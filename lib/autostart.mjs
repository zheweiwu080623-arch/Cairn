// autostart.mjs —— 开机自启 + 存活看护（跨平台，2026-09-27 从 server.mjs 搬出来并补上 macOS）。
//
//   Windows：在「启动」文件夹放一个快捷方式（指向托盘脚本或桌面外壳）—— 原样搬过来，行为不变；
//   macOS  ：写一个 LaunchAgent（~/Library/LaunchAgents/com.cairn.planner.plist）——
//            RunAtLoad 管开机自启，KeepAlive 管"挂了就拉起"，正好等价于 Windows 那边的托盘看门狗；
//   其它   ：如实返回 supported:false（不假装做了）。
//
// 纪律：所有"外部动作"都通过可注入的 runner / exists 走，纯函数部分（plist 内容、快捷方式脚本）
// 可以离线测；改动前先把状态读出来，改完再读一次核对 —— **不谎报成功**。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Windows：启动文件夹里的快捷方式名（旧中文名也要认，升级后不误判）。 */
export const AUTOSTART_LNK = 'CodexPlanner.lnk';
export const AUTOSTART_LNK_LEGACY = ['Codex Planner 后台.lnk', 'Codex Planner 计划.lnk'];

/** macOS：LaunchAgent 的 label 与文件名。 */
export const MAC_AGENT_LABEL = 'com.cairn.planner';
export const MAC_AGENT_FILE = 'com.cairn.planner.plist';

/**
 * macOS 路径一律用 '/' 拼（**不要用 path.join**：在 Windows 上模拟 macOS 时会拼成反斜杠，
 * 写进 plist 就废了）。生产环境跑在 macOS 上时两者结果一样，但这样更不容易出错。
 */
const macJoin = (...parts) => parts
  .filter((p) => p !== undefined && p !== null && String(p) !== '')
  .map((p) => String(p).replace(/\/+$/, ''))
  .join('/');

export function autostartAllPaths({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') {
    const base = env.APPDATA || join(env.USERPROFILE || home, 'AppData', 'Roaming');
    const dir = join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return [join(dir, AUTOSTART_LNK), ...AUTOSTART_LNK_LEGACY.map((n) => join(dir, n))];
  }
  if (platform === 'darwin') return [macAgentPath({ env, home })];
  return [];
}

export function macAgentPath({ env = process.env, home = homedir() } = {}) {
  return macJoin(env.HOME || home, 'Library/LaunchAgents', MAC_AGENT_FILE);
}

/**
 * LaunchAgent 的 plist 内容（纯函数，方便测）。
 * KeepAlive=true：进程退出就拉起来（崩了自动重启，等价于 Windows 托盘的看门狗）。
 */
export function macAgentPlist({ repoDir, nodePath, port = 3210, logPath = '' } = {}) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const args = [String(nodePath || 'node'), macJoin(repoDir, 'server.mjs')];
  const out = logPath || (repoDir ? macJoin(repoDir, 'data/launchd.log') : '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(MAC_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(repoDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${esc(String(port))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${out ? `  <key>StandardOutPath</key>\n  <string>${esc(out)}</string>\n  <key>StandardErrorPath</key>\n  <string>${esc(out)}</string>\n` : ''}</dict>
</plist>
`;
}

/**
 * Windows 建快捷方式用的 C# 互操作代码：走 **IShellLinkW + IPersistFile**（Unicode 版）。
 *
 * 为什么不用 `WScript.Shell.CreateShortcut()`：它走 **ANSI 代码页**。本机 ACP=1252，
 * 于是路径 / 参数 / 备注里的中文全被写成 '????'；更糟的是如果「启动」文件夹本身
 * 在一个含中文的路径下（用户名是中文的机器就是这样），它连 .lnk 都存不下来。
 * 2026-09-28 实测：IShellLinkW 在中文路径下目标 / 参数 / 工作目录 / 图标都能原样读回，
 * 双击也真的会执行（`work/try_com_lnk.py`）。
 */
const WINDOWS_LINK_CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  '',
  '[ComImport, Guid("00021401-0000-0000-C000-000000000046")]',
  'public class ShellLinkCoClass { }',
  '',
  '[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'public interface IShellLinkW',
  '{',
  '    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);',
  '    void GetIDList(out IntPtr ppidl);',
  '    void SetIDList(IntPtr pidl);',
  '    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);',
  '    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);',
  '    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);',
  '    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);',
  '    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);',
  '    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);',
  '    void GetHotkey(out short pwHotkey);',
  '    void SetHotkey(short wHotkey);',
  '    void GetShowCmd(out int piShowCmd);',
  '    void SetShowCmd(int iShowCmd);',
  '    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);',
  '    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);',
  '    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);',
  '    void Resolve(IntPtr hwnd, uint dwFlags);',
  '    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);',
  '}',
  '',
  '[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
  'public interface IPersistFile',
  '{',
  '    void GetClassID(out Guid pClassID);',
  '    [PreserveSig] int IsDirty();',
  '    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);',
  '    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);',
  '    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);',
  '    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);',
  '}',
  '',
  'public static class CairnShortcut',
  '{',
  '    public static void Create(string lnk, string target, string args, string workdir, string icon, string desc, int show)',
  '    {',
  '        var link = (IShellLinkW)new ShellLinkCoClass();',
  '        link.SetPath(target);',
  '        if (!string.IsNullOrEmpty(args)) link.SetArguments(args);',
  '        if (!string.IsNullOrEmpty(workdir)) link.SetWorkingDirectory(workdir);',
  '        if (!string.IsNullOrEmpty(desc)) link.SetDescription(desc);',
  '        if (!string.IsNullOrEmpty(icon)) link.SetIconLocation(icon, 0);',
  '        link.SetShowCmd(show);',
  '        ((IPersistFile)link).Save(lnk, true);',
  '    }',
  '}',
].join('\n');

/** Windows：给"建/删快捷方式"的 PowerShell 脚本。 */
export function windowsShortcutScript({ enabled, lnk, allLnks = [], shellExe = '', repoDir = '', vbsPath = '', iconPath = '' }) {
  const esc = (s) => String(s).replace(/'/g, "''");
  if (!enabled) {
    const removals = allLnks
      .map((p) => `  if (Test-Path -LiteralPath '${esc(p)}') { Remove-Item -LiteralPath '${esc(p)}' -Force }`)
      .join('\n');
    return [
      "$ProgressPreference = 'SilentlyContinue'",
      "$ErrorActionPreference = 'Stop'",
      'try {',
      removals,
      "  Write-Output 'ok'",
      "} catch { Write-Output ('ERR ' + $_.Exception.Message); exit 1 }",
    ].join('\n');
  }
  const useShell = Boolean(shellExe) && existsSync(shellExe) && process.env.PLANNER_AUTOSTART_SHELL === '1';
  const target = useShell ? shellExe : join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe');
  const args = useShell ? '' : `"${vbsPath}"`;
  const cleanups = allLnks
    .filter((p) => p !== lnk)
    .map((p) => `  if (Test-Path -LiteralPath '${esc(p)}') { Remove-Item -LiteralPath '${esc(p)}' -Force }`)
    .join('\n');
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    'try {',
    cleanups,
    "$CairnLinkCode = @'",
    WINDOWS_LINK_CSHARP,
    "'@",
    '  Add-Type -TypeDefinition $CairnLinkCode -Language CSharp | Out-Null',
    `  [CairnShortcut]::Create('${esc(lnk)}', '${esc(target)}', '${esc(args)}', '${esc(useShell ? dirname(shellExe) : repoDir)}', '${esc(iconPath)}', '${esc('Cairn 后台常驻（开机自动运行）')}', 7)`,
    `  if (Test-Path -LiteralPath '${esc(lnk)}') { Write-Output 'ok' } else { Write-Output 'ERR 快捷方式未生成'; exit 1 }`,
    "} catch { Write-Output ('ERR ' + $_.Exception.Message); exit 1 }",
  ].join('\n');
}

function runHiddenPowerShell(script, { timeout = 20000, exec = execFile } = {}) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    try {
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
        { timeout, windowsHide: true }, (err, stdout, stderr) => {
          resolve({ ok: !err, out: String(stdout || '').trim(), err: err ? String(stderr || err.message).trim() : '' });
        });
    } catch (e) { resolve({ ok: false, out: '', err: e.message }); }
  });
}

/** 现在的自启状态（读，不改）。 */
export function getAutostartState({ platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (platform === 'win32') {
    const [lnk, ...legacy] = autostartAllPaths({ platform, env, home });
    const found = legacy.find((p) => exists(p));
    return { supported: true, enabled: exists(lnk) || Boolean(found), path: exists(lnk) ? lnk : (found || lnk), how: 'shortcut' };
  }
  if (platform === 'darwin') {
    const path = macAgentPath({ env, home });
    return { supported: true, enabled: exists(path), path, how: 'launchagent', label: MAC_AGENT_LABEL };
  }
  return { supported: false, enabled: false, path: null, how: null };
}

/**
 * 开 / 关自启。返回**改完之后重新读出来的状态** + ok/error（不谎报）。
 * @param {{enabled:boolean, platform?:string, repoDir?:string, nodePath?:string, port?:number, logPath?:string,
 *          env?:object, home?:string, exists?:Function, log?:Function, exec?:Function, run?:Function,
 *          mkdir?:Function, writeFile?:Function, removeFile?:Function}} opts
 */
export async function setAutostart({
  enabled, platform = process.platform, repoDir = '', nodePath = process.execPath, port = 3210, logPath = '',
  env = process.env, home = homedir(), exists = existsSync,
  mkdir = (d) => mkdirSync(d, { recursive: true }),
  writeFile = (p, c) => writeFileSync(p, c, 'utf8'),
  removeFile = (p) => rmSync(p, { force: true }),
  log = () => {}, exec = execFile, run = null,
} = {}) {
  const shell = { platform, env, home, exists };
  if (platform === 'win32') {
    const lnk = autostartAllPaths(shell)[0];
    const script = windowsShortcutScript({
      enabled, lnk, allLnks: autostartAllPaths(shell), repoDir,
      shellExe: join(repoDir, 'shell', 'dist', 'PlannerShell.exe'),
      vbsPath: join(repoDir, 'start-tray.vbs'), iconPath: join(repoDir, 'app.ico'),
    });
    const r = await runHiddenPowerShell(script, { exec });
    const state = getAutostartState(shell);
    const ok = r.ok && state.enabled === Boolean(enabled);
    let reason = '';
    if (r.out && r.out.startsWith('ERR')) reason = r.out.slice(3).trim();
    else if (r.err && !r.err.startsWith('#<')) reason = r.err.trim();
    if (!reason) reason = enabled ? '无法写入 Windows「启动」文件夹（可能被安全软件或权限拦截）' : '无法删除「启动」文件夹里的快捷方式';
    if (ok) log(`[autostart] 已${enabled ? '开启' : '关闭'}开机自启 -> ${lnk}`);
    else log(`[autostart] 设置失败（目标 ${enabled ? '开启' : '关闭'}）：${reason}`);
    return { ...state, ok, error: ok ? null : reason };
  }

  if (platform === 'darwin') {
    const path = macAgentPath(shell);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const runCmd = run || ((args) => new Promise((resolve) => {
      try {
        exec('launchctl', args, { timeout: 15000 }, (err, stdout, stderr) => resolve({
          ok: !err, out: String(stdout || '').trim(), err: err ? String(stderr || err.message).trim() : '',
        }));
      } catch (e) { resolve({ ok: false, out: '', err: e.message }); }
    }));
    let ok = false; let reason = '';
    if (enabled) {
      try {
        mkdir(dirname(path));
        writeFile(path, macAgentPlist({ repoDir, nodePath, port, logPath }));
      } catch (e) { return { ...getAutostartState(shell), ok: false, error: `写 LaunchAgent 失败：${e.message}` }; }
      // bootstrap 是 macOS 10.10+ 的正路；失败就退回老的 load -w（两条都试，如实报错）
      const r = await runCmd(['bootstrap', `gui/${uid}`, path]);
      if (!r.ok) {
        const r2 = await runCmd(['load', '-w', path]);
        if (!r2.ok) reason = (r2.err || r.err || 'launchctl 没能加载这个 agent').trim();
      }
      const state = getAutostartState(shell);
      ok = state.enabled && !reason;
      if (ok) log(`[autostart] 已开启（LaunchAgent）-> ${path}`);
      else if (!reason) reason = 'LaunchAgent 写好了，但 launchctl 没确认加载';
    } else {
      await runCmd(['bootout', `gui/${uid}/${MAC_AGENT_LABEL}`]);
      await runCmd(['unload', '-w', path]);
      try { if (exists(path)) removeFile(path); } catch (e) { reason = `删 LaunchAgent 失败：${e.message}`; }
      const state = getAutostartState(shell);
      ok = !state.enabled && !reason;
      if (ok) log('[autostart] 已关闭（去掉 LaunchAgent）');
    }
    if (!reason) reason = enabled ? '无法让 launchd 加载这个 agent' : '无法删除 LaunchAgent 文件';
    return { ...getAutostartState(shell), ok, error: ok ? null : reason };
  }

  return { ...getAutostartState(shell), ok: false, error: '这个平台暂时不支持开机自启（Windows 用快捷方式、macOS 用 LaunchAgent）' };
}

/** 给 server.mjs 用的绑定版：把"这台机器 / 这个仓库"的默认值固定下来，调用处只剩两行。 */
export function createAutostart({ repoDir = '', port = 3210, logPath = '', log = () => {} } = {}) {
  return {
    getAutostartState: (opts = {}) => getAutostartState(opts),
    setAutostart: (enabled, opts = {}) => setAutostart({
      enabled, repoDir, port, logPath, log, ...opts,
    }),
  };
}
