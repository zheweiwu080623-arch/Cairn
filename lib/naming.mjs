// 课程资料统一命名
//
// 规则（2026-09-16 用户定稿，取代 09-15 的旧版）：
//   FA26_<课程代码>_Week<n>_<去掉对方自己写的课程号后的原名>.<原扩展名>
//   · 学期代号 `FA26`：F + 季节（FA 秋 / SP 春 / SU 夏）+ 两位年份；本机当前学期即 FA26。
//   · <课程代码> = 学院口径的课程号（MATH1860J / STAT1000J / ENGR1010J / ENGL1000J / PUM1201 …）；
//     「Undergraduate Students」这种学院口径材料用 `学院文件`（这类非课程材料不加 Week 段）。
//   · <n> = 本学期的第几周，按材料在 Canvas 上的日期算（第 1 周 = 学期开学的周一，见 SEMESTER_START）。
//   · 文件名里**对方自己写的课程号**要去掉（例如 `math186_all_lecture_slides.pdf` → `all_lecture_slides`），
//     同时去掉重复的 FA26_ 前缀、独立的学期标记（FA26 / 26FA）与我们自己加过的 Week 段，
//     这样反复改名不会滚成 `FA26_MATH1860J_Week1_math186_Week1_…`。
//   例：`lec_1.pdf`（ENGR1010J，第 1 周）→ `FA26_ENGR1010J_Week1_lec_1.pdf`
import { basename, extname } from 'node:path';

export const SEMESTER_TAG = 'FA26';
/** 学期第 1 周的周一（Planner 校历 kind=term：2026秋 · 开学）。 */
export const SEMESTER_START = '2026-09-14';
/** 学期周数上限（GC Fall 2026 共 14 周）。 */
export const SEMESTER_WEEKS = 14;
export const COLLEGE_CODE = '学院文件';

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把 YYYY-MM-DD / ISO 串 / 毫秒数统一成毫秒时间戳；认不出来就返回 null。 */
function toTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = new Date(`${s}T00:00:00`).getTime();
    return Number.isNaN(t) ? null : t;
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * 某个日期属于本学期第几周。
 * 开学前拿到的材料算第 1 周；超过学期周数的按上限截断（假期/期末补发不出现 Week20）。
 * @returns {number|null} 认不出日期时返回 null（调用方据此不加 Week 段）
 */
export function semesterWeek(dateLike, { start = SEMESTER_START, max = SEMESTER_WEEKS } = {}) {
  const t = toTime(dateLike);
  const s = toTime(start);
  if (t === null || s === null) return null;
  const week = Math.floor((t - s) / (7 * 86400000)) + 1;
  if (!Number.isFinite(week)) return null;
  if (week < 1) return 1;
  return Math.min(week, max);
}

/** 第 n 周 → `Weekn` 段；无效周次返回空串（不加这一段）。 */
export function weekTag(week) {
  const n = Number(week);
  return Number.isInteger(n) && n >= 1 ? `Week${n}` : '';
}

/** 规范化课程号：去掉括号 / 前后缀噪声，转大写。 */
export function normalizeCourseCode(raw) {
  const m = String(raw || '').match(/([A-Za-z]{2,6}\d{3,5}[A-Za-z]?)/);
  if (m) return m[1].toUpperCase();
  if (/undergraduate|学院|教务处/i.test(String(raw || ''))) return COLLEGE_CODE;
  return '';
}

/**
 * 一个课程号的各种写法（都是小写）：完整号、去掉尾部字母、以及「字母 + 前 3 位数字」的简写。
 * MATH1860J → ['math1860j', 'math1860', 'math186']（最后一个正是用户举例的 `math186`）
 */
