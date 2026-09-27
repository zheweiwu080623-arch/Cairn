// 再处理功能：课程辅助（course-assist）
//
// 触发：手动（今日页的卡片）或定时（"每日 18:00 开工"那把调度器）。
// 本功能收到后做的事，按 `input.mode` 分：
//   index（D4，已实现）：把课程资料目录扫一遍、读成文字 → 生成 `material-index.md`
//   weekly / cram / practice（D5/D6）：每周巩固包 / 考前抱佛脚 / 练习反馈
//   不认识的 mode → **什么都不做**（返回空数组），不猜、不硬造产物。
//
// 三条硬规矩：
//   1) **只读课程材料**：只扫目录、只读文件，绝不改动/移动你的课件；
//   2) 产物写进 `<数据目录>/study/`（写文件是 action `file`，由服务端执行；
//      演练时只规划、连目录都不会建）；
//   3) 读不出来的材料（扫描件/图片/压缩包/视频）**如实写进索引**，不假装读过。

export async function run(input = {}, ctx = {}) {
  const course = ctx.course;
  if (!course || typeof course.scan !== 'function') {
    ctx.log?.('[course-assist] 没有可用的课程材料能力，跳过');
    return [];
  }

  const mode = String(input.mode || 'index');
  if (mode !== 'index' && mode !== 'weekly') {
    ctx.log?.(`[course-assist] 还不支持的 mode：${mode}`);
    return [];
  }

  const dir = course.dir();
  if (!dir) {
    return [{
      type: 'notify',
      summary: '课程辅助：还没设置课程资料目录',
      target: { kind: 'notification' },
      idempotency_key: 'course-assist:no-dir',
      permissions: ['notify:app'],
      payload: { text: '在「今日」页的「📚 课程辅助」卡片里选一个课程资料文件夹，之后就能生成资料索引了。' },
    }];
  }

  const only = String(input.course || '').trim();
  const scan = course.scan({});
  if (!scan.ok) {
    return [{
      type: 'notify',
      summary: `课程辅助：读不到课程资料目录`,
      target: { kind: 'notification' },
      idempotency_key: 'course-assist:scan-failed',
      permissions: ['notify:app'],
      payload: { text: String(scan.error || '') },
    }];
  }

  const materials = course.read({ courses: scan.courses, only });

  // 能力③：每周巩固包（只从材料里**摘**，摘不到就说摘不到，绝不编题）
  if (mode === 'weekly') {
    const week = Number(input.week) || (typeof course.currentWeek === 'function' ? course.currentWeek() : null);
    if (!week) {
      return [{
        type: 'notify',
        summary: '课程辅助：不知道现在是第几周',
        target: { kind: 'notification' },
        idempotency_key: 'course-assist:no-week',
        permissions: ['notify:app'],
        payload: { text: '先在「日程」里填上开学日期（校历），或者在生成时指定 week=N。' },
      }];
    }
    const built = typeof course.weekly === 'function'
      ? course.weekly({ course: only, week, materials, generatedAt: new Date().toISOString() })
      : { markdown: '', stats: {} };
    const path = course.outPath(`week-${week}-巩固.md`);
    return [{
      type: 'file',
      summary: `第 ${week} 周巩固包（读了 ${built.stats.readable || 0}/${built.stats.materials || 0} 份材料）`,
      target: { kind: 'file', path },
      idempotency_key: `course-assist:weekly:${only || 'all'}:${week}`,
      permissions: ['fs:write:data'],
      payload: { path, text: built.markdown, stats: built.stats },
    }];
  }

  const built = course.index({
    root: dir, materials, courseFilter: only, generatedAt: new Date().toISOString(),
    courseNames: scan.courses.map((c) => c.name),
  });
  const path = course.outPath('material-index.md');
  const label = only || `${scan.courses.length} 门课`;

  return [{
    type: 'file',
    summary: `课程资料索引（${label}·${materials.length} 份材料）`,
    target: { kind: 'file', path },
    idempotency_key: `course-assist:index:${only || 'all'}:${built.stats.files}`,
    permissions: ['fs:write:data'],
    payload: { path, text: built.markdown, stats: built.stats },
  }];
}
