import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync, createReadStream, readFileSync, createWriteStream, renameSync, rmSync } from 'node:fs';
import { extname, join, dirname, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { pipeline } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { store } from './lib/store.mjs';
import {
  detectCodexHome, readAutomations, nextOccurrences, describeRrule,
} from './lib/codex.mjs';
import { listConnectorMeta, getConnector, normalizeForStore } from './lib/connectors/index.mjs';
import { instanceType } from './lib/connectors/instances.mjs';
import { createAutoSync } from './lib/autosync.mjs';
import { semesterInfo } from './lib/semester.mjs';
import { buildStudentView } from './lib/student-view.mjs';
import {
  PLAN_FILE_NAMES, PLAN_FORMAT_LABELS, buildPlan, planToCsv, planToMarkdown, writePlanExport,
} from './lib/plan-export.mjs';
import {
  buildNotificationsExport, buildSnapshotExport, writeExportFiles,
} from './lib/export-contract.mjs';
import { buildPlannerAppStatus } from './lib/app-status.mjs';
import { buildIcs } from './lib/ics.mjs';
import { findPdftotext, setPdftotextPath } from './lib/coursetext.mjs';
import { findRasterizer, setRasterizerPath } from './lib/pdf-pages.mjs';
import { planExportFormats } from './lib/function-settings.mjs';
import { brandInfo } from './lib/brand.mjs';
import { describePaths } from './lib/paths.mjs';
import {
  deriveProfileFromState, normalizeProfile, parseProfileFromText, scoreItem, summarizeVerdicts,
} from './lib/relevance.mjs';
import {
  clearLearning, learnedRules, mergeLearned, normalizeLearning, recordFeedback,
} from './lib/learning.mjs';
import { activeFocus, importantKind, notifyGate } from './lib/focus.mjs';
import { bandLabel, isPeak } from './lib/peak.mjs';
import { createUserPrefs } from './lib/user-prefs.mjs';
import { createAutostart } from './lib/autostart.mjs';
import { localPath } from './lib/local-config.mjs';
import { moduleAssetPath } from './lib/modules.mjs';
import { createMedia } from './lib/media.mjs';
import { createStudyRoutes } from './lib/routes/study.mjs';
import { createConnectorRoutes } from './lib/routes/connectors.mjs';
import { createDocsRoutes } from './lib/routes/docs.mjs';
import { createPriorityRoutes } from './lib/routes/priority.mjs';
import { createDigestRoutes } from './lib/routes/digest.mjs';
import { createAutopushRunner } from './lib/autopush-run.mjs';
import { createPrefsRoutes } from './lib/routes/prefs.mjs';
import { createMobileRoutes } from './lib/routes/mobile.mjs';
import { createMobileServer } from './lib/mobile-server.mjs';
import { createModuleRoutes } from './lib/routes/modules.mjs';
import { createCapabilityRoutes } from './lib/routes/capabilities.mjs';
import { createFlowStack } from './lib/flow-stack.mjs';
import { createCapabilityHost } from './lib/capabilities/host.mjs';
import { createPreclassStack } from './lib/preclass-stack.mjs';
import { createLocalDirRoutes } from './lib/routes/localdirs.mjs';
import { createLocalDropRoutes } from './lib/routes/local-drop.mjs';
import { createFunctionSettingsRoutes } from './lib/routes/function-settings.mjs';
import { createCourseStack } from './lib/course-stack.mjs';
import { createProcessorExecutors } from './lib/processor-executors.mjs';
import { createBackupStack } from './lib/backup-stack.mjs';
import { createTickRunner } from './lib/notify-tick.mjs';
import { createDdlStack } from './lib/ddl-stack.mjs';
import { createDailyStack } from './lib/daily-stack.mjs';
import { createMcpStack } from './lib/mcp-stack.mjs';
import { createTrayGuard } from './lib/tray-guard.mjs';
import {
  createStaticHandler, initFileLogging, installProcessGuards, openBrowser, openExternalUrl, streamMedia,
} from './lib/server-shell.mjs';
import { describeLocalProvider, resolveLocalProvider } from './lib/codex-config.mjs';
import {
  maskConfigJson, maskMobilePrefs, sanitizeMobilePatch,
} from './lib/credential-mask.mjs';
import { describeTestResult, humanizeConnectorError } from './lib/connector-errors.mjs';
import {
  DEFAULT_LLM, askLlm, describeLlm, humanizeLlmError, llmReady, normalizeLlm, redactToken, withLocalProvider,
} from './lib/llm.mjs';
import {
  MAX_ITEMS_PER_RUN, applySemanticResults, buildSemanticPrompt, parseSemanticReply,
} from './lib/semantic.mjs';
import { sendViaMailBridge } from './lib/mail-bridge.mjs';
import {
  MOBILE_KEYS, getMobilePrefs, saveMobilePrefs, ensureCalToken, calendarInfo,
  buildDigestText, digestDue, sendDigest, sendDueDigests, sendDigestNow, writeMobileFiles, pushBarkNotification, barkSourceAllowed,
  testIcloud, syncIcloud, icloudDue,
} from './lib/mobile.mjs';
import {
  getCourseSync, setCourseSync, queueCanvasFile, runCourseSync,
  purgeHistoryNow, courseSyncStatus, listWorkbookContainer,
  testMailBridge, resolveCourseDir, normalizeCourseNames, courseRootLabel, courseFileNameTemplate,
} from './lib/course-sync.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUB_DIR = join(__dir, 'public');
const PORT = Number(process.env.PORT || 3210);
const MOBILE_PORT = Number(process.env.MOBILE_PORT || 3211);
// 数据目录：老装机继续用 <repo>/data（零迁移），新装机用平台默认目录。
const DATA_DIR = describePaths({ repoDir: __dir }).dataDir;
const MODULES_DIR = join(__dir, 'modules');   // 可插拔功能的目录（W2）
const LOG_PATH = join(DATA_DIR, 'server.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// ---------- 后台运行日志 + 进程护栏（实现在 lib/server-shell.mjs）----------
initFileLogging({ logPath: LOG_PATH, maxBytes: LOG_MAX_BYTES, dataDir: DATA_DIR });
installProcessGuards();
const HK = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

// ---------- SSE hub for live notifications ----------
const clients = new Set();
function broadcast(event) {
  const payload = `event: notification\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// ---------- Codex connection helpers ----------
function currentCodexHome() {
  return store.getSync('codex_home') || detectCodexHome();
}

// ---------- 计划导出(让 Codex 读取应用里的每日计划与安排) ----------
let lastPlanExport = null;
function exportPlanNow() {
  try {
    // 导出哪几种格式是**设置里的偏好**（设置 → 本机 → 计划导出；默认 md + json）
    const formats = planExportFormats();
    const r = writePlanExport(store, { dataDir: DATA_DIR, codexHome: currentCodexHome(), formats });
    // P1-5：同时刷新契约化导出（data/export/*.json），供外部程序（办公 AI / 本机脚本）消费
    let exports = { paths: [] };
    try { exports = writeExportFiles(store, { dataDir: DATA_DIR }); } catch { /* 不影响计划文件 */ }
    lastPlanExport = { exported_at: r.exported_at, formats: r.formats, paths: r.paths, exports: exports.paths };
    return lastPlanExport;
  } catch (e) {
    return { error: e.message, formats: [], paths: [] };
  }
}
function getPlanSnapshot() { return buildPlan(store, { days: 14 }); }

function syncCodex() {
  const home = currentCodexHome();
  if (!home) {
    return { connected: false, error: '未检测到 Codex 目录，请在设置中填写 CODEX_HOME。' };
  }
  const automations = readAutomations(home);
  // Compute next run time for each enabled automation, so it becomes a planned event.
  const scheduled = automations.map((a) => {
    let next = [];
    if (a.status === 'ACTIVE' && a.rrule) {
      next = nextOccurrences(a.rrule, new Date(), 1);
    }
    return { ...a, describe: describeRrule(a.rrule), next_run_at: next[0] || null };
  });
  // 2026-09-27：不再读 Codex 的历史会话（用户要求删掉这个功能）——只读"自动化任务"这一件事。
  const connected = !!home;
  const result = {
    connected,
    home,
    automations: scheduled,
    error: null,
    synced_at: Date.now(),
  };
  store.setSync('codex_snapshot', JSON.stringify(result));
  return result;
}

function getCodexSnapshot() {
  const raw = store.getSync('codex_snapshot');
  if (raw) {
    const s = JSON.parse(raw);
    s.synced_at = s.synced_at || 0;
    return s;
  }
  return { connected: false, home: null, automations: [], synced_at: 0 };
}

/**
 * 一次性清理：把**以前存进 Cairn 自己库里**的 Codex 会话记录删掉（2026-09-27）。
 *
 * 用户要求删掉"记录 Codex 历史会话"这个功能。功能已经删了，但老数据还在
 * `sync_state.codex_snapshot` 里（实测 232 条、151 KB，含每个会话第一条用户消息原文与工作目录）。
 * 这里在启动时把 `threads` 字段从库里抹掉，只留"自动化任务"那部分 —— 不留历史包袱。
 */
function purgeStoredCodexThreads() {
  try {
    const raw = store.getSync('codex_snapshot');
    if (!raw || !raw.includes('"threads"')) return 0;
    const s = JSON.parse(raw);
    const n = Array.isArray(s.threads) ? s.threads.length : 0;
    delete s.threads;
    store.setSync('codex_snapshot', JSON.stringify(s));
    console.log(`[codex] 已从本机库里删除旧的 Codex 会话记录 ${n} 条（这个功能已经下线）`);
    return n;
  } catch (e) {
    console.warn('[codex] 清理旧会话记录失败（不影响其它功能）：', e.message);
    return 0;
  }
}

// Ask the local Codex CLI and return its response as text.
function askCodex(prompt) {
  // 注意：真正对外用的是 askAgent() —— 它按配置决定走本机 CLI 还是走 HTTP 模型接口。
  const cli = process.env.CODEX_CLI || 'codex'; // on PATH, or override with full path
  const user = process.env.USERPROFILE || process.env.HOME || '';
  const env = { ...process.env, HOME: user, USERPROFILE: user, CODEX_HOME: user ? (user + '\\.codex') : process.env.CODEX_HOME };
  return new Promise((resolve) => {
    execFile(cli, ['exec', prompt], { timeout: 150000, maxBuffer: 12 * 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      const errOut = String(stderr || '').trim();
      if (err) return resolve({ ok: false, error: errOut || out || err.message });
      resolve({ ok: true, text: out || errOut });
    });
  });
}

// ---------- Daily auto-sync (scheduled external data supplement) ----------
function getAutoSync() {
  const raw = store.getSync('auto_sync');
  if (raw) return JSON.parse(raw);
  return { enabled: false, time: '08:00', connectors: { feishu: false, canvas: false, email: false, email_sjtu: false, arxiv: false }, demo: false, auto_approve: false, last_run: null, last_result: null };
}

function setAutoSync(cfg) {
  // keep last_run unless explicitly reset
  cfg.last_run = cfg.last_run ?? getAutoSync().last_run;
  store.setSync('auto_sync', JSON.stringify(cfg));
  return getAutoSync();
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 每日自动同步整块搬去了 lib/autosync.mjs（见那里的注释）；这里只做接线。
const { runAutoSync } = createAutoSync({
  store, getConnector, normalizeForStore, scoreItem, summarizeVerdicts,
  effectiveProfile, pushItemToPlanner, getAutoSync, setAutoSync,
});

// Called from the tick loop; triggers when the configured daily time is reached.
// ---------- 信息筛选：画像（profile）----------
// 画像决定"外部进来的哪条信息值得打扰你"。未启用时一切与历史行为完全一致。
const PROFILE_KEY = 'profile_json';

function getProfile() {
  try {
    const raw = JSON.parse(store.getSync(PROFILE_KEY) || 'null');
    return normalizeProfile(raw || {});
  } catch {
    return normalizeProfile({});
  }
}

function setProfile(patch) {
  const next = normalizeProfile({ ...getProfile(), ...patch, updated_at: Date.now() });
  store.setSync(PROFILE_KEY, JSON.stringify(next));
  return next;
}

/** 从应用已有数据派生画像（不需要 agent）：课表课程代码、任务里的目标词、来源占比。 */
function derivedProfile() {
  return deriveProfileFromState({
    courses: store.listCourses(),
    tasks: store.listTasks(),
    notifications: store.listNotifications(),
  });
}

// ---------- 信息筛选：行为学习（P1）----------
// 你删掉 / 批准的条目会训练筛选规则；学习记录单独存放，随时可清空。
const LEARNING_KEY = 'learning_json';

// ---------- 通用 agent 接入（W4-3）----------
// 默认仍是"本机 Codex CLI"（不改现有行为）；填了别的 provider 就走 HTTP 模型接口。
const AGENT_KEY = 'llm_json';

function getAgent() {
  try { return normalizeLlm(JSON.parse(store.getSync(AGENT_KEY) || 'null') || {}); }
  catch { return normalizeLlm({}); }
}

function setAgent(patch) {
  let merged = { ...getAgent(), ...patch, updated_at: Date.now() };
  // 选「沿用本机 Codex 配置」时：把地址/模型**写进配置**（但**不写令牌**），
  // 令牌只在每次调用那一刻从 ~/.codex/config.toml 读出来用（见 askAgent）。
  if (merged.provider === 'codex-config') {
    const local = resolveLocalProvider();
    if (local) merged = { ...merged, base_url: local.base_url, model: patch.model || local.model || merged.model };
  }
  const next = normalizeLlm(merged);
  store.setSync(AGENT_KEY, JSON.stringify(next));   // api_key 会被 store 自动加密
  return next;
}

/** 对外表示：Key 只回掩码，附上"能不能用"的判断。 */
function agentPublic(cfg = getAgent()) {
  const masked = cfg.api_key ? '••••' + String(cfg.api_key).slice(-4) : '';
  const ready = llmReady(cfg);
  return {
    ...cfg, api_key: masked, has_key: Boolean(cfg.api_key), ready: ready.ready, why: ready.why, label: describeLlm(cfg),
    // 「沿用本机 Codex 配置」这条通道：告诉界面"本机发现了什么"（令牌只给掩码）
    local: describeLocalProvider(resolveLocalProvider()),
  };
}

/**
 * 真正要用的那份配置。
 *
 * 关键点：「沿用本机 Codex 配置」这条通道的**地址 / 模型 / 令牌**在**调用这一刻**
 * 才从 `~/.codex/config.toml` 读出来（不落库、不进日志），所以凡是要"真调一次"的地方
 * （askAgent、/api/agent/test）都必须先过这个函数 —— 否则就会像 2026-09-22 这次一样，
 * 测试报"API Key 无效"，而其实只是没把本机那个令牌带上。
 */
function effectiveAgentConfig() {
  const cfg = getAgent();
  if (cfg.provider !== 'codex-config') return cfg;
  const local = resolveLocalProvider();
  if (!local || !local.base_url) return cfg;          // 交给调用方按"不就绪"报错
  return withLocalProvider(cfg, local);
}

/**
 * 真正对外用的调用口：按配置决定走 CLI 还是 HTTP 模型接口。
 * `opts.images`（可选）= 给视觉模型的图（PDF→LaTeX 的"视觉路线"要用）。
 */
async function askAgent(prompt, opts = {}) {
  const cfg = getAgent();
  const images = Array.isArray(opts.images) ? opts.images : [];
  const llmOpts = { images, timeoutMs: Number(opts.timeoutMs) || 0 };
  if (cfg.provider === 'codex-config') {
    const local = resolveLocalProvider();
    if (!local || !local.base_url) {
      return { ok: false, error: '没读到本机 Codex 配置（~/.codex/config.toml）。可以到「数据源 → Agent 接入」换成 OpenAI 兼容 / Ollama，或确认 Codex 自己能用。' };
    }
    const ready = withLocalProvider(cfg, local);
    const r = await askLlm(ready, prompt, llmOpts);
    if (r.ok) return { ok: true, text: r.text, via: `codex-config:${local.id}` };
    // 报错也过一遍脱敏：中转有可能把整个请求回显在错误里
    return { ok: false, error: redactToken(humanizeLlmError(r.error, ready), local.token) };
  }
  if (cfg.provider !== 'codex-cli') {
    const ready = llmReady(cfg);
    if (!ready.ready) return { ok: false, error: `模型配置不完整（${ready.why}）—— 到「数据源 → Agent 接入」里补一下` };
    const r = await askLlm(cfg, prompt, llmOpts);
    if (r.ok) return { ok: true, text: r.text, via: cfg.provider };
    // 明确报错，不静默回落到 CLI（否则你会以为用的是自己的 Key）
    return { ok: false, error: humanizeLlmError(r.error, cfg) };
  }
  // codex-cli 通道发不了图（CLI 的 exec 接口这一层没有图片参数）—— 如实拒绝，别假装成功
  if (images.length) return { ok: false, error: '当前用的是「本机 Codex CLI」通道，发不了图；视觉路线要在「数据源 → Agent 接入」里选一个支持图片的接口。' };
  return askCodex(prompt);
}

function getLearning() {
  try {
    return normalizeLearning(JSON.parse(store.getSync(LEARNING_KEY) || 'null') || {});
  } catch {
    return normalizeLearning({});
  }
}

function setLearning(next) {
  const normalized = normalizeLearning({ ...next, updated_at: Date.now() });
  store.setSync(LEARNING_KEY, JSON.stringify(normalized));
  return normalized;
}

/** 真正生效的画像 = 手填画像 + 学习到的规则（手填优先，学习只追加）。 */
function effectiveProfile() {
  return mergeLearned(getProfile(), getLearning()).profile;
}

/** 学习主体：优先发件人，其次来源 —— 这样"某个来源一直被你删"也能学会。 */
function learningKeyOf(row = {}) {
  try {
    const payload = JSON.parse(row.payload || '{}');
    const from = payload.from || payload.sender || payload.user;
    if (from) return String(from).toLowerCase();
  } catch { /* payload 不是 JSON 就跳过 */ }
  const mail = String(row.notes || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (mail) return mail[0].toLowerCase();
  return String(row.source || '').toLowerCase();
}

function learnFromRow(row, action) {
  const key = learningKeyOf(row);
  const { learning, changed } = recordFeedback(getLearning(), { action, key, label: key });
  setLearning(learning);
  return changed;
}

// ---------- 信息筛选：语义兜底（P2）----------
// 只对"规则拿不准"的中间带条目、且**只在非高峰**批处理 —— 花模型调用的事排到半价时段。
let lastSemanticRun = 0;

async function runSemanticBatch({ force = false } = {}) {
  const profile = effectiveProfile();
  const band = bandLabel(new Date(), peakPrefs());
  if (profile.semantic !== 'batch' && !force) {
    return { ok: false, skipped: 'disabled', band, hint: '在「我关心什么」里把语义兜底设为「非高峰自动跑」' };
  }
  if (!force && isPeak(new Date(), peakPrefs())) {
    return { ok: false, skipped: 'peak', band, hint: '现在是高峰时段，按设计留到非高峰再跑' };
  }
  const rows = store.listPending().filter((r) => r.verdict === 'review').slice(0, MAX_ITEMS_PER_RUN);
  if (!rows.length) return { ok: true, band, judged: 0, pushed: 0, dropped: 0, hint: '没有拿不准的条目' };

  let reply = '';
  try {
    const agentReply = await askAgent(buildSemanticPrompt(profile, rows));
    if (!agentReply.ok) return { ok: false, band, error: agentReply.error, hint: '模型没配好也不影响其它功能（可在「数据源 → Agent 接入」里配置）' };
    reply = agentReply.text;
  } catch (e) {
    return { ok: false, band, error: String(e.message || e), hint: 'agent 调用失败（没装/没登录也不影响其它功能）' };
  }
  const results = parseSemanticReply(reply);
  const applied = applySemanticResults(rows, results);
  let pushed = 0;
  let dropped = 0;
  for (const item of applied) {
    const row = item.item;
    const updated = store.updateConnectorVerdict(row.id, {
      verdict: item.verdict, score: item.score, reasons: item.reasons,
    });
    if (item.verdict === 'push') {
      // 判为"相关"的，直接像你点「批准并推送」那样送进日程/任务/通知
      try {
        store.approveConnectorData(row.id);
        pushed += pushItemToPlanner(updated || row);
      } catch { /* 推送失败不影响裁决记录 */ }
    } else {
      dropped += 1;
    }
  }
  lastSemanticRun = Date.now();
  return {
    ok: true, band, candidates: rows.length, judged: applied.length, pushed, dropped,
    notes: applied.map((a) => ({ title: String(a.item.title || '').slice(0, 60), verdict: a.verdict, why: a.reasons[0].note })),
  };
}

function autoSyncDue() {
  const cfg = getAutoSync();
  if (!cfg.enabled) return false;
  const now = new Date();
  // 到点即触发；如果应用当时没开，开门后当天补跑一次（原来要求精确命中那一分钟）。
  const [h, m] = String(cfg.time || '08:00').split(':').map((x) => parseInt(x, 10) || 0);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (now < target) return false;
  const today = todayKey(now);
  const lastDay = cfg.last_run ? todayKey(new Date(cfg.last_run)) : null;
  if (lastDay === today) return false; // already run today
  return true;
}

// ---------- Canvas 巡检（后台常驻时每 3 小时跑一次，发现新条目就弹 Windows 通知） ----------
const SERVER_START_TS = Date.now();
const CANVAS_WATCH_DEFAULT = {
  enabled: true, interval_hours: 3, last_run: null, last_error: null, last_result: null,
};

function getCanvasWatch() {
  const raw = store.getSync('canvas_watch');
  if (raw) {
    try { return { ...CANVAS_WATCH_DEFAULT, ...JSON.parse(raw) }; } catch { /* ignore */ }
  }
  return { ...CANVAS_WATCH_DEFAULT };
}

function setCanvasWatch(cfg) {
  store.setSync('canvas_watch', JSON.stringify(cfg));
  return getCanvasWatch();
}

// 用独立进程弹一个 Windows 通知气泡；中文用 -EncodedCommand(UTF-16LE) 传递，避免编码问题。
function showWindowsBalloon(title, message) {
  if (process.platform !== 'win32') return;
  const iconPath = join(__dir, 'app.ico').replace(/'/g, "''");
  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''").replace(/\r?\n/g, ' ');
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$ni = New-Object System.Windows.Forms.NotifyIcon',
    `if (Test-Path '${iconPath}') { $ni.Icon = New-Object System.Drawing.Icon('${iconPath}') } else { $ni.Icon = [System.Drawing.SystemIcons]::Information }`,
    `$ni.BalloonTipTitle = '${esc(title).slice(0, 120)}'`,
    `$ni.BalloonTipText = '${esc(message).slice(0, 600)}'`,
    '$ni.Text = "Codex Planner"',
    '$ni.Visible = $true',
    '$ni.ShowBalloonTip(15000)',
    'Start-Sleep -Seconds 18',
    '$ni.Dispose()',
  ].join('\n');
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    // windowsHide：只写 -WindowStyle Hidden 时，控制台窗口仍会先被创建再隐藏（会闪一下）
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', b64],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { /* ignore */ }
}

// 拉一次 Canvas，把新条目写进「通知」，并弹系统通知。
async function runCanvasWatch() {
  const cfg = getCanvasWatch();
  const nowIso = new Date().toISOString();
  if (!cfg.enabled) return { skipped: 'disabled' };

  const conn = getConnector('canvas');
  const conf = JSON.parse(store.getConnector('canvas')?.config_json || '{}');
  if (!conn || !conf.base_url || !conf.token) {
    setCanvasWatch({ ...cfg, last_run: nowIso, last_result: { added: 0, total: 0, note: '未配置 Canvas 令牌' } });
    console.log('[canvas-watch] 跳过：尚未配置 Canvas 域名或令牌');
    return { skipped: 'no-config' };
  }

  try {
    const result = await conn.fetchAll(conf);
    let added = 0;
    const fresh = [];
    // 新文件（含页面里链出去的隐藏文件、模块资料文件）走「下载 → 办公本 / 邮件」这条路，
    // 不再发 Bark 推送（用户 2026-09-15 要求）；其它动态照旧推送。
    const fileItems = [];
    const csCfg = getCourseSync();
    for (const it of result.items) {
      const norm = normalizeForStore(it, 'canvas');
      const dl = it.download;
      if (dl && dl.url) {
        const q = queueCanvasFile({
          externalId: dl.external_id || it.external_id,
          course: it.course || conf.name || '',
          courseCode: it.course_code || '',
          filename: dl.filename,
          url: dl.url,
          size: dl.size,
          // 材料在 Canvas 上的日期 → 文件名里的 Week 段（见 lib/naming.mjs）
          when: it.due_at || it.start_at || null,
          log: (m) => console.log(m),
        });
        if (q.row) {
          fileItems.push({ norm, rowId: q.row.id, queued: q.queued });
          continue; // 通知稍后带上「下载结果」一起建
        }
      }
      if (pushItemToNotification({ source: 'canvas', ...norm })) { added += 1; fresh.push(norm); }
    }

  // 下载新材料，并按「办公本是否连着」决定推进设备还是交给邮件桥发信。
    // 这一步（下载 + MTP 拷贝）可能要好几分钟，所以放到后台跑，不阻塞提醒循环。
    if (fileItems.length) {
      kickCourseSync('canvas', fileItems.map((f) => store.getCourseFile(f.rowId)).filter(Boolean));
      for (const f of fileItems) {
        const row = store.getCourseFile(f.rowId) || {};
        const suffix = row.status === 'downloaded'
          ? `\n📥 已下载到：${row.rel_path || row.filename}`
          : row.status === 'error'
            ? `\n⚠️ 下载失败：${row.error || '未知原因'}`
            : '\n📥 正在下载到桌面课程资料…';
        // 默认不推 Bark（用户要求：新文件改走「下载 + 办公本 / 邮件」，不再刷手机推送）
        const norm = { ...f.norm, notes: `${f.norm.notes || ''}${suffix}`, no_bark: !csCfg.bark_for_files };
        if (pushItemToNotification({ source: 'canvas', ...norm })) { added += 1; fresh.push(norm); }
      }
    }

    const watchResult = { added, total: result.items.length, raw: result.raw || null, at: nowIso };
    if (fileItems.length) watchResult.course_sync = { queued: fileItems.length, background: true };
    setCanvasWatch({ ...cfg, last_run: nowIso, last_error: null, last_result: watchResult });
    console.log(`[canvas-watch] 拉取完成 ${JSON.stringify(result.raw || {})} 共 ${result.items.length} 条，新增 ${added} 条`);
    if (added > 0) {
      const title = added === 1 ? `Canvas：${fresh[0].title}` : `Canvas 有 ${added} 条新动态`;
      const body = fresh.slice(0, 3).map((f) => {
        const when = f.due_at ? `（${String(f.due_at).slice(0, 16).replace('T', ' ')}）` : '';
        return `· ${f.title}${when}`;
      }).join('  ');
      broadcast({ type: 'canvas-new', count: added, items: fresh.slice(0, 10).map((f) => ({ title: f.title, message: f.notes, url: f.url, due_at: f.due_at })) });
      showWindowsBalloon(title, body);
      console.log(`[canvas-watch] 新增 ${added} 条，已弹出系统通知`);
    } else {
      console.log(`[canvas-watch] 无新增（Canvas 共 ${result.items.length} 条）`);
    }
    return { added, total: result.items.length };
  } catch (e) {
    setCanvasWatch({ ...cfg, last_run: nowIso, last_error: e.message });
    console.error('[canvas-watch] 出错：', e.message);
    return { error: e.message };
  }
}

// 后台巡检是否该跑了：启动 90 秒后先查一次，之后按 interval_hours（默认 3 小时）。
function canvasWatchDue() {
  const cfg = getCanvasWatch();
  if (!cfg.enabled) return false;
  const interval = Math.max(1, Number(cfg.interval_hours) || 3) * 3600000;
  const last = cfg.last_run ? new Date(cfg.last_run).getTime() : 0;
  if (!last) return Date.now() - SERVER_START_TS > 90000;
  return Date.now() - last >= interval;
}

// ---------- 后台状态（/api/health）与开机自启 ----------
// 2026-09-15 修复：快捷方式文件名必须是纯 ASCII。
// 原文件名 'Codex Planner 后台.lnk' 含中文，在本机的代码页下
// WScript.Shell.CreateShortcut().Save() 会把中文写成 '??' 并直接失败
// （server.log 里的 “Unable to save shortcut ... Codex Planner ??.lnk” 就是它），
// 结果开机自启永远装不上。改用 ASCII 名后与代码页无关。
// 2026-09-28：根治了 —— lib/autostart.mjs 改用 Unicode 版 IShellLinkW 写快捷方式，
// 不再碰 WScript.Shell 的 ANSI 代码页，所以现在**路径/参数/备注里的中文都不会再变 '????'**，
// 「启动」文件夹本身在中文路径下（用户名是中文的机器）也能存下来。ASCII 文件名保持不变。
// 开机自启 / 存活看护已搬进 lib/autostart.mjs（Windows 快捷方式 + macOS LaunchAgent）
const autostart = createAutostart({ repoDir: __dir, port: PORT, logPath: join(DATA_DIR, 'launchd.log'), log: (m) => console.log(m) });
const { getAutostartState, setAutostart } = autostart;

// 托盘看门狗（2026-09-28）：托盘自己看不了自己 —— 它一死，服务就**没有看门狗**了
// （实测：当天托盘心跳停了几个小时，服务真崩了的话没人拉）。而服务本身很稳
// （连续 17 小时没重启），所以让它反过来盯着托盘心跳（data/tray.heartbeat）：
// 过期就尝试把托盘重新拉起。从没用过托盘的机器不插手（见 lib/tray-guard.mjs 的规则）。
const trayGuard = createTrayGuard({ dataDir: DATA_DIR, repoDir: __dir, log: (m) => console.log(m) });
trayGuard.start();

function watchNextRun(watch) {
  const interval = Math.max(1, Number(watch.interval_hours) || 3) * 3600000;
  const last = watch.last_run ? new Date(watch.last_run).getTime() : 0;
  return new Date(last ? last + interval : SERVER_START_TS + 90000).toISOString();
}

// 给托盘 / 桌面外壳 / 应用内「后台常驻」卡片共用的健康快照。
function buildHealth() {
  const watch = getCanvasWatch();
  return {
    ok: true,
    app: 'codex-planner',
    pid: process.pid,
    port: PORT,
    node: process.version,
    platform: process.platform,
    started_at: new Date(SERVER_START_TS).toISOString(),
    uptime_sec: Math.round((Date.now() - SERVER_START_TS) / 1000),
    log_path: 'data/server.log',
    canvas_watch: {
      enabled: Boolean(watch.enabled),
      interval_hours: Math.max(1, Number(watch.interval_hours) || 3),
      last_run: watch.last_run || null,
      next_run: watchNextRun(watch),
      last_error: watch.last_error || null,
      last_result: watch.last_result || null,
    },
    autostart: getAutostartState(),
    counts: {
      tasks: store.listTasks().length,
      notifications: store.listNotifications().length,
      pending: store.listPending().length,
    },
    ui: { version: ['index.html', 'app.js', 'styles.css', 'vm-bridge.js'].map((f) => { try { return Math.round(statSync(join(PUB_DIR, f)).mtimeMs); } catch { return 0; } }).join('-') },
    server_time: Date.now(),
  };
}

// ---------- Notification scheduler ----------
/** 读免打扰偏好（{focus_mute,start,end}）；坏了当没设 —— 绝不能因为偏好读不出来就不提醒。 */
function readQuietPref() {
  try { return JSON.parse(store.getSync('pref_quiet') || '{}'); } catch { return {}; }
}

async function notifTick() {
  const now = Date.now();
  // 免打扰（P1 → 2026-09-27 做成可调偏好）：专注时静音 + 安静时段。
  // 命中就不弹、不推手机、**也不标记已触发** —— 免打扰结束后会补弹，不会丢。
  // 例外（2026-09-27 晚）：DDL 最后一档 / 标了「重点」的提醒可以破例，逐条判断（重要KindOf）。
  const quiet = readQuietPref();
  const gate = notifyGate({ quiet, focusRows: store.listFocus() }, now);
  if (gate.defer && process.env.DEBUG_NOTIFY) {
    console.log(`[notify] ${gate.why === 'focus' ? '正在专注' : '安静时段'}：只放"重要例外"的提醒过去（其余攒着）`);
  }
  const list = store.listNotifications();
  const fired = [];
  for (const n of list) {
    if (!n.enabled) continue;
    const t = new Date(n.trigger_at).getTime();
    if (Number.isNaN(t)) continue;
    // 同步进来的历史邮件/课程通知只作为列表信息，不弹系统提醒（它们的时间就是同步时刻）。
    if (isBackfilledConnectorNotif(n)) {
      if (!n.last_fired_at) store.markFired(n.id, new Date().toISOString());
      continue;
    }
    if (process.env.DEBUG_NOTIFY) {
      console.log(`[notify-dbg] id=${n.id.slice(0,8)} trigger=${n.trigger_at} enabled=${n.enabled} t=${t} now=${now} due=${t <= now} repeat=${n.repeat} last=${n.last_fired_at}`);
    }
    // 一次性提醒只触发一次；重复提醒按周期再触发。
    if (t <= now && (!n.last_fired_at || isDueAgain(n, now))) {
      // 免打扰期间：不是"重要的"就攒着（不标记、不弹、不推）；重要的带上例外种类放行。
      const kind = gate.defer ? importantKind(n, quiet) : '';
      if (gate.defer && !kind) continue;
      const firedAt = new Date().toISOString();
      store.markFired(n.id, firedAt);
      fired.push({ ...n, last_fired_at: firedAt, important: kind || undefined });
    }
  }
  // 一次只弹少数几条；批量触发（例如刚同步完）就静默处理，避免刷屏。
  if (fired.length && fired.length <= 3) {
    for (const f of fired) {
      broadcast({ id: f.id, title: f.title, message: f.message, fired_at: f.last_fired_at });
      // 真正到点的提醒同步推到手机（外部同步进来的补录条目不算，它们在下面被跳过）。
      barkNotify({ title: `⏰ ${f.title}`, body: f.message || '', url: f.url || '', level: 'timeSensitive', important: f.important })
        .catch(() => { /* 推送失败不影响提醒本身 */ });
    }
  }
  return fired;
}

// 判断是否「补录型」同步条目：来源是外部同步，且提醒时间≈创建时间（说明是按同步时刻填的）。
function isBackfilledConnectorNotif(n) {
  if (!String(n.source || '').startsWith('connector:')) return false;
  const t = new Date(n.trigger_at).getTime();
  const c = Number(n.created_at) || 0;
  if (!t || !c) return true;
  return Math.abs(t - c) < 3600000;
}

function isDueAgain(n, now) {
  if (!n.repeat || n.repeat === 'none') return false; // 一次性提醒不再重复
  const t = new Date(n.trigger_at).getTime();
  const lastF = n.last_fired_at ? new Date(n.last_fired_at).getTime() : 0;
  const periods = { daily: 86400000, weekly: 604800000, monthly: 30 * 86400000, hourly: 3600000 };
  const p = periods[n.repeat];
  if (!p) return true;
  return now - lastF >= p && now >= t;
}

// ---------- 课程资料同步的日常维护（重试下载 + 补推办公本 + 每日清理） ----------
let LAST_COURSE_MAINT_TS = 0;
const COURSE_MAINT_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟看一次就够了
let COURSE_SYNC_RUNNING = false;

/**
 * 把一轮课程资料同步丢到后台跑。
 * 下载 + MTP 推进办公本可能要几分钟，绝不能卡住 4 秒一次的提醒循环。
 */
function kickCourseSync(trigger, rows = null) {
  if (COURSE_SYNC_RUNNING) {
    console.log('[course-sync] 上一轮还在跑，本次跳过');
    return false;
  }
  COURSE_SYNC_RUNNING = true;
  Promise.resolve()
    .then(() => runCourseSync({ trigger, rows, log: (m) => console.log(m) }))
    .then((r) => {
      console.log(`[course-sync] ${JSON.stringify(r)}`);
      try { updateCourseNotifications(); } catch (e) { console.error('[course-sync] 回写通知失败：', e.message); }
    })
    .catch((e) => console.error('[course-sync] 出错：', e.message))
    .finally(() => { COURSE_SYNC_RUNNING = false; });
  return true;
}

/** 台账里有结果了，就把对应的 Canvas 通知补上「已下载 / 已进办公本」一行。 */
function updateCourseNotifications() {
  const rows = store.listCourseFiles().filter((r) => r.status === 'downloaded' || r.status === 'error');
  if (!rows.length) return 0;
  const list = store.listNotifications();
  let patched = 0;
  for (const row of rows) {
    const n = list.find((x) => x.external_id && (x.external_id === row.external_id
      || String(x.title || '').includes(row.filename)));
    if (!n) continue;
    const base = String(n.message || '')
      .split('\n')
      .filter((line) => !/^[📥📖⚠️]/.test(line.trim()))
      .join('\n')
      .trim();
    const lines = [];
    if (row.status === 'downloaded') {
      lines.push(`📥 已下载到：${row.rel_path || row.filename}`);
      if (row.device_status === 'synced') lines.push(`📖 已同步到办公本：${row.device_name || ''}`);
      else if (row.device_status === 'error') lines.push(`⚠️ 推进办公本失败：${row.device_error || ''}`);
    } else {
      lines.push(`⚠️ 下载失败：${row.error || '未知原因'}`);
    }
    const next = [base, ...lines].filter(Boolean).join('\n');
    if (next !== String(n.message || '')) {
      store.updateNotification(n.id, { message: next });
      patched += 1;
    }
  }
  if (patched) console.log(`[course-sync] 已把 ${patched} 条通知补上同步结果`);
  return patched;
}

async function courseSyncMaintenance({ force = false } = {}) {
  const cfg = getCourseSync();
  if (!cfg.enabled && !cfg.history?.enabled) return { skipped: 'disabled' };
  const now = Date.now();
  if (!force && now - LAST_COURSE_MAINT_TS < COURSE_MAINT_INTERVAL_MS) return { skipped: 'too-soon' };
  LAST_COURSE_MAINT_TS = now;
  const out = {};
  try {
    // 1) 还有没下下来的（上次断网 / 出错）→ 重试
    const rows = store.listCourseFiles();
    const cfgS = getCourseSync();
    const retryable = cfgS.download
      ? rows.filter((r) => r.status !== 'downloaded' && (Number(r.attempts) || 0) < 5)
      : [];
    if (retryable.length) {
      // 交给后台那一轮去下载 + 推进办公本 / 发邮件
      out.retry_started = kickCourseSync('retry');
    }
    // 2) 之前因为没连办公本而没推过去的 PDF：设备一插上就自动补推
    const pendingDevice = store.listCourseFiles()
      .filter((r) => r.status === 'downloaded' && r.device_status !== 'synced' && /\.pdf$/i.test(r.filename));
    if (cfgS.workbook_enabled && pendingDevice.length) {
      out.catch_up_started = kickCourseSync('catch-up');
    }
    // 3) 每天清理超过 N 天的历史记录（自带「今天跑过了 / 还没到点」判断）
    const purged = purgeHistoryNow({ log: (m) => console.log(m) });
    if (purged && purged.total !== undefined) out.purged = purged;
  } catch (e) {
    console.error('[course-sync] 维护出错：', e.message);
    out.error = e.message;
  }
  return out;
}

// 后台心跳：做什么都写在这张清单里（调度本身在 lib/notify-tick.mjs；一个任务炸了不影响其它任务）。
// 加一件"到点自动做的事" = 加一行；D5 的「每日 18:00 开工」就是这么插进来的。
const tick = createTickRunner({
  store, log: (m) => console.log(m), warn: (m) => console.error(m),
  fireReminders: () => notifTick(),
  heartbeat: ({ uptime_minutes }) => {
    const w = getCanvasWatch();
    console.log(`[heartbeat] 运行中 pid=${process.pid} 已运行 ${uptime_minutes} 分钟 · 通知 ${store.listNotifications().length} 条 · 下次 Canvas 巡检 ${watchNextRun(w).slice(0, 16).replace('T', ' ')}`);
  },
  jobs: [
    { name: 'autosync', due: () => autoSyncDue(), run: async () => { const r = await runAutoSync(); return { note: `每日外部数据同步完成：共 ${r.total} 条待批准` }; } },
    { name: 'canvas-watch', due: () => canvasWatchDue(), run: () => runCanvasWatch() },   // 默认每 3 小时一次
    {
      name: 'semantic',
      // 只在非高峰、且确实有"拿不准"的条目时才跑；每 30 分钟最多一次
      due: () => effectiveProfile().semantic === 'batch' && !isPeak(new Date(), peakPrefs())
        && Date.now() - lastSemanticRun > 30 * 60000 && store.listPending().some((r) => r.verdict === 'review'),
      run: async () => {
        const s = await runSemanticBatch();
        return s.ok ? { note: `判了 ${s.judged} 条（放行 ${s.pushed} / 忽略 ${s.dropped}）· ${s.band}` } : { ok: false };
      },
    },
    // 早报（07:00）/ 晚报（21:00）邮件各自开关；正文 = 日程清单 + 最值得先看的 3 条
    {
      name: 'digest',
      due: () => true,                                                                     // 内部自带"到点才发"判断
      run: async () => await sendDueDigests(store, {
        dataDir: DATA_DIR, appName: brandInfo({ dataDir: DATA_DIR }).app_name,
        briefFor: (kind) => digestRoutes.makeBrief(kind),
        log: (m) => console.log(m), warn: (m) => console.error(m),
      }),
    },
    { name: 'autopush', due: () => true, run: async () => await autopushRunner.maybeRun() },   // 默认关；内部 10 分钟节流
    { name: 'preclass', due: () => true, run: () => preclass.runner.maybeRun() },          // 快上课时才真跑；内部 60 秒节流
    {
      name: 'icloud',
      due: () => icloudDue(store),
      run: async () => {
        const r = await syncIcloud(store, { log: (m) => console.log(m) });
        return r.ok ? { note: `日历同步完成：新增/更新 ${r.pushed}，未变 ${r.unchanged}，删除 ${r.deleted}` } : { ok: false, note: `日历同步失败：${r.error}` };
      },
    },
    { name: 'course-sync', due: () => true, run: () => courseSyncMaintenance() },          // 重试下载 / 补推办公本 / 每日清理
    { name: 'backup', due: () => true, run: () => backups.maybeRun() },                    // 到点且库有变化才备；旧的自动清
    { name: 'ddl', due: () => true, run: () => ddl.maybeRun() },                           // DDL 到档位就提醒（每档只响一次）
    { name: 'daily', due: () => daily.status().due.ok, run: () => daily.runOnce({ dryRun: false }) },   // 每日 18:00 开工
  ],
});
tick.start();

// ---------- HTTP helpers ----------
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

function sendJson(res, code, obj) {
  // API 响应**一律不许被缓存**（2026-09-25 踩到：浏览器把"接口还没做时"的那个 404 缓存住了，
  // 后来接口做好了、页面还是拿到旧的 404，表现为"能力清单读出来是空的"）。
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

function notFound(res) { sendError(res, 404, 'Not Found'); }

// ---------- 手机 / 办公本通道：Bark 推送 + 局域网日历订阅 ----------
// 桌面主服务仍然只监听 127.0.0.1；这里单独开一个「只读、带密钥」的小服务给手机用，
// 只暴露日历订阅与今日文本，不暴露应用本身（设置、任务、邮件内容都不在里面）。
let barkWindow = { ts: 0, sent: 0, suppressed: 0 };

// ignoreSource（2026-10-01）：备用通道（/api/local-drop）用它绕过"重点来源"过滤 ——
// 那是一个**故障兜底**通道，`pigeon` 通常不在用户勾的重点来源里，但"邮件坏了"这件事必须能推到你面前。
async function barkNotify({ title, body = '', url = '', level = 'active', force = false, source = '', ignoreSource = false, important = '' }) {
  try {
    if (!force) {
      if (source && !ignoreSource && !barkSourceAllowed(store, source)) return { ok: false, skipped: 'source-filtered' };
      if (!getMobilePrefs(store).bark_key) return { ok: false, skipped: 'no-key' };
      // 免打扰（2026-09-27）：安静时段 / 专注静音期间**不主动推手机**。
      // force=true = 你自己在界面上点"推到手机"，那就照做（人的明确指令优先于偏好）。
      // important = 这条属于哪类"重要例外"（DDL 最后一档 / 重点工作提醒），开着就放行。
      const gate = notifyGate({ quiet: readQuietPref(), focusRows: store.listFocus(), kind: important });
      if (gate.defer) return { ok: false, skipped: gate.why === 'focus' ? 'focus' : 'quiet' };
      const nowMs = Date.now();
      // 一次同步可能带来十几条新通知：前 5 条逐条推，多出来的静默丢弃，避免刷屏。
      if (nowMs - barkWindow.ts > 5 * 60 * 1000) barkWindow = { ts: nowMs, sent: 0, suppressed: 0 };
      if (barkWindow.sent >= 5) { barkWindow.suppressed += 1; return { ok: false, skipped: 'rate-limited' }; }
    }
    const res = await pushBarkNotification(store, { title, body, url, level, force: true });
    if (res.ok && !force) barkWindow.sent += 1;
    if (!res.ok) console.warn(`[bark] 推送失败：${res.error || res.skipped || '未知原因'}`);
    return res;
  } catch (e) {
    console.warn('[bark] 异常：', e.message);
    return { ok: false, error: e.message };
  }
}

// 手机侧的**只读小服务**（另一端口，见 lib/mobile-server.mjs）：这里只创建，启动在下面按设置决定。
const mobileServer = createMobileServer({
  store, mobilePort: MOBILE_PORT, buildIcs, buildDigestText, calendarInfo,
  appName: () => brandInfo({ dataDir: DATA_DIR }).app_name,
  log: (m) => console.log(m), warn: (m) => console.warn(m),
});

// Control the standalone Edge --app window via Win32 (custom title bar buttons).
function controlWindow(action) {
  let doIt;
  if (action === 'min') doIt = "[W]::ShowWindow($p.MainWindowHandle,6)";
  else if (action === 'max') doIt = "[W]::ShowWindow($p.MainWindowHandle,3)";
  else if (action === 'close') doIt = "[W]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)";
  else return Promise.resolve({ error: 'unknown action' });
  const sig = `using System;
using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }`;
  const ps = `Add-Type -TypeDefinition @'\n${sig}\n'@; $p=Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Codex Planner' } | Select-Object -First 1; if($p){ ${doIt}; 'ok' } else { 'no window' }`;
  return new Promise((resolve) => {
    // windowsHide: 不加的话，从无控制台的进程里起 PowerShell 会先建一个控制台窗口
    // （用户会看到"莫名其妙打开一下"；2026-09-19 定位）
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 9000, windowsHide: true }, (err, stdout) => {
      if (err) resolve({ error: err.message, out: String(stdout || '') });
      else resolve({ ok: true, out: String(stdout || '').trim() });
    });
  });
}

