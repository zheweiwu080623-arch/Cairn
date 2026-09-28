"""公开仓库之前：扫 **git 历史**（不只是工作区）有没有凭据 / 个人信息。

    python -X utf8 scripts/history-check.py [仓库路径]

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


def git_lines(args):
    """跑一条 git 命令；**读不到就报错退出**，绝不把"读不到"当成"干净"。

    2026-09-28 踩到的：本机 `git rev-list --all` 因为"仓库属主和当前用户不一致"
    （dubious ownership）返回空，脚本却把 0 个提交当成"没有命中"，照样打印
    「历史干净 —— 可以直接公开」。那是个**假阴性**，比误报危险得多。
    现在：先带 safe.directory 重试，仍然失败就直接退 2 并说明原因。
    """
    for extra in ([], ["-c", f"safe.directory={REPO}"]):
        p = subprocess.run(["git"] + extra + args, cwd=REPO, capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout.split()
    print(f"✗ 读不了这个仓库的 git（git {' '.join(args)}）：")
    print("   " + ((p.stderr or p.stdout or "").strip().splitlines() or ["(没有输出)"])[0][:300])
    print("   注意：这类失败**不能**当成「历史干净」—— 先解决 git 的问题再跑。")
    sys.exit(2)


def scan(patterns):
    rows = []
    shas = git_lines(["rev-list", "--all"])
    for name, pat in patterns.items():
        hits = []
        for sha in shas:
            out = git_grep(pat, sha)
            if out.strip():
                hits.extend(out.splitlines())
        rows.append((name, hits))
    return shas, rows


def git_grep(pat, sha):
    """`git grep` 某个提交。0=有命中、1=没命中（都正常）；>1 说明出错了 —— 那必须报出来，
    否则"扫不了"会被当成"没命中"（2026-09-28 那个假阴性的另一条路）。"""
    for extra in ([], ["-c", f"safe.directory={REPO}"]):
        r = subprocess.run(["git"] + extra + ["grep", "-nIE", "--", pat, sha],
                           cwd=REPO, capture_output=True, text=True)
        if r.returncode in (0, 1):
            return r.stdout
    print(f"✗ git grep 扫不了提交 {sha[:8]}（正则 {pat[:40]}…）：")
    print("   " + ((r.stderr or "").strip().splitlines() or ["(没有输出)"])[0][:300])
    print("   注意：扫不动**不能**当成「没命中」。")
    sys.exit(2)


def scan_credential_assignments(shas):
    """带引号字面量赋值的凭据类：先粗筛，再排除"一眼是假值"的测试夹具。"""
    pat = r"(password|passwd|authcode|授权码|token|secret)[[:space:]]*[:=][[:space:]]*[\x27\"]([^\x27\"]{12,})[\x27\"]"
    real, fake = [], []
    for sha in shas:
        for line in git_grep(pat, sha).splitlines():
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
