// CLI wiring tests for `agentlinkops citation`. Everything runs on the mock engine
// through the real command path (citationMain), in a temporary directory, at $0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { citationMain } from '../cli/citation.js';

const lines = [];
const out = (text) => lines.push(text);
const errLines = [];
const errs = (text) => errLines.push(text);
const reset = () => { lines.length = 0; errLines.length = 0; };

const panel = (fixtures, overrides = {}) => ({
  schema_version: 1,
  targets: [{ domain: 'example.com', scope: 'domain', brand: 'Acme', aliases: [] }],
  prompts: [{ id: 'p1', text: 'best optics guide' }],
  engines: [{ engine: 'mock' }],
  samples: 10,
  maxUsd: 5,
  mockFixtures: fixtures,
  ...overrides,
});

async function writePanel(cwd, doc) {
  const path = join(cwd, 'panel.json');
  await writeFile(path, JSON.stringify(doc), 'utf8');
  return 'panel.json';
}

test('citation help prints the contract vocabulary', async () => {
  reset();
  const code = await citationMain(['help'], { cwd: '/tmp', out, err: errs, env: {} });
  assert.equal(code, 0);
  assert.ok(lines.join('\n').includes('never "removed"'));
});

test('citation run: mock epoch writes ledger rows and exits 0', async () => {
  reset();
  const cwd = await mkdtemp(join(tmpdir(), 'citation-cli-'));
  const panelPath = await writePanel(cwd, panel({ 'best optics guide': { citations: [{ url: 'https://example.com/guide', weight: 1 }] } }));
  const code = await citationMain(['run', panelPath], { cwd, out, err: errs, env: {} });
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.ok(text.includes('first epoch'), text);
  assert.ok(text.includes('estimated spend'), text);
  const obs = (await readFile(join(cwd, '.agentlinkops/citations-observations.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(obs.length, 10);
});

test('citation run: a declined epoch exits 1 and says declined', async () => {
  reset();
  const cwd = await mkdtemp(join(tmpdir(), 'citation-cli-'));
  const strong = await writePanel(cwd, panel({ 'best optics guide': { citations: [{ url: 'https://example.com/guide', weight: 1 }] } }));
  assert.equal(await citationMain(['run', strong], { cwd, out, err: errs, env: {} }), 0);
  reset();
  const collapsed = await writePanel(cwd, panel({ 'best optics guide': { citations: [] } }));
  const code = await citationMain(['run', collapsed], { cwd, out, err: errs, env: {} });
  assert.equal(code, 1);
  assert.ok(lines.join('\n').includes('declined'));
  assert.ok(errLines.join('\n').includes('declined with complete evidence'));
});

test('citation run: perplexity without a credential is a usage error, never a guess', async () => {
  reset();
  const cwd = await mkdtemp(join(tmpdir(), 'citation-cli-'));
  const panelPath = await writePanel(cwd, panel({}, { engines: [{ engine: 'perplexity' }] }));
  const code = await citationMain(['run', panelPath], { cwd, out, err: errs, env: {} });
  assert.equal(code, 2);
  assert.ok(errLines.join('\n').includes('PERPLEXITY_API_KEY'));
});

test('citation run: a budget abort exits 2 and states the cap', async () => {
  reset();
  const cwd = await mkdtemp(join(tmpdir(), 'citation-cli-'));
  const panelPath = await writePanel(cwd, panel({ 'best optics guide': { citations: [] } }, { maxUsd: 0.001 }));
  const code = await citationMain(['run', panelPath], { cwd, out, err: errs, env: {} });
  assert.equal(code, 2);
  assert.ok(errLines.join('\n').includes('budget abort'));
});
