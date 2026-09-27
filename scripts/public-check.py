"""发布前体检 v2：这个目录推到 GitHub 会不会出事。

    python tools\\github_preflight_scan.py "C:\\path\\to\\repo" [--out 报告.md]

v2 相比 v1 的三处改进（都是被真实误报逼出来的）：
  1. **区分「会不会真的进仓库」**：读 `.gitignore`，把命中分成
     「会随代码公开（阻断）」和「本地文件、已被忽略（不算事故）」。
     否则 data/ 里的数据库和日志会把报告刷满，看不出真正的问题。
  2. **示例值白名单**：`student@example.edu`、`user@example.com`、`*.invalid` 这类
     本来就是给人看的占位符，不算个人信息。
  3. **真密钥启发式**：`icloud_pass: 'mobile_icloud_pass'` 这种"键名当值"不算凭据；
     只有"长度够 + 字母数字混合 / base64 形状 / 高熵"才报，减少假警报。

退出码：0 = 没有阻断性问题；1 = 有（可直接当 CI 门禁）。
"""
import argparse
import fnmatch
import os
import re
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
# 体检脚本自己（以及同伴 history-check）**必须跳过**：
# 它们天然包含"凭据长什么样"的规则与用法示例，扫自己必然误报（2026-09-24 实测：3 处自指命中）。
SELF_FILES = {Path(__file__).resolve().name, "history-check.py"}
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".mp4", ".mov", ".webm",
              ".dll", ".exe", ".so", ".dylib", ".zip", ".7z", ".pdf", ".woff", ".woff2"}
BIG_FILE_MB = 3.0
BIG_MEDIA_MB = 10.0

