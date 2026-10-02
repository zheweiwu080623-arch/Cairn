// app-status.v1：Planner 的机器可读健康状态（P1-8）。
//
// 与 /api/health 的关系：health 是"人看的历史接口"，这个是把同样的信息按
// contracts/app-status.v1.schema.json 整理成**两个应用通用**的结构，
// 这样 windows\status.ps1 只要读 JSON，不用解析任何文本/日志。
export const APP_STATUS_SCHEMA = 'app-status.v1';

const iso = (moment = new Date()) => moment.toISOString();

function levelFor(state) {
  return ['ok', 'warn', 'error', 'idle', 'running', 'down'].includes(state) ? state : 'ok';
}

/**
 * @param {object} health /api/health 的返回值（buildHealth()）
 * @param {object} [extra] 可选补充：{ courseSync, planExport, serverPid }
 */
export function buildPlannerAppStatus(health = {}, extra = {}) {
  const watch = health.canvas_watch || {};
  const autostart = health.autostart || {};
  const counts = health.counts || {};

  const sections = [
    {
      id: 'core',
      label: '核心服务',
      state: 'ok',
      detail: `http 127.0.0.1:${health.port ?? '?'} · node ${health.node ?? '?'} · 运行 ${Math.round((health.uptime_sec || 0) / 60)} 分钟`,
    },
    {
      id: 'canvas_watch',
      label: 'Canvas 巡检',
      state: watch.last_error ? 'warn' : (watch.enabled ? 'ok' : 'idle'),
      detail: watch.last_error ? `上次失败：${String(watch.last_error).slice(0, 80)}` : `每 ${watch.interval_hours ?? '?'} 小时`,
      last_run: watch.last_run || null,
      next_run: watch.next_run || null,
    },
    {
      id: 'autostart',
      label: '开机自启',
      state: autostart.enabled ? 'ok' : 'warn',
      detail: autostart.enabled ? '已启用' : `未启用${autostart.supported === false ? '（当前平台不支持）' : ''}`,
    },
  ];

  // 数据版本（2026-09-21 新增）：换新版本之后旧数据有没有升级成功，在这里一眼能看到。
  if (extra.schemaInfo && typeof extra.schemaInfo === 'object') {
    const pending = Array.isArray(extra.schemaInfo.pending) ? extra.schemaInfo.pending : [];
    sections.push({
      id: 'data',
      label: '数据版本',
      state: extra.schemaInfo.error ? 'warn' : (pending.length ? 'warn' : 'ok'),
      detail: extra.schemaInfo.error
        ? `升级失败：${String(extra.schemaInfo.error).slice(0, 80)}`
        : (extra.schemaInfo.detail || `数据版本 ${extra.schemaInfo.version ?? '?'}`),
    });
  }

  if (extra.courseSync && typeof extra.courseSync === 'object') {
    const pending = extra.courseSync.counts?.pending_device ?? extra.courseSync.pending_device ?? null;
    const failed = extra.courseSync.counts?.failed ?? null;
    sections.push({
      id: 'course_sync',
      label: '课程资料同步',
      state: failed ? 'warn' : 'ok',
      detail: `${pending != null ? `待同步 ${pending} 项` : '运行中'}${failed ? `，失败 ${failed} 项` : ''}`,
    });
  }
  if (extra.planExport && typeof extra.planExport === 'object') {
    sections.push({
      id: 'plan_export',
      label: '计划导出',
      state: extra.planExport.error ? 'warn' : 'ok',
      detail: extra.planExport.error
        ? String(extra.planExport.error).slice(0, 80)
        : `最近导出 ${extra.planExport.exported_at || '（未记录）'}`,
    });
  }

  const state = sections.some((s) => s.state === 'error') ? 'error'
    : sections.some((s) => s.state === 'warn') ? 'warn' : 'ok';

  return {
    schema: APP_STATUS_SCHEMA,
    app: 'planner',
    version: extra.version || 'Vol.2.5',
    running: health.ok !== false,
    pid: health.pid ?? null,
    started_at: health.started_at || null,
    heartbeat_at: iso(extra.now instanceof Date ? extra.now : new Date()),
    state: levelFor(state),
    sections,
    metrics: {
      tasks: counts.tasks ?? null,
      notifications: counts.notifications ?? null,
      pending: counts.pending ?? null,
      uptime_sec: health.uptime_sec ?? null,
      port: health.port ?? null,
    },
  };
}