// ---------- 壁纸与本地音乐（R2：已搬到 lib/media.mjs）----------
// 这里只保留"接线"：外部依赖一次性传进去，具体实现见 lib/media.mjs（含音乐文件的目录穿越防护）。
const media = createMedia({
  store, repoDir: __dir, dataDir: DATA_DIR,
  streamMedia, sendJson, sendError, notFound, readBody,
});
const {
  scanWallpapers, rescanMusic, getMusic, handleWallpapers,
} = media;
// 本机目录 / 本机工具都能在界面上改：routes/localdirs.mjs 写 paths.json → 这里把新值交给
// 用到它的人（立刻生效，不用重启）—— 壁纸扫描、PDF 取字、PDF 转图各一条。
// 启动时也先按 paths.json 注入一次（环境变量仍然优先，见各模块自己的取值顺序）。
setPdftotextPath(localPath({ envKey: '', configKey: 'pdftotext_path', dataDir: DATA_DIR }));
setRasterizerPath(localPath({ envKey: '', configKey: 'pdftoppm_path', dataDir: DATA_DIR }));
const localDirs = createLocalDirRoutes({
  dataDir: DATA_DIR, sendJson, sendError, readBody,
  log: (m) => console.log(m),
  // 选文件的框（给外部工具用）与选目录的框各走一条
  detectTools: { pdftotext: () => findPdftotext(), pdftoppm: () => findRasterizer() },
  onChanged: (key, value) => {
    if (key === 'wallpaper') media.setWallpaperDir(value);
    if (key === 'pdftotext') setPdftotextPath(value);
    if (key === 'pdftoppm') setRasterizerPath(value);
  },
});
// 每个功能自己的设置（功能页右上角「⚙ 功能设置」抽屉读它）：接口在 lib/routes/function-settings.mjs
const fnSettings = createFunctionSettingsRoutes({ sendJson, sendError, readBody, log: (m) => console.log(m) });

