# Codex Planner 后台托盘（常驻 + 看门狗 + 开机自启开关）
# 2026-09-13 增强：
#   - 看门狗：每 20 秒探活 /api/health，后端掉线自动拉起（以前只在启动时看一眼，服务挂了就一直是挂的）
#   - 单实例：已在跑托盘 / 桌面外壳（PlannerShell.exe）时本脚本自动退出，不再出现两个托盘图标
#   - 开机自启：托盘菜单与 -Action start/stop 都可切换，状态与桌面外壳、应用内开关一致
# 用法：双击「启动后台.cmd」，或 powershell -File tray.ps1 -Action status|start|stop
param([string]$Action = '')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3210
$baseUrl = "http://127.0.0.1:$port"
$logDir = Join-Path $scriptDir 'data'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir 'tray.log'
# ---------- 单实例 + 心跳（2026-09-26 修："托盘里看不到这个应用"）----------
# 以前只靠一个全局互斥量判断"是不是已经有托盘在跑"。问题是：**幽灵托盘**（进程活着、图标不显示，
# 例如从一个非交互会话里被拉起来的）也占着那个锁 ⇒ 之后每次重开都被挡回去，用户就是"看不到图标"。
# 现在改成看**心跳**：只有"最近 90 秒还在写心跳"的托盘才算在跑；心跳断了就接管。
$pidPath = Join-Path $logDir 'tray.pid'
$beatPath = Join-Path $logDir 'tray.heartbeat'
# 2026-09-28：托盘**正常退出**时会把心跳写成这个标记（而不是删掉文件），
# 这样服务端的托盘看门狗（lib/tray-guard.mjs）就能分清"用户主动关了"和"托盘悄悄死了"。
$script:BeatExitedMark = 'exited'
function Test-TrayAlive {
  try {
    if (-not (Test-Path -LiteralPath $pidPath)) { return $false }
    $oldPid = 0
    [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$oldPid)
    if ($oldPid -le 0) { return $false }
    if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { return $false }
    if (-not (Test-Path -LiteralPath $beatPath)) { return $false }
    # 上一个托盘是"正常退出"的 → 不算还有活的托盘（否则会把自己挡回去）
    if ((Get-Content -LiteralPath $beatPath -Raw -ErrorAction SilentlyContinue).Trim() -eq $script:BeatExitedMark) { return $false }
    return (((Get-Date) - (Get-Item -LiteralPath $beatPath).LastWriteTime).TotalSeconds -lt 90)
  } catch { return $false }
}

<#
  「为什么认为上一个托盘不在了」——**如实说清是哪一种**（2026-09-28）。

  以前这里只有一句「发现旧的托盘记录（心跳已停）：接管」，可 Test-TrayAlive 为假有四种原因
  （进程没了 / 心跳文件没了 / 心跳标了 exited / 心跳过期），四种情况全被写成了"心跳已停"。
  真出问题时（2026-09-28 攒出三个图标那次）看日志的人就被这句话带偏了。
#>
function Get-TrayTakeoverReason {
  if (-not (Test-Path -LiteralPath $pidPath)) { return '之前没有托盘记录（本次像是第一次启动）' }
  $oldPid = 0
  try { [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$oldPid) } catch { }
  if ($oldPid -le 0) { return '托盘记录里的 pid 读不出来' }
  if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { return ("上一个托盘进程（pid {0}）已经不在了" -f $oldPid) }
  if (-not (Test-Path -LiteralPath $beatPath)) { return ("心跳文件不见了（pid {0} 的进程还在）" -f $oldPid) }
  $text = ''
  try { $text = (Get-Content -LiteralPath $beatPath -Raw -ErrorAction SilentlyContinue).Trim() } catch { }
  if ($text -eq $script:BeatExitedMark) { return ("上一个托盘标了「已退出」（pid {0} 的进程还在）" -f $oldPid) }
  $age = 0
  try { $age = ((Get-Date) - (Get-Item -LiteralPath $beatPath).LastWriteTime).TotalSeconds } catch { }
  return ("上一个托盘（pid {0} 的进程还在）的心跳停了 {1:N0} 秒" -f $oldPid, $age)
}

