// 闸门：课表 / 校历都能**用表单**增改，不用手写 JSON（2026-09-27）
//
//   node tests/schedule-form.test.mjs
//
// 用户原话：「日程部分让填入 json 格式不是特别人性化，有什么解决办法吗」。
// 查证：课表当时**有**表单（＋ 新建课程 / 编辑），但校历**只有 JSON** ——
// 加进去以后还只能删、不能改（后端其实早就支持 POST /api/academic 与 PATCH /api/academic/:id）。
// 这个文件把修法钉住：校历上表单、JSON 收进「高级」折叠、以及顺手修掉的两个小坑。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public', 'styles.css'), 'utf8');
let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
};

console.log('schedule-form.test.mjs');

// ---------------- ① 校历有表单了 ----------------
{
  ok('弹窗认 academic 这个类型', app.includes("academic: '校历事项'") && app.includes("if (type === 'academic')"));
  ok('表单字段是人话（标题 / 类型 / 开始 / 结束 / 备注 / 颜色）',
    app.includes('id="f-kind"') && app.includes('结束日期（单天可留空）') && /kinds\.map/.test(app));
  ok('类型选项覆盖学期/假期/考试/补课/其他（数据里真实存在这几种）',
    ['term', 'holiday', 'exam', 'makeup', 'general'].every((k) => app.includes(`['${k}',`)));
  ok('保存走 /api/academic（新建 POST、编辑 PATCH 由 id 决定）',
    app.includes("path = '/api/academic';") && app.includes('const method = id ? \'PATCH\' : \'POST\';'));
  ok('只填开始日期也能存（结束日期可为空 = 单天）', app.includes("end_at: $('#f-end').value || null"));
  ok('类型在表格里显示成人话，不再直接印 term/holiday',
    app.includes('ACADEMIC_KIND_LABEL[a.kind]') && app.includes("const ACADEMIC_KIND_LABEL = { term: '学期'"));
}

// ---------------- ② 管理窗口：两个页签都能新建 + 编辑；JSON 退到"高级" ----------------
{
  ok('两个页签都有「＋ 新建」按钮（以前只有课表有）',
    app.includes("id=\"mgr-new\">＋ 新建${isCourse ? '课程' : '校历事项'}"));
  ok('校历行也有「编辑」（以前只有「删」）',
    app.includes('data-edit-academic=') && app.includes("openModal('academic', a)"));
  ok('JSON 粘贴收进 <details>「高级：批量导入」里，默认收起',
    app.includes('<details class="mgr-import">') && app.includes('高级：批量导入 / 导出模板')
    && css.includes('.mgr-import > summary'));
}

// ---------------- ②b 一行式输入 + 文件导入（2026-09-27 第二轮） ----------------
{
  ok('管理窗口有一行式输入（回车即添加）',
    app.includes('id="mgr-quick"') && app.includes('id="mgr-quick-add"')
    && app.includes("if (e.key === 'Enter') { e.preventDefault(); quickAdd(); }"));
  ok('一行式按当前页签解析（课表 / 校历两套语法）',
    app.includes("kind: isCourse ? 'course' : 'academic'") && app.includes('window.ScheduleInput'));
  ok('支持从 .ics / .csv 导入，并且**先给预览再确认**（不偷偷写库）',
    app.includes('id="mgr-file-input"') && app.includes('accept=".ics,.csv,.txt"')
    && app.includes('id="mgr-file-ok"') && app.includes('确认导入'));
  ok('导 .ics 时会说明"按校历导入"并切到校历页签（不硬塞进课表）',
    app.includes('日历文件按「校历」导入，已切到校历页签'));
  ok('解析器单独一个文件（纯函数，便于单测）',
    (() => {
      try { return readFileSync(join(ROOT, 'public', 'schedule-input.js'), 'utf8').includes('parseQuickLine'); }
      catch { return false; }
    })());
  ok('index.html 在 app.js **之前**加载解析器',
    (() => {
      const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
      return html.indexOf('schedule-input.js') > 0 && html.indexOf('schedule-input.js') < html.indexOf('app.js');
    })());
}

// ---------------- ③ 顺手修掉的两个坑（都实测撞出来的） ----------------
{
  ok('新建时不再显示成「编辑」、也不再冒出删不掉的「🗑 删除」按钮（看有没有 id，而不是有没有传对象）',
    app.includes('const isNew = !(item && item.id);') && app.includes("`${isNew ? '新建' : '编辑'}${titles[type] || ''}`"));
  ok('保存后**等数据回来再重画**列表（不然刚存的那条不出现 —— 课表/校历都中过）',
    /api\(method, url, body\)\.then\(async \(\) => \{[\s\S]{0,200}await refresh\(\);[\s\S]{0,120}renderMgrTab\(mgrTab\)/.test(app));
  ok('预填"今天"用本地日期（用 toISOString 会显示成昨天）',
    app.includes('localDT(new Date()).slice(0, 10)') && !app.includes("new Date().toISOString().slice(0, 10)"));
}

// ---------------- ④ 发布前巡检撞出来的两处（2026-09-27 晚） ----------------
// 都是**界面级**测试才撞得出来的：接口测试全绿，但点按钮会出事 / 会说谎。
{
  ok('管理窗口里的「删」先二次确认（删了没有回收站）',
    /\[data-del\]', box\)\.forEach\(\(b\) => b\.onclick = async \(\) => \{[\s\S]{0,320}window\.confirm\(`确认删除这条\$\{label\}？/.test(app));
  ok('「清空」不再谎报「已清空校历」：只清输入框，且不碰已保存数据',
    app.includes("$('#mgr-paste').value = '';")
    && app.includes("已清空输入框（不影响已保存的")
    && !app.includes('toast(`已清空${label}`)'));
  ok('「清空」按钮的文案跟行为一致（不再是一个危险的裸「清空」）',
    app.includes('id="mgr-clear">清空输入框</button>'));
}

console.log('');
console.log(failures === 0 ? 'schedule-form.test: PASS' : `schedule-form.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
