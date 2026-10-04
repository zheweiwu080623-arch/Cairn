// 跨平台运行器：只跑"不依赖本机环境"的那批测试（W1 的 CI 用）。
//
//   node tests/run-portable.mjs          # 人读输出
//   node tests/run-portable.mjs --json   # 机器可读
//
// 为什么要有它：`work/tools/run_all_suites.py` 里有大量路径写死在这台机器上
// （Planner 服务、本机的邮件桥目录、PowerShell 脚本），在别的系统上必然跑不了。
// 这个运行器只用**仓库内的代码与样例**，不联网、不碰系统、不要求任何服务在跑，
// 所以 Windows / macOS / Linux 都能跑 —— 它既是 CI 的入口，也是"换台机器还灵不灵"的第一道体检。
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** 只列"纯仓库内"的测试；需要活的 Planner 服务或本机邮件桥 / PowerShell 的都不在里面。 */
export const PORTABLE_TESTS = [
  'viewmodel.test.mjs',
  'mobile-view.test.mjs',
  'anki.test.mjs',
  'anki-export.test.mjs',
  'job-runs.test.mjs',
  'dashboard.test.mjs',
  'dashboard-panels.test.mjs',
  'duedate.test.mjs',
  'today-wiring.test.mjs',
  'today-html.test.mjs',
  'tasks-wiring.test.mjs',
  'tasks-html.test.mjs',
  'notifications-wiring.test.mjs',
  'notifications-html.test.mjs',
  'connectors-wiring.test.mjs',
  'connectors-html.test.mjs',
  'calendar-wiring.test.mjs',
  'calendar-html.test.mjs',
  'calendar-dayweek.test.mjs',
  'vm-bridge.test.mjs',
  'r4-html.test.mjs',
  'export-contract.test.mjs',
  'app-status.test.mjs',
  'brand.test.mjs',
  'paths.test.mjs',
  'local-config.test.mjs',
  'relevance.test.mjs',
  'learning.test.mjs',
  'digest-focus.test.mjs',
  'quiet-hours.test.mjs',
  'customizable.test.mjs',
  'cross-platform.test.mjs',
  'semantic.test.mjs',
  'profile-ui.test.mjs',
  'modules.test.mjs',
  'connect-wizard.test.mjs',
  'agent-connect.test.mjs',
  'secrets.test.mjs',
  'migrations.test.mjs',
  'feed.test.mjs',
  'rss-connector.test.mjs',
  'ical.test.mjs',
  'ical-connector.test.mjs',
  'jsonmap.test.mjs',
  'jsonapi-connector.test.mjs',
  'localfile.test.mjs',
  'llm.test.mjs',
  'llm-providers.test.mjs',
  'wallpapers.test.mjs',
  'media.test.mjs',
  'study-routes.test.mjs',
  'credential-mask.test.mjs',
  'connectors-routes.test.mjs',
  'connector-instances.test.mjs',
  'semester.test.mjs',
  'student-mode.test.mjs',
  'student-view.test.mjs',
  'md-lite.test.mjs',
  'docs-route.test.mjs',
  'priority.test.mjs',
  'priority-module.test.mjs',
  'priority-routes.test.mjs',
  'codex-config.test.mjs',
  'digest-brief.test.mjs',
  'digest-routes.test.mjs',
  'daily-brief-module.test.mjs',
  'autopush.test.mjs',
  'email-digest.test.mjs',
  'onboarding.test.mjs',
  'mobile-routes.test.mjs',
  'processor.test.mjs',
  'preclass.test.mjs',
  'cli-mod.test.mjs',
  'localdirs.test.mjs',
  'local-tools.test.mjs',
  'local-drop.test.mjs',
  'mail-policy.test.mjs',
  'coursetext.test.mjs',
  'pdftotext-route.test.mjs',
  'course-assist.test.mjs',
  'naming-template.test.mjs',
  'fn-settings.test.mjs',
  'stability-refresh.test.mjs',
  'no-codex-history.test.mjs',
  'schedule-form.test.mjs',
  'schedule-input.test.mjs',
  'course-latex.test.mjs',
  'calendar-nav.test.mjs',
  // 能力层（M1 · S2）：注册表整表 + 每条能力自己的单测
  'capabilities.test.mjs',
  'capability-canvas-course-check.test.mjs',
  'capability-course-scan.test.mjs',
  'capability-course-text.test.mjs',
  'capability-course-artifacts.test.mjs',
  'capability-dedupe-filter-new.test.mjs',
  'capability-dedupe-mark-seen.test.mjs',
  'capability-prefs-read.test.mjs',
  'capability-notify-app.test.mjs',
  'capability-push-phone.test.mjs',
  'capability-file-write.test.mjs',
  'capability-host.test.mjs',
  // 2026-10-02 「能力搭建简化」三项：通用原子能力 / 图上的条件 / 复合能力
  'capability-atoms.test.mjs',
  'capability-model-tools.test.mjs',
  'capability-llm-task.test.mjs',
  'composite-capability.test.mjs',
  'flow.test.mjs',
  'flow-conditions.test.mjs',
  'flow-builder.test.mjs',
  'privacy-disable-manifest.test.mjs',
  'onboarding-wizard.test.mjs',
  'settings-dev.test.mjs',
  'page-gear.test.mjs',
  'function-capability-split.test.mjs',
  'backup.test.mjs',
  'notify-tick.test.mjs',
  'ddl.test.mjs',
  'daily.test.mjs',
  'mcp.test.mjs',
  'server-shell.test.mjs',
  'tray-guard.test.mjs',
  'feedback-fixes.test.mjs',
  'feedback-ux.test.mjs',
];

