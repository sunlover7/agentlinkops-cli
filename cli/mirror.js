// The fact mirror: append-only observations, tool-owned, never hand-edited.
//
// A row carries the verifier's own result object with the HTML removed — byte for byte what
// the cloud stores in `observations.result_json`. That is what makes "the same shape as the
// cloud" testable rather than aspirational.
//
// Raw evidence is never written here. A repository is the wrong place for a publisher's HTML,
// and it is not ours to redistribute; cloud rows carry a key and the bytes stay in private R2
// under their own lifecycle.
import { appendFile, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Strips the bytes and keeps the receipt. The same shape the cloud persists. */
export function observationRow(entryId, result, { source = 'local', evidenceKey = null } = {}) {
  const { html, ...top } = result;
  const { html: rawHtml, body, ...evidence } = top.evidence ?? {};
  const stripped = { ...top, evidence };
  return {
    id: entryId,
    checked_at: result.checkedAt,
    state: result.state,
    reason: result.reason,
    occurrences: result.occurrences?.length ?? 0,
    complete: result.evidence?.complete === true,
    checker_version: result.evidence?.checkerVersion ?? null,
    source,
    evidence_key: evidenceKey,
    result: stripped,
  };
}

/**
 * The natural key of an observation: which entry, when it was checked, and who looked.
 *
 * `checked_at` is the cloud's own timestamp for that observation rather than a local clock, so a
 * replayed event produces a byte-identical key. `source` is in the key because a local check and
 * a cloud check of the same entry at the same instant are two real observations, not a duplicate.
 */
export function observationKey(row) {
  return `${row.id}|${row.checked_at}|${row.source ?? 'local'}`;
}

/**
 * Drops incoming rows the mirror already holds.
 *
 * This exists because of the ORDER sync must write in. Observations are appended first and the
 * cursor advances second, so a crash between them replays that page — which is correct, and is
 * the only ordering that cannot lose an event. Without a dedupe the correct ordering produces
 * duplicate history, and with one it produces none.
 */
export function dedupeObservations(existingRows, incoming) {
  const seen = new Set(existingRows.map(observationKey));
  const fresh = [], duplicates = [];
  for (const row of incoming) {
    const key = observationKey(row);
    if (seen.has(key)) { duplicates.push(row); continue; }
    seen.add(key);
    fresh.push(row);
  }
  return { fresh, duplicates };
}

export async function appendObservations(path, rows) {
  if (!rows.length) return 0;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return rows.length;
}

export async function readObservations(path) {
  let text = '';
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { rows: [], problems: [] }; throw error; }
  const rows = [], problems = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); }
    catch (error) { problems.push({ line: index + 1, reason: error.message }); }
  });
  return { rows, problems };
}

/** The most recent observation per ledger entry, by checked_at then by file order. */
export function latestByEntry(rows) {
  const latest = new Map();
  for (const row of rows) {
    const held = latest.get(row.id);
    if (!held || String(row.checked_at) >= String(held.checked_at)) latest.set(row.id, row);
  }
  return latest;
}

/**
 * Collapses runs of identical observations to the first and last of each run, and records the
 * window collapsed.
 *
 * Never automatic. Silently shrinking a customer's file is not maintenance, and a gap that a
 * reader cannot see reads exactly like a period with no checks — which is the mistake the
 * cloud's own retention had to be built to avoid.
 */
export function compactionPlan(rows) {
  const byEntry = new Map();
  for (const row of rows) {
    if (!byEntry.has(row.id)) byEntry.set(row.id, []);
    byEntry.get(row.id).push(row);
  }
  const keep = new Set(), dropped = [];
  for (const [, entryRows] of byEntry) {
    const ordered = [...entryRows].sort((a, b) => (a.checked_at < b.checked_at ? -1 : 1));
    let previous = null;
    ordered.forEach((row, index) => {
      const boundary = row.state !== previous || index === ordered.length - 1
        || ordered[index + 1]?.state !== row.state;
      if (boundary) keep.add(row); else dropped.push(row);
      previous = row.state;
    });
  }
  return { keep: rows.filter(row => keep.has(row)), dropped };
}

export async function writeObservations(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.obs.tmp`);
  await writeFile(temporary, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  await rename(temporary, path);
}
