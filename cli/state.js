// `state.json`: when each entry was last checked, and where the cloud cursors are.
//
// This file exists because of a number measured by running the tool: one observation row is
// about 2 KB, so appending every check for a thousand links daily is roughly 700 MB of git
// churn a year, nearly all of it rows saying the same thing as the row above.
//
// So **the mirror records CHANGES and this file records ACTIVITY.** A repeat observation of the
// same state with the same link signature tells a reader nothing they cannot already see, and
// writing it only to compact it away later is doing the work twice. What would be lost — "when
// was this last confirmed" — is exactly what a small, rewritten map answers better.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 2;

/**
 * Brings a state file forward without losing anything it already held.
 *
 * Two rules, and the second is the one that matters. **Every unknown key is preserved**, because
 * this file is written into the customer's repository and a newer version of the tool may have
 * put something there that an older one is about to write back. And **an upgrade never invents a
 * cursor**: a v1 file recorded one `events` cursor and knew nothing about target events, so the
 * target cursor upgrades to `null` — start of feed — rather than being seeded from the source
 * cursor. Seeding it would skip every target event ever emitted, and the feed would look quiet.
 */
export function upgradeState(raw) {
  const state = { ...(raw ?? {}) };
  const version = Number.isInteger(state.v) ? state.v : 1;
  const cursors = { ...(state.cursors ?? {}) };
  if (!('events' in cursors)) cursors.events = null;
  if (!('target_events' in cursors)) cursors.target_events = null;
  return {
    ...state,
    v: STATE_VERSION,
    entries: state.entries ?? {},
    cursors,
    gaps: state.gaps ?? [],
    // Kept so a reader can tell an upgraded file from one written at this version.
    upgraded_from: version < STATE_VERSION ? version : (state.upgraded_from ?? null),
  };
}

export async function readState(path) {
  try { return upgradeState(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return upgradeState({ v: STATE_VERSION, entries: {}, cursors: {} });
    throw error;
  }
}

export async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${crypto.randomUUID()}.state.tmp`);
  // Sorted keys so a run that changes one entry produces a one-line diff.
  const entries = Object.fromEntries(Object.entries(state.entries ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  await writeFile(temporary, `${JSON.stringify({ ...state, entries }, null, 1)}\n`, 'utf8');
  await rename(temporary, path);
}

/** When each entry was last checked, whatever the answer was. */
export function lastCheckedMap(state) {
  return new Map(Object.entries(state.entries ?? {}).map(([id, record]) => [id, record.last_checked]));
}

/**
 * Splits a run's rows into the ones worth recording and the ones that repeat.
 *
 * A row is worth recording when it is the first for its entry, or when the state, the reason or
 * the link signature moved. The signature is in there deliberately: a link that is still present
 * but whose anchor or rel changed is a real event, and comparing only the state would miss it.
 */
export function selectChanged(rows, state) {
  const changed = [], repeated = [];
  for (const row of rows) {
    const previous = state.entries?.[row.id];
    const signature = row.result?.linkSignature ?? null;
    const same = previous
      && previous.last_state === row.state
      && (previous.last_reason ?? null) === (row.reason ?? null)
      && (previous.last_signature ?? null) === signature;
    (same ? repeated : changed).push(row);
  }
  return { changed, repeated };
}

/** Applies a run to the activity record. Every check counts, recorded or not. */
export function applyRun(state, rows) {
  const entries = { ...(state.entries ?? {}) };
  for (const row of rows) {
    const previous = entries[row.id] ?? { checks: 0 };
    entries[row.id] = {
      ...previous,
      last_checked: row.checked_at,
      last_complete: row.complete === true,
      last_placement: row.result?.sourceUrl && row.result?.targetUrl ? JSON.stringify([row.result.sourceUrl, row.result.targetUrl, row.result.targetScope ?? 'exact']) : null,
      last_state: row.state,
      last_reason: row.reason ?? null,
      last_signature: row.result?.linkSignature ?? null,
      checks: (previous.checks ?? 0) + 1,
      // The date a placement was first seen is worth keeping where nothing can compact it away.
      first_present: previous.first_present ?? (row.state === 'present' ? row.checked_at : null),
      first_present_placement: previous.first_present ? previous.first_present_placement ?? null : row.state === 'present' && row.result?.sourceUrl && row.result?.targetUrl ? JSON.stringify([row.result.sourceUrl, row.result.targetUrl, row.result.targetScope ?? 'exact']) : null,
    };
  }
  return { ...state, v: STATE_VERSION, entries };
}