<#
  找"另一个托盘进程"（2026-09-28 修"三个图标"那次）。

  为什么要它：单实例判断只看**心跳**，于是"进程活着但心跳停了"的托盘会被当成已死 ——
  新托盘接管时只改写 tray.pid，**旧进程谁也不管**，图标就一个接一个攒起来（实测攒到 3 个）。
  现在接管时把更早的托盘进程真的收掉。

  一条刻意的规矩：**只结束比我先启动的**。同时起两个时，新的赢；老的那个即便之后"醒过来"，
  也不会反过来把新的杀掉（它只收比自己更早的）。
#>
function Get-OlderTrayProcesses {
  $out = @()
  try {
    $mine = Get-Process -Id $PID -ErrorAction Stop
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop)) {
      if (-not $p.CommandLine) { continue }
      if ($p.CommandLine -notmatch 'tray\.ps1') { continue }
      if ([int]$p.ProcessId -eq $PID) { continue }
      $started = $null
      # PowerShell 7 把 CreationDate 直接转成 DateTime，5.1 给的是 CIM 字符串 —— 两种都认，
      # 否则日志里会写成"启动于 时间未知"（2026-09-28 实测踩到）。
      try {
        if ($p.CreationDate -is [datetime]) { $started = $p.CreationDate }
        else { $started = [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate) }
      } catch { }
      if ($started -and $started -gt $mine.StartTime) { continue }   # 比我还新 → 让着它
      $out += [pscustomobject]@{ Id = [int]$p.ProcessId; Started = $started }
    }
  } catch { }
  return $out
}

# 2026-09-15 修复：快捷方式文件名必须是纯 ASCII（旧中文名在本机代码页下会写成 '??' 并保存失败）
$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'CodexPlanner.lnk'
$lnkLegacy = @(
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Planner 后台.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Planner ??.lnk')
)

<#
  状态读取（可选）：如果本机装了一个"外部邮件桥"，它可以提供一份只读的
  **状态读取脚本** `<桥目录>\windows\common.ps1`，托盘就用它把健康状态显示得更细。

  三条保持不变：
    * 那份脚本里只有"读状态"的代码，托盘不会让它做任何结束进程 / 改配置的动作；
    * 托盘自己的启停、开机自启、看门狗逻辑一行没动；
    * 找不到那份脚本时自动回退到原来读 /api/health 的老办法，托盘照常可用。

  桥目录从哪来（都不进仓库）：环境变量 MAIL_BRIDGE_DIR > data\paths.json 的 mail_bridge_dir。
#>
$script:CommonPs1 = $null
$script:BridgeDir = $env:MAIL_BRIDGE_DIR
if (-not $script:BridgeDir) {
  try {
    $pathsFile = Join-Path $logDir 'paths.json'
    if (Test-Path -LiteralPath $pathsFile) {
      $script:BridgeDir = (Get-Content -LiteralPath $pathsFile -Raw -Encoding UTF8 | ConvertFrom-Json).mail_bridge_dir
    }
  } catch { $script:BridgeDir = $null }
}
foreach ($cand in @(
    $env:MAIL_BRIDGE_COMMON,
    ($(if ($script:BridgeDir) { Join-Path $script:BridgeDir 'windows\common.ps1' } else { $null }))
  )) {
  if ($cand -and (Test-Path -LiteralPath $cand)) { $script:CommonPs1 = $cand; break }
}
if ($script:CommonPs1) { . $script:CommonPs1 }
$script:HasCommon = [bool](Get-Command Get-PlannerAppStatus -ErrorAction SilentlyContinue)

# ---------- 应用显示名（与网页同一套规则，见 lib\brand.mjs）----------
# 优先 data\brand.json（作者本机写的名字，data\ 不进仓库），其次环境变量，最后默认 Cairn。
$script:AppName = 'Cairn'
try {
  if ($env:PLANNER_APP_NAME) {
    $script:AppName = $env:PLANNER_APP_NAME
  } else {
    $brandFile = Join-Path $scriptDir 'data\brand.json'
    if (Test-Path -LiteralPath $brandFile) {
      $brandObj = (Get-Content -LiteralPath $brandFile -Raw) | ConvertFrom-Json
      if ($brandObj.app_name) { $script:AppName = [string]$brandObj.app_name }
    }
  }
} catch { }