// 邮件 / Canvas / arXiv 的条目统一进「通知」，由每日同步更新（事件仍进「日程」）。
const CONNECTOR_NOTIFY_SOURCES = new Set(['email', 'email_sjtu', 'canvas', 'arxiv']);
// 重点来源（2026-09-27 起**可配**）：默认仍是"学校邮箱 + 课程平台"，别人重点看别的源就自己勾
// （设置 → 偏好）。读写逻辑在 lib/user-prefs.mjs。
const userPrefs = createUserPrefs({ store });
const { peakPrefs, isPrioritySource } = userPrefs;

let dismissedNotifKeys = null;
function isNotifDismissed(source, key) {
  if (!dismissedNotifKeys) dismissedNotifKeys = new Set(store.listDismissedNotificationKeys());
  return dismissedNotifKeys.has(`${source}:${key}`);
}
function rememberNotifDismissed(source, key) {
  if (!dismissedNotifKeys) dismissedNotifKeys = new Set(store.listDismissedNotificationKeys());
  dismissedNotifKeys.add(`${source}:${key}`);
  store.dismissNotificationKey(`${source}:${key}`, source);
}

// 同步来的条目转成「通知」：有未来时间就按那个时间提醒，否则算作今天的通知。
function pushItemToNotification(r) {
  const src = `connector:${r.source}`;
  const rawTime = r.due_at || r.start_at;
  const t = rawTime ? new Date(rawTime).getTime() : NaN;
  const nowMs = Date.now();
  const upcoming = !Number.isNaN(t) && t > nowMs;
  const trigger = upcoming ? new Date(t).toISOString() : new Date(nowMs).toISOString();
  const key = r.external_id ? String(r.external_id) : `${r.title}|${rawTime || ''}`;
  if (isNotifDismissed(r.source, key)) return 0;
  const exists = store.listNotifications().some((n) => n.source === src && n.external_id === key);
  if (exists) return 0;
  store.createNotification({
    title: r.title,
    message: r.notes,
    trigger_at: trigger,
    repeat: 'none',
    source: src,
    external_id: key,
    priority: isPrioritySource(r.source) ? 1 : 0,
    // 点通知可以直接跳到邮件 / Canvas 的内容
    url: r.url || null,
    // 已过时间的条目直接标记为「已触发」，避免一进来就狂弹提醒
    last_fired_at: upcoming ? null : new Date(nowMs).toISOString(),
  });
  // 同步进来的新条目 → 顺手推到手机（默认只推交大邮箱与 Canvas，可在设置里改）。
  // no_bark：课程资料新文件不发 Bark（它们改走「下载 → 办公本 / 邮件」）。
  if (!r.no_bark && (!upcoming || t - nowMs < 6 * 3600 * 1000)) {
    barkNotify({
      title: `${isPrioritySource(r.source) ? '⭐ ' : ''}${r.title}`,
      body: r.notes || (r.source === 'canvas' ? 'Canvas 有新动态' : ''),
      url: r.url || '',
      source: r.source,
      // 重点来源（交大邮箱 / Canvas）算"重要例外"：用户在免打扰里打开 starred 就照推
      important: isPrioritySource(r.source) ? 'starred' : '',
    }).catch(() => { /* ignore */ });
  }
  return 1;
}

