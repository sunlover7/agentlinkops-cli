// DP-0029-T03: the AgentLinkOps names are primary; the Linktrail names keep working for the
// pilot compatibility window. Each alias rule is exercised here at the layer that owns it —
// env.js for variables, config.js for the directory, main.js for `init` and `migrate`, and the
// executables themselves for the deprecation notice — so a later cutover (T05) can delete the
// alias and watch exactly one test fail per surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv, resolveEnv, resetCompatibilityNotices, ENV_NAMES, deprecationNotice } from '../cli/env.js';
import { loadConfig, findRoot, resolveDirName, DEFAULTS, LEGACY_DIR, setNoticeSink, migrateHint } from '../cli/config.js';
import { cloudConnection } from '../cli/connection.js';
import { main } from '../cli/main.js';
import { verifyDelivery } from '../cli/delivery.js';
import { createHmac } from 'node:crypto';

const run = promisify(execFile);
const cliDir = fileURLToPath(new URL('../cli/', import.meta.url));
const TOKEN = `lt_${'ab'.repeat(32)}`;

async function scratch(t, prefix = 'agentlinkops-compat-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const exists = path => stat(path).then(() => true, () => false);
const cli = (dir, argv) => {
  const out = [], err = [];
  return main(argv, { cwd: dir, out: line => out.push(String(line)), err: line => err.push(String(line)) })
    .then(code => ({ code, out: out.join('\n'), err: err.join('\n') }));
};

test.beforeEach(() => { resetCompatibilityNotices(); setNoticeSink(null); });

// --- environment variables -------------------------------------------------------------------

test('every variable prefers the AGENTLINKOPS_ name and reads the LINKTRAIL_ name as an alias', () => {
  for (const suffix of ENV_NAMES) {
    const warnings = [];
    const warn = message => warnings.push(message);
    assert.deepEqual(readEnv({ [`AGENTLINKOPS_${suffix}`]: 'new' }, suffix, { warn }), { value: 'new', name: `AGENTLINKOPS_${suffix}` });
    assert.deepEqual(readEnv({ [`LINKTRAIL_${suffix}`]: 'legacy-value-xyz' }, suffix, { warn }), { value: 'legacy-value-xyz', name: `LINKTRAIL_${suffix}` });
    assert.deepEqual(readEnv({}, suffix, { warn }), { value: undefined, name: null });
    // Both set to the same value: the new name is reported and nobody is warned.
    assert.deepEqual(readEnv({ [`AGENTLINKOPS_${suffix}`]: 'same', [`LINKTRAIL_${suffix}`]: 'same' }, suffix, { warn }), { value: 'same', name: `AGENTLINKOPS_${suffix}` });
    assert.deepEqual(warnings, [deprecationNotice(`LINKTRAIL_${suffix}`, `AGENTLINKOPS_${suffix}`)], `${suffix}: exactly one warning, for the old-only case`);
    assert.ok(!warnings[0].includes('legacy-value-xyz'), 'a warning never carries the value');
  }
});

test('an old name and a new name set to different values fail like TOKEN versus API_KEY, without exposing either', () => {
  setNoticeSink(() => {});
  assert.throws(() => readEnv({ AGENTLINKOPS_TOKEN: 'one-secret', LINKTRAIL_TOKEN: 'other-secret' }, 'TOKEN', { warn: () => {} }),
    error => error.name === 'ConfigError' && /AGENTLINKOPS_TOKEN and LINKTRAIL_TOKEN disagree/u.test(error.message) && !/secret/u.test(error.message));
  assert.throws(() => resolveEnv({ AGENTLINKOPS_API_URL: 'https://a.example', LINKTRAIL_API_URL: 'https://b.example' }, { warn: () => {} }),
    error => error.name === 'ConfigError' && /AGENTLINKOPS_API_URL and LINKTRAIL_API_URL disagree/u.test(error.message));
  // The pre-existing rule survives across spellings: a new-name TOKEN against an old-name API_KEY.
  assert.throws(() => cloudConnection({}, { AGENTLINKOPS_TOKEN: TOKEN, LINKTRAIL_API_KEY: `lt_${'cd'.repeat(32)}` }),
    error => error.name === 'ConfigError' && /AGENTLINKOPS_TOKEN and LINKTRAIL_API_KEY disagree/u.test(error.message) && !error.message.includes('cd'));
  assert.equal(cloudConnection({}, { AGENTLINKOPS_TOKEN: TOKEN, LINKTRAIL_API_KEY: TOKEN }).token, TOKEN, 'agreeing values across spellings are fine');
});

test('the old-name warning is printed once per process per variable, to the notice sink', () => {
  const notices = [];
  setNoticeSink(message => notices.push(message));
  const env = { LINKTRAIL_TOKEN: TOKEN, LINKTRAIL_API_URL: 'https://api.example.com' };
  cloudConnection({}, env);
  cloudConnection({}, env);
  resolveEnv(env);
  assert.deepEqual(notices, [
    deprecationNotice('LINKTRAIL_TOKEN', 'AGENTLINKOPS_TOKEN'),
    deprecationNotice('LINKTRAIL_API_URL', 'AGENTLINKOPS_API_URL'),
  ]);
  assert.ok(notices.every(line => !line.includes(TOKEN)), 'a notice never carries the value');
  const connection = cloudConnection({}, { AGENTLINKOPS_API_KEY: TOKEN, AGENTLINKOPS_API_URL: 'https://api.example.com' });
  assert.equal(connection.token, TOKEN);
  assert.equal(connection.tokenSource, 'AGENTLINKOPS_API_KEY');
  assert.equal(connection.origin, 'https://api.example.com');
  assert.equal(notices.length, 2, 'new names warn about nothing');
});

test('a signed delivery verifies under either header set', () => {
  const secret = 'fixture-secret', workspaceId = 'ws_1';
  const body = JSON.stringify({ v: 1, workspace_id: workspaceId, feed: 'events', id: 'dl_1', sequence: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  for (const prefix of ['AgentLinkOps', 'Linktrail']) {
    const headers = { [`${prefix}-Timestamp`]: timestamp, [`${prefix}-Signature`]: signature };
    assert.equal(verifyDelivery({ body, headers, secret, workspaceId }).id, 'dl_1', prefix);
  }
  assert.throws(() => verifyDelivery({ body, headers: { 'AgentLinkOps-Timestamp': timestamp, 'AgentLinkOps-Signature': 'v1=' + '0'.repeat(64) }, secret, workspaceId }), /invalid delivery signature/u);
});

// --- ledger directory ------------------------------------------------------------------------

test('the default directory is .agentlinkops/, and init creates it', async t => {
  const dir = await scratch(t);
  assert.equal(DEFAULTS.dir, '.agentlinkops');
  const result = await cli(dir, ['init']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^created .*\.agentlinkops(?:\n|$)/u);
  assert.ok(await exists(join(dir, '.agentlinkops', 'links.jsonl')));
  assert.ok(await exists(join(dir, '.agentlinkops', 'config.json')));
  assert.equal(await exists(join(dir, '.linktrail')), false);
  assert.equal(result.err, '', 'a fresh init prints no compatibility notice');
  const config = await loadConfig({ cwd: dir });
  assert.equal(config.dirName, '.agentlinkops');
  assert.equal(config.legacyDir, false);
});

test('an existing .linktrail/ is read transparently with one hint per process', async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, LEGACY_DIR, 'nested'), { recursive: true });
  await writeFile(join(dir, LEGACY_DIR, 'links.jsonl'), '');
  await writeFile(join(dir, LEGACY_DIR, 'config.json'), JSON.stringify({ project: { id: 'p_old' } }));
  const notices = [];
  setNoticeSink(message => notices.push(message));
  assert.equal(await findRoot(join(dir, LEGACY_DIR, 'nested')), dir, 'the walk-up finds the old directory name');
  const config = await loadConfig({ cwd: join(dir, LEGACY_DIR, 'nested') });
  assert.equal(config.dirName, LEGACY_DIR);
  assert.equal(config.legacyDir, true);
  assert.equal(config.dir, join(dir, LEGACY_DIR));
  assert.equal(config.project.id, 'p_old');
  assert.ok(config.paths.ledger.startsWith(join(dir, LEGACY_DIR)));
  await loadConfig({ cwd: dir });
  assert.deepEqual(notices, [migrateHint(join(dir, LEGACY_DIR))], 'hinted once for two loads');
  assert.match(notices[0], /agentlinkops migrate/u);
  // The hint reaches a command's error stream, never its stdout.
  const status = await cli(dir, ['status', '--json']);
  assert.equal(status.code, 0, status.err);
  assert.doesNotThrow(() => JSON.parse(status.out), 'stdout stayed machine-readable');
  assert.equal(await exists(join(dir, '.agentlinkops')), false, 'reading never creates the new directory');
});

