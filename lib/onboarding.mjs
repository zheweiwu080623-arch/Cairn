// onboarding.mjs —— 「用户入门的体验感」：把"第一次打开该做什么"变成一张会自己打勾的清单。
//
// 三条设计原则：
//   1) **不逼人**：每个步骤都能跳过，跳过的只是不打勾，不影响使用；
//   2) **不撒谎**：每一步的"完成"都从**真实状态**推出来（有没有配数据源、模型能不能用、
//      名字改没改过），而不是"你点过按钮就算完成"；
//   3) **能收起来**：看烦了点"不再显示"，状态记在本机（sync_state），刷新和换浏览器都在。
//
// 纯函数：不碰数据库、不联网；服务端只负责把状态取出来喂进来。

export const ONBOARDING_KEY = 'onboarding_state_json';
export const ONBOARDING_SCHEMA = 'onboarding.v1';

/** 推荐顺序就是数组顺序；id 稳定（界面/存储都靠它）。 */
export const ONBOARDING_STEPS = [
  {
    id: 'name',
    icon: '🏷️',
    title: '给它起个名字',
    hint: '默认叫 Cairn。名字只存在你这台机器上（data/brand.json），不会进仓库。',
  },
  {
    id: 'source',
    icon: '🔌',
    title: '连一个数据源',
    hint: '最省事的是「任意 RSS / 任意 ICS 日历」——只要一个网址，不用账号。',
  },
  {
    id: 'agent',
    icon: '🤖',
    title: '接上你自己的模型（可选）',
    hint: '不接也能用：排序、筛选、日报都是本机算的；接了才有"写建议 / 语义兜底"。',
    optional: true,
  },
  {
    id: 'docs',
    icon: '📖',
    title: '花 3 分钟看懂它怎么运作',
    hint: '打开《它是怎么运作的》：数据从哪来、存在哪、为什么能筛掉噪音。',
  },
];

const truthy = (v) => v === true || v === '1' || v === 1 || v === 'true';

/** 状态清洗：dismissed（不再显示）+ done（用户手动标记过的步骤）。 */
export function normalizeOnboarding(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const done = {};
  const src = r.done && typeof r.done === 'object' ? r.done : {};
  for (const s of ONBOARDING_STEPS) if (truthy(src[s.id])) done[s.id] = true;
  return {
    schema: ONBOARDING_SCHEMA,
    dismissed: truthy(r.dismissed),
    done,
    updated_at: Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : 0,
  };
}

/**
 * 把"真实状态"折成每一步的完成情况。
 * @param {{brand?:{custom?:boolean}, connectors?:{configured?:number}, agent?:{ready?:boolean}}} state
 */
export function computeSteps(state = {}, progress = {}) {
  const p = normalizeOnboarding(progress);
  const facts = {
    name: !!state.brand?.custom,
    source: Number(state.connectors?.configured || 0) > 0,
    agent: !!state.agent?.ready,
    docs: false,   // "看过文档"没法自动检测，只能用户自己点"我看过了"
  };
  return ONBOARDING_STEPS.map((s) => ({
    ...s,
    done: facts[s.id] === true || p.done[s.id] === true,
    auto: facts[s.id] === true,
  }));
}

/** 汇总：完成几个、下一步是什么、这张卡还要不要显示。 */
export function summarize(steps = [], progress = {}) {
  const p = normalizeOnboarding(progress);
  const required = steps.filter((s) => !s.optional);
  const doneRequired = required.filter((s) => s.done).length;
  const next = required.find((s) => !s.done) || steps.find((s) => !s.done) || null;
  return {
    total: steps.length,
    done: steps.filter((s) => s.done).length,
    required_total: required.length,
    required_done: doneRequired,
    percent: required.length ? Math.round((doneRequired / required.length) * 100) : 100,
    complete: doneRequired === required.length,
    next: next ? { id: next.id, title: next.title } : null,
    // 该不该显示：没被"不再显示"，且必做项还没做完
    show: !p.dismissed && doneRequired < required.length,
  };
}
