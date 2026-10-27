// Public learning-hub view. Read-only: no storage, filesystem, network, or notifications.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

export const NOW = {
  date: 'Template',
  line: 'A neutral starting point for project-driven learning.',
  note: 'Replace this template in a private local customisation.',
};

export const LAYERS = [
  { n: 1, name: 'Foundations', why: 'Build durable programming and analysis skills.', is: 'Data structures · algorithms · complexity · testing · debugging', enough: 'Can choose and explain an approach, then verify it.' },
  { n: 2, name: 'Systems', why: 'Understand runtime, failure, and recovery.', is: 'Processes · threads · networking · concurrency · retries · idempotency', enough: 'Can trace a failure path and justify recovery behavior.' },
  { n: 3, name: 'Architecture', why: 'Keep boundaries explicit as systems grow.', is: 'Interfaces · modules · contracts · adapters · observability', enough: 'Can explain why a boundary exists and what it isolates.' },
  { n: 4, name: 'Machine Learning', why: 'Connect models to assumptions and evidence.', is: 'Mathematics · training · evaluation · uncertainty', enough: 'Can explain a metric, its assumptions, and its failure modes.' },
  { n: 5, name: 'Agents', why: 'Move from demos to testable behavior.', is: 'Planning · tools · memory · evaluation · reliability', enough: 'Can turn a problem into a reproducible hypothesis and experiment.' },
  { n: 6, name: 'Security', why: 'Treat every capability as a trust decision.', is: 'Least privilege · sandboxing · threat modeling · audit', enough: 'Can identify trust boundaries and the control at each boundary.' },
  { n: 7, name: 'Research Method', why: 'Make results understandable to other people.', is: 'Question · baseline · experiment · ablation · analysis · writing', enough: 'Can produce a repeatable experiment and honest report.' },
];

export const STATUS = {
  ok: { label: 'Ready', cls: 'lh-ok' },
  proj: { label: 'Used in projects', cls: 'lh-proj' },
  none: { label: 'Not started', cls: 'lh-none' },
  later: { label: 'Deferred', cls: 'lh-later' },
};

export const DIAGNOSIS = [
  { topic: 'Programming foundations', status: 'proj', note: 'Assess through explanation, tests, and debugging.' },
  { topic: 'Algorithms', status: 'none', note: 'Use problem solving, not a memorised list.' },
  { topic: 'Systems', status: 'proj', note: 'Trace real failure and recovery paths.' },
  { topic: 'Architecture', status: 'proj', note: 'Review interfaces, ownership, and change cost.' },
  { topic: 'Mathematics', status: 'none', note: 'Connect each topic to a concrete model or experiment.' },
  { topic: 'Machine learning', status: 'none', note: 'Prioritise evaluation and assumptions.' },
  { topic: 'Agents', status: 'proj', note: 'Measure behavior rather than feature count.' },
  { topic: 'Security', status: 'proj', note: 'Write down the threat model and trust boundary.' },
  { topic: 'Research method', status: 'none', note: 'Practise the full question-to-report loop.' },
];

export const NOT_NEEDED = [
  'Topics with no connection to the current project or research question',
  'Large reading lists without a prerequisite path',
  'Optimisation work before a measured bottleneck exists',
];

export const PHASES = [
  {
    tag: 'Phase 0', when: 'Foundation', title: 'Build the prerequisites',
    learn: 'Programming · data structures · testing · debugging',
    why: 'Later work becomes guesswork without a reliable foundation.',
    enough: 'Can solve unfamiliar problems and explain the trade-offs.',
    map: 'Use one small project and one test suite.',
    impact: 'Makes independent engineering possible.',
    next: 'Move to systems once the basics are observable.',
  },
  {
    tag: 'Phase 1', when: 'Systems', title: 'Study reliability in context',
    learn: 'Networking · concurrency · failure · retries · idempotency',
    why: 'Reliability is learned by tracing real boundaries.',
    enough: 'Can draw success and failure paths and explain each state.',
    map: 'Instrument one existing workflow without changing its owner.',
    impact: 'Builds a concrete systems vocabulary.',
    next: 'Use the evidence to frame a measurable research question.',
  },
  {
    tag: 'Phase 2', when: 'Research', title: 'Run a small experiment',
    learn: 'Question · baseline · dataset · metric · ablation · analysis',
    why: 'A reproducible comparison is more useful than an opinion.',
    enough: 'Produces a report with a repeatable method and honest limits.',
    map: 'Keep raw data and code outside the public repository.',
    impact: 'Turns implementation experience into research evidence.',
    next: 'Iterate only after reviewing the result and threats to validity.',
  },
];

