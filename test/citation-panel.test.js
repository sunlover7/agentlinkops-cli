import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStarterPanel } from '../src/citations/panel-builder.js';
import { citationPanelSchema } from '../src/citations/contract.js';

test('starter panel: domain + brand → validated v2 panel with editable suggestions and a mock default', () => {
  const panel = buildStarterPanel({ domain: 'example.com', brand: 'Example' });
  const parsed = citationPanelSchema.parse(panel);
  assert.equal(parsed.prompts.length, 5);
  assert.equal(parsed.schema_version, 2);
  assert.equal(parsed.engines.length, 1);
  assert.equal(parsed.engines[0].engine, 'mock');
  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0].domain, 'example.com');
  assert.equal(parsed.locale, 'en-US');
});

test('starter panel: competitors become additional targets', () => {
  const panel = buildStarterPanel({
    domain: 'example.com', brand: 'Example',
    competitors: [{ domain: 'competitor.com', brand: 'Competitor', aliases: [] }],
  });
  const parsed = citationPanelSchema.parse(panel);
  assert.equal(parsed.targets.length, 2);
  assert.equal(parsed.targets[1].domain, 'competitor.com');
  assert.equal(parsed.competitors.length, 1);
});

test('starter panel: fails without domain or brand', () => {
  assert.throws(() => buildStarterPanel({}), /required/);
  assert.throws(() => buildStarterPanel({ domain: 'x.com' }), /required/);
});

test('panel schema: locale defaults to en-US', () => {
  const panel = citationPanelSchema.parse({
    schema_version: 1,
    targets: [{ domain: 'example.com', scope: 'domain', brand: 'Example', aliases: [] }],
    prompts: [{ id: 'p1', text: 'test' }],
    engines: [{ engine: 'mock' }],
  });
  assert.equal(panel.locale, 'en-US');
  assert.deepEqual(panel.competitors, []);
});

import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { citationMain } from '../cli/citation.js';
import { createMockEngine } from '../src/citations/adapter.js';
import { engineIdentity } from '../src/citations/contract.js';
import { runEpoch } from '../src/citations/runner.js';
import { analyzeRetainedAnswer } from '../src/citations/match.js';

test('v1 migration materializes competitors and leaves source panel unchanged', () => {
  const input = { schema_version: 1, targets: [{ domain: 'example.com', brand: 'Example' }],
    competitors: [{ domain: 'rival.example.org', brand: 'Rival' }], prompts: [{ text: 'question' }], engines: [{ engine: 'mock' }] };
  const result = citationPanelSchema.parse(input);
  assert.equal(result.schema_version, 2); assert.equal(result.targets.length, 2);
  assert.equal(input.schema_version, 1); assert.equal(input.targets.length, 1);
  assert.equal(citationPanelSchema.parse(result).targets.length, 2, 'migration is idempotent');
});
test('panel CLI writes valid JSON with custom questions and refuses overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-author-'));
  try {
    const out = [], err = []; const options = { cwd: dir, out: value => out.push(value), err: value => err.push(value), env: {} };
    assert.equal(await citationMain(['panel', '--domain', 'example.com', '--brand', 'Example', '--prompt', 'A real customer question?', '--out', 'panel.json'], options), 0);
    const panel = citationPanelSchema.parse(JSON.parse(await readFile(join(dir, 'panel.json'), 'utf8')));
    assert.equal(panel.prompts.length, 1); assert.equal(panel.prompts[0].text, 'A real customer question?');
    assert.equal(panel.engines[0].engine, 'mock'); assert.match(err.join('\n'), /not observed search demand/);
    assert.equal(await citationMain(['panel', '--domain', 'example.com', '--brand', 'Example', '--out', 'panel.json'], options), 2);
    assert.equal(await citationMain(['panel', '--domain', 'example.com/path', '--brand', 'Example'], options), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('mentioned and cited remain independent during retained-answer re-analysis', () => {
  const target = { scope: 'domain', domain: 'example.com', brand: 'Example' };
  const cases = [
    [{ answer: 'Example offers a useful service.', citations: [] }, true, false, 'mentioned'],
    [{ answer: 'Example is described here.', citations: [{ url: 'https://example.com/source' }] }, true, true, 'cited'],
    [{ answer: 'Exampleshop is unrelated.', citations: [] }, false, false, 'not_cited'],
    [{ answer: '', citations: [], failure: { code: 'blocked' } }, null, null, 'unknown'],
  ];
  for (const [envelope, mentioned, cited, outcome] of cases) {
    assert.deepEqual(analyzeRetainedAnswer(target, envelope), { mentioned, cited, citedUrls: cited ? ['https://example.com/source'] : [], outcome });
  }
});
test('non-US mock epoch retains locale, separates competitor scopes and never shares US baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-locale-'));
  try {
    const spec = { engine: 'mock' }, engines = new Map([[engineIdentity(spec), createMockEngine({ fixtures: { question: { citations: [{ url: 'https://rival.example.org/source', weight: 1 }], mentionText: 'Example offers a service.' } } })]]);
    const panel = buildStarterPanel({ domain: 'example.com', brand: 'Example', competitors: [{ domain: 'rival.example.org', brand: 'Rival' }], prompts: [{ id: 'question', text: 'question' }], samples: 10 });
    const us = await runEpoch(panel, { dir, engines, now: new Date('2026-09-19T00:00:00Z') });
    const gb = await runEpoch({ ...panel, locale: 'en-GB', country: 'GB' }, { dir, engines, now: new Date('2026-09-20T00:00:00Z') });
    assert.equal(gb.cells.length, 2);
    assert.ok(gb.cells.every(cell => cell.cell_id.includes('question@en-GB:GB')));
    assert.ok(gb.cells.every(cell => cell.baseline === undefined));
    assert.ok(us.cells.every(cell => !cell.cell_id.includes('@')));
    assert.equal(gb.cells.find(cell => cell.cell_id.endsWith('d:rival.example.org')).k, 10);
    assert.equal(gb.cells.find(cell => cell.cell_id.endsWith('d:example.com')).mentioned, 10);
    const evidenceDir = join(dir, 'citations', 'evidence', gb.epochId);
    const evidence = JSON.parse(await readFile(join(evidenceDir, (await readdir(evidenceDir)).find(name => name.endsWith('.json'))), 'utf8'));
    assert.deepEqual(evidence.locale_context, { locale: 'en-GB', country: 'GB', mode: 'fixture' });
    const before = JSON.stringify(evidence);
    analyzeRetainedAnswer(panel.targets[0], evidence);
    assert.equal(JSON.stringify(evidence), before, 're-analysis preserves evidence');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('AIO GB country flag controls the explicit provider request in a non-US fixture', async () => {
  const { createGoogleAioEngine } = await import('../src/citations/adapter.js');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/citations/dataforseo-aio.json', import.meta.url), 'utf8'));
  fixture.tasks[0].result[0].location_code = 2826;
  let sent;
  const adapter = createGoogleAioEngine({ country: 'GB', credentials: { login: 'fixture', password: 'fixture' },
    fetchImpl: async (_, init) => { sent = JSON.parse(init.body)[0]; return Response.json(fixture); } });
  const run = await adapter.run({ prompt: fixture.tasks[0].result[0].keyword });
  assert.equal(sent.location_code, 2826); assert.equal(sent.language_code, 'en');
  assert.equal(run.provenance.location_code, 2826);
  assert.throws(() => createGoogleAioEngine({ country: 'ZZ' }), /country must be US or GB/);
});
