import { main } from '../cli/main.js';
import { mutateLedger, readLedger } from '../cli/ledger.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { acquireSyncLock } from '../cli/sync-lock.js';
import { nativeLock } from '../cli/native-lock.js';
const worker = new URL('./fixtures/cli-sync-crash-worker.mjs', import.meta.url);
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'alo-owned-lock-')); t.after(() => rm(dir, {recursive: true, force: true})); return dir; }
function child(t, dir, mode) {
  const p = fork(worker, [dir, mode], {stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {PATH: process.env.PATH}});
  let stderr = ''; p.stderr.on('data', b => { stderr += b; });
  const exit = once(p, 'exit');
  t.after(() => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); });
  const message = new Promise((resolve, reject) => { p.once('message', resolve); p.once('error', reject); p.once('exit', (code, signal) => reject(Error(`fixture exited ${code}/${signal}: ${stderr}`))); });
  return {p, exit, message};
}
test('native refusal precedes filesystem mutation', async t => {
  const dir = await temp(t); await assert.rejects(acquireSyncLock(dir, 'sync', {kernel: () => nativeLock('win32')}), /unsupported/);
  await assert.rejects(lstat(join(dir, '.sync-gate')), {code: 'ENOENT'});
});
test('legacy empty and malformed markers are never reclaimed', async t => {
  const dir = await temp(t);
  for (const value of ['', '{bad', 'x'.repeat(4097)]) {
    await writeFile(join(dir, 'sync.lock'), value);
    await assert.rejects(acquireSyncLock(dir, 'sync'), /ownership is unknown/);
    assert.equal(await readFile(join(dir, 'sync.lock'), 'utf8'), value);
  }
});
test('symlink marker and permissive gate refuse without touching target', async t => {
  const dir = await temp(t); const target = join(dir, 'target'); await writeFile(target, 'protected');
  await symlink(target, join(dir, 'sync.lock'));
  await assert.rejects(acquireSyncLock(dir, 'sync'), /ownership is unknown/);
  assert.equal(await readFile(target, 'utf8'), 'protected');
  await rm(join(dir, 'sync.lock'));
  await chmod(join(dir, '.sync-gate'), 0o666);
  await assert.rejects(acquireSyncLock(dir, 'sync'), /ownership is unknown/);
  await assert.rejects(lstat(join(dir, 'sync.lock')), {code: 'ENOENT'});
  assert.equal(await readFile(target, 'utf8'), 'protected');
});
test('live owned child serializes writers and clean release preserves gate inode', async t => {
  const dir = await temp(t); const held = child(t, dir, 'hold'); const receipt = await held.message;
  assert.equal(receipt.pid, held.p.pid); assert.equal(receipt.checkpoint, 'lock-held');
  const before = await readFile(join(dir, 'sync.lock'), 'utf8'); const gate = await lstat(join(dir, '.sync-gate'));
  await assert.rejects(acquireSyncLock(dir, 'sync'), /writer is active/);
  assert.equal(await readFile(join(dir, 'sync.lock'), 'utf8'), before);
  held.p.send('release'); assert.deepEqual(await held.exit, [0, null]);
  const next = await acquireSyncLock(dir, 'sync'); await next.release();
  assert.equal((await lstat(join(dir, '.sync-gate'))).ino, gate.ino);
});
test('successor marker is preserved on release refusal', async t => {
  const dir = await temp(t); const lock = await acquireSyncLock(dir, 'sync');
  await rm(lock.path); await writeFile(lock.path, 'successor');
  await assert.rejects(lock.release(), /ownership is unknown/);
  assert.equal(await readFile(lock.path, 'utf8'), 'successor');
});
for (const boundary of ['history', 'state']) test(`actual owned-child crash after ${boundary} persistence preserves history and separate cursors`, async t => {
  const cwd = await temp(t); const dir = join(cwd, '.agentlinkops'); await mkdir(dir);
  const ledger = JSON.stringify({id:'lk_aaaaaaaa',intent:'expected',source:'https://publisher.invalid/a',target:'https://customer.invalid/',scope:'exact'})+'\n';
  await writeFile(join(dir,'links.jsonl'),ledger); await writeFile(join(dir,'config.json'),JSON.stringify({project:{id:'pr_fixture'},cloud:{origin:'https://fixture.invalid',workspaceId:'ws_fixture'}}));
  await writeFile(join(dir,'state.json'),JSON.stringify({v:1,watches:{lk_aaaaaaaa:'wat_fixture_one'},cursors:{events:'old-source',target_events:'old-target'},customerCheckpoint:'preserve'}));
  const crashed=child(t,cwd,boundary === 'history' ? 'crash' : 'state-crash'); const checkpoint=await crashed.message;
  assert.equal(checkpoint.checkpoint,`${boundary}-persisted`,JSON.stringify(checkpoint)); assert.equal(checkpoint.pid,crashed.p.pid);
  assert.equal((await readFile(join(dir,'observations.jsonl'),'utf8')).trim().split('\n').length,1);
  assert.equal(JSON.parse(await readFile(join(dir,'state.json'),'utf8')).cursors.events,boundary === 'history' ? 'old-source' : 'source_fixture_end');
  crashed.p.kill('SIGKILL'); assert.deepEqual(await crashed.exit,[null,'SIGKILL']);
  const replay=child(t,cwd,'resume'); const resumed=await replay.message; assert.equal(resumed.code,0); assert.deepEqual(await replay.exit,[0,null]);
  const third=child(t,cwd,'resume'); const stable=await third.message; assert.equal(stable.code,0); assert.deepEqual(await third.exit,[0,null]);
  assert.equal((await readFile(join(dir,'observations.jsonl'),'utf8')).trim().split('\n').length,1);
  assert.equal((await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').length,1);
  const state=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));
  assert.deepEqual(state.cursors,{events:'source_fixture_end',target_events:'target_fixture_end'});
  assert.equal(state.watches.lk_aaaaaaaa,'wat_fixture_one'); assert.equal(state.customerCheckpoint,'preserve');
  assert.equal(await readFile(join(dir,'links.jsonl'),'utf8'),ledger);
  t.diagnostic(JSON.stringify({binding:'isolated injected GET feed',boundary,crashedPid:crashed.p.pid,crashSignal:'SIGKILL',replayPid:replay.p.pid,thirdPid:third.p.pid,observationCount:1,eventCount:1,cursors:state.cursors,mapping:state.watches,requests:[checkpoint.calls,resumed.calls,stable.calls],customerCheckpoint:state.customerCheckpoint}));
  assert.ok(resumed.calls.every(c=>c.method==='GET')); assert.ok(stable.calls.every(c=>c.method==='GET'));
  if (boundary === 'state') assert.equal(resumed.calls.find(c=>c.path==='/v1/events').cursor,'source_fixture_end');
});

