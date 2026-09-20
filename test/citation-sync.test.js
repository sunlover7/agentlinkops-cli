import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncEpochs } from '../src/citations/sync.js';
test('sync preserves unknown null rates and batches all rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-sync-'));
  try {
    const rows = Array.from({ length: 101 }, (_, i) => ({ epoch_id: 'epoch', cell_id: `cell${i}`, k: 0, n: 0, rate: null, ci_low: null, ci_high: null, classification: 'insufficient_data' }));
    await writeFile(join(dir, 'citations-epochs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    const batches = [];
    const result = await syncEpochs({ dir, workspaceId: 'w', projectId: 'p', api: async (_, init) => { assert.deepEqual(Object.keys(init.body).sort(), ['epochs', 'projectId']); batches.push(init.body.epochs); } });
    assert.deepEqual(result, { synced: 101, errors: 0, total: 101 });
    assert.deepEqual(batches.map(b => b.length), [100, 1]);
    assert.equal(batches[0][0].rate, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('malformed local evidence prevents sync rather than silently dropping rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-sync-'));
  try {
    await writeFile(join(dir, 'citations-epochs.jsonl'), '{bad json');
    await assert.rejects(syncEpochs({ dir, workspaceId: 'w', projectId: 'p', api: async () => assert.fail('must not send') }), SyntaxError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { mkdir, readFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syncEvidence } from '../src/citations/sync.js';
import { evidenceEnvelopeSchema } from '../src/citations/contract.js';
async function evidenceFixture(count = 6, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'citation-evidence-sync-'));
  const epoch = 'fixture-epoch'; await mkdir(join(dir, 'citations/evidence', epoch), { recursive: true });
  const rows = [];
  for (let i = 0; i < count; i++) {
    const identity = options.engine ?? 'mock:builtin';
    const envelope = { schema_version: 1, epoch_id: epoch, cell_id: `${identity}|q|d:example.com`, run_index: i,
      prompt: 'Fixture prompt', engine_identity: identity, provider_model_version: 'mock:1',
      answer: options.answer ?? 'Fixture answer', citations: [], fan_out: [], usage: { input_tokens: 0, output_tokens: 0 },
      cost_estimate_usd: 0, at: new Date().toISOString() };
    const digest = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
    envelope.screenshot_file = `${digest}.screenshot.png`;
    await writeFile(join(dir, 'citations/evidence', epoch, digest + '.json'), JSON.stringify(evidenceEnvelopeSchema.parse(envelope), null, 2));
    rows.push({ epoch_id: epoch, cell_id: envelope.cell_id, run_index: i, evidence_sha256: digest });
  }
  await writeFile(join(dir, 'citations-observations.jsonl'), rows.map(JSON.stringify).join('\n'));
  return { dir, rows, path: join(dir, 'citations/evidence', epoch, rows[0].evidence_sha256 + '.json') };
}
test('evidence sync preserves exact bytes and SHA, batches five, never uploads pixels', async () => {
  const fixture = await evidenceFixture(); const batches = [];
  try {
    const result = await syncEvidence({ dir: fixture.dir, projectId: 'p', cliVersion: '0.6.2', api: async (_, init) => batches.push(init.body) });
    assert.deepEqual(batches.map(batch => batch.records.length), [5, 1]); assert.equal(result.synced, 6);
    const record = batches[0].records[0]; const text = await readFile(fixture.path, 'utf8');
    assert.equal(record.envelopeJson, text); assert.equal(record.sha256, createHash('sha256').update(text).digest('hex'));
    assert.notEqual(record.sha256, record.localEvidenceSha256); assert.deepEqual(record.screenshot, { reference: `${fixture.rows[0].evidence_sha256}.screenshot.png`, sha256: null });
    assert.ok(!JSON.stringify(batches).includes('base64'));
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
test('evidence sync rejects malformed identity and escaping symlinks before sending', async () => {
  const fixture = await evidenceFixture(1); let sends = 0;
  const run = () => syncEvidence({ dir: fixture.dir, projectId: 'p', cliVersion: '0.6.2', api: async () => sends++ });
  try {
    const text = await readFile(fixture.path, 'utf8');
    await writeFile(fixture.path, text.replace('"run_index": 0', '"run_index": 9'));
    await assert.rejects(run(), /identity/);
    await rm(fixture.path); await symlink('/etc/hosts', fixture.path);
    await assert.rejects(run(), /regular ledger file/); assert.equal(sends, 0);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
test('missing or unproven legacy AIO evidence produces explicit partial reasons', async () => {
  const fixture = await evidenceFixture(2, {engine:'google-aio:api'});
  try {
    await rm(fixture.path);
    const result = await syncEvidence({ dir: fixture.dir, projectId: 'p', cliVersion: '0.6.2', api: async () => assert.fail('must not send') });
    assert.equal(result.skipped, 2); assert.deepEqual(result.reasons, { missing_envelope: 1, legacy_aio_without_provenance: 1 });
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});
test('evidence batching respects encoded request bytes and preflights the full selection', async () => {
  const fixture = await evidenceFixture(5, {answer:'x'.repeat(48000)}); const batches = [];
  try {
    const run = () => syncEvidence({ dir: fixture.dir, projectId: 'p', cliVersion: '0.6.2', api: async (_, init) => batches.push(init.body) });
    await run(); assert.deepEqual(batches.map(batch => batch.records.length), [4, 1]);
    assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 196608));
    batches.length = 0;
    await writeFile(join(fixture.dir, 'citations/evidence/fixture-epoch', fixture.rows[4].evidence_sha256 + '.json'), '{bad');
    await assert.rejects(run(), SyntaxError); assert.equal(batches.length, 0);
  } finally { await rm(fixture.dir, { recursive: true, force: true }); }
});

test('legacy smoothed rates are explicitly projected without rewriting evidence', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'citation-legacy-'));
 try {
 const text = JSON.stringify({ epoch_id:'legacy',cell_id:'cell',k:0,n:1,rate:1/3,ci_low:0,ci_high:.79 });
 await writeFile(join(dir,'citations-epochs.jsonl'),text);
 const result = await syncEpochs({dir,workspaceId:'w',projectId:'p',api:async(_,init)=> {assert.deepEqual(Object.keys(init.body).sort(),['epochs','projectId']);assert.equal(init.body.epochs[0].rate,0);}});
 assert.equal(result.normalized_rates,1); assert.match(result.normalization,/unchanged/);
 assert.equal(await readFile(join(dir,'citations-epochs.jsonl'),'utf8'),text);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('evidence sync rejects changed answer, citations and screenshot binding before any upload', async () => {
  const fixture = await evidenceFixture(6); let sends = 0;
  const path = join(fixture.dir, 'citations/evidence/fixture-epoch', fixture.rows[5].evidence_sha256 + '.json');
  try {
    const original = await readFile(path, 'utf8');
    for (const mutation of [
      value => { value.answer = 'Changed answer'; },
      value => { value.unverified_extra = 'fixture-private-sentinel'; },
      value => { value.usage.unverified_extra = 'fixture-private-sentinel'; },
      value => { value.citations = [{url:'https://example.com/changed'}]; },
      value => { value.screenshot_file = `${'a'.repeat(64)}.screenshot.png`; },
    ]) {
      const envelope = JSON.parse(original); mutation(envelope);
      await writeFile(path, JSON.stringify(envelope));
      await assert.rejects(syncEvidence({dir:fixture.dir,projectId:'p',cliVersion:'0.6.6',api:async()=>sends++}), /digest/);
      assert.equal(sends, 0, 'full selection must validate before first batch');
    }
  } finally { await rm(fixture.dir, {recursive:true,force:true}); }
});

test('conflicting duplicate envelope references reject the complete selection before upload', async () => {
  const fixture = await evidenceFixture(1); let sends = 0;
  try {
    const rows = [fixture.rows[0], {...fixture.rows[0],run_index:99}];
    await writeFile(join(fixture.dir,'citations-observations.jsonl'),rows.map(JSON.stringify).join('\n'));
    await assert.rejects(syncEvidence({dir:fixture.dir,projectId:'p',cliVersion:'0.6.6',api:async()=>sends++}), /Conflicting/);
    assert.equal(sends,0);
  } finally {await rm(fixture.dir,{recursive:true,force:true});}
});
