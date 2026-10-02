// processor-executors.mjs —— 「再处理功能」真正动手的那三个执行能力。
//
// 为什么单独一个文件：功能本身（modules/*/run.js）是**别人写的、可以来自功能商店**，
// 所以"它说要做的事"和"系统真的去做"必须分开审 —— 这一份就是"真的去做"的那半边：
//   notify → 本机通知表（source 记成 `processor:<id>`，谁发的看得见）
//   push   → 手机短句（走既有 Bark 通道，**受来源过滤约束**，功能不越权）
//   file   → 写文件（只允许写 `<数据目录>/study/`，闸门在 lib/course-stack.mjs）
//   task   → 在本机建一条任务（2026-10-02 加）
//
// 编排在 lib/routes/modules.mjs（默认演练、动作规范化、记账），这里只做"怎么做"。

export function createProcessorExecutors({ store, barkNotify, writeFile, log = () => {} } = {}) {
  return {
    notify: (a, mod) => {
      const notif = store.createNotification({
        title: String(a.summary || `${mod.name} 的提醒`).slice(0, 120),
        message: String(a.payload?.text || a.result?.detail || ''),
        trigger_at: new Date().toISOString(), repeat: 'none',
        source: `processor:${mod.id}`, external_id: a.idempotency_key || null,
        priority: 1, url: a.target?.url || null,
      });
      return { ok: true, detail: `通知已建（${notif && notif.id ? 'ok' : 'no-id'}）` };
    },

    push: async (a, mod) => {
      const r = await barkNotify({
        title: String(a.summary || mod.name).slice(0, 40),
        body: String(a.payload?.push || '').slice(0, 60),   // 手机只发短句
        url: a.target?.url || '', level: 'active', source: `processor:${mod.id}`,
      });
      return { ok: !!(r && r.ok), detail: r && r.ok ? '已推送' : `未推送（${(r && (r.skipped || r.error)) || '未知'}）` };
    },

    file: (a) => {
      if (typeof writeFile !== 'function') return { ok: false, error: '这台机器上没有可用的写文件能力' };
      log(`[processor] 写文件：${a.target?.path || a.payload?.path || ''}`);
      return writeFile(a);
    },

    /**
     * 建任务：把"再处理的结果"变成用户待办清单里的一条。
     * 边界：只建**一条**、只认标题/截止时间/优先级/备注；**不替用户改已有任务、不删任务**。
     * 幂等靠 external_id：同一个 idempotency_key 再来一次不会建第二条（重跑安全）。
     */
    task: (a, mod) => {
      const title = String(a.payload?.title || '').trim();   // 只认 payload.title，不用默认摘要兜底
      if (!title) return { ok: false, error: 'task 动作没有标题（payload.title）' };
      const key = a.idempotency_key || null;
      if (key && typeof store.listTasks === 'function') {
        const dup = store.listTasks().find((t) => t.source === `processor:${mod.id}` && t.notes && t.notes.includes(`[${key}]`));
        if (dup) return { ok: true, detail: `已经有了（${dup.id}），这次没重复建` };
      }
      const task = store.createTask({
        title: title.slice(0, 120),
        notes: String(a.payload?.notes || a.result?.detail || '') + (key ? `\n[${key}]` : ''),
        due_at: a.target?.due_at || null,
        priority: Number.isFinite(Number(a.payload?.priority)) ? Number(a.payload.priority) : 2,
        status: 'todo',
        tags: a.payload?.tags ? String(a.payload.tags) : '',
        source: `processor:${mod.id}`,
      });
      log(`[processor] 建任务：${title}`);
      return { ok: true, detail: `任务已建（${task && task.id ? 'ok' : 'no-id'}）` };
    },
  };
}
