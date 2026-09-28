// function-settings.mjs —— 「每个功能自己的设置」（2026-09-27 新增）
//
// 起因（用户要求）：设置页里那一堆"某项功能专属"的选项，不该全挤进设置页 ——
// 谁的东西放在谁的页面上，从那一页右上角的「⚙ 功能设置」抽屉里改。
//
// 三条规矩：
//   1) **一个功能一套键**：值存在 `<数据目录>` 的 sync_state 里，键名 `fn_<功能 id>`
//      （对应需求里的 `fn.course_assist.*`）；没有值就用声明里的默认值，
//      所以"用户没配过"和"配了默认值"在界面上看起来一样。
//   2) **只认登记过的字段**：白名单外的键一律忽略（界面写错键名不会污染存储）。
//   3) **读坏不炸**：存的 JSON 坏了就退回默认，绝不让设置把功能弄挂。
//
// 谁在用：`lib/routes/function-settings.mjs`（HTTP 出口）、`lib/course-sync.mjs`（读命名模板）、
// 以及功能模块自己的 `settings(el, ctx)`（画抽屉里的内容）。
import {
  COLLEGE_CODE, DEFAULT_NAME_TEMPLATE, NAME_VARS, analyzeNameTemplate,
  buildCourseFileName, semesterWeek,
} from './naming.mjs';
import { store as realStore } from './store.mjs';

/** 一个功能的设置声明。字段类型（`type`）决定界面怎么画。 */
export const FUNCTION_SETTINGS = {
  course_assist: {
    id: 'course_assist',
    label: '课程辅助',
    title: '课程辅助 · 专属设置',
    note: '课件下载到哪、文件叫什么名字 —— 只影响课程辅助自己。',
    fields: [
      {
        key: 'name_template',
        type: 'template',
        label: '文件怎么命名',
        hint: '点下面的变量拼一个模板；扩展名（.pdf / .docx…）自动保留，不用写。',
        default: DEFAULT_NAME_TEMPLATE,
        vars: NAME_VARS,
      },
      {
        key: 'rename_scope',
        type: 'choice',
        label: '改名范围',
        default: 'future',
        options: [
          { value: 'future', label: '只影响以后（推荐）', note: '已经躺在文件夹里的材料不动' },
          { value: 'all', label: '顺便把已有材料也改名', note: '按新模板重命名现在文件夹里的材料（撞名的挪进「_重名或重复（可删）」）' },
        ],
      },
    ],
  },
  /**
   * 计划导出（2026-09-28）：以前导出**永远是** Markdown + JSON 两份，
   * 想导成日历（.ics）或表格（.csv）只能自己另想办法。现在勾选即可。
   *
   * "谁的东西放谁的页面上"这条没变 —— 这个功能没有自己的页面，
   * 它的设置在**设置 → 本机 → 计划导出**（和"导出到哪"本来就是同一件事）。
   */
  plan_export: {
    id: 'plan_export',
    label: '计划导出',
    title: '计划导出 · 导出格式',
    note: '勾上哪几种，导出时就写哪几种文件 —— 默认 Markdown + JSON（和以前一样）',
    fields: [
      {
        key: 'formats',
        type: 'checks',
        label: '导出哪些格式',
        default: 'md,json',
        options: [
          { value: 'md', label: 'Markdown', note: '给 Codex 和人看的正文（daily-plan.md）' },
          { value: 'json', label: 'JSON', note: '给程序读的完整结构（plan.json）' },
          { value: 'ics', label: 'ICS 日历', note: '导进手机 / 办公本日历（daily-plan.ics）' },
          { value: 'csv', label: 'CSV 表格', note: '一行一件事，导进 Excel / 飞书表格（daily-plan.csv）' },
        ],
      },
    ],
  },
};

/**
 * 「多选」（`type: 'checks'`）的值规整：只留声明过的项、去重、按声明顺序排；
 * 一个都不剩就回到默认 —— 免得用户把勾全去掉之后导出什么都不写（那更像故障，不像设置）。
 */
export function normalizeChecks(value, field) {
  const opts = (field && field.options) || [];
  const allowed = opts.map((o) => o.value);
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,，;；\s]+/);
  const picked = new Set(raw.map((s) => String(s || '').trim()).filter((s) => allowed.includes(s)));
  const out = allowed.filter((v) => picked.has(v));
  if (!out.length) {
    const fallback = String((field && field.default != null) ? field.default : '');
    const fb = new Set(fallback.split(/[,，;；\s]+/).map((s) => s.trim()).filter((s) => allowed.includes(s)));
    return allowed.filter((v) => fb.has(v)).join(',');
  }
  return out.join(',');
}

/** 一个功能的设置存在哪：`fn_<id>`（就是需求里说的 `fn.<id>.*`）。 */
export const fnSettingKey = (id) => `fn_${String(id || '')}`;

