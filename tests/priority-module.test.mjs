// 「重要信息」模块的验证（纯渲染 + 接线）。
//
//   node tests/priority-module.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderAdvice, renderAutopush, renderCard, renderGoals, renderItem, whenLabel } from '../modules/priority-feed/view.js';
import { scanModules } from '../lib/modules.mjs';

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

console.log('priority-module.test.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- 1. 时间文案 ----------------
ok('今天 / 明天 / N 天后 / 已过期 / 无时间',
  whenLabel({ daysLeft: 0 }) === '今天'
  && whenLabel({ daysLeft: 1 }) === '明天'
  && whenLabel({ daysLeft: 5 }) === '5 天后'
  && whenLabel({ daysLeft: -1 }) === '已过期'
  && whenLabel({ daysLeft: null }) === '无时间', whenLabel({ daysLeft: 5 }));

// ---------------- 2. 单条渲染 ----------------
{
  const html = renderItem({ band: 'high', importance: 88, title: '实验报告明天截止', source: 'canvas', daysLeft: 1, why: '明天内到期（+35）' });
  ok('重要条目有档位与分数', html.includes('重要 88'));
  ok('标题被转义（防注入）', !renderItem({ band: 'low', importance: 10, title: '<img src=x onerror=1>' }).includes('<img'));
  ok('时间与来源都显示', html.includes('明天') && html.includes('canvas'));
  ok('理由显示出来（可解释）', html.includes('明天内到期'));
}

// ---------------- 3. 建议渲染 ----------------
{
  const html = renderAdvice([{ id: 'urgent', level: 'high', text: '先做实验报告' }], { source: 'rules' });
  ok('建议带等级徽章', html.includes('要紧') && html.includes('先做实验报告'));
  ok('规则版会说明"不联网"', html.includes('规则版建议'));
  const agent = renderAdvice([{ id: 'agent', level: 'info', text: 'x' }], { source: 'agent' });
  ok('agent 版会说明来源', agent.includes('agent'));
  ok('没有建议时不渲染区块', renderAdvice([]) === '');
}

// ---------------- 4. 规划编辑区 ----------------
{
  const html = renderGoals(['11 月要考托福', 'GPA 上 3.8']);
  ok('两行规划回填进文本框', html.includes('11 月要考托福') && html.includes('GPA 上 3.8'));
  ok('文本框按条数变高（2~6 行）', /rows="3"/.test(html));
  ok('有保存与 agent 按钮', html.includes('id="pf-save"') && html.includes('id="pf-agent"'));
  ok('规划里的尖括号被转义', !renderGoals(['<script>']).includes('<script>'));
  ok('空规划也不炸', renderGoals([]).includes('rows="2"'));
}

// ---------------- 4b. 自动推送开关（默认关） ----------------
{
  const off = renderAutopush({
    cfg: { enabled: false, notify: true, bark: false, threshold: 70, max_per_run: 3 },
    describe: '自动推送：关闭（打开后，重要信息会自己进通知 / 推手机）', preview: [],
  });
  ok('三个勾选框 + 阈值 + 每次上限都在',
    ['pf-ap-enabled', 'pf-ap-notify', 'pf-ap-bark', 'pf-ap-threshold', 'pf-ap-max'].every((id) => off.includes(`id="${id}"`)));
  ok('默认是没勾上的', /id="pf-ap-enabled"[^>]*\/>/.test(off) && !/id="pf-ap-enabled" checked/.test(off));
  ok('有保存与"现在跑一次"两个按钮', off.includes('id="pf-ap-save"') && off.includes('id="pf-ap-run"'));
  ok('说明文字用服务端给的那句', off.includes('自动推送：关闭'));
  ok('没有候选时说实话（不硬凑）', off.includes('暂时没有需要自动推送的条目'));
  ok('老数据（没传 autopush）也渲染成默认关', renderAutopush().includes('id="pf-ap-enabled"'));

  const on = renderAutopush({
    cfg: { enabled: true, notify: true, bark: true, threshold: 80, max_per_run: 5 },
    describe: '自动推送：开启 · ≥80 分 · 进通知 + 推手机',
    preview: [{ title: '实验报告明天截止' }],
    last: { dry: false, at: '2026-09-22T13:00:00.000Z', notified: 1, pushed: 1 },
  });
  ok('开启状态会回填成勾上', /id="pf-ap-enabled" checked/.test(on));
  ok('阈值与上限回填', on.includes('value="80"') && on.includes('value="5"'));
  ok('预览列出"下一次会推谁"', on.includes('实验报告明天截止'));
  ok('上次推送结果显示成人话', on.includes('进通知 1 条 / 推手机 1 条'));
  ok('预览里的标题会被转义（防注入）', !renderAutopush({ preview: [{ title: '<img src=x>' }] }).includes('<img'));
}

// ---------------- 5. 整张卡 ----------------
{
  const payload = {
    context: {
      goals: ['11 月要考托福'],
      upcoming: [{ id: 'u1', title: '期中考试', daysLeft: 3, kind: 'exam' }],
      crowdedDays: [],
    },
    counts: { high: 2, normal: 1, low: 0 },
    ranked: [
      { id: 'p:1', band: 'high', importance: 92, title: '实验报告明天截止', source: 'canvas', daysLeft: 1, why: '明天内到期' },
      { id: 'p:2', band: 'normal', importance: 50, title: '讲座通知', source: 'rss', daysLeft: null, why: '命中关注点' },
    ],
    advice: [{ id: 'urgent', level: 'high', text: '今晚先写实验报告的引言' }],
    advice_source: 'rules',
  };
  const html = renderCard(payload);
  ok('卡片标题在', html.includes('重要信息') && html.includes('按你的未来规划排序'));
  ok('汇总数字在', html.includes('2 条重要') && html.includes('1 条一般'));
  ok('说明参考了什么', html.includes('参考 1 条规划') && html.includes('1 项未来安排'));
  ok('建议被渲染', html.includes('今晚先写实验报告的引言'));
  ok('两条信息都渲染', html.includes('实验报告明天截止') && html.includes('讲座通知'));
  ok('排序靠前的先出现', html.indexOf('实验报告明天截止') < html.indexOf('讲座通知'));
  ok('有规划编辑区', html.includes('id="pf-goals"'));
  ok('卡片里有自动推送开关', html.includes('id="pf-ap-enabled"') && html.includes('id="pf-ap-run"'));
}
{
  const empty = renderCard({});
  ok('空数据给出友好提示', empty.includes('暂时没有需要排优先级的信息'));
  ok('没有任何依据时提示先写规划', empty.includes('先在上面写下你的规划'));
  ok('空数据不报错也不出现 undefined', !empty.includes('undefined'));
}
{
  const many = renderCard({ ranked: Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, band: 'low', importance: 10, title: `第${i}条`, source: 'rss', why: '' })) });
  ok('最多只显示 10 条（不刷屏）', (many.match(/class="list-item"/g) || []).length === 10);
}

