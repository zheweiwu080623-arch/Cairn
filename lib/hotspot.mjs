// hotspot.mjs —— 「给平板开热点」：用电脑自己的无线网卡开一个热点，把当前网络共享出去（2026-10-08）
//
// 为什么需要它（真实处境）：校园网会把同一 Wi-Fi 里的设备互相隔离 —— 平板连校园网时
// **根本连不到这台电脑**（实测：3211 的访问日志里一条请求都没有）。手机热点能用，但要一直开着、
// 而且每次 IP 都不一样。最省事的办法是**让电脑自己发一个热点**：
//   * 平板连电脑的热点 → 数据从平板直接到电脑，不经过校园网的 AP，**绕开设备隔离**；
//   * Windows 的移动热点是"共享"（ICS/NAT）：电脑连着校园网，把网络转给平板，**平板照样能上网**；
//   * 这个热点的地址是固定的（ICS 网段，通常 192.168.137.1）—— 平板那条链接加一次主屏幕就不用再改。
//
// 实现说明：Windows 的移动热点只能通过 WinRT 的 NetworkOperatorTetheringManager 开关，
// 而 WinRT 在 PowerShell 7 里用不了、必须 Windows PowerShell 5.1（`powershell.exe`）。
// 所以这里是"把一段 PowerShell 用 -EncodedCommand 递过去、读回一行 JSON"，
// **不落任何临时文件**（省得又在磁盘上留一堆脚本）。
//
// 边界：只开关这一个热点，不碰别的网络设置；非 Windows 如实说"没做"。

import { execFile } from 'node:child_process';

/** ICS 默认网段（读不到真实地址时的兜底；正常都会读出真的）。 */
export const HOTSPOT_FALLBACK_IP = '192.168.137.1';

// 这段脚本要**纯 ASCII**：它以 base64 传过去，但里面的枚举/字段名本来就是英文。
const PS_TEMPLATE = `
$ErrorActionPreference = 'SilentlyContinue'
[void][Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
$out = [ordered]@{ supported = $true; state = 'unknown'; ssid = ''; pass = ''; ip = ''; code = ''; error = ''; action = '__ACTION__' }
$conn = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if (-not $conn) {
  $out.state = 'no-internet'
  $out.code = 'no-internet'
  $out | ConvertTo-Json -Compress
  exit 0
}
$mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($conn)
$cfg = $mgr.GetCurrentAccessPointConfiguration()
$out.ssid = [string]$cfg.Ssid
$out.pass = [string]$cfg.Passphrase
$out.state = $mgr.TetheringOperationalState.ToString().ToLower()

# Poll the tethering state itself. Deliberately NOT reading $op.Status:
# on this machine that WinRT property reads back empty in PowerShell 5.1, which made
# the old check throw "failed (status=)" even though the toggle had actually worked.
function Wait-ForState($m, $target, $tries) {
  $n = 0
  while ($n -lt $tries) {
    if ($m.TetheringOperationalState.ToString().ToLower() -eq $target) { return $true }
    Start-Sleep -Milliseconds 500
    $n++
  }
  return $false
}

$cur = $mgr.TetheringOperationalState.ToString().ToLower()
$want = '__ACTION__'
try {
  if ($want -eq 'on' -and $cur -ne 'on') {
    $null = $mgr.StartTetheringAsync()
    if (-not (Wait-ForState $mgr 'on' 120)) { throw 'tethering did not turn on within 60s' }
  } elseif ($want -eq 'off' -and $cur -ne 'off') {
    $null = $mgr.StopTetheringAsync()
    if (-not (Wait-ForState $mgr 'off' 120)) { throw 'tethering did not turn off within 60s' }
  }
  else { $out.action = 'noop' }          # already in the wanted state: do not call again
} catch {
  $out.error = [string]$_.Exception.Message
}

$out.state = $mgr.TetheringOperationalState.ToString().ToLower()
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.InterfaceDescription -like '*Wi-Fi Direct*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1).IPAddress
if ($ip) { $out.ip = [string]$ip }
if ($out.state -eq 'on' -and -not $out.ip) { $out.ip = '${HOTSPOT_FALLBACK_IP}' }
$out | ConvertTo-Json -Compress
`;

/** 状态字符串 → 人话。 */
export function stateLabel(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'on') return '已开';
  if (s === 'off') return '关着';
  if (s === 'intransition') return '正在切换';
  if (s === 'no-internet') return '没联网';
  return '未知';
}

