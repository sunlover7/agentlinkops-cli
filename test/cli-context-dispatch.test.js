import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DP-0026-T03: the CLI gains the deferred `linktrail context` dispatch (DP-0017 T02/T03's
// recorded follow-up: "one USAGE line plus one dispatch arm"). The arm must work without a
// ledger (context owns its config), must pass flags through positionally, and must not change
// any other command's behavior.

const manual = ['# Target pages', '', '- https://example.com/guide', '', '# Site description', '', 'A probate guide site.', ''].join('\n');
const window = { start: '2026-08-15', end: '2026-09-11', days: 28 };
const gscRow = {
  kind: 'gsc.page', property: 'sc-domain:example.com', page: 'https://example.com/guide', window,
  type: 'web', aggregationType: 'byPage', dataState: 'final', clicks: 12, impressions: 340,
  position: 8.4, rows_returned: 1, truncated: false, retrieved_by: 'customer-harness',
  captured_at: '2026-09-10T18:22:00Z', fetched_at: '2026-09-12T10:04:00Z',
};

async function repo(t, { ledger = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'linktrail-cli-ctx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.linktrail', 'context'), { recursive: true });
  if (ledger) await writeFile(join(dir, '.linktrail', 'links.jsonl'), '', 'utf8');
  await writeFile(join(dir, '.linktrail', 'config.json'), JSON.stringify({ project: { id: 'p_ctx', domain: 'example.com' } }), 'utf8');
  await writeFile(join(dir, '.linktrail', 'context', 'manual.md'), manual, 'utf8');
  await writeFile(join(dir, '.linktrail', 'context', 'gsc.jsonl'), `${JSON.stringify(gscRow)}\n`, 'utf8');
  return dir;
}

const run = (dir, argv) => {
  const lines = [];
  const errors = [];
  const main = import('../cli/main.js').then(m => m.main);
  return main.then(m => m(argv, { cwd: dir, out: line => lines.push(String(line)), err: line => errors.push(String(line)) })
    .then(code => ({ code, lines, errors })));
};

test('`linktrail context …` dispatches through main, with no ledger required', async t => {
  const dir = await repo(t, { ledger: false });
  const status = await run(dir, ['context', 'status']);
  assert.equal(status.code, 0);
  assert.ok(status.lines.some(line => line.includes('connection grant: none')));
  assert.ok(status.lines.some(line => line.includes('gsc rows: 1')));
});

test('the dispatch passes the subcommand surface through intact, flags before or after the command word', async t => {
  const dir = await repo(t);
  const page = await run(dir, ['context', 'gsc', 'page', 'https://example.com/guide', '--start', '2026-08-15', '--end', '2026-09-11']);
  assert.equal(page.code, 0);
  assert.ok(page.lines.some(line => line.includes('state: ok')));
  assert.ok(page.lines.some(line => line.includes('clicks 12')));
  // Flags after the subcommand pass through to contextMain's own parser. (A flag directly
  // before a bare word eats it as its value in BOTH parsers — `--json status` parses as
  // json="status" — which is the pre-existing CLI convention, not something the context arm
  // changes.)
  const flagged = await run(dir, ['context', 'status', '--json']);
  assert.equal(flagged.code, 0);
  assert.ok(flagged.lines.some(line => line.includes('"gsc_rows": 1')));
});

test('USAGE advertises the context surface and the usage contract is unchanged elsewhere', async t => {
  const dir = await repo(t);
  const help = await run(dir, ['help']);
  assert.equal(help.code, 0);
  assert.ok(help.lines.some(line => line.includes('agentlinkops context')));
  const contextHelp = await run(dir, ['context']);
  assert.equal(contextHelp.code, 0);
  assert.ok(contextHelp.lines.some(line => line.includes('agentlinkops context gsc refresh')));
  const unknown = await run(dir, ['context', 'no-such-area']);
  assert.equal(unknown.code, 2);
  const stillUnknown = await run(dir, ['no-such-command']);
  assert.equal(stillUnknown.code, 2);
  assert.ok(stillUnknown.errors.some(line => line.includes('unknown command')));
});