/** 需要本机环境、故意不进 CI 的测试（列出来是为了不让人以为漏了）。 */
export const LOCAL_ONLY_TESTS = [
  'mail-bridge.test.mjs（要本机配了邮件桥）',
  'planner_ui_smoke.mjs（要活着的 Planner 服务）',
  'regression_day1.py / status_ps1_test.py / tray_common_test.py（要 Windows + PowerShell）',
  'mail-bridge 的真实发信（要本机邮件桥进程）',
  'contract_check.py（Python + 本机工作区路径）',
];

export function runPortable({ quiet = false } = {}) {
  // 每个测试都需要一个可写的临时目录。
  // 优先用 PLANNER_TEST_TMP（有些沙箱里 %TEMP% 不可写），否则用系统临时目录。
  // 注意：不要退到仓库里的目录。tests/settings-dev.test.mjs 有一条断言「能力目录不能在源码树里」，
  // 临时目录一旦落进仓库，那条会红（2026-10-03 踩过）。%TEMP% 不可写的环境请自己给 PLANNER_TEST_TMP。
  const baseTmp = process.env.PLANNER_TEST_TMP || tmpdir();
  let tmp = baseTmp;
  try { tmp = mkdtempSync(join(baseTmp, 'portable-')); } catch { tmp = baseTmp; }
  // 时区：默认按 **UTC** 跑，和 GitHub 的 runner 对齐。
  // 2026-09-28 踩到的坑：CI 的 runner 在 UTC，而本机是 +08；一批测试把
  // '…T09:00:00+08:00' 这种**绝对时刻**当"本地 09:00"用，于是本机全过、CI 六个组合全挂。
  // 现在测试已改成按本地时间构造（任意时区都成立），这里再把默认时区钉成 UTC ——
  // 本机跑就等于 CI 跑，以后同类问题在推之前就能撞到。想验证别的时区：`TZ=Asia/Shanghai node tests/run-portable.mjs`
  const tz = process.env.TZ || 'UTC';
  const env = { ...process.env, PLANNER_TEST_TMP: tmp, TZ: tz };
  const results = [];

  for (const file of PORTABLE_TESTS) {
    const started = Date.now();
    const proc = spawnSync(process.execPath, [join('tests', file)], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 120000,
    });
    const out = `${proc.stdout || ''}${proc.stderr || ''}`;
    const lines = out.trim().split('\n').filter((l) => l.trim());
    const ok = proc.status === 0;
    results.push({
      file, ok, ms: Date.now() - started,
      tail: lines.slice(-1)[0] || '',
      log: lines.slice(-20).join('\n'),       // 失败时用来定位（CI 里会变成 annotation）
    });
    if (!quiet) console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}${ok ? '' : `  ← ${results.at(-1).tail}`}`);
  }
  return { results, tmp, passed: results.filter((r) => r.ok).length, total: results.length };
}

// 直接运行时才执行
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const json = process.argv.includes('--json');
  const out = runPortable({ quiet: json });
    if (json) {
      console.log(JSON.stringify({
        platform: process.platform, node: process.version, tz: process.env.TZ || 'UTC',
        passed: out.passed, total: out.total,
        failed: out.results.filter((r) => !r.ok).map((r) => r.file),
        // 明细：GitHub 的 job log 要登录才看得到，所以 CI 会把这几行变成 annotation
        // （见 tests/ci-annotate.mjs），不登录也能从 API 读到失败原因。
        failedDetail: out.results.filter((r) => !r.ok)
          .map((r) => ({ file: r.file, tail: r.tail, log: r.log })),
      }, null, 2));
    } else {
    console.log('');
    console.log(`平台 ${process.platform} · Node ${process.version} · TZ ${process.env.TZ || 'UTC'} · ${out.passed}/${out.total} 通过`);
    if (out.passed !== out.total) {
      console.log('没过的：');
      for (const r of out.results.filter((x) => !x.ok)) console.log(`  · ${r.file}`);
    }
  }
  process.exit(out.passed === out.total ? 0 : 1);
}
