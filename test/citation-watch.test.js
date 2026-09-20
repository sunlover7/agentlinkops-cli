import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAlert } from '../src/citations/alert.js';

test('shouldAlert: fires only on declined classification', () => {
  assert.ok(shouldAlert([{ classification: 'declined' }]));
  assert.ok(!shouldAlert([{ classification: 'insufficient_data' }]));
  assert.ok(!shouldAlert([{ classification: 'first_epoch' }]));
  assert.ok(!shouldAlert([{ classification: 'not_distinguishable' }]));
  assert.ok(!shouldAlert([{ classification: 'grown' }]));
  assert.ok(!shouldAlert([]));
});

test('shouldAlert: mixed cells — any declined fires', () => {
  assert.ok(shouldAlert([
    { classification: 'first_epoch' },
    { classification: 'declined' },
    { classification: 'not_distinguishable' },
  ]));
});

import { registerWatch, removeWatch } from '../src/citations/watch.js';
import { sendAlertEmail } from '../src/citations/alert.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function cronFake(existing, failure) {
  const state = { writes: [] };
  state.exec = (bin, args, callback) => {
    assert.equal(bin, 'crontab');
    if (args[0] === '-l') queueMicrotask(() => callback(failure, existing, failure ? 'permission denied' : ''));
    return { stdin: { on() {}, end(value) { state.writes.push(value); queueMicrotask(() => callback(null, '', '')); } } };
  };
  return state;
}
test('watch writes stdin, quotes shell paths and preserves unrelated entries', async () => {
  const fake = cronFake('0 0 * * * keep-this\n');
  await registerWatch({ panelPath: "/tmp/a 'quote% $(bad).json", binary: '/tmp/my bin.js', execFileImpl: fake.exec });
  assert.equal(fake.writes.length, 1);
  assert.ok(fake.writes[0].startsWith('0 0 * * * keep-this\n'));
  assert.ok(fake.writes[0].includes("'\\''"));
  assert.ok(fake.writes[0].includes('\\%'));
  assert.ok(fake.writes[0].includes('status=$?; if [ "$status" -le 1 ]'));
});
test('crontab read failure prevents destructive replacement', async () => {
  const fake = cronFake('', Object.assign(new Error('permission denied'), { code: 1 }));
  await assert.rejects(removeWatch('panel', { execFileImpl: fake.exec }), /read crontab/);
  assert.equal(fake.writes.length, 0);
});
test('watch removal matches exact marker, preserving names with shared prefixes', async () => {
  const fake = cronFake('a # agentlinkops:citation-watch:panel\nb # agentlinkops:citation-watch:panel-long\n');
  await removeWatch('panel', { execFileImpl: fake.exec });
  assert.equal(fake.writes[0], 'b # agentlinkops:citation-watch:panel-long\n');
});
test('SMTP secret travels over stdin and never appears in thrown error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'citation-alert-'));
  try {
    const htmlPath = join(dir, 'report.html'); await writeFile(htmlPath, '<p>Decline</p>');
    let input;
    await assert.rejects(sendAlertEmail({ to: 'test@example.com', htmlPath, smtp: { host: 'localhost', user: 'test', pass: 'private-smtp-value' },
      execFileImpl: (bin, args, callback) => {
        assert.ok(!args.join(' ').includes('private-smtp-value'));
        return { stdin: { on() {}, end(value) { input = JSON.parse(value); queueMicrotask(() => callback(new Error('private-smtp-value'))); } } };
      },
    }), error => error.message === 'smtp send failed');
    assert.equal(input.pass, 'private-smtp-value');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('webhook rejects remote cleartext and URL credentials before any transport', async () => {
  const { validateAlertWebhook } = await import('../src/citations/alert.js');
  for (const endpoint of ['http://example.com/report', 'https://user:password@example.com/report']) {
    assert.throws(() => validateAlertWebhook(endpoint), /requires HTTPS/);
  }
  assert.equal(validateAlertWebhook('http://127.0.0.1:8080/fixture').hostname, '127.0.0.1');
});
test('webhook sends nothing for unknown or first-epoch cells', async () => {
  const { sendAlertWebhook } = await import('../src/citations/alert.js');
  const result = await sendAlertWebhook({ endpoint: 'http://127.0.0.1/fixture', cells: [{ classification: 'insufficient_data' }],
    fetchImpl: async () => assert.fail('unknown evidence must not deliver') });
  assert.equal(result.delivered, false);
});
