// The package as a user gets it: the executables run as subprocesses from the package
// directory, with the declared dependencies and nothing from any product tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const pkg = fileURLToPath(new URL('../', import.meta.url));
const bin = name => join(pkg, 'bin', `${name}.mjs`);
const preload = join(pkg, 'test/support/route-fetch.mjs');
const FIXTURE_HOST = 'publisher-fixture.com';

// The environment a stranger has: no AgentLinkOps or Linktrail variable set.
const cleanEnv = extra => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTLINKOPS|LINKTRAIL)_/u.test(key))),
  ...extra,
});
// Node prints its own experimental warnings on stderr; they are not the CLI's output.
const cliLines = text => text.split('\n').filter(line => line && !/ExperimentalWarning|--trace-warnings/u.test(line));

async function cli(name, args, { cwd, env = {}, nodeArgs = [] } = {}) {
  const result = await exec(process.execPath, [...nodeArgs, bin(name), ...args], { cwd, env: cleanEnv(env) }).catch(error => error);
  return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: cliLines(result.stderr ?? '') };
}

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentlinkops-pkg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixtureServer(t, pages) {
  const server = http.createServer((request, response) => {
    const body = pages[request.url];
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('doctor runs in an empty directory with no token, and says what to do next', async t => {
  const dir = await workspace(t);
  const { code, stdout, stderr } = await cli('agentlinkops', ['doctor'], { cwd: dir });
  assert.equal(code, 1, 'one failed check (no ledger yet) is exit 1');
  assert.match(stdout, /^agentlinkops doctor — /u);
  assert.match(stdout, /run `agentlinkops init`/u);
  assert.match(stdout, /verifier\s+— self-test passed/u);
  assert.match(stdout, /token\s+— no token/u);
  assert.deepEqual(stderr, [], 'nothing on stderr for the canonical name with no legacy input');
});

test('the linktrail alias runs the same command with exactly one notice on stderr', async t => {
  const dir = await workspace(t);
  const { code, stdout, stderr } = await cli('linktrail', ['--help'], { cwd: dir });
  assert.equal(code, 0);
  assert.match(stdout, /backlink ledger/u);
  assert.deepEqual(stderr, ['linktrail: this command is now `agentlinkops`; the old name keeps working during the pilot compatibility window.']);
});

test('check runs the verifier against a fixture page served locally: present, then absent, with evidence', async t => {
  const dir = await workspace(t);
  const target = 'https://example.com/guide';
  const origin = await fixtureServer(t, {
    '/resources': `<html><body><p>Resources</p><a href="${target}" rel="nofollow">the guide</a></body></html>`,
    '/gone': '<html><body><p>Nothing here links anywhere.</p></body></html>',
  });
  const env = { AGENTLINKOPS_TEST_ROUTE_HOST: FIXTURE_HOST, AGENTLINKOPS_TEST_ROUTE_ORIGIN: origin };
  const nodeArgs = ['--import', preload];

  assert.equal((await cli('agentlinkops', ['init'], { cwd: dir })).code, 0);
  for (const path of ['resources', 'gone']) {
    const added = await cli('agentlinkops', ['add', '--source', `https://${FIXTURE_HOST}/${path}`, '--target', target, '--intent', 'expected'], { cwd: dir });
    assert.equal(added.code, 0, added.stderr.join('\n'));
  }
  const checked = await cli('agentlinkops', ['check', '--json'], { cwd: dir, env, nodeArgs });
  assert.equal(checked.code, 1, 'an expected link observed absent with complete evidence is exit 1');
  // --json prints one observation row per line, the same shape the mirror keeps.
  const rows = checked.stdout.trim().split('\n').map(line => JSON.parse(line));
  const byState = Object.fromEntries(rows.map(row => [row.state, row]));
  assert.ok(byState.present, `present row missing: ${checked.stdout.slice(0, 400)}`);
  assert.ok(byState.absent, `absent row missing: ${checked.stdout.slice(0, 400)}`);

  const mirror = (await readFile(join(dir, '.agentlinkops/observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(mirror.length, 2);
  for (const row of mirror) {
    assert.equal(row.source, 'local');
    assert.equal(row.complete, true);
    assert.match(row.result.evidence.sha256, /^[0-9a-f]{64}$/u, 'every observation carries a hash of the bytes');
    assert.equal(row.result.httpStatus, 200);
    assert.equal('html' in row.result, false, 'page HTML never enters the repository');
    assert.equal('html' in row.result.evidence, false);
  }
  const present = mirror.find(row => row.state === 'present');
  assert.equal(present.occurrences, 1);
  assert.deepEqual(present.result.occurrences[0].rel, ['nofollow']);
  assert.equal(mirror.find(row => row.state === 'absent').occurrences, 0);
});

test('migrate renames a .linktrail/ directory once, with a receipt, and doctor hints at it first', async t => {
  const dir = await workspace(t);
  await mkdir(join(dir, '.linktrail'));
  await writeFile(join(dir, '.linktrail/config.json'), JSON.stringify({ project: null, cloud: null, paths: {}, defaults: {} }));
  await writeFile(join(dir, '.linktrail/links.jsonl'), '');
  const before = await cli('agentlinkops', ['doctor'], { cwd: dir });
  assert.match(before.stdout, /\.linktrail/u, 'doctor names the directory actually in use');
  assert.ok(before.stderr.some(line => /run `agentlinkops migrate`/u.test(line)), before.stderr.join('\n'));

  const migrated = await cli('agentlinkops', ['migrate', '--json'], { cwd: dir });
  assert.equal(migrated.code, 0, migrated.stderr.join('\n'));
  const receipt = JSON.parse(migrated.stdout);
  assert.equal(receipt.migrated, true);
  assert.deepEqual(receipt.files, ['config.json', 'links.jsonl']);
  await assert.rejects(stat(join(dir, '.linktrail')));
  assert.ok((await stat(join(dir, '.agentlinkops/links.jsonl'))).isFile());

  const again = await cli('agentlinkops', ['migrate'], { cwd: dir });
  assert.equal(again.code, 0, 'a second run is a no-op, so setup scripts can call it unconditionally');
  assert.match(again.stdout, /nothing to migrate/u);
  const after = await cli('agentlinkops', ['doctor'], { cwd: dir });
  assert.deepEqual(after.stderr, [], 'no hint once the directory is renamed');
});

test('LINKTRAIL_* variables are read with one warning, disagreeing spellings refuse, values never print', async t => {
  const dir = await workspace(t);
  assert.equal((await cli('agentlinkops', ['init'], { cwd: dir })).code, 0);
  const secret = `lt_${'0123456789abcdef'.repeat(4)}`;
  const old = await cli('agentlinkops', ['doctor'], { cwd: dir, env: { LINKTRAIL_TOKEN: secret } });
  assert.ok(old.stderr.some(line => /LINKTRAIL_TOKEN is deprecated; set AGENTLINKOPS_TOKEN instead/u.test(line)), old.stderr.join('\n'));
  assert.equal(old.stderr.filter(line => /deprecated/u.test(line)).length, 1, `one warning per variable per process:\n${old.stderr.join('\n')}`);
  assert.match(old.stdout, /set in the environment \(LINKTRAIL_TOKEN\)/u);
  assert.equal(`${old.stdout}${old.stderr.join('\n')}`.includes(secret), false, 'the value never appears');

  const both = await cli('agentlinkops', ['doctor'], { cwd: dir, env: { LINKTRAIL_TOKEN: secret, AGENTLINKOPS_TOKEN: `${secret}x` } });
  assert.equal(both.code, 2);
  assert.ok(both.stderr.some(line => /AGENTLINKOPS_TOKEN and LINKTRAIL_TOKEN disagree/u.test(line)), both.stderr.join('\n'));
  assert.equal(`${both.stdout}${both.stderr.join('\n')}`.includes(secret), false);
});
