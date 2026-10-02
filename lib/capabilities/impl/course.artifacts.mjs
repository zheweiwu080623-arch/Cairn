// 能力模块：course.artifacts —— 生成并写出课程产物（资料索引 / 每周巩固包）。
export const meta = {
  id: 'course.artifacts',
  name: '生成并写出课程产物（资料索引 / 每周巩固包）',
  version: '1.0.0',
  kind: 'write',
  input: { type: 'object', properties: { materials: { type: 'array' }, course: { type: 'string' }, week: { type: ['number', 'null'] }, mode: { type: 'string' } }, required: ['materials'] },
  output: { type: 'object', properties: { markdown: { type: 'string' }, stats: { type: 'object' }, path: { type: 'string' } }, required: ['markdown', 'path'] },
  permissions: ['fs:write:data'],
  idempotent: true,
  cost: 'none',
  ui: { label: '出索引 / 巩固包', group: '课程', icon: '🧾' },
  model: { description: '当用户要"课程资料索引""这周的巩固包"这类课程产物时用它。它会写文件，所以调用只会先给你方案。' },
  used_by: ['course-assist'],
  notes: '产物只能写进 <数据目录>/study/，越界一律拒绝（闸门 writeStudyFile / insideStudy）。同名重写结果一致 ⇒ 可重放。',
};
export const bind = { from: 'course', ctx: ['course.index', 'course.weekly', 'course.outPath', 'course.studyDir', 'course.dir'] };
export async function run(input = {}, ctx) {
  return input.mode === 'weekly' ? ctx.course.weekly(input) : ctx.course.index(input);
}
