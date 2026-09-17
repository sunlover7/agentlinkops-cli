// The ledger: intent, human-owned, one JSON object per line.
//
// Reading is deliberately forgiving of everything except silence. A line that does not parse,
// or an entry that is not valid, is REPORTED with its line number and kept out of the working
// set — never dropped quietly. A tool that discards a customer's row and carries on produces a
// number that is wrong in a way they discover months later.
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const INTENTS = Object.freeze(['wanted', 'expected', 'retired']);
export const SCOPES = Object.freeze(['exact', 'domain', 'subdomain', 'path']);
export const CADENCES = Object.freeze({ daily: 86_400, weekly: 604_800, monthly: 2_592_000 });
// What the cloud accepts, mirrored so a local ledger cannot hold something sync must reject.
export const CADENCE_BOUNDS = Object.freeze({ min: 3_600, max: 2_592_000 });
// Which transition is news, per intent. This is the whole difference between them.
export const DEFAULT_CADENCE = Object.freeze({ wanted: 'weekly', expected: 'daily', retired: null });

// Stable key order, so `fmt` produces a diff that names the entry that changed rather than
// reordering every line.
const KEY_ORDER = ['id', 'intent', 'source', 'target', 'scope', 'expect', 'cadence', 'ref', 'origin', 'tags', 'added', 'note'];

// Where an entry came from, when it was not typed by hand. `placement_run` is adopt-side
// lineage, not import-side: a run's queue holds decisions already made and its output reports
// placements, which is why T09 consumes it through adopt rather than the discovery import lane.
export const ORIGIN_KINDS = Object.freeze(['manual', 'import', 'discovery_candidate', 'mention', 'citation', 'competitor', 'placement_run']);
// What `local_reference` can carry to the cloud. It truncates at 200, and the ledger id plus a
// space goes first — so how much `ref` survives depends on the ID, which is 7 to 35 characters.
// A single constant would be wrong for every entry but one, which is why the check below is a
// function of the entry rather than a number.
export const LOCAL_REFERENCE_LIMIT = 200;

