// No real crontab, email, provider calls or remote endpoints: execute the generated
// cron shell command against mock-engine evidence and a loopback receiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerWatch, listWatches, removeWatch } from '../src/citations/watch.js';

const exec = promisify(execFile);
test('unattended fixture cadence registers, runs, reports and delivers only a decline locally', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation cadence-'));
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body)); res.writeHead(202); res.end('accepted');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bin = join(dir, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'logger'), '#!/bin/sh\ncat >> "$FIXTURE_LOG"\n', { mode: 0o700 });
    const panelPath = join(dir, "fixture 'quoted% panel.json");
    const ledgerDir = join(dir, 'ledger'); const reportPath = join(dir, 'fixture-report.html');
    const panel = { schema_version: 1, note: 'FIXTURE ONLY: cadence acceptance',
      targets: [{ domain: 'example.com', scope: 'domain', brand: 'Fixture' }],
      prompts: [{ id: 'p1', text: 'fixture question' }], engines: [{ engine: 'mock' }], samples: 10, maxUsd: 1,
      mockFixtures: { 'fixture question': { citations: [{ url: 'https://example.com/fixture', weight: 1 }] } } };
    await writeFile(panelPath, JSON.stringify(panel));
    let crontab = '# unrelated entry preserved\n'; let writes = 0;
    const fakeCrontab = (command, args, callback) => {
      assert.equal(command, 'crontab');
      if (args[0] === '-l') queueMicrotask(() => callback(null, crontab, ''));
      return { stdin: { on() {}, end(input) { crontab = input; writes++; queueMicrotask(() => callback(null, '', '')); } } };
    };
    await registerWatch({ panelPath, cadence: 'hourly', dir: ledgerDir, out: reportPath,
      binary: fileURLToPath(new URL('../cli/agentlinkops.mjs', import.meta.url)), execFileImpl: fakeCrontab,
      webhook: `http://127.0.0.1:${server.address().port}/declines` });
    assert.equal(writes, 1); assert.ok(crontab.startsWith('# unrelated entry preserved'));
    assert.equal((await listWatches({ execFileImpl: fakeCrontab })).length, 1);
    const line = crontab.split('\n').find(value => value.startsWith('17 '));
    // Simulate cron's field parsing and percent unescaping; execute the exact shell command.
    const shellCommand = line.replace(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/, '').replace(/\\%/g, '%');
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FIXTURE_LOG: join(dir, 'cadence.log') };
    await exec('/bin/sh', ['-c', shellCommand], { env, timeout: 12_000 });
    assert.equal(received.length, 0, 'first epoch must not alert');
    assert.match(await readFile(reportPath, 'utf8'), /FIXTURE ONLY/);
    panel.mockFixtures = { 'fixture question': { citations: [] } };
    await writeFile(panelPath, JSON.stringify(panel));
    await exec('/bin/sh', ['-c', shellCommand], { env, timeout: 12_000 });
    assert.equal(received.length, 1, 'one decline delivered to loopback');
    assert.equal(received[0].type, 'citation.declined');
    assert.equal(received[0].cells[0].classification, 'declined');
    assert.match(received[0].report.html, /FIXTURE ONLY/);
    assert.match(received[0].report.html, /Declined/);
    assert.match(await readFile(join(dir, 'cadence.log'), 'utf8'), /citation decline report delivered/);
    await removeWatch("fixture 'quoted% panel", { execFileImpl: fakeCrontab });
    assert.equal((await listWatches({ execFileImpl: fakeCrontab })).length, 0);
    assert.equal(crontab, '# unrelated entry preserved\n');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