export const THREAD = {
  tag: 'Parallel', when: 'Ongoing', title: 'Sustainable practice',
  learn: 'Writing · communication · exercise · rest · deliberate review',
  why: 'A plan that cannot be sustained is not a successful plan.',
  enough: 'Maintain one small, repeatable check-in.',
  map: 'Use a habit tracker or calendar owned by the user.',
  impact: 'Protects attention and long-term consistency.',
  next: 'Adjust the cadence before adding new commitments.',
};

export const RESOURCES = [
  { topic: 'Foundations', main: 'Official language and framework documentation', aux: 'One structured course', papers: ['Use primary sources and verify links before sharing'] },
  { topic: 'Systems', main: 'A current operating-systems or distributed-systems course', aux: 'System documentation', papers: ['Choose papers relevant to the active project'] },
  { topic: 'Research', main: 'A research-methods guide', aux: 'A recent related paper', papers: ['Read the method and evaluation sections first'] },
];

export const PROJECT_MAP = [
  { know: 'Interfaces', proj: 'Define a small contract and test both sides.' },
  { know: 'Reliability', proj: 'Trace retries, duplicates, and recovery without guessing.' },
  { know: 'Security', proj: 'List assets, actors, trust boundaries, and controls.' },
  { know: 'Research', proj: 'Turn one engineering question into a measurable experiment.' },
];

export const WEEKLY = {
  must: ['One focused learning block', 'One project check-in with evidence'],
  should: ['Read one source closely', 'Write a short reflection or experiment note'],
  later: ['Topics without a current prerequisite or project link'],
};

export const LOOP = ['Build', 'Observe', 'Explain', 'Study', 'Test', 'Record', 'Review'];

export const PROMPTS = [
  {
    id: 'tutor',
    title: 'Learning tutor',
    use: 'Diagnose first, then teach and test.',
    text: 'You are a patient technical tutor. Ask what I already understand, identify the smallest missing prerequisite, give one concrete example, and then test transfer to a new problem. Do not invent sources.',
  },
  {
    id: 'examiner',
    title: 'Capability examiner',
    use: 'Test understanding rather than recall.',
    text: 'Create a short assessment with concept explanation, comparison, debugging, system analysis, and an unfamiliar transfer problem. State which prerequisite is missing when an answer fails.',
  },
  {
    id: 'map',
    title: 'Literature map',
    use: 'Build a bounded reading path.',
    text: 'Build a dependency-aware map for this topic. Distinguish primary sources from tutorials, identify prerequisites, and mark anything you cannot verify. Do not fabricate papers, courses, links, or claims.',
  },
];

export const NON_TECH = [
  { name: 'Writing', now: 'Template', goal: 'Explain one idea clearly', closed: 'Publish a short, reviewed note' },
  { name: 'Rest', now: 'Template', goal: 'Protect recovery time', closed: 'Keep one undisturbed recovery block' },
];

const TABS = [
  { id: 'tree', ico: '🌳', name: 'Knowledge tree' },
  { id: 'diag', ico: '📊', name: 'Assessment' },
  { id: 'route', ico: '🛤️', name: 'Route' },
  { id: 'res', ico: '📚', name: 'Resources' },
  { id: 'project', ico: '🛠️', name: 'Projects' },
  { id: 'weekly', ico: '📅', name: 'Weekly' },
  { id: 'loop', ico: '🔁', name: 'Loop' },
  { id: 'prompts', ico: '💬', name: 'Prompts' },
  { id: 'life', ico: '🌱', name: 'Sustainability' },
];

