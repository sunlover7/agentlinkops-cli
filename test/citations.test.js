// Citation watch tests. Zero network: every engine here is the mock, every fetch is
// injected, and the budget cap is proven with the mock's nominal estimates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wilsonInterval, smoothedRate, classifyEpoch, tallyOutcomes } from '../src/citations/stats.js';
import { registrableDomain, normalizeHost, urlMatchKey, matchCitations, matchMention, classifyOutcome } from '../src/citations/match.js';
import { createMockEngine } from '../src/citations/adapter.js';
import { runEpoch } from '../src/citations/runner.js';
import { engineIdentity } from '../src/citations/contract.js';

test('wilson interval matches hand-computed values', () => {
  assert.deepEqual(wilsonInterval(24, 30).map((x) => Number(x.toFixed(3))), [0.627, 0.905]);
  assert.deepEqual(wilsonInterval(6, 30).map((x) => Number(x.toFixed(3))), [0.095, 0.373]);
  assert.equal(wilsonInterval(0, 0), null);
});

test('a collapse separates intervals and a wobble does not', () => {
  const base = { k: 24, n: 30 };
  assert.equal(classifyEpoch({ k: 6, n: 30 }, base, { minSamplesForInterpretation: 10, maxCiWidth: 0.5 }), 'declined');
  // 30/30 separates entirely from 12/30.
  assert.equal(classifyEpoch({ k: 30, n: 30 }, { k: 12, n: 30 }, { minSamplesForInterpretation: 10, maxCiWidth: 0.5 }), 'grown');
  assert.equal(classifyEpoch({ k: 24, n: 30 }, null, { minSamplesForInterpretation: 10, maxCiWidth: 0.5 }), 'first_epoch');
  // 18/30 overlaps 24/30: honestly not distinguishable, never "stable".
  assert.equal(classifyEpoch({ k: 18, n: 30 }, base, { minSamplesForInterpretation: 10, maxCiWidth: 0.5 }), 'not_distinguishable');
  // Thin data is refused before it is interpreted.
  assert.equal(classifyEpoch({ k: 3, n: 5 }, base, { minSamplesForInterpretation: 10, maxCiWidth: 0.5 }), 'insufficient_data');
});

test('smoothed rate never claims certainty of zero or one', () => {
  assert.equal(smoothedRate(0, 30), 1 / 32);
  assert.equal(smoothedRate(30, 30), 31 / 32);
  assert.equal(smoothedRate(0, 0), null);
});

test('unknown outcomes leave the denominator', () => {
  const t = tallyOutcomes(['unknown', 'cited', 'verified', 'mentioned', 'not_cited', 'unknown']);
  assert.equal(t.n, 4);
  assert.equal(t.k, 2);
  assert.equal(t.unknowns, 2);
  assert.equal(t.mentioned, 1);
});

test('registrable domains: www, apex and multi-label suffixes', () => {
  assert.equal(normalizeHost('WWW.Example.COM.'), 'example.com');
  assert.equal(registrableDomain('shop.example.com'), 'example.com');
  assert.equal(registrableDomain('www.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('citation matching: domain scope survives www and apex variants', () => {
  const target = { scope: 'domain', domain: 'example.com' };
  const hits = matchCitations(target, [
    { url: 'https://www.example.com/guide' },
    { url: 'https://other.example.org/x' },
    { url: 'https://sub.example.com/deep/page' },
  ]);
  assert.deepEqual(hits, ['https://www.example.com/guide', 'https://sub.example.com/deep/page']);
});

test('citation matching: url scope needs the path, ignores query and slash noise', () => {
  const target = { scope: 'url', url: 'https://example.com/guide/' };
  assert.deepEqual(matchCitations(target, [{ url: 'https://www.example.com/guide?utm=x' }, { url: 'https://example.com/other' }]), ['https://www.example.com/guide?utm=x']);
  assert.equal(urlMatchKey('https://example.com'), urlMatchKey('http://www.example.com/'));
});

test('mention matching is word-boundary and alias-aware', () => {
  const target = { brand: 'Acme', aliases: ['Acme Optics'] };
  assert.equal(matchMention(target, 'Acme makes the best optics.'), true);
  assert.equal(matchMention(target, 'Buy from acmeshop today.'), false);
  assert.equal(matchMention(target, 'Try Acme Optics instead.'), true);
  assert.equal(matchMention(target, 'Nothing here.'), false);
});

test('outcome tiers: cited outranks mention; verified needs a reachable fetch', () => {
  const target = { scope: 'domain', domain: 'example.com', brand: 'Acme', aliases: [] };
  const run = { citations: [{ url: 'https://example.com/a' }], answer: 'Acme says hi' };
  assert.equal(classifyOutcome(target, run).outcome, 'cited');
  assert.equal(classifyOutcome(target, run, () => true).outcome, 'verified');
  // A failed verification fetch never downgrades the citation.
  assert.equal(classifyOutcome(target, run, () => false).outcome, 'cited');
  const mentionOnly = { citations: [], answer: 'Acme is mentioned.' };
  assert.equal(classifyOutcome(target, mentionOnly).outcome, 'mentioned');
  assert.equal(classifyOutcome(target, { citations: [], answer: 'nope' }).outcome, 'not_cited');
});

const panelFor = (fixtures, overrides = {}) => ({
  schema_version: 1,
  targets: [{ domain: 'example.com', scope: 'domain', brand: 'Acme', aliases: [] }],
  prompts: [
    { id: 'p1', text: 'what is the best optics guide' },
    { id: 'p2', text: 'acme review' },
  ],
  engines: [{ engine: 'mock' }],
  samples: 10,
  maxUsd: 5,
  ...overrides,
});

test('epoch runner: evidence, observations, epochs and first_epoch classification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citations-'));
  const identity = engineIdentity({ engine: 'mock' });
  const engines = new Map([[identity, createMockEngine({
    fixtures: {
      'what is the best optics guide': { citations: [{ url: 'https://example.com/guide', weight: 1 }] },
      'acme review': { citations: [], mentionText: 'Acme is well regarded.' },
    },
  })]]);

  const result = await runEpoch(panelFor(), { dir, engines, now: new Date('2026-09-16T12:00:00Z') });
  assert.equal(result.aborted, null);
  assert.equal(result.cells.length, 2);
  const citedCell = result.cells.find((c) => c.k === 10);
  const mentionedCell = result.cells.find((c) => c.mentioned === 10);
  assert.ok(citedCell, 'one cell should be cited 10/10');
  assert.ok(mentionedCell, 'one cell should be mentioned 10/10');
  assert.equal(mentionedCell.k, 0);
  assert.equal(citedCell.classification, 'first_epoch');
  assert.equal(citedCell.unknowns, 0);

  const obsText = await readFile(join(dir, 'citations-observations.jsonl'), 'utf8');
  const obs = obsText.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(obs.length, 20);
  assert.ok(obs.every((o) => o.evidence_sha256.length === 64));

  const evidenceFiles = await readdir(join(dir, 'citations/evidence', result.epochId));
  assert.equal(evidenceFiles.length, 20);
  const one = JSON.parse(await readFile(join(dir, 'citations/evidence', result.epochId, evidenceFiles[0]), 'utf8'));
  assert.equal(one.schema_version, 1);
  assert.ok(one.engine_identity.startsWith('mock:builtin'));
});