// Push a connector/approved item into the planner (event / task / notification).
function pushItemToPlanner(r) {
  const src = `connector:${r.source}`;
  const kind = r.kind;
  if (kind === 'event') {
    if (!r.start_at) return 0;
    const exists = store.listEvents().some((e) => e.title === r.title && e.start_at === r.start_at);
    if (exists) return 0;
    store.createEvent({ title: r.title, notes: r.notes, start_at: r.start_at, end_at: r.end_at, tags: r.source, source: src });
    return 1;
  }
  // 「进通知」的来源：既有硬编码清单（邮箱/Canvas/arXiv），
  // 也允许连接器自己在 meta 里声明 notify: true（通用适配器用这条，不用改这里）
  // r.source 是**实例 id**（可能是 `email#2`）：查连接器定义前先剥成类型
  if (CONNECTOR_NOTIFY_SOURCES.has(instanceType(r.source)) || getConnector(instanceType(r.source))?.meta?.notify === true) {
    return pushItemToNotification(r);
  }
  if (kind === 'task') {
    const exists = store.listTasks().some((t) => t.title === r.title && t.due_at === r.due_at);
    if (exists) return 0;
    store.createTask({ title: r.title, notes: r.notes, due_at: r.due_at, tags: r.source, source: src });
    return 1;
  }
  // reminder
  const trigger = r.due_at || r.start_at;
  if (!trigger) return 0;
  const exists = store.listNotifications().some((n) => n.title === r.title && n.trigger_at === trigger);
  if (exists) return 0;
  store.createNotification({ title: r.title, message: r.notes, trigger_at: trigger, repeat: 'none', source: src });
  return 1;
}

