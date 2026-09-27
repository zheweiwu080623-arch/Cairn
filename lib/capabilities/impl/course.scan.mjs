// 能力模块：course.scan —— 扫课程资料目录（认课程与周次）。

export const meta = {
  id: 'course.scan',
  name: '扫课程资料目录（认课程与周次）',
  version: '1.0.0',
  kind: 'read',
  input: { type: 'object', properties: { root: { type: 'string' }, maxFiles: { type: 'number' } } },
  output: {
    type: 'object',
    properties: { courses: { type: 'array' }, files: { type: 'array' }, week: { type: ['number', 'null'] } },
    required: ['courses', 'files'],
  },
  permissions: ['fs:read:course'],
  idempotent: true,
  cost: 'none',
  ui: { label: '扫课件目录', group: '课程', icon: '📂' },
  used_by: ['course-assist'],
  notes: '只读磁盘。顶层文件夹经常是空的、材料都在子文件夹里，所以是逐层扫；扫不动时返回 ok:false 而不是抛。',
};

export const bind = { from: 'course', ctx: ['course.scan', 'course.currentWeek'] };

export async function run(input = {}, ctx) {
  return ctx.course.scan(input);
}