export function courseCodeVariants(code) {
  const c = normalizeCourseCode(code);
  if (!c || c === COLLEGE_CODE) return [];
  const out = new Set([c.toLowerCase()]);
  const m = c.match(/^([A-Z]{2,6})(\d{3,5})([A-Z]?)$/);
  if (m) {
    const [, letters, digits] = m;
    out.add(`${letters}${digits}`.toLowerCase());
    if (digits.length >= 4) out.add(`${letters}${digits.slice(0, 3)}`.toLowerCase());
    if (digits.length === 5) out.add(`${letters}${digits.slice(0, 4)}`.toLowerCase());
  }
  return [...out];
}

/** 去掉文件名里重复的课程号 / 学期标记，并清掉多余分隔符。 */
export function cleanStem(stem, code) {
  let s = String(stem || '');
  // 去掉我们自己的前缀（FA26_ / FA26- / FA26空格，重复出现的也一起去掉）
  s = s.replace(/^(?:\s*FA26[\s_-]*)+/i, '');
  // 再去掉我们自己的「学院文件」标记（口径课材料的 tag），避免出现 学院文件_学院文件_
  s = s.replace(/^(?:学院文件[\s_-]*)+/, '');
  // 去掉我们自己的 Week 段（改名幂等：FA26_X_Week1_lec → lec）
  s = s.replace(/[\s_-]*Week\d+(?![0-9])/gi, ' ');
  // 去掉开头的课程号
  const c = normalizeCourseCode(code);
  if (c && c !== COLLEGE_CODE) s = s.replace(new RegExp(`^(?:\\s*${escapeRegExp(c)}[\\s_-]*)+`, 'i'), '');
  // 去掉任意位置出现的课程号写法（连同前后分隔符一起吃掉，后面再归一化）
  for (const v of courseCodeVariants(c)) {
    s = s.replace(new RegExp(`[\\s_-]*${escapeRegExp(v)}(?![0-9a-z])`, 'gi'), ' ');
  }
  // 去掉独立的学期标记（FA26 / 26FA），以及紧跟在后面的分隔符
  s = s.replace(new RegExp(`(^|[\\s_\\-(\\[])(${SEMESTER_TAG}|26FA)(?=[\\s_\\-)\\]]|$)`, 'gi'), '$1');
  // 归一化分隔符：只收掉「被删掉的那一段」留下的空位，不把原有的空格整体改成下划线
  s = s.replace(/\s{2,}/g, ' ').replace(/_{2,}/g, '_');
  s = s.replace(/^[\s_\-]+|[\s_\-]+$/g, '');
  s = s.replace(/^\.+|\.+$/g, '');
  return s || '未命名';
}

/**
 * 组装目标文件名：`FA26_<课程代码>_Week<n>_<清理后的原名>.<原扩展名>`
 * week 为空 / 非正整数时不加 Week 段（学院文件本来就不加）。
 *
 * 2026-09-27：名字本身改由**模板**决定（`nameFor`），这里的默认参数就是原来的规则，
 * 所以不填 template 时逐字等同于老版本。四个调用点（下载落盘 / 桌面改名计划 /
 * 邮件附件名 / 通知文案）都从这里过，改模板只需要改一个字。
 */
export function buildCourseFileName({
  courseCode = '', filename = '', week = null,
  course = '', date = null, seq = null, template = DEFAULT_NAME_TEMPLATE,
} = {}) {
  const code = normalizeCourseCode(courseCode) || COLLEGE_CODE;
  const ext = extname(String(filename || ''));
  const stem = basename(String(filename || ''), ext);
  const cleaned = cleanStem(stem, code);
  const vars = {
    学期: SEMESTER_TAG,
    课程号: code,
    课程名: courseNameOf(course, code),
    周次: code === COLLEGE_CODE ? '' : weekNumberText(week),
    原名: cleaned,
    日期: dateTag(date),
    类型: ext ? ext.replace(/^\./, '') : '',
    序号: seq === null || seq === undefined || seq === '' ? '' : String(seq).padStart(2, '0'),
  };
  // 模板把名字吃空了（例如写成 `{课程名}` 而这门课没名字）→ 退回"当年那份原名"，绝不产出空名
  const base = sanitizeFileBase(nameFor(template, vars)) || cleaned;
  return base + ext;
}

