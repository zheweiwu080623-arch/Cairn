import { canvasSample } from './samples.mjs';

export const meta = {
  id: 'canvas',
  name: 'Canvas LMS',
  icon: '🎓',
  description: '通过 Canvas REST API 导入课程、作业（转为任务）与日历事件（转为日程），并巡检课程文件 / 页面资源 / 教学大纲 / 模块（转为通知）；新文件可自动下载到桌面课程资料并同步到办公本。',
  fields: [
    { key: 'base_url', label: 'Canvas 域名', type: 'text', required: true, placeholder: 'https://school.instructure.com' },
    { key: 'token', label: 'API 访问令牌', type: 'password', required: true, placeholder: '粘贴 Canvas 生成的 Token' },
    { key: 'lookback_days', label: '课程文件/资源回溯天数（默认 30）', type: 'number', required: false, placeholder: '30' },
    { key: 'exclude_courses', label: '排除课程（课程代码 / 课程 ID / 名称片段，逗号分隔）', type: 'text', required: false, placeholder: 'POL3610J' },
  ],
};

// ---------- 参数与上限 ----------
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_PER_COURSE = 120;            // 单门课最多产出条目，防止刷屏
const MAX_PAGES_PER_COURSE = 25;       // 单门课最多读多少个页面正文
const MAX_MODULE_ITEMS_PER_COURSE = 40;
const MAX_FILES_PER_PAGE = 12;         // 超过这个数说明是「文件目录页」，不逐个展开
const MAX_FOLDER_DEPTH = 3;
const FETCH_TIMEOUT_MS = 20000;

async function getJson(base, path, token) {
  const url = base.replace(/\/$/, '') + path;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
  return res.json().catch(() => []);
}

