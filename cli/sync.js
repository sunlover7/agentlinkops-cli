import {lifecycleOutput} from '../shared/lifecycle-contract.js';
import {observationFromSnapshot,eventSnapshot} from '../shared/observation-event.js';
// `agentlinkops sync`: expectations up, events and evidence references down.
//
// The cloud is a mirror and a history of the customer's file, never the system of record for
// their workflow. So sync is deliberately asymmetric: **it pushes intent and pulls facts, and it
// never writes to the ledger.** A cloud that could rewrite `links.jsonl` would be a dashboard
// that had learned to commit, which is the product this one exists not to be.
import { toWatchInput, ledgerIdOf } from './ledger.js';
import { observationRow } from './mirror.js';
import { CloudError } from './client.js';

const PUSH_BATCH = 100;

export function syncPlan(entries, state, { includeWanted = false, ledgerIds = null } = {}) {
  if (ledgerIds !== null && (!Array.isArray(ledgerIds) || ledgerIds.some(id => typeof id !== 'string') || ledgerIds.some(id => !entries.some(entry => entry.id === id))))
    throw new CloudError('INVALID_SYNC_SELECTION', 0);
  const selected = ledgerIds === null ? null : new Set(ledgerIds);
  return entries.map(entry => ({ id: entry.id, intent: entry.intent,
    action: selected && !selected.has(entry.id) ? 'stay_local'
      : entry.intent === 'retired' ? (state.watches?.[entry.id] ? 'pause' : 'stay_local')
      : entry.intent === 'wanted' && !includeWanted ? 'stay_local' : 'monitor',
    watch_id: state.watches?.[entry.id] ?? null }));
}

/**
 * Pushes every entry the cloud should be watching.
 *
 * Idempotent by construction rather than by bookkeeping: the cloud deduplicates a watch on
 * (source, target, scope) and returns `created: false` for one it already has, so pushing the
 * same ledger twice creates nothing and the second run is a no-op a customer can run freely.
 */
export async function pushExpectations(client, entries, state, { projectId, onProgress = null, includeWanted = false, ledgerIds = null } = {}) {
  const plan = syncPlan(entries, state, { includeWanted, ledgerIds });
  const actions = new Map(plan.map(row => [row.id, row.action]));
  const watched = entries.filter(entry => actions.get(entry.id) === 'monitor');
  const created = [], failed = [], mapping = { ...(state.watches ?? {}) };
  for (let index = 0; index < watched.length; index += PUSH_BATCH) {
    const batch = watched.slice(index, index + PUSH_BATCH);
    const result = await client.importWatches(projectId, batch.map(toWatchInput));
    for (const row of result.rows ?? []) {
      const entry = batch[row.index];
      if (!entry) continue;
      if (row.error) { failed.push({ id: entry.id, code: row.error.code, message: row.error.message }); continue; }
      mapping[entry.id] = row.watch.id;
      if (row.watch.created !== false) created.push(entry.id);
    }
    onProgress?.(Math.min(index + PUSH_BATCH, watched.length), watched.length);
  }
  // A retired entry is PAUSED, never deleted. Its observations are the customer's history and
  // deleting the watch would take them with it.
  const retired = [];
  for (const entry of entries.filter(item => actions.get(item.id) === 'pause')) {
    const watchId = mapping[entry.id];
    if (!watchId) continue;
    try { await client.updateWatch(watchId, { status: 'paused' }); retired.push(entry.id); }
    catch (error) { failed.push({ id: entry.id, code: error.code, message: error.message }); }
  }
  return { pushed: watched.length, created: created.length, retired: retired.length, failed, watches: mapping, local: plan.filter(row => row.action === 'stay_local').length };
}

/**
 * Pulls the event feed into the local mirror.
 *
 * Two rules, both inherited from the cloud's own contract rather than invented here.
 *
 * **A whole page applies before the cursor advances.** A crash mid-page re-fetches that page; it
 * never skips it.
 *
 * **An expired cursor resyncs, it does not skip.** The cloud answers a cursor below its floor
 * with 410 carrying `resync_required`, a snapshot endpoint and a resume cursor. Advancing to the
 * resume cursor WITHOUT taking the snapshot would silently drop every change in the gap, which
 * is the exact failure the 410 exists to prevent.
 */
export async function pullEvents(client, state, options = {}) {
  return pullFeed({ list: query => client.listEvents(query), exportSnapshot: query => client.exportWatches(query) }, 'events', state, options);
}

/**
 * Pulls the TARGET event feed, on its own cursor.
 *
 * The cloud keeps `events` and `target_events` in separate per-workspace sequences, so a single
 * cursor cannot address both: sequence 41 means one thing in one feed and something unrelated in
 * the other. Sharing one would have advanced the target cursor past unread source events on every
 * sync, and the loss would have been invisible — the feed would simply look quiet.
 *
 * The independence is total, and that is the part worth testing: an expiry on one feed resyncs
 * that feed and **must not touch the other's cursor**, because the two have no reason to have
 * expired together.
 */
export async function pullTargetEvents(client, state, options = {}) {
  return pullFeed({ list: query => client.listTargetEvents(query), exportSnapshot: client.listTargets ? query => client.listTargets(query) : null }, 'target_events', state, options);
}

