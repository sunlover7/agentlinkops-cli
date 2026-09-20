// `agentlinkops citation sync` — push local epoch rows to the hosted API
// so the console Citations view shows real data without the hosted scheduler.
// Reads the local citations-epochs.jsonl and POSTs each row to the hosted
// citation_epochs endpoint via the existing REST client.
//
// The sync is one-way (local → hosted) and idempotent: the hosted side
// deduplicates by epoch_id + cell_id. The local ledger is the source of
// truth; the hosted view is a projection.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyLocalEvidenceDigest } from './evidence-integrity.js';

export async function syncEpochs({ dir, api, workspaceId, projectId }) {
  if (!api || !workspaceId || !projectId) {
    throw new Error('citation sync needs api, workspaceId and projectId (connect first: agentlinkops connect)');
  }

  const epochsPath = join(resolve(dir), 'citations-epochs.jsonl');
  let text;
  try {
    text = await readFile(epochsPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { synced: 0, total: 0, errors: 0, note: 'no local epochs found' };
  }

  const rows = text.split('\n').filter((l) => l.trim()).map((l) => {
    return JSON.parse(l);
  });

  if (rows.length === 0) return { synced: 0, total: 0, errors: 0, note: 'epoch file is empty' };

  const normalizedRates = rows.filter(row => Number.isInteger(row.n) && Number.isInteger(row.k) && row.n >= 0 && row.k >= 0 && row.k <= row.n && row.rate !== (row.n ? row.k / row.n : null)).length;
  // Legacy smoothed rates are projected from retained counts; never rewrite the local ledger.
  // Send the epoch rows in batches (the API accepts up to 100 per call)
  let synced = 0;
  let errors = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100).map((row) => ({
      workspace_id: workspaceId,
      project_id: projectId,
      epoch_id: row.epoch_id,
      cell_id: row.cell_id,
      k: row.k,
      n: row.n,
      unknowns: row.unknowns ?? 0,
      mentioned: row.mentioned ?? 0,
      rate: row.n === 0 ? null : row.k / row.n,
      ci_low: row.n === 0 ? null : row.ci_low,
      ci_high: row.n === 0 ? null : row.ci_high,
      classification: row.classification,
      baseline_epoch_id: row.baseline?.epoch_id ?? null,
      baseline_rate: row.baseline?.rate ?? null,
      baseline_ci_low: row.baseline?.ci_low ?? null,
      baseline_ci_high: row.baseline?.ci_high ?? null,
      spent_estimate_usd: row.spent_estimate_usd ?? 0,
      at: row.at,
    }));

    try {
      await api('/v1/commands/sync_citation_epochs', {
        method: 'POST',
        body: { epochs: batch, projectId },
      });
      synced += batch.length;
    } catch (cause) {
      errors += batch.length;
      console.error(`sync batch failed: ${cause.message}`);
    }
  }

  return { synced, errors, total: rows.length, ...(normalizedRates ? { normalized_rates: normalizedRates, normalization: 'Hosted rates projected as k/n (null for n=0); local ledger unchanged.' } : {}) };
}

// Explicit opt-in: raw retained answer text leaves the local ledger only here.
export async function syncEvidence({ dir, api, projectId, cliVersion }) {
  const { lstat, realpath } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { evidenceEnvelopeSchema } = await import('./contract.js');
  const { CITATION_EVIDENCE_LIMITS: limits, citationEvidenceRecordInput } = await import('../../shared/citation-evidence-contract.js');
  if (!api || !projectId || !cliVersion) throw new Error('Evidence sync requires a connected project and CLI version');
  const root = await realpath(resolve(dir));
  let text;
  try { text = await readFile(join(root, 'citations-observations.jsonl'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { synced: 0, total: 0, skipped: 0, errors: 0, reasons: {} }; }
  const rows = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const records = []; const reasons = {}; const seen = new Map();
  const skip = reason => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  async function safeFile(path) {
    const actual = await realpath(path);
    if (!actual.startsWith(root + '/') || !(await lstat(path)).isFile()) throw new Error('Evidence path is not a regular ledger file');
    return actual;
  }
  // Validate the complete local selection before sending any evidence batch.
  for (const row of rows) {
    if (!/^[A-Za-z0-9_.-]+$/.test(row.epoch_id ?? '') || ['.', '..'].includes(row.epoch_id) || !/^[a-f0-9]{64}$/.test(row.evidence_sha256 ?? '')) throw new Error('Malformed local evidence reference');
    const path = join(root, 'citations/evidence', row.epoch_id, `${row.evidence_sha256}.json`);
    const identity = JSON.stringify([row.epoch_id, row.cell_id, row.run_index]);
    if (seen.has(path)) {
      if (seen.get(path) !== identity) throw new Error('Conflicting local evidence reference');
      continue;
    }
    seen.set(path, identity);
    let file;
    try { file = await safeFile(path); } catch (error) { if (error.code === 'ENOENT') { skip('missing_envelope'); continue; } throw error; }
    if ((await lstat(file)).size > limits.envelopeBytes) throw new Error('Evidence envelope exceeds the upload limit');
    const envelopeJson = await readFile(file, 'utf8');
    const envelope = evidenceEnvelopeSchema.parse(JSON.parse(envelopeJson));
    if (envelope.epoch_id !== row.epoch_id || envelope.cell_id !== row.cell_id || envelope.run_index !== row.run_index) throw new Error('Evidence identity does not match its observation');
    if (!verifyLocalEvidenceDigest({ envelope, text: envelopeJson, digest: row.evidence_sha256 })) throw new Error('Evidence digest does not match its retained observation');
    if (envelope.engine_identity.startsWith('google-aio:') && !envelope.provenance) { skip('legacy_aio_without_provenance'); continue; }
    const record = { envelopeJson, sha256: hash(envelopeJson), cliVersion, localEvidenceSha256: row.evidence_sha256 };
    if (envelope.screenshot_file) {
      if (!/^[A-Za-z0-9_.-]+$/.test(envelope.screenshot_file) || ['.', '..'].includes(envelope.screenshot_file)) throw new Error('Unsafe screenshot reference');
      record.screenshot = { reference: envelope.screenshot_file, sha256: null };
      try {
        const image = await safeFile(join(root, 'citations/evidence', row.epoch_id, envelope.screenshot_file));
        if ((await lstat(image)).size <= 10 * 1024 * 1024) record.screenshot.sha256 = hash(await readFile(image));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    records.push(citationEvidenceRecordInput.parse(record));
  }
  const batches = []; let batch = [];
  const bytes = records => Buffer.byteLength(JSON.stringify({ projectId, records }));
  for (const record of records) {
    if (bytes([record]) > limits.requestBytes) throw new Error('Encoded evidence exceeds the request limit');
    if (batch.length && (batch.length >= limits.records || bytes([...batch, record]) > limits.requestBytes)) { batches.push(batch); batch = []; }
    batch.push(record);
  }
  if (batch.length) batches.push(batch);
  let synced = 0; let errors = 0;
  for (const records of batches) {
    try { await api('/v1/commands/ingest_citation_evidence', { method: 'POST', body: { projectId, records } }); synced += records.length; }
    catch { errors += records.length; }
  }
  return { synced, total: seen.size, skipped: Object.values(reasons).reduce((a, b) => a + b, 0), errors, reasons };
}