function Remove-LegacyLnk {
  $ErrorActionPreference = 'SilentlyContinue'
  foreach ($p in $lnkLegacy) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force } }
}

function Write-Log([string]$m) {
  try {
    if ((Test-Path -LiteralPath $logPath) -and ((Get-Item -LiteralPath $logPath).Length -gt 262144)) {
      Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
    }
    ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Add-Content -LiteralPath $logPath -Encoding UTF8
  } catch {}
}

  # ---------- 开机自启 ----------
  # 2026-09-28：不再自己用 WScript.Shell 建快捷方式 —— 它走 ANSI 代码页，路径/参数/备注
  # 里的中文会变成 '????'（路径本身含中文时连 .lnk 都存不下来）。现在交给服务端的
  # /api/autostart：那边用的是 Unicode 版 IShellLinkW（lib/autostart.mjs），只留一处实现。
  function Set-Autostart {
    param([bool]$On)
    $ErrorActionPreference = 'Stop'
    try {
      $body = @{ enabled = $On } | ConvertTo-Json -Compress
      $r = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/autostart" `
              -ContentType 'application/json' -Body $body -TimeoutSec 40
      if ($r.ok) {
        Write-Log ("开机自启：已{0}" -f $(if ($On) { '开启（静默托盘）' } else { '关闭' }))
        return [bool]$r.enabled
      }
      Write-Log ("设置开机自启失败：{0}" -f $r.error)
      return [bool]$r.enabled
    } catch {
      # 服务没在跑时兜底：至少把「关闭」这件事做掉（纯文件操作，不涉及代码页）
      if (-not $On) {
        if (Test-Path -LiteralPath $lnkPath) { Remove-Item -LiteralPath $lnkPath -Force }
        Remove-LegacyLnk
        Write-Log '开机自启：已关闭（服务未运行时直接删快捷方式）'
        return $false
      }
      Write-Log ('设置开机自启失败（服务没在跑？）：' + $_.Exception.Message)
      return (Test-Path -LiteralPath $lnkPath)
    }
  }

# ---------- -Action 模式：只做一件事就退出（供 .cmd 呼叫，不影响已运行的托盘） ----------
if ($Action -ne '') {
  $act = $Action.ToLower()
  if ($act -eq 'start') { $on = Set-Autostart -On $true }
  elseif ($act -eq 'stop') { $on = Set-Autostart -On $false }
  elseif ($act -eq 'status') { $on = Test-Path -LiteralPath $lnkPath }
  elseif ($act -eq 'info') {
    # 输出被重定向（管道/文件）时改用 UTF-8，避免中文被控制台代码页降级成 "?"。
    # 与 status.ps1 同一处理；直接双击 .cmd 时不动，保持终端自己的编码。
    if ([Console]::IsOutputRedirected) {
      try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    }
    Write-Host ''
    Write-Host ("  {0} · 后台状态" -f $script:AppName) -ForegroundColor Cyan
    $st = $null
    if ($script:HasCommon) { try { $st = Get-PlannerAppStatus } catch { $st = $null } }
    if ($st) {
      # 共用渲染：和 status.ps1 看到的完全一样（读 app-status.v1，不看日志）
      Write-AppStatus -Status $st -Title 'Planner（日程管家）'
    } else {
      try {
        $h = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 8
        $up = [TimeSpan]::FromSeconds([int]$h.uptime_sec)
        Write-Host ("  服务：运行中  pid {0}  已运行 {1:N1} 小时" -f $h.pid, $up.TotalHours)
        Write-Host ("  Canvas 巡检：{0}  每 {1} 小时" -f $(if ($h.canvas_watch.enabled) { '开' } else { '关' }), $h.canvas_watch.interval_hours)
      } catch {
        Write-Host '  后台服务未运行（双击「启动后台.cmd」即可拉起）' -ForegroundColor Yellow
      }
    }
    Write-Host ("  开机自启：{0}" -f $(if (Test-Path -LiteralPath $lnkPath) { '已开启' } else { '未开启' }))
    Write-Host ("  日志：data\server.log")
    Write-Host ''
    exit 0
  }
  elseif ($act -eq 'restart') {
    # 2026-09-26：给"托盘图标不见了"准备的一键修复 —— 结束记在 tray.pid 里的旧托盘，再拉一个新的。
    $oldPid = 0
    try { [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$oldPid) } catch { }
    if ($oldPid -gt 0) {
      try { Stop-Process -Id $oldPid -Force; Write-Log ("重启托盘：已结束旧托盘 pid={0}" -f $oldPid) } catch { Write-Log ('重启托盘：结束旧托盘失败 ' + $_.Exception.Message) }
    }
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + (Join-Path $scriptDir 'start-tray.vbs') + '"') -WindowStyle Hidden
    Write-Log '重启托盘：已请求拉起新托盘（若仍看不到图标，请双击「启动后台.cmd」）'
    Write-Host '已请求重启托盘（新图标应当出现在任务栏右下角）'
    exit 0
  }
  else {
    Write-Host '用法：tray.ps1 -Action start|stop|status|info|restart'
    exit 0
  }
  Write-Host ("开机自启：{0}" -f $(if ($on) { '已开启' } else { '未开启' }))
  Write-Host ("快捷方式：{0}" -f $lnkPath)
  exit 0
}

