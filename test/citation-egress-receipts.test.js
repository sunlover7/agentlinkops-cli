import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { runEpoch } from '../src/citations/runner.js';
import { createEgressJournal } from '../src/citations/egress-receipts.js';
import { createMockEngine, EngineError } from '../src/citations/adapter.js';
import { createBrowserEngine } from '../src/citations/browser/engine.js';
const secret = 'fixture-private-credential';
const panel = { schema_version: 1, targets: [{ domain: 'example.com', scope: 'domain', brand: 'Acme' }], prompts: [{ id: 'p', text: 'fixture' }], engines: [{ engine: 'chatgpt', via: 'browser' }], samples: 2, maxUsd: 5 };
const temporaryDirectories = [];
after(async () => { await Promise.all(temporaryDirectories.map(dir => rm(dir, { recursive: true, force: true }))); });
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'egress-')); temporaryDirectories.push(dir); return dir; };
const receipt = (sequence, overrides = {}) => ({ version: 1, sequence, engine: secret, egress: 'proxy-required', phase: 'sample', outcome: 'observed', reason: null, leaseHash: 'a'.repeat(64), observedAt: '2026-09-20T00:00:00Z', meterState: 'unavailable', bytes: null, costMicrousd: null, password: secret, ...overrides });
function fixture({ fatal = false, cleanup = false } = {}) {
  const receipts = []; let calls = 0, closed = 0;
  return { estimateCostUsd: () => 0.03, getEgressReceipts: () => receipts, get calls() { return calls; }, get closed() { return closed; },
    async run() { calls++; receipts.push(receipt(receipts.length + 1)); if (fatal) throw Object.assign(new EngineError('Admission failed'), { code: 'PROXY_RELEASE_FAILED' }); return { engine: 'chatgpt', model: 'web', answer: 'fixture', citations: [], costEstimateUsd: 0.03 }; },
    async close() { closed++; receipts.push(receipt(receipts.length + 1, { phase: 'cleanup', outcome: cleanup ? 'cleanup_unconfirmed' : 'closed', meterState: cleanup ? 'incomplete' : 'unavailable' })); if (cleanup) throw Error(secret); },
  };
}
async function rows(dir) { const [name] = await readdir(join(dir, 'citations/egress')); return (await readFile(join(dir, 'citations/egress', name), 'utf8')).trim().split('\n').map(JSON.parse); }
const run = (dir, engine, extra = {}) => runEpoch(panel, { dir, engines: new Map([['chatgpt:web-own-browser', engine]]), ...extra });

test('runner retains bounded supplemental receipts and cleanup without changing envelope hashes or unknown meter costs', async () => {
  const dir = await temp(), engine = fixture(); const result = await run(dir, engine), journal = await rows(dir);
  assert.equal(engine.closed, 1); assert.equal(journal.filter(r => r.type === 'receipt').length, 3);
  assert.equal(JSON.stringify(journal).includes(secret), false);
  assert.ok(journal.filter(r => r.type === 'receipt').every(r => r.receipt.costMicrousd === null));
  assert.equal(journal.at(-1).outcome, 'returned'); assert.equal(journal.at(-1).evidenceComplete, true);
  assert.equal(journal[0].engines[0].identityHash, createHash('sha256').update('chatgpt:web-own-browser').digest('hex'));
  assert.deepEqual(journal.filter(row => row.phase === 'attempt').map(row => row.runIndex), [0,1]); assert.equal(journal.at(-1).totals, null);
  const root = join(dir, 'citations/evidence', result.epochId), names = await readdir(root);
  assert.equal(names.length, 2);
  for (const name of names) { const value = JSON.parse(await readFile(join(root, name), 'utf8')); assert.equal(value.egressReceipt, undefined); assert.equal(createHash('sha256').update(JSON.stringify(value)).digest('hex') + '.json', name); }
});

test('fatal admission and unconfirmed cleanup persist evidence, close once, and never store exception text', async () => {
  for (const options of [{ fatal: true }, { cleanup: true }]) {
    const dir = await temp(), engine = fixture(options);
    await assert.rejects(run(dir, engine), error => !inspect(error).includes(secret));
    const journal = await rows(dir); assert.equal(engine.closed, 1); assert.equal(journal.at(-1).outcome, 'failed');
    assert.equal(JSON.stringify(journal).includes(secret), false);
    assert.equal(journal.at(-1).cleanupUncertain, Boolean(options.cleanup));
    assert.ok(journal.some(r => r.type === 'status' && r.outcome === 'error'));
  }
});

test('real browser admission rejects missing proxy before module load and leaves durable failure status', async () => {
  const dir = await temp(); let loads = 0;
  const engine = createBrowserEngine({ engineName: 'chatgpt', env: {}, runtime: { loadModule() { loads++; throw Error('must not load'); } } });
  await assert.rejects(run(dir, engine), { code: 'PROXY_REQUIRED' }); assert.equal(loads, 0);
  const journal = await rows(dir); assert.ok(journal.some(row => row.code === 'PROXY_REQUIRED')); assert.equal(journal.at(-1).outcome, 'failed');
});

test('exclusive journal prevents repeated epoch overwrites and stops before another browser call', async () => {
  const dir = await temp(), now = new Date('2026-09-20T01:00:00Z'), first = fixture();
  await run(dir, first, { now }); const before = await rows(dir), second = fixture();
  await assert.rejects(run(dir, second, { now }), { code: 'EGRESS_JOURNAL_UNAVAILABLE' });
  assert.equal(second.calls, 0); assert.equal(second.closed, 1); assert.deepEqual(await rows(dir), before);
});

