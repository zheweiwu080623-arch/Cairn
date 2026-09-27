// 「日报 / 晚报」模块的验证（纯渲染 + 接线）。
//
//   node tests/daily-brief-module.test.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAgentAdvice, renderCard } from '../modules/daily-brief/view.js';
import { scanModules, validateModule } from '../lib/modules.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('daily-brief-module.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BRIEF = {
  kind: 'morning', label: '早报', date: '2026-09-22', weekday: '周二', advice_source: 'rules',
  counts: { high: 1, normal: 2, low: 3 },
  text: 'Cairn · 早报 · 2026-09-22 周二 09:00\n【最值得先看的 1 条】\n  1. [重要 92] 实验报告明天截止\n【建议】\n  · 今晚先写引言。\n\n本摘要由本机 Cairn 生成；排序依据是「你的未来规划」。',
};

// ---------------- 1. 整张卡 ----------------
{
  const html = renderCard(BRIEF, { kind: 'morning' });
  ok('卡片标题在', html.includes('日报 / 晚报') && html.includes('最值得先看的几条'));
  ok('日期与来源在', html.includes('2026-09-22') && html.includes('周二') && html.includes('规则版建议'));
  ok('两个档位按钮都在', html.includes('id="db-morning"') && html.includes('id="db-evening"'));
  ok('当前那一档被高亮', /id="db-morning"[^>]*$|class="btn small primary" id="db-morning"/.test(html) || html.includes('class="btn small primary" id="db-morning"'));
  ok('还有刷新 / 推手机 / agent 三个按钮',
    html.includes('id="db-load"') && html.includes('id="db-push"') && html.includes('id="db-agent"'));
  ok('正文进了 pre', html.includes('id="db-body"') && html.includes('实验报告明天截止'));
  ok('分档计数显示出来', html.includes('重要 1') && html.includes('一般 2') && html.includes('低 3'));
  ok('说明排序与「重要信息」同一套', html.includes('同一套'));
}
{
  const evening = renderCard({ ...BRIEF, kind: 'evening' }, { kind: 'evening' });
  ok('切到晚报时晚报按钮高亮', evening.includes('class="btn small primary" id="db-evening"'));
  const agent = renderCard({ ...BRIEF, advice_source: 'agent' });
  ok('agent 版会标注来源', agent.includes('agent 版建议'));
}
{
  const html = renderCard({ text: '<script>alert(1)</script>' });
  ok('正文被转义（防注入）', html.includes('&lt;script&gt;') && !html.includes('<script>alert'));
  const empty = renderCard({});
  ok('空数据给出友好提示', empty.includes('还没有内容'));
  ok('空数据不出现 undefined', !empty.includes('undefined'));
}

// ---------------- 2. agent 建议替换进摘要 ----------------
{
  const got = applyAgentAdvice(BRIEF, '- 今晚先写实验报告的引言\n- 明早确认选课');
  ok('agent 建议替换了【建议】那一节',
    got.text.includes('今晚先写实验报告的引言') && got.text.includes('明早确认选课')
    && !got.text.includes('今晚先写引言。'), got.text);
  ok('保留了摘要的抬头与榜单', got.text.includes('Cairn · 早报') && got.text.includes('实验报告明天截止'));
  ok('保留了结尾那句话', got.text.includes('本摘要由本机'));
  ok('来源标记成 agent', got.advice_source === 'agent');
  ok('advice 数组也换掉了', got.advice.length === 2 && got.advice[0].id === 'agent');
  ok('去掉了模型可能带的行首符号', !got.text.includes('· -'));

  const noMark = applyAgentAdvice({ text: '没有建议标记的摘要' }, '- 一条建议');
  ok('没有【建议】标记也不崩', noMark.advice_source === 'agent' && noMark.text === '没有建议标记的摘要');
  ok('空文本原样返回', applyAgentAdvice(BRIEF, '') === BRIEF);
  ok('空 brief 不崩', applyAgentAdvice(null, 'x') === null);
}

// ---------------- 3. 真的调用 mount()（框架的调用方式） ----------------
function fakeEl() {
  const kids = new Map();
  return {
    innerHTML: '',
    querySelector: (s) => {
      if (!kids.has(s)) kids.set(s, { value: '', checked: false, onclick: null, disabled: false, textContent: '', innerHTML: '' });
      return kids.get(s);
    },
  };
}
{
  const el = fakeEl();
  const calls = [];
  const toasts = [];
  const api = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith('/api/digest/advice')) return { ok: true, text: '- agent 写的建议', advice_source: 'agent' };
    if (path.startsWith('/api/digest/push')) return { ok: true, sent: { title: '早报 · 9月22日', body: '1. x' } };
    return { brief: BRIEF, text: BRIEF.text };
  };
  await (await import('../modules/daily-brief/view.js')).mount(el, { api, toast: (m) => toasts.push(m), refresh: () => {} });

  ok('挂载时拉了默认的早报', calls.includes('GET /api/digest?kind=morning'), JSON.stringify(calls));
  ok('渲染进了容器', el.innerHTML.includes('日报 / 晚报') && el.innerHTML.includes('实验报告明天截止'));

  await el.querySelector('#db-evening').onclick();
  ok('点晚报会去拉晚报', calls.includes('GET /api/digest?kind=evening'));

  await el.querySelector('#db-push').onclick();
  ok('点"推到手机"会 POST 到 /api/digest/push', calls.some((c) => c === 'POST /api/digest/push'));
  ok('推送成功给出人话反馈', toasts.some((t) => /已推到手机/.test(t)));

  await el.querySelector('#db-agent').onclick();
  ok('点"让 agent 写建议"会 POST 到 /api/digest/advice', calls.some((c) => c === 'POST /api/digest/advice'));
  ok('agent 建议换进了卡片', el.innerHTML.includes('agent 版建议') && el.innerHTML.includes('agent 写的建议'));
}

// ---------------- 4. 接线：模块被发现 + 挂在「今日」 ----------------
{
  const mods = scanModules(join(ROOT, 'modules'));
  const mine = mods.find((m) => m.id === 'daily-brief');
  ok('模块能被发现且没有错误', !!mine && !mine.error, JSON.stringify(mine && mine.error));
  ok('挂在今日视图上', mine && mine.mount_into === 'today');
  ok('是 gadget 且有 view 入口', mine && mine.kind === 'gadget' && mine.entry.view === 'view.js');
  ok('声明了要读的数据（便于审阅）', mine && mine.data.reads.includes('digest'));
  ok('模块清单里的自己合法（validateModule 无错）',
    validateModule(JSON.parse(readFileSync(join(ROOT, 'modules', 'daily-brief', 'module.json'), 'utf8'))).errors.length === 0);
  ok('六个模块都在（含日报/晚报）', mods.filter((m) => !m.error).length >= 6, String(mods.length));

  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('今日页会挂载模块', /function renderToday\(\)[\s\S]{0,400}mountGadgets\('today'\)/.test(app));
  ok('挂载发生在重画之后（否则会被冲掉）',
    app.indexOf("mountGadgets('today')") > app.indexOf('el.innerHTML = todayHtml(todaySelectionFor(now), now)'));
}

console.log('');
console.log(failures === 0 ? 'daily-brief-module.test: PASS' : `daily-brief-module.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
