"""公开仓库之前：扫 **git 历史**（不只是工作区）有没有凭据 / 个人信息。

    python -X utf8 work\\tools\\git_history_scan.py [仓库路径]

为什么必须单独扫一遍：工作区干净 ≠ 历史干净。.gitignore 只挡"以后"，挡不住"以前提交过的"。
公开（Public）之前跑；私有仓库可以只当体检看一眼。
"""

import re
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

REPO = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parents[1])

# 判据分两类：真凭据（必须为 0）与"只是可能暴露环境/身份"的提示项（可接受，但要知情）
BLOCKING = {
    "真实 API key 形态": r"sk-[A-Za-z0-9]{20,}",
    "Bearer 长串": r"Bearer[[:space:]]+[A-Za-z0-9._-]{20,}",
    "私钥块": r"BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY",
}
# 凭据类赋值要"实际看看值长什么样"：一眼是假值/占位的（测试夹具）不算命中
CRED_HINT = "|".join(["example", "placeholder", "your", "sample", "demo", "fake", "test",
                      "\\$\\{", "<", ">", "••", "xxx", "123", "456", "tok-", "pw-"])
NOTICE = {
    "学校邮箱（可能是假样例）": r"[A-Za-z0-9._%+-]+@sjtu\.edu\.cn",
    "本机绝对路径（可能是注释示例）": r"[A-Za-z]:\\\\(Users\\\\[^\\\\]+|SteamLibrary)",
    "学校域名": r"oc\.sjtu\.edu\.cn",
    "示例值 sk-example…": r"sk-example",
}


def scan(patterns):
    rows = []
    shas = subprocess.run(["git", "rev-list", "--all"], cwd=REPO, capture_output=True, text=True).stdout.split()
    for name, pat in patterns.items():
        hits = []
        for sha in shas:
            r = subprocess.run(["git", "grep", "-nIE", "--", pat, sha], cwd=REPO, capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.strip():
                hits.extend(r.stdout.splitlines())
        rows.append((name, hits))
    return shas, rows


def scan_credential_assignments(shas):
    """带引号字面量赋值的凭据类：先粗筛，再排除"一眼是假值"的测试夹具。"""
    pat = r"(password|passwd|authcode|授权码|token|secret)[[:space:]]*[:=][[:space:]]*[\x27\"]([^\x27\"]{12,})[\x27\"]"
    real, fake = [], []
    for sha in shas:
        r = subprocess.run(["git", "grep", "-nIE", "--", pat, sha], cwd=REPO, capture_output=True, text=True)
        for line in (r.stdout or "").splitlines():
            m = re.search(pat, line, re.I)
            value = m.group(2) if m else ""
            (fake if re.search(CRED_HINT, value, re.I) else real).append(line)
    return real, fake


print(f"仓库：{REPO}")
shas, blocking = scan(BLOCKING)
print(f"提交数：{len(shas)}")
print("\n【必须为 0】真凭据类：")
blocked = 0
for name, hits in blocking:
    print(f"  {name:<24} {'OK' if not hits else f'⚠️ {len(hits)} 处'}")
    for h in hits[:3]:
        print("      ", h[:160])
    blocked += len(hits)

real_creds, fake_creds = scan_credential_assignments(shas)
print(f"  {'凭据类赋值（已排假值）':<24} {'OK' if not real_creds else f'⚠️ {len(real_creds)} 处'}")
for h in real_creds[:3]:
    print("      ", h[:160])
if fake_creds:
    print(f"    （另有 {len(fake_creds)} 处一眼是假值/占位，已忽略，例如：{fake_creds[0].split(':', 2)[-1].strip()[:70]}）")
blocked += len(real_creds)

_, notice = scan(NOTICE)
print("\n【知情即可】可能暴露环境/身份（多为测试占位或注释示例）：")
for name, hits in notice:
    print(f"  {name:<24} {len(hits)} 处")
    for h in hits[:2]:
        print("      ", h[:150])

print("\n结论：", "历史干净 —— 可以直接公开（Public）" if blocked == 0 else f"⚠️ 有 {blocked} 处真凭据命中，公开前必须先处理（改代码 + 重写历史或换新仓库）")
print("\n提醒：commit 作者与 GitHub 用户名本身就是公开信息；上面那两条提示项请自己判断要不要接受。")
sys.exit(0 if blocked == 0 else 1)