const chip = (s) => `<span class="lh-chip ${s.cls}">${esc(s.label)}</span>`;

function renderTree() {
  return LAYERS.map((x) => `
    <div class="lh-layer">
      <div class="lh-layer-n">L${x.n}</div>
      <div><div class="lh-layer-name">${esc(x.name)}</div>
      <div class="lh-dim"><b>Why</b>: ${esc(x.why)}</div>
      <div class="lh-dim"><b>Scope</b>: ${esc(x.is)}</div>
      <div class="lh-dim"><b>Enough</b>: ${esc(x.enough)}</div></div>
    </div>`).join('');
}

function renderDiag() {
  return DIAGNOSIS.map((x) => `<div class="lh-row"><div class="lh-row-t">${esc(x.topic)}</div><div>${chip(STATUS[x.status])}</div><div class="lh-row-n">${esc(x.note)}</div></div>`).join('')
    + (NOT_NEEDED.length ? `<div class="lh-note"><b>KEEP OUT</b>: ${NOT_NEEDED.map(esc).join(' · ')}</div>` : '');
}

function renderRoute() {
  return PHASES.map((x) => `<div class="lh-phase"><div class="lh-phase-head"><span class="lh-tag">${esc(x.tag)}</span><b>${esc(x.title)}</b><span class="lh-dim">${esc(x.when)}</span></div>
    <div class="lh-dim"><b>Scope</b>: ${esc(x.learn)}</div><div class="lh-dim"><b>Why</b>: ${esc(x.why)}</div><div class="lh-dim"><b>Enough</b>: ${esc(x.enough)}</div><div class="lh-dim"><b>Project</b>: ${esc(x.map)}</div><div class="lh-dim"><b>Impact</b>: ${esc(x.impact)}</div><div class="lh-dim"><b>Next</b>: ${esc(x.next)}</div></div>`).join('');
}

function renderRes() {
  return RESOURCES.map((x) => `<div class="lh-res"><div class="lh-res-topic">${esc(x.topic)}</div><div class="lh-dim"><b>Main</b>: ${esc(x.main)}</div><div class="lh-dim"><b>Aux</b>: ${esc(x.aux)}</div><div class="lh-dim"><b>Notes</b>: ${esc(x.papers.join(' · '))}</div></div>`).join('');
}

function renderProject() {
  return `<table class="lh-table"><tr><th>Concept</th><th>Project check</th></tr>${PROJECT_MAP.map((x) => `<tr><td>${esc(x.know)}</td><td>${esc(x.proj)}</td></tr>`).join('')}</table>`;
}