// ---------- 命名模板（2026-09-27：把"名字长什么样"从代码里搬到一个可改的值上） ----------
//
// 默认值就是**现在的规则本身**（`FA26_<课程号>_Week<n>_<原名>`）。抽模板不是为了改默认值，
// 而是为了"想换一种叫法时不用改代码"；所以默认模板必须与老规则逐字相同 ——
// 否则老装机升级之后，同一个文件夹里的名字会集体漂移一次。
export const DEFAULT_NAME_TEMPLATE = '{学期}_{课程号}_Week{周次}_{原名}';

/** 模板里能用的变量（顺序就是界面上的按钮顺序，也是提示里的样例来源）。 */
export const NAME_VARS = [
  { key: '学期', sample: 'FA26', note: '当前学期代号（FA26 = 2026 年秋）' },
  { key: '课程号', sample: 'MATH1860J', note: '学院口径的课程号；学院文件写「学院文件」' },
  { key: '课程名', sample: '高等数学B1', note: '课程名（去掉课程号与学期前缀后的那段）' },
  { key: '周次', sample: '3', note: '本学期的第几周；学院文件没有周次（那段会整段消失）' },
  { key: '原名', sample: 'all_lecture_slides', note: '清理后的原文件名（去掉重复课程号，不含扩展名）' },
  { key: '日期', sample: '20260915', note: '材料在 Canvas 上的日期；没有就用文件时间' },
  { key: '类型', sample: 'pdf', note: '文件扩展名（pdf / docx / ipynb …）' },
  { key: '序号', sample: '01', note: '同名时的顺序号，平时用不到（留空）' },
];

const NAME_VAR_KEYS = new Set(NAME_VARS.map((v) => v.key));
const VAR_TOKEN_RE = /\{([^{}]*)\}/g;
const pad2 = (n) => String(n).padStart(2, '0');