// ---------- Codex 定时任务报告回流（2026-09-16 新增）----------
// 为什么要有这条通路：四个 Codex 定时任务（每日简报 / 跟进监控 / 每周回顾 / 每周兴趣推荐）原本只在
// Codex 里出结果——电脑让给番茄专注、人离开书桌，就等于没跑。现在给它们一个固定的「投递口」：
//   定时任务跑完 → POST http://127.0.0.1:3210/api/automation/report → Planner 收下
//     → ① 写进「通知」页（⭐ 置顶，来源 codex）② 交给本机邮件桥转发到办公本邮箱。
// 为什么由 Planner 转发、而不是让定时任务自己发信：定时任务跑在没有外网的沙箱里（直连一律
// WinError 10013，只有 127.0.0.1 通），而 Planner 是桌面常驻进程，本身有网，也能调用本机的邮件桥。
const AUTOMATION_REPORT_SOURCE = 'codex';
const AUTOMATION_REPORT_MAX_CHARS = 20000;  // 单条正文上限，防止长文把库撑大
const AUTOMATION_FORWARD_PER_DAY = 12;      // 每天最多转发多少封，防止任务刷屏

function automationReportsToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  return store.listNotifications()
    .filter((n) => n.source === AUTOMATION_REPORT_SOURCE && Number(n.created_at) >= startMs).length;
}

function automationReportRecipients() {
  try {
    const prefs = getMobilePrefs(store);
    return String(prefs.digest_to || '').split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// ---------- 把本机文件当附件发到办公本（2026-09-16 新增）----------
// 用途：生成好的交付物（PDF / ics / md / txt）直接进办公本邮箱，不用手动拷来拷去。
// 安全边界：只允许发送白名单目录下的普通文件，且有大小上限——避免这条本机接口被用来外发任意文件。
// 允许作为附件发出的目录（安全白名单）。默认 = 家目录下的 Documents\Codex，
// 不写死某台机器的用户名；要改就设 PLANNER_SEND_ROOTS（多个目录用 ; 分隔）。
const SEND_FILE_HOME = process.env.USERPROFILE || process.env.HOME || '';
const SEND_FILE_ROOTS = (
  process.env.PLANNER_SEND_ROOTS
    ? process.env.PLANNER_SEND_ROOTS.split(';').map((s) => s.trim()).filter(Boolean)
    : [SEND_FILE_HOME ? join(SEND_FILE_HOME, 'Documents', 'Codex') : '']
).filter(Boolean);
const SEND_FILE_MAX_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
};

function contentTypeFor(file) {
  return MIME_BY_EXT[extname(file).toLowerCase()] || 'application/octet-stream';
}

async function sendLocalFileViaMailBridge(body = {}) {
  const input = String(body.path || '').trim();
  if (!input) return { ok: false, error: '缺少 path（要发送的文件路径）' };
  const file = resolve(input);
  if (!existsSync(file)) return { ok: false, error: `文件不存在：${file}` };
  const lower = file.toLowerCase();
  // 2026-09-28：这里原来写死 '\\' —— 在 macOS / Linux 上 `resolve(root) + '\'` 永远拼不出
  // 真实路径，于是这个"只允许发送这些目录"的判断**永远为假**，功能直接不可用（CI 抓到的）。
  // 用 path.sep 之后两个平台都对。
  const allowed = SEND_FILE_ROOTS.some((root) => lower.startsWith(resolve(root).toLowerCase() + sep));
  if (!allowed) {
    return { ok: false, error: `出于安全考虑，只允许发送这些目录下的文件：${SEND_FILE_ROOTS.join(' / ')}` };
  }
  const st = statSync(file);
  if (!st.isFile()) return { ok: false, error: '目标不是普通文件' };
  if (st.size > SEND_FILE_MAX_BYTES) {
    return { ok: false, error: `文件太大（${(st.size / 1048576).toFixed(1)} MB），上限 ${SEND_FILE_MAX_BYTES / 1048576} MB` };
  }

  const recipients = automationReportRecipients();
  const name = basename(file);
  const res = await sendViaMailBridge({
    to: recipients.length ? recipients : undefined,
    subject: String(body.subject || `📄 ${name}`).trim(),
    text: String(body.text || `来自电脑的文件：${name}\n大小：${(st.size / 1024).toFixed(1)} KB\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n`),
    attachments: [{ filename: name, content: readFileSync(file), contentType: contentTypeFor(file) }],
  });
  if (!res.ok) return { ok: false, error: res.error || '发信失败', via: 'mail-bridge', config_path: res.config_path || null };
  console.log(`[send/file] 已发送 ${name}（${(st.size / 1024).toFixed(1)} KB）→ ${(res.to || []).join(', ')}`);
  return {
    ok: true, file, filename: name, size: st.size,
    to: res.to, smtp: res.smtp, bytes: res.bytes,
  };
}

/** 交给本机邮件桥把报告发到办公本；收件人取「数据源 → 手机与办公本」里的投递邮箱。 */
async function forwardAutomationReport({ name, title, text, ranAt }) {
  const recipients = automationReportRecipients();
  let when = String(ranAt || '');
  try { when = new Date(ranAt).toLocaleString('zh-CN', { hour12: false }); } catch { /* 保持原样 */ }
  const res = await sendViaMailBridge({
    to: recipients.length ? recipients : undefined,   // 留空 = 用邮件桥自己的收件人白名单
    subject: `🤖 ${name}｜${title}`,
    text: `${text}\n\n${'-'.repeat(48)}\n`
      + `本邮件由 Planner 交给本机邮件桥转发\n`
      + `来源：Codex 定时任务「${name}」\n`
      + `任务运行时间：${when}\n`
      + `收件人：${recipients.length ? recipients.join(', ') : '邮件桥白名单默认收件人'}\n`,
  });
  return res;
}

async function ingestAutomationReport(b = {}) {
  const id = String(b.id || b.automation_id || 'unknown').trim();
  const name = String(b.name || id).trim();
  const title = String(b.title || '自动化报告').trim();
  const raw = String(b.body || b.message || '').trim();
  if (!raw) return { ok: false, error: '报告正文是空的（body 不能为空）' };

  const ranAt = b.ran_at || b.ranAt || new Date().toISOString();
  const text = raw.length > AUTOMATION_REPORT_MAX_CHARS
    ? `${raw.slice(0, AUTOMATION_REPORT_MAX_CHARS)}\n\n…（正文超过 ${AUTOMATION_REPORT_MAX_CHARS} 字，已截断；完整版见 Codex 会话）`
    : raw;
  // 同一任务、同一分钟只收一次：定时任务重试或重发不会在通知里刷出重复条目。
  const stamp = String(ranAt).slice(0, 16).replace(/[^0-9A-Za-z:-]/g, '');
  const externalId = `auto-${id}-${stamp}`;

  if (isNotifDismissed(AUTOMATION_REPORT_SOURCE, externalId)) {
    return { ok: true, skipped: 'dismissed', external_id: externalId };
  }
  if (store.listNotifications().some((n) => n.source === AUTOMATION_REPORT_SOURCE && n.external_id === externalId)) {
    return { ok: true, skipped: 'duplicate', external_id: externalId };
  }

  const todayBefore = automationReportsToday();
  const nowIso = new Date().toISOString();
  let forward = { ok: false, skipped: 'rate-limited', note: `今天已转发 ${todayBefore} 封（上限 ${AUTOMATION_FORWARD_PER_DAY}）` };
  if (todayBefore < AUTOMATION_FORWARD_PER_DAY) {
    try {
      const r = await forwardAutomationReport({ name, title, text, ranAt });
      forward = r.ok
        ? { ok: true, to: r.to, smtp: r.smtp, bytes: r.bytes }
        : { ok: false, error: r.error || '未知错误', config_path: r.config_path || null };
    } catch (e) {
      forward = { ok: false, error: e.message };
    }
  }

  const mailNote = forward.ok
    ? `📮 已通过邮件桥转发到 ${(forward.to || []).join(', ')}`
    : (forward.skipped === 'rate-limited'
      ? `📮 未转发：${forward.note}`
      : `📮 转发失败：${forward.error}（报告已存进 Planner）`);

  const notif = store.createNotification({
    title: `🤖 ${name}｜${title}`,
    message: `${text}\n\n${'-'.repeat(48)}\n${mailNote}`,
    trigger_at: nowIso,
    repeat: 'none',
    source: AUTOMATION_REPORT_SOURCE,
    external_id: externalId,
    priority: 1,
    url: b.url || null,
    // 补录型条目：直接标记「已触发」，不进系统通知弹窗（与邮件 / Canvas 同步条目同一套规则）。
    last_fired_at: nowIso,
  });

  // 手机推送（默认只推交大邮箱与 Canvas；把 codex 加进 Bark 来源即可一起推）。
  barkNotify({
    title: `🤖 ${name}｜${title}`,
    body: text.slice(0, 180),
    url: b.url || '',
    source: AUTOMATION_REPORT_SOURCE,
  }).catch(() => { /* ignore */ });

  console.log(`[automation] 收到「${name}」的报告（${text.length} 字）；转发：${forward.ok ? '成功' : (forward.skipped || forward.error)}`);
  return { ok: true, notification_id: notif.id, external_id: externalId, chars: text.length, forwarded: forward };
}

// ---------- 凭据脱敏与数据源接口（R2：已搬到 lib/credential-mask.mjs 与 lib/routes/connectors.mjs）----------
// ---------- 本机备用投递口（2026-10-01 新增）----------
// 邮件桥发不出去时，Pigeon 把内容投到本机 Cairn（进「通知」页，可选推手机）。
// 实现与边界见 lib/routes/local-drop.mjs；这里只接线。
const localDrop = createLocalDropRoutes({
  store, sendJson, sendError, readBody, barkNotify,
  log: (m) => console.log(m),
});
// 只保留接线：这两个模块的职责见各自文件头（凭据脱敏是安全边界，单独一个文件便于审阅）。
const connRoutes = createConnectorRoutes({
  store, sendJson, sendError, notFound, readBody,
  listConnectorMeta, getConnector, normalizeForStore,
  describeTestResult, humanizeConnectorError, pushItemToPlanner,
});
const { handleConnectors } = connRoutes;

// ---------- 文档（应用内可读的说明文档，R2 后新增）----------
// 只读仓库 docs/ 下的 .md，渲染成网页；只认 ^[A-Za-z0-9._-]+\.md$，挡目录穿越。
const docsRoutes = createDocsRoutes({
  docsDir: join(__dir, 'docs'),
  sendHtml: (res, code, html) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  },
  sendError,
});

// ---------- 重要性引擎（按未来规划排序）+ 日报 / 晚报：逻辑在 lib/priority.mjs 与 lib/digest.mjs（纯函数）----------
// 两条链路都只读 + 解释，不改变任何现有推送；日报只有你点「推到手机」才会发。
// 注：isPeak 传的是**读偏好后的**版本（2026-09-27 高峰时段可配），两个路由共用同一份口径
const isPeakNow = (d) => isPeak(d || new Date(), peakPrefs());
const priorityRoutes = createPriorityRoutes({ store, sendJson, sendError, readBody, getProfile, getLearning, learningKeyOf, isPeak: isPeakNow, askAgent });
const digestRoutes = createDigestRoutes({
  store, sendJson, sendError, readBody, priority: priorityRoutes, isPeak: isPeakNow, askAgent, getPlan: () => buildPlan(store, { days: 2 }),
  appName: () => brandInfo({ dataDir: DATA_DIR }).app_name, pushBark: (o) => barkNotify({ ...o, force: true }),
});
// ---------- 应用偏好（主题 / 系统通知 / 显示名 / 入门清单）：接口在 lib/routes/prefs.mjs ----------
// 入门清单的"打勾"不看用户点没点过按钮，而是看真实状态：这里把事实折出来（判断逻辑在 lib/onboarding.mjs）。
const onboardingFacts = () => ({
  brand: brandInfo({ dataDir: DATA_DIR }),
  connectors: { configured: store.listConnectors().filter((c) => ['ok', 'demo', 'configured'].includes(String(c.status))).length },
  agent: agentPublic(),
});
const prefsRoutes = createPrefsRoutes({ store, sendJson, readBody, dataDir: DATA_DIR, facts: onboardingFacts });
// ---------- 手机 / 办公本通道（十条路径）：实现在 lib/routes/mobile.mjs ----------
const mobileRoutes = createMobileRoutes({
  store, sendJson, sendError, readBody, dataDir: DATA_DIR, mobilePort: MOBILE_PORT,
  mobileApi: {
    getMobilePrefs, saveMobilePrefs, ensureCalToken, calendarInfo,
    buildDigestText, writeMobileFiles, testIcloud, syncIcloud, sendDigestNow,
  },
  maskMobilePrefs, sanitizeMobilePatch, buildIcs,
  appName: () => brandInfo({ dataDir: DATA_DIR }).app_name,
  briefFor: (kind) => digestRoutes.makeBrief(kind),
  lanServer: mobileServer, barkNotify: (o) => barkNotify(o),
});