/** The shared walk. One cursor key per feed, and the key is the only thing that differs. */
async function pullFeed(feed, cursorKey, state, { maxPages = 100, onSnapshot = null } = {}) {
  const events = [], gaps = [];
  let cursor = state.cursors?.[cursorKey] ?? null;
  let pages = 0, resynced = false;
  while (pages < maxPages) {
    let page;
    try { page = await feed.list({ cursor, limit: 100 }); }
    catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'CURSOR_EXPIRED') throw error;
      const details = error.details ?? {};
      // The snapshot is taken FIRST. Only then does the cursor move, and the gap is recorded so
      // a reader can see that something happened here rather than inferring quiet.
      if (!feed.exportSnapshot) throw new CloudError('RESYNC_SNAPSHOT_UNAVAILABLE', 410, details);
      if (resynced) throw new CloudError('RESYNC_REPEATED_EXPIRY', 410, details);
      let snapshot = null, snapshotCursor = null;
      const seen = new Set();
      do {
        const part = await feed.exportSnapshot({cursor: snapshotCursor, limit: 100});
        snapshot = snapshot ? {...snapshot, items: [...snapshot.items, ...(part.items ?? [])]} : {...part, items: part.items ?? []};
        snapshotCursor = part.next_cursor ?? null;
        if (snapshotCursor && seen.has(snapshotCursor)) throw new CloudError('INVALID_SNAPSHOT_CURSOR', 502);
        seen.add(snapshotCursor);
      } while (snapshotCursor);
      snapshot.next_cursor = null;
      // The server's expiry watermark precedes this scan. Replaying from it catches concurrent changes.
      for (const watch of snapshot.items) {
        const state = watch.observation_state;
        const at = state?.checked_at ?? state?.latestAttempt?.checkedAt;
        if (!at) continue;
        const after = cursorKey === 'events' ? eventSnapshot({...state, source_url:watch.source_url,target_url:watch.target_url,target_scope:watch.target_scope})
          : {target_id:watch.id,url:watch.url,state:state.state,uncertain:state.uncertain,checked_at:at,http_status:state.latestAttempt?.httpStatus,reason:state.latestAttempt?.reason,final_url:state.latestAttempt?.finalUrl};
        events.push({id: `snapshot:${cursorKey}:${watch.id}:${at}`, ...(cursorKey === 'events' ? {watch_id: watch.id} : {target_id: watch.id}),
          data: {after}});
      }
      await onSnapshot?.(snapshot, cursorKey);
      gaps.push({ at: new Date().toISOString(), reason: 'cursor_expired', resumed_from: details.resume_cursor ?? null });
      cursor = details.resume_cursor ?? null;
      resynced = true;
      if (!details.resume_cursor) break;
      continue;
    }
    events.push(...(page.events ?? []));
    pages++;
    // Applied, then advanced.
    cursor = page.next_cursor ?? cursor;
    if (!page.has_more) break;
  }
  // Named by feed, so a caller writing this back cannot put it under the wrong key.
  return { feed: cursorKey, events, cursor, pages, gaps, resynced };
}

/** Cloud observations, tagged so a row never loses which machine looked. */
export function cloudObservationRows(events, watchToLedger) {
  const rows = [];
  for (const event of events) {
    const ledgerId = watchToLedger.get(event.watch_id);
    if (!ledgerId) continue;
    const observation = event.data?.after;
    if (!observation?.checked_at) continue;
    rows.push({...observationRow(ledgerId, observationFromSnapshot(observation), { source: 'cloud', evidenceKey: event.data?.evidence_key ?? null }),
      // The hosted observation's own id, carried so a receipt export can name the workspace row
      // (agentlinkops:evidence/1/link/hosted/<id>) alongside the mirror reference that resolves
      // offline. Absent on snapshot-derived rows, which reconstruct state without observation ids.
      cloud_observation_id: event.data?.observation_id ?? null, projection_version: 1});
  }
  return rows;
}

/** Ledger id per cloud watch id, from what push recorded and what the cloud reports. */
export async function watchIndex(client, state) {
  const index = new Map();
  for (const [ledgerId, watchId] of Object.entries(state.watches ?? {})) index.set(watchId, ledgerId);
  // A watch created somewhere else still carries its ledger id in `localReference`, so the
  // mapping does not depend on this machine having been the one that pushed it.
  // The list endpoint signals more pages with a non-null `next_cursor` and does NOT return a
  // `has_more` flag — reading one would have silently indexed only the first hundred watches,
  // and every event past them would have been skipped as belonging to an unknown watch.
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const result = await client.listWatches({ cursor, limit: 100 });
    for (const watch of result.items ?? []) {
      const ledgerId = ledgerIdOf(watch.local_reference);
      if (ledgerId) index.set(watch.id, ledgerId);
    }
    if (!result.next_cursor) return index;
    cursor = result.next_cursor;
  }
  throw new CloudError('WATCH_INDEX_LIMIT', 502);
}


// Optional read-only deal mirror. One failure leaves the previous mirror untouched.
// The caller saves it only after every selected watch has been read and scoped.
export async function pullLifecycleMirrors(client,state,{projectId,index=null,ledgerIds=null,now=()=>new Date().toISOString()}={}){
 const candidates=index?[...index].map(([watchId,ledgerId])=>[ledgerId,watchId]):Object.entries(state.watches??{});
 const selected=ledgerIds===null?null:new Set(ledgerIds),mapping=candidates.filter(([id])=>!selected||selected.has(id));
 if(new Set(mapping.map(([id])=>id)).size!==mapping.length)throw new CloudError('LIFECYCLE_MAPPING_CONFLICT',0);
 if(mapping.length>1000)throw new CloudError('LIFECYCLE_MIRROR_LIMIT',0);
 const rows={};
 for(const [ledgerId,watchId] of mapping){
  const value=lifecycleOutput.parse(await client.callCommand('get_link_lifecycle',{projectId,watchId}));
  if(value.projectId!==projectId||value.watchId!==watchId)throw new CloudError('LIFECYCLE_MIRROR_SCOPE',0);
  rows[ledgerId]={...value,observedAt:now()};
 }
 return {projectId,rows};
}
