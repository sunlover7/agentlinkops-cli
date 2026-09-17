// Local claims, joined to existing facts by ledger id. No network and no cloud receipt.
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeEntry, readLedger } from './ledger.js';
import { checkObservationKind } from '../src/verifier/observation-kind.js';
import { readObservations } from './mirror.js';
import { readState } from './state.js';

const textAt = async path => readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error;
});
const core = row => JSON.stringify([row.kind, row.source, row.target, row.scope ?? 'exact', row.acted_at]);
const placement = row => JSON.stringify([row.source, row.target, row.scope ?? 'exact']);
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

export async function readReceipts(path) {
  const rows = [], ids = new Set(), keys = new Set();
  for (const [i, line] of (await textAt(path)).split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!/^ar_[a-z0-9]{4,32}$/.test(row.id) || !/^lk_[a-z0-9]{4,32}$/.test(row.ledger)
        || !['internal', 'external'].includes(row.kind) || row.report?.state !== 'claimed'
        || !date(row.acted_at) || !date(row.declared_at) || !('baseline' in row)
        || !['human', 'agent'].includes(row.actor?.role)) throw new Error('invalid receipt claim');
      normalizeEntry({ ...row, id: row.ledger, intent: row.intent_after ?? 'wanted' });
      if (ids.has(row.id) || (row.idempotency && keys.has(row.idempotency))) throw new Error('duplicate receipt identity or idempotency key');
      ids.add(row.id); if (row.idempotency) keys.add(row.idempotency);
      rows.push(row);
    } catch (error) { throw new Error(`receipts line ${i + 1}: ${error.message}`); }
  }
  return rows;
}

