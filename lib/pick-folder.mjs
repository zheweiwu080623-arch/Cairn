// pick-folder.mjs —— 「选一个本机文件夹」的系统选择框（Windows）。
//
// 为什么需要它：壁纸目录、课程资料目录这类路径**每个人的机器都不一样**，
// 让用户手写路径（甚至去改 JSON）是不合理的。网页本身拿不到真实绝对路径
// （浏览器的文件夹选择只给相对路径），所以只能让服务端弹一个系统选择框。
//
// 做法：用 Windows 自带的 WinForms `FolderBrowserDialog`，通过 powershell.exe 调起。
//   1) 脚本走 `-EncodedCommand`（UTF-16LE + base64）—— 中文标题/初始目录不会被命令行编码搞坏；
//   2) 脚本只输出**选中路径**一行，取消就什么都不输出；
//   3) 非 Windows、或本机 powershell 被策略限制（受限语言模式）→ **如实返回失败**，
//      调用方要给出"那就手动粘贴路径"的退路，绝不假装成功。
//
// 一条刻意的边界：**这里只选路径名，不读目录内容、不改任何文件**。
//
// 2026-09-28：同一个模块也负责"选一个**文件**"（`pickFile`）—— pdftotext / pdftoppm
// 这类外部工具是可执行文件，让用户手打完整路径不合理。两条路共用 pickSystemDialog，
// 只是 WinForms 那边从 FolderBrowserDialog 换成 OpenFileDialog。

import { execFile } from 'node:child_process';

/** PowerShell 单引号字符串里的转义：单引号写成两个。 */
function psQuote(s) {
  return `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;
}

/**
 * 拼出"弹一个文件夹选择框并把结果打到标准输出"的 PowerShell 脚本。
 * 纯函数，方便测试（不用真的弹窗）。
 */
export function buildPickerScript({ title = '选择文件夹', initial = '' } = {}) {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',   // 中文路径要能原样传回
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dlg.Description = ${psQuote(title || '选择文件夹')}`,
    '$dlg.ShowNewFolderButton = $true',
    `$ini = ${psQuote(initial || '')}`,
    'if ($ini -ne "") { $dlg.SelectedPath = $ini }',
    // 需要一个"拥有者窗体"才能让对话框浮在最前面（服务端是后台进程，不这样的话容易藏在别的窗口后面）
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = "Minimized"',
    '$r = $null',
    'try { $r = $dlg.ShowDialog($owner) } finally { $owner.Dispose() }',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
  ].join('\n');
}

/** 脚本 → `-EncodedCommand` 需要的形式（UTF-16LE + base64）。 */
export function encodePowerShell(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

/** 反向解出来（测试用；也方便排查"到底发给 powershell 的是什么"）。 */
export function decodePowerShell(encoded) {
  return Buffer.from(String(encoded || ''), 'base64').toString('utf16le');
}

/**
 * 拼出"弹一个**文件**选择框"的脚本（2026-09-28 新增）。
 *
 * 为什么需要它：pdftotext / pdftoppm 这类**外部工具**是"一个可执行文件"，
 * 不是目录 —— 让用户手打 `...\poppler\Library\bin\pdftotext.exe` 是不合理的。
 * 和选目录同一个套路：WinForms 的 OpenFileDialog、UTF-16 编码、只返回路径。
 *
 * @param {{title?:string, initial?:string, filter?:string}} opts
 *   `filter` 是 WinForms 的 Filter 串（如 `可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*`），留空 = 所有文件。
 */
export function buildFilePickerScript({ title = '选择文件', initial = '', filter = '' } = {}) {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',   // 中文路径要能原样传回
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    `$dlg.Title = ${psQuote(title || '选择文件')}`,
    '$dlg.CheckFileExists = $true',
    '$dlg.CheckPathExists = $true',
    '$dlg.Multiselect = $false',
    `$ini = ${psQuote(initial || '')}`,
    'if ($ini -ne "") { $dlg.InitialDirectory = $ini }',
    ...(filter ? [`$dlg.Filter = ${psQuote(filter)}`] : []),
    // 和选目录一样：需要一个"拥有者窗体"，否则对话框会藏在别的窗口后面
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = "Minimized"',
    '$r = $null',
    'try { $r = $dlg.ShowDialog($owner) } finally { $owner.Dispose() }',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }',
  ].join('\n');
}

/**
 * macOS 的选择框：用 osascript 调 Finder 的 `choose folder`（2026-09-27 补）。
 * 取消时 osascript 会以非 0 退出（错误里带 "User canceled"）—— 那种情况算"取消"，不是失败。
 */
