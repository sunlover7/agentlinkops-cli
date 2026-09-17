import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/main.js';
import { classifyObservation, classifyBenchmarkRow, platformAggregate, attachToCandidates } from '../cli/platforms.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-platforms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const observation = over => `${JSON.stringify({
  id: 'lk_x', checked_at: '2026-09-11T05:00:00.000Z', state: over.state, reason: over.reason ?? 'link_found',
  occurrences: 1, complete: true, checker_version: '1', source: 'local', evidence_key: null,
  result: { state: over.state, reason: over.reason ?? 'link_found', sourceUrl: `https://${over.host}/user/x`,
    directives: { noindex: over.noindex ?? false } },
})}\n`;

test('the classifier votes only where the verifier measured a visibility class', () => {
  assert.equal(classifyObservation({ state: 'present', result: { state: 'present', directives: { noindex: false } } }), 'server-html');
  assert.equal(classifyObservation({ state: 'present', result: { state: 'present', directives: { noindex: true } } }), 'noindex');
  assert.equal(classifyObservation({ state: 'unknown', reason: 'possible_render_required', result: { state: 'unknown', reason: 'possible_render_required', directives: {} } }), 'js-only');
  // THE T01 rule, kept: an absent on a rich page is not evidence of js-only, and votes nothing.
  assert.equal(classifyObservation({ state: 'absent', reason: 'no_matching_link_in_complete_html', result: { state: 'absent', reason: 'no_matching_link_in_complete_html', directives: {} } }), null);
  assert.equal(classifyObservation({ state: 'unknown', reason: 'robots_http_403', result: { state: 'unknown', reason: 'robots_http_403', directives: {} } }), null);
  // Benchmark rows carry the same semantics as renderFixable / noindex booleans.
  assert.equal(classifyBenchmarkRow({ state: 'present', noindex: true }), 'noindex');
  assert.equal(classifyBenchmarkRow({ state: 'unknown', renderFixable: true }), 'js-only');
  assert.equal(classifyBenchmarkRow({ state: 'absent', renderFixable: false, noindex: false }), null);
});

test('observations accumulate per platform with counts, majority class and last-seen', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'obs.jsonl'),
    observation({ host: 'www.wattpad.com', state: 'absent', reason: 'no_matching_link_in_complete_html' })
    + observation({ host: 'wattpad.com', state: 'unknown', reason: 'robots_http_403', state2: 'unknown' })
    + observation({ host: 'gravatar.com', state: 'present' })
    + observation({ host: 'blurb.com', state: 'present', noindex: true }));
  const aggregate = await platformAggregate({ observations: [join(dir, 'obs.jsonl')] });
  const wattpad = aggregate.platforms.find(row => row.platform === 'wattpad.com');
  assert.ok(wattpad, 'www. and bare host merge to one platform');
  assert.equal(wattpad.observations, 2);
  assert.equal(wattpad.majority_class, null, 'no class votes -> unknown, not a default');
  assert.equal(wattpad.status, 'observed-unclassified');
  const gravatar = aggregate.platforms.find(row => row.platform === 'gravatar.com');
  assert.equal(gravatar.majority_class, 'server-html');
  assert.equal(gravatar.last_seen, '2026-09-11');
  // noindex outranks presence: a link on a noindexed page is present but not visible.
  assert.equal(aggregate.platforms.find(row => row.platform === 'blurb.com').majority_class, 'noindex');
});

test('a seed contributes a class vote with its own provenance, never a guess', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'seed.jsonl'), `${JSON.stringify({ platform: 'vimeo.com', class: 'js-only', checked_at: '2026-09-11', provenance: 'dp-0014-t01-absent-adjudication-2026-09-11' })}\n`);
  const aggregate = await platformAggregate({ seed: [join(dir, 'seed.jsonl')] });
  const vimeo = aggregate.platforms.find(row => row.platform === 'vimeo.com');
  assert.equal(vimeo.majority_class, 'js-only');
  assert.equal(vimeo.sources['dp-0014-t01-absent-adjudication-2026-09-11'], 1);
});

test('a majority requires more than half the classified votes; a tie is not a majority', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'obs.jsonl'),
    observation({ host: 'mixed.example', state: 'present' })
    + observation({ host: 'mixed.example', state: 'present', noindex: true }));
  const aggregate = await platformAggregate({ observations: [join(dir, 'obs.jsonl')] });
  assert.equal(aggregate.platforms[0].classified, 2);
  assert.equal(aggregate.platforms[0].majority_class, null, 'one server-html and one noindex is a tie');
});

test('the CLI answers a placement agent query and says unknown for the unmeasured', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'obs.jsonl'), observation({ host: 'www.wattpad.com', state: 'absent', reason: 'no_matching_link_in_complete_html' }));
  await writeFile(join(dir, 'seed.jsonl'), `${JSON.stringify({ platform: 'wattpad.com', class: 'js-only', checked_at: '2026-09-11', provenance: 'adjudication' })}\n`);
  const lines = [];
  await main(['platforms', 'wattpad', '--observations', join(dir, 'obs.jsonl'), '--seed', join(dir, 'seed.jsonl')], { out: line => lines.push(line) });
  assert.ok(lines.some(line => line.includes('wattpad.com') && line.includes('js-only')));

  const none = [];
  await main(['platforms', 'never-measured.example', '--seed', join(dir, 'seed.jsonl')], { out: line => none.push(line) });
  assert.ok(none.some(line => line.includes('unknown') && line.includes('Nothing is inferred from absence')));
});

test('the aggregate travels with candidate rows as claim-free context', async t => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'obs.jsonl'), observation({ host: 'gravatar.com', state: 'present' }));
  const aggregate = await platformAggregate({ observations: [join(dir, 'obs.jsonl')] });
  const [attached, unmeasured] = attachToCandidates([
    { id: 'dc_1', source_url: 'https://gravatar.com/brand' },
    { id: 'dc_2', source_url: 'https://unmeasured.example/brand' },
  ], aggregate);
  assert.equal(attached.platform_context.majority_class, 'server-html');
  assert.equal(attached.platform_context.claim, 'counts_from_our_observations_only');
  assert.equal(unmeasured.platform_context.observations, 0);
  assert.equal(unmeasured.platform_context.claim, 'no_observations_unknown');
  // Claim-free means no recommendation travels with the numbers.
  assert.equal('worth_it' in attached.platform_context, false);
  assert.equal('verdict' in attached.platform_context, false);
});