test('receipt row/byte caps, malformed secret fields, and mutable prior receipts fail closed without secrets', async () => {
  for (const variant of ['count','bytes','malformed','mutation']) {
    const dir = await temp(), records = [], engine = { getEgressReceipts: () => records };
    const journal = await createEgressJournal({ dir, epochId: 'fixture', engines: [engine], limits: { rows: variant === 'count' ? 1 : 20, bytes: variant === 'bytes' ? 250 : 10000 } });
    records.push(receipt(1));
    if (variant === 'malformed') records[0].phase = secret;
    if (variant === 'mutation') { await journal.capture(engine, { phase: 'attempt' }); records[0].bytes = 12; }
    await assert.rejects(journal.capture(engine, { phase: 'attempt' }), error => !inspect(error).includes(secret));
    await journal.close(); assert.equal(JSON.stringify(await rows(dir)).includes(secret), false);
  }
});

test('receipt retrieval failure stops further attempts but still invokes cleanup', async () => {
  const dir = await temp(), engine = fixture(); engine.getEgressReceipts = () => { if (engine.calls) throw Error(secret); return []; };
  await assert.rejects(run(dir, engine), error => error.code === 'EGRESS_RECEIPT_UNAVAILABLE' && !inspect(error).includes(secret));
  assert.equal(engine.calls, 1); assert.equal(engine.closed, 1);
  assert.equal((await rows(dir)).at(-1).outcome, 'failed'); assert.equal((await rows(dir)).at(-1).evidenceComplete, false);
});

test('mock/API engines create no egress journal and keep existing epoch shape', async () => {
  const dir = await temp(); const result = await runEpoch({ ...panel, engines: [{ engine: 'mock' }] }, { dir, engines: new Map([['mock:builtin', createMockEngine()]]) });
  assert.equal(result.cells[0].n, 2); await assert.rejects(readdir(join(dir, 'citations/egress')), { code: 'ENOENT' });
});

test('journal creation filesystem failure closes engine without making a browser request', async () => {
  const dir = await temp(); await runEpoch({ ...panel, engines: [{ engine: 'mock' }] }, { dir, engines: new Map([['mock:builtin', createMockEngine()]]) });
  await writeFile(join(dir, 'citations/egress'), 'blocked'); const engine = fixture();
  await assert.rejects(run(dir, engine), { code: 'EGRESS_JOURNAL_UNAVAILABLE' }); assert.equal(engine.calls, 0); assert.equal(engine.closed, 1);
});

test('preflight panel/locale/missing-engine and filesystem failures clean up supplied adapters once', async () => {
  for (const variant of ['panel','locale','missing','mkdir']) {
    const dir = await temp(), engine = fixture(), engines = new Map([['chatgpt:web-own-browser', engine], ['duplicate', engine]]);
    const input = variant === 'panel' ? {} : variant === 'locale' ? { ...panel, locale: 'fr-FR', country: 'FR' } : variant === 'missing' ? { ...panel, engines: [{ engine: 'perplexity' }] } : panel;
    if (variant === 'mkdir') await writeFile(join(dir, 'citations'), 'blocked');
    await assert.rejects(runEpoch(input, { dir, engines })); assert.equal(engine.calls, 0); assert.equal(engine.closed, 1);
  }
});

test('measured deltas persist only supplier values and never become a complete epoch dollar total', async () => {
  const dir = await temp(), records = [], engine = { getEgressReceipts: () => records };
  const journal = await createEgressJournal({ dir, epochId: 'fixture', engines: [engine] });
  records.push(receipt(1, { meterState: 'measured', bytes: 1234, costMicrousd: 56 }), receipt(2, { meterState: 'bytes_only', bytes: 20 }));
  await journal.capture(engine, { phase: 'attempt' }); await journal.finish({ failed: false, cleanupUncertain: false, evidenceComplete: true }); await journal.close();
  const saved = await rows(dir); assert.equal(saved[1].receipt.costMicrousd, 56); assert.equal(saved[2].receipt.costMicrousd, null); assert.equal(saved.at(-1).totals, null);
});

test('reused adapter starts at existing receipt cursor and never attributes previous epoch deltas again', async () => {
  const firstDir = await temp(), secondDir = await temp(), engine = fixture();
  await run(firstDir, engine); await run(secondDir, engine);
  const first = await rows(firstDir), second = await rows(secondDir);
  assert.deepEqual(first.filter(r => r.type === 'receipt').map(r => r.receipt.sequence), [1,2,3]);
  assert.deepEqual(second.filter(r => r.type === 'receipt').map(r => r.receipt.sequence), [4,5,6]);
  assert.equal(second[0].engines[0].firstSequence, 4);
});

test('oversized receipt history aborts the runner before another sample and still cleans up', async () => {
  const dir = await temp(), engine = fixture();
  engine.getEgressReceipts = () => engine.calls ? Array.from({ length: 10001 }, (_, i) => receipt(i + 1)) : [];
  await assert.rejects(run(dir, engine), { code: 'EGRESS_RECEIPT_LIMIT' });
  assert.equal(engine.calls, 1); assert.equal(engine.closed, 1);
  const saved = await rows(dir); assert.equal(saved.at(-1).evidenceComplete, false); assert.equal(saved.at(-1).totals, null);
});