function renderWeekly() {
  return ['must', 'should', 'later'].map((k) => `<div class="lh-week"><div class="lh-week-t ${k}">${esc(k)}</div><ul class="lh-list">${WEEKLY[k].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('');
}

function renderLoop() {
  return `<div class="lh-loop">${LOOP.map((x) => `<span class="lh-step">${esc(x)}</span>`).join('<span class="lh-arrow">→</span>')}</div>`;
}

function renderPrompts() {
  return PROMPTS.map((x) => `<div class="lh-prompt"><div class="lh-prompt-head"><b>${esc(x.title)}</b><button class="btn small" data-lh-copy="${esc(x.id)}">Copy</button></div><div class="lh-dim">${esc(x.use)}</div><pre class="lh-pre">${esc(x.text)}</pre></div>`).join('');
}

function renderLife() {
  return NON_TECH.map((x) => `<div class="lh-life"><div class="lh-life-t">${esc(x.name)}</div><div class="lh-dim"><b>Now</b>: ${esc(x.now)}</div><div class="lh-dim"><b>Goal</b>: ${esc(x.goal)}</div><div class="lh-dim"><b>Minimum loop</b>: ${esc(x.closed)}</div></div>`).join('');
}

export function renderPage(state = {}) {
  const tab = TABS.some((t) => t.id === state.tab) ? state.tab : 'tree';
  const body = {
    tree: renderTree, diag: renderDiag, route: renderRoute, res: renderRes,
    project: renderProject, weekly: renderWeekly, loop: renderLoop,
    prompts: renderPrompts, life: renderLife,
  }[tab]();
  return `
  <style>
    .lh-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 12px}
    .lh-tab{border:1px solid var(--line,#2a2a2a);background:transparent;color:inherit;border-radius:999px;padding:5px 12px;cursor:pointer;font-size:13px}
    .lh-tab.active{background:#e60012;border-color:#e60012;color:#fff}
    .lh-note,.lh-dim{font-size:13px;opacity:.86;margin:3px 0;line-height:1.65}
    .lh-chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px}
    .lh-ok{background:#123d24;color:#7ee2a8}.lh-proj{background:#3d3410;color:#ffd166}
    .lh-none{background:#3d1414;color:#ff9b9b}.lh-later{background:#22262c;color:#aab}
    .lh-layer{display:flex;gap:10px;padding:10px 0;border-bottom:1px dashed var(--line,#2a2a2a)}
    .lh-layer-n{font-weight:800;color:#e60012;min-width:34px}.lh-layer-name{font-weight:700;margin-bottom:4px}
    .lh-row{display:grid;grid-template-columns:1.3fr 150px 2fr;gap:8px;padding:8px 0;border-bottom:1px dashed var(--line,#2a2a2a)}
    .lh-row-t{font-weight:600}.lh-row-n{font-size:13px;opacity:.84;line-height:1.6}
    .lh-phase,.lh-res,.lh-prompt,.lh-life{border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:10px 12px;margin:10px 0}
    .lh-phase-head,.lh-prompt-head{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
    .lh-tag{background:#e60012;color:#fff;border-radius:6px;padding:1px 8px;font-size:12px}
    .lh-table{width:100%;border-collapse:collapse;font-size:13px}.lh-table th,.lh-table td{border:1px solid var(--line,#2a2a2a);padding:7px 9px;text-align:left}
    .lh-week{border-left:3px solid var(--line,#2a2a2a);padding-left:10px;margin:10px 0}.lh-week-t{font-weight:700}
    .lh-week-t.must{color:#ff6b6b}.lh-week-t.should{color:#ffd166}.lh-week-t.later{color:#8ab4f8}
    .lh-list{margin:4px 0 4px 18px;font-size:13px;line-height:1.75}.lh-loop{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}
    .lh-step{background:var(--line,#2a2a2a);border-radius:6px;padding:3px 8px}.lh-arrow{opacity:.5}
    .lh-pre{white-space:pre-wrap;font-size:12.5px;line-height:1.6;background:rgba(127,127,127,.08);border-radius:8px;padding:10px;margin:8px 0 0}
  </style>
  <div class="card">
    <div class="flex" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <h3 style="margin:0">🧭 Learning Hub</h3>
      <a class="btn small" href="/docs/LEARNING_FRAMEWORK.md" target="_blank" rel="noopener">Open public template</a>
    </div>
    <div class="lh-dim" style="margin-top:6px">${esc(NOW.date)} · ${esc(NOW.line)}</div>
    <div class="lh-tabs" style="margin-top:10px">
      ${TABS.map((t) => `<button class="lh-tab ${t.id === tab ? 'active' : ''}" data-lh-tab="${esc(t.id)}">${esc(t.ico)} ${esc(t.name)}</button>`).join('')}
    </div>
    <div id="lh-body">${body}</div>
  </div>`;
}

export async function mount(el, ctx = {}) {
  const { toast = () => {} } = ctx;
  let tab = 'tree';
  const draw = () => {
    el.innerHTML = renderPage({ tab });
    el.querySelectorAll('[data-lh-tab]').forEach((b) => {
      b.onclick = () => { tab = b.dataset.lhTab; draw(); };
    });
    el.querySelectorAll('[data-lh-copy]').forEach((b) => {
      b.onclick = async () => {
        const prompt = PROMPTS.find((x) => x.id === b.dataset.lhCopy);
        if (!prompt) return;
        try {
          await navigator.clipboard.writeText(prompt.text);
          toast('Copied', 'green');
        } catch {
          toast('Copy failed; select the text manually.', 'red');
        }
      };
    });
  };
  draw();
}