test('when both directories exist the new one wins and nothing is hinted', async t => {
  const dir = await scratch(t);
  for (const name of ['.agentlinkops', LEGACY_DIR]) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'links.jsonl'), '');
    await writeFile(join(dir, name, 'config.json'), JSON.stringify({ project: { id: name } }));
  }
  const notices = [];
  setNoticeSink(message => notices.push(message));
  const config = await loadConfig({ cwd: dir });
  assert.equal(config.dirName, '.agentlinkops');
  assert.equal(config.project.id, '.agentlinkops');
  assert.deepEqual(notices, []);
  assert.deepEqual(await resolveDirName(dir), { name: '.agentlinkops', legacy: false, exists: true });
});

test('init beside an existing .linktrail/ refuses and points at migrate rather than shadowing the ledger', async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, LEGACY_DIR));
  await writeFile(join(dir, LEGACY_DIR, 'links.jsonl'), '{"id":"lk_keepme01","intent":"wanted","source":"https://a.example/","target":"https://b.example/"}\n');
  const result = await cli(dir, ['init']);
  assert.equal(result.code, 2);
  assert.match(result.err, /already exists; run `agentlinkops migrate`/u);
  assert.equal(await exists(join(dir, '.agentlinkops')), false);
  assert.equal(await readFile(join(dir, LEGACY_DIR, 'links.jsonl'), 'utf8'), '{"id":"lk_keepme01","intent":"wanted","source":"https://a.example/","target":"https://b.example/"}\n', 'the old ledger is untouched');
});

