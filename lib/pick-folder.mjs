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
// 一条刻意的边界：**这里只选目录、只读路径名，不读目录内容、不改任何文件**。

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

/**
 * 弹系统选择框。取消 → `{ok:true, dir:null, cancelled:true}`；出问题 → `{ok:false, error}`。
 *
 * @param {{title?:string, initial?:string, platform?:string, timeoutMs?:number,
 *          runner?:Function, env?:object}} opts
 */
export function pickFolder({
  title = '选择文件夹', initial = '', platform = process.platform,
  timeoutMs = 300000, runner = execFile, env = process.env,
} = {}) {
  return new Promise((resolve) => {
    // macOS：osascript（Finder 的原生选择框）
    if (platform === 'darwin') {
      let done2 = false;
      const finish = (v) => { if (!done2) { done2 = true; resolve(v); } };
      try {
        runner('osascript', macPickerArgs({ title, initial }),
          { timeout: timeoutMs, env, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            const out = String(stdout || '').trim();
            if (out) { finish({ ok: true, dir: out.replace(/\/$/, '') || '/' }); return; }
            const msg = String((stderr || '') + (err && err.message ? ` ${err.message}` : '')).trim();
            if (/User canceled|-128/i.test(msg)) { finish({ ok: true, dir: null, cancelled: true }); return; }
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
    const args = ['-NoProfile', '-STA', '-EncodedCommand', encodePowerShell(buildPickerScript({ title, initial }))];
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      runner('powershell.exe', args, { timeout: timeoutMs, windowsHide: true, env, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) {
          done({ ok: false, error: `选择框没能打开：${err.message}（可以手动粘贴路径）` });
          return;
        }
        const dir = String(stdout || '').trim();
        if (!dir) { done({ ok: true, dir: null, cancelled: true }); return; }
        done({ ok: true, dir });
      });
    } catch (e) {
      done({ ok: false, error: `选择框没能打开：${(e && e.message) || e}（可以手动粘贴路径）` });
    }
  });
}
