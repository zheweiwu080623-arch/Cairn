// Parity test for the extracted ViewModel layer.
//
//   node tests/viewmodel.test.mjs
//
// Three things are checked:
//   1. shape    — every ViewModel satisfies contracts/viewmodel.v1
//   2. parity   — buildTodayVM() reproduces the legacy renderToday() selection
//                 (oracle: work/baseline/expected-today.json, written by an
//                  independent Python implementation of the app.js rules)
//   3. surfaces — the same ViewModel feeds two display surfaces (text + markdown)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import {
  buildTodayVM, buildTasksVM, buildSourcesVM, buildNotificationsVM,
  registeredViews, buildView, renderText, renderMarkdown,
} from '../public/viewmodel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Fixture resolution, in order:
//   1. $PLANNER_TEST_BASELINE              (point it at a fresh capture)
//   2. tests/fixtures/                     (ships with the repo)
//   3. ...\2026-09-17\xian\work\baseline   (the working tree that produced them)
const CANDIDATES = [
  process.env.PLANNER_TEST_BASELINE,
  join(HERE, 'fixtures'),
  join(HERE, '..', '..', '..', 'baseline'),
].filter(Boolean);
const BASELINE = CANDIDATES.find((dir) =>
  existsSync(join(dir, 'planner-state.json')) && existsSync(join(dir, 'expected-today.json')));
if (!BASELINE) {
  console.error(`no baseline fixture found; looked in:\n  ${CANDIDATES.join('\n  ')}`);
  process.exit(2);
}
console.log(`  baseline: ${BASELINE}`);

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const project = (vm) => ({
  id: vm.id,
  title: vm.title,
  summary: vm.summary,
  badge: vm.badge,
  sections: vm.sections.map((s) => ({ id: s.id, title: s.title, items: s.items.map((i) => i.id) })),
});

const state = JSON.parse(readFileSync(join(BASELINE, 'planner-state.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(BASELINE, 'expected-today.json'), 'utf8'));
const NOW = expected.now_ms;

console.log('viewmodel.test.mjs');
console.log(`  state: ${state.tasks.length} tasks / ${state.events.length} events / ${state.notifications.length} notifications, now=${NOW}`);

// ---- 1. shape
const today = buildTodayVM(state, NOW);
ok('today has schema viewmodel.v1', today.schema === 'viewmodel.v1');
ok('today has id + title', Boolean(today.id && today.title));
ok('every section has id/title/items', today.sections.every((s) => s.id && s.title && Array.isArray(s.items)));
ok('every item has id + title', today.sections.every((s) => s.items.every((i) => i.id && i.title)));
ok('levels are in the contract enum', today.sections.every((s) =>
  s.items.every((i) => ['info', 'ok', 'warn', 'error', 'muted'].includes(i.level))));

// ---- 2. parity with the legacy selection, at two different moments
for (const variant of expected.variants) {
  console.log(`  -- variant ${variant.label} (${variant.today}, ${variant.counts.todays_events} events / ${variant.counts.overdue + variant.counts.due_today} due)`);
  const got = project(buildTodayVM(state, variant.now_ms));
  const want = variant.expected;
  ok(`[${variant.label}] id`, got.id === want.id, `${got.id} vs ${want.id}`);
  ok(`[${variant.label}] summary`, got.summary === want.summary, `${got.summary} vs ${want.summary}`);
  ok(`[${variant.label}] badge`, got.badge === want.badge, `${got.badge} vs ${want.badge}`);
  ok(`[${variant.label}] section order`,
    got.sections.map((s) => s.id).join(',') === want.sections.map((s) => s.id).join(','),
    got.sections.map((s) => s.id).join(','));
  for (const [index, wantSection] of want.sections.entries()) {
    const gotSection = got.sections[index];
    if (!gotSection) {
      ok(`[${variant.label}] section ${wantSection.id} present`, false);
      continue;
    }
    const same = gotSection.items.join('|') === wantSection.items.join('|');
    ok(`[${variant.label}] ${wantSection.id}: ${wantSection.items.length} item(s)`, same,
      same ? '' : `got [${gotSection.items.join(',')}] want [${wantSection.items.join(',')}]`);
  }
}

// ---- 3. other views build and share the contract
for (const [name, build] of [['tasks', buildTasksVM], ['sources', buildSourcesVM], ['notifications', buildNotificationsVM]]) {
  const vm = build(state, NOW);
  ok(`${name} builds a valid view`, Boolean(vm && vm.id === name && Array.isArray(vm.sections)));
}
ok('registry exposes 8 ordered views', registeredViews().length === 8);
ok('buildView("today") resolves to the same view', buildView('today', state, NOW).id === today.id);
ok('buildView("calendar") returns null (not migrated yet)', buildView('calendar', state, NOW) === null);

// ---- 4. one ViewModel, two surfaces
const text = renderText(today);
const markdown = renderMarkdown(today);
const titles = today.sections.flatMap((s) => s.items.map((i) => i.title));
ok('text surface contains every item title', titles.every((t) => text.includes(t)));
ok('markdown surface contains every item title', titles.every((t) => markdown.includes(t)));
ok('markdown starts with the view title', markdown.startsWith(`# ${today.title}`));

console.log('');
console.log(failures === 0 ? 'viewmodel.test: PASS' : `viewmodel.test: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
