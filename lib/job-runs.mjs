// job-runs.mjs —— 作业运行记录（改造项 2）。
//
// 要回答的问题只有一个：**"昨天 18:00 那轮同步跑了多久、成功没？"**
// 以前得去翻 data\server.log 反推；现在每一次"真的跑了"的定时作业都会在
// `job_runs` 里留一行（ok / failed + 时长 + 摘要 + 错误）。
//
// 为什么单独一个文件：主程序 server.mjs 有一条"< 2100 行"的硬闸门，
// 它只应该留接线；记录、清理、查询这些细节放这里，顺带可以单独测。

/**
 * 调度器的回调：把一次运行写进库。
 * **它自己绝不能抛** —— 记录只是观测，不该影响作业调度。
 */
export function createJobRunRecorder(store, { warn = () => {} } = {}) {
  return (rec) => {
    try {
      store.insertJobRun(rec);
    } catch (e) {
      warn(`[job-runs] 写入失败：${(e && e.message) || e}`);
    }
  };
}

/** 启动时清一次太老的记录；保留 90 天、且不超过 2000 条。 */
export function pruneJobRuns(store, { days = 90, keep = 2000, log = () => {}, warn = () => {} } = {}) {
  try {
    const n = store.pruneJobRuns({ days, keep });
    if (n) log(`[job-runs] 清理旧记录 ${n} 条`);
    return n;
  } catch (e) {
    warn(`[job-runs] 清理失败：${(e && e.message) || e}`);
    return 0;
  }
}

/**
 * `/api/job-runs` 的响应体。
 * 参数直接从 URL 上读：`?days=2&limit=50&job=autosync`（days<=0 表示不限时间）。
 */
export function jobRunsResponse(store, url, nowMs = Date.now()) {
  const days = Number(url?.searchParams?.get('days') ?? 2);
  const rawLimit = Number(url?.searchParams?.get('limit') ?? 50);
  const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));
  const jobId = url?.searchParams?.get('job') || null;
  const since = Number.isFinite(days) && days > 0 ? nowMs - days * 86400000 : null;

  const runs = store.listJobRuns({ jobId, since, limit });
  // 顺手给每个作业的"最近一次"，界面不用自己归并
  const last = {};
  for (const r of runs) if (!last[r.job_id]) last[r.job_id] = r;
  return { days, job: jobId, count: runs.length, last_by_job: last, runs };
}
