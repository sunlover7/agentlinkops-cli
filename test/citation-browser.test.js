// Browser-engine wiring tests. No browser launches here: the runner path is
// proven with a fake engine that returns a screenshot buffer, and the
// identity/schema surface is contract-checked. The live browser flow proves
// itself on the VPS with real surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { engineIdentity, citationPanelSchema, evidenceEnvelopeSchema } from '../src/citations/contract.js';
import { runEpoch } from '../src/citations/runner.js';

test('engine identities name the surface and never average across it', () => {
  assert.equal(engineIdentity({ engine: 'chatgpt', via: 'browser' }), 'chatgpt:web-own-browser');
  assert.equal(engineIdentity({ engine: 'perplexity', via: 'api' }), 'perplexity:api');
  assert.equal(engineIdentity({ engine: 'perplexity', via: 'api', model: 'sonar' }), 'perplexity:api:sonar');
  assert.equal(engineIdentity({ engine: 'mock', via: 'api' }), 'mock:builtin');
});

test('panels accept browser engine specs and default via to api', () => {
  const panel = citationPanelSchema.parse({
    schema_version: 1,
    targets: [{ domain: 'example.com', scope: 'domain', brand: 'Acme', aliases: [] }],
    prompts: [{ id: 'p1', text: 'best optics guide' }],
    engines: [{ engine: 'chatgpt', via: 'browser' }, { engine: 'perplexity' }],
    samples: 5, maxUsd: 2,
  });
  assert.equal(panel.engines[0].via, 'browser');
  assert.equal(panel.engines[1].via, 'api');
});

test('evidence envelope carries an optional screenshot_file', () => {
  const env = evidenceEnvelopeSchema.parse({
    schema_version: 1, epoch_id: 'e', cell_id: 'c', run_index: 0, prompt: 'p',
    engine_identity: 'chatgpt:web-own-browser', provider_model_version: 'chatgpt-web',
    answer: 'a', citations: [], fan_out: [], usage: { input_tokens: 0, output_tokens: 0 },
    cost_estimate_usd: 0.004, at: '2026-09-17T00:00:00Z', screenshot_file: 'x.screenshot.png',
  });
  assert.equal(env.screenshot_file, 'x.screenshot.png');
});

test('runner persists a screenshot sibling for browser-engine runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-browser-'));
  const fakeBrowserEngine = {
    identity: { engine: 'chatgpt', provider: 'web-own-browser', model: 'chatgpt' },
    estimateCostUsd: () => 0.004,
    closed: false,
    async run({ prompt }) {
      return {
        engine: 'chatgpt', provider: 'web-own-browser', model: 'chatgpt',
        providerModelVersion: 'chatgpt-web',
        browserContext: { surface: 'web', authentication: 'anonymous', account_tier: 'unknown' },
        answer: `Acme answer to: ${prompt}`,
        citations: [{ url: 'https://example.com/guide', title: 'Acme Guide' }],
        fanOut: [], usage: { input_tokens: 0, output_tokens: 0 },
        costEstimateUsd: 0.004,
        screenshotPng: Buffer.from('89504e470d0a1a0a-fake-png-bytes', 'latin1'),
      };
    },
    async close() { this.closed = true; },
  };
  const identity = engineIdentity({ engine: 'chatgpt', via: 'browser' });
  const result = await runEpoch({
    schema_version: 1,
    targets: [{ domain: 'example.com', scope: 'domain', brand: 'Acme', aliases: [] }],
    prompts: [{ id: 'p1', text: 'best optics guide' }],
    engines: [{ engine: 'chatgpt', via: 'browser' }],
    samples: 3, maxUsd: 5,
  }, { dir, engines: new Map([[identity, fakeBrowserEngine]]), now: new Date('2026-09-17T01:00:00Z') });

  assert.equal(result.aborted, null);
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].k, 3, 'all three runs cited');
  assert.ok(fakeBrowserEngine.closed, 'engine cleanup ran');
  assert.equal(result.spentEstimateUsd, 0.012);

  const evidenceFiles = await readdir(join(dir, 'citations/evidence', result.epochId));
  const shots = evidenceFiles.filter((f) => f.endsWith('.screenshot.png'));
  const jsons = evidenceFiles.filter((f) => f.endsWith('.json'));
  assert.equal(jsons.length, 3);
  assert.equal(shots.length, 3, 'every observation kept its pixels');
  for (const j of jsons) {
    const env = JSON.parse(await readFile(join(dir, 'citations/evidence', result.epochId, j), 'utf8'));
    assert.equal(env.screenshot_file, `${j.replace('.json', '')}.screenshot.png`);
    assert.ok(env.engine_identity.startsWith('chatgpt:web-own-browser'));
    assert.deepEqual(env.browser_context, { surface: 'web', authentication: 'anonymous', account_tier: 'unknown' });
  }
  const shotBytes = await readFile(join(dir, 'citations/evidence', result.epochId, shots[0]));
  assert.equal(shotBytes.toString('latin1').includes('fake-png-bytes'), true);
});