// ---------- 重要信息自动推送（默认关；执行逻辑在 lib/autopush-run.mjs，这里只接线）----------
const autopushRunner = createAutopushRunner({ store, priority: priorityRoutes, bark: (o) => barkNotify(o), log: (m) => console.log(m), warn: (m) => console.error(m) });

// ---------- 模块系统：清单 + 跑"再处理功能"（processor）----------
// 默认 **dry-run**；执行能力是注入的（通知进本机通知表 / 推送走既有 Bark 通道，且受来源过滤约束）
// 上课前检查那三块（调度 / 功能的能力 / 接口）一次性装好；runModule 用懒引用避免"鸡生蛋"
const preclass = createPreclassStack({
  store, sendJson, sendError, readBody,
  runModule: (id, opts) => moduleRoutes.runModule(id, opts),
  runsOf: () => (moduleRoutes.readRuns() || {})['preclass-check'] || null,
  log: (m) => console.log(m), warn: (m) => console.warn(m),
});
// 课程辅助（📚）：功能能力 + file 执行能力 + 那一页的接口，全部装在一个 stack 里（主程序只留接线）
const course = createCourseStack({
  dataDir: DATA_DIR, log: (m) => console.log(m), sendJson, sendError, readBody,
  runsOf: () => (moduleRoutes.readRuns() || {})['course-assist'] || null,
  termStart: () => (store.listAcademic() || []).find((a) => a.kind === 'term')?.start_at || null,
  askAgent,                        // 「公式转 LaTeX」用：把 PDF 抽出来的文字还原成 Markdown + LaTeX
});
// 自动备份（审阅反馈 2026-09-24）：VACUUM INTO 快照 + 只留最近 N 份，纯本地、不联网
const backups = createBackupStack({ store, dataDir: DATA_DIR, sendJson, sendError, readBody, log: (m) => console.log(m) });
// DDL 提醒 + 每日 18:00 开工（D5）：引擎/执行能力/接口都在各自 stack 里，主程序只传依赖
const ddl = createDdlStack({ store, sendJson, sendError, readBody, bark: (o) => barkNotify(o), log: (m) => console.log(m) });
const daily = createDailyStack({ store, sendJson, sendError, readBody, dataDir: DATA_DIR, log: (m) => console.log(m), runModule: (id, opts) => moduleRoutes.runModule(id, opts) });
// 给外部 AI agent 的只读数据入口（Qoder 走 MCP、千问办公走授权文件夹），见 bin/cairn-mcp.mjs
const mcp = createMcpStack({ store, sendJson, sendError, readBody, dataDir: DATA_DIR, priority: priorityRoutes, course, log: (m) => console.log(m) });
// 能力宿主（M1 · S4）：把"能力"从三个 stack 里取出来、按登记表装配给功能。
// 两个提供者都传**函数**（懒引用）—— 跟原来 `preclass.extraContext(mod)` 的求值时机一致。
const capabilityHost = createCapabilityHost({
  providers: {
    preclass: () => preclass.extraContext(),
    course: () => course.extraContext(),
    dataDir: DATA_DIR,           // 开发者自写能力的位置（<数据目录>/capabilities/，不改内核）
  },
  log: (m) => console.log(m),
});
const moduleRoutes = createModuleRoutes({
  modulesDir: MODULES_DIR, store, sendJson, sendError, readBody,
  // 给功能的能力（M1 · S4）：**按 lib/capabilities 的登记表装配**，不再手写这两个对象。
  // 功能在 module.json 的 requires.capabilities 里声明了哪几条，ctx 里就有哪几条（S5）。
  extraContext: (mod) => capabilityHost.extraContext(mod),
  // 声明式功能（M2）：图里的节点靠它调能力；产出的 action 照走下面同一套执行器
  capabilities: capabilityHost,
  // 真正动手的三个执行能力（通知 / 手机短句 / 写文件）在 lib/processor-executors.mjs
  executors: createProcessorExecutors({
    store, barkNotify: (o) => barkNotify(o), writeFile: (a) => course.writeFile(a),
    log: (m) => console.log(m),
  }),
  log: (m) => console.log(m),
});
// 能力层（M1 · S3/S6）：只读出口 —— 命令行 `cairn cap list`、可视化搭建、安装预览读的都是它
const capabilityRoutes = createCapabilityRoutes({
  sendJson, sendError,
  listModules: () => moduleRoutes.listModules().modules,
  dataDir: DATA_DIR, readBody,
});
// 能力搭建（M2/M3）：图执行 + 试跑 + 存成新功能，接线收在 flow-stack 里
const flows = createFlowStack({ sendJson, sendError, readBody, modulesDir: MODULES_DIR, capabilities: capabilityHost, log: (m) => console.log(m) });

// ---------- 养成（习惯 / 番茄 / 里程碑）与课表校历（R2：已搬到 lib/routes/study.mjs）----------
// 这里只保留接线：存东西的地方（store）与怎么回话（sendJson…）一次性传进去。
const study = createStudyRoutes({ store, sendJson, sendError, notFound, readBody });
const { computeInsights, handleStudy, handleScheduleData } = study;

