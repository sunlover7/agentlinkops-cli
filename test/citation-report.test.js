// Report generator tests: a fake engine produces a real epoch, then the
// report renders from the ledger artifacts — no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runEpoch } from '../src/citations/runner.js';
import { engineIdentity } from '../src/citations/contract.js';
import { generateReport } from '../src/citations/report.js';

test('report renders a complete HTML document with evidence inline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-report-'));
  const fakeEngine = {
    identity: { engine: 'chatgpt', provider: 'web-own-browser', model: 'chatgpt' },
    estimateCostUsd: () => 0.03,
    async run({ prompt }) {
      return {
        engine: 'chatgpt', provider: 'web-own-browser', model: 'chatgpt',
        providerModelVersion: 'chatgpt-web',
        answer: `AgentLinkOps is a backlink monitoring tool. ${prompt}`,
        citations: [{ url: 'https://agentlinkops.com/docs', title: 'AgentLinkOps Docs' }],
        fanOut: [], usage: { input_tokens: 0, output_tokens: 0 },
        costEstimateUsd: 0.03,
        screenshotPng: Buffer.from('fake-png-data-for-test', 'latin1'),
      };
    },
    async close() {},
  };
  const identity = engineIdentity({ engine: 'chatgpt', via: 'browser' });
  const result = await runEpoch({
    schema_version: 1,
    targets: [{ domain: 'agentlinkops.com', scope: 'domain', brand: 'AgentLinkOps', aliases: [] }],
    prompts: [{ id: 'p1', text: 'what is backlink monitoring' }, { id: 'p2', text: 'tools for monitoring' }],
    engines: [{ engine: 'chatgpt', via: 'browser' }],
    samples: 3, maxUsd: 1,
  }, { dir, engines: new Map([[identity, fakeEngine]]), now: new Date('2026-09-18T12:00:00Z') });

  const html = await generateReport({
    dir, epochId: result.epochId,
    panel: { note: 'Test citation panel' },
    now: new Date('2026-09-18T12:05:00Z'),
  });

  // Structure checks
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'renders as HTML');
  assert.ok(html.includes('AgentLinkOps Citation Report'), 'header present');
  assert.ok(html.includes('chatgpt:web-own-browser'), 'engine identity in report');
  assert.ok(html.includes('Wilson 95%'), 'interval label present');
  assert.ok(html.includes('data:image/png;base64,'), 'screenshot embedded as base64');
  assert.ok(html.includes('agentlinkops.com'), 'target domain in summary');
  assert.ok(html.includes('Evidence integrity'), 'integrity footer present');
  assert.ok(html.includes('First epoch') || html.includes('Insufficient data'), 'classification badge present');
  assert.ok(!html.includes('undefined'), 'no undefined values leaked');
  assert.ok(html.length > 2000, 'report is substantial');
});

test('latest panel epoch does not select another panel sharing the ledger', async () => {
  const { latestPanelEpoch } = await import('../src/citations/report.js');
  const { engineIdentity, cellId, targetKey } = await import('../src/citations/contract.js');
  const dir = await mkdtemp(join(tmpdir(), 'citation-panel-select-'));
  const panel = { schema_version: 1, targets: [{ scope: 'domain', domain: 'example.com', brand: 'Example' }], prompts: [{ id: 'query', text: 'a query' }], engines: [{ engine: 'mock' }] };
  const id = cellId(engineIdentity(panel.engines[0]), 'query', targetKey(panel.targets[0]));
  await writeFile(join(dir, 'citations-epochs.jsonl'), [
    { epoch_id: 'matching', cell_id: id }, { epoch_id: 'other', cell_id: 'other-engine|query|d:other.com' },
  ].map(row => JSON.stringify(row)).join('\n'));
  const rows = await latestPanelEpoch({ dir, panel });
  assert.equal(rows[0].epoch_id, 'matching');
});

