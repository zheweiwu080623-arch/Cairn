// 办公本（讯飞 X5 / iFlytek AiNote）联动：检测设备、读书架、把 PDF 拷进去。
//
// 设备是 MTP 设备，没有盘符，只能用 Windows 外壳（Shell.Application）操作；
// 这里的脚本一律用 -EncodedCommand（UTF-16LE）传进 PowerShell，
// 避免中文路径 / 中文容器名在不同 PowerShell 版本下的编码问题。
import { execFile } from 'node:child_process';

export const WORKBOOK_DEFAULT = {
  device_pattern: '*AiNote*',
  container: '书架',
  copy_timeout_ms: 600000,
};

// PowerShell 里用单引号字符串，内部单引号翻倍转义。
const psQuote = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const psB64 = (s) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(s), 'utf8').toString('base64')}'))`;

function runPowerShell(script, { timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
        { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          const out = String(stdout || '');
          const marker = out.lastIndexOf('#JSON#');
          if (marker >= 0) {
            const line = out.slice(marker + 6).split(/\r?\n/)[0];
            try { return resolve(JSON.parse(line)); } catch (e) { return resolve({ ok: false, error: `解析设备返回失败：${e.message}` }); }
          }
          resolve({ ok: false, error: err ? `调用 PowerShell 失败：${err.message}` : '设备未返回结果' });
        });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// 脚本公共头：找到设备 → 拿到内部存储 → 拿到目标容器（书架 / office中心）。
// container 支持多层路径，例如 '书架/02_数学与统计'。
const DEVICE_HEAD = (pattern, container) => `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$pattern = ${psQuote(pattern)}
$containerName = ${psQuote(container)}
$shell = $null
$dev = $null
$storage = $null
$container = $null
function Emit($obj) { Write-Output ('#JSON#' + ($obj | ConvertTo-Json -Depth 6 -Compress)) }
try {
  $shell = New-Object -ComObject Shell.Application
  $dev = $shell.NameSpace(17).Items() | Where-Object { $_.Name -like $pattern } | Select-Object -First 1
  if (-not $dev) { Emit @{ ok = $true; connected = $false }; exit 0 }
  $root = $dev.GetFolder
  $storage = ($root.Items() | Where-Object { $_.IsFolder } | Select-Object -First 1)
  if (-not $storage) { Emit @{ ok = $false; connected = $true; device = $dev.Name; error = '设备里看不到内部存储' }; exit 0 }
  $storage = $storage.GetFolder
  $node = $storage
  foreach ($seg in ($containerName -split '[\\\\/]')) {
    if (-not $seg) { continue }
    $next = $node.Items() | Where-Object { $_.Name -eq $seg } | Select-Object -First 1
    if (-not $next) { Emit @{ ok = $false; connected = $true; device = $dev.Name; error = ("设备上找不到「" + $containerName + "」") }; exit 0 }
    $node = $next.GetFolder
  }
  $container = $node
} catch {
  Emit @{ ok = $false; connected = $false; error = $_.Exception.Message }
  exit 0
}
`;

const ITEM_SIZE_PS = `
function Size-Of($item) {
  try { $v = $item.ExtendedProperty('System.Size'); if ($v -ne $null) { return [int64]$v } } catch { }
  try { $v = $item.ExtendedProperty('Size'); if ($v -ne $null) { return [int64]$v } } catch { }
  return 0
}
`;

/**
 * 只读：设备是否连接 + 目标容器里有什么（用于判断「哪些 PDF 已经在办公本上了」）。
 */
export async function listWorkbookContainer({ pattern = WORKBOOK_DEFAULT.device_pattern, container = WORKBOOK_DEFAULT.container } = {}) {
  if (process.platform !== 'win32') return { ok: false, connected: false, error: '只支持 Windows' };
  const script = `${DEVICE_HEAD(pattern, container)}${ITEM_SIZE_PS}
try {
  $items = @()
  foreach ($i in $container.Items()) {
    $items += @{ name = $i.Name; isFolder = [bool]$i.IsFolder; size = (Size-Of $i) }
  }
  Emit @{ ok = $true; connected = $true; device = $dev.Name; container = $containerName; items = $items }
} catch {
  Emit @{ ok = $false; connected = $true; device = $dev.Name; error = $_.Exception.Message }
}
`;
  const res = await runPowerShell(script, { timeout: 60000 });
  if (res && res.ok && res.connected) {
    res.items = Array.isArray(res.items) ? res.items : (res.items ? [res.items] : []);
  }
  return res;
}

/**
 * 把文件（路径 + 文件名）拷进目标容器。设备是 MTP，没有进度回调：
 * 拷完轮询容器列表，用「新出现的条目」判断是否成功（设备可能自己改名，所以不比对文件名）。
 * @param {{path:string,name:string}[]} files
 */
export async function copyToWorkbook(files, { pattern = WORKBOOK_DEFAULT.device_pattern, container = WORKBOOK_DEFAULT.container, timeoutMs = WORKBOOK_DEFAULT.copy_timeout_ms } = {}) {
  if (process.platform !== 'win32') return { ok: false, error: '只支持 Windows' };
  if (!files?.length) return { ok: true, connected: true, copied: [], failed: [] };
  const payload = Buffer.from(JSON.stringify(files.map((f) => ({ path: f.path, name: f.name }))), 'utf8').toString('base64');
  const script = `${DEVICE_HEAD(pattern, container)}${ITEM_SIZE_PS}
$items = @()
# 注意：PowerShell 5.1 的 ConvertFrom-Json 返回的数组不会被自动展开，
# 必须用 foreach 逐个取出，否则整批会当成「一个对象」。
foreach ($x in (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(payload)}))))) { $items += $x }
if ($items.Count -eq 0) { Emit @{ ok = $true; connected = $true; copied = @(); failed = @() }; exit 0 }
$before = @{}
foreach ($i in $container.Items()) { $before[$i.Name] = $true }
$copied = @()
$failed = @()
foreach ($f in $items) {
  try {
    if (-not (Test-Path -LiteralPath $f.path)) { $failed += @{ src = $f.name; error = '本机文件不存在' }; continue }
    $dir = Split-Path -Parent $f.path
    $ns = $shell.NameSpace($dir)
    $item = $ns.ParseName($f.name)
    if (-not $item) { $failed += @{ src = $f.name; error = '无法读取本机文件' }; continue }
    $container.CopyHere($item, 20)
    $newName = $null
    # 大文件（几十 MB 的教材）走 MTP 可能要一两分钟，这里最多等 150 秒
    for ($i = 0; $i -lt 75; $i++) {
      Start-Sleep -Seconds 2
      $fresh = $container.Items()
      foreach ($x in $fresh) { if (-not $before.ContainsKey($x.Name)) { $newName = $x.Name } }
      if ($newName) { break }
    }
    if ($newName) { $before[$newName] = $true; $copied += @{ src = $f.name; device_name = $newName } }
    else { $failed += @{ src = $f.name; error = '拷进设备后 150 秒内没看到新条目（可能被设备拒绝或需要手动确认）' } }
  } catch {
    $failed += @{ src = $f.name; error = $_.Exception.Message }
  }
}
Emit @{ ok = ($failed.Count -eq 0); connected = $true; device = $dev.Name; container = $containerName; copied = $copied; failed = $failed }
`;
  const res = await runPowerShell(script, { timeout: Math.max(180000, timeoutMs) });
  if (res) {
    if (!Array.isArray(res.copied)) res.copied = res.copied ? [res.copied] : [];
    if (!Array.isArray(res.failed)) res.failed = res.failed ? [res.failed] : [];
  }
  return res;
}

/** 设备名规范化，用于「这份材料是不是已经在办公本上了」的粗判。 */
export function normalizeBookName(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}

/** 从文件名里挑出「有辨识度的词」（带数字、长度 ≥ 5），用于宽松匹配设备上的书名。 */
function signatureTokens(filename) {
  return String(filename || '')
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .split(/[^0-9A-Za-z\u4e00-\u9fff]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 5 && /\d/.test(t));
}

/**
 * 宽松判断某份本地 PDF 是否已经以别的名字出现在办公本上
 * （设备会把《Course Syllabus ENGR1010J Fall26.pdf》这类书重命名成自己的书名）。
 */
export function looksPresentOnDevice(deviceNames, filename, { courseCode = '' } = {}) {
  const target = normalizeBookName(filename);
  if (!target) return false;
  const names = (deviceNames || []).map(normalizeBookName);
  for (const n of names) {
    if (!n) continue;
    if (n === target) return true;
    // 一方完整包含另一方（≥6 个字符才有意义，避免误判）
    if (target.length >= 6 && (n.includes(target) || target.includes(n))) return true;
  }
  const tokens = signatureTokens(filename);
  const code = String(courseCode || '').toLowerCase();
  if (tokens.length) {
    const hit = names.some((n) => tokens.every((t) => n.includes(t)));
    if (hit) return true;
  }
  // 课程号 + 「大纲 / 课程大纲」这种设备自带命名
  if (code && /syllabus|大纲/i.test(filename)) {
    const hit = names.some((n) => n.includes(code.replace(/[^0-9a-z]/g, '')) && /大纲/.test(n));
    if (hit) return true;
  }
  return false;
}

export { runPowerShell };

/**
 * 删除办公本（书架 / office 中心）上的条目。
 *
 * MTP 设备**不支持改名**（Shell 的 MoveHere 会被静默忽略，WPD 自动化 COM 在这台机器上也没注册），
 * 所以「改名」只能 = 按新名字重新导入 + 删掉旧条目。而 `InvokeVerb('delete')` 会弹一个确认框并
 * 阻塞当前线程 —— 这里在后台 runspace 里用 EnumWindows 找到 explorer.exe 拥有的标准对话框
 * （类名 `#32770`）并 PostMessage(WM_COMMAND, IDOK) 点掉它。只动 explorer 的对话框，不碰别的程序。
 */
export async function deleteFromWorkbook(names, { pattern = WORKBOOK_DEFAULT.device_pattern, container = WORKBOOK_DEFAULT.container, timeoutMs = 300000 } = {}) {
  if (process.platform !== 'win32') return { ok: false, error: '只支持 Windows' };
  const list = (names || []).map((n) => String(n)).filter(Boolean);
  if (!list.length) return { ok: true, connected: true, deleted: [], failed: [] };
  const payload = Buffer.from(JSON.stringify(list), 'utf8').toString('base64');
  const stopFile = `${process.env.TEMP || process.env.TMP || '.'}\\\\planner-workbook-delete.stop`;
  const script = `${DEVICE_HEAD(pattern, container)}
$stopFile = ${psQuote(stopFile)}
try { Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue } catch { }
$names = @()
foreach ($x in (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(payload)}))))) { $names += [string]$x }

# 后台点掉「确认删除」对话框（只针对 explorer.exe 拥有的 #32770 对话框）
$clicker = [powershell]::Create()
[void]$clicker.AddScript({
  param($seconds, $selfPid, $stopFile)
  Add-Type -Namespace Win32 -Name Dlg -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
'@
  $deadline = (Get-Date).AddSeconds($seconds)
  $clicked = 0
  # 主流程一结束就写 stop 文件，避免这条线程白跑满整个时长
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $stopFile)) {
    # 确认框可能是 explorer.exe 弹的，也可能就在本进程里（Shell COM 调用方）；两种都接受。
    $pids = @(Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $pids += [int]$selfPid
    $hits = New-Object System.Collections.ArrayList
    $cb = [Win32.Dlg+EnumWindowsProc]{
      param($h, $l)
      $sb = New-Object System.Text.StringBuilder 256
      [void][Win32.Dlg]::GetClassName($h, $sb, 256)
      if ($sb.ToString() -eq '#32770') {
        $pid = 0
        [void][Win32.Dlg]::GetWindowThreadProcessId($h, [ref]$pid)
        if ($pids -contains [int]$pid) { [void]$hits.Add($h) }
      }
      return $true
    }
    [void][Win32.Dlg]::EnumWindows($cb, [IntPtr]::Zero)
    foreach ($h in $hits) {
      [void][Win32.Dlg]::PostMessage($h, 0x0111, [IntPtr]1, [IntPtr]::Zero)   # WM_COMMAND + IDOK
      $clicked++
    }
    Start-Sleep -Milliseconds 400
  }
}).AddArgument(120).AddArgument($PID).AddArgument($stopFile)
$handle = $clicker.BeginInvoke()

$deleted = @()
$failed = @()
foreach ($n in $names) {
  $item = $container.Items() | Where-Object { $_.Name -eq $n } | Select-Object -First 1
  if (-not $item) { $failed += @{ name = $n; error = '设备上找不到该条目' }; continue }
  try {
    $item.InvokeVerb('delete')
    Start-Sleep -Seconds 2
    $still = $container.Items() | Where-Object { $_.Name -eq $n } | Select-Object -First 1
    if ($still) { $failed += @{ name = $n; error = '删除指令已发出，但条目还在' } }
    else { $deleted += @{ name = $n } }
  } catch {
    $failed += @{ name = $n; error = $_.Exception.Message }
  }
}
try { Set-Content -LiteralPath $stopFile -Value 'done' -ErrorAction SilentlyContinue } catch { }
try { $clicker.EndInvoke($handle) | Out-Null } catch { }
try { $clicker.Dispose() } catch { }
Emit @{ ok = ($failed.Count -eq 0); connected = $true; device = $dev.Name; container = $containerName; deleted = $deleted; failed = $failed }
`;
  const res = await runPowerShell(script, { timeout: Math.max(300000, timeoutMs) });
  if (res) {
    if (!Array.isArray(res.deleted)) res.deleted = res.deleted ? [res.deleted] : [];
    if (!Array.isArray(res.failed)) res.failed = res.failed ? [res.failed] : [];
  }
  return res;
}