export function macPickerArgs({ title = '选择文件夹', initial = '' } = {}) {
  const q = (s) => `"${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const prompt = q(String(title || '选择文件夹'));
  const loc = String(initial || '').trim();
  // 指定默认位置（POSIX path）时多给一句 default location
  const script = loc
    ? `set p to choose folder with prompt ${prompt} default location POSIX file ${q(loc)}\nreturn POSIX path of p`
    : `set p to choose folder with prompt ${prompt}\nreturn POSIX path of p`;
  return ['-e', script];
}

/** macOS 的**文件**选择框：osascript 调 Finder 的 `choose file`（与选目录同一套路）。 */
export function macFilePickerArgs({ title = '选择文件', initial = '' } = {}) {
  const q = (s) => `"${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const prompt = q(String(title || '选择文件'));
  const start = String(initial || '').trim();
  // choose file 的默认位置要求给一个**文件**（不是目录），所以只有初始值本身就是文件时才带上
  const script = (start && !start.endsWith('/'))
    ? `set p to choose file with prompt ${prompt} default location POSIX file ${q(start)}\nreturn POSIX path of p`
    : `set p to choose file with prompt ${prompt}\nreturn POSIX path of p`;
  return ['-e', script];
}

/**
 * 弹系统选择框（**选目录与选文件共用这一套**）。
 * 取消 → `{ok:true, cancelled:true}`（选目录时还带 `dir:null`）；出问题 → `{ok:false, error}`。
 *
 * @param {{mode?:'folder'|'file', title?:string, initial?:string, filter?:string,
 *          platform?:string, timeoutMs?:number,
 *          runner?:Function, env?:object}} opts
 */
export function pickSystemDialog({
  mode = 'folder', title = '', initial = '', filter = '', platform = process.platform,
  timeoutMs = 300000, runner = execFile, env = process.env,
} = {}) {
  const isFile = mode === 'file';
  const title2 = String(title || '').trim() || (isFile ? '选择文件' : '选择文件夹');
  return new Promise((resolve) => {
    // macOS：osascript（Finder 的原生选择框）
    if (platform === 'darwin') {
      let done2 = false;
      const finish = (v) => { if (!done2) { done2 = true; resolve(v); } };
      try {
        const args = isFile
          ? macFilePickerArgs({ title: title2, initial })
          : macPickerArgs({ title: title2, initial });
        runner('osascript', args,
          { timeout: timeoutMs, env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            const out = String(stdout || '').trim();
            if (out && isFile) { finish({ ok: true, file: out }); return; }
            if (out) { finish({ ok: true, dir: out.replace(/\/$/, '') || '/' }); return; }
            const msg = String((stderr || '') + (err && err.message ? ` ${err.message}` : '')).trim();
            if (/User canceled|-128/i.test(msg)) { finish(isFile ? { ok: true, file: null, cancelled: true } : { ok: true, dir: null, cancelled: true }); return; }
            finish({ ok: false, error: `选择框没能打开：${msg || '未知原因'}（可以手动粘贴路径）` });
          });
      } catch (e) {
        finish({ ok: false, error: `选择框没能打开：${(e && e.message) || e}（可以手动粘贴路径）` });
      }
      return;
    }
    if (platform !== 'win32') {
      resolve({ ok: false, error: '系统选择框目前只在 Windows 与 macOS 上提供；请手动粘贴路径。' });
      return;
    }
    const script = isFile
      ? buildFilePickerScript({ title: title2, initial, filter })
      : buildPickerScript({ title: title2, initial });
    const args = ['-NoProfile', '-STA', '-EncodedCommand', encodePowerShell(script)];
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      runner('powershell.exe', args, { timeout: timeoutMs, windowsHide: true, env, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) {
          done({ ok: false, error: `选择框没能打开：${err.message}（可以手动粘贴路径）` });
          return;
        }
        const out = String(stdout || '').trim();
        if (!out) { done(isFile ? { ok: true, file: null, cancelled: true } : { ok: true, dir: null, cancelled: true }); return; }
        done(isFile ? { ok: true, file: out } : { ok: true, dir: out });
      });
    } catch (e) {
      done({ ok: false, error: `选择框没能打开：${(e && e.message) || e}（可以手动粘贴路径）` });
    }
  });
}

/** 弹"选一个文件夹"。（名字与返回值保持原样：界面上早就按 `dir` 在用了。） */
export function pickFolder(opts = {}) {
  return pickSystemDialog({ ...opts, mode: 'folder' });
}

/** 弹"选一个文件"（给 pdftotext / pdftoppm 这类外部工具用）。返回 `{ok, file}`。 */
export function pickFile(opts = {}) {
  return pickSystemDialog({ ...opts, mode: 'file' });
}