// 单个接口失败（学生无权限、接口 404）不该拖垮整轮拉取。
async function getJsonSafe(base, path, token) {
  try {
    return await getJson(base, path, token);
  } catch {
    return null;
  }
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => {
      const code = parseInt(d, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
}

function stripHtml(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|td)>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function humanSize(n) {
  const b = Number(n) || 0;
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// Canvas 返回 UTC；显示成北京时间，方便直接读。
function localTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  try {
    return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function isFresh(iso, sinceMs) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return true; // 没有时间信息就当作「需要看一眼」
  return t >= sinceMs;
}

// 从页面正文里抠出指向文件的链接（有些大纲/讲义是隐藏文件，只挂链接、不出现在 Files 列表）
function extractFileIds(html) {
  const ids = new Set();
  const s = String(html || '');
  for (const m of s.matchAll(/\/files\/(\d+)/g)) ids.add(m[1]);
  for (const m of s.matchAll(/files%2F(\d+)/gi)) ids.add(m[1]);
  return ids;
}

// 课程文件：顶层文件 + 逐层文件夹（嵌套目录才是课件真正存放的地方）
async function collectCourseFiles(base, token, courseId, put) {
  const top = await getJsonSafe(base, `/api/v1/courses/${courseId}/files?per_page=100&sort=created_at&order=desc`, token);
  for (const f of asArray(top)) put(f, '');

  const roots = await getJsonSafe(base, `/api/v1/courses/${courseId}/folders?per_page=100`, token);
  await walkFolders(base, token, asArray(roots), put, 0);
}

async function walkFolders(base, token, folders, put, depth) {
  if (depth > MAX_FOLDER_DEPTH || !folders.length) return;
  for (const fo of folders) {
    if (!fo || fo.id == null) continue;
    const files = await getJsonSafe(base, `/api/v1/folders/${fo.id}/files?per_page=100`, token);
    for (const f of asArray(files)) put(f, fo.full_name || '');
    const subs = await getJsonSafe(base, `/api/v1/folders/${fo.id}/folders?per_page=100`, token);
    if (asArray(subs).length) await walkFolders(base, token, subs, put, depth + 1);
  }
}

export async function fetchAll(config) {
  if (!config?.base_url || !config?.token) throw new Error('缺少 Canvas 域名或令牌');
  const base = config.base_url.replace(/\/$/, '');
  const token = config.token;
  const lookbackDays = Math.max(1, Math.min(365, parseInt(config.lookback_days, 10) || DEFAULT_LOOKBACK_DAYS));
  const sinceMs = Date.now() - lookbackDays * 86400000;
  let courses = await getJson(base, '/api/v1/courses?enrollment_state=active&per_page=100', token);
  // 已退课 / 不再关心的课：Canvas 上可能还挂着（退课手续还没办完），
  // 在这里排掉，免得每轮巡检又把课件、日程搬回来。
  // exclude_courses 支持课程代码（POL3610J）、课程 id（97886）或课程名片段，逗号/空格分隔。
  const excluded = String(config.exclude_courses || '')
    .split(/[,;、\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (excluded.length) {
    courses = asArray(courses).filter((c) => {
      const hay = `${c.id} ${c.course_code || ''} ${c.name || ''}`.toLowerCase();
      return !excluded.some((kw) => hay.includes(kw));
    });
  }
  const items = [];
  const stats = {
    courses: courses.length, assignments: 0, events: 0,
    files: 0, pages: 0, syllabus: 0, module_items: 0, skipped_old: 0, lookback_days: lookbackDays,
  };

  for (const c of courses) {
    const cid = c.id;
    const cname = c.name || `课程 ${cid}`;
    const courseItems = [];

    // ---- 1) 作业 ----
    // 2026-09-26 晚（用户："canvas 本身做特化"）：带上 `include[]=submission`，
    // Canvas 会把「你交了没有 / 老师评了多少分」一起回给我们 —— 这才是学生真正关心的那一列。
    const asg = await getJsonSafe(base, `/api/v1/courses/${cid}/assignments?per_page=100&include[]=submission`, token);
    for (const a of asArray(asg)) {
      if (!a.due_at) continue;
      // submission 可能因为权限/未启用而缺席 —— 缺了就不写状态，别猜
      const sub = a.submission || {};
      const stateText = submitStateText(sub);
      courseItems.push({
        kind: 'task',
        external_id: `${cid}-${a.id}`,
        title: `${cname} · ${a.name}`,
        due_at: a.due_at,
        url: a.html_url || null,
        notes: [a.points_possible ? `${a.points_possible} 分` : '', stateText].filter(Boolean).join(' · '),
        course: cname,
        submit_state: String(sub.workflow_state || '').trim(),
      });
    }

    // ---- 2) 课程文件（含子文件夹）----
    const fileIds = new Set();
    const fileSeen = new Map();
    await collectCourseFiles(base, token, cid, (f, folder) => {
      if (!f || f.id == null || fileSeen.has(f.id)) return;
      fileSeen.set(f.id, { file: f, folder: folder || '' });
    });
    // 隐藏文件（hidden_for_user）在 Files 页看不到，只能用下载直链，否则点开是空白
    const fileItem = (f, folder) => {
      const when = f.created_at || f.updated_at || f.modified_at || null;
      const fallback = `${base}/courses/${cid}/files/${f.id}`;
      return {
        kind: 'file',
        external_id: `file-${cid}-${f.id}`,
        title: `${cname} · 课程文件：${f.display_name || f.filename || f.id}`,
        due_at: when,
        url: f.hidden_for_user ? (f.url || fallback) : fallback,
        notes: [
          folder ? `📁 ${folder.replace(/^course files\/?/, '') || '课程文件'}` : '',
          humanSize(f.size),
          when ? `上传 ${localTime(when)}` : '',
        ].filter(Boolean).join(' · '),
        course: cname,
        course_code: c.course_code || '',
        // 下载元数据：Planner 的「课程资料自动同步」用它把新文件落盘到桌面课程文件夹。
        // （只在本轮内存里传递，不入库；带 verifier 的 url 不能加 Authorization 头。）
        download: {
          external_id: `file-${cid}-${f.id}`,
          filename: f.display_name || f.filename || `file-${f.id}`,
          url: f.url || '',
          size: Number(f.size) || 0,
          hidden_for_user: !!f.hidden_for_user,
        },
      };
    };
    for (const { file: f, folder } of fileSeen.values()) {
      // 统一按字符串记录：下面页面 / 作业里抠出来的文件 id 都是字符串，
      // 混用数字会让"这个文件已经处理过"判重失效（同一份材料重复入库）。
      fileIds.add(String(f.id));
      const when = f.created_at || f.updated_at || f.modified_at;
      if (!isFresh(when, sinceMs)) { stats.skipped_old += 1; continue; }
      courseItems.push(fileItem(f, folder));
    }

    // ---- 3) 页面 / 资源页（含首页正文摘要）----
    const pages = await getJsonSafe(base, `/api/v1/courses/${cid}/pages?per_page=100&sort=updated_at&order=desc`, token);
    let pageRead = 0;
    for (const p of asArray(pages)) {
      const when = p.updated_at || p.created_at;
      if (!isFresh(when, sinceMs)) { stats.skipped_old += 1; continue; }
      if (pageRead >= MAX_PAGES_PER_COURSE) break;
      pageRead += 1;
      const full = await getJsonSafe(base, `/api/v1/courses/${cid}/pages/${encodeURIComponent(p.url)}`, token);
      const text = stripHtml((full && full.body) || '');
      const tag = p.front_page ? '首页' : '页面';
      const pageItem = {
        kind: 'page',
        external_id: `page-${cid}-${p.page_id || p.url}-${String(when || '').slice(0, 19)}`,
        title: `${cname} · ${tag}：${p.title || p.url}`,
        due_at: when || null,
        url: p.html_url || `${base}/courses/${cid}/pages/${p.url}`,
        notes: [when && `更新 ${localTime(when)}`, text.slice(0, 300)].filter(Boolean).join(' · '),
        course: cname,
      };
      courseItems.push(pageItem);
      // 页面里链出去的文件（例如首页挂的教学大纲 PDF，可能是隐藏文件）
      const linked = [...extractFileIds(full && full.body)];
      if (linked.length > MAX_FILES_PER_PAGE) {
        // 目录型页面（一页挂几十上百份材料）不逐个展开，只在页面备注里说明条数
        pageItem.notes += ` · 页面含 ${linked.length} 个文件链接`;
      } else {
        for (const fid of linked) {
          if (fileIds.has(fid)) continue;
          fileIds.add(fid); // 记一次就够了，避免同一文件重复请求
          const f = await getJsonSafe(base, `/api/v1/courses/${cid}/files/${fid}`, token);
          if (!f || f.id == null) continue;
          const fwhen = f.created_at || f.updated_at || f.modified_at;
          if (!isFresh(fwhen, sinceMs)) { stats.skipped_old += 1; continue; }
          courseItems.push(fileItem(f, '页面链接'));
        }
      }
    }

    // ---- 3.5) 作业里挂的文件（2026-09-18 新增）----
    // 有的老师把题面直接挂在作业描述里，文件还是 hidden_for_user：
    // 既不在课程 Files（顶层 / 子文件夹都看不到），也不在任何页面上，
    // 只有作业描述里那条 /files/<id> 链接能找到它。
    // 实例：MATH1860J 的 Assignment 1 挂着 MATH1860J_26_ex01-1.pdf（2 周时间都没抓到）。
    for (const a of asArray(asg)) {
      const awhen = a.updated_at || a.created_at;
      if (!isFresh(awhen, sinceMs)) continue;
      const linked = [...extractFileIds(a.description)];
      for (const att of asArray(a.attachments)) {
        if (att && att.id != null) linked.push(String(att.id));
      }
      if (linked.length > MAX_FILES_PER_PAGE) continue;   // 题面挂了上百份材料就不逐个展开
      for (const fid of linked) {
        if (fileIds.has(fid)) continue;
        fileIds.add(fid);
        const f = await getJsonSafe(base, `/api/v1/courses/${cid}/files/${fid}`, token);
        if (!f || f.id == null) continue;
        const fwhen = f.created_at || f.updated_at || f.modified_at;
        if (!isFresh(fwhen, sinceMs)) { stats.skipped_old += 1; continue; }
        courseItems.push(fileItem(f, `作业附件 · ${a.name || 'Assignment'}`));
      }
    }

    // ---- 4) 教学大纲（课程设置里的 syllabus_body）----
    const detail = await getJsonSafe(base, `/api/v1/courses/${cid}?include[]=syllabus_body`, token);
    const syl = stripHtml((detail && detail.syllabus_body) || '');
    if (syl) {
      courseItems.push({
        kind: 'syllabus',
        external_id: `syllabus-${cid}-${syl.length}-${syl.slice(0, 64)}`,
        title: `${cname} · 教学大纲`,
        due_at: null,
        url: detail.html_url ? `${detail.html_url}/assignments/syllabus` : `${base}/courses/${cid}/assignments/syllabus`,
        notes: syl.slice(0, 300),
        course: cname,
      });
    }

    // ---- 5) 模块里挂的资源（文件接口 401 时，模块条目往往仍可见）----
    const mods = await getJsonSafe(base, `/api/v1/courses/${cid}/modules?per_page=100&include[]=items&include[]=content_details`, token);
    let modCount = 0;
    for (const m of asArray(mods)) {
      for (const it of asArray(m.items)) {
        if (modCount >= MAX_MODULE_ITEMS_PER_COURSE) break;
        if (!['File', 'Page', 'Quiz', 'Assignment', 'ExternalUrl', 'Discussion'].includes(it.type)) continue;
        const mtitle = m.name || '模块';
        if (it.type === 'File') {
          if (it.content_id && fileIds.has(String(it.content_id))) continue; // 已在课程文件里覆盖
          const f = it.content_id ? await getJsonSafe(base, `/api/v1/courses/${cid}/files/${it.content_id}`, token) : null;
          const when = (f && (f.created_at || f.updated_at)) || null;
          if (when && !isFresh(when, sinceMs)) { stats.skipped_old += 1; continue; }
          modCount += 1;
          courseItems.push({
            kind: 'module',
            external_id: `moditem-${cid}-${it.id}`,
            title: `${cname} · 模块资料：${it.title}`,
            due_at: when,
            url: it.content_id ? `${base}/courses/${cid}/files/${it.content_id}` : it.html_url,
            notes: [`📁 ${mtitle}`, when && `上传 ${localTime(when)}`].filter(Boolean).join(' · '),
            course: cname,
            course_code: c.course_code || '',
            // 文件接口对学生会 401 的课程（如国家安全教育）拿不到 f，这种情况下只能留链接。
            download: f && f.url ? {
              external_id: `file-${cid}-${f.id}`,
              filename: f.display_name || f.filename || it.title,
              url: f.url,
              size: Number(f.size) || 0,
            } : null,
          });
        } else {
          modCount += 1;
          courseItems.push({
            kind: 'module',
            external_id: `moditem-${cid}-${it.id}`,
            title: `${cname} · 模块资源：${it.title}`,
            due_at: null,
            url: it.html_url || it.url || null,
            notes: `📁 ${mtitle}`,
            course: cname,
          });
        }
        if (modCount >= MAX_MODULE_ITEMS_PER_COURSE) break;
      }
      if (modCount >= MAX_MODULE_ITEMS_PER_COURSE) break;
    }

    // 单门课限额（作业 > 文件 > 页面 > 大纲 > 模块 的先后顺序保留）
    const kept = courseItems.slice(0, MAX_PER_COURSE);
    for (const it of kept) {
      if (it.kind === 'task') stats.assignments += 1;
      else if (it.kind === 'file') stats.files += 1;
      else if (it.kind === 'page') stats.pages += 1;
      else if (it.kind === 'syllabus') stats.syllabus += 1;
      else if (it.kind === 'module') stats.module_items += 1;
    }
    items.push(...kept);
  }

  // calendar events (exams, appointments) -> schedule
  const cals = await getJson(base, '/api/v1/calendar_events?per_page=100', token);
  for (const e of asArray(cals)) {
    if (!e.start_at) continue;
    items.push({
      kind: 'event',
      external_id: `evt-${e.id}`,
      title: e.title || 'Canvas 事件',
      start_at: e.start_at,
      end_at: e.end_at || null,
      url: e.html_url || null,
      notes: e.description || '',
      course: e.context_code || '',
    });
    stats.events += 1;
  }
  return { items, raw: stats };
}

export function fromSample() {
  const items = [];
  for (const c of canvasSample.courses) {
    for (const a of canvasSample.assignments[c.id] || []) {
      items.push({
        kind: 'task', external_id: `${c.id}-${a.id}`, title: `${c.name} · ${a.name}`,
        due_at: a.due_at, url: a.html_url || null, notes: a.points_possible ? `${a.points_possible} 分` : '', course: c.name,
      });
    }
  }
  for (const e of canvasSample.events) {
    items.push({
      kind: 'event', external_id: `evt-${e.id}`, title: e.title, start_at: e.start_at, end_at: e.end_at || null,
      url: e.html_url || null, notes: '', course: '',
    });
  }
  return { items, raw: { courses: canvasSample.courses.length, assignments: items.filter((i) => i.kind === 'task').length, events: items.filter((i) => i.kind === 'event').length } };
}
/**
 * 把 Canvas 的 `submission.workflow_state` 翻成学生真正关心的那一句话。
 * （2026-09-26 晚用户："canvas 本身做特化" —— 光有"什么时候交"不够，
 *   学生最想一眼看到的是**我交了没有、老师给了多少分**。）
 *
 * 拿不到 submission（没权限 / 未启用）时返回空串：**不猜**。
 */
export function submitStateText(sub = {}) {
  const st = String((sub && sub.workflow_state) || '').trim();
  const score = sub && sub.score !== null && sub.score !== undefined ? ` ${sub.score}` : '';
  if (st === 'graded') return `已评${score} 分`;
  if (st === 'submitted') return '已提交';
  if (st === 'unsubmitted') return '⚠️ 还没交';
  if (st === 'pending_review') return '待批改';
  return '';
}