function Get-ServerProcessId {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch {}
  return 0
}

function Test-Server {
  try { $null = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 4; return $true } catch {}
  try { $null = Invoke-WebRequest -Uri "$baseUrl/api/state" -TimeoutSec 4 -UseBasicParsing; return $true } catch { return $false }
}

function Get-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Start-Server {
  $nodeExe = Get-NodeExe
  if (-not $nodeExe) { Write-Log '找不到 node.exe，无法启动服务'; return $false }
  Start-Process -FilePath $nodeExe -ArgumentList 'server.mjs' -WorkingDirectory $scriptDir -WindowStyle Hidden
  Write-Log "已启动 server（$nodeExe）"
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Server) { Write-Log 'server 启动成功'; return $true }
  }
  Write-Log 'server 启动后仍无响应（看门狗会继续重试，详见 data\server.log）'
  return $false
}

# ---------- 单实例（心跳版）：幽灵托盘不再挡路 ----------
# 1) 非交互会话里不启动托盘图标：那种进程不会有可见图标，只会白占一个"已在运行"的名额
if (-not [Environment]::UserInteractive) {
  Write-Log '非交互会话：不启动托盘图标（服务交给桌面上的托盘看门狗）'
  exit 0
}
# 2) 心跳还活着 ⇒ 真的已有托盘在跑，退出
if (Test-TrayAlive) { Write-Log '已有健康托盘在运行，本次退出'; exit 0 }
Write-Log ('接管：' + (Get-TrayTakeoverReason))
# 3) 桌面外壳 PlannerShell 自带托盘与看门狗
try {
  if (Get-Process -Name 'PlannerShell' -ErrorAction SilentlyContinue) {
    Write-Log '桌面外壳 PlannerShell 正在运行（含托盘与看门狗），本次退出'
    exit 0
  }
} catch {}
# 3.5) **真的**把更早的托盘进程收掉（2026-09-28 修"三个图标"那次：
#      以前接管只是改写 tray.pid，旧进程谁也不管，于是每接管一次就多留一个图标）
$script:olderTrays = @(Get-OlderTrayProcesses)
if ($script:olderTrays.Count -gt 0) {
  Write-Log ("接管：发现 {0} 个更早的托盘进程，先把它们收掉（不然各留一个图标）" -f $script:olderTrays.Count)
  foreach ($o in $script:olderTrays) {
    try {
      Stop-Process -Id $o.Id -Force -ErrorAction Stop
      Write-Log ("接管：已结束旧托盘 pid={0}（启动于 {1}）" -f $o.Id, $(if ($o.Started) { $o.Started.ToString('HH:mm:ss') } else { '时间未知' }))
    } catch {
      Write-Log ("接管：结束旧托盘 pid={0} 失败：{1}" -f $o.Id, $_.Exception.Message)
    }
  }
  Start-Sleep -Milliseconds 400        # 给 Windows 一点时间把旧图标收掉
}
Set-Content -LiteralPath $pidPath -Value $PID -Encoding ascii
Set-Content -LiteralPath $beatPath -Value (Get-Date).ToString('o') -Encoding ascii
Write-Log ("托盘启动（看门狗已开启：每 20 秒探活）· 会话 {0} · 当前时间 {1:HH:mm:ss}" -f ([System.Diagnostics.Process]::GetCurrentProcess().SessionId), (Get-Date))