// ---------------- 6. 接线：模块被系统发现 + 挂到「今日」 ----------------
{
  const mods = scanModules(join(ROOT, 'modules'));
  const mine = mods.find((m) => m.id === 'priority-feed');
  ok('模块能被发现且没有错误', !!mine && !mine.error, JSON.stringify(mine && mine.error));
  ok('挂在今日视图上', mine.mount_into === 'today');
  ok('是 gadget 且有 view 入口', mine.kind === 'gadget' && mine.entry.view === 'view.js');
  ok('声明了要读的数据（便于审阅）', mine.data.reads.includes('priority'));
  ok('五个模块都在', mods.filter((m) => !m.error).length >= 5, String(mods.length));

  const app = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');
  ok('今日页会挂载模块', /function renderToday\(\)[\s\S]{0,400}mountGadgets\('today'\)/.test(app));
  ok('挂载发生在重画之后（否则会被冲掉）',
    app.indexOf("mountGadgets('today')") > app.indexOf('el.innerHTML = todayHtml(todaySelectionFor(now), now)'));

  const server = readFileSync(join(ROOT, 'server.mjs'), 'utf8');
  ok('服务端接了 /api/priority', server.includes("p === '/api/priority'") && server.includes('priorityRoutes.handlePriority'));
  ok('服务端接了 /api/plan/goals 与 /api/priority/advice',
    server.includes("'/api/plan/goals'") && server.includes("'/api/priority/advice'"));
  ok('新路由与 R2 的结构一致（独立文件 + 接线）',
    server.includes("from './lib/routes/priority.mjs'") && server.includes('createPriorityRoutes({'));
}

console.log('');
console.log(failures === 0 ? 'priority-module.test: PASS' : `priority-module.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
