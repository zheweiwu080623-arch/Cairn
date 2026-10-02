// notify-tick.mjs —— 后台心跳：**每一轮该做什么**都在这里（2026-09-24 从主程序整块搬出来）。
//
// 为什么要搬：主程序有个"别再长回去"的行数护栏，而这块是纯调度 —— 每一件事本身都在别处实现，
// 这里只负责"到点没有 / 该不该跑 / 出错不要连坐"。搬出来之后：
//   * 主程序只剩一张 **jobs 清单**（加一件定时的事 = 加一行），D5 的「每日 18:00 开工」就是这么插进来的；
//   * 调度逻辑本身可以离线测（注入假时钟、假任务），不用起服务、不用等 4 秒。
//
// 三条刻意的行为（与搬出来之前**逐字保持**一致）：
//   1) **一个任务炸了不影响其它任务**（各自 try/catch，只留一行日志）；
//   2) 一轮跑完**一定**排下一轮（放在 finally 里，不会因为异常把心跳打断）；
//   3) 每小时留一行 `[heartbeat]` 日志 —— 事后翻日志就能确认"整晚都在跑"。

export function createTickRunner({
  store = null,
  fireReminders = async () => [],      // 「到点就响」的提醒（返回触发了哪几条）
  heartbeat = null,                    // 每小时一次的心跳日志（(info) => void）
  jobs = [],                           // [{ name, due: () => boolean, run: async () => ({ok?,note?}) }]
  intervalMs = 4000,
  heartbeatEveryMs = 3600000,
  log = (m) => console.log(m),
  warn = (m) => console.error(m),
  now = () => Date.now(),
  // 作业运行记录钩子（改造项 2）：每有一次作业**真的跑了**就回调一次，
  // 由主程序决定怎么写（默认什么都不做，保持这个文件可单独测）。
  onJobRun = null,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
} = {}) {
  const startedAt = now();
  let lastHeartbeat = startedAt;
  let timer = null;
  let running = false;

  /**
   * 记一次作业运行。**这个函数自己绝不抛**——它只是观测，不该影响调度。
   */
  function record(jobId, { status, startedAtMs, summary = '', error = '' }) {
    if (!onJobRun) return;
    try {
      onJobRun({
        job_id: jobId,
        trigger: 'tick',
        status,
        started_at: startedAtMs,
        finished_at: now(),
        duration_ms: Math.max(0, now() - startedAtMs),
        summary: summary || null,
        error: error || null,
      });
    } catch (e) {
      warn(`[job-runs] 记录 ${jobId} 失败：${(e && e.message) || e}`);
    }
  }

  /** 跑一轮（可离线调用；返回这一轮发生了什么，方便测）。 */
  async function tickOnce() {
    const out = { at: now(), fired: [], ran: {}, skipped: [], errors: [] };
    try {
      try {
        const fired = await fireReminders();
        out.fired = Array.isArray(fired) ? fired : [];
        if (out.fired.length) log(`[notify] ${out.fired.length} 条提醒已触发`);
      } catch (e) {
        out.errors.push(['reminders', (e && e.message) || String(e)]);
        warn(`[notify] 触发提醒出错：${(e && e.message) || e}`);
      }

      // 心跳：每小时一行，事后能确认后台一直在跑
      if (heartbeat && now() - lastHeartbeat > heartbeatEveryMs) {
        lastHeartbeat = now();
        try {
          heartbeat({ uptime_minutes: Math.round((now() - startedAt) / 60000), notifications: store ? store.listNotifications().length : null });
        } catch (e) { warn(`[heartbeat] 写日志出错：${(e && e.message) || e}`); }
      }

      for (const job of jobs) {
        let due = false;
        try { due = job.due ? !!job.due() : true; } catch (e) {
          out.errors.push([job.name, `判断该不该跑时出错：${(e && e.message) || e}`]);
          warn(`[${job.name}] 判断出错：${(e && e.message) || e}`);
          continue;
        }
        if (!due) { out.skipped.push(job.name); continue; }
        const startedAtMs = now();
        try {
          const r = await job.run();
          out.ran[job.name] = r === undefined ? true : r;
          if (r && r.note) log(`[${job.name}] ${r.note}`);
          // **只记"真的干了活"或"明确报错"的那些**。
          // 这里有个必须记住的坑（上线第一天就踩到）：本仓库多数作业的 due 是恒真、
          // 靠作业内部节流（没到时候就返回 { ok:false } 且不带说明）。如果按"跑了就记"，
          // 4 秒一轮 × 十来个作业 = 一天十几万行，把表刷爆；而且会把"这次没事做"
          // 误报成"失败"。所以判据是：有 note（干了活）或 error（明确出错）才记。
          if (r && (r.note || r.error)) {
            record(job.name, {
              status: r.error ? 'failed' : 'ok',
              startedAtMs,
              summary: r.note || '',
              error: r.error ? String(r.error) : '',
            });
          }
        } catch (e) {
          out.errors.push([job.name, (e && e.message) || String(e)]);
          warn(`[${job.name}] error ${(e && e.message) || e}`);      // 一个任务失败不影响其它任务
          record(job.name, { status: 'failed', startedAtMs, error: (e && e.message) || String(e) });
        }
      }
    } catch (e) {
      out.errors.push(['tick', (e && e.message) || String(e)]);
      warn(`[notify] error ${(e && e.message) || e}`);
    }
    return out;
  }

  /** 排下一轮（幂等：重复调用只会留一个定时器）。 */
  function schedule() {
    if (timer) timers.clear(timer);
    timer = timers.set(async () => {
      running = true;
      try { await tickOnce(); } catch { /* tickOnce 自己兜了，这里只是保险 */ } finally {
        running = false;
        schedule();                       // ← 一定要排下一轮，哪怕这一轮出过错
      }
    }, intervalMs);
    return timer;
  }

  return {
    tickOnce,
    start: () => schedule(),
    stop: () => { if (timer) timers.clear(timer); timer = null; },
    isRunning: () => running,
    hasTimer: () => timer !== null,
    uptimeMinutes: () => Math.round((now() - startedAt) / 60000),
  };
}