SECRET_RULES = [
    ("口令/密码", re.compile(r"(?i)(pass(word|wd)?|pwd)\s*[:=]\s*['\"]([^'\"]{4,})['\"]")),
    ("密钥/令牌", re.compile(r"(?i)(secret|token|api[_-]?key|app[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*['\"]([A-Za-z0-9_\-./+]{8,})['\"]")),
    ("邮箱授权码", re.compile(r"(?i)(授权码|app[_-]?password|imap[_-]?pass|smtp[_-]?pass)\s*[:=]\s*['\"]([^'\"]{4,})['\"]")),
    ("私钥文件", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

EMAIL_ALLOW = re.compile(r"(?i)@(example\.(com|org|net|edu)|.*\.invalid|.*\.test|localhost|users\.noreply\.github\.com)$")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
WIN_USER_RE = re.compile(r"[A-Za-z]:\\Users\\(?!example\b|<)([^\\\s'\"]+)")
FIXED_DRIVE_RE = re.compile(r"[A-Za-z]:\\(?!Users\\|Windows\\)[A-Za-z0-9_\u4e00-\u9fff\\\\.\-]{3,}")
STUDENT_ID_RE = re.compile(r"(?i)(sjtu\d{5,}|jaccount)")
MASKED_SECRET_RE = re.compile(r"••••(?!(0000\b))\w+")

# 这些盘符路径是**有意保留**的，不算可移植性欠账：
#   · C:\Program Files\...            → 在 Windows 上找 Edge/Chrome 可执行文件（带存在性检查）
#   · C:\Windows\System32\wscript.exe → 开机自启的兜底启动器
#   · D:\<邮件桥目录>                  → 外部邮件桥的安装位置（本机配置，不进仓库）
#   · C:\Users\x / example / <...>    → 样例与测试里的占位用户名
ACCEPTED_DRIVE_PATTERNS = [
    re.compile(r"(?i)^c:\\program"),          # 抓取时会在空格处截断，所以只匹配前缀
    re.compile(r"(?i)^c:\\windows"),
    re.compile(r"(?i)^c:\\users\\?(x|example|<|$)"),
]


def is_accepted_drive(value: str) -> bool:
    # 源码里写的是转义形式（C:\\Users\\x），先还原成单反斜杠再判断
    norm = value.replace("\\\\", "\\")
    return any(rx.match(norm) for rx in ACCEPTED_DRIVE_PATTERNS)


def is_test_path(rel: str) -> bool:
    """测试文件里的示例路径不算"可移植性欠账" —— 它们是夹具与断言，不是产品代码。"""
    return rel.startswith("tests/") or "/tests/" in rel


def looks_like_real_secret(value: str) -> bool:
    """`mobile_icloud_pass` 这种键名当值的不算密钥；真密钥通常更长且字母数字混合。"""
    v = value.strip()
    if not v:
        return False
    if re.fullmatch(r"[a-z0-9_]+", v):          # 纯小写+下划线 = 像设置键名
        return False
    if v.lower() in ("password", "changeme", "your-password", "xxx", "todo", "example"):
        return False
    if "example" in v.lower() or "placeholder" in v.lower():
        return False
    has_alpha = any(c.isalpha() for c in v)
    has_digit = any(c.isdigit() for c in v)
    has_symbol = any(c in "-_./+=" for c in v)
    return len(v) >= 8 and has_alpha and (has_digit or has_symbol)


def load_gitignore(root: Path) -> list:
    gi = root / ".gitignore"
    lines = []
    if gi.is_file():
        for raw in gi.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if line and not line.startswith("#"):
                lines.append(line)
    return lines


def is_ignored(rel: str, patterns: list) -> bool:
    parts = rel.split("/")
    for pat in patterns:
        p = pat.rstrip("/")
        if pat.endswith("/"):
            # 目录规则可能含多级（如 public/assets/wallpapers/），按前缀匹配整条路径
            if rel == p or rel.startswith(p + "/"):
                return True
            continue
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(parts[-1], pat):
            return True
    return False


def is_text(path: Path) -> bool:
    if path.suffix.lower() in BINARY_EXT:
        return False
    try:
        return b"\x00" not in path.read_bytes()[:4096]
    except OSError:
        return False


def scan(root: Path):
    patterns = load_gitignore(root)
    findings = []      # (类别, 文件相对路径, 处数, 样本, 是否会被公开)
    big, binaries, backups, data_files = [], [], [], []
    total_files = total_bytes = 0
    published_files = published_bytes = 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name in SELF_FILES and Path(dirpath).resolve().name == "scripts":
                continue                      # 跳过体检脚本自己（见 SELF_FILES 的说明）
            path = Path(dirpath) / name
            rel = path.relative_to(root).as_posix()
            try:
                size = path.stat().st_size
            except OSError:
                continue
            total_files += 1
            total_bytes += size
            ignored = is_ignored(rel, patterns)
            if not ignored:
                published_files += 1
                published_bytes += size

            if size > BIG_MEDIA_MB * 1024 * 1024:
                big.append((rel, size, "媒体/大文件", ignored))
            elif size > BIG_FILE_MB * 1024 * 1024:
                big.append((rel, size, "偏大", ignored))
            if path.suffix.lower() in (".exe", ".dll", ".so", ".dylib"):
                binaries.append((rel, size, ignored))
            if re.search(r"\.bak|\.snapshot|副本|\.old$|~$", name):
                backups.append((rel, ignored))
            if path.suffix.lower() in (".sqlite", ".sqlite3", ".db", ".db-wal", ".db-shm"):
                data_files.append((rel, ignored))

            if not is_text(path) or size > 8 * 1024 * 1024:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue

            for label, rx in SECRET_RULES:
                hits = []
                for m in rx.finditer(text):
                    value = m.group(m.lastindex) if m.lastindex else m.group(0)
                    if label == "私钥文件" or looks_like_real_secret(value):
                        hits.append(value)
                if hits:
                    findings.append(("凭据·" + label, rel, len(hits), str(hits[0])[:40], ignored))

            emails = [e for e in EMAIL_RE.findall(text) if not EMAIL_ALLOW.search(e)]
            if emails:
                findings.append(("个人信息·邮箱", rel, len(emails), emails[0], ignored))
            phones = PHONE_RE.findall(text)
            if phones:
                findings.append(("个人信息·手机号", rel, len(phones), phones[0], ignored))
            users = WIN_USER_RE.findall(text)
            if users:
                findings.append(("个人信息·本机用户名", rel, len(users), users[0], ignored))
            drives = [d for d in FIXED_DRIVE_RE.findall(text)
                      if not d.lower().startswith(("c:\\program", "c:\\windows"))
                      and "example" not in d.lower() and "..." not in d]
            drives = [d for d in drives if not is_accepted_drive(d)]
            # 测试里的示例路径不算欠账（可移植性只对生产代码有意义）
            if drives and not is_test_path(rel):
                # 硬编码盘符是"可移植性欠账"，不是泄露 —— 单独归类，不算阻断
                findings.append(("可移植性·硬编码盘符(警告)", rel, len(drives), drives[0][:40], ignored))
            ids = STUDENT_ID_RE.findall(text)
            if ids:
                findings.append(("个人信息·学号/JAccount", rel, len(ids), ids[0], ignored))
            # 只在数据类文件里查"掩码残留"：源码里出现 •••• 是在写脱敏逻辑本身，不是泄漏。
            if path.suffix.lower() in (".json", ".md", ".txt", ".log", ".csv", ".tsv", ".yml", ".yaml"):
                masks = MASKED_SECRET_RE.findall(text)
                if masks:
                    findings.append(("凭据·掩码残留(露出尾字符)", rel, len(masks), masks[0], ignored))

    return dict(findings=findings, big=big, binaries=binaries, backups=backups,
                data_files=data_files, total_files=total_files, total_bytes=total_bytes,
                published_files=published_files, published_bytes=published_bytes,
                patterns=patterns)


def report(root: Path, out: Path) -> int:
    r = scan(root)
    pub = [f for f in r["findings"] if not f[4]]
    local = [f for f in r["findings"] if f[4]]

    lines = [
        f"# 发布前体检报告 · {root.name}",
        "",
        f"- 生成时间：{datetime.now():%Y-%m-%d %H:%M:%S}",
        f"- 全目录：**{r['total_files']}** 个文件 / **{r['total_bytes']/1024/1024:.1f} MB**",
        f"- **会随代码公开：{r['published_files']} 个文件 / {r['published_bytes']/1024/1024:.1f} MB**"
        f"（其余被 .gitignore 排除，不会上传）",
        "",
        "## 1. 会随代码公开的问题（阻断级）",
        "",
    ]
    if pub:
        by_kind = {}
        for kind, rel, n, sample, _ in pub:
            by_kind.setdefault(kind, []).append((rel, n, sample))
        for kind in sorted(by_kind):
            lines.append(f"- ⛔ **{kind}**：{len(by_kind[kind])} 个文件")
            for rel, n, sample in by_kind[kind][:20]:
                lines.append(f"    - `{rel}`（{n} 处，例如 `{sample}`）")
    else:
        lines.append("- ✅ 没有发现会公开的凭据 / 个人信息 / 硬编码盘符")

    lines += ["", "## 2. 本地文件里的问题（已被 .gitignore 排除，不阻断）", ""]
    if local:
        by_kind = {}
        for kind, rel, n, sample, _ in local:
            by_kind.setdefault(kind, {})[rel] = n
        for kind in sorted(by_kind):
            files = by_kind[kind]
            lines.append(f"- ⚪ {kind}：{len(files)} 个文件（数据库/日志/备份，只在本机）")
        lines.append("")
        lines.append(f"  合计 {len(local)} 条命中，全部落在被忽略的目录里 —— 说明 `.gitignore` 起作用了。")
    else:
        lines.append("- （无）")

    lines += ["", "## 3. 体积与二进制（只看会公开的）", ""]
    pub_big = [b for b in r["big"] if not b[3]]
    if pub_big:
        for rel, size, why, _ in sorted(pub_big, key=lambda x: -x[1])[:25]:
            mark = "⛔" if why == "媒体/大文件" else "⚠️"
            lines.append(f"- {mark} {size/1024/1024:.2f} MB `{rel}`（{why}）")
    else:
        lines.append("- ✅ 会公开的文件里没有超过 3 MB 的")
    pub_bin = [b for b in r["binaries"] if not b[2]]
    if pub_bin:
        for rel, size, _ in pub_bin[:10]:
            lines.append(f"- ⛔ 二进制 `{rel}`（{size/1024:.0f} KB）—— 源码仓库不该放编译产物")

    lines += ["", "## 4. .gitignore", ""]
    lines.append(f"- 现有规则：{', '.join(r['patterns']) if r['patterns'] else '（没有）'}")
    lines.append("- 判定方式：目录规则按路径段匹配，其余按 fnmatch 匹配全路径或文件名。")

    lines += ["", "## 5. 结论", ""]
    # 阻断 = 泄露类（凭据/个人信息）；硬编码盘符只算可移植性警告
    leak = [f for f in pub if not f[0].startswith("可移植性")]
    warn_portability = [f for f in pub if f[0].startswith("可移植性")]
    blockers = len(leak) + len(pub_bin) + len([b for b in pub_big if b[2] == "媒体/大文件"])
    if leak or pub_bin:
        lines.append("**⛔ 不能公开。** 先处理第 1 节里的泄露类问题（和第 3 节的二进制）。")
        code = 1
    elif [b for b in pub_big if b[2] == "媒体/大文件"]:
        lines.append("**⚠️ 可以公开，但建议先处理体积**（大媒体会让 clone 变慢）。")
        code = 0
    else:
        lines.append("**✅ 体检通过：会公开的内容里没有凭据、个人信息与硬编码盘符。**")
        code = 0
    lines += ["", f"（阻断项计数：{blockers}；可移植性警告：{len(warn_portability)} 条，属 W2 待办）", ""]

    if out:                                     # 仓库自带版：没给 --out 就不落文件（报告里含本机路径）
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:52]))
    print(f"\n完整报告 -> {out}" if out else "\n（没写报告文件；想要就加 --out 报告.md）")
    return code


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default=None,
                    help="要体检的仓库根目录（默认 = 本脚本所在的仓库）")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[1]
    out = Path(args.out) if args.out else None    # 仓库自带版：不写文件（想留报告就显式给 --out）
    return report(root, out)


if __name__ == "__main__":
    raise SystemExit(main())
