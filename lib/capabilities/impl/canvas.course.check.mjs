// 能力模块：canvas.course.check —— 只读查一门课的新材料。
// 一个能力 = 一个文件：meta（身份证）+ bind（装到哪 / 谁来干）+ run（干什么）。

export const meta = {
  id: 'canvas.course.check',
  name: '查一门课的新材料',
  version: '1.0.0',
  kind: 'read',
  input: { type: 'object', properties: { courseCode: { type: 'string' }, sinceMs: { type: ['number', 'null'] } }, required: ['courseCode'] },
  output: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
  permissions: ['net:canvas'],
  idempotent: true,
  cost: 'none',
  ui: { label: '查课前新料', group: '课程', icon: '🔎' },
  model: { description: '当用户问"某门课有没有新作业 / 新公告 / 新文件"时用它。只读课程平台，不会下载也不会提交。' },
  used_by: ['preclass-check'],
  notes: '只读：只对 Canvas 发 GET（文件/页面/公告/作业/小测），不下载、不提交、不改配置。查不到就静默。',
};

/** 装进 ctx 的 `canvas.checkCourse`（提供者是 preclass stack）。 */
export const bind = { from: 'preclass', ctx: ['canvas.checkCourse'] };

export async function run(input, ctx) {
  return ctx.canvas.checkCourse(input);
}
