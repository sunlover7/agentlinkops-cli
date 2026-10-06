// Isolated fixture only: all requests are injected, no network is reachable.
import { main } from '../../cli/main.js';
import { loadConfig } from '../../cli/config.js';
import { localCheck, adoptLocalResult } from '../../cli/local-result.js';
import { verifyLink } from '../../src/verifier/index.js';
import { mutateLedger } from '../../cli/ledger.js';
import { join } from 'node:path';
import { acquireSyncLock } from '../../cli/sync-lock.js';
const [cwd, mode] = process.argv.slice(2);
const send = value => new Promise(resolve => process.send(value, resolve));
if (mode === 'ledger-crash') {
  await mutateLedger(join(cwd,'links.jsonl'),async entries => {
    await send({checkpoint:'ledger-locked',pid:process.pid}); await new Promise(() => {});
    return entries;
  });
} else if (mode === 'adopt-crash' || mode === 'adopt-resume') {
  const result = await localCheck({source:'https://publisher.example.com/a',target:'https://example.com/guide',scope:'exact'}, {
    hostDelayMs:0, verify:(input, options)=>verifyLink(input,{...options,now:'2026-09-30T12:00:00Z',fetchImpl:async url=>new URL(url).pathname==='/robots.txt'?new Response('',{status:404}):new Response('<html><body><a href="https://example.com/guide">Guide</a></body></html>',{headers:{'content-type':'text/html'}})})
  });
  const config=await loadConfig({cwd});
  const adopted=await adoptLocalResult(config,result,{intent:'expected',afterWrite:mode==='adopt-crash'?async()=>{await send({checkpoint:'adoption-part-persisted',pid:process.pid});await new Promise(()=>{});}:undefined});
  await send({checkpoint:'adopted',pid:process.pid,result:adopted});process.exit(0);
} else if (mode === 'before-marker') {
  await acquireSyncLock(cwd, 'fixture', { afterMarkerCreated: async () => { await send({checkpoint:'empty-marker',pid:process.pid}); await new Promise(() => {}); } });
} else if (mode === 'hold') {
  const lock = await acquireSyncLock(cwd, 'fixture');
  await send({ checkpoint: 'lock-held', pid: process.pid });
  process.on('message', async () => { await lock.release(); process.exit(0); });
} else {
  const calls = [];
  const event = { id: 'evt_fixture_one', type: 'watch.checked', watch_id: 'wat_fixture_one', data: { after: { checked_at: '2026-09-30T12:00:00Z', result: { presence: 'present', htmlComplete: true, checkedAt: '2026-09-30T12:00:00Z' } } } };
  const fetchImpl = async (url, options) => {
    const u = new URL(url); calls.push({ path: u.pathname, cursor: u.searchParams.get('cursor'), method: options.method });
    if (options.method !== 'GET' || u.origin !== 'https://fixture.invalid') throw Error('Fixture forbids external writes or origins');
    if (u.pathname === '/v1/events') return Response.json({ events: u.searchParams.get('cursor') === 'source_fixture_end' ? [] : [event], next_cursor: 'source_fixture_end', has_more: false });
    if (u.pathname === '/v1/target-events') return Response.json({ events: [], next_cursor: 'target_fixture_end', has_more: false });
    if (u.pathname === '/v1/watches') return Response.json({ items: [{ id: 'wat_fixture_one', project_id: 'pr_fixture', local_reference: 'lk_aaaaaaaa' }], next_cursor: null });
    throw Error(`Unexpected fixture request ${u.pathname}`);
  };
  const code = await main(['sync', '--pull-only'], { cwd, env: { AGENTLINKOPS_TOKEN: 'isolated-fixture' }, fetchImpl,
    out: () => {}, err: message => calls.push({ error: message }),
    afterHistoryPersisted: mode === 'crash' ? async () => { await send({ checkpoint: 'history-persisted', pid: process.pid, calls }); await new Promise(() => {}); } : undefined,
    afterStatePersisted: mode === 'state-crash' ? async () => { await send({ checkpoint: 'state-persisted', pid: process.pid, calls }); await new Promise(() => {}); } : undefined });
  await send({ checkpoint: 'finished', pid: process.pid, code, calls });
  process.exit(code);
}