/** 从 PowerShell 的 stdout 里挑出那行 JSON（前面的杂音不管）。 */
export function parseStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const o = JSON.parse(lines[i]);
      return {
        supported: o.supported !== false,
        state: String(o.state || 'unknown').toLowerCase(),
        ssid: String(o.ssid || ''),
        pass: String(o.pass || ''),
        ip: String(o.ip || ''),
        action: String(o.action || ''),
        code: String(o.code || ''),
        // 人话写在 JS 这一侧：PowerShell 脚本保持纯 ASCII（项目里踩过编码的坑）
        error: humanizePsError(o.code, o.error),
      };
    } catch { /* 继续往前找 */ }
  }
  return { supported: true, state: 'unknown', ssid: '', pass: '', ip: '', action: '', code: '', error: '读不出热点状态' };
}

/** 把 PowerShell 侧的错误码/英文短句翻成人话。 */
export function humanizePsError(code, error) {
  if (code === 'no-internet') {
    return '电脑现在没有连上任何网络 —— 先让电脑连上 Wi-Fi 或手机热点，再开热点给平板';
  }
  const text = String(error || '');
  const m = text.match(/tethering op failed \(status=(\d)\)/);
  if (m) {
    const why = { 0: '还在切换中', 1: '', 2: '被取消了', 3: '系统拒绝了这次切换（可能被组策略 / 权限挡住）' }[m[1]] || '未知原因';
    return `热点操作没成功：${why}（code ${m[1]}）`;
  }
  const t = text.match(/tethering did not turn (on|off) within (\d+)s/);
  if (t) return `等了 ${t[2]} 秒，热点还是没能${t[1] === 'on' ? '打开' : '关闭'} —— 请到「设置 → 网络和 Internet → 移动热点」看一眼（可能被系统/安全软件挡住）`;
  return text;
}

/**
 * PowerShell 出错时 stderr 往往是 CLIXML（`#< CLIXML <Objs…<S S="Error">真正的消息</S>`）——
 * 直接把这段丢给界面等于没报错。这里把真正的消息抠出来，抠不到就退化成去标签的纯文本。
 */
export function cleanPsError(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const msgs = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((m) => m[1].replace(/_x000D_|_x000A_/g, ' ').trim())
    .filter(Boolean);
  if (msgs.length) return msgs.join(' ').slice(0, 300);
  return raw.replace(/#<\s*CLIXML/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 平板要打开的地址（固定 IP + 那串密钥）。 */
export function tabletUrl({ ip, port = 3211, token = '' } = {}) {
  const host = String(ip || '').trim() || HOTSPOT_FALLBACK_IP;
  return `http://${host}:${port}/p/${encodeURIComponent(String(token || ''))}/`;
}

export function buildScript(action) {
  const a = ['on', 'off', 'status'].includes(String(action)) ? String(action) : 'status';
  // 注意用 replaceAll：模板里 __ACTION__ 出现两处（$out.action 与 $want）。
  // 2026-10-08 踩过：写成 replace 只会替换第一处，于是 $want 还是字面量 '__ACTION__'，
  // 两个分支都不匹配 —— 表现就是"点了开/关没反应"（实测接口 1.4 秒返回 state 不变）。
  return PS_TEMPLATE.replaceAll('__ACTION__', a);
}

/** 跑一次 PowerShell（Windows PowerShell 5.1，WinRT 只有它认）。 */
// 开关热点实测要几十秒（关一次 ~34 秒），所以默认给足 75 秒；查询本来很快，用不到这么多。
export function runPowerShell(action, { timeoutMs = 75000, runner = execFile, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return Promise.resolve({ supported: false, state: 'unsupported', ssid: '', pass: '', ip: '', error: '这个开关目前只做了 Windows' });
  }
  const script = buildScript(action);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    try {
      runner('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) {
          resolve({ supported: true, state: 'unknown', ssid: '', pass: '', ip: '', action: '', code: '',
              error: cleanPsError(stderr) || String(err.message || err).slice(0, 200) });
            return;
          }
          resolve(parseStatus(stdout));
        });
    } catch (e) {
      resolve({ supported: true, state: 'unknown', ssid: '', pass: '', ip: '', action: '', code: '',
        error: String(e.message || e) });
    }
  });
}