# ---------- 心跳：交给独立线程（2026-09-28，和上面那条同一个原因）----------
# 心跳原来只由下面那个 20 秒的 WinForms 定时器写 —— 那是 **UI 线程**的定时器：
# 托盘只要卡在"向通知区域登记图标"这类调用上，心跳就停，服务端看门狗（lib/tray-guard.mjs）
# 会误判成"托盘死了"，于是再拉一个**新的**（旧的还活着）⇒ 图标越攒越多（实测攒到 3 个）。
# 现在用 C# 的小定时器写心跳：它跑在 .NET 线程池线程上，UI 线程被挡住也照样跳。
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public sealed class CairnTrayBeat {
  private Timer _t;
  private string _path;
  public void Start(string path, int everyMs) {
    _path = path;
    _t = new Timer(_ => { try { File.WriteAllText(_path, DateTime.Now.ToString("o")); } catch { } }, null, everyMs, everyMs);
  }
  public void Stop() { try { if (_t != null) { _t.Dispose(); _t = null; } } catch { } }
}
'@ -ErrorAction SilentlyContinue
$script:beat = $null
try {
  $script:beat = New-Object CairnTrayBeat
  $script:beat.Start($beatPath, 20000)
  Write-Log '心跳：已交给独立线程（UI 卡住也不会停跳）'
} catch {
  $script:beat = $null
  Write-Log ('心跳：独立线程没起来（{0}）—— 退回由 UI 定时器写' -f $_.Exception.Message)
}

if (Test-Server) { Write-Log 'server 已在运行（HTTP 探测通过）' } else { Start-Server }

