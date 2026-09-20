// Supplemental operational evidence; never part of citation-envelope hashes.
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError } from './adapter.js';
export const EGRESS_LIMITS = Object.freeze({ rows: 10000, bytes: 8 * 1024 * 1024 });
const fail = code => Object.assign(new EngineError('Egress evidence could not be persisted; the epoch stopped.'), { code });
const codes = new Set(['PROXY_REQUIRED','PROXY_POLICY_INVALID','PROXY_POLICY_CONFLICT','PROXY_CONFIGURATION_INVALID','PROXY_ACQUIRE_FAILED','PROXY_SUPPLIER_INVALID','PROXY_LEASE_INVALID','PROXY_LEASE_EXPIRED','PROXY_QUARANTINED','PROXY_QUARANTINE_FAILED','PROXY_RELEASE_FAILED','PROXY_RECEIPT_FAILED','PROXY_CUSTODY_UNAVAILABLE','BROWSER_CLEANUP_UNCONFIRMED','BROWSER_RUN_IN_PROGRESS','BROWSER_RUN_FAILED']);
const safeCode = error => error ? codes.has(error.code) ? error.code : 'ENGINE_ERROR' : null;
const enumeration = (value, values) => { if (!values.includes(value)) throw fail('EGRESS_RECEIPT_INVALID'); return value; };
const count = value => { if (!Number.isSafeInteger(value) || value < 0) throw fail('EGRESS_RECEIPT_INVALID'); return value; };
function sanitize(row) {
  if (!row || row.version !== 1 || count(row.sequence) < 1) throw fail('EGRESS_RECEIPT_INVALID');
  const observedAt = typeof row.observedAt === 'string' && row.observedAt.length <= 35 ? new Date(row.observedAt) : null;
  if (!observedAt || !Number.isFinite(observedAt.getTime())) throw fail('EGRESS_RECEIPT_INVALID');
  if (row.leaseHash !== null && !/^[a-f0-9]{64}$/.test(row.leaseHash ?? '')) throw fail('EGRESS_RECEIPT_INVALID');
  const meterState = enumeration(row.meterState, ['measured','bytes_only','unavailable','not_applicable','incomplete']);
  const bytes = row.bytes === null ? null : count(row.bytes);
  const costMicrousd = row.costMicrousd === null ? null : count(row.costMicrousd);
  if ((meterState === 'measured' && (bytes === null || costMicrousd === null)) || (meterState === 'bytes_only' && (bytes === null || costMicrousd !== null)) || (['unavailable','not_applicable'].includes(meterState) && (bytes !== null || costMicrousd !== null))) throw fail('EGRESS_RECEIPT_INVALID');
  return { version: 1, sequence: row.sequence,
    egress: enumeration(row.egress, ['proxy-required','direct-diagnostic']),
    phase: enumeration(row.phase, ['sample','cleanup','failure_cleanup','lease_expiry']),
    outcome: enumeration(row.outcome, ['observed','unknown','failed','closed','cleanup_unconfirmed']),
    reason: enumeration(row.reason, [null,'blocked','rate_limited','connection_error','cleanup_unconfirmed']),
    leaseHash: row.leaseHash, observedAt: observedAt.toISOString(), meterState, bytes, costMicrousd };
}

export async function createEgressJournal({ dir, epochId, engines, identityHashes = new Map(), limits = EGRESS_LIMITS }) {
  if (typeof epochId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(epochId)) throw fail('EGRESS_JOURNAL_UNAVAILABLE');
  const tracked = new Map(engines.map((engine, index) => [engine, { index, retained: [] }]));
  if (!tracked.size) return null;
  if (!Number.isSafeInteger(limits.rows) || limits.rows < 1 || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1) throw fail('EGRESS_LIMIT_INVALID');
  // A reusable adapter may retain earlier epochs in memory. Establish the cursor
  // before this epoch's first request; never count or rewrite those older deltas.
  for (const [engine, state] of tracked) {
    try {
      const prior = engine.getEgressReceipts?.() ?? [];
      if (!Array.isArray(prior) || prior.length > limits.rows) throw fail('EGRESS_RECEIPT_LIMIT');
      state.retained = prior.map((row, index) => {
        const value = sanitize(row);
        if (value.sequence !== index + 1) throw fail('EGRESS_RECEIPT_INVALID');
        return JSON.stringify(value);
      });
    } catch { throw fail('EGRESS_RECEIPT_UNAVAILABLE'); }
  }
  let file;
  try { await mkdir(join(dir, 'citations/egress'), { recursive: true }); file = await open(join(dir, 'citations/egress', `${epochId}.jsonl`), 'wx', 0o600); }
  catch { throw fail('EGRESS_JOURNAL_UNAVAILABLE'); }
  let rows = 0, bytes = 0;
  async function append(row) {
    const text = JSON.stringify(row) + '\n', size = Buffer.byteLength(text);
    if (rows + 1 > limits.rows || bytes + size > limits.bytes) throw fail('EGRESS_RECEIPT_LIMIT');
    try { await file.writeFile(text); await file.sync(); }
    catch { throw fail('EGRESS_WRITE_FAILED'); }
    rows++; bytes += size;
  }
  try { await append({ type: 'start', version: 1, epochId, engines: [...tracked].map(([engine, state]) => ({ engineIndex: state.index, firstSequence: state.retained.length + 1, identityHash: /^[a-f0-9]{64}$/.test(identityHashes.get(engine) ?? '') ? identityHashes.get(engine) : null })), completeness: 'open', costBasis: 'supplier_meter_only', totals: null }); }
  catch (error) { await file.close().catch(() => {}); throw error; }
  return {
    async capture(engine, { phase, error = null, cellHash = null, runIndex = null, attempt = null } = {}) {
      const state = tracked.get(engine); if (!state) return;
      if (cellHash !== null && !/^[a-f0-9]{64}$/.test(cellHash)) throw fail('EGRESS_RECEIPT_INVALID');
      if (runIndex !== null) count(runIndex);
      if (attempt !== null) count(attempt);
      let receipts;
      try { receipts = engine.getEgressReceipts?.() ?? []; }
      catch { throw fail('EGRESS_RECEIPT_UNAVAILABLE'); }
      if (!Array.isArray(receipts) || receipts.length > limits.rows || receipts.length < state.retained.length) throw fail('EGRESS_RECEIPT_LIMIT');
      for (let i = 0; i < receipts.length; i++) {
        const receipt = sanitize(receipts[i]), serialized = JSON.stringify(receipt);
        if (receipt.sequence !== i + 1 || (i < state.retained.length && state.retained[i] !== serialized)) throw fail('EGRESS_RECEIPT_INVALID');
        if (i < state.retained.length) continue;
        await append({ type: 'receipt', engineIndex: state.index, receipt }); state.retained.push(serialized);
      }
      await append({ type: 'status', engineIndex: state.index, phase: enumeration(phase, ['attempt','cleanup']), outcome: error ? 'error' : 'returned', code: safeCode(error), cellHash, runIndex, attempt, receiptsAvailable: typeof engine.getEgressReceipts === 'function' });
    },
    async finish({ failed, cleanupUncertain, evidenceComplete }) { await append({ type: 'finish', outcome: failed ? 'failed' : 'returned', cleanupUncertain, evidenceComplete, totals: null }); },
    async close() { try { await file.close(); } catch { throw fail('EGRESS_WRITE_FAILED'); } },
  };
}
