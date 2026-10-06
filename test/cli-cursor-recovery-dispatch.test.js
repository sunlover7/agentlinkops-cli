import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// With experimental module mocks, only advisory acquisition is doubled.
// The ordinary packaged test command exercises the actual native binding.
if (typeof mock.module === 'function') mock.module('../cli/native-lock.js', {namedExports: {nativeLock: async () => ({acquire: () => true})}});
const {main} = await import('../cli/main.js');
const localId = 'lk_aaaaaaaa';

async function fixture(t, site) {
  const cwd = await mkdtemp(join(tmpdir(), `alo-cursor-${site}-`));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const dir = join(cwd, '.agentlinkops'); await mkdir(dir, {mode: 0o700});
  const project = `pr_${site}`, watch = `wat_${site}`, target = `tgt_${site}`;
  const authored = JSON.stringify({id: localId, intent: 'expected', source: `https://publisher-${site}.example/a`, target: `https://customer-${site}.example/b`}) + '\n';
  await writeFile(join(dir, 'links.jsonl'), authored);
  await writeFile(join(dir, 'config.json'), JSON.stringify({project: {id: project}, cloud: {origin: 'https://api.example', token: 'fixture'}}));
  await writeFile(join(dir, 'state.json'), JSON.stringify({v: 2, cursors: {events: 'old-source', target_events: 'old-target'}, watches: {[localId]: watch}, custom: {site}}));
  const calls = [];
  const observation = at => ({state: 'present', uncertain: false, checked_at: `2026-09-30T${at}:00:00Z`});
  const fetchImpl = async (url, init) => {
    const u = new URL(url); calls.push({path: u.pathname, cursor: u.searchParams.get('cursor'), project: u.searchParams.get('projectId'), method: init.method});
    assert.equal(init.method, 'GET'); assert.equal(u.searchParams.get('projectId'), project);
    const cursor = u.searchParams.get('cursor');
    if (u.pathname === '/v1/events' || u.pathname === '/v1/target-events') {
      const feed = u.pathname === '/v1/events' ? 'events' : 'target_events';
      if (cursor?.startsWith('old-')) return Response.json({error: {code: 'INVALID_CURSOR', message: 'scope changed'}}, {status: 400});
      const second = cursor === `${feed}-page1`;
      return Response.json({events: [{id: second ? 'ev2' : 'ev1', project_id: project, ...(feed === 'events' ? {watch_id: watch} : {target_id: target}), data: {after: observation(second ? '13' : '12')}}], next_cursor: `${feed}-${second ? 'done' : 'page1'}`, has_more: !second});
    }
    if (u.pathname === '/v1/exports/watches' || u.pathname === '/v1/targets') {
      const isSource = u.pathname === '/v1/exports/watches';
      return Response.json({items: cursor ? [] : [{id: isSource ? watch : target, project_id: project, observation_state: observation('11')}], next_cursor: cursor ? null : 'snapshot-page2'});
    }
    assert.equal(u.pathname, '/v1/watches');
    return Response.json({items: [{id: watch, project_id: project, local_reference: localId}], next_cursor: null});
  };
  return {cwd, dir, project, watch, target, authored, calls, fetchImpl};
}
const run = (f, extra = {}) => main(['sync', '--pull-only', '--recover-cursors'], {cwd: f.cwd, env: {}, fetchImpl: f.fetchImpl, out: () => {}, err: () => {}, ...extra});

test('recovery flag refuses implicit push, other commands and nonboolean values before network or lock acquisition', async () => {
  for (const argv of [['sync', '--recover-cursors'], ['sync', '--push-only', '--recover-cursors'], ['receive', '--recover-cursors'], ['sync', '--pull-only', '--recover-cursors=false']]) {
    const errors = []; assert.equal(await main(argv, {out: () => {}, err: s => errors.push(s), fetchImpl: assert.fail}), 2);
    assert.match(errors[0], /requires agentlinkops sync --pull-only --recover-cursors/);
  }
});

test('nine CLI ledgers recover both feeds and replay an interruption without cross-site history or authored changes', async t => {
  for (let site = 0; site < 9; site++) {
    const f = await fixture(t, site), before = await readFile(join(f.dir, 'state.json'), 'utf8');
    assert.equal(await run(f, {afterHistoryPersisted: () => { throw new Error('injected after history append'); }}), 2);
    assert.equal(await readFile(join(f.dir, 'state.json'), 'utf8'), before);
    const historyBefore = await readFile(join(f.dir, 'events.jsonl'), 'utf8');
    assert.equal(await run(f), 0);
    assert.equal(await readFile(join(f.dir, 'events.jsonl'), 'utf8'), historyBefore);
    const history = historyBefore.trim().split('\n').map(JSON.parse);
    assert.equal(history.length, 6);
    assert.ok(history.every(e => (e.watch_id ?? e.target_id) === (e.watch_id ? f.watch : f.target)));
    assert.equal(await readFile(join(f.dir, 'links.jsonl'), 'utf8'), f.authored);
    const saved = JSON.parse(await readFile(join(f.dir, 'state.json'), 'utf8'));
    assert.deepEqual(saved.cursors, {events: 'events-done', target_events: 'target_events-done'});
    assert.equal(saved.custom.site, site);
    assert.deepEqual(saved.gaps.map(g => g.feed), ['events', 'target_events']);
    const snapshots = (await readdir(f.dir)).filter(n => n.startsWith('snapshot-'));
    assert.equal(snapshots.length, 4, 'source/target snapshots from each interrupted and successful attempt are retained');
    for (const path of snapshots) assert.equal(JSON.parse(await readFile(join(f.dir, path), 'utf8')).next_cursor, null);
    assert.ok(f.calls.every(c => c.project === f.project && c.method === 'GET'));
  }
});

test('denied snapshot exits2 with structured guidance while state/history/ledger remain unchanged', async t => {
  const f = await fixture(t, 'denied'), before = await readFile(join(f.dir, 'state.json'), 'utf8'), errors = [];
  const fetchImpl = async (url, init) => new URL(url).pathname === '/v1/exports/watches'
    ? Response.json({error: {code: 'FORBIDDEN', message: 'denied'}}, {status: 403}) : f.fetchImpl(url, init);
  assert.equal(await run(f, {fetchImpl, err: s => errors.push(s)}), 2);
  assert.equal(JSON.parse(errors.at(-1)).error.code, 'FORBIDDEN');
  assert.match(JSON.parse(errors.at(-1)).error.next, /authorized read access/);
  assert.equal(await readFile(join(f.dir, 'state.json'), 'utf8'), before);
  assert.equal(await readFile(join(f.dir, 'links.jsonl'), 'utf8'), f.authored);
  assert.ok(!(await readdir(f.dir)).includes('events.jsonl'));
});