$ni = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $scriptDir 'app.ico'
if (Test-Path -LiteralPath $iconPath) {
  try { $ni.Icon = New-Object System.Drawing.Icon($iconPath) } catch { $ni.Icon = [System.Drawing.SystemIcons]::Application }
} else { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = ("{0}（后台运行中 · 每 3 小时检查 Canvas）" -f $script:AppName)
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen  = $menu.Items.Add('打开面板')
$miStat  = $menu.Items.Add('后台状态')
$miSync  = $menu.Items.Add('立即检查 Canvas')
[void]$menu.Items.Add('-')
$miRestart = $menu.Items.Add('重启后台服务')
$miAuto  = $menu.Items.Add('开机自启：读取中…')
[void]$menu.Items.Add('-')
$miData  = $menu.Items.Add('打开数据目录')
$miLog   = $menu.Items.Add('查看服务日志')
$miTray  = $menu.Items.Add('查看托盘日志')
[void]$menu.Items.Add('-')
# 2026-09-27：**拆成两项**。以前只有一项"退出 Planner（后台）"，它顺手把 server 也 Stop 掉 ——
# 用户点一次（本意往往只是收掉托盘图标）后台服务就没了，表现就是"后台时好时坏"。
# 现在默认的"退出托盘"**不动服务**，想连服务一起停要显式点第二项。
$miExit    = $menu.Items.Add('退出托盘（后台服务继续跑）')
$miExitAll = $menu.Items.Add('退出并停止后台服务')

$miOpen.add_Click({ try { Start-Process $baseUrl } catch {} })

$miStat.add_Click({
  # 和 status.ps1 用同一份取数（common.ps1）；读不到时回退到老的健康接口。
  $st = $null
  if ($script:HasCommon) { try { $st = Get-PlannerAppStatus } catch { $st = $null } }
  $body = $null
  if ($st) {
    $lines = @($st.sections | ForEach-Object { '{0}：{1}' -f $_.label, $_.detail })
    $body = ($lines -join "`n")
    if ($st.metrics.legacy) { $body += "`n（旧健康接口读数）" }
  } else {
    try {
      $h = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 10
      $up = [TimeSpan]::FromSeconds([int]$h.uptime_sec)
      $upTxt = if ($up.TotalHours -ge 1) { '{0:N1} 小时' -f $up.TotalHours } else { '{0} 分钟' -f [int]$up.TotalMinutes }
      $auto = if ($h.autostart.enabled) { '已开启' } else { '未开启' }
      $body = "服务：运行中（pid $($h.pid)，已运行 $upTxt）`n开机自启：$auto"
    } catch {
      $body = $null
    }
  }
  if ($body) {
    $ni.ShowBalloonTip(10000, ("{0} · 后台状态" -f $script:AppName), $body, [System.Windows.Forms.ToolTipIcon]::Info)
    Write-Log ('后台状态：' + ($body -replace "`n", ' / '))
  } else {
    $ni.ShowBalloonTip(6000, $script:AppName, '读取状态失败（服务可能没在跑）', [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})

$miSync.add_Click({
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/canvas-watch/run" -TimeoutSec 90
    $added = $r.result.added
    $msg = if ($added -gt 0) { "发现 $added 条新动态，已加入通知" } else { '没有新的 Canvas 动态' }
    $ni.ShowBalloonTip(6000, ("{0} · Canvas" -f $script:AppName), $msg, [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $ni.ShowBalloonTip(6000, $script:AppName, ('检查失败：' + $_.Exception.Message), [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})

$miRestart.add_Click({
  try {
    $h = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 8
    if ($h.pid) { Stop-Process -Id ([int]$h.pid) -Force -ErrorAction SilentlyContinue; Write-Log "已结束后台 server pid=$($h.pid)" }
    Start-Sleep -Milliseconds 800
    $ok = Start-Server
    $ni.ShowBalloonTip(6000, ("{0} · 后台服务" -f $script:AppName), $(if ($ok) { '后台服务已重启' } else { '重启失败，请查看 data\server.log' }), [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    $ni.ShowBalloonTip(6000, $script:AppName, ('重启失败：' + $_.Exception.Message), [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})

$miAuto.add_Click({
  $on = Test-Path -LiteralPath $lnkPath
  $now = Set-Autostart -On (-not $on)
  $miAuto.Text = $(if ($now) { '开机自启：已开启（点击关闭）' } else { '开机自启：未开启（点击开启）' })
  $ni.ShowBalloonTip(7000, ("{0} · 开机自启" -f $script:AppName), $(if ($now) { '已开启：下次开机自动在后台运行' } else { '已关闭：开机后不再自动运行' }), [System.Windows.Forms.ToolTipIcon]::Info)
})

$miData.add_Click({ try { Start-Process explorer.exe $scriptDir } catch {} })
$miLog.add_Click({
  $p = Join-Path $scriptDir 'data\server.log'
  if (Test-Path -LiteralPath $p) { Start-Process notepad.exe $p } else { Start-Process explorer.exe $logDir }
})
$miTray.add_Click({
  if (Test-Path -LiteralPath $logPath) { Start-Process notepad.exe $logPath }
  else { Start-Process explorer.exe $logDir }
})

$miExit.add_Click({
  $ni.Visible = $false
  $ni.Dispose()
  try { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue } catch { }
  Write-Log '托盘退出（后台服务继续跑）'
  [System.Windows.Forms.Application]::Exit()
  [Environment]::Exit(0)
})

$miExitAll.add_Click({
  $spid = Get-ServerProcessId
  if ($spid -gt 0) { try { Stop-Process -Id $spid -Force; Write-Log "已停止 server pid=$spid" } catch { Write-Log ('停止失败: ' + $_.Exception.Message) } }
  $ni.Visible = $false
  $ni.Dispose()
  try { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue } catch { }
  Write-Log '托盘退出（连后台服务一起停）'
  [System.Windows.Forms.Application]::Exit()
  [Environment]::Exit(0)
})

$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ try { Start-Process $baseUrl } catch {} })

# 打开菜单时刷新「开机自启」文字（只读本地快捷方式，不联网）
$menu.add_Opening({
  $on = Test-Path -LiteralPath $lnkPath
  $miAuto.Text = $(if ($on) { '开机自启：已开启（点击关闭）' } else { '开机自启：未开启（点击开启）' })
})

# ---------- 看门狗：后端掉线自动拉起 ----------
$script:failCount = 0
$watchdog = New-Object System.Windows.Forms.Timer
$watchdog.Interval = 20000
$watchdog.add_Tick({
  # 2026-09-26：整个 tick 包 try —— 以前心跳写失败（文件被占/杀软）会把这个定时器回调炸掉，
  # 严重时连托盘一起没了；现在任何一步出错都只记一行日志，托盘继续活着。
  try {
    # 心跳：正常情况由那个独立线程写（见上面的 CairnTrayBeat）；它没起来时才由这里兜底。
    # 顺带自检一次 —— 心跳是"给别人看的存活信号"，停了必须留下痕迹（以前是静默 catch）。
    if (-not $script:beat) {
      try { Set-Content -LiteralPath $beatPath -Value (Get-Date).ToString('o') -Encoding ascii }
      catch { Write-Log ('写心跳失败：' + $_.Exception.Message) }
    } else {
      try {
        $beatAge = ((Get-Date) - (Get-Item -LiteralPath $beatPath).LastWriteTime).TotalSeconds
        if ($beatAge -gt 60) { Write-Log ("心跳异常：已经 {0:N0} 秒没更新（独立线程可能没起来）" -f $beatAge) }
      } catch { }
    }
    # 2026-09-26：图标"不见了"但进程还在（explorer 重排托盘区时图标会掉）⇒ 每轮把可见性再声明一次，
    # 这是让图标自己回来的标准做法，代价几乎为零。
    try { if (-not $ni.Visible) { $ni.Visible = $true }; $ni.Text = ("{0}（后台运行中 · 每 3 小时检查 Canvas）" -f $script:AppName) } catch { }
    if (Test-Server) { $script:failCount = 0; return }
    $script:failCount++
    Write-Log ("健康检查失败 {0} 次（后端无响应）" -f $script:failCount)
    # 2026-09-27：从"连续 2 次"放宽到"连续 3 次"（20 秒一次 ⇒ 60 秒没反应才重启）。
    # 起因：正常的一次服务重启（约 20~25 秒）刚好会被判成掉线，托盘跟着又拉一个 ——
    # 日志里就会看到一串"掉线→自动重启"，用户感受就是"后台时好时坏"。宁可晚 20 秒恢复，
    # 也不要在服务只是"正在重启"的时候插一脚。
    if ($script:failCount -lt 3) { return }
    $script:failCount = 0
    Write-Log '后台服务已掉线（连续 3 次无响应），开始自动重启'
    $ok = Start-Server
    $ni.ShowBalloonTip(6000, ("{0} · 后台服务" -f $script:AppName), $(if ($ok) { '后台服务曾中断，已自动重启（提醒与 Canvas 巡检恢复）' } else { '后台服务中断且自动重启失败，请查看 data\server.log' }), [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {
    try { Write-Log ('看门狗这一轮出错（已忽略，托盘继续）：' + $_.Exception.Message) } catch { }
  }
})
$watchdog.Start()

Write-Log '托盘启动（看门狗已开启：每 20 秒探活）'
  $ni.ShowBalloonTip(6000, $script:AppName, '已在后台运行：每 3 小时自动检查 Canvas，服务掉线会自动重启。', [System.Windows.Forms.ToolTipIcon]::Info)

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.Visible = $false
# ---------- 退出时记下原因（2026-09-28）----------
# 以前托盘"悄悄没了"只留下一个过期心跳，日志里**没有任何原因**，事后无从判断。
# 现在把退出路径和异常都写进 tray.log，并把心跳写成 'exited'：
#   · 用户主动退出（菜单里那个）→ 服务端看门狗看到标记就不再拉起；
#   · 异常退出 → 心跳停在旧时间戳，服务端会在 ~3 分钟后把它拉起来。
try {
  [System.Windows.Forms.Application]::Run($form)
  Write-Log '托盘退出：窗口循环正常结束'
} catch {
  try {
    Write-Log ('托盘退出（未捕获异常）：' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
  } catch { }
} finally {
  # 先停掉独立心跳线程，再写 'exited' —— 不然它会在这之后把标记覆盖成时间戳，
  # 服务端看门狗（lib/tray-guard.mjs）就分不清"用户主动退出"和"托盘悄悄死了"了。
  try { if ($script:beat) { $script:beat.Stop() } } catch { }
  try { Set-Content -LiteralPath $beatPath -Value $script:BeatExitedMark -Encoding ascii } catch { }
  try { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue } catch { }
  Write-Log '托盘已退出（心跳已标记 exited；服务端看门狗不会自动拉起这次退出）'
}
