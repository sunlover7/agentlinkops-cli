// `agentlinkops platforms`: the per-platform visibility aggregate over verification results.
//
// A placement agent's first question about a self-serve platform is not "can I get a link"
// but "will the link be VISIBLE" — in served HTML a crawler reads, or written by JavaScript
// a crawler never runs, or flattened to plain text, or on a page that is noindexed. Those
// four classes are exactly what the verifier already measures, page by page:
//
//   server-html        the link was found in the served HTML (state `present`, link_found)
//   noindex            the page was read and carries a robots noindex (present or not)
//   js-only            the page provably needs a browser (`possible_render_required`), or an
//                      adjudication found the target only in script / in no served bytes
//   mention-no-anchor  an adjudication found the target in markup but never as a link
//
// What the aggregate REFUSES to do matters as much: an `absent` on a rich page contributes
// the observation but no class vote, because static HTML cannot tell "does not link to us"
// from "links to us via JavaScript" — the T01 decision, kept. A platform with no observations
// is unknown, and nothing about an absent platform is inferred.
//
// The aggregate is claim-free context: counts, classes and dates from real observations, with
// their provenance, and no verdict. It can travel with candidate rows for exactly that reason.
import { readFile } from 'node:fs/promises';

export const PLATFORM_CLASSES = Object.freeze(['server-html', 'js-only', 'mention-no-anchor', 'noindex']);

const normalizeHost = value => {
  try { return new URL(value).hostname.replace(/^www\./u, ''); } catch { return null; }
};

/**
 * One observation row -> one class vote, or none. The precedence is explicit:
 * noindex beats server-html (a link on a noindexed page is present but not visible),
 * and an absent/unknown page never votes js-only unless the verifier or an adjudication
 * PROVED the browser dependency. An `absent` with complete evidence votes nothing.
 */
export function classifyObservation(row) {
  const result = row.result ?? row;
  const noindex = result.directives?.noindex ?? row.noindex ?? null;
  if (result.state === 'present' || row.state === 'present') return noindex ? 'noindex' : 'server-html';
  const reason = result.reason ?? row.reason;
  if (reason === 'possible_render_required') return 'js-only';
  return null;
}

/** A benchmark result row (scripts/verifier-benchmark.mjs shape) classifies the same way. */
export function classifyBenchmarkRow(row) {
  if (row.state === 'present') return row.noindex ? 'noindex' : 'server-html';
  if (row.renderFixable) return 'js-only';
  return null;
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

const dayOf = value => String(value ?? '').slice(0, 10);

/**
 * The aggregate. Sources are stated per platform, because "one adjudication last year" and
 * "eleven checks this month" are different amounts of knowledge and the reader can tell.
 */
export async function platformAggregate({ observations = [], benchmark = [], seed = [] } = {}) {
  const platforms = new Map();
  const observe = (host, { klass, at, source }) => {
    if (!host) return;
    if (!platforms.has(host)) platforms.set(host, {
      platform: host, observations: 0, classes: Object.fromEntries(PLATFORM_CLASSES.map(c => [c, 0])),
      unclassified: 0, last_seen: null, sources: {},
    });
    const row = platforms.get(host);
    row.observations++;
    if (klass) row.classes[klass]++; else row.unclassified++;
    if (!row.last_seen || dayOf(at) > dayOf(row.last_seen)) row.last_seen = dayOf(at);
    row.sources[source] = (row.sources[source] ?? 0) + 1;
  };

  for (const path of observations) {
    for (const row of await readJsonl(path)) {
      observe(normalizeHost(row.result?.sourceUrl ?? row.source), {
        klass: classifyObservation(row), at: row.checked_at, source: row.source === 'cloud' ? 'cloud-observation' : 'local-observation',
      });
    }
  }
  for (const path of benchmark) {
    for (const row of await readJsonl(path)) {
      observe(normalizeHost(row.sourceUrl), {
        klass: classifyBenchmarkRow(row), at: row.checked_at, source: 'verifier-benchmark',
      });
    }
  }
  for (const path of seed) {
    for (const row of await readJsonl(path)) {
      observe(normalizeHost(`https://${row.platform}/`), {
        klass: row.class, at: row.checked_at ?? row.last_seen, source: row.provenance,
      });
    }
  }

  const rows = [...platforms.values()].map(row => {
    const votes = PLATFORM_CLASSES.map(klass => [klass, row.classes[klass]]).filter(([, n]) => n > 0);
    votes.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // A majority needs MORE THAN HALF the classified votes; a tie is not a majority, and
    // zero classified votes is unknown rather than a default.
    const classified = votes.reduce((n, [, count]) => n + count, 0);
    const majority = classified > 0 && votes[0][1] > classified / 2 ? votes[0][0] : null;
    return { ...row, classified, majority_class: majority,
      // "unknown" here means "no class evidence", never "checked and absent".
      status: classified ? 'classified' : 'observed-unclassified' };
  }).sort((a, b) => b.observations - a.observations || a.platform.localeCompare(b.platform));

  return {
    v: 1,
    // No inference from absence: a platform NOT in `platforms` has never been observed,
    // and the CLI prints exactly that when asked about one.
    classes: PLATFORM_CLASSES, platforms: rows,
    totals: {
      platforms: rows.length,
      classified: rows.filter(row => row.classified).length,
      observed_unclassified: rows.filter(row => !row.classified).length,
      observations: rows.reduce((n, row) => n + row.observations, 0),
    },
  };
}

/** Claim-free context for candidate rows: the platform's numbers, or an explicit unknown. */
export function attachToCandidates(candidates, aggregate) {
  const byHost = new Map(aggregate.platforms.map(row => [row.platform, row]));
  return candidates.map(candidate => {
    const host = normalizeHost(candidate.source_url ?? candidate.sourceUrl ?? '');
    const row = host ? byHost.get(host) : null;
    return {
      ...candidate,
      platform_context: row ? {
        platform: row.platform, observations: row.observations, classified: row.classified,
        majority_class: row.majority_class, classes: row.classes, last_seen: row.last_seen, sources: row.sources,
        claim: 'counts_from_our_observations_only',
      } : { platform: host, observations: 0, majority_class: null, claim: 'no_observations_unknown' },
    };
  });
}

export function renderPlatforms(aggregate, query, out = console.log) {
  const rows = query
    ? aggregate.platforms.filter(row => row.platform.includes(query.replace(/^www\./u, '')))
    : aggregate.platforms;
  if (query && !rows.length) {
    out(`no observations for "${query}" — unknown. Nothing is inferred from absence; the platform may be excellent, unmeasured.`);
    return 0;
  }
  out(`platform                 obs  class  majority-class     last-seen   sources`);
  for (const row of rows.slice(0, query ? 50 : 40)) {
    out(`${row.platform.padEnd(24)} ${String(row.observations).padStart(4)} ${String(row.classified).padStart(6)}  `
      + `${(row.majority_class ?? '—').padEnd(16)} ${String(row.unclassified).padStart(3)}u  ${(row.last_seen ?? '').padEnd(10)} ${JSON.stringify(row.sources)}`);
  }
  const t = aggregate.totals;
  out('');
  out(`${t.platforms} platform(s), ${t.classified} with a class, ${t.observed_unclassified} observed without one, ${t.observations} observations total.`);
  out('A platform absent from this list has never been observed by us; that is unknown, not a judgement.');
  if (!query && rows.length > 40) out(`… and ${rows.length - 40} more (pass a HOST substring to filter)`);
  return 0;
}
