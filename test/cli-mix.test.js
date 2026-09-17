import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../cli/main.js';
import { renderMix } from '../cli/mix.js';
import { buildDomainMixReport } from '../src/competitors/domain-mix.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-mix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const entry = (id, source, tags, added) => `${JSON.stringify({ id, intent: 'wanted', source, target: 'https://me.example/', scope: 'domain', ...(tags ? { tags } : {}), ...(added ? { added } : {}) })}\n`;

async function init(dir) {
  const out = [];
  const code = await main(['init'], { cwd: dir, out: line => out.push(line), err: () => {} });
  assert.equal(code, 0);
  return out;
}

test('mix splits the ledger into src lanes, counts classes from tags only, and renders honestly', async t => {
  const dir = await scratch(t);
  await init(dir);
  await writeFile(join(dir, '.agentlinkops', 'links.jsonl'),
    entry('lk_a1b2c3d4', 'https://pad.example/a', ['generic', 'src:sneakies-2025-03'], '2026-09-01')
    + entry('lk_b2c3d4e5', 'https://pad.example/b', ['generic', 'src:sneakies-2025-03'])
    + entry('lk_c3d4e5f6', 'https://niche-dir.example/listing', ['niche', 'src:curated-2026'])
    + entry('lk_d4e5f6a7', 'https://unlabelled.example/x'));
  const out = [];
  const code = await main(['mix'], { cwd: dir, out: line => out.push(line), err: () => {} });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.match(text, /competitor side: no_approved_competitor_set/);
  assert.match(text, /sneakies-2025-03: 1 domains — generic 1.*unlabelled 0/);
  assert.match(text, /curated-2026: 1 domains — .*niche 1/);
  assert.match(text, /unattributed: 1 domains — .*unlabelled 1/);
  assert.doesNotMatch(text, /padding guidance|50-100 padding|kit sources|seller supporting/);
  assert.match(text, /report [0-9a-f]{64}/);
});

test('mix --json emits the full report and --lane-file merges bridge output', async t => {
  const dir = await scratch(t);
  await init(dir);
  await writeFile(join(dir, '.agentlinkops', 'links.jsonl'),
    entry('lk_a1b2c3d4', 'https://pad.example/a', ['generic', 'src:sneakies-2025-03']));
  const laneFile = join(dir, 'graph-lanes.json');
  await writeFile(laneFile, JSON.stringify([{ lane: 'cc-webgraph:me.example', rows: [
    { source_url: 'https://referrer.example/' }, { source_url: 'https://other.example/', class: 'niche' },
  ] }]));
  const out = [];
  const code = await main(['mix', '--lane-file', laneFile, '--json'], { cwd: dir, out: line => out.push(line), err: () => {} });
  assert.equal(code, 0);
  const report = JSON.parse(out.join('\n'));
  assert.equal(report.metadata.kind, 'referring_domain_mix');
  assert.deepEqual(report.metadata.lanes, ['sneakies-2025-03', 'cc-webgraph:me.example']);
  const graph = report.ours.find(lane => lane.lane === 'cc-webgraph:me.example');
  assert.equal(graph.referring_domains, 2);
  assert.equal(graph.classes.niche, 1);
  assert.equal(graph.classes.unlabelled, 1);
});

test('mix --save then --against renders the watch diff for grown lanes and refuses different ones', async t => {
  const dir = await scratch(t);
  await init(dir);
  await writeFile(join(dir, '.agentlinkops', 'links.jsonl'),
    entry('lk_a1b2c3d4', 'https://pad.example/a', ['generic', 'src:sneakies-2025-03']));
  const saved = join(dir, 'mix-baseline.json');
  const first = [];
  assert.equal(await main(['mix', '--save', saved, '--json'], { cwd: dir, out: line => first.push(line), err: () => {} }), 0);
  await writeFile(join(dir, '.agentlinkops', 'links.jsonl'),
    entry('lk_a1b2c3d4', 'https://pad.example/a', ['generic', 'src:sneakies-2025-03'])
    + entry('lk_b2c3d4e5', 'https://new-referrer.example/x', ['niche', 'src:sneakies-2025-03']));
  const out = [];
  assert.equal(await main(['mix', '--against', saved], { cwd: dir, out: line => out.push(line), err: () => {} }), 0);
  const text = out.join('\n');
  assert.match(text, /referring-domains 1 -> 2/);
  assert.match(text, /\+ niche new-referrer\.example/);
  // Different lanes refuse with the reason and still exit 0: a stated refusal, not a crash.
  const laneFile = join(dir, 'other-lanes.json');
  await writeFile(laneFile, JSON.stringify([{ lane: 'cc-webgraph:me.example', rows: [{ source_url: 'https://x.example/' }] }]));
  const refused = [];
  assert.equal(await main(['mix', '--against', saved, '--lane-file', laneFile], { cwd: dir, out: line => refused.push(line), err: () => {} }), 0);
  assert.match(refused.join('\n'), /not comparable: lanes differ/);
});

test('mix on an empty ledger is a confirmed absence (exit 1), never an empty report', async t => {
  const dir = await scratch(t);
  await init(dir);
  const errs = [];
  const code = await main(['mix'], { cwd: dir, out: () => {}, err: line => errs.push(line) });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /no labelled rows/);
});

test('mix without a ledger init says so instead of inventing one (exit 2)', async t => {
  const dir = await scratch(t);
  const errs = [];
  const code = await main(['mix'], { cwd: dir, out: () => {}, err: line => errs.push(line) });
  assert.equal(code, 2);
});


test('human renderer ignores obsolete guidance fields in older reports', async () => {
  const report = await buildDomainMixReport({ lanes: [{ lane: 'customer', rows: [{ source_url: 'https://example.com/', class: 'niche' }] }] });
  report.padding_guidance = { guidance: 'private vendor instruction', source: 'internal vendor path' };
  const lines = [];
  renderMix(report, line => lines.push(line));
  assert.match(lines.join('\n'), /customer: 1 domains/);
  assert.doesNotMatch(lines.join('\n'), /private vendor|internal vendor|padding guidance/);
});