// A recoverable two-file append. A crash after the entry write cannot mint another identity.
// Before/after comparisons refuse concurrent manual edits; recovery never overwrites them.
async function finishTransaction(path, tx, afterWrite = async () => {}) {
  for (const part of tx.parts) {
    const held = await textAt(part.path);
    if (held === part.after) continue;
    if (held !== part.before) throw new Error(`receipt transaction conflict at ${part.path}; preserve edits and reconcile ${path}`);
    await mkdir(dirname(part.path), { recursive: true });
    const tmp = `${part.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, part.after, 'utf8');
    await rename(tmp, part.path);
    await afterWrite(part.path);
  }
  await unlink(path);
}

export async function writeReceipt(config, input, { now = new Date().toISOString(), afterWrite } = {}) {
  await mkdir(config.dir, { recursive: true });
  const lock = `${config.paths.ledger}.lock`;
  let handle;
  try { handle = await import('node:fs/promises').then(fs => fs.open(lock, 'wx')); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`receipt writer locked: ${lock}; remove only after confirming its writer stopped`); throw error; }
  const journal = join(config.dir, 'receipt-transaction.json');
  try {
    const pending = await textAt(journal);
    if (pending) await finishTransaction(journal, JSON.parse(pending), afterWrite);
    const ledger = await readLedger(config.paths.ledger);
    if (ledger.missing || ledger.problems.length) throw new Error('receipt requires a valid existing ledger');
    const receipts = await readReceipts(config.paths.receipts);
    const proposed = input.intent_after ?? (input.kind === 'internal' ? 'expected' : 'wanted');
    const entry = normalizeEntry({ source: input.source, target: input.target, scope: input.scope,
      intent: proposed, expect: input.expect, ref: input.ref, tags: input.tags, note: input.note,
      added: now.slice(0, 10) }, { assignId: true });
    const kind = checkObservationKind({ kind: input.kind, sourceUrl: entry.source, targetUrl: entry.target }, config.project?.site);
    if (!kind.valid) throw new Error(kind.reason);
    if (!date(input.acted_at) || !date(now)) throw new Error('acted_at must be an ISO timestamp with timezone');
    if (!['human', 'agent'].includes(input.actor?.role)) throw new Error('actor.role must be human or agent');
    if (input.report && input.report.state !== 'claimed') throw new Error('report.state must remain claimed');
    if (input.idempotency != null && (typeof input.idempotency !== 'string' || !input.idempotency.trim())) throw new Error('idempotency must be a nonempty string');
    const replay = input.idempotency && receipts.find(row => row.idempotency === input.idempotency);
    if (replay) {
      if (core(replay) !== core(input)) throw new Error('idempotency key is bound to a different core claim');
      return { receipt: replay, created: false };
    }
    const matches = ledger.entries.filter(row => placement(row) === placement(entry));
    if (matches.length > 1) throw new Error('ambiguous placement: multiple ledger entries');
    const existing = input.ledger ? ledger.entries.find(row => row.id === input.ledger) : matches[0];
    if (input.ledger && (!existing || placement(existing) !== placement(entry))) throw new Error('ledger reference does not match receipt placement');
    const linked = existing ?? entry;
    const observations = await readObservations(config.paths.observations);
    if (observations.problems.length) throw new Error('cannot pin baseline from malformed observations');
    const state = await readState(config.paths.state);
    const prior = observations.rows.filter(row => row.id === linked.id && row.result?.sourceUrl === entry.source && row.result?.targetUrl === entry.target && (row.result?.targetScope ?? 'exact') === entry.scope && Date.parse(row.checked_at) <= Date.parse(now))
      .sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0];
    let baseline = prior ? { checked_at: prior.checked_at, state: prior.state, reason: prior.reason ?? null, complete: prior.complete === true } : null;
    const activity = state.entries?.[linked.id];
    if (activity && activity.last_placement === placement(entry) && Date.parse(activity.last_checked) <= Date.parse(now) && (!baseline || Date.parse(activity.last_checked) > Date.parse(baseline.checked_at))) {
      baseline = { checked_at: activity.last_checked, state: activity.last_state, reason: activity.last_reason ?? null,
        complete: activity.last_complete ?? (prior?.state === activity.last_state && prior?.reason === activity.last_reason ? prior.complete === true : false) };
    }
    const receipt = { ...input, id: `ar_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
      source: entry.source, target: entry.target, scope: entry.scope, declared_at: now,
      report: { ...input.report, state: 'claimed' }, baseline, ledger: linked.id, intent_after: proposed };
    const parts = [];
    for (const [path, row] of [[config.paths.ledger, existing ? null : entry], [config.paths.receipts, receipt]]) {
      if (!row) continue;
      const before = await textAt(path);
      parts.push({ path, before, after: before + (before && !before.endsWith('\n') ? '\n' : '') + JSON.stringify(row) + '\n' });
    }
    await writeFile(journal, JSON.stringify({ parts }), { flag: 'wx' });
    await finishTransaction(journal, { parts }, afterWrite);
    return { receipt, created: true };
  } finally { await handle.close(); await unlink(lock); }
}

export function receiptHistory(receipts, entries, observations, state) {
  return receipts.map(receipt => {
    const entry = entries.find(row => row.id === receipt.ledger);
    const history = observations.filter(row => row.id === receipt.ledger).sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
    const activity = state.entries?.[receipt.ledger];
    const firstPresent = [activity?.first_present_placement === placement(receipt) ? activity.first_present : null, ...history.filter(row => row.state === 'present' && row.complete && row.result?.sourceUrl === receipt.source && row.result?.targetUrl === receipt.target && (row.result?.targetScope ?? 'exact') === receipt.scope).map(row => row.checked_at)]
      .filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    return { receipt, entry_missing: !entry, placement_changed: !!entry && placement(entry) !== placement(receipt),
      intent_proposal_differs: !!entry && entry.intent !== receipt.intent_after,
      latest: history.at(-1) ?? null, first_present: firstPresent,
      novelty: receipt.baseline?.state === 'present' || (firstPresent && Date.parse(firstPresent) < Date.parse(receipt.acted_at)) ? 'contradicted' : 'unproven', history };
  });
}
