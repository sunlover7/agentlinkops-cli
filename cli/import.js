// `agentlinkops import`: a supplier export becomes candidate rows in the shared shape.
//
// The whole lane exists so that "we do not make you depend on our data" is true today rather
// than after the corpus is built. The customer keeps their supplier; we verify and watch.
import { readFile } from 'node:fs/promises';
import { readTable, CsvError } from './adapters/csv.js';
import { resolveMapping, toImportRow, SUPPLIER_NAMES } from './adapters/suppliers.js';
import { prepareImport } from '../src/discovery/import.js';
import { DISCOVERY_LIMITS } from '../src/discovery/contract.js';

/** Rejection reasons by frequency, with an example line for each. */
export function summarizeReasons(rejected) {
  const groups = new Map();
  for (const entry of rejected) {
    // "source_url: invalid_url" and "source_url: empty" are different problems; the row number
    // inside a reason is not part of the kind.
    const kind = String(entry.reason).replace(/\(.*?\)/gu, '(…)').slice(0, 120);
    if (!groups.has(kind)) groups.set(kind, { reason: kind, count: 0, example_row: entry.row });
    groups.get(kind).count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** `--map source=Referring page URL,target=Target URL` */
export function parseMap(value) {
  if (!value || value === true) return {};
  const overrides = {};
  for (const pair of String(value).split(',')) {
    const index = pair.indexOf('=');
    if (index < 1) throw new CsvError(`--map entries look like field=column, not "${pair}"`, 0);
    overrides[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return overrides;
}

/**
 * Reads an export and reports what it would import. Never writes.
 *
 * Rejections are returned in two layers because they have different causes: a row the FILE could
 * not produce (a short row, a broken delimiter) and a row the CONTRACT would not accept (a bad
 * URL, an unreadable date, a link to someone else's site). Collapsing them into one count would
 * hide which half of the pipeline to look at.
 */
export async function readImport(path, {
  supplier = 'csv', map = {}, target, targetKind = 'domain', includeSubdomains = true,
  runId = 'dr_preview', workspaceId = 'ws_preview', projectId = 'pr_preview', now = new Date().toISOString(),
  supplierGeneratedAt = null,
} = {}) {
  if (!SUPPLIER_NAMES.includes(supplier)) return { error: `unknown supplier "${supplier}". Known: ${SUPPLIER_NAMES.join(', ')}` };
  const text = await readFile(path, 'utf8');
  let table;
  try { table = readTable(text); }
  catch (error) { return { error: error instanceof CsvError ? `line ${error.line}: ${error.message}` : String(error.message) }; }

  const resolved = resolveMapping(table.header, { supplier, overrides: map, targetProvided: Boolean(target) });
  if (resolved.error) return { error: resolved.error, header: table.header };

  const unreadable = table.records.filter(record => record.error).map(record => ({ row: record.line, reason: record.error }));
  const readable = table.records.filter(record => record.values);
  const rows = readable.map(record => toImportRow(record.values, resolved.mapping, resolved.unclaimed));
  // A file with no target column is a file about ONE target, which the operator named with
  // --target. Every row gets that target's site root; the scope below says what "matching"
  // means. Nothing is inferred — without --target the resolver above refuses the file.
  if (!resolved.mapping.target) {
    const targetUrl = targetKind === 'domain' ? `https://${target}/` : target;
    for (const row of rows) row.target_url = targetUrl;
  }

  const targetUrl = targetKind === 'domain' ? `https://${target}/` : target;
  const scope = targetKind === 'exact_url' ? 'exact' : includeSubdomains ? 'domain' : 'subdomain';
  // One discovery run holds at most 1,000 candidates, and real exports are bigger than that —
  // the Settled registry is 2,241 rows. A preview reads the WHOLE file and reports it as one
  // answer; `sync` is where the chunks become runs. Duplicate detection is shared across
  // chunks, so a placement repeated in two different parts of one file is still one candidate.
  const prepared = { accepted: [], rejected: [], duplicates: [] };
  const seen = new Map();
  const chunks = [];
  for (let index = 0; index < rows.length; index += DISCOVERY_LIMITS.rows) chunks.push(index);
  for (const offset of chunks) {
    const part = await prepareImport({
      runId: `${runId}_${offset / DISCOVERY_LIMITS.rows}`, workspaceId, projectId, supplier,
      rows: rows.slice(offset, offset + DISCOVERY_LIMITS.rows), target: targetUrl, scope,
      taskId: 'import_preview', retrievedAt: now, generatedAt: supplierGeneratedAt,
      seen, rowOffset: offset,
    });
    prepared.accepted.push(...part.accepted);
    prepared.rejected.push(...part.rejected);
    prepared.duplicates.push(...part.duplicates);
  }
  // Rejections carry the file's own line numbers, not the array index, so "row 412" means what
  // it means when the customer opens the file.
  const rejected = [
    ...unreadable,
    ...prepared.rejected.map(entry => ({ row: readable[entry.row - 1]?.line ?? entry.row, reason: entry.reason })),
  ].sort((a, b) => a.row - b.row);

  return {
    supplier, mapping: resolved.mapping, unclaimed: resolved.unclaimed, header: table.header,
    rows, accepted: prepared.accepted,
    rejected, duplicates: prepared.duplicates.map(entry => ({ row: readable[entry.row - 1]?.line ?? entry.row, first_seen_on_row: readable[entry.first_seen_on_row - 1]?.line ?? entry.first_seen_on_row })),
    counts: { read: table.records.length, accepted: prepared.accepted.length, rejected: rejected.length, duplicates: prepared.duplicates.length },
    chunks: chunks.length,
    // Grouped, because two thousand identical lines is not a report. When one reason accounts
    // for nearly everything, the MAPPING is wrong rather than the data, and the reader needs to
    // see that in the first line instead of inferring it from scrolling.
    reasons: summarizeReasons(rejected),
  };
}