test('actual crash during marker initialization protects the unknown empty marker', async t => {
  const dir=await temp(t); const interrupted=child(t,dir,'before-marker');
  const checkpoint=await interrupted.message; assert.equal(checkpoint.checkpoint,'empty-marker');
  interrupted.p.kill('SIGKILL'); assert.deepEqual(await interrupted.exit,[null,'SIGKILL']);
  await assert.rejects(acquireSyncLock(dir,'sync'),/ownership is unknown/);
  assert.equal(await readFile(join(dir,'sync.lock'),'utf8'),'');
});
test('verified metadata with live/reused PID, foreign boot or denied probe is preserved', async t => {
  const dir=await temp(t); const lock=await acquireSyncLock(dir,'sync');
  const original=await readFile(lock.path,'utf8'); await lock.release();
  for (const mutate of [v=>v, v=>({...v,boot:'another-boot'}), v=>({...v,uid:v.uid+1})]) {
    const text=JSON.stringify(mutate(JSON.parse(original)))+'\n'; await writeFile(join(dir,'sync.lock'),text);
    await assert.rejects(acquireSyncLock(dir,'sync'),/live or reused|ownership is unknown/);
    assert.equal(await readFile(join(dir,'sync.lock'),'utf8'),text);
  }
  await writeFile(join(dir,'sync.lock'),original);
  await assert.rejects(acquireSyncLock(dir,'sync',{isDeparted:()=>{throw Error('denied')}}),/ownership is unknown/);
  assert.equal(await readFile(join(dir,'sync.lock'),'utf8'),original);
});
test('two actual recoverers cannot overlap after an owned process dies', async t => {
  const dir=await temp(t); const first=child(t,dir,'hold'); await first.message;
  first.p.kill('SIGKILL'); assert.deepEqual(await first.exit,[null,'SIGKILL']);
  const a=child(t,dir,'hold'), b=child(t,dir,'hold');
  const results=await Promise.allSettled([a.message,b.message]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const winner=results[0].status==='fulfilled'?a:b, loser=winner===a?b:a;
  assert.deepEqual(await loser.exit,[1,null]); winner.p.send('release'); assert.deepEqual(await winner.exit,[0,null]);
});

test('actual adoption crash recovers the secondary ledger lock and pending transaction once', async t => {
  const cwd=await temp(t);assert.equal(await main(['init'],{cwd,out:()=>{},err:assert.fail}),0);
  const interrupted=child(t,cwd,'adopt-crash');assert.equal((await interrupted.message).checkpoint,'adoption-part-persisted');
  interrupted.p.kill('SIGKILL');assert.deepEqual(await interrupted.exit,[null,'SIGKILL']);
  const resumed=child(t,cwd,'adopt-resume');const receipt=await resumed.message;assert.deepEqual(await resumed.exit,[0,null]);
  const again=child(t,cwd,'adopt-resume');const replay=await again.message;assert.deepEqual(await again.exit,[0,null]);
  assert.equal(receipt.result.ledger_id,replay.result.ledger_id);assert.equal(replay.result.observation_added,false);
  const dir=join(cwd,'.agentlinkops');assert.equal((await readLedger(join(dir,'links.jsonl'))).entries.length,1);
  assert.equal((await readFile(join(dir,'observations.jsonl'),'utf8')).trim().split('\n').length,1);
  await assert.rejects(lstat(join(dir,'adopt-result-transaction.json')),{code:'ENOENT'});
  t.diagnostic(JSON.stringify({binding:'isolated adoption transaction, injected verifier',interruptedPid:interrupted.p.pid,signal:'SIGKILL',resumePid:resumed.p.pid,replayPid:again.p.pid,receipt:receipt.result,replay:replay.result,observations:1,ledgerRows:1}));
});
test('actual ledger-writer death recovers without inventing a prior commit', async t => {
  const dir=await temp(t);await writeFile(join(dir,'links.jsonl'),'');
  const interrupted=child(t,dir,'ledger-crash');assert.equal((await interrupted.message).checkpoint,'ledger-locked');
  interrupted.p.kill('SIGKILL');assert.deepEqual(await interrupted.exit,[null,'SIGKILL']);
  assert.equal(await readFile(join(dir,'links.jsonl'),'utf8'),'');
  await mutateLedger(join(dir,'links.jsonl'),entries=>{assert.deepEqual(entries,[]);return entries;});
  assert.equal(await readFile(join(dir,'links.jsonl'),'utf8'),'');
});