export function newId() {
  return `lk_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

const isUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; }
  catch { return false; }
};

/** Validates one entry and returns it normalised, or throws with a reason a human can act on. */
export function normalizeEntry(input, { assignId = false } = {}) {
  const problems = [];
  const entry = {};
  entry.id = typeof input.id === 'string' && /^lk_[a-z0-9]{4,32}$/.test(input.id)
    ? input.id : (assignId ? newId() : null);
  if (!entry.id) problems.push('id must look like lk_xxxxxxxx');
  entry.intent = INTENTS.includes(input.intent) ? input.intent : null;
  if (!entry.intent) problems.push(`intent must be one of ${INTENTS.join(', ')}`);
  entry.source = isUrl(input.source) ? input.source : null;
  if (!entry.source) problems.push('source must be an http(s) URL');
  entry.target = isUrl(input.target) ? input.target : null;
  if (!entry.target) problems.push('target must be an http(s) URL');
  entry.scope = input.scope ?? 'exact';
  if (!SCOPES.includes(entry.scope)) problems.push(`scope must be one of ${SCOPES.join(', ')}`);

  if (input.expect != null) {
    if (typeof input.expect !== 'object' || Array.isArray(input.expect)) problems.push('expect must be an object');
    else {
      const expect = {};
      if (input.expect.anchor != null) {
        if (typeof input.expect.anchor !== 'string' || input.expect.anchor.length > 1000) problems.push('expect.anchor must be a string of at most 1000 characters');
        else expect.anchor = input.expect.anchor;
      }
      if (input.expect.rel != null) {
        const rel = input.expect.rel;
        if (!Array.isArray(rel) || rel.length > 20 || rel.some(token => typeof token !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(token))) {
          problems.push('expect.rel must be up to 20 relation tokens');
        } else expect.rel = [...new Set(rel.map(token => token.toLowerCase()))].sort();
      }
      if (Object.keys(expect).length) entry.expect = expect;
    }
  }

  const cadence = input.cadence ?? DEFAULT_CADENCE[entry.intent] ?? undefined;
  if (cadence !== undefined && cadence !== null) {
    const seconds = cadenceSeconds(cadence);
    if (seconds === null) problems.push(`cadence must be daily, weekly, monthly or ${CADENCE_BOUNDS.min}-${CADENCE_BOUNDS.max} seconds`);
    else entry.cadence = cadence;
  }
  if (input.ref != null) {
    if (typeof input.ref !== 'string' || input.ref.length > 500) problems.push('ref must be a string of at most 500 characters');
    else entry.ref = input.ref;
  }
  // Lineage: where this entry came from, when a tool produced it rather than a person typing it.
  //
  // **Deliberately its own field and not part of `ref`.** `ref` is the half of `local_reference`
  // the cloud truncates at 200 characters, and how much of it survives depends on the length of
  // the ledger id in front of it — so the same provenance string survives on one entry and is cut
  // on another. A provenance that shortens depending on an unrelated id is one that will name the
  // wrong run, so lineage stays local, where nothing truncates it.
  if (input.origin != null) {
    if (typeof input.origin !== 'object' || Array.isArray(input.origin)) problems.push('origin must be an object');
    else {
      const origin = {};
      if (!ORIGIN_KINDS.includes(input.origin.kind)) problems.push(`origin.kind must be one of ${ORIGIN_KINDS.join(', ')}`);
      else origin.kind = input.origin.kind;
      for (const field of ['id', 'run_id', 'provider', 'observed_at', 'source_url']) {
        if (input.origin[field] == null) continue;
        if (typeof input.origin[field] !== 'string' || input.origin[field].length > 500) problems.push(`origin.${field} must be a string of at most 500 characters`);
        else origin[field] = input.origin[field];
      }
      // An unknown lineage key is kept for the same reason an unknown entry key is.
      for (const [key, value] of Object.entries(input.origin)) if (!(key in origin) && !['kind', 'id', 'run_id', 'provider', 'observed_at', 'source_url'].includes(key)) origin[key] = value;
      if (Object.keys(origin).length) entry.origin = origin;
    }
  }
  if (input.tags != null) {
    if (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== 'string')) problems.push('tags must be an array of strings');
    else if (input.tags.length) entry.tags = [...new Set(input.tags)];
  }
  for (const field of ['added', 'note']) {
    if (input[field] != null) {
      if (typeof input[field] !== 'string') problems.push(`${field} must be a string`);
      else entry[field] = input[field];
    }
  }
  // An unknown key is kept rather than discarded: it is the customer's file, and a future
  // version of this tool may well mean something by it.
  for (const [key, value] of Object.entries(input)) if (!KEY_ORDER.includes(key)) entry[key] = value;
  if (problems.length) {
    const error = new Error(problems.join('; '));
    error.problems = problems;
    throw error;
  }
  return entry;
}

/** `daily` / `weekly` / `monthly` / an integer, to seconds the cloud will accept. */
export function cadenceSeconds(cadence) {
  const seconds = typeof cadence === 'string' ? (CADENCES[cadence] ?? Number(cadence)) : cadence;
  if (!Number.isInteger(seconds) || seconds < CADENCE_BOUNDS.min || seconds > CADENCE_BOUNDS.max) return null;
  return seconds;
}

/**
 * Reads a ledger. Returns the entries that are usable AND every problem found, because a
 * caller that cannot see the problems will report a count that quietly excludes them.
 */
export async function readLedger(path) {
  let text = '';
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { entries: [], problems: [], missing: true }; throw error; }
  const entries = [], problems = [], seen = new Map();
  text.split('\n').forEach((line, index) => {
    const number = index + 1;
    if (!line.trim() || line.trimStart().startsWith('//')) return;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch (error) { problems.push({ line: number, reason: `not valid JSON: ${error.message}` }); return; }
    let entry;
    try { entry = normalizeEntry(parsed); }
    catch (error) { problems.push({ line: number, id: parsed?.id ?? null, reason: error.message }); return; }
    // A duplicate id is an ambiguity, not a preference: which observation history belongs to
    // which entry stops having an answer, so both are reported and neither is guessed at.
    if (seen.has(entry.id)) {
      problems.push({ line: number, id: entry.id, reason: `duplicate id, first seen on line ${seen.get(entry.id)}` });
      return;
    }
    seen.set(entry.id, number);
    entries.push(entry);
  });
  return { entries, problems, missing: false };
}

/** One entry per line, keys in a fixed order, sorted by id. Written atomically. */
export function serializeLedger(entries) {
  const ordered = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ordered.map(entry => {
    const object = {};
    for (const key of KEY_ORDER) if (entry[key] !== undefined) object[key] = entry[key];
    for (const [key, value] of Object.entries(entry)) if (!KEY_ORDER.includes(key)) object[key] = value;
    return JSON.stringify(object);
  }).join('\n') + (ordered.length ? '\n' : '');
}

export async function writeLedger(path, entries) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, serializeLedger(entries), 'utf8');
  await rename(temporary, path);
}

/** Read, validate and replace under one lock. A malformed row prevents every mutation. */
export async function mutateLedger(path, update) {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('Ledger is being updated by another process.');
    throw error;
  });
  try {
    const ledger = await readLedger(path);
    if (ledger.missing) throw new Error('Ledger does not exist.');
    if (ledger.problems.length) throw new Error(`Ledger has invalid rows; repair them before writing (line ${ledger.problems[0].line}).`);
    const result = await update(ledger.entries);
    await writeLedger(path, result);
    return result;
  } finally { await lock.close(); await unlink(lockPath); }
}

/**
 * What the cloud is told about this entry.
 *
 * `localReference` carries the ledger id FIRST and the customer's own reference after it, so
 * the id survives truncation at the cloud's 200-character limit. The id is what makes a
 * corrected URL keep its history; the customer's reference is best-effort and the ledger keeps
 * the full value either way.
 */
export function toWatchInput(entry) {
  // The ledger id always survives; the ref tail may not, and `refTruncatedInTransit` exists so a
  // caller can say so rather than discovering it when a reference comes back short.
  const reference = entry.ref ? `${entry.id} ${entry.ref}` : entry.id;
  return {
    sourceUrl: entry.source, targetUrl: entry.target, targetScope: entry.scope,
    cadenceSeconds: cadenceSeconds(entry.cadence ?? DEFAULT_CADENCE[entry.intent] ?? 'daily'),
    expectedAnchor: entry.expect?.anchor ?? null,
    expectedRel: entry.expect?.rel ?? null,
    localReference: reference.slice(0, 200),
  };
}

/** Whether this entry's `ref` would lose its tail on the way to the cloud. */
export function refTruncatedInTransit(entry) {
  if (typeof entry?.ref !== 'string' || !entry.ref) return false;
  return `${entry.id} ${entry.ref}`.length > LOCAL_REFERENCE_LIMIT;
}

/** The ledger id inside a `localReference`, or null. */
export function ledgerIdOf(localReference) {
  const match = /^(lk_[a-z0-9]{4,32})(?:\s|$)/.exec(localReference ?? '');
  return match ? match[1] : null;
}
