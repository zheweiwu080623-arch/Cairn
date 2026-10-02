// dashboard.mjs —— 首页卡片（改造项 3）。
//
// 目标：**插一行数据 = 首页多一张卡**。
// `dashboard_cards` 表只存"放哪张卡、多大、第几位、配置是什么"；
// 卡片**画什么内容**由这里的 CARD_TYPES 决定（纯函数，不碰 DOM、不发请求）。
//
// 为什么这么分：以前给首页加一块内容要改 public/app.js；现在前端只认
// "标题 + 几行"，内容是后端按 contracts/dashboard.v1 契约产出的。
// **加一种卡 = 在这里加一个类型 + 往表里插一行**，前端一行不用改。

import { dayKey } from '../public/viewmodel.js';
// Anki 只读读取：首页那张「Anki 复习」卡要"今日待复习多少张"。
// 它自己会把 collection 复制到临时目录再读，失败也只返回 { ok:false }，不会拖垮首页。
import { readAnki } from './anki.mjs';

export const DASHBOARD_SCHEMA = 'dashboard.v1';
export const CARD_SIZES = ['sm', 'md', 'lg'];

const row = (label, value, meta = '', level = 'info') => ({ label, value: String(value), meta, level });
const isDone = (t) => t && (t.status === 'done' || t.status === 'cancelled');

/**
 * 「原生面板」：内容和交互由 public/app.js 的 renderToday() 自己画（后端不产出它们的行），
 * 但**摆在首页哪个位置、多宽、留不留**由同一张 dashboard_cards 表说了算 ——
 * 前端 public/dashboard-cards.js 会把这些 DOM 节点**搬**进卡片网格，于是它们自动获得
 * 同一套 ↑ ↓ ⤢ ✕（用户 2026-10-02：「底下的这些理论上也应该是可以活动的卡片」）。
 *
 * 这里只登记"有哪些面板、标题叫什么、默认多宽"。标题是前端用来**认面板**的键
 * （app.js 里那几张卡的 <h3> 文字），改标题 = 前端就认不出来了，两边要一起改。
 */
export const NATIVE_CARDS = {
  student: { title: '学生', size: 'lg' },               // public/app.js 的 #student-card
  'stat-events': { title: '今日日程', size: 'sm' },   // 三格统计
  'stat-todo': { title: '待办任务', size: 'sm' },
  'stat-done': { title: '任务完成', size: 'sm' },
  'today-schedule': { title: '今天的安排', size: 'md' },
  attention: { title: '需要关注的任务', size: 'md' },
  reminders: { title: '即将到来的提醒', size: 'md' },
  upcoming: { title: '未来任务', size: 'md' },
  codex: { title: 'Codex 连接', size: 'lg' },
};

/**
 * 内置卡片类型。每种返回 `{ title, note?, rows:[{label,value,meta,level}] }`。
 * level ∈ ok | warn | error | info | muted（前端只按这个上色）。
 */
export const CARD_TYPES = {
  today: {
    title: '今日',
    size: 'md',
    build({ store, nowMs }) {
      const today = dayKey(new Date(nowMs));
      const tasks = store.listTasks ? store.listTasks() : [];
      const dueToday = tasks.filter((t) => !isDone(t) && t.due_at && dayKey(t.due_at) === today).length;
      const overdue = tasks.filter((t) => !isDone(t) && t.due_at && String(t.due_at) < today).length;
      return {
        title: '今日',
        note: today,
        rows: [
          row('到期任务', dueToday, '今天截止', dueToday ? 'warn' : 'ok'),
          row('逾期任务', overdue, '需要先处理', overdue ? 'error' : 'ok'),
          row('课表条目', (store.listCourses ? store.listCourses() : []).length, '整学期'),
        ],
      };
    },
  },
  jobs: {
    title: '作业运行',
    size: 'md',
    build({ store, nowMs }) {
      const runs = store.listJobRuns ? store.listJobRuns({ since: nowMs - 86400000, limit: 400 }) : [];
      const last = {};
      for (const r of runs) if (!last[r.job_id]) last[r.job_id] = r;   // listJobRuns 已按时间倒序
      const ids = Object.keys(last);
      if (!ids.length) {
        return { title: '作业运行', note: '最近 24 小时', rows: [row('还没有记录', '—', '等下一轮作业跑完')] };
      }
      return {
        title: '作业运行',
        note: '最近 24 小时',
        rows: ids.slice(0, 6).map((id) => {
          const r = last[id];
          const ok = r.status === 'ok';
          return row(id, ok ? `${r.duration_ms} ms` : '失败',
            ok ? '正常' : String(r.error || '').slice(0, 40), ok ? 'ok' : 'error');
        }),
      };
    },
  },
  sources: {
    title: '数据源',
    size: 'sm',
    build({ store }) {
      const conns = store.listConnectors ? store.listConnectors() : [];
      return {
        title: '数据源',
        rows: conns.length
          ? conns.slice(0, 6).map((c) => row(c.source, store.countConnectorData ? store.countConnectorData(c.source) : 0, '条'))
          : [row('还没有数据源', '—', '去「数据源」页添加')],
      };
    },
  },
  // 「Anki 复习」是**只读**卡：数字来自本机 Anki 的 collection（lib/anki.mjs 复制一份再读）。
  // 它不写库、不发网络请求；没装桌面版 / 没同步过也只是一行提示。
  // 默认不放首页（Anki 不是人人都用），在「添加卡片」里选一次即可。
  anki: {
    title: 'Anki 复习',
    size: 'sm',
    build({ nowMs, anki }) {
      const a = anki === undefined ? readAnki({ nowMs }) : anki;
      if (!a || !a.ok) {
        return {
          title: 'Anki 复习',
          note: '本机 Anki 库',
          rows: [row('读不到 Anki', '—', String((a && a.error) || '未接入'), 'warn')],
        };
      }
      const due = a.due || { new: 0, learning: 0, review: 0, total: 0 };
      return {
        title: 'Anki 复习',
        note: '只读 · 不套每日上限',
        rows: [
          row('今日待复习', `${due.total} 张`, due.total ? '挑一段完整时间过一遍' : '今天清空了', due.total ? 'warn' : 'ok'),
          row('新 / 学 / 复习', `${due.new} / ${due.learning} / ${due.review}`, '按库里到期数估算'),
          a.never_synced
            ? row('同步', '从未同步', '电脑上登录 AnkiWeb 后点一次同步', 'error')
            : row('最后同步', a.last_sync_at ? new Date(a.last_sync_at).toLocaleString() : '未知', `共 ${a.total_cards} 张卡 / ${a.total_notes} 条笔记`, 'ok'),
        ],
      };
    },
  },
};

