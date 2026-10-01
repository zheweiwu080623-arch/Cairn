// 课程资料自动同步（2026-09-15 新增）
//
// 一条链：Canvas 巡检发现新文件 → 下载到桌面「FA26课程资料\<课程>」→
//   ① 办公本（讯飞 X5）连着  → 把 PDF 推进「书架」（代码文件如 .ipynb / .py / .m 不同步）
//   ② 办公本没连              → 交给本机的邮件桥发一封邮件说明
// 另外：每日清理 Planner 里存在超过 N 天（默认 10 天）的历史记录。
import { existsSync, mkdirSync, readdirSync, statSync, renameSync, rmSync, createWriteStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { store } from './store.mjs';
import { listWorkbookContainer, copyToWorkbook, deleteFromWorkbook, looksPresentOnDevice, normalizeBookName, WORKBOOK_DEFAULT } from './workbook.mjs';
import { sendViaMailBridge, testMailBridge, mailBridgeStatus, MAIL_BRIDGE_DEFAULT_DIR } from './mail-bridge.mjs';
// COLLEGE_CODE：2026-09-27 补进来的 —— `folderCode()` 与"台账指回现存文件"那两处一直在用它，
// 但从来没 import 过（一旦某个文件夹/某一行的课程号为空就 ReferenceError：
// 「统一命名」这条路径上会直接 500）。测试没覆盖到，是这次做就地设置时实测撞出来的。
import { COLLEGE_CODE, DEFAULT_NAME_TEMPLATE, buildCourseFileName, normalizeCourseCode, deviceNameFor, cleanStem, semesterWeek, standardFileNameFor } from './naming.mjs';
import { courseNameTemplate } from './function-settings.mjs';
import { localPath } from './local-config.mjs';
import { decideMail, noteMailSent } from './mail-policy.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PlannerCourseSync/1.0';
const DOWNLOAD_TIMEOUT_MS = 180000;
const MAX_ATTEMPTS = 5;
// 重名 / 内容重复的旧文件挪到这里，不直接删（可随时自己清理）
export const QUARANTINE_DIR = '_重名或重复（可删）';

// 我们自己生成的学习包 / 周总结 / 精华版不进统一命名（否则会被套上 FA26_ 前缀再挪一次）。
// 2026-09-29：用户要求"每周总结同时放 每周总结\\ 与 WeekNN\\"，这两处都得保持原文件名。
const GENERATED_RE = /(学习包|复习包|周总结|精华版|Piazza.*精选)/;
export const isGeneratedArtifact = (name) => GENERATED_RE.test(String(name || ''));

/**
 * 第 n 周 → 周文件夹名 `WeekNN`（两位数，和桌面上已有的 Week01/Week02 对齐）。
 * 2026-09-29（用户要求）："新的一周下载下来新的文件之后新建文件夹装这些文件" ——
 * 课程材料从此按周进 `WeekNN` 子文件夹，课程目录根下不再堆当周文件。
 */
export function weekDirName(week) {
  const n = Number(week);
  return Number.isInteger(n) && n >= 1 ? `Week${String(n).padStart(2, '0')}` : '';
}

/** 这门课的材料要不要按周分文件夹：学院文件（00 学院文件与课程表）不排周次，也就不分。 */
function useWeekFolder(code, week) {
  return code !== COLLEGE_CODE && !!weekDirName(week);
}

/**
 * 撞名时的区分后缀：不同 TA 的 `rc1.pdf`、不同老师的同名讲义都会走到这里。
 * 用 Canvas 文件号（稳定、可回溯）而不是序号，重跑时不会来回改名。
 */
export function disambiguationTag(row) {
  const raw = String(row?.external_id || row?.id || '').replace(/\D/g, '');
  return raw ? `f${raw.slice(-6)}` : '';
}

/** 把 `name.pdf` 变成 `name_<tag>.pdf`。 */
export function withTag(name, tag) {
  if (!tag) return name;
  const m = String(name).match(/^(.*?)(\.[A-Za-z0-9]{1,6})$/);
  return m ? `${m[1]}_${tag}${m[2]}` : `${name}_${tag}`;
}
// 只有这些类型的材料可能出现在办公本上（.md / .zip / .svg / 代码 之类不会被导入）
const DEVICE_FILE_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg', '.txt', '.epub', '.mobi']);

export const COURSE_SYNC_DEFAULT = {
  enabled: true,
  // 默认落在「当前用户的桌面」下，不写死某台机器的用户名
  root: join(homedir(), 'Desktop', 'FA26课程资料'),
  // 新文件：只下载、不发 Bark（用户 2026-09-15 要求）
  download: true,
  bark_for_files: false,
  // 办公本联动
  workbook_enabled: true,
  device_pattern: WORKBOOK_DEFAULT.device_pattern,
  workbook_container: WORKBOOK_DEFAULT.container,
  // 没检测到办公本 → 交给邮件桥发信
  email_enabled: true,
  mail_bridge_dir: MAIL_BRIDGE_DEFAULT_DIR,
  email_to: '',
  email_attach: true,
  email_attach_max_mb: 15,
  last_run: null,
  last_result: null,
  last_device: null,
  // 上次邮件已经汇报过哪些材料（同一个集合不重复发，避免没连办公本时反复轰炸）
  emailed_signature: '',
  last_email_at: null,
  history: {
    enabled: true,
    days: 10,
    time: '04:00',
    notifications: true,
    connector_data: true,
    dismissed: true,
    focus: true,
    done_tasks: false,
    last_purge: null,
    last_result: null,
  },
};

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function stamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function humanSize(n) {
  const b = Number(n) || 0;
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 设置读写 ----------
/** 存过的原始值（不动它 = 不改已经存过的东西；"放在哪"由 courseRoot() 现算）。 */
function rawCourseSync() {
  try {
    const parsed = JSON.parse(store.getSync('course_sync') || 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/**
 * 课程资料放哪 —— **只有这一处判断**（2026-09-27 收敛）：
 *   ① 「本机目录 → 课程资料目录」（和壁纸目录同一套：界面选完立刻生效，不用重启）
 *   ② 老装机写在「课程资料自动同步」自己那个键里的 root（以前那个输入框存的）
 *   ③ 默认：当前用户的桌面 `~/Desktop/FA26课程资料`
 * 返回值不会是空串 —— 下载 / 改名 / 台账都假定它有个目录。
 */
export function courseRoot(cfg = null) {
  const fromLocal = localPath({ envKey: ['PLANNER_COURSE_DIR'], configKey: ['course_dir', 'course_materials_dir'] });
  if (fromLocal) return fromLocal;
  const own = String((cfg && cfg.root) || '').trim();
  if (own) return own;
  return COURSE_SYNC_DEFAULT.root;
}

/** 给人看的位置说法：桌面下的写「桌面 / 名字」，别处写全路径（通知与邮件文案用）。 */
export function courseRootLabel(root = courseRoot()) {
  const r = String(root || '');
  const desktop = join(homedir(), 'Desktop');
  const name = basename(r);
  if (name && r.toLowerCase().startsWith(desktop.toLowerCase())) return `桌面 / ${name}`;
  return r;
}

/** 当前生效的命名模板（用户在「⚙ 功能设置 → 文件怎么命名」里改的那个）。 */
export function courseFileNameTemplate() {
  try { return courseNameTemplate() || DEFAULT_NAME_TEMPLATE; } catch { return DEFAULT_NAME_TEMPLATE; }
}

export function getCourseSync() {
  const raw = rawCourseSync();
  const cfg = { ...COURSE_SYNC_DEFAULT, ...raw };
  cfg.history = { ...COURSE_SYNC_DEFAULT.history, ...(raw.history || {}) };
  cfg.root = courseRoot(cfg);       // 生效值：界面显示的、实际用的都是它
  return cfg;
}

export function setCourseSync(patch = {}) {
  const raw = rawCourseSync();
  const cur = getCourseSync();
  const next = { ...COURSE_SYNC_DEFAULT, ...raw, ...patch };
  if (patch.history) next.history = { ...cur.history, ...patch.history };
  // 这几个只能由程序自己更新，避免界面误改
  next.last_run = cur.last_run;
  next.last_result = cur.last_result;
  next.last_device = cur.last_device;
  next.history.last_purge = cur.history.last_purge;
  next.history.last_result = cur.history.last_result;
  store.setSync('course_sync', JSON.stringify(next));
  return getCourseSync();
}

function saveRuntime(patch = {}) {
  const raw = rawCourseSync();
  const cur = getCourseSync();
  const next = { ...COURSE_SYNC_DEFAULT, ...raw, ...patch };
  if (patch.history) next.history = { ...cur.history, ...patch.history };
  store.setSync('course_sync', JSON.stringify(next));
  return next;
}

// ---------- 课程文件夹 ----------
/** 从 Canvas 的 course_code（如 "(2026-2027-1)-ENGR1010J-03-Intro to ..."）里抠出课程号。 */
export function extractCourseCode(raw) {
  const s = String(raw || '');
  const m = s.match(/([A-Z]{2,6}\d{3,5}[A-Z]?)/);
  if (m) return m[1].toUpperCase();
  if (/undergraduate|学院|教务处/i.test(s)) return '学院文件';
  return '';
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '') || '未命名';
}

function subDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/**
 * 找到（必要时创建）课程对应的桌面文件夹：优先按课程号前缀匹配，
 * 「Undergraduate Students」这类没有课程号的学院文件放进「00 学院文件与课程表」。
 */
export function resolveCourseDir(cfg, { courseCode = '', course = '' } = {}) {
  const root = String(cfg.root || COURSE_SYNC_DEFAULT.root);
  const code = extractCourseCode(courseCode) || extractCourseCode(course);
  const dirs = subDirs(root);
  let folder = '';
  if (code && code !== '学院文件') {
    folder = dirs.find((d) => d.toUpperCase().startsWith(code)) || '';
    if (!folder && course) {
      const zh = String(course).replace(/^\(.*?\)-/, '').trim();
      folder = sanitizeName(`${code} ${zh}`);
    } else if (!folder) {
      folder = code;
    }
  } else {
    folder = dirs.find((d) => /^00[\s_]/.test(d)) || dirs.find((d) => /学院/.test(d)) || '00 学院文件与课程表';
  }
  const abs = join(root, folder);
  try { mkdirSync(root, { recursive: true }); mkdirSync(abs, { recursive: true }); } catch { /* 用不了就报错在下游 */ }
  return { folder, dir: abs, created: !dirs.includes(folder) };
}

// ---------- 下载 ----------
async function downloadOne(row, cfg, log = () => {}) {
  const { dir, folder } = resolveCourseDir(cfg, { courseCode: row.course_code, course: row.course });
  const rawName = sanitizeName(row.filename || basename(String(row.url || 'file')));
  // 统一命名：FA26_<课程号>_Week<n>_<去掉教授自己写的课程号后的文件名>
  // n 取材料在 Canvas 上的日期（入库时记下的 file_date；老记录回退到入库时间）。
  const code = normalizeCourseCode(row.course_code) || normalizeCourseCode(row.course) || '学院文件';
  const week = semesterWeek(row.file_date || row.created_at);
  let filename = buildCourseFileName({
    courseCode: code, filename: rawName, week, course: row.course || '',
    date: row.file_date || row.created_at, template: courseFileNameTemplate(),
  });
  // 按周进子文件夹（2026-09-29）：WeekNN 不存在就现建，之后再下载也落同一处。
  const sub = useWeekFolder(code, week) ? weekDirName(week) : '';
  const destDir = sub ? join(dir, sub) : dir;
  if (sub) { try { mkdirSync(destDir, { recursive: true }); } catch { /* 建不了就退回课程目录 */ } }
  const realDir = existsSync(destDir) ? destDir : dir;
  let dest = join(realDir, filename);
  const relOf = (n) => `${folder}\\${sub ? `${sub}\\` : ''}${n}`;
  if (!row.url) throw new Error('这条记录没有下载链接');
  if (existsSync(dest)) {
    const local = statSync(dest);
    const same = !row.size || Math.abs(local.size - Number(row.size)) < 1;
    if (same) {
      log(`[course-sync] 已存在，跳过下载：${relOf(filename)}`);
      return { id: row.id, path: dest, rel: relOf(filename), size: local.size, reused: true };
    }
    // 同名但内容不同 = 这是另一份材料（典型：不同 TA 的 rc1.pdf）。
    // 绝不能覆盖 —— 加 Canvas 文件号后缀并存（2026-09-29，用户报"四份 RC 被标准化成同名"）。
    const tagged = withTag(filename, disambiguationTag(row));
    if (tagged !== filename) {
      filename = tagged;
      dest = join(realDir, filename);
      log(`[course-sync] 同名不同内容 → 另存为 ${filename}`);
    } else {
      log(`[course-sync] 本地已有同名但大小不同（${local.size} → ${row.size}），重新下载：${relOf(filename)}`);
    }
  }
  const rel = `${folder}\\${sub ? `${sub}\\` : ''}${filename}`;
  // 带 verifier 的 Canvas 下载直链**不能**再带 Authorization 头，否则跳转后的存储地址会 400。
  const res = await fetch(row.url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error('响应没有内容');
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const size = statSync(tmp).size;
    if (!size) throw new Error('下载到的文件是空的');
    renameSync(tmp, dest);
    return { id: row.id, path: dest, rel, size, reused: false };
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** 把台账里还没下载成功的条目下下来（失败会累计 attempts，超过上限就不再自动重试）。 */
export async function downloadPending({ limit = 20, log = () => {} } = {}) {
  const cfg = getCourseSync();
  if (!cfg.download) return { downloaded: [], failed: [], skipped: 'disabled' };
  const rows = store.listCourseFiles().filter((r) => r.status !== 'downloaded' && (Number(r.attempts) || 0) < MAX_ATTEMPTS);
  const downloaded = [];
  const failed = [];
  for (const row of rows.slice(0, limit)) {
    try {
      const r = await downloadOne(row, cfg, log);
      const localName = basename(r.path);
      store.updateCourseFile(row.id, {
        status: 'downloaded', error: null, rel_path: r.rel, abs_path: r.path,
        size: r.size || row.size, downloaded_at: Date.now(),
        // 只有 PDF 会往办公本推；其它类型直接标成 skipped，避免台账里一直显示「待进办公本」
        device_status: /\.pdf$/i.test(localName) ? 'pending' : 'skipped',
        local_name: localName,
      });
      downloaded.push({
        ...row, status: 'downloaded', rel_path: r.rel, abs_path: r.path, size: r.size || row.size,
        local_name: localName,
      });
      log(`[course-sync] 已下载：${r.rel}${r.reused ? '（本机已有）' : `（${humanSize(r.size)}）`}`);
    } catch (e) {
      const attempts = (Number(row.attempts) || 0) + 1;
      store.updateCourseFile(row.id, { status: 'error', error: e.message, attempts });
      failed.push({ ...row, error: e.message, attempts });
      log(`[course-sync] 下载失败：${row.filename} —— ${e.message}`);
    }
  }
  return { downloaded, failed };
}

/**
 * 登记一条 Canvas 新材料（去重：同一个 Canvas 文件只登记一次）。
 * @returns {{queued:boolean, row:object|null}}
 */
export function queueCanvasFile({ externalId, course = '', courseCode = '', filename, url, size = 0, when = null, log = () => {} }) {
  if (!externalId || !filename) return { queued: false, row: null };
  const cfg = getCourseSync();
  if (!cfg.enabled || !cfg.download) return { queued: false, row: null };
  const existing = store.getCourseFileByExternal(externalId);
  if (existing) return { queued: false, row: existing };
  const row = store.createCourseFile({
    external_id: externalId,
    source: 'canvas',
    course,
    course_code: extractCourseCode(courseCode) || extractCourseCode(course),
    filename,
    url,
    size,
    file_date: when ? (new Date(when).getTime() || null) : null,
    status: 'queued',
    device_status: 'pending',
  });
  log(`[course-sync] 新材料入队：${course} · ${filename}`);
  return { queued: true, row };
}

// ---------- 办公本 / 邮件 ----------
function textOfNotYetSynced(rows) {
  const template = courseFileNameTemplate();
  return rows.map((r) => {
    const name = standardFileNameFor(r, { template });
    const where = r.rel_path || name;
    return `  · ${r.course || r.course_code || '课程资料'} / ${name}${r.size ? `（${humanSize(r.size)}）` : ''}\n      电脑位置：${where}`;
  }).join('\n');
}

export function buildCourseMailText({ rows, device, at = new Date(), note = '' }) {
  const pdfs = rows.filter((r) => /\.pdf$/i.test(r.filename));
  const others = rows.filter((r) => !/\.pdf$/i.test(r.filename));
  const L = [];
  L.push(`空庭Coterie 的 Planner · Canvas 新课件 ${ymd(at)} ${hm(at)}`);
  L.push('='.repeat(40));
  L.push(`新下载 ${rows.length} 份课程材料${pdfs.length ? `（其中 PDF ${pdfs.length} 份）` : ''}。`);
  L.push(`办公本：${device?.connected ? `已连接（${device.device || '讯飞 X5'}）` : '本次没检测到连接'}`);
  L.push('');
  L.push('【新材料】');
  L.push(textOfNotYetSynced(rows));
  if (others.length) {
    L.push('');
    L.push(`【不是 PDF 的 ${others.length} 份】办公本只同步 PDF，这些要在这台电脑上看（或直接回复本邮件让邮件桥转发）。`);
  }
  if (note) { L.push(''); L.push(note); }
  L.push('');
  L.push('说明：');
  L.push('  · 办公本（讯飞 X5）插上数据线后，Planner 会自动把课程资料里的 PDF 同步进「书架」；');
  L.push('  · 本邮件由 Planner 交给本机的邮件桥发出；');
  L.push(`  · 材料同时留在电脑的「${courseRootLabel()} / <课程>」里。`);
  return L.join('\r\n');
}

/**
 * 把「已下载但还没进办公本」的 PDF 推到设备；没连设备就交给邮件桥发信。
 */
export async function syncToWorkbookOrMail({ rows = null, force = false, log = () => {} } = {}) {
  const cfg = getCourseSync();
  const all = store.listCourseFiles();
  // 待处理的 PDF：下载成功、还没进办公本
  const pdfRows = (rows || all).filter((r) => r.status === 'downloaded' && /\.pdf$/i.test(r.filename));
  const out = { device: null, synced: [], skipped: [], failed: [], emailed: null };

  let deviceInfo = null;
  if (cfg.workbook_enabled) {
    const listed = await listWorkbookContainer({ pattern: cfg.device_pattern, container: cfg.workbook_container });
    deviceInfo = { connected: !!listed.connected, device: listed.device || null, error: listed.error || null, at: new Date().toISOString() };
    out.device = deviceInfo;
    if (listed.connected && listed.ok) {
      const names = (listed.items || []).map((i) => i.name);
      const pending = [];
      for (const r of pdfRows) {
        // 台账说已同步、且设备上确实还在 → 跳过
        if (r.device_status === 'synced' && r.device_name && names.includes(r.device_name)) continue;
        const abs = r.abs_path || (r.rel_path ? join(cfg.root, r.rel_path) : '');
        if (!abs || !existsSync(abs)) {
          out.failed.push({ filename: r.filename, error: '本机文件不见了' });
          continue;
        }
        const localName = r.local_name || r.filename;
        if (looksPresentOnDevice(names, localName, { courseCode: r.course_code })
          || looksPresentOnDevice(names, r.filename, { courseCode: r.course_code })) {
          store.updateCourseFile(r.id, {
            device_status: 'synced', device_name: r.device_name || '(设备上已有)', synced_at: Date.now(), device_error: null,
          });
          out.skipped.push({ filename: localName, reason: '办公本上已经有了' });
          continue;
        }
        pending.push({ row: r, path: abs, name: basename(abs) });
      }
      if (pending.length) {
        log(`[course-sync] 办公本已连接（${listed.device}），要推 ${pending.length} 份 PDF`);
        // 一次 PowerShell 调用里只推 4 份：MTP 拷大文件慢，分批能让失败/超时互不牵连。
        const CHUNK = 4;
        for (let i = 0; i < pending.length; i += CHUNK) {
          const chunk = pending.slice(i, i + CHUNK);
          const res = await copyToWorkbook(chunk.map((p) => ({ path: p.path, name: p.name })),
            { pattern: cfg.device_pattern, container: cfg.workbook_container });
          const copied = new Map((res.copied || []).map((c) => [c.src, c.device_name]));
          for (const p of chunk) {
            const deviceName = copied.get(p.name);
            if (deviceName) {
              store.updateCourseFile(p.row.id, {
                device_status: 'synced', device_name: deviceName, device_error: null, synced_at: Date.now(),
              });
              out.synced.push({ filename: p.row.filename, device_name: deviceName });
              log(`[course-sync] 已推进办公本：${p.row.filename} → ${deviceName}`);
            } else {
              const f = (res.failed || []).find((x) => x.src === p.name);
              const msg = (f && f.error) || res.error || '未知原因';
              store.updateCourseFile(p.row.id, { device_status: 'error', device_error: msg });
              out.failed.push({ filename: p.row.filename, error: msg });
              log(`[course-sync] 推进办公本失败：${p.row.filename} —— ${msg}`);
            }
          }
        }
      }
    }
  }

  const connectedAndOk = !!(deviceInfo && deviceInfo.connected);
  // 这次真正要汇报的材料：优先用刚下载完的；没有就用「下载好了但还没进办公本」的存量。
  const fresh = (rows || []).filter((r) => r.status === 'downloaded');
  // 存量兜底只看「下载好了但还没进办公本的 PDF」——邮件说的是「办公本上看不到的材料」，
  // 非 PDF（xlsx / ipynb / zip 之类）本来就不往办公本推，不该反复出现在邮件里。
  const list = fresh.length ? fresh : store.listCourseFiles()
    .filter((r) => r.status === 'downloaded' && r.device_status !== 'synced' && /\.pdf$/i.test(r.filename));
  const signature = list.map((r) => r.external_id || r.rel_path || r.filename).sort().join('|');
  const alreadyEmailed = !force && signature && signature === cfg.emailed_signature;
  // 没连上办公本 → 走邮件桥（连上了就不用发，材料已经在设备上了）
  const wantMail = cfg.email_enabled && list.length > 0 && (force || !connectedAndOk) && !alreadyEmailed;
  // 发信策略（2026-10-01，用户要求降载）：**只有"这一轮确实有新增"才允许发**，
  // 且一天最多 8 封（见 lib/mail-policy.mjs）。没有新增 / 超配额 → 不发邮件，
  // 材料照样进应用通知、也还在本机目录里。
  const gate = wantMail ? decideMail('canvas', { store, hasNew: !alreadyEmailed }) : null;
  const shouldMail = wantMail && gate.allow;
  if (wantMail && !gate.allow) {
    out.emailed = { ok: false, skipped: 'mail-policy', count: list.length, reason: gate.reason };
    log(`[course-sync] 按发信策略没发邮件：${gate.reason}（材料已在本机 / 通知里）`);
  }
  if (cfg.email_enabled && list.length > 0 && alreadyEmailed) {
    out.emailed = { skipped: 'already-emailed', count: list.length };
  }
  if (shouldMail) {
    const at = new Date();
    let attachments = [];
    let note = '';
    if (cfg.email_attach) {
      const cap = Math.max(1, Number(cfg.email_attach_max_mb) || 15) * 1024 * 1024;
      let total = 0;
      const skipped = [];
      for (const r of list.filter((x) => /\.pdf$/i.test(x.filename))) {
        const abs = r.abs_path || (r.rel_path ? join(cfg.root, r.rel_path) : '');
        if (!abs || !existsSync(abs)) continue;
        const size = statSync(abs).size;
        // 附件名用台账里的标准名（默认 FA26_<课程号>_Week<n>_<原名>.<ext>），和电脑上、办公本上保持一致
        const name = standardFileNameFor(r, { template: courseFileNameTemplate() });
        if (total + size > cap) { skipped.push(name); continue; }
        total += size;
        try {
          attachments.push({ filename: name, content: readFileSync(abs), contentType: 'application/pdf' });
        } catch { skipped.push(name); }
      }
      if (skipped.length) note = `（${skipped.length} 份 PDF 超过 ${cfg.email_attach_max_mb} MB 的附件上限，没随邮件发出，可在电脑上取）`;
    } else {
      note = `（按设置没有附带文件，可在电脑的「${courseRootLabel()}」里取）`;
    }
    const text = buildCourseMailText({ rows: list, device: deviceInfo, at, note });
    const r = await sendViaMailBridge({
      dir: cfg.mail_bridge_dir,
      to: cfg.email_to,
      subject: `📚 Canvas 新课件 ${ymd(at)}（${list.length} 份 · 未连接办公本）`,
      text,
      attachments,
      log,
    });
    out.emailed = { ...r, count: list.length, attached: attachments.length, at: at.toISOString() };
    if (r.ok) saveRuntime({ emailed_signature: signature, last_email_at: at.toISOString() });
    // 只有真的发出去了才记账（失败不占配额 —— 否则 163 风控那会儿会把一天的额度白白吃光）
    if (r.ok) noteMailSent('canvas', { store, ref: `canvas-${ymd(at)}-${list.length}` });
    if (r.ok) log(`[course-sync] 已交给邮件桥发出：${(r.to || []).join(', ')}（附件 ${attachments.length} 份）`);
    else log(`[course-sync] 邮件桥发信失败：${r.error}`);
  }

  return out;
}

/**
 * 一轮完整同步：下载 → （办公本 PDF 同步 | 邮件桥发信）。
 * @param {{trigger?:string, rows?:object[], log?:Function, sendMailEvenIfConnected?:boolean}} opts
 */
export async function runCourseSync({ trigger = 'canvas', rows = null, log = () => {} } = {}) {
  const cfg = getCourseSync();
  const nowIso = new Date().toISOString();
  if (!cfg.enabled) {
    saveRuntime({ last_run: nowIso, last_result: { skipped: 'disabled', at: nowIso, trigger } });
    return { skipped: 'disabled' };
  }
  // 一轮最多下载 4 批 × 40 份：首次启用时可能一次补下几十份课程材料。
  const dl = { downloaded: [], failed: [] };
  for (let round = 0; round < 4; round++) {
    const batch = await downloadPending({ limit: 40, log });
    dl.downloaded.push(...(batch.downloaded || []));
    dl.failed.push(...(batch.failed || []));
    if (!((batch.downloaded || []).length) && !((batch.failed || []).length)) break;
    if ((batch.downloaded || []).length < 40 && (batch.failed || []).length < 40) break;
  }
  const rowsForMail = dl.downloaded.length ? dl.downloaded : null;
  const wb = await syncToWorkbookOrMail({ rows: rowsForMail, log });
  const result = {
    at: nowIso,
    trigger,
    downloaded: dl.downloaded.length,
    download_failed: dl.failed.length,
    synced_to_device: wb.synced.length,
    device_skipped: wb.skipped.length,
    device_failed: wb.failed.length,
    // 注意：emailed.skipped 表示「同一批材料已经发过邮件，这次不重复发」，
    // 它不是失败，所以 ok 记为 true 并带上 skipped，免得界面写成「邮件失败：」。
    emailed: wb.emailed ? {
      ok: wb.emailed.skipped ? true : !!wb.emailed.ok,
      skipped: wb.emailed.skipped || null,
      to: wb.emailed.to || [],
      count: wb.emailed.count || 0,
      attached: wb.emailed.attached || 0,
      error: wb.emailed.error || null,
    } : null,
    device: wb.device,
    errors: [
      ...dl.failed.map((f) => `下载失败 ${f.filename}：${f.error}`),
      ...wb.failed.map((f) => `办公本失败 ${f.filename}：${f.error}`),
      ...(wb.emailed && !wb.emailed.ok && !wb.emailed.skipped ? [`邮件失败：${wb.emailed.error}`] : []),
    ],
  };
  saveRuntime({ last_run: nowIso, last_result: result, last_device: wb.device || null });
  return result;
}

// ---------- 统一命名（FA26_<课程号>_Week<n>_<文件名>） ----------

const sha256Of = (path) => {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return ''; }
};

function folderCode(folderName) {
  return normalizeCourseCode(folderName) || COLLEGE_CODE;
}

/**
 * 桌面侧的改名计划：每个课程文件夹里的顶层文件 → `FA26_<课程号>_Week<n>_<去掉教授课程号的文件名>`。
 * 子目录（解压出来的代码、__MACOSX 之类）不动；重名/重复的挪进 `_重名或重复（可删）`。
 */
export function planDesktopRenames(cfg = getCourseSync()) {
  const root = String(cfg.root || '');
  const template = courseFileNameTemplate();
  const rename = [];
  const skipped = [];
  const collisions = [];
  // 台账里有 Canvas 日期 → 用它算「第几周」；台账没有的文件退回用文件自身的修改时间。
  const weekByName = new Map();
  const tagByName = new Map();          // 文件名 → Canvas 文件号后缀（撞名时用来区分不同材料）
  for (const r of store.listCourseFiles()) {
    const w = semesterWeek(r.file_date || r.created_at);
    if (!w) continue;
    const tag = disambiguationTag(r);
    for (const n of [r.local_name, r.filename]) {
      if (!n) continue;
      if (!weekByName.has(n)) weekByName.set(n, w);
      if (tag && !tagByName.has(n)) tagByName.set(n, tag);
    }
  }
  let folders = [];
  try { folders = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return { rename, skipped, collisions, root }; }
  folders = folders.filter((f) => f !== QUARANTINE_DIR);
  for (const folder of folders) {
    const dir = join(root, folder);
    const code = folderCode(folder);
    // 课程目录本体 + 已有的 WeekNN 子文件夹都要参与规划（其它子目录仍旧不动）
    const srcDirs = [{ dir, sub: '' }];
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (!/^Week\d+$/i.test(d.name)) {
          skipped.push({ folder, name: d.name, reason: '子目录（代码/解压出来的东西不动）' });
          continue;
        }
        srcDirs.push({ dir: join(dir, d.name), sub: d.name });
      }
    } catch { continue; }
    const byTarget = new Map();
    for (const src of srcDirs) {
      let entries = [];
      try { entries = readdirSync(src.dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isDirectory()) {
          skipped.push({ folder, name: `${src.sub ? `${src.sub}\\` : ''}${e.name}`, reason: '子目录（代码/解压出来的东西不动）' });
          continue;
        }
        if (e.name === '说明.md') { skipped.push({ folder, name: e.name, reason: '目录说明文件' }); continue; }
        if (isGeneratedArtifact(e.name)) { skipped.push({ folder, name: e.name, reason: 'Cairn 自己生成的周总结/学习包' }); continue; }
        const abs = join(src.dir, e.name);
        const info = (() => { try { return statSync(abs); } catch { return null; } })();
        // 周次来源优先级：文件名里已经写好的 `_Week<n>_` > 台账里的 Canvas 日期 > 文件修改时间。
        // 2026-09-29：改名会刷新 mtime（尤其重新下载的），只看 mtime 会把 Week2 的讲义
        // 误判成当周——文件名里的 Week 段是我们自己按 Canvas 日期写进去的，最可靠。
        const fromName = Number((String(e.name).match(/_Week(\d+)_/i) || [])[1]) || null;
        const week = fromName || weekByName.get(e.name) || semesterWeek(info ? info.mtimeMs : null);
        const target = buildCourseFileName({
          courseCode: code, filename: e.name, week, course: folder,
          date: info ? info.mtimeMs : null, template,
        });
        // 目标位置：该课该周应该待的文件夹（学院文件 / 认不出周次 → 仍然留在课程目录根下）
        const sub = useWeekFolder(code, week) ? weekDirName(week) : '';
        const toDir = sub ? join(dir, sub) : dir;
        const item = {
          folder, dir: src.dir, toDir, from: e.name, to: target, code, week,
          rel: `${folder}\\${sub ? `${sub}\\` : ''}${target}`,
          changed: abs !== join(toDir, target), abs,
        };
        const key = `${toDir}|${target}`;
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key).push(item);
      }
    }
    for (const [, items] of byTarget) {
      const target = items[0].to;
      if (items.length === 1) { rename.push(items[0]); continue; }
      // 多个文件会撞到同一个目标名：内容一样的留下一个，其余的挪进隔离目录
      items.sort((a, b) => (a.from === target ? -1 : b.from === target ? 1 : a.from.localeCompare(b.from)));
      const keeper = items[0];
      rename.push(keeper);
      for (const dup of items.slice(1)) {
        const sameSize = (() => { try { return statSync(keeper.abs).size === statSync(dup.abs).size; } catch { return false; } })();
        const identical = sameSize && sha256Of(keeper.abs) && sha256Of(keeper.abs) === sha256Of(dup.abs);
        if (identical) {
          // 真的重复：留一份，其余进隔离目录（可以自己删）
          collisions.push({ ...dup, keeper: keeper.from, identical, target });
          skipped.push({ folder, name: dup.from, reason: `与 ${keeper.from} 内容重复（保留一份）` });
          continue;
        }
        // 同名但内容不同 = 另一份材料（不同 TA 的同名讲义）→ 加后缀并存，绝不覆盖/挪走
        const tag = tagByName.get(dup.from) || tagByName.get(dup.to) || sha256Of(dup.abs).slice(0, 6);
        const newName = withTag(dup.to, tag);
        if (newName === dup.to) {
          collisions.push({ ...dup, keeper: keeper.from, identical, target });
          skipped.push({ folder, name: dup.from, reason: `与 ${keeper.from} 同名冲突（无法加后缀）` });
          continue;
        }
        const sub = dup.toDir === join(root, folder) ? '' : `${basename(dup.toDir)}\\`;
        const renamed = { ...dup, to: newName, rel: `${folder}\\${sub}${newName}`, changed: true };
        rename.push(renamed);
        log(`[rename] 同名不同内容 → ${newName}（保留，不覆盖）`);
      }
    }
  }
  return { root, rename, skipped, collisions };
}

/** 设备条目的匹配打分：数字越大越像同一份材料。 */
function matchScore(deviceName, { oldName, code }) {
  const a = normalizeBookName(deviceName);
  const b = normalizeBookName(oldName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  // 去掉课程号后再比：设备上可能是教授原始的命名（math186_all_lecture_slides），
  // 而本地文件已经统一成 FA26_MATH1860J_all_lecture_slides。
  const cleanedDevice = normalizeBookName(cleanStem(deviceName, code));
  const cleanedLocal = normalizeBookName(cleanStem(oldName.replace(/\.[a-z0-9]{1,6}$/i, ''), code));
  if (cleanedDevice && cleanedDevice === cleanedLocal) return 90;
  if (b.length >= 6 && (a.includes(b) || b.includes(a))) return 60;
  // 课程号 + 大纲：设备导入时会把《Course Syllabus …》这类书叫成「…课程大纲」
  const codeKey = String(code || '').toLowerCase().replace(/[^0-9a-z]/g, '');
  if (codeKey && a.includes(codeKey) && /大纲/.test(deviceName) && /syllabus|大纲/i.test(oldName)) return 70;
  const tokens = String(oldName)
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .split(/[^0-9A-Za-z\u4e00-\u9fff]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 5 && /\d/.test(t));
  if (tokens.length && tokens.every((t) => a.includes(t))) return 40;
  return 0;
}

/** office 中心那三份是历史手工导入的，名字和设备自带命名不一样，这里用关键词对上。 */
const OFFICE_MAP = [
  { device: 'FA26_PUM1201_学习指南2026秋季', keys: ['学习指南2026秋季'] },
  { device: 'FA26_STAT1000J_课程群二维码', keys: ['课程群二维码', '课程飞书群二维码'] },
  { device: 'FA26_学院课程表_S-V6', keys: ['课程表'] },
];

/**
 * 统一桌面与办公本上的课程资料文件名。
 * @param {{dryRun?:boolean, includeDevice?:boolean, log?:Function}} opts
 */
export async function normalizeCourseNames({ dryRun = false, includeDevice = true, log = () => {} } = {}) {
  const cfg = getCourseSync();
  const root = String(cfg.root || '');
  const plan = planDesktopRenames(cfg);
  const report = {
    at: new Date().toISOString(),
    dry_run: !!dryRun,
    root,
    desktop: { renamed: [], moved: [], skipped: plan.skipped, collisions: plan.collisions },
    device: { connected: false, renamed: [], failed: [], skipped: [] },
    ledger_updated: 0,
  };

  // ---- 1) 桌面改名 ----
  const mapping = new Map();          // 旧绝对路径 → 新绝对路径
  if (!dryRun) {
    for (const item of plan.rename) {
      if (!item.changed) continue;
      try {
        const target = join(item.toDir || item.dir, item.to);
        try { mkdirSync(item.toDir || item.dir, { recursive: true }); } catch { /* 建不了就在下游报错 */ }
        renameSync(item.abs, target);
        report.desktop.renamed.push({ folder: item.folder, from: item.from, to: item.to });
        mapping.set(item.abs, target);
        log(`[rename] ${item.folder}\\${item.from} → ${item.rel || item.to}`);
      } catch (e) {
        report.desktop.renamed.push({ folder: item.folder, from: item.from, to: item.to, error: e.message });
        log(`[rename] 失败 ${item.folder}\\${item.from}：${e.message}`);
      }
    }
    // 重名/重复的挪进隔离目录
    for (const c of plan.collisions) {
      const destDir = join(root, QUARANTINE_DIR, c.folder);
      try {
        mkdirSync(destDir, { recursive: true });
        renameSync(c.abs, join(destDir, c.from));
        report.desktop.moved.push({ folder: c.folder, name: c.from, to: `${QUARANTINE_DIR}\\${c.folder}\\${c.from}`, identical: c.identical, kept: c.keeper });
        log(`[rename] 挪走重复：${c.folder}\\${c.from} → ${QUARANTINE_DIR}\\${c.folder}\\`);
      } catch (e) {
        log(`[rename] 挪走失败 ${c.from}：${e.message}`);
      }
    }
  } else {
    report.desktop.renamed = plan.rename.filter((r) => r.changed).map((r) => ({ folder: r.folder, from: r.from, to: r.to }));
  }

  // ---- 2) 台账同步到新名字（同时给设备侧提供「旧名 → 新名」） ----
  const rows = store.listCourseFiles();
  // 改名后磁盘上的路径（干跑时就是原名）
  const localList = plan.rename.map((item) => ({
    folder: item.folder,
    code: item.code,
    oldName: item.from,
    newName: item.to,
    rel: item.rel,
    abs: mapping.get(item.abs) || item.abs,
  }));
  const nameMap = new Map();          // 旧文件名 → { newName, folder, abs }
  for (const item of localList) {
    nameMap.set(item.oldName, { newName: item.newName, folder: item.folder, abs: item.abs, code: item.code, rel: item.rel });
  }
  for (const row of rows) {
    const oldLocal = row.local_name || row.filename;
    const hit = nameMap.get(oldLocal) || nameMap.get(String(row.filename || ''));
    const alreadyRight = hit && hit.newName === oldLocal && hit.rel === row.rel_path;
    if (!hit || alreadyRight) continue;
    if (!dryRun) {
      store.updateCourseFile(row.id, {
        local_name: hit.newName,
        rel_path: hit.rel || `${hit.folder}\\${hit.newName}`,
        abs_path: hit.abs,
        // 设备上的名字要跟着换，但已经同步过的条目保持 synced：否则这一批 PDF 会被当成
        // 「还没进办公本」再发一封邮件。等办公本插线后，再点一次「统一命名」即可把
        // 书架上的旧条目换成新名字（走 step 3 的删旧 + 导新）。
        device_status: row.device_status === 'synced' ? 'synced' : 'pending',
        device_name: row.device_status === 'synced' ? row.device_name : null,
      });
    }
    report.ledger_updated += 1;
  }

  // 2b) 台账指的文件如果已经不在原位（例如重名时那一份被挪进了隔离目录），按统一命名重新指回现存的那份
  const repaired = [];
  for (const row of rows) {
    const curAbs = row.abs_path || '';
    if (curAbs && existsSync(curAbs)) continue;
    const { dir, folder } = resolveCourseDir(cfg, { courseCode: row.course_code, course: row.course });
    const canonical = buildCourseFileName({
      courseCode: normalizeCourseCode(row.course_code) || normalizeCourseCode(row.course) || COLLEGE_CODE,
      filename: row.filename,
      week: semesterWeek(row.file_date || row.created_at),
      course: row.course || '',
      date: row.file_date || row.created_at,
      template: courseFileNameTemplate(),
    });
    const candidates = [
      row.local_name ? join(dir, row.local_name) : '',
      join(dir, canonical),
      // 按周分文件夹之后，台账里的老路径可能少了 WeekNN 这一段
      join(dir, weekDirName(semesterWeek(row.file_date || row.created_at)), row.local_name || canonical),
      join(dir, weekDirName(semesterWeek(row.file_date || row.created_at)), canonical),
      join(root, QUARANTINE_DIR, folder, row.local_name || ''),
    ].filter(Boolean);
    const found = candidates.find((p) => existsSync(p));
    if (!found) continue;
    const name = basename(found);
    const relFound = found.startsWith(dir) ? `${folder}\\${found.slice(dir.length + 1)}` : `${folder}\\${name}`;
    if (!dryRun) {
      store.updateCourseFile(row.id, {
        local_name: name,
        rel_path: relFound,
        abs_path: found,
        device_status: /\.pdf$/i.test(name) ? (row.device_status === 'pending' ? 'synced' : row.device_status) : 'skipped',
      });
    }
    repaired.push({ filename: row.filename, local_name: name });
    log(`[rename] 台账指回现存文件：${row.filename} → ${folder}\\${name}`);
  }
  report.ledger_repaired = repaired;

  // 2c) 非 PDF 本来就不进办公本：标成 skipped，避免台账里一直挂着「待进办公本」
  for (const row of rows) {
    const name = row.local_name || row.filename;
    if (/\.pdf$/i.test(name)) continue;
    if (row.device_status === 'pending') {
      if (!dryRun) store.updateCourseFile(row.id, { device_status: 'skipped' });
      report.ledger_updated += 1;
    }
  }

  // ---- 3) 办公本：按新名字重新导入 + 删掉旧条目 ----
  if (includeDevice && cfg.workbook_enabled) {
    const shelf = await listWorkbookContainer({ pattern: cfg.device_pattern, container: cfg.workbook_container });
    const office = await listWorkbookContainer({ pattern: cfg.device_pattern, container: 'office中心' });
    report.device.connected = !!shelf.connected;
    if (shelf.connected && shelf.ok) {
      const used = new Set();
      const jobs = [];   // { container, oldDeviceName, newDeviceName, abs }
      // 只有「可能被导入办公本」的文件类型参与匹配，避免把 .md 笔记之类错配到设备条目上
      const candidates = localList.filter((v) => DEVICE_FILE_EXTS.has(extname(v.oldName).toLowerCase()));
      const matchDevice = (items, container) => {
        for (const it of items || []) {
          // office 中心走显式映射
          if (container === 'office中心') {
            const m = OFFICE_MAP.find((x) => x.device === it.name);
            if (m) {
              const local = localList.find((v) => m.keys.some((k) => v.oldName.includes(k)));
              if (local) jobs.push({ container, oldDeviceName: it.name, newDeviceName: deviceNameFor(local.newName), abs: local.abs, oldName: local.oldName });
            }
            continue;
          }
          let best = null; let bestScore = 0;
          for (const cand of candidates) {
            if (used.has(cand.abs)) continue;
            const score = matchScore(it.name, { oldName: cand.oldName, code: cand.code });
            if (score > bestScore) { best = cand; bestScore = score; }
          }
          if (best && bestScore >= 60) {
            used.add(best.abs);
            jobs.push({ container, oldDeviceName: it.name, newDeviceName: deviceNameFor(best.newName), abs: best.abs, oldName: best.oldName });
          }
        }
      };
      matchDevice((shelf.items || []).filter((i) => !i.isFolder), cfg.workbook_container);
      if (office.ok) matchDevice((office.items || []).filter((i) => !i.isFolder), 'office中心');

      for (const job of jobs) {
        if (!job.newDeviceName || job.newDeviceName === job.oldDeviceName) { report.device.skipped.push({ ...job, reason: '名字已经一致' }); continue; }
        const listFor = (job.container === 'office中心' ? office.items : shelf.items) || [];
        const existing = listFor.find((i) => i.name === job.newDeviceName);
        const localSize = (() => { try { return statSync(job.abs).size; } catch { return 0; } })();
        // 设备上已有同名条目时，还要比一下大小：大小一致才算「已经在设备上」，
        // 否则（上次中断留下的半个文件）删掉重导。
        const sameOnDevice = !!existing && localSize > 0 && (Number(existing.size) || 0) === localSize;
        if (!sameOnDevice) {
          if (dryRun) { report.device.renamed.push({ ...job, dry_run: true, already: !!existing }); continue; }
          if (existing) {
            log(`[rename] 设备上的 ${job.newDeviceName} 大小不符，先删掉重导`);
            await deleteFromWorkbook([job.newDeviceName], { pattern: cfg.device_pattern, container: job.container });
          }
          const copy = await copyToWorkbook([{ path: job.abs, name: basename(job.abs) }],
            { pattern: cfg.device_pattern, container: job.container });
          if (!(copy.copied || []).length) {
            report.device.failed.push({ ...job, error: (copy.failed && copy.failed[0] && copy.failed[0].error) || copy.error || '导入失败' });
            log(`[rename] 办公本导入失败：${job.newDeviceName}`);
            continue;
          }
        } else if (dryRun) {
          report.device.renamed.push({ ...job, dry_run: true, already: true });
          continue;
        }
        if (dryRun) continue;
        const del = await deleteFromWorkbook([job.oldDeviceName], { pattern: cfg.device_pattern, container: job.container });
        if ((del.deleted || []).length) {
          report.device.renamed.push({ ...job });
          log(`[rename] 办公本：${job.oldDeviceName} → ${job.newDeviceName}`);
          const row = rows.find((r) => r.device_name === job.oldDeviceName)
            || rows.find((r) => job.oldName && (r.local_name || r.filename) === job.oldName);
          if (row) store.updateCourseFile(row.id, { device_status: 'synced', device_name: job.newDeviceName, device_error: null, synced_at: Date.now() });
        } else {
          report.device.failed.push({ ...job, error: (del.failed && del.failed[0] && del.failed[0].error) || del.error || '旧条目删除失败' });
          log(`[rename] 办公本旧条目没删掉：${job.oldDeviceName}`);
        }
      }
      // 收尾核对：新名字在设备上且大小与本地一致
      if (!dryRun) {
        const shelfAfter = await listWorkbookContainer({ pattern: cfg.device_pattern, container: cfg.workbook_container });
        const officeAfter = await listWorkbookContainer({ pattern: cfg.device_pattern, container: 'office中心' });
        const all = [...(shelfAfter.items || []), ...(officeAfter.items || [])];
        const verify = [];
        for (const job of jobs) {
          const want = job.newDeviceName || job.oldDeviceName;
          const hit = all.find((i) => i.name === want);
          const localSize = (() => { try { return statSync(job.abs).size; } catch { return 0; } })();
          const ok = !!hit && (!localSize || (Number(hit.size) || 0) === localSize);
          verify.push({ name: want, ok, device_size: hit ? Number(hit.size) || 0 : null, local_size: localSize });
          // 顺手把台账里的办公本名字对齐（早先是「(设备上已有)」这种占位）
          if (ok) {
            const row = rows.find((r) => r.device_name === job.oldDeviceName || r.device_name === want)
              || rows.find((r) => job.oldName && (r.local_name || r.filename) === job.oldName)
              || rows.find((r) => r.abs_path === job.abs);
            if (row && row.device_name !== want) {
              store.updateCourseFile(row.id, { device_status: 'synced', device_name: want, device_error: null, synced_at: Date.now() });
            }
          }
        }
        report.device.verify = verify;
        const bad = verify.filter((v) => !v.ok);
        if (bad.length) log(`[rename] 办公本核对：${verify.length - bad.length} 个一致，${bad.length} 个要复查`);
        else log(`[rename] 办公本核对：${verify.length} 个全部一致`);
      }
    }
  }
  return report;
}

// ---------- 每日清理历史记录 ----------
export function purgeHistoryNow({ force = false, log = () => {} } = {}) {
  const cfg = getCourseSync();
  const h = cfg.history;
  const today = ymd();
  if (!force) {
    if (!h.enabled) return { skipped: 'disabled' };
    if (h.last_purge === today) return { skipped: 'already-today' };
    const [hh, mm] = String(h.time || '04:00').split(':').map((x) => parseInt(x, 10) || 0);
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return { skipped: 'before-time' };
  }
  const res = store.purgeHistory({
    days: Math.max(1, Number(h.days) || 10),
    notifications: h.notifications !== false,
    connectorData: h.connector_data !== false,
    dismissed: h.dismissed !== false,
    focus: h.focus !== false,
    doneTasks: !!h.done_tasks,
  });
  const record = { ...res, at: new Date().toISOString(), forced: !!force };
  saveRuntime({ history: { last_purge: today, last_result: record } });
  log(`[history] 清理完成：通知 ${res.notifications} · 导入条目 ${res.connector_data} · 删除标记 ${res.dismissed} · 专注 ${res.focus}${res.done_tasks ? ` · 已完成任务 ${res.done_tasks}` : ''}（保留最近 ${res.days} 天）`);
  return record;
}

/**
 * 邮件桥当前状态（给界面看的那个读数）。
 *
 * 2026-09-27：加 30 秒短缓存。起因是实测 —— 问一次状态就要起一个桥的子进程（实测 250~330ms），
 * 而 `/api/course-sync` 在"数据源 / 设置"页每渲染一次就被问一次，
 * 表现就是"打开设置就慢半拍"。这只是一行显示用的读数，30 秒内的旧值完全安全；
 * 真正发信那条路（sendViaMailBridge）**不受影响，永远是现问的**。
 */
const MAIL_BRIDGE_STATUS_TTL_MS = 30000;
let mailBridgeStatusCache = { at: 0, dir: '', value: null };

async function mailBridgeStatusCached(dir) {
  const key = String(dir || '');
  const now = Date.now();
  if (mailBridgeStatusCache.value && mailBridgeStatusCache.dir === key && now - mailBridgeStatusCache.at < MAIL_BRIDGE_STATUS_TTL_MS) {
    return mailBridgeStatusCache.value;
  }
  // P1-7：不读任何凭据（凭据不进 Planner 进程），只问邮件桥要一份状态
  const value = await (async () => {
    const st = await mailBridgeStatus({ dir });
    if (st && st.ok) {
      return { ok: true, via: 'bridge-cli', config_path: st.config_path, from: st.from, recipients: st.recipients };
    }
    return { ok: false, via: 'bridge-cli', error: (st && st.error) || '邮件桥没有给出状态' };
  })();
  mailBridgeStatusCache = { at: now, dir: key, value };
  return value;
}

/** 只读：本机文件系统 + 办公本 + 邮件桥的当前状态（给界面用）。 */
export async function courseSyncStatus({ probeDevice = false, log = () => {} } = {}) {
  const cfg = getCourseSync();
  const rows = store.listCourseFiles();
  const mail_bridge = await mailBridgeStatusCached(cfg.mail_bridge_dir);
  const out = {
    config: cfg,
    // 「放在哪 / 叫什么名」现在都由别处（本机目录 / 功能设置）决定，这里把生效值一并给界面，
    // 免得界面上还留着一句写死的「桌面\FA26课程资料」跟实际不一致。
    root_label: courseRootLabel(cfg.root),
    name_template: courseFileNameTemplate(),
    root_exists: existsSync(String(cfg.root || '')),
    counts: {
      files: rows.length,
      downloaded: rows.filter((r) => r.status === 'downloaded').length,
      failed: rows.filter((r) => r.status === 'error').length,
      pending_device: rows.filter((r) => r.status === 'downloaded' && r.device_status !== 'synced' && /\.pdf$/i.test(r.filename)).length,
      on_device: rows.filter((r) => r.device_status === 'synced').length,
    },
    files: rows.slice(0, 40),
    mail_bridge,
  };
  if (probeDevice && process.platform === 'win32') {
    out.device = await listWorkbookContainer({ pattern: cfg.device_pattern, container: cfg.workbook_container });
  }
  return out;
}

export { testMailBridge, listWorkbookContainer, copyToWorkbook };
