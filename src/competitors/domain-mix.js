import { z } from 'zod';
import { validateInventorySnapshot, compareInventoryCollection, COMPETITOR_LIMITS } from './contract.js';
import { discoveryHash } from '../discovery/contract.js';

// The referring-domain mix report (DP-0003-T08).
//
// Compare imported referring-domain classes across customer lanes and selected inventories.
//
// The honesty rules are DP-0003-T06's, reused rather than reinvented:
//   - a rank is `rank_within_dataset`, never `rank`, and the metadata says the ranking scope;
//   - a thing we did not measure is unavailable or unlabelled, never zero or guessed;
//   - one dataset is not a comparison, and a comparison is null rather than an empty object.
//
// The one rule this report adds: CLASS LABELS COME FROM IMPORTED ROWS. A referring domain
// no imported row ever labelled is counted `unlabelled`, and the share of a member's domains
// our labels reach is reported as label coverage. Inferring "generic" from a domain's shape
// would present a guess as an imported label.
export const DOMAIN_MIX_CLASSES = Object.freeze(['generic', 'niche']);

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./u, ''); } catch { return null; } };

export const domainMixOptions = {
  limit: z.number().int().min(1).max(200).optional(),
  maxRetrievalSkewMs: z.number().int().min(0).max(COMPETITOR_LIMITS.retrievalSkewMs).optional(),
};

/** A lane's rows are whatever imported rows already carry: a URL, a class label, maybe a date. */
export const laneRow = z.object({
  source_url: z.string().min(1),
  class: z.string().min(1).nullable().optional(),
  added: z.string().nullable().optional(),
});
export const laneInput = z.object({ lane: z.string().min(1), rows: z.array(laneRow).min(1) });

const coverageOf = snapshot => snapshot?.run?.coverage ?? snapshot?.coverage ?? 'unknown';

/**
 * One side's referring-domain split. `labelFor` maps a host to its imported label or null;
 * every domain it cannot label is counted `unlabelled`, and that count is a COVERAGE fact.
 */
function memberSplit(domains, labelFor, labels, limit) {
  // domains: Map<host, Set<source_url>> — distinct referring pages per host, T06's counting unit.
  const classes = { unlabelled: 0 };
  for (const label of labels) classes[label] = 0;
  const hosts = [];
  for (const [host, pages] of domains) {
    const label = labelFor(host);
    classes[label ?? 'unlabelled']++;
    hosts.push({ host, class: label ?? 'unlabelled', referring_pages: pages.size });
  }
  const labelled = hosts.length - classes.unlabelled;
  hosts.sort((a, b) => b.referring_pages - a.referring_pages || order(a.host, b.host));
  return {
    referring_domains: hosts.length,
    classes,
    labelled_domains: labelled,
    label_coverage: hosts.length ? Number((labelled / hosts.length).toFixed(4)) : null,
    // Ratios are over LABELLED domains only: an unlabelled domain has no class to be in, and a
    // denominator that included it would read unlabelled as niche-by-default.
    generic_share_of_labelled: labelled ? Number(((classes.generic ?? 0) / labelled).toFixed(4)) : null,
    niche_share_of_labelled: labelled ? Number(((classes.niche ?? 0) / labelled).toFixed(4)) : null,
    generic_niche_ratio: (classes.niche ?? 0) ? Number(((classes.generic ?? 0) / classes.niche).toFixed(4)) : null,
    top_domains: hosts.slice(0, limit).map((row, index) => ({ ...row, rank_within_dataset: index + 1 })),
    // The diff needs every domain, not the capped display list; compact on purpose.
    domain_classes: Object.fromEntries(hosts.map(row => [row.host, row.class])),
  };
}

/**
 * The report. `lanes` is one or more labelled lanes (an adopted registry, an imported
 * supplier file); `snapshots` are frozen competitor inventories, and MAY be empty — the
 * report then renders ours alone and states the competitor side is unavailable rather than
 * inventing comparison numbers.
 */