async function retainedFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'citation-privacy-'));
  const epochId = 'fixture-epoch'; const evidence = join(dir, 'citations', 'evidence', epochId);
  await mkdir(evidence, { recursive: true });
  const cell = { epoch_id: epochId, cell_id: 'mock:builtin|prompt|d:example.com', k: 0, n: 0, unknowns: 10, mentioned: 0,
    rate: null, ci_low: null, ci_high: null, classification: 'insufficient_data', spent_estimate_usd: 0.5 };
  await writeFile(join(dir, 'citations-epochs.jsonl'), JSON.stringify(cell) + '\n');
  return { dir, epochId, evidence, cell };
}
test('report escapes hostile text, omits hidden fields and marks missing screenshots/unknown data', async () => {
  const { dir, epochId, evidence, cell } = await retainedFixture();
  await writeFile(join(evidence, 'answer.json'), JSON.stringify({ epoch_id: epochId, cell_id: cell.cell_id, run_index: 0,
    answer: '<script>globalThis.reportXss=1</script>', citations: [], secret: 'PRIVATE-FIELD-MUST-NOT-LEAK', screenshot_file: '../../../../private.png' }));
  const html = await generateReport({ dir, epochId, panel: { note: '<img src=x onerror=alert(1)>' } });
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;script&gt;/); assert.ok(!html.includes('PRIVATE-FIELD-MUST-NOT-LEAK'));
  assert.ok(!html.includes('../../../../private.png')); assert.ok(!html.includes('data:image/png;base64,'));
  assert.match(html, /No screenshot retained/); assert.match(html, /Unknown: no interpretable observations/);
  assert.match(html, /default-src 'none'/); assert.ok(!html.includes('0% cited'));
});
test('report rejects epoch traversal and ignores symlinked evidence/PNG', async () => {
  const { symlink } = await import('node:fs/promises');
  const { dir, epochId, evidence, cell } = await retainedFixture();
  await assert.rejects(generateReport({ dir, epochId: '../../../private', panel: {} }), /Invalid citation epoch/);
  const secret = join(dir, 'private.json');
  await writeFile(secret, JSON.stringify({ epoch_id: epochId, cell_id: cell.cell_id, run_index: 0, answer: 'PRIVATE-SYMLINK', citations: [] }));
  await symlink(secret, join(evidence, 'linked.json'));
  await writeFile(join(evidence, 'safe.json'), JSON.stringify({ epoch_id: epochId, cell_id: cell.cell_id, run_index: 1, answer: 'safe fixture', citations: [] }));
  await symlink(secret, join(evidence, 'safe.screenshot.png'));
  const html = await generateReport({ dir, epochId, panel: {} });
  assert.ok(!html.includes('PRIVATE-SYMLINK')); assert.ok(!html.includes('data:image/png;base64,'));
});
test('report does not multiply epoch-level spend by the cell count', async () => {
  const { dir, epochId, cell } = await retainedFixture();
  await writeFile(join(dir, 'citations-epochs.jsonl'), [cell, { ...cell, cell_id: 'mock:builtin|other|d:example.com' }].map(row => JSON.stringify(row)).join('\n'));
  const html = await generateReport({ dir, epochId, panel: {} });
  assert.match(html, /estimated spend \$0\.5000/); assert.ok(!html.includes('$1.0000'));
});

