import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Experimental module mocks replace advisory acquisition only; filesystem
// markers remain active. Without that flag, use the packaged native binding.
if (typeof mock.module === 'function') mock.module('../cli/native-lock.js', {namedExports: {nativeLock: async () => ({acquire: () => true})}});
const {doctorMain} = await import('../cli/doctor.js');
const {acquireSyncLock} = await import('../cli/sync-lock.js');
const {writeState} = await import('../cli/state.js');
const {main} = await import('../cli/main.js');

async function ledger(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'alo-doctor-writer-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const dir = join(cwd, '.agentlinkops'); await mkdir(dir, {mode: 0o700});
  await writeFile(join(dir, 'links.jsonl'), JSON.stringify({id: 'lk_sameid01', intent: 'expected', source: 'https://publisher.example/a', target: 'https://customer.example/b'}) + '\n');
  await writeFile(join(dir, 'config.json'), JSON.stringify({cloud: {origin: 'https://api.example'}}));
  const statePath = join(dir, 'state.json');
  const before = {v: 2, entries: {}, watches: {lk_sameid01: 'old'}, cursors: {events: 'old-source', target_events: 'old-target'}, custom: {site: cwd}};
  await writeState(statePath, before);
  return {cwd, dir, statePath, before};
}
const response = () => Response.json({status: 'ok'});
const run = (f, fetchImpl, lines) => doctorMain([], {cwd: f.cwd, env: {}, fetchImpl, out: s => lines.push(s), err: s => lines.push(s)});

test('doctor probing while a writer commits retains new cursors, maps and unknown fields across nine ledgers', async t => {
  await Promise.all(Array.from({length: 9}, async () => {
    const f = await ledger(t), lines = [];
    let releaseProbe, enteredProbe;
    const entered = new Promise(r => { enteredProbe = r; });
    const held = new Promise(r => { releaseProbe = r; });
    const pending = run(f, async () => { enteredProbe(); await held; return response(); }, lines);
    await entered;
    const newer = {...f.before, watches: {lk_sameid01: 'new'}, entries: {lk_sameid01: {checkedAt: '2026-09-30T12:00:00Z'}}, cursors: {events: 'new-source', target_events: 'new-target'}, extra: {preserve: 17}};
    const lock = await acquireSyncLock(f.dir, 'sync');
    try { await writeState(f.statePath, newer); } finally { await lock.release(); }
    releaseProbe();
    // No credential is supplied: the expected token diagnostic fails independently
    // of whether the anonymous probe is safely recorded.
    assert.equal(await pending, 1, lines.join('\n'));
    const saved = JSON.parse(await readFile(f.statePath, 'utf8'));
    assert.ok(saved.doctor?.cloud?.ok);
    const {doctor, ...rest} = saved;
    assert.deepEqual(rest, {...newer, gaps: [], upgraded_from: null});
    assert.ok(lines.some(s => s.includes('recorded in state.json')));
  }));
});

test('a live writer prevents doctor persistence and remains owned until released', async t => {
  const f = await ledger(t), lines = [], bytes = await readFile(f.statePath, 'utf8');
  const lock = await acquireSyncLock(f.dir, 'sync');
  try {
    const marker = await readFile(lock.path, 'utf8');
    await run(f, async () => response(), lines);
    assert.equal(await readFile(f.statePath, 'utf8'), bytes);
    assert.equal(await readFile(lock.path, 'utf8'), marker);
    assert.ok(lines.some(s => s.includes('NOT recorded')));
  } finally { await lock.release(); }
});

test('an unknown legacy marker prevents doctor persistence without deleting it', async t => {
  const f = await ledger(t), lines = [], bytes = await readFile(f.statePath, 'utf8');
  const marker = join(f.dir, 'sync.lock'); await writeFile(marker, '', {mode: 0o600});
  await run(f, async () => response(), lines);
  assert.equal(await readFile(f.statePath, 'utf8'), bytes);
  assert.equal(await readFile(marker, 'utf8'), '');
  assert.ok(lines.some(s => s.includes('NOT recorded')));
});

test('reverse ordering: actual sync retains the already committed doctor record and unknown state', async t => {
  const f = await ledger(t), lines = [];
  await run(f, async () => response(), lines);
  const diagnosed = JSON.parse(await readFile(f.statePath, 'utf8'));
  await writeFile(join(f.dir, 'config.json'), JSON.stringify({project: {id: 'pr_reverse'}, cloud: {origin: 'https://api.example', token: 'fixture'}}));
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET');
    const u = new URL(url); assert.equal(u.searchParams.get('projectId'), 'pr_reverse');
    return u.pathname.includes('events') ? Response.json({events: [], next_cursor: u.pathname === '/v1/events' ? 'new-source' : 'new-target', has_more: false})
      : Response.json({items: [], next_cursor: null});
  };
  assert.equal(await main(['sync', '--pull-only'], {cwd: f.cwd, env: {}, fetchImpl, out: () => {}, err: assert.fail}), 0);
  const synced = JSON.parse(await readFile(f.statePath, 'utf8'));
  assert.deepEqual(synced.doctor, diagnosed.doctor);
  assert.deepEqual(synced.custom, diagnosed.custom);
  assert.deepEqual(synced.cursors, {events: 'new-source', target_events: 'new-target'});
});