export async function buildDomainMixReport({ set = null, lanes, snapshots = [], ...input }) {
  const options = z.strictObject(domainMixOptions).parse(input);
  const limit = options.limit ?? 25;
  const skew = options.maxRetrievalSkewMs ?? COMPETITOR_LIMITS.retrievalSkewMs;
  const parsedLanes = lanes.map(lane => laneInput.parse(lane));
  if (!parsedLanes.length) throw new Error('DOMAIN_MIX_REQUIRES_A_LANE');
  // Ours alone is a legitimate request (the real lane today: no approved competitor set
  // exists, so there is nothing to validate against). A set becomes required the moment a
  // snapshot is selected, because a frozen inventory only means anything inside one.
  if (snapshots.length && !set) throw new Error('DOMAIN_MIX_REQUIRES_A_SET_FOR_INVENTORIES');

  // The label catalogue every side is classified against: host -> label, from our rows only.
  const labelByHost = new Map();
  const seenLabels = new Set();
  for (const lane of parsedLanes) {
    for (const row of lane.rows) {
      const host = hostOf(row.source_url);
      if (!host) continue;
      if (row.class) { labelByHost.set(host, row.class); seenLabels.add(row.class); }
      else if (!labelByHost.has(host)) labelByHost.set(host, null);
    }
  }
  const labels = [...new Set([...DOMAIN_MIX_CLASSES, ...seenLabels])].filter(l => l !== 'unlabelled').sort();
  const labelFor = host => labelByHost.get(host) ?? null;

  const ours = parsedLanes.map(lane => {
    const domains = new Map();
    for (const row of lane.rows) {
      const host = hostOf(row.source_url);
      if (!host) continue;
      if (!domains.has(host)) domains.set(host, new Set());
      domains.get(host).add(row.source_url);
    }
    return { lane: lane.lane, rows_read: lane.rows.length, ...memberSplit(domains, labelFor, labels, limit) };
  });

  // Competitors: validated snapshots, each split against the same label catalogue. An empty
  // selection is a legitimate request — ours alone — and is stated, not filled with anything.
  const validated = [];
  for (const snapshot of snapshots) validated.push(await validateInventorySnapshot(snapshot, set));
  // A collection comparison is offered only when the datasets support one (T06's rule); with
  // zero or one dataset it is null rather than an empty object, because empty reads as a result.
  let comparison = null;
  if (validated.length > 1) comparison = (await compareInventoryCollection({ set, snapshots: validated, maxRetrievalSkewMs: skew })).comparison;
  const members = [];
  for (const snapshot of validated) {
    const domains = new Map();
    for (const candidate of snapshot.candidates) {
      const host = hostOf(candidate.source_url);
      if (!host) continue;
      if (!domains.has(host)) domains.set(host, new Set());
      domains.get(host).add(candidate.source_url);
    }
    members.push({
      member_id: snapshot.member_id, member_role: snapshot.member_role, inventory_id: snapshot.id,
      coverage: coverageOf(snapshot), ...memberSplit(domains, labelFor, labels, limit),
    });
  }

  const reportHash = await discoveryHash([1, 'competitor_referring_domain_mix',
    parsedLanes.map(lane => lane.lane), validated.map(s => [s.id, s.content_hash]), limit, skew]);
  return {
    metadata: {
      v: 1, kind: 'referring_domain_mix', set_id: set?.id ?? null, set_revision: set?.revision ?? null,
      comparison, ranking_scope: 'selected_inventory_datasets', whole_web_coverage: false,
      absence_claim: 'not_supported',
      // Labels are the customer's own imported vocabulary, applied to domains their rows named.
      label_source: 'imported_row_labels', labels, lanes: parsedLanes.map(lane => lane.lane),
      selected_inventory_ids: validated.map(s => s.id),
      coverage_by_inventory: Object.fromEntries(validated.map(s => [s.id, coverageOf(s)])),
      unselected_member_ids: set ? set.members.filter(m => !validated.some(s => s.member_id === m.id)).map(m => m.id).sort() : [],
      competitor_side_available: validated.length > 0,
      // With no set there is no competitor scope at all, and the report says which side is empty.
      competitor_side_state: validated.length ? 'selected_inventories' : (set ? 'no_inventories_selected' : 'no_approved_competitor_set'),
      report_hash: reportHash, limit,
    },
    ours,
    members,
  };
}

/**
 * A change between two runs renders as a DIFF (the watch pattern), never a fresh page.
 * Comparable means the same lanes and the same selected datasets: a diff across different
 * datasets would present provider index churn as link acquisition, which is DP-0003's
 * founding failure mode.
 */
export function diffDomainMixReports(previous, current) {
  if (!previous || !current) return { comparable: false, reason: 'a report is missing' };
  const sameLanes = JSON.stringify(previous.metadata?.lanes) === JSON.stringify(current.metadata?.lanes);
  const sameDatasets = JSON.stringify(previous.metadata?.selected_inventory_ids) === JSON.stringify(current.metadata?.selected_inventory_ids);
  if (!sameLanes || !sameDatasets) {
    return { comparable: false, reason: sameLanes ? 'selected datasets differ; re-baseline rather than diff across datasets' : 'lanes differ' };
  }
  const sides = [], changes = [];
  const side = (before, after, who) => {
    const beforeHosts = before?.domain_classes ?? {};
    const afterHosts = after?.domain_classes ?? {};
    for (const [host, klass] of Object.entries(afterHosts)) if (!(host in beforeHosts)) changes.push({ who, direction: 'added', host, class: klass });
    for (const [host, klass] of Object.entries(beforeHosts)) if (!(host in afterHosts)) changes.push({ who, direction: 'removed', host, class: klass });
    sides.push({
      who,
      referring_domains: { from: before?.referring_domains ?? null, to: after?.referring_domains ?? null },
      generic_share_of_labelled: { from: before?.generic_share_of_labelled ?? null, to: after?.generic_share_of_labelled ?? null },
      label_coverage: { from: before?.label_coverage ?? null, to: after?.label_coverage ?? null },
    });
  };
  (previous.ours ?? []).forEach((before, index) => side(before, current.ours?.[index], `ours:${before.lane}`));
  (previous.members ?? []).forEach((before, index) => side(before, current.members?.[index], before.member_id));
  return { comparable: true, v: 1, generated_from: current.metadata.report_hash, sides, changes };
}

/** The watch-pattern rendering: `from -> to` per side, one line per changed domain. */
export function renderDomainMixDiff(diff, out = console.log) {
  if (!diff.comparable) { out(`not comparable: ${diff.reason}`); return 0; }
  for (const row of diff.sides) {
    out(`${row.who}  referring-domains ${row.referring_domains.from} -> ${row.referring_domains.to}`
      + `  generic-share ${row.generic_share_of_labelled.from} -> ${row.generic_share_of_labelled.to}`
      + `  label-coverage ${row.label_coverage.from} -> ${row.label_coverage.to}`);
  }
  for (const change of diff.changes) out(`  ${change.direction === 'added' ? '+' : '-'} ${change.class} ${change.host}  (${change.who})`);
  if (!diff.changes.length) out('  no referring-domain changes');
  return 0;
}