test('CLI --last selects bounded requested-panel history without cross-panel evidence', async () => {
  const { citationMain } = await import('../cli/citation.js');
  const { engineIdentity, cellId, targetKey } = await import('../src/citations/contract.js');
  const dir = await mkdtemp(join(tmpdir(), 'citation-history-')); const ledger = join(dir, '.agentlinkops'); await mkdir(ledger);
  const panel = { schema_version: 1, targets: [{ scope: 'domain', domain: 'example.com', brand: 'Example' }], prompts: [{ id: 'q', text: 'question' }], engines: [{ engine: 'mock' }] };
  await writeFile(join(dir, 'panel.json'), JSON.stringify(panel));
  const id = cellId(engineIdentity(panel.engines[0]), 'q', targetKey(panel.targets[0]));
  const row = { cell_id: id, k: 0, n: 0, unknowns: 10, mentioned: 0, rate: null, ci_low: null, ci_high: null, classification: 'insufficient_data', spent_estimate_usd: 0 };
  await writeFile(join(ledger, 'citations-epochs.jsonl'), [
    { ...row, epoch_id: 'fixture-older' }, { ...row, epoch_id: 'fixture-selected-old' },
    { ...row, epoch_id: 'PRIVATE-OTHER-PANEL', cell_id: 'other|q|d:private.example' },
    { ...row, epoch_id: 'fixture-selected-new' },
  ].map(value => JSON.stringify(value)).join('\n'));
  const output = []; const err = [];
  const run = argv => citationMain(argv, { cwd: dir, out: text => output.push(text), err: text => err.push(text), env: {} });
  assert.equal(await run(['report', 'panel.json', '--last', '2', '--out', 'report.html']), 0);
  const html = await readFile(join(dir, 'report.html'), 'utf8');
  assert.match(html, /Recent epochs/); assert.match(html, /fixture-selected-old/); assert.match(html, /fixture-selected-new/);
  assert.ok(!html.includes('PRIVATE-OTHER-PANEL')); assert.ok(!html.includes('fixture-older'));
  for (const count of ['0', '31', '1.5', 'NaN']) assert.equal(await run(['report', 'panel.json', '--last', count]), 2);
  assert.equal(await run(['report', 'panel.json', '--last']), 2);
});

 test('supplemental statistics render corrected and exploratory limits without changing classification', async () => {
  const { dir, epochId, cell } = await retainedFixture();
  await writeFile(join(dir, 'citations-epochs.jsonl'), JSON.stringify({ ...cell, statistics: {
    scope: 'fixed-epoch-supplemental', confidence_sequence: { interval: [0.1, 0.9], method: 'hoeffding-alpha-spending' },
    epoch_comparison: { verdict: 'not_distinguishable' }, changepoint: { interpretation: 'exploratory' }
  } }) + '\n');
  const html = await generateReport({ dir, epochId, panel: {} });
  assert.match(html, /hoeffding-alpha-spending/);
  assert.match(html, /Corrected epoch comparison: not_distinguishable/);
  assert.match(html, /exploratory and does not establish a change date/);
  assert.match(html, /do not promise lifetime coverage/);
  assert.match(html, /Insufficient data/);
});

test('legacy smoothed rows render empirical rates and unknown zero-sample history without rewriting evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-report-legacy-'));
  const cells = [
    { epoch_id:'legacy', cell_id:'chatgpt:web-own-browser|p1|d:example.com',k:0,n:2,rate:0.25,ci_low:0,ci_high:0.66,unknowns:0,mentioned:0,classification:'insufficient_data',spent_estimate_usd:0 },
    { epoch_id:'legacy', cell_id:'chatgpt:web-own-browser|p2|d:example.com',k:0,n:0,rate:0,ci_low:0,ci_high:1,unknowns:2,mentioned:0,classification:'insufficient_data',spent_estimate_usd:0 },
  ];
  const original=cells.map(JSON.stringify).join('\n')+'\n';
  await writeFile(join(dir,'citations-epochs.jsonl'),original);
  const html=await generateReport({dir,epochId:'legacy',history:[cells,cells.map(r=>({...r,epoch_id:'older'}))]});
  assert.match(html,/0 of 2 rendered observations cited/);
  assert.match(html,/Display rates use retained citation counts/);
  assert.match(html,/unknown; n=0/);
  assert.match(html,/Unknown: no interpretable observations/);
  assert.doesNotMatch(html,/25%/);
  assert.equal(await readFile(join(dir,'citations-epochs.jsonl'),'utf8'),original);
  await writeFile(join(dir,'citations-epochs.jsonl'),JSON.stringify({...cells[0],k:3,n:2})+'\n');
  await assert.rejects(generateReport({dir,epochId:'legacy'}),/Invalid retained citation counts/);
});