test('epoch runner: a collapse between epochs is declined, with the baseline recorded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citations-'));
  const identity = engineIdentity({ engine: 'mock' });
  const strongFixtures = {
    'what is the best optics guide': { citations: [{ url: 'https://example.com/guide', weight: 1 }] },
    'acme review': { citations: [{ url: 'https://example.com/review', weight: 0.8 }] },
  };
  const collapsedFixtures = {
    'what is the best optics guide': { citations: [{ url: 'https://example.com/guide', weight: 0.05 }] },
    'acme review': { citations: [], mentionText: 'Acme is still mentioned.' },
  };
  await runEpoch(panelFor(), { dir, engines: new Map([[identity, createMockEngine({ seed: 'a', fixtures: strongFixtures })]]), now: new Date('2026-09-16T12:00:00Z') });
  const second = await runEpoch(panelFor(), { dir, engines: new Map([[identity, createMockEngine({ seed: 'a', fixtures: collapsedFixtures })]]), now: new Date('2026-09-23T12:00:00Z') });
  const guide = second.cells.find((c) => c.cell_id.includes('p1'));
  assert.equal(guide.classification, 'declined');
  assert.ok(guide.baseline);
  assert.equal(guide.baseline.epoch_id !== second.epochId, true);
});

test('budget cap: the runner aborts BEFORE exceeding and records a partial receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citations-'));
  const identity = engineIdentity({ engine: 'mock' });
  const engines = new Map([[identity, createMockEngine({ costEstimateUsd: 0.01, fixtures: {
    'what is the best optics guide': { citations: [{ url: 'https://example.com/guide', weight: 1 }] },
    'acme review': { citations: [] },
  } })]]);
  const result = await runEpoch(panelFor(null, { samples: 10, maxUsd: 0.045 }), { dir, engines, now: new Date('2026-09-16T12:00:00Z') });
  assert.ok(result.aborted, 'must abort');
  assert.equal(result.aborted.reason, 'budget');
  assert.ok(result.spentEstimateUsd <= 0.045, `spent ${result.spentEstimateUsd} exceeded the cap`);
  assert.equal(result.spentEstimateUsd, 0.04);
  // Partial tallies fall below the interpretation minimum and say so.
  assert.ok(result.cells.every((c) => c.classification === 'insufficient_data'));
});

test('all unknown runs preserve null rate and confidence limits', async () => {
  const { EngineError } = await import('../src/citations/adapter.js');
  const { rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'citations-unknown-'));
  try {
    const engines = new Map([[engineIdentity({ engine: 'mock' }), { estimateCostUsd: () => 0, run: async () => { throw new EngineError('unavailable', { retriable: true }); } }]]);
    const result = await runEpoch(panelFor(), { dir, engines });
    for (const row of result.cells) {
      assert.equal(row.n, 0); assert.equal(row.rate, null); assert.equal(row.ci_low, null); assert.equal(row.ci_high, null);
      assert.equal(row.classification, 'insufficient_data');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('epoch JSON carries supplemental corrected statistics without dropping fixed-n samples', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citations-statistics-'));
  const { rm } = await import('node:fs/promises');
  try {
    const engines = new Map([[engineIdentity({ engine: 'mock' }), createMockEngine()]]);
    const result = await runEpoch(panelFor(), { dir, engines });
    for (const cell of result.cells) {
      assert.equal(cell.statistics.scope, 'fixed-epoch-supplemental');
      assert.equal(cell.statistics.confidence_sequence.comparisons, result.cells.length);
      assert.equal(cell.statistics.confidence_sequence.n, 10);
      assert.equal(cell.statistics.epoch_comparison, null);
      assert.equal(cell.statistics.changepoint.interpretation, 'exploratory');
      assert.equal(cell.statistics.changepoint.run_length_posterior, undefined);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
