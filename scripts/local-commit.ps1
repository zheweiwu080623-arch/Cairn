<#
  local-commit.ps1 —— 把当前改动提交进本地 git 仓库（W1 用）

  为什么需要你双击：项目目录里的 .git 对"自动化沙箱身份"是只读的
  （沙箱策略把所有工作区根目录下的 .git 视为只读），但对你自己完全可写。
  所以 git 的写入动作必须由你来执行 —— 脚本已经替你做完剩下的一切。

  用法（由 提交到本地仓库.cmd 调用，也可以手动跑）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\local-commit.ps1 -Message "说明"
    不带 -Message 时会用一个带时间戳的默认说明。

  安全性：只做 init / config / add / commit / log，不删文件、不改远程、不推送。
#>
param([string]$Message = "")

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot          # 本脚本在 <repo>\scripts\ 下
Set-Location -LiteralPath $repo

Write-Host ''
Write-Host '  Planner · 提交到本地仓库' -ForegroundColor Cyan
Write-Host ("  仓库：{0}" -f $repo)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host '  ✗ 没找到 git。请先安装 Git for Windows，然后再双击一次。' -ForegroundColor Red
    exit 1
}

# 1) 让 git 认可这个目录（避免 "dubious ownership"）。写全局配置失败也不影响后面。
try { & git config --global --add safe.directory $repo 2>$null } catch { }

# 2) 仓库不存在就初始化
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    & git init -b main
    Write-Host '  · 已初始化本地仓库（分支 main）'
} else {
    Write-Host '  · 已存在本地仓库'
}

# 3) 提交身份：**不在仓库里硬编码**（公开仓库不该带作者身份）。
#    优先读本机的 data\git-identity.json（data/ 被 .gitignore 排除，永远不会上传）：
#        { "name": "你的名字", "email": "<ID>+<用户名>@users.noreply.github.com" }
#    没有这个文件就沿用你 git 里已设的身份（你自己在 GitHub Desktop / git config 里设的）。
$idFile = Join-Path $repo 'data\git-identity.json'
if (Test-Path -LiteralPath $idFile) {
    try {
        $id = Get-Content -Raw -LiteralPath $idFile | ConvertFrom-Json
        if ($id.name) { & git config user.name $id.name 2>$null }
        if ($id.email) { & git config user.email $id.email 2>$null }
        Write-Host ("  · 提交身份取自 data\git-identity.json：{0}" -f $id.name)
    } catch {
        Write-Host '  · data\git-identity.json 读不出来，沿用现有 git 身份' -ForegroundColor Yellow
    }
} else {
    Write-Host '  · 沿用你 git 里已设的提交身份（想固定就建 data\git-identity.json）'
}

# 3.5) 防呆：这个仓库是**要公开**的 —— 真实邮箱会出现在每一条提交里
$curEmail = (& git config user.email) 2>$null
if ($curEmail -and ($curEmail -notmatch '@users\.noreply\.github\.com$')) {
    Write-Host ''
    Write-Host '  ⚠️ 当前提交邮箱不是 GitHub 的 noreply 地址：' -ForegroundColor Yellow
    Write-Host ("     {0}" -f $curEmail) -ForegroundColor Yellow
    Write-Host '     这个仓库要公开，真实邮箱会出现在每一条提交里（GitHub 上人人可见）。' -ForegroundColor Yellow
    Write-Host '     建议改成：git config --global user.email "<你的ID>+<用户名>@users.noreply.github.com"' -ForegroundColor Yellow
    Write-Host '     （那一串去 GitHub → Settings → Emails 里复制）' -ForegroundColor Yellow
    Write-Host ''
}

# 4) 暂存所有改动
& git add -A
$staged = @(& git diff --cached --name-only)
if ($staged.Count -eq 0) {
    Write-Host '  · 没有需要提交的改动' -ForegroundColor Yellow
    & git log --oneline -5
    Write-Host ''
    return 0
}

# 5) 安全闸：确认不该进仓库的东西没被混进去
$forbidden = $staged | Where-Object { $_ -match '^(data/|node_modules/)' -or $_ -match '\.(db|sqlite3?|mp4|dll|exe)$' -or $_ -match '\.bak' }
if ($forbidden) {
    Write-Host '  ✗ 暂存里出现了不该提交的文件，已停下（没有提交）：' -ForegroundColor Red
    $forbidden | Select-Object -First 15 | ForEach-Object { Write-Host ("      " + $_) }
    Write-Host '    处理办法：确认 .gitignore 是否被改过；需要的话把这几行加回去，再双击一次。'
    exit 1
}
Write-Host ("  · 将要提交 {0} 个文件" -f $staged.Count)

# 5.5) 公开前体检：工作区 + git 历史（防止把凭据/个人信息推上去）
#  - 有 python 就跑；没装 python 只提醒一句，继续提交（不因为体检工具缺失而卡住你）
#  - 真凭据类命中 → **停下不提交**；提示类（学校邮箱/本机路径模板）只打印
$pyOk = $false
foreach ($cand in @('python', 'python3')) {
    $exe = Get-Command $cand -ErrorAction SilentlyContinue
    if ($exe) { $pyExe = $exe.Source; $pyOk = $true; break }
}
if ($pyOk) {
    Write-Host '  · 体检：扫描工作区里的凭据 / 个人信息 ...'
    & $pyExe -X utf8 (Join-Path $repo 'scripts\public-check.py') 2>&1 | Select-Object -Last 8
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  ✗ 工作区体检发现阻断项，已停下（没有提交）。' -ForegroundColor Red
        Write-Host '    先按上面的提示处理，再双击一次。' -ForegroundColor Red
        exit 1
    }
    Write-Host '  · 体检：扫描 git 历史（只提醒，不阻断） ...'
    & $pyExe -X utf8 (Join-Path $repo 'scripts\history-check.py') 2>&1 | Select-Object -Last 6
} else {
    Write-Host '  · 没找到 python，跳过体检（建议装一个：体检能防止把凭据推上去）' -ForegroundColor Yellow
}

# 6) 提交
if (-not $Message) { $Message = "Planner 本地提交 {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm') }
& git commit -q -m $Message
if ($LASTEXITCODE -ne 0) {
    Write-Host '  ✗ 提交失败（可能是身份未配置）。把上面的 git 报错发我即可。' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  ✓ 提交完成。最近 5 条记录：' -ForegroundColor Green
& git log --oneline -5 | ForEach-Object { Write-Host ("      " + $_) }
Write-Host ''
Write-Host '  下一步（等你决定"私有还是公开"之后再做）：' -ForegroundColor Cyan
Write-Host '    1) 在 GitHub 上新建一个空仓库（不要勾选 README）'
Write-Host '    2) 然后运行：git remote add origin <仓库地址>'
Write-Host '                 git push -u origin main'
Write-Host ''