// --- migrate ---------------------------------------------------------------------------------

test('migrate renames .linktrail/ to .agentlinkops/ with a receipt, and afterwards nothing is hinted', async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, LEGACY_DIR, 'context'), { recursive: true });
  const ledger = '{"id":"lk_moved001","intent":"expected","source":"https://a.example/","target":"https://b.example/"}\n';
  await writeFile(join(dir, LEGACY_DIR, 'links.jsonl'), ledger);
  await writeFile(join(dir, LEGACY_DIR, 'config.json'), JSON.stringify({ project: { id: 'p_1' } }));
  await writeFile(join(dir, LEGACY_DIR, 'state.json'), '{"v":1,"entries":{}}\n');
  await writeFile(join(dir, LEGACY_DIR, 'context', 'manual.md'), '# manual\n');
  const nested = join(dir, 'src', 'deep');
  await mkdir(nested, { recursive: true });

  const result = await cli(nested, ['migrate', '--json']);
  assert.equal(result.code, 0, result.err);
  const receipt = JSON.parse(result.out);
  assert.equal(receipt.migrated, true);
  assert.equal(receipt.from, join(dir, LEGACY_DIR));
  assert.equal(receipt.to, join(dir, '.agentlinkops'));
  assert.deepEqual(receipt.files, ['config.json', 'context', 'context/manual.md', 'links.jsonl', 'state.json']);
  assert.match(receipt.at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(await exists(join(dir, LEGACY_DIR)), false, 'the old directory is gone because it was renamed, not copied');
  assert.equal(await readFile(join(dir, '.agentlinkops', 'links.jsonl'), 'utf8'), ledger);
  assert.equal(await readFile(join(dir, '.agentlinkops', 'context', 'manual.md'), 'utf8'), '# manual\n');
  assert.deepEqual((await readdir(join(dir, '.agentlinkops'))).sort(), ['config.json', 'context', 'links.jsonl', 'state.json']);

  const notices = [];
  setNoticeSink(message => notices.push(message));
  const config = await loadConfig({ cwd: nested });
  assert.equal(config.dirName, '.agentlinkops');
  assert.deepEqual(notices, []);

  // Running it again is a no-op with exit 0, so a setup script can call it unconditionally.
  const again = await cli(dir, ['migrate']);
  assert.equal(again.code, 0);
  assert.match(again.out, /nothing to migrate/u);
});