/** Windows 上不能出现在文件名里的字符 + 结尾的点/空格（替成下划线 / 去掉）。 */
function sanitizeFileBase(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/** 第 n 周 → `3`（只给模板用；`Week` 两个字在模板里自己写，这样"不要 Week"也能表达）。 */
export function weekNumberText(week) {
  const n = Number(week);
  return Number.isInteger(n) && n >= 1 ? String(n) : '';
}

/** 材料日期 → `20260915`（认不出日期就空串，那一段会整段消失）。 */
export function dateTag(value) {
  const t = toTime(value);
  if (t === null) return '';
  const d = new Date(t);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/**
 * 课程名：去掉开头的学期前缀 `(2026-2027-1)-`，再去掉重复的课程号。
 * 认不出课程名时返回空串（调用方按空处理，不硬塞一个"未命名"）。
 */
export function courseNameOf(course, code = '') {
  const s = String(course || '').replace(/^\([^)]*\)\s*-?\s*/, '').trim();
  if (!s) return '';
  const cleaned = cleanStem(s, code);
  return cleaned === '未命名' ? '' : cleaned;
}

/** 模板用到了哪些变量 / 有没有写错的变量（界面拿它提示，不改名也不报错）。 */
export function analyzeNameTemplate(template) {
  const src = String(template == null ? '' : template);
  const used = [];
  const unknown = [];
  for (const m of src.matchAll(VAR_TOKEN_RE)) {
    const key = m[1];
    if (NAME_VAR_KEYS.has(key)) { if (!used.includes(key)) used.push(key); }
    else if (!unknown.includes(key)) unknown.push(key);
  }
  return { used, unknown };
}

/**
 * 按模板拼一个名字（不含扩展名）。
 *
 * 两条规则，都是为了"默认模板与老规则逐字相同"：
 *   1) 模板按**分隔符**（`_` / `-` / 空格）切成段；**一段里的变量全是空值 → 整段不要**
 *      （连着它旁边的那个分隔符一起不要）。于是"学院文件没有周次"时
 *      `Week{周次}`、`第{周次}周` 都会整段消失，而不是留下孤零零的 `Week` / `第周`。
 *   2) 没有变量的段原样保留；换回来的分隔符用**用户自己写的那一个**
 *      （所以 `{课程号}-{原名}` 出来的是横杠，不会被统一成下划线）。
 *
 * @param {string} template 形如 `{学期}_{课程号}_Week{周次}_{原名}`
 * @param {object} vars 变量值表（键就是 `{...}` 里的名字）
 */
export function nameFor(template, vars = {}) {
  const tpl = String(template == null ? '' : template).trim() || DEFAULT_NAME_TEMPLATE;
  const table = vars && typeof vars === 'object' ? vars : {};
  const valueOf = (k) => String(table[k] == null ? '' : table[k]);
  // 切成 [段, 分隔符, 段, 分隔符, 段…]（分隔符原样留着，好按用户写的样子拼回去）。
  // 连续的一串分隔符（含 ` - ` 这种混着的）算**一个**分隔符，原样保留。
  const parts = tpl.split(/([\s_\-]+)/);
  const segs = [];
  const seps = [''];                                  // seps[i] = 第 i 段前面的那个分隔符
  for (const part of parts) {
    if (part === '') continue;
    if (/^[\s_\-]+$/.test(part)) seps[segs.length] = part;
    else segs.push(part);
  }
  const out = [];
  let pendingSep = '';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const keys = [...seg.matchAll(VAR_TOKEN_RE)].map((m) => m[1]);
    if (keys.length && keys.every((k) => !valueOf(k))) continue;    // 变量全空：整段（连同分隔符）不要
    if (out.length) out.push(seps[i] || '');                        // 段与段之间用用户写的分隔符
    out.push(seg.replace(VAR_TOKEN_RE, (_, k) => valueOf(k)));
  }
  return sanitizeFileBase(out.join(''));
}

/** 办公本（书架 / office 中心）显示的是去掉扩展名的书名。 */
export function deviceNameFor(filename) {
  const ext = extname(String(filename || ''));
  return ext ? basename(String(filename), ext) : String(filename || '');
}

/** 判断某个文件名是否已经符合规则。 */
export function isCanonical(filename, code, week = null) {
  const c = normalizeCourseCode(code) || COLLEGE_CODE;
  const prefix = `${SEMESTER_TAG}_${c}_`;
  const s = String(filename || '');
  if (!s.startsWith(prefix)) return false;
  const tag = c === COLLEGE_CODE ? '' : weekTag(week);
  return tag ? s.startsWith(`${prefix}${tag}_`) : !/^Week\d+_/.test(s.slice(prefix.length));
}

/**
 * 邮件里用的文件名：一律取台账里的标准名（local_name）。
 * 老记录没有 local_name（或不是 FA26 开头）时，按命名规则现算 ——
 * 邮件附件、邮件正文、电脑上的文件、办公本书架上的名字四处保持一致。
 * @param {object} row course_files 台账行（含 local_name / course_code / course / filename / file_date / created_at）
 */
export function standardFileNameFor(row = {}, { template = DEFAULT_NAME_TEMPLATE } = {}) {
  const r = row || {};
  const local = String(r.local_name || '').trim();
  const code = normalizeCourseCode(r.course_code) || normalizeCourseCode(r.course);
  const week = semesterWeek(r.file_date || r.created_at);
  const canonical = buildCourseFileName({
    courseCode: code, filename: r.filename || local, week,
    course: r.course || '', date: r.file_date || r.created_at, template,
  });
  if (local && (local === canonical || local.startsWith(`${SEMESTER_TAG}_`))) return local;
  return canonical;
}
