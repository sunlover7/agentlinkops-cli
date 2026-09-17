// `agentlinkops check`: the exact cloud verifier, over a ledger file, without an account.
//
// Two things make it the real thing rather than a lookalike.
//
// **It imports `verifyLink` from `src/verifier/`.** Not a copy, not a port. The cases in
// `test/fixtures/verifier-cases.js` are asserted against both this and the cloud path, so the
// two cannot drift and still show green.
//
// **It paces.** Supplying `beforeFetch` is not politeness garnish: without it the verifier
// REFUSES every host that states a robots crawl delay, and a CLI that skipped it would report
// our own omission to the customer as the publisher's fault.
import { verifyLink } from '../src/verifier/index.js';
import { observationRow } from './mirror.js';
import { cadenceSeconds, DEFAULT_CADENCE } from './ledger.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hostOf = url => { try { return new URL(url).hostname; } catch { return null; } };

/** A courtesy floor per host, honouring a publisher's own stated delay when it is longer. */
export function createPacer({ hostDelayMs = 2000, now = () => Date.now(), wait = sleep } = {}) {
  const nextAllowed = new Map();
  return {
    async beforeFetch(url, context = {}) {
      const host = hostOf(url);
      if (!host) return;
      const stated = Number(context.crawlDelaySeconds ?? 0) * 1000;
      const floor = Math.max(hostDelayMs, Number.isFinite(stated) ? stated : 0);
      const allowed = nextAllowed.get(host) ?? 0;
      const delay = allowed - now();
      if (delay > 0) await wait(delay);
      nextAllowed.set(host, now() + floor);
    },
  };
}

/** Entries a check should visit. `retired` is kept for its history and never fetched. */
export function selectEntries(entries, { filter = null, includeRetired = false } = {}) {
  return entries.filter(entry => {
    if (entry.intent === 'retired' && !includeRetired) return false;
    if (!filter) return true;
    const haystack = [entry.id, entry.source, entry.target, entry.ref ?? '', ...(entry.tags ?? [])].join(' ').toLowerCase();
    return haystack.includes(String(filter).toLowerCase());
  });
}

/**
 * Entries whose cadence says they are due. A check with no `--all` does not refetch the web.
 *
 * `lastChecked` comes from `state.json`, not from the observation mirror, because the mirror
 * only records CHANGES — reading the last check time from it would make an entry that has been
 * stably present for a month look like it had never been checked since the day it appeared.
 */
export function dueEntries(entries, lastChecked, { now = Date.now() } = {}) {
  return entries.filter(entry => {
    const last = lastChecked.get(entry.id);
    if (!last) return true;
    const seconds = cadenceSeconds(entry.cadence ?? DEFAULT_CADENCE[entry.intent] ?? 'daily') ?? 86_400;
    return now - Date.parse(last) >= seconds * 1000;
  });
}

/**
 * Runs the verifier over a set of entries. Hosts run in parallel, a host never runs in parallel
 * with itself, and the result rows come back in the ledger's own order so a diff is stable.
 */
export async function runCheck(entries, {
  concurrency = 6, timeoutMs = 20_000, hostDelayMs = 2000,
  verify = verifyLink, pacer = null, onResult = null,
} = {}) {
  const paced = pacer ?? createPacer({ hostDelayMs });
  const byHost = new Map();
  for (const entry of entries) {
    const host = hostOf(entry.source) ?? entry.id;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(entry);
  }
  const queue = [...byHost.values()];
  const rows = new Map();
  const worker = async () => {
    while (queue.length) {
      for (const entry of queue.pop()) {
        const result = await verify(
          { sourceUrl: entry.source, targetUrl: entry.target, targetScope: entry.scope,
            expectedAnchor: entry.expect?.anchor, expectedRel: entry.expect?.rel },
          // `includeHtml: false` is a contract commitment, not a size optimisation: the bytes
          // must not reach the repository.
          { publicFetchSafe: true, timeoutMs, includeHtml: false, beforeFetch: paced.beforeFetch });
        const row = observationRow(entry.id, result);
        rows.set(entry.id, row);
        onResult?.(entry, row);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return entries.map(entry => rows.get(entry.id)).filter(Boolean);
}

/**
 * The exit code, which is where "unknown is never absent" either holds or quietly stops.
 *
 * Only an `expected` entry observed ABSENT with COMPLETE evidence fails. None of the 471
 * unknowns the T01 benchmark measured is evidence that a link is gone, and a CLI that failed on
 * them would teach people to pass a flag that turns the check off.
 */
export function summarize(entries, rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const counts = { present: 0, absent: 0, unknown: 0, source_unavailable: 0, unchecked: 0 };
  const failures = [], appeared = [];
  for (const entry of entries) {
    const row = byId.get(entry.id);
    if (!row) { counts.unchecked++; continue; }
    counts[row.state] = (counts[row.state] ?? 0) + 1;
    if (entry.intent === 'expected' && row.state === 'absent' && row.complete) failures.push({ entry, row });
    // A `wanted` link that turned up is the whole selling moment, so it is a headline rather
    // than a line in a table.
    if (entry.intent === 'wanted' && row.state === 'present') appeared.push({ entry, row });
  }
  return { counts, failures, appeared, exitCode: failures.length ? 1 : 0 };
}
