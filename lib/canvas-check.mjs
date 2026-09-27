// canvas-check.mjs —— **针对一门课**的只读 Canvas 检查（给"上课前 30 分钟 checks"用）
//
// 为什么不直接复用 `lib/connectors/canvas.mjs`：那个是"一轮抓全部课程"的巡检，
// 单门课要跑几十个请求；上课前只需要**这一门课最近有没有新东西**，所以另写一条小路：
//   1) 拉一次课程列表（一次请求），按 course_code 找到这门课；
//   2) 只查这一门课的五类位置：文件 / 页面 / 公告 / 作业 / 小测；
//   3) 只保留 `sinceMs` 之后有更新的条目（没有时间字段的按"可能新"保留，宁可多看一眼）。
//
// 全程 **GET、只读**；令牌只在本进程内存里用，不打印、不落盘。

const FETCH_TIMEOUT_MS = 20000;

/** 从连接器配置里取 Canvas 的地址与令牌（读的是加密存储，解密由 store 负责）。 */
export function canvasConfigFromStore(store) {
  const row = store && store.getConnector ? store.getConnector('canvas') : null;
  if (!row) return { ok: false, error: '还没有配置 Canvas 数据源' };
  let cfg = {};
  try { cfg = JSON.parse(row.config_json || '{}'); } catch { cfg = {}; }
  if (!cfg.base_url || !cfg.token) return { ok: false, error: 'Canvas 配置里缺少域名或令牌' };
  return { ok: true, base_url: String(cfg.base_url).replace(/\/$/, ''), token: String(cfg.token) };
}

const ymdhms = (v) => {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : null;
};

/** 五类位置各自的取数与归一化。 */
function sourcesFor(base, cid) {
  return [
    {
      type: 'file',
      path: `/api/v1/courses/${cid}/files?per_page=40&sort=created_at&order=desc`,
      pick: (x) => ({
        id: `file-${x.id}`, title: x.display_name || x.filename || `file ${x.id}`,
        at: x.created_at || x.updated_at || x.modified_at || null,
        url: `${base}/courses/${cid}/files/${x.id}`,
      }),
    },
    {
      type: 'page',
      path: `/api/v1/courses/${cid}/pages?per_page=40&sort=updated_at&order=desc`,
      pick: (x) => ({
        id: `page-${x.page_id || x.url}`, title: x.title || x.url,
        at: x.updated_at || x.created_at || null,
        url: x.html_url || `${base}/courses/${cid}/pages/${x.url}`,
      }),
    },
    {
      type: 'announcement',
      path: `/api/v1/courses/${cid}/discussion_topics?only_announcements=true&per_page=20`,
      pick: (x) => ({
        id: `ann-${x.id}`, title: x.title || `announcement ${x.id}`,
        at: x.posted_at || x.created_at || null,
        url: x.html_url || `${base}/courses/${cid}/discussion_topics/${x.id}`,
      }),
    },
    {
      type: 'assignment',
      path: `/api/v1/courses/${cid}/assignments?per_page=40&order_by=due_at`,
      pick: (x) => ({
        id: `assign-${x.id}`, title: x.name || `assignment ${x.id}`,
        at: x.updated_at || x.created_at || null,
        url: x.html_url || `${base}/courses/${cid}/assignments/${x.id}`,
      }),
    },
    {
      type: 'quiz',
      path: `/api/v1/courses/${cid}/quizzes?per_page=20`,
      pick: (x) => ({
        id: `quiz-${x.id}`, title: x.title || `quiz ${x.id}`,
        at: x.updated_at || x.published_at || null,
        url: x.html_url || `${base}/courses/${cid}/quizzes/${x.id}`,
      }),
    },
  ];
}

/**
 * 查一门课最近有没有新东西。
 * @param {{config?:{base_url:string,token:string}, store?:object, courseCode:string, sinceMs?:number,
 *          fetchImpl?:Function, maxPerType?:number}} opts
 */
export async function checkCourseForNewMaterial({
  config = null, store = null, courseCode, sinceMs = 48 * 3600000,
  fetchImpl = fetch, maxPerType = 20,
} = {}) {
  const cfg = config || canvasConfigFromStore(store);
  if (!cfg || cfg.ok !== true) return { ok: false, error: (cfg && cfg.error) || '没有可用的 Canvas 配置' };
  const code = String(courseCode || '').trim();
  if (!code) return { ok: false, error: '没有给课程代码' };
  const base = cfg.base_url;
  const headers = { Authorization: `Bearer ${cfg.token}` };
  const get = async (path) => {
    const res = await fetchImpl(base + path, {
      headers, signal: AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}：${path}`);
    return res.json().catch(() => []);
  };
  const getSafe = async (path) => { try { return await get(path); } catch { return null; } };

  let courses = [];
  try {
    courses = await get('/api/v1/courses?enrollment_state=active&per_page=100');
  } catch (e) {
    return { ok: false, error: `连 Canvas 失败：${(e && e.message) || e}` };
  }
  const hit = (Array.isArray(courses) ? courses : []).find((c) => {
    const hay = `${c.course_code || ''} ${c.name || ''}`.toUpperCase();
    return hay.includes(code.toUpperCase());
  });
  if (!hit) return { ok: false, error: `Canvas 上没找到这门课（${code}）`, courses: (courses || []).length };

  const items = [];
  const checked = {};
  for (const src of sourcesFor(base, hit.id)) {
    const rows = await getSafe(src.path);
    checked[src.type] = Array.isArray(rows) ? rows.length : '×';
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const item = src.pick(row);
      const t = ymdhms(item.at);
      if (t !== null && t < sinceMs) continue;          // 太老的不要
      items.push({ type: src.type, ...item });
      if (items.filter((x) => x.type === src.type).length >= maxPerType) break;
    }
  }
  return {
    ok: true,
    course: { id: hit.id, code: hit.course_code || code, name: hit.name || '' },
    items, checked,
  };
}
