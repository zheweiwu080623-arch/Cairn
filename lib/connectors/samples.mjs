// Local sample data so the import pipeline is verifiable without network/credentials.
// Shapes mirror what each provider API returns, then gets normalized.

export const feishuSample = {
  calendars: [
    { calendar_id: 'cal_work', summary: '工作日历' },
    { calendar_id: 'cal_personal', summary: '私人日历' },
  ],
  events: {
    cal_work: [
      {
        event_id: 'fe_ev_1', summary: '产品评审会',
        start_time: { timestamp: Math.floor((Date.now() + 2 * 86400000) / 1000), timezone: 'Asia/Shanghai' },
        end_time: { timestamp: Math.floor((Date.now() + 2 * 86400000 + 3600000) / 1000), timezone: 'Asia/Shanghai' },
        description: '评审 Q3 路线图',
        url: 'https://example.feishu.cn/meeting/fe_ev_1',
      },
      {
        event_id: 'fe_ev_2', summary: '与设计团队对齐',
        start_time: { timestamp: Math.floor((Date.now() + 3 * 86400000) / 1000), timezone: 'Asia/Shanghai' },
        end_time: { timestamp: Math.floor((Date.now() + 3 * 86400000 + 1800000) / 1000), timezone: 'Asia/Shanghai' },
        description: '确认视觉稿方向',
        url: 'https://example.feishu.cn/meeting/fe_ev_2',
      },
    ],
    cal_personal: [
      {
        event_id: 'fe_ev_3', summary: '健身课',
        start_time: { timestamp: Math.floor((Date.now() + 1 * 86400000) / 1000), timezone: 'Asia/Shanghai' },
        end_time: { timestamp: Math.floor((Date.now() + 1 * 86400000 + 3600000) / 1000), timezone: 'Asia/Shanghai' },
        description: '',
        url: 'https://example.feishu.cn/meeting/fe_ev_3',
      },
    ],
  },
};

export const canvasSample = {
  courses: [
    { id: 101, name: '计算机视觉', enrollment_state: 'active' },
    { id: 202, name: '机器学习导论', enrollment_state: 'active' },
  ],
  assignments: {
    101: [
      { id: 1011, name: '作业1：图像分类实验', due_at: new Date(Date.now() + 5 * 86400000).toISOString(), html_url: 'https://canvas.example.edu/courses/101/assignments/1011', points_possible: 100 },
      { id: 1012, name: '项目提案', due_at: new Date(Date.now() + 12 * 86400000).toISOString(), html_url: 'https://canvas.example.edu/courses/101/assignments/1012', points_possible: 50 },
    ],
    202: [
      { id: 2021, name: 'Quiz 1：线性代数', due_at: new Date(Date.now() + 2 * 86400000).toISOString(), html_url: 'https://canvas.example.edu/courses/202/assignments/2021', points_possible: 20 },
    ],
  },
  events: [
    { id: 3001, title: '期中考试：计算机视觉', start_at: new Date(Date.now() + 8 * 86400000).toISOString(), end_at: new Date(Date.now() + 8 * 86400000 + 2 * 3600000).toISOString(), html_url: 'https://canvas.example.edu/calendar' },
  ],
};

export const emailSample = {
  messages: [
    { uid: 1, subject: '明天会议议程和材料', from: '项目经理 <pm@example.com>', date: new Date(Date.now() + 1 * 86400000).toUTCString(), body: '请准备明天的会议材料' },
    { uid: 2, subject: '课程助教排班确认', from: '课程组 <staff@example.edu>', date: new Date(Date.now() + 3 * 86400000).toUTCString(), body: '请查收助教排班表' },
    { uid: 3, subject: '报销单需要补充材料', from: '财务 <finance@example.com>', date: new Date(Date.now()).toUTCString(), body: '请于周五前补充发票' },
  ],
};
/**
 * 通用 RSS 连接器的离线示例（一段真的 RSS XML）。
 * 时间用「相对现在」，保证无论哪天跑，示例都能落在"最近 N 天"里。
 */
export function rssSample() {
  const day = (n) => new Date(Date.now() - n * 86400000).toUTCString();
  const item = (i, title, days, desc) => `
  <item>
    <title>${title}</title>
    <link>https://example.edu/feed/${i}</link>
    <guid>sample-${i}</guid>
    <pubDate>${day(days)}</pubDate>
    <description><![CDATA[<p>${desc}</p>]]></description>
  </item>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>示例 · 学院公告</title>
  <link>https://example.edu/feed</link>
  <description>这是离线示例数据，用来在没有网络时验证 RSS 连接器。</description>
${item(1, '关于秋季学期选课系统维护的通知', 1, '系统将于本周日 02:00–06:00 维护，期间无法选课。')}
${item(2, '讲座：从零开始的科研方法', 2, '周四 19:00 图书馆报告厅，欢迎参加。')}
${item(3, '图书馆延长开放时间', 5, '考试周期间自习区开放到 23:00。')}
</channel></rss>`;
}
/**
 * 通用 ICS 连接器的离线示例：三门课 + 一个全天校历，时间都相对"现在"，
 * 保证任何一天跑示例都能落在导入窗口里。
 */
export function icsSample() {
  const ts = (daysFromNow, h, m) => {
    const d = new Date(Date.now() + daysFromNow * 86400000);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      + `T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
  };
  const day = (daysFromNow) => {
    const d = new Date(Date.now() + daysFromNow * 86400000);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  const ev = (uid, title, start, end, extra = '') => [
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`,
    `DTSTART${start.length === 8 ? ';VALUE=DATE' : ''}:${start}`,
    `DTEND${end.length === 8 ? ';VALUE=DATE' : ''}:${end}`,
    extra, 'END:VEVENT',
  ].filter(Boolean).join('\r\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cairn//Sample//CN', 'X-WR-CALNAME:示例课表（离线演示）',
    ev('demo-1', '高等数学（示例）', ts(1, 8, 0), ts(1, 9, 40), 'LOCATION:东中院 201'),
    ev('demo-2', '程序设计（示例）', ts(2, 14, 0), ts(2, 15, 40), 'LOCATION:线上'),
    ev('demo-3', '小组讨论（示例）', ts(5, 19, 0), ts(5, 20, 30)),
    ev('demo-4', '校历：假期（示例）', day(10), day(12)),
    'END:VCALENDAR',
  ].join('\r\n');
}
/** 通用 JSON 接口连接器的离线示例。 */
export function jsonSample() {
  const soon = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  return JSON.stringify({
    code: 0,
    data: {
      list: [
        { id: 'demo-json-1', name: '（示例）提交实验报告', deadline: soon(2), link: 'https://example.edu/t/1', description: '实验三的报告，附源码压缩包' },
        { id: 'demo-json-2', name: '（示例）预习第 5 章', deadline: soon(4), link: 'https://example.edu/t/2' },
        { id: 'demo-json-3', name: '（示例）小组讨论准备', deadline: soon(6), link: 'https://example.edu/t/3', description: '每人准备一页提纲' },
      ],
    },
  });
}