/**
 * 首页默认摆哪几张卡（只在表为空时安装一次）。
 * **顺序 = 原来首页的样子**：学生卡在最上（它本来就是 renderStudentCard 插在最前面的），
 * 接着三格统计、几张长面板、Codex 连接；新加的三张内置卡（今日 / 作业运行 / 数据源）
 * 排在最底下 —— 老用户第一次升级看到的版面跟原来一样，只是每张卡都多了一套按钮。
 */
const NATIVE_DEFAULTS = Object.entries(NATIVE_CARDS).map(([card_id, t], i) => (
  { module_id: 'native', card_id, size: t.size, position: i }
));
const BUILTIN_DEFAULTS = ['today', 'jobs', 'sources'];
export const DEFAULT_CARDS = [
  ...NATIVE_DEFAULTS,
  ...BUILTIN_DEFAULTS.map((card_id, i) => (
    { module_id: 'builtin', card_id, size: CARD_TYPES[card_id].size, position: NATIVE_DEFAULTS.length + i }
  )),
];

/** 首次启动装一遍默认卡片；已有卡片就什么都不做。 */
export function seedDashboardCards(store, log = () => {}) {
  try {
    if (store.listDashboardCards().length) return 0;
    for (const c of DEFAULT_CARDS) store.upsertDashboardCard(c);
    log(`[dashboard] 已安装 ${DEFAULT_CARDS.length} 张默认卡片`);
    return DEFAULT_CARDS.length;
  } catch (e) {
    log(`[dashboard] 安装默认卡片失败：${(e && e.message) || e}`);
    return 0;
  }
}

/**
 * 把"卡片表 + 各类型的内容"合成首页要渲染的东西（纯函数，方便测）。
 * 认不出的类型不报错，而是给一张提示卡 —— 一行坏数据不该把首页弄白。
 */
export function buildDashboardVM(store, { cards = null, nowMs = Date.now(), anki } = {}) {
  const list = (cards || (store.listDashboardCards ? store.listDashboardCards() : [])).slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));

  const out = list.map((c) => {
    const native = c.module_id === 'native' ? NATIVE_CARDS[c.card_id] : null;
    const kind = native ? 'native' : (CARD_TYPES[c.card_id] ? 'builtin' : 'unknown');
    const base = {
      id: c.id,
      module_id: c.module_id,
      card_id: c.card_id,
      size: CARD_SIZES.includes(c.size) ? c.size : 'md',
      position: Number(c.position) || 0,
      kind,
    };
    // 原生面板：内容在前端手里（app.js 画的 DOM 节点），这里只给标题与摆放信息
    if (native) return { ...base, title: native.title, rows: [] };
    const type = CARD_TYPES[c.card_id];
    if (!type) {
      return {
        ...base, title: c.card_id, note: '未知卡片类型',
        rows: [row('认不出这种卡', c.card_id, '检查 card_id 拼写', 'warn')],
      };
    }
    try {
      return { ...base, ...type.build({ store, nowMs, anki }) };
    } catch (e) {
      return {
        ...base, title: type.title, note: '这卡算不出来',
        rows: [row('出错了', String((e && e.message) || e).slice(0, 60), '', 'error')],
      };
    }
  });

  return { schema: DASHBOARD_SCHEMA, generated_at: new Date(nowMs).toISOString(), count: out.length, cards: out };
}

