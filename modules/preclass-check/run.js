// 再处理功能：上课前 Canvas 检查（preclass-check）
//
// 触发：调度器在"某节课开始前 N 分钟"（默认 30）产出一条 signal（见 lib/preclass.mjs）。
// 本功能收到后：
//   1) 只查**这一门课**的 Canvas（文件 / 页面 / 公告 / 作业 / 小测，只读）；
//   2) 和"上次检查记下的指纹"比对，只报**新出现的**；
//   3) 有新东西 → 产出一条应用内通知（标题带课号与分钟数）；你勾了手机推送就再加一条**短句**推送；
//   4) 没有新东西 → **返回空数组**（安静是正确结果，不为了刷存在感硬造通知）；
//   5) 查不到（没配 Canvas / 网络失败 / 这门课不在 Canvas 上）→ 也不打扰，只留一行日志。

export async function run(input = {}, ctx = {}) {
  const meta = input.meta || {};
  const { courseCode, courseName, minutesLeft = 0, sinceMs } = meta;
  if (!courseCode) return [];
  if (!ctx.canvas || typeof ctx.canvas.checkCourse !== 'function') {
    ctx.log?.('[preclass-check] 没有可用的 Canvas 检查能力，跳过');
    return [];
  }

  let check = null;
  try {
    check = await ctx.canvas.checkCourse({ courseCode, sinceMs });
  } catch (e) {
    ctx.log?.(`[preclass-check] ${courseCode} 检查出错：${(e && e.message) || e}`);
    return [];
  }
  if (!check || check.ok !== true) {
    ctx.log?.(`[preclass-check] ${courseCode} 没查成：${(check && check.error) || '未知原因'}`);
    return [];                                  // 失败也安静：不去打扰，只留日志
  }

  const all = Array.isArray(check.items) ? check.items : [];
  const fresh = ctx.dedupe ? ctx.dedupe.filterNew(all, { scope: courseCode }) : all;
  if (!fresh.length) {
    ctx.log?.(`[preclass-check] ${courseCode}：${minutesLeft} 分钟后上课，没有新东西`);
    return [];
  }

  const head = fresh.slice(0, 3).map((x) => `· ${x.title}`).join('\n');
  const title = `⏱️ ${courseCode} ${minutesLeft} 分钟后上课 · 有 ${fresh.length} 条新东西`;
  const actions = [{
    type: 'notify',
    summary: title,
    target: { kind: 'notification', course: courseCode, url: fresh[0]?.url || null },
    idempotency_key: `preclass:${courseCode}:${meta.dateKey || ''}`,
    permissions: ['notify:app'],
    payload: {
      text: `${check.course?.name || courseName || ''}\n${head}\n（${fresh.length} 条：${[...new Set(fresh.map((x) => x.type))].join(' / ')}）`,
    },
  }];

  const prefs = typeof ctx.prefs === 'function' ? (ctx.prefs() || {}) : {};
  if (prefs.bark) {
    actions.push({
      type: 'push',
      summary: `${courseCode} 快上课了`,
      target: { kind: 'phone', course: courseCode },
      idempotency_key: `preclass-push:${courseCode}:${meta.dateKey || ''}`,
      permissions: ['notify:phone'],
      payload: { push: `${minutesLeft} 分钟后上课｜${courseCode} 有 ${fresh.length} 条新东西` },   // 手机只发短句
    });
  }

  ctx.dedupe?.markSeen(all, { scope: courseCode });
  return actions;
}