// ---------- Routes ----------
async function handleJson(req, res, url) {
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean); // e.g. ['api','tasks','id']
  const method = req.method;

  // API status / full state
  if (p === '/api/state' && method === 'GET') {
    const connMeta = listConnectorMeta();
    // 实例化之后：configs 的 source 是**实例 id**（`rss` / `rss#2`），类型要过 instanceType；
    // counts 仍按类型合计（"这个类型一共收了多少条"），另给一份按实例的。
    const connConfigs = store.listConnectors().map((c) => ({
      ...c, type: instanceType(c.source), config_json: maskConfigJson(instanceType(c.source), c.config_json),
    }));
    const connCounts = {};
    const connCountsByInstance = {};
    for (const m of connMeta) connCounts[m.id] = 0;
    for (const c of store.listConnectors()) {
      const t = instanceType(c.source);
      const n = store.countConnectorData(c.source);
      connCountsByInstance[c.source] = n;
      if (connCounts[t] === undefined) connCounts[t] = 0;
      connCounts[t] += n;
    }
    return sendJson(res, 200, {
      tasks: store.listTasks(),
      events: store.listEvents(),
      // 「重点」按当前偏好现算（改设置立刻生效）；只重算数据源来的，别覆盖 DDL / Codex 自带的优先级
      notifications: store.listNotifications().map((n) => {
        const src = String(n.source || '');
        if (!src.startsWith('connector:')) return n;
        const priority = isPrioritySource(src.slice(10)) ? 1 : 0;
        return priority === (n.priority || 0) ? n : { ...n, priority };
      }),
      codex: getCodexSnapshot(),
      codex_home: currentCodexHome(),
      brand: brandInfo({ dataDir: DATA_DIR }),
      profile: getProfile(),
      agent: agentPublic(),
      // 本机路径（壁纸引擎 / 邮件桥目录）不写死在代码里，由 data\paths.json 提供
      paths: {
        mail_bridge_dir_default: localPath({ envKey: 'MAIL_BRIDGE_DIR', configKey: 'mail_bridge_dir', dataDir: DATA_DIR }),
        wallpaper_configured: Boolean(media.WALLPAPER_DIR),
      },
      profile_learned: (() => {
        const l = getLearning();
        const rules = learnedRules(l);
        return { enabled: l.enabled, notes: rules.notes, deny: rules.denySenders, allow: rules.allowSenders };
      })(),
      connectors: { meta: connMeta, configs: connConfigs, counts: connCounts, counts_by_instance: connCountsByInstance },
      // 学生特化：界面据此在页头显示"第 N 周 / 共 M 周 · 考试周"
      semester: semesterInfo((() => {
        try { return JSON.parse(store.getSync('pref_semester') || '{}'); } catch { return {}; }
      })()),
      // 学生卡片：未交作业 / 今天的课 / 考试周 / 学期进度（只在学生模式下由界面显示）
      student_view: buildStudentView({
        semester: semesterInfo((() => {
          try { return JSON.parse(store.getSync('pref_semester') || '{}'); } catch { return {}; }
        })()),
        courses: store.listCourses(),
        connectorRows: store.listConnectorData(),
        tasks: store.listTasks(),
      }),
      courses: store.listCourses(),
      academic: store.listAcademic(),
      habits: store.listHabits(),
      habit_logs: store.listHabitLogs(),
      focus: store.listFocus(),
      milestones: store.listMilestones(),
      insights: computeInsights(),
      auto_sync: getAutoSync(),
      canvas_watch: getCanvasWatch(),
      course_sync: (() => {
        const cfg = getCourseSync();
        const rows = store.listCourseFiles();
        return {
          config: cfg,
          root_label: courseRootLabel(cfg.root), name_template: courseFileNameTemplate(),   // 放在哪 / 叫什么名 的生效值
          counts: {
            files: rows.length,
            downloaded: rows.filter((r) => r.status === 'downloaded').length,
            failed: rows.filter((r) => r.status === 'error').length,
            pending_device: rows.filter((r) => r.status === 'downloaded' && r.device_status !== 'synced' && /\.pdf$/i.test(r.filename)).length,
            on_device: rows.filter((r) => r.device_status === 'synced').length,
          },
          files: rows.slice(0, 30),
        };
      })(),
      mobile: (() => {
        const readJson = (k) => { try { const raw = store.getSync(k); return raw ? JSON.parse(raw) : null; } catch { return null; } };
        const lastDigest = readJson(MOBILE_KEYS.digest_result);
        const lastDigestEvening = readJson(MOBILE_KEYS.digest_evening_result);
        const lastIcloud = readJson(MOBILE_KEYS.icloud_result);
        return {
          prefs: maskMobilePrefs(getMobilePrefs(store)),
          calendar: calendarInfo(store, { port: MOBILE_PORT }),
          mobile_dir_default: join(DATA_DIR, 'mobile'),
          last_digest: lastDigest,
          last_digest_evening: lastDigestEvening,
          last_icloud: lastIcloud,
        };
      })(),
      health: buildHealth(),
      pending: store.listPending(),
      plan_export: lastPlanExport,
      music: getMusic(),
      server_time: Date.now(),
    });
  }

  // ---------- 计划导出(给 Codex 读取) ----------
  if (p === '/api/plan' && method === 'GET') return sendJson(res, 200, getPlanSnapshot());
  // ---- 重要性引擎（按未来规划排序）与"我的未来规划" ----
  if (p === '/api/priority' || p === '/api/plan/goals' || p === '/api/priority/advice') {
    return priorityRoutes.handlePriority(req, res, url);
  }
  if (p === '/api/priority/autopush') return priorityRoutes.handlePriority(req, res, url);   // 自动推送设置
  if (p === '/api/priority/autopush/run' && method === 'POST') {
    const body = await readBody(req);   // 默认按当前设置真跑；{"dry":true} 只预览
    return sendJson(res, 200, await autopushRunner.run({ force: body?.force === true, dry: body?.dry === true }));
  }
  // ---- 日报 / 晚报（复用同一套排序；只有你点「推到手机」才会发）----
  if (p === '/api/digest' || p.startsWith('/api/digest/')) return digestRoutes.handleDigest(req, res, url);
  // ---- 计划导出的四种格式，都能直接预览/下载（2026-09-28）----
  // `/api/plan.md`（老链接，浏览器里点「预览 Markdown」用的）、`/api/plan.json`、
  // `/api/plan.ics`（导进日历）、`/api/plan.csv`（导进表格）。
  // `?download=1` 会带上文件名，点一下就是下载而不是在浏览器里打开。
  if (/^\/api\/plan\.(md|json|ics|csv)$/.test(p) && method === 'GET') {
    const fmt = p.slice('/api/plan.'.length);
    const plan = getPlanSnapshot();
    const body = fmt === 'md' ? planToMarkdown(plan)
      : fmt === 'json' ? JSON.stringify(plan, null, 2)
        : fmt === 'csv' ? planToCsv(plan)
          : (buildIcs(store, { pastDays: 0, futureDays: 14 }).ics || '');
    const type = fmt === 'md' ? 'text/markdown; charset=utf-8'
      : fmt === 'json' ? 'application/json; charset=utf-8'
        : fmt === 'csv' ? 'text/csv; charset=utf-8'
          : 'text/calendar; charset=utf-8';
    const head = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    if (url.searchParams.get('download')) {
      head['Content-Disposition'] = `attachment; filename="${PLAN_FILE_NAMES[fmt] || `daily-plan.${fmt}`}"`;
    }
    res.writeHead(200, head);
    return res.end(body);
  }
  // 「导出格式有哪几种可选」：界面照它画勾选框（就一处声明，不写第二份）
  if (p === '/api/plan/formats' && method === 'GET') {
    return sendJson(res, 200, {
      schema: 'plan-formats.v1',
      current: planExportFormats(),
      options: Object.keys(PLAN_FILE_NAMES).map((value) => ({ value, label: PLAN_FORMAT_LABELS[value] || value, file: PLAN_FILE_NAMES[value] })),
    });
  }
  if (p === '/api/plan/export' && method === 'POST') return sendJson(res, 200, exportPlanNow());
  if (p === '/api/plan/export' && method === 'GET') return sendJson(res, 200, lastPlanExport || exportPlanNow());

  // ---------- 统一状态契约（P1-8，见 contracts/app-status.v1.schema.json） ----------
  if (p === '/api/status' && method === 'GET') {
    let courseSync = null;
    try { courseSync = await courseSyncStatus(); } catch { /* 状态查询失败不影响整体 */ }
    return sendJson(res, 200, buildPlannerAppStatus(buildHealth(), {
      courseSync, planExport: lastPlanExport, version: 'Vol.2.4',
      schemaInfo: store.migrationState(),
    }));
  }

  // ---------- 自服务重启（P1-9）----------
  // 目的：改了服务端代码后需要重启，但「重启进程」在沙箱里要提权，于是每次都变成
  // 一次打扰。托盘本来就每 20 秒探活、掉线自动拉起，所以这里只要主动退出即可：
  // 进程退出 → 看门狗在 20 秒内用**新代码**重新拉起。
  // 安全：服务只监听 127.0.0.1，外部访问不到；最坏情况也只是本机把服务重启一次。
  if (p === '/api/admin/restart' && method === 'POST') {
    sendJson(res, 200, {
      ok: true, restarting: true, pid: process.pid,
      note: '托盘看门狗会在 20 秒内用新代码重新拉起服务',
    });
    setTimeout(() => { try { process.exit(0); } catch { /* ignore */ } }, 400);
    return;
  }

  // ---------- 数据出口（P1-5，契约见 contracts/planner-*.v1.schema.json） ----------
  if (p === '/api/export/notifications' && method === 'GET') {
    const q = new URL(req.url, `http://${req.headers.host}`).searchParams;
    return sendJson(res, 200, buildNotificationsExport(store, {
      source: q.get('source') || null,
      days: Number(q.get('days') || 7),
      limit: Number(q.get('limit') || 200),
    }));
  }
  if (p === '/api/export/snapshot' && method === 'GET') {
    const q = new URL(req.url, `http://${req.headers.host}`).searchParams;
    return sendJson(res, 200, buildSnapshotExport(store, {
      days: Number(q.get('days') || 7),
      staleAfterHours: Number(q.get('stale_after_hours') || 24),
    }));
  }

  // ---------- 本地音乐（R2：已搬到 lib/media.mjs；列表 / 扫描 / 流式播放都在那边）----------
  if (p.startsWith('/api/music')) return media.handleMusic(req, res, url);
  // ---------- Canvas 后台巡检（每 3 小时） ----------
  if (p === '/api/canvas-watch' && method === 'GET') {
    const conf = JSON.parse(store.getConnector('canvas')?.config_json || '{}');
    const watch = getCanvasWatch();
    return sendJson(res, 200, {
      config: watch,
      next_run: watchNextRun(watch),
      canvas_configured: Boolean(conf.base_url && conf.token),
      server_started_at: new Date(SERVER_START_TS).toISOString(),
      server_pid: process.pid,
    });
  }
  if (p === '/api/canvas-watch' && method === 'POST') {
    const b = await readBody(req);
    const cur = getCanvasWatch();
    const next = {
      ...cur,
      enabled: b.enabled != null ? Boolean(b.enabled) : cur.enabled,
      interval_hours: b.interval_hours != null ? Math.max(1, Number(b.interval_hours) || 3) : cur.interval_hours,
    };
    return sendJson(res, 200, { config: setCanvasWatch(next) });
  }
  if (p === '/api/canvas-watch/run' && method === 'POST') {
    return sendJson(res, 200, { result: await runCanvasWatch(), config: getCanvasWatch() });
  }
  // ---------- 课程资料自动同步（Canvas 新文件 → 桌面课程资料 → 办公本 X5 / 邮件桥发信） ----------
  if (p === '/api/course-sync' && method === 'GET') {
    return sendJson(res, 200, await courseSyncStatus({ probeDevice: url.searchParams.get('device') === '1' }));
  }
  if (p === '/api/course-sync' && method === 'POST') {
    const b = await readBody(req);
    return sendJson(res, 200, { config: setCourseSync(b || {}) });
  }
  if (p === '/api/course-sync/run' && method === 'POST') {
    const b = await readBody(req);
    if (b && b.config) setCourseSync(b.config);
    const result = await runCourseSync({ trigger: 'manual', log: (m) => console.log(m) });
    return sendJson(res, 200, { result, status: await courseSyncStatus({ probeDevice: true }) });
  }
  if (p === '/api/course-sync/device' && method === 'POST') {
    const b = await readBody(req);
    if (b && b.config) setCourseSync(b.config);
    const cfg = getCourseSync();
    return sendJson(res, 200, await listWorkbookContainer({ pattern: cfg.device_pattern, container: cfg.workbook_container }));
  }
  if (p === '/api/course-sync/folder' && method === 'POST') {
    const b = await readBody(req);
    const cfg = getCourseSync();
    const r = resolveCourseDir(cfg, { courseCode: b?.course_code || '', course: b?.course || '' });
    return sendJson(res, 200, { ...r, root: cfg.root });
  }
  // 统一命名：FA26_<课程号>_<去掉教授课程号的文件名>（桌面 + 办公本）
  if (p === '/api/course-sync/rename' && method === 'POST') {
    const b = await readBody(req);
    if (b && b.config) setCourseSync(b.config);
    // 改名期间先占住「课程资料同步」的坑，避免后台那轮同时往设备推材料
    const wasRunning = COURSE_SYNC_RUNNING;
    COURSE_SYNC_RUNNING = true;
    let report;
    try {
      report = await normalizeCourseNames({
        dryRun: !!b?.dry_run,
        includeDevice: b?.device !== false,
        log: (m) => console.log(m),
      });
    } finally {
      COURSE_SYNC_RUNNING = wasRunning;
    }
    if (!b?.dry_run) {
      try { updateCourseNotifications(); } catch (e) { console.error('[course-sync] 回写通知失败：', e.message); }
    }
    return sendJson(res, 200, report);
  }
  if (p === '/api/course-sync/mail-bridge-test' && method === 'POST') {
    const b = await readBody(req);
    if (b && b.config) setCourseSync(b.config);
    const cfg = getCourseSync();
    const r = await testMailBridge({
      dir: (b && b.mail_bridge_dir) || cfg.mail_bridge_dir,
      send: !!(b && b.send),
      subject: '🧪 Planner 邮件通道测试',
      text: `Planner 正在通过本机邮件桥发信。\n如果你在办公本 / 手机邮箱里看到这封邮件，说明「未连接办公本 → 发邮件」这条链路是通的。\n发送时间 ${new Date().toLocaleString('zh-CN')}`,
    });
    return sendJson(res, 200, r);
  }
  if (p === '/api/history/purge' && method === 'POST') {
    const b = await readBody(req);
    if (b && b.config) setCourseSync({ history: b.config });
    return sendJson(res, 200, purgeHistoryNow({ force: true, log: (m) => console.log(m) }));
  }
  // ---------- 后台状态 / 开机自启（托盘、桌面外壳、应用内幕面板共用） ----------
  if (p === '/api/health' && method === 'GET') return sendJson(res, 200, buildHealth());
  if (p === '/api/autostart' && method === 'GET') return sendJson(res, 200, getAutostartState());
  if (p === '/api/autostart' && method === 'POST') {
    const b = await readBody(req);
    const cur = getAutostartState();
    const want = b.enabled == null ? !cur.enabled : Boolean(b.enabled);
    return sendJson(res, 200, await setAutostart(want));
  }
  // （/api/music 的三个接口已在上面的「本地音乐」处统一交给 lib/media.mjs）
  // Codex connect / refresh
  if (p === '/api/codex/connect' && method === 'POST') {
    const body = await readBody(req);
    if (body.home) store.setSync('codex_home', body.home);
    const result = syncCodex();
    return sendJson(res, 200, result);
  }

  // Codex snapshot
  if (p === '/api/codex' && method === 'GET') {
    return sendJson(res, 200, getCodexSnapshot());
  }
  // ---------- Codex 定时任务报告回流 ----------
  // 定时任务跑完把简报 POST 到这里；见 ingestAutomationReport() 的说明。
  if (p === '/api/automation/report' && method === 'POST') {
    const b = await readBody(req);
    try {
      return sendJson(res, 200, await ingestAutomationReport(b));
    } catch (e) {
      console.log('[automation] 报告接收失败：', e.message);
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  // 本机备用投递口（2026-10-01）：邮件桥发不出去时，Pigeon 把内容送到这里 → 进「通知」页。
  // 实现在 lib/routes/local-drop.mjs（GET = 就绪探测，POST = 投递）。
  if (p === '/api/local-drop') return localDrop.handleLocalDrop(req, res, url);
  if (p === '/api/automation/reports' && method === 'GET') {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 10) || 10));
    const rows = store.listNotifications()
      .filter((n) => n.source === AUTOMATION_REPORT_SOURCE)
      .slice(0, limit)
      .map((n) => ({
        id: n.id, title: n.title, external_id: n.external_id,
        created_at: n.created_at,
        created_at_text: new Date(Number(n.created_at)).toLocaleString('zh-CN', { hour12: false }),
        message: n.message,
      }));
    return sendJson(res, 200, { count: rows.length, reports: rows, forwarded_today: automationReportsToday() });
  }
  // 把本机文件当附件发到办公本（交给本机邮件桥）；见 sendLocalFileViaMailBridge()。
  if (p === '/api/send/file' && method === 'POST') {
    const b = await readBody(req);
    try {
      return sendJson(res, 200, await sendLocalFileViaMailBridge(b));
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  // Ask Codex (in-app chat)
  if (p === '/api/codex/ask' && method === 'POST') {
    const b = await readBody(req);
      const result = await askAgent(String(b.prompt || '').slice(0, 12000));
    return sendJson(res, 200, result);
  }
  // ---------- Connectors (飞书 / Canvas / 邮箱) ----------
  if (p.startsWith('/api/connectors')) {
    return handleConnectors(req, res, url);
  }

  // ---------- Auto-sync (daily external supplement) ----------
  if (p === '/api/sync' && method === 'GET') {
    return sendJson(res, 200, getAutoSync());
  }
  // ---------- 信息筛选：画像 ----------
  // ---------- 模块系统（W2）----------
  // ---------- 模块系统（清单 + 跑一个 processor）：接口在 lib/routes/modules.mjs ----------
  if (p === '/api/modules' || p.startsWith('/api/modules/')) return moduleRoutes.handleModules(req, res, url);
  if (p === '/api/capabilities' || p.startsWith('/api/capabilities/')) return capabilityRoutes.handleCapabilities(req, res, url);
  if (p === '/api/flows' || p.startsWith('/api/flows/')) return flows.routes.handleFlows(req, res, url);
  // ---------- 上课前 Canvas 检查（设置 + 状态）：接口在 lib/routes/preclass.mjs ----------
  if (p === '/api/preclass') return preclass.routes.handlePreclass(req, res, url);
  // ---------- 本机目录（壁纸目录 / 课程资料目录）：接口在 lib/routes/localdirs.mjs ----------
  if (p === '/api/localdirs' || p.startsWith('/api/localdirs/')) return localDirs.handleLocalDirs(req, res, url);
  if (p === '/api/fn-settings' || p.startsWith('/api/fn-settings/')) return fnSettings.handleFnSettings(req, res, url);
  // ---------- 课程辅助那一页的数据（只读）：接口在 lib/routes/course.mjs ----------
  if (p === '/api/course' || p.startsWith('/api/course/')) return course.routes.handleCourse(req, res, url);
  // ---------- 自动备份（审阅反馈 2026-09-24）：接口在 lib/backup-stack.mjs ----------
  if (p === '/api/backups' || p.startsWith('/api/backups/')) return backups.handleBackups(req, res, url);
  // ---------- DDL 到点提醒（D5）：接口在 lib/ddl-stack.mjs ----------
  if (p === '/api/ddl' || p.startsWith('/api/ddl/')) return ddl.handleDdl(req, res, url);
  // ---------- 每日 18:00 开工（D5）：接口在 lib/daily-stack.mjs ----------
  if (p === '/api/daily' || p.startsWith('/api/daily/')) return daily.handleDaily(req, res, url);
  // ---------- 外部 AI agent 的只读入口（Qoder / 千问办公）：接口在 lib/routes/mcp.mjs ----------
  if (p.startsWith('/api/mcp/')) return mcp.handleMcp(req, res, url);
  if (p === '/api/agent-export') return mcp.handleAgentExport(req, res, url);
  // 两条入口都在这里：①从长期记忆文本一次性导入 ②手动填 / 自动派生
  if (p === '/api/profile' && method === 'GET') {
    const l = getLearning();
    const rules = learnedRules(l);
    return sendJson(res, 200, {
      profile: getProfile(),
      effective: effectiveProfile(),
      learning: { enabled: l.enabled, reject: l.reject, accept: l.accept, applied: l.applied, notes: rules.notes },
      derived: derivedProfile(),
    });
  }
  // 行为学习：清空记录 / 开关
  if (p === '/api/profile/learning' && method === 'POST') {
    const body = await readBody(req);
    if (body && body.clear === true) return sendJson(res, 200, { ok: true, learning: setLearning(clearLearning(getLearning())) });
    if (body && body.enabled === false) return sendJson(res, 200, { ok: true, learning: setLearning({ ...getLearning(), enabled: false }) });
    if (body && body.enabled === true) return sendJson(res, 200, { ok: true, learning: setLearning({ ...getLearning(), enabled: true }) });
    return sendJson(res, 200, { ok: true, learning: getLearning() });
  }
  // 语义兜底：立即跑一次（force 可越过非高峰门禁，供你自己手动触发）
  if (p === '/api/profile/semantic/run' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await runSemanticBatch({ force: Boolean(body && body.force) }));
  }
  // ---------- 通用 agent 接入（W4-3）----------
  if (p === '/api/agent' && method === 'GET') {
    return sendJson(res, 200, { agent: agentPublic() });
  }
  if (p === '/api/agent' && method === 'POST') {
    const body = await readBody(req) || {};
    const patch = { ...(body || {}) };
    // 界面回传的是掩码 → 沿用已存 Key，别把掩码存成 Key
    if (typeof patch.api_key === 'string' && patch.api_key.startsWith('••••')) delete patch.api_key;
    return sendJson(res, 200, { ok: true, agent: agentPublic(setAgent(patch)) });
  }
  if (p === '/api/agent/test' && method === 'POST') {
    // 与 askAgent 共用同一套"该走哪条路"的判断：**测试必须是真调**，
    // 否则会出现"测试说不可用、实际能用"（或反过来）这种最误导人的情况。
    const cfg = effectiveAgentConfig();
    const started = Date.now();
    const startedProvider = cfg.provider;
    if (startedProvider === 'codex-cli') {
      const r = await askCodex('只回复两个字：可用');
      return sendJson(res, 200, {
        ok: r.ok, provider: startedProvider, ms: Date.now() - started,
        message: r.ok ? `本机 Codex CLI 可用（回复：${String(r.text || '').slice(0, 24)}）` : `Codex CLI 调用失败：${String(r.error || '').slice(0, 120)}`,
      });
    }
    const r = await askLlm(cfg, '只回复两个字：可用');
    // 错误与"回复原文"都过一遍脱敏：任何路径下令牌都不该出现在界面上
    return sendJson(res, 200, {
      ok: r.ok, provider: startedProvider, ms: Date.now() - started,
      message: redactToken(
        r.ok ? `${describeLlm(cfg)} 可用（回复：${String(r.text || '').slice(0, 24)}）` : humanizeLlmError(r.error, cfg),
        cfg.api_key,
      ),
      error: r.ok ? undefined : redactToken(String(r.error || '').slice(0, 160), cfg.api_key),
    });
  }
  if (p === '/api/profile' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { ok: true, profile: setProfile(body || {}) });
  }
  if (p === '/api/profile/derive' && method === 'POST') {
    const body = await readBody(req);
    const draft = derivedProfile();
    // preview=true 时只回草稿不动线上；否则保存（enabled 仍由 draft 决定，默认 false）
    if (body && body.preview) return sendJson(res, 200, { ok: true, draft });
    return sendJson(res, 200, { ok: true, profile: setProfile({ ...draft, ...(body || {}) }) });
  }
  if (p === '/api/profile/import' && method === 'POST') {
    const body = await readBody(req);
    const text = String((body && body.text) || '');
    if (!text.trim()) {
      return sendJson(res, 400, { error: '缺少 text：请把长期记忆 / 任意 markdown 文本粘进来' });
    }
    const draft = parseProfileFromText(text);
    // 默认只回草稿（要你确认）；body.save === true 时才落库
    if (body && body.save === true) return sendJson(res, 200, { ok: true, profile: setProfile(draft) });
    return sendJson(res, 200, { ok: true, draft, hint: '确认后带 save:true 再提交一次即可保存' });
  }
  if (p === '/api/sync' && method === 'POST') {
    const body = await readBody(req);
    const cfg = setAutoSync({ ...getAutoSync(), ...body });
    return sendJson(res, 200, cfg);
  }
  if (p === '/api/sync/run' && method === 'POST') {
    const result = await runAutoSync();
    return sendJson(res, 200, result);
  }

  // ---------- Preferences (theme) ----------
  // ---------- 手机 / 办公本同步（十条路径：lib/routes/mobile.mjs）----------
  if (p === '/api/mobile' || p.startsWith('/api/mobile/')) return mobileRoutes.handleMobile(req, res, url);

  // ---------- 应用偏好（主题 / 系统通知 / 显示名 / 入门清单）----------
  if (p === '/api/prefs') return prefsRoutes.handlePrefs(req, res, url);

  // ---------- Custom window controls (self-drawn title bar) ----------
  if (p.startsWith('/api/window/') && method === 'POST') {
    const action = p.split('/').pop();
    const result = await controlWindow(action);
    return sendJson(res, 200, result);
  }

  // ---------- 打开外部链接（通知 → 邮件 / Canvas 内容） ----------
  if (p === '/api/open' && method === 'POST') {
    const body = await readBody(req);
    const target = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(target)) return sendError(res, 400, '只支持 http/https 链接');
    // 2026-09-27：改走跨平台的 openExternalUrl（原来写死 Windows 的 Edge/Chrome 路径 + rundll32，
    // macOS / Linux 上必然失败）。Windows 行为不变：仍优先复用 Edge/Chrome，找不到才用系统默认浏览器。
    const r = await openExternalUrl({ url: target });
    return sendJson(res, 200, { ok: !!r.ok, error: r.error || null, url: target, via: r.via, cmd: r.cmd });
  }

  // ---------- Pending approval ----------
  if (p === '/api/pending' && method === 'GET') {
    return sendJson(res, 200, store.listPending());
  }
  if (p.startsWith('/api/pending/') && method === 'POST') {
    const m = p.match(/\/api\/pending\/([^/]+)\/(approve|delete|push)/);
    if (m) {
      const id = m[1];
      const action = m[2];
    if (action === 'delete') {
      // 删掉一条 = 一次"不想看"的反馈（行要先取出来，删完就没了）
      const row = store.listPending().find((r) => r.id === id) || {};
      const learned = learnFromRow(row, 'delete');
      store.deleteConnectorData(id);
      return sendJson(res, 200, { ok: true, learned });
    }
    const row = store.approveConnectorData(id); // marks approved -> leaves pending
    if (!row) return sendError(res, 404, 'not found');
    const learned = learnFromRow(row, 'approve');
    if (action === 'push') {
  const pushed = pushItemToPlanner(row);
      return sendJson(res, 200, { ok: true, pushed, learned });
    }
    return sendJson(res, 200, { ...row, learned });
    }
    return notFound(res);
  }

  // ---------- 课表 / 校历 ----------
  if (seg[1] === 'courses' || seg[1] === 'academic') {
    return handleScheduleData(req, res, url);
  }

  // ---------- 习惯 / 专注 / 里程碑 / 洞察 ----------
  if (seg[1] === 'habits' || seg[1] === 'focus' || seg[1] === 'milestones' || seg[1] === 'insights') {
    return handleStudy(req, res, url);
  }

