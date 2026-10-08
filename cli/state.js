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
import { placementIdentity, attemptSummary, isConclusive, isLinkVerification, validTime } from './placement-projection.js';

export const STATE_VERSION = 3;

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
export function lastCheckedMap(state, entries = null) {
  const identities = entries ? new Map(entries.map(entry => [entry.id, placementIdentity(entry)])) : null;
  return new Map(Object.entries(state.entries ?? {}).filter(([id, record]) => !identities
    || identities.get(id) && record.last_placement === identities.get(id)).map(([id, record]) => [id, record.last_checked]));
}

const methodOf = row => row.result?.evidence?.method ?? null;
const eligible = (row, previous) => validTime(row.checked_at)
  && (!validTime(previous?.last_checked) || Date.parse(row.checked_at) > Date.parse(previous.last_checked));
const repeats = (row, previous) => previous
  && previous.last_placement === placementIdentity(row)
  && previous.last_state === row.state
  && (previous.last_reason ?? null) === (row.reason ?? null)
  && (previous.last_signature ?? null) === (row.result?.linkSignature ?? null)
  && previous.last_complete === (row.complete === true)
  && (previous.last_method ?? null) === methodOf(row)
  && (previous.last_checker_version ?? null) === (row.checker_version ?? row.result?.evidence?.checkerVersion ?? null);

function applyRow(previous, row) {
  const identity = placementIdentity(row);
  const samePlacement = previous?.last_placement === identity;
  const attempt = attemptSummary(row, { retained: !repeats(row, previous) });
  const knownPresent = isConclusive(attempt) && attempt.state === 'present';
  const priorFirst = samePlacement && previous?.first_present_observation?.placement === identity
    && isConclusive(previous.first_present_observation) && previous.first_present_observation.state === 'present'
    ? previous.first_present_observation : null;
  const firstPresent = priorFirst ?? (knownPresent ? attempt : null);
  return {
    ...previous,
    last_checked: row.checked_at,
    last_complete: row.complete === true,
    last_placement: identity,
    last_state: row.state,
    last_reason: row.reason ?? null,
    last_signature: row.result?.linkSignature ?? null,
    last_method: methodOf(row),
    last_checker_version: row.checker_version ?? row.result?.evidence?.checkerVersion ?? null,
    checks: (previous?.checks ?? 0) + 1,
    last_attempt: attempt,
    last_successful_observation: isConclusive(attempt) ? attempt : samePlacement ? previous?.last_successful_observation ?? null : null,
    last_link_verification: isLinkVerification(attempt) ? attempt : samePlacement ? previous?.last_link_verification ?? null : null,
    first_present: firstPresent?.checked_at ?? null,
    first_present_placement: firstPresent ? identity : null,
    first_present_observation: firstPresent,
    ...(samePlacement && previous?.first_present && !previous.first_present_observation
      ? { legacy_first_present: previous.first_present } : {}),
  };
}

/**
 * Splits a run's rows into the ones worth recording and the ones that repeat.
 *
 * A row is worth recording when it is the first for its placement, or when the state, reason,
 * link signature, completeness or method moved. A link that is still present but whose anchor
 * or rel changed is a real event, and comparing only the state would miss it.
 */
export function selectChanged(rows, state) {
  const changed = [], repeated = [], ignored = [];
  const entries = { ...(state.entries ?? {}) };
  for (const row of rows) {
    const previous = entries[row.id];
    if (!eligible(row, previous)) { ignored.push(row); continue; }
    (repeats(row, previous) ? repeated : changed).push(row);
    entries[row.id] = applyRow(previous, row);
  }
  return { changed, repeated, ignored };
}

/** Applies a run to the activity record. Every check counts, recorded or not. */
export function applyRun(state, rows) {
  const entries = { ...(state.entries ?? {}) };
  for (const row of rows) {
    const previous = entries[row.id];
    if (!eligible(row, previous)) continue;
    entries[row.id] = applyRow(previous, row);
  }
  return { ...state, v: STATE_VERSION, entries };
}
