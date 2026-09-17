import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/main.js';
import { fleetProject, fleetSummary } from '../cli/fleet.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-fleet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const entry = (id, intent, source) => `${JSON.stringify({ id, intent, source, target: 'https://me.example/', scope: 'domain' })}\n`;
const observation = (id, state, checked_at = '2026-09-11T05:00:00.000Z') => `${JSON.stringify({
  id, checked_at, state, reason: state === 'present' ? 'link_found' : 'no_matching_link_in_complete_html',
  occurrences: state === 'present' ? 1 : 0, complete: true, checker_version: '1', source: 'local', evidence_key: null,
  result: { state, reason: 'x', sourceUrl: `https://${id}.example/x`, directives: { noindex: false } },
})}\n`;

test('fleet summarises each project on its own and never merges intent', async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, 'a'));
  await mkdir(join(dir, 'b'));
  // THE case the acceptance names: the same platform domain, expected in one project and
  // merely wanted in another. Two files, two ids, and the summary must report both.
  await writeFile(join(dir, 'a', 'links.jsonl'), entry('lk_expected1', 'expected', 'https://platform.example/a') + entry('lk_wantedaa', 'wanted', 'https://other.example/'));
  await writeFile(join(dir, 'b', 'links.jsonl'), entry('lk_wantedbb', 'wanted', 'https://platform.example/b'));
  await writeFile(join(dir, 'a', 'observations.jsonl'), observation('lk_expected1', 'present'));

  const summary = await fleetSummary(
    [{ name: 'a', ledger: join(dir, 'a', 'links.jsonl') }, { name: 'b', ledger: join(dir, 'b', 'links.jsonl') }],
    { observationsOf: { a: join(dir, 'a', 'observations.jsonl') } },
  );

  assert.equal(summary.intent_merged_across_repos, false);
  const a = summary.projects.find(p => p.project === 'a'), b = summary.projects.find(p => p.project === 'b');
  assert.equal(a.expected, 1);
  assert.equal(a.earned, 1, 'an entry whose latest observation says present is earned');
  assert.equal(b.wanted, 1);
  assert.equal(b.earned, 0);
  assert.equal(b.last_observation, null);
  assert.equal(b.never_checked, 1);
  // The same platform counted in both projects is two intents; the total is a sum of counts.
  assert.equal(summary.totals.entries, 3);
});

test('an observation for an id the ledger does not hold is not earned', async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, 'a'));
  await writeFile(join(dir, 'a', 'links.jsonl'), entry('lk_present', 'expected', 'https://platform.example/a'));
  await writeFile(join(dir, 'a', 'observations.jsonl'), observation('lk_otherled', 'present'));
  const row = await fleetProject('a', join(dir, 'a', 'links.jsonl'), join(dir, 'a', 'observations.jsonl'));
  assert.equal(row.earned, 0);
  assert.equal(row.observed_entries, 0);
});

test('the CLI renders per-project rows and refuses a project argument without a path', async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, 'a'));
  await writeFile(join(dir, 'a', 'links.jsonl'), entry('lk_one12345', 'wanted', 'https://platform.example/a'));
  const lines = [];
  const code = await main(['fleet', '--project', `a=${join(dir, 'a', 'links.jsonl')}`], { out: line => lines.push(line) });
  assert.equal(code, 0);
  assert.ok(lines.some(line => line.includes('never merged across repos')));
  assert.ok(lines.some(line => line.trim().startsWith('a ') && line.includes('1')));

  const bad = await main(['fleet', '--project', 'noname'], { out: () => {}, err: () => {} });
  assert.equal(bad, 2);
});