const specOf = (id) => FUNCTION_SETTINGS[String(id || '')] || null;

/** 默认值表（缺字段的声明也兜住：没有 default 就是空串）。 */
export function fnDefaults(id) {
  const spec = specOf(id);
  if (!spec) return {};
  const out = {};
  for (const f of spec.fields) out[f.key] = f.default === undefined ? '' : f.default;
  return out;
}

function readRaw(id, store) {
  try {
    const parsed = JSON.parse(store.getSync(fnSettingKey(id)) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

/**
 * 读一个功能的设置。
 * @returns {{ok:boolean, id:string, label:string, values:object, defaults:object, changed:boolean, fields:object[], error?:string}}
 */
export function getFunctionSettings(id, { store = realStore } = {}) {
  const spec = specOf(id);
  if (!spec) {
    return { ok: false, id: String(id || ''), label: '', values: {}, defaults: {}, changed: false, fields: [], error: `没有登记过这个功能：${id || '（空）'}` };
  }
  const defaults = fnDefaults(id);
  const raw = readRaw(id, store);
  const values = { ...defaults };
  let changed = false;
  for (const f of spec.fields) {
    const v = raw[f.key];
    if (v === undefined || v === null) continue;
    const text = String(v);
    if (f.type === 'choice') {
      const allowed = (f.options || []).map((o) => o.value);
      if (allowed.includes(text)) { values[f.key] = text; changed = changed || text !== defaults[f.key]; }
      continue;
    }
    if (f.type === 'checks') {
      // 多选：存的是逗号串（`md,json`），读的时候规整一遍 —— 老值里混进没声明的项也不会出事
      const norm = normalizeChecks(text, f);
      values[f.key] = norm;
      changed = changed || norm !== normalizeChecks(defaults[f.key], f);
      continue;
    }
    values[f.key] = text;
    changed = changed || text.trim() !== String(defaults[f.key]).trim();
  }
  return { ok: true, id: spec.id, label: spec.label, title: spec.title, note: spec.note, values, defaults, changed, fields: spec.fields };
}

/**
 * 改一个功能的设置（**只改传进来的字段**，其余保持不动）。
 * 传空串 = 回到默认值（不是"存一个空串"，否则界面上"恢复默认"和"存了空"分不清）。
 * @returns {{ok:boolean, error?:string} & ReturnType<typeof getFunctionSettings>}
 */
export function setFunctionSettings(id, patch = {}, { store = realStore } = {}) {
  const spec = specOf(id);
  if (!spec) return { ok: false, error: `没有登记过这个功能：${id || '（空）'}` };
  const defaults = fnDefaults(id);
  const raw = readRaw(id, store);
  const patchObj = patch && typeof patch === 'object' ? patch : {};
  for (const f of spec.fields) {
    if (!(f.key in patchObj)) continue;                       // 没传 = 不动
    const text = patchObj[f.key] === undefined || patchObj[f.key] === null ? '' : String(patchObj[f.key]);
    if (f.type === 'choice') {
      const allowed = (f.options || []).map((o) => o.value);
      if (!allowed.includes(text)) return { ok: false, error: `「${f.label}」只能是 ${allowed.join(' / ')}` };
      raw[f.key] = text;
      continue;
    }
    if (f.type === 'checks') {
      const allowed = (f.options || []).map((o) => o.value);
      const asked = text.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
      const unknown = asked.filter((s) => !allowed.includes(s));
      if (unknown.length) return { ok: false, error: `「${f.label}」不认识这几项：${unknown.join(' / ')}（只能是 ${allowed.join(' / ')}）` };
      const norm = normalizeChecks(text, f);
      if (!asked.length || norm === normalizeChecks(defaults[f.key], f)) delete raw[f.key];   // 空 / 回到默认 = 不存
      else raw[f.key] = norm;
      continue;
    }
    if (!text.trim() || text.trim() === String(defaults[f.key]).trim()) delete raw[f.key];
    else raw[f.key] = text.trim();
  }
  try {
    store.setSync(fnSettingKey(id), JSON.stringify({ ...raw, updated_at: Date.now() }));
  } catch (e) {
    return { ok: false, error: `存不进去：${(e && e.message) || e}` };
  }
  return getFunctionSettings(id, { store });
}

/** 所有已登记功能的设置（界面一次取全）。 */
export function listFunctionSettings({ store = realStore } = {}) {
  const functions = {};
  for (const id of Object.keys(FUNCTION_SETTINGS)) functions[id] = getFunctionSettings(id, { store });
  return { schema: 'fn-settings.v1', functions };
}

/** 课程辅助的命名模板（其它地方要"当前生效的模板"时走它，保证只读一处）。 */
export function courseNameTemplate({ store = realStore } = {}) {
  const v = getFunctionSettings('course_assist', { store }).values || {};
  return String(v.name_template || '').trim() || DEFAULT_NAME_TEMPLATE;
}

/**
 * 现在勾选的**导出格式**（设置 → 本机 → 计划导出）。
 * 没配过就是 `md,json` —— 和"以前永远导这两份"完全一致（老装机升级上来行为不变）。
 * 返回**数组**（`['md','json']`），调用方直接喂给 writePlanExport / 接口都行。
 */
export function planExportFormats({ store = realStore } = {}) {
  const v = getFunctionSettings('plan_export', { store }).values || {};
  return normalizeChecks(v.formats, FUNCTION_SETTINGS.plan_export.fields[0]).split(',').filter(Boolean);
}

/** 台账行 → 按某个模板算出来的新名字（下载落盘、改名计划、邮件附件名都走同一个函数）。 */
function nameWithTemplate(row, template) {
  const r = row || {};
  return buildCourseFileName({
    courseCode: r.course_code || r.course || '',
    filename: r.filename || r.local_name || '',
    week: semesterWeek(r.file_date || r.created_at),
    course: r.course || '',
    date: r.file_date || r.created_at,
    template,
  });
}

/**
 * 「文件怎么命名」的**实时预览**（纯计算，不写任何东西）。
 *
 * 为什么放在服务端算：模板语法只有一处实现（`lib/naming.mjs`），
 * 界面不能自己再写一遍 —— 两边一旦分叉，"预览说会变成 A、实际变成 B"是最坏的那种 bug。
 * 预览用的是**真实台账**里的材料名，所以看到的就是你自己那些文件。
 */
export function courseAssistNamePreview({ template = DEFAULT_NAME_TEMPLATE, store = realStore, limit = 3 } = {}) {
  const tpl = String(template == null ? '' : template);
  const effective = tpl.trim() || DEFAULT_NAME_TEMPLATE;
  const used = analyzeNameTemplate(effective);
  let rows = [];
  try { rows = store.listCourseFiles() || []; } catch { rows = []; }

  const samples = [];
  const seen = new Set();
  for (const r of rows) {
    const from = String(r.local_name || r.filename || '').trim();
    if (!from || seen.has(from)) continue;
    seen.add(from);
    const to = nameWithTemplate(r, effective);
    samples.push({ course: String(r.course || r.course_code || ''), from, to, changed: to !== from });
    if (samples.length >= limit) break;
  }
  // 台账是空的 / 恰好没有学院口径材料时，补一个样例：说明"没有周次时 Week 段会整段消失"
  if (!samples.some((s) => s.to.includes(COLLEGE_CODE))) {
    samples.push({
      course: '学院文件（样例）',
      from: 'Undergraduate Students 选课通知.pdf',
      to: buildCourseFileName({
        courseCode: COLLEGE_CODE, filename: 'Undergraduate Students 选课通知.pdf',
        week: 5, course: 'Undergraduate Students', date: '2026-09-15', template: effective,
      }),
      changed: true, sample: true,
    });
  }
  if (!samples.length) {
    samples.push({
      course: '样例',
      from: 'math186_all_lecture_slides.pdf',
      to: buildCourseFileName({
        courseCode: 'MATH1860J', filename: 'math186_all_lecture_slides.pdf',
        week: 3, course: '(2026-2027-1)-MATH1860J-01-高等数学B1', date: '2026-09-15', template: effective,
      }),
      changed: true, sample: true,
    });
  }

  // 台账整体：按这个模板有多少份会改名（给"顺手重命名已有文件"一个诚实的数字）
  let total = 0;
  let wouldRename = 0;
  for (const r of rows) {
    const from = String(r.local_name || r.filename || '').trim();
    if (!from) continue;
    total += 1;
    if (nameWithTemplate(r, effective) !== from) wouldRename += 1;
  }

  const warnings = [];
  if (!tpl.trim()) warnings.push(`模板是空的 → 会用默认的 ${DEFAULT_NAME_TEMPLATE}`);
  if (used.unknown.length) warnings.push(`这几个变量用不上、会被忽略：${used.unknown.map((k) => `{${k}}`).join('、')}`);
  if (tpl.trim() && !used.used.includes('原名')) {
    warnings.push('模板里没有 {原名}：不同的材料可能撞成同一个名字（撞名的那份会挪进「_重名或重复（可删）」）');
  }
  if (tpl.trim() && !used.used.includes('课程号') && !used.used.includes('课程名')) {
    warnings.push('模板里既没有 {课程号} 也没有 {课程名}：光看名字认不出是哪一门课（文件仍然各自放在课程文件夹里）');
  }
  return {
    ok: true,
    template: effective,
    is_default: effective === DEFAULT_NAME_TEMPLATE,
    vars: used.used,
    unknown: used.unknown,
    samples,
    counts: { ledger: total, would_rename: wouldRename },
    warnings,
  };
}