// ---------- 壁纸接口（列表 / 预览 / 视频 / 选用）----------
  if (seg[1] === 'wallpapers') {
    return handleWallpapers(req, res, url);
  }

  // Generic resource CRUD
  const resource = seg[1];
  const id = seg[2];
  const table = ['tasks', 'events', 'notifications'].includes(resource) ? resource : null;
  if (!table) return notFound(res);

  if (id && method === 'GET') {
    const row = table === 'tasks' ? store.getTask(id) : table === 'events' ? store.getEvent(id) : store.getNotification(id);
    return row ? sendJson(res, 200, row) : sendError(res, 404, 'not found');
  }

  if (!id && method === 'POST') {
    const body = await readBody(req);
    let row;
    if (table === 'tasks') row = store.createTask(body);
    else if (table === 'events') row = store.createEvent(body);
    else row = store.createNotification(body);
    return sendJson(res, 201, row);
  }

  if (id && method === 'PATCH') {
    const body = await readBody(req);
    const row = table === 'tasks' ? store.updateTask(id, body)
      : table === 'events' ? store.updateEvent(id, body)
        : store.updateNotification(id, body);
    return row ? sendJson(res, 200, row) : sendError(res, 404, 'not found');
  }

  if (id && method === 'DELETE') {
    if (table === 'tasks') store.deleteTask(id);
    else if (table === 'events') store.deleteEvent(id);
    else {
      // 同步来的通知被删掉后，记住它，别在下次同步时又冒出来。
      const n = store.getNotification(id);
      if (n && String(n.source || '').startsWith('connector:') && n.external_id) {
        rememberNotifDismissed(String(n.source).slice('connector:'.length), n.external_id);
      }
      store.deleteNotification(id);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (id === 'test' && method === 'POST' && table === 'notifications') {
    const n = store.getNotification(id);
    if (!n) return sendError(res, 404, 'not found');
    broadcast({ id: n.id, title: n.title, message: n.message, fired_at: new Date().toISOString(), test: true });
    return sendJson(res, 200, { ok: true });
  }

  // notifications/:id/test handled below (resolve `test` as id is ambiguous)
  if (table === 'notifications' && seg[2] && seg[3] === 'test' && method === 'POST') {
    const n = store.getNotification(seg[2]);
    if (!n) return sendError(res, 404, 'not found');
    broadcast({ id: n.id, title: n.title, message: n.message, fired_at: new Date().toISOString(), test: true });
    return sendJson(res, 200, { ok: true });
  }

  return notFound(res);
}

// ---------- Static files（实现在 lib/server-shell.mjs）----------
const serveStatic = createStaticHandler({
  pubDir: PUB_DIR, modulesDir: MODULES_DIR, moduleAssetPath, sendError, notFound,
  log: (m) => console.log(m),
});

// ---------- Server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 5000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p.startsWith('/api/')) {
    try {
      const result = await handleJson(req, res, url);
      // 任何写操作后,刷新给 Codex 的计划导出(计划相关端点除外)
      if (req.method !== 'GET' && !p.startsWith('/api/plan')) { try { exportPlanNow(); } catch { /* ignore */ } }
      return result;
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  // 文档页要在静态文件之前处理：/docs/xxx.md 不是 public/ 里的文件，交给文档路由渲染成网页
  if (p === '/docs' || p.startsWith('/docs/')) {
    if (req.method !== 'GET') return notFound(res);
    return docsRoutes.handleDocs(req, res, url);
  }
  if (req.method === 'GET') return serveStatic(req, res, p);
  return notFound(res);
});

// Run an initial sync so the UI has data instantly (non-fatal if fails).
try { if (currentCodexHome()) syncCodex(); } catch { /* ignore */ }
// 启动即导出一份计划,供 Codex 读取。
try { exportPlanNow(); } catch { /* ignore */ }
// 手机 / 办公本同步：确保订阅密钥存在，并（按设置）打开局域网只读端口。
try {
  ensureCalToken(store);
  if (getMobilePrefs(store).lan_enabled) mobileServer.start();
} catch (e) { console.warn('[mobile] 启动失败：', e.message); }
// 定时刷新(即使没有写操作,也保持导出较新)。
setInterval(() => { try { exportPlanNow(); } catch { /* ignore */ } }, 60000);
// 后台扫描一次本地音乐目录(不阻塞启动)。
setTimeout(() => { try { rescanMusic(); } catch { /* ignore */ } }, 1500);

// 端口被占用（已经有一个 Planner 在后台跑）就干净退出，让守护进程复用现有实例，不要报错崩栈。
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${PORT} 已被占用：已有 Planner 在后台运行，本次启动退出。`);
    process.exit(0);
  }
  console.error('[server] 监听失败：', (e && e.stack) || e);
});

// 只监听本机回环地址：避免同一局域网内其他设备访问到这个个人规划面板
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log(`   Codex Planner 已启动（pid ${process.pid}）`);
  console.log(`   本地地址: http://localhost:${PORT}`);
  console.log(`   Codex 目录: ${currentCodexHome() || '(未检测到)'}`);
  console.log(`   运行日志: ${LOG_PATH}`);
  console.log('');
  purgeStoredCodexThreads();      // 一次性：把以前存进本机库的 Codex 会话记录抹掉（功能已下线）
});

// 心跳由上面那张 jobs 清单自己跑（tick.start()），这里不用再排一轮

// 打开浏览器（只在 OPEN=1 时；实现在 lib/server-shell.mjs）
if (process.env.OPEN === '1') openBrowser({ url: `http://localhost:${PORT}` });

export { server };