test('migrate prints a human receipt without --json', async t => {
  const dir = await scratch(t);
  await mkdir(join(dir, LEGACY_DIR));
  await writeFile(join(dir, LEGACY_DIR, 'links.jsonl'), '');
  const result = await cli(dir, ['migrate']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^moved .*\.linktrail -> .*\.agentlinkops \(1 file; nothing merged or deleted\)/u);
  assert.match(result.out, /links\.jsonl/u);
  assert.match(result.out, /\.gitignore/u, 'the receipt tells the operator what else names the directory');
});

test('migrate refuses when .agentlinkops/ already exists, when nothing exists, and when a sync holds the lock', async t => {
  const both = await scratch(t);
  for (const name of ['.agentlinkops', LEGACY_DIR]) { await mkdir(join(both, name)); await writeFile(join(both, name, 'links.jsonl'), `${name}\n`); }
  let result = await cli(both, ['migrate']);
  assert.equal(result.code, 2);
  assert.match(result.err, /already exists; nothing was moved/u);
  assert.equal(await readFile(join(both, LEGACY_DIR, 'links.jsonl'), 'utf8'), `${LEGACY_DIR}\n`, 'never merges');
  assert.equal(await readFile(join(both, '.agentlinkops', 'links.jsonl'), 'utf8'), '.agentlinkops\n', 'never overwrites');

  const empty = await scratch(t);
  result = await cli(empty, ['migrate']);
  assert.equal(result.code, 2);
  assert.match(result.err, /no \.linktrail\/ directory found/u);
  assert.equal(await exists(join(empty, '.agentlinkops')), false);

  const locked = await scratch(t);
  await mkdir(join(locked, LEGACY_DIR));
  await writeFile(join(locked, LEGACY_DIR, 'links.jsonl'), '');
  await writeFile(join(locked, LEGACY_DIR, 'sync.lock'), '');
  result = await cli(locked, ['migrate']);
  assert.equal(result.code, 2);
  assert.match(result.err, /locked by a running sync/u);
  assert.ok(await exists(join(locked, LEGACY_DIR, 'links.jsonl')));

  result = await cli(locked, ['migrate', '--force']);
  assert.equal(result.code, 2, 'migrate takes no flags besides --json');
});

// --- executables -----------------------------------------------------------------------------

test('agentlinkops is the executable and linktrail is an alias that prints exactly one notice to stderr', async () => {
  const primary = await run(process.execPath, [join(cliDir, 'agentlinkops.mjs'), '--help']);
  assert.match(primary.stdout, /^agentlinkops — a backlink ledger/u);
  assert.match(primary.stdout, /agentlinkops migrate/u);
  assert.equal(primary.stdout.includes('linktrail init'), false, 'usage examples name the new executable');
  assert.equal(primary.stderr.split('\n').filter(line => /linktrail/u.test(line)).length, 0, 'the primary entry prints no deprecation notice');

  const alias = await run(process.execPath, [join(cliDir, 'linktrail.mjs'), '--help']);
  assert.equal(alias.stdout, primary.stdout, 'the alias delegates to the same command');
  const notices = alias.stderr.split('\n').filter(line => /this command is now `agentlinkops`/u.test(line));
  assert.equal(notices.length, 1, `expected one notice, saw:\n${alias.stderr}`);
});

test('both executables run doctor in an empty directory with no token and name the new commands', async t => {
  const dir = await scratch(t);
  for (const entry of ['agentlinkops.mjs', 'linktrail.mjs']) {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const result = await run(process.execPath, [join(cliDir, entry), 'doctor'], { cwd: dir, env }).catch(error => error);
    assert.equal(result.code, 1, `${entry}: doctor fails on a directory with no ledger`);
    assert.match(result.stdout, /agentlinkops doctor — .*\.agentlinkops/u);
    assert.match(result.stdout, /fix\s+— run `agentlinkops init`/u);
    assert.match(result.stdout, /skip\s+token\s+— no token \(and no cloud configured\)/u);
    assert.equal(result.stdout.includes('LINKTRAIL'), false);
  }
});