/** 可用的卡片类型（给"添加卡片"的下拉框用）。 */
export function availableCardTypes() {
  return [
    ...Object.entries(CARD_TYPES).map(([id, t]) => ({ id, title: t.title, kind: 'builtin', size: t.size || 'md' })),
    ...Object.entries(NATIVE_CARDS).map(([id, t]) => ({ id, title: t.title, kind: 'native', size: t.size })),
  ];
}

/** 按 position 排好、并把 position 规整成 0..n-1（换位之后调一次）。 */
function renumber(store) {
  const cards = store.listDashboardCards().slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  cards.forEach((c, i) => {
    if (Number(c.position) !== i) {
      store.upsertDashboardCard({ module_id: c.module_id, card_id: c.card_id, size: c.size, position: i });
    }
  });
  return cards;
}

/**
 * `/api/dashboard*` 的全部接口。
 *
 * 为什么放在这里而不是 server.mjs：主程序有一条 2100 行硬闸门，
 * 它只该留一行分发；具体规则（含参数校验）属于这个模块，也方便单测。
 *
 * 返回 true 表示"这个请求我处理了"，server.mjs 直接 return。
 */
export async function handleDashboardApi(req, res, url, store, { sendJson, readBody } = {}) {
  const p = url.pathname;
  if (!p.startsWith('/api/dashboard')) return false;
  const method = req.method || 'GET';

  if (p === '/api/dashboard' && method === 'GET') {
    sendJson(res, 200, buildDashboardVM(store));
    return true;
  }
  if (p === '/api/dashboard/available' && method === 'GET') {
    sendJson(res, 200, { types: availableCardTypes() });
    return true;
  }

  const body = method === 'POST' ? await readBody(req) : {};

  // 添加：position 默认排到最后
  if (p === '/api/dashboard/cards' && method === 'POST') {
    const card_id = String(body.card_id || '');
    const native = NATIVE_CARDS[card_id];
    if (!CARD_TYPES[card_id] && !native) {
      sendJson(res, 400, { error: `没有这种卡片类型：${card_id}` });
      return true;
    }
    const cards = store.listDashboardCards();
    const maxPos = cards.length ? Math.max(...cards.map((c) => Number(c.position) || 0)) : -1;
    // 原生面板必须归到 module_id='native'：它和表里的那一行是同一张卡，
    // 归错组（比如 custom）会出现"两张同名卡"，删掉一张另一张还在。
    const id = store.upsertDashboardCard({
      module_id: native ? 'native' : String(body.module_id || 'custom'),
      card_id,
      // 不指定宽度就用"这种卡默认多宽"（数据源是 1/3），别一律塞 md
      size: CARD_SIZES.includes(body.size) ? body.size
        : (native ? native.size : (CARD_TYPES[card_id].size || 'md')),
      position: maxPos + 1,
    });
    sendJson(res, 200, { ok: true, id, dashboard: buildDashboardVM(store) });
    return true;
  }

  // 换位 / 删除 / 改尺寸
  const m = /^\/api\/dashboard\/cards\/([^/]+)\/(move|remove|resize)$/.exec(p);
  if (m && method === 'POST') {
    const id = decodeURIComponent(m[1]);
    const act = m[2];
    const cards = store.listDashboardCards().slice()
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
    const i = cards.findIndex((c) => c.id === id);
    if (i < 0) {
      sendJson(res, 404, { error: '没有这张卡' });
      return true;
    }
    if (act === 'remove') {
      store.deleteDashboardCard(id);
      renumber(store);
    } else if (act === 'resize') {
      const size = CARD_SIZES.includes(body.size) ? body.size : 'md';
      store.upsertDashboardCard({ module_id: cards[i].module_id, card_id: cards[i].card_id, size, position: i });
    } else if (act === 'move') {
      const delta = Number(body.delta) < 0 ? -1 : 1;
      const j = Math.min(cards.length - 1, Math.max(0, i + delta));
      if (j !== i) {
        const a = cards[i]; const b = cards[j];
        store.upsertDashboardCard({ module_id: a.module_id, card_id: a.card_id, size: a.size, position: j });
        store.upsertDashboardCard({ module_id: b.module_id, card_id: b.card_id, size: b.size, position: i });
      }
    }
    sendJson(res, 200, { ok: true, dashboard: buildDashboardVM(store) });
    return true;
  }

  sendJson(res, 404, { error: '没有这个接口' });
  return true;
}
