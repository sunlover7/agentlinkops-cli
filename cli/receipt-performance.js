// Optional local context for a receipt report. Never edits the receipt or verification history.
import { newestWinningRows, windowComparison, windowFromRange, assertComparable, pageWithinProperty } from '../src/context/gsc.js';
import { landingPageContext } from '../src/context/ga4.js';

const dayIn = (value, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
function window(value) {
  for (const key of ['start', 'end']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value?.[key] ?? '') || new Date(`${value[key]}T00:00:00Z`).toISOString().slice(0, 10) !== value[key]) throw new Error('performance windows require valid calendar dates');
  }
  return windowFromRange(value.start, value.end);
}
const sameWindow = (a, b) => a?.start === b.start && a?.end === b.end;
const caveats = [
  'Traffic and search changes are observations, not evidence that this action caused ranking or traffic lift.',
  'Content edits, technical changes, other links, seasonality, search updates and measurement changes may explain differences; these alternatives have not been ruled out.',
  'GSC calendar dates use America/Los_Angeles; GA4 retains its property timezone. The populations are separate and are not joined.',
];

export function attachReceiptPerformance(history, spec, { gscRows = [], ga4Rows = [], now = new Date().toISOString() } = {}) {
  if (!spec || typeof spec.receipt_id !== 'string') throw new Error('performance requires receipt_id');
  const selected = history.find(row => row.receipt.id === spec.receipt_id);
  if (!selected) throw new Error('performance receipt_id not found');
  const before = window(spec.before), after = window(spec.after);
  assertComparable(before, after);
  const actedDay = dayIn(selected.receipt.acted_at, 'America/Los_Angeles');
  if (before.end >= actedDay || after.start <= actedDay || after.end >= dayIn(now, 'America/Los_Angeles')) throw new Error('performance windows must exclude the action day and unfinished days');
  if (typeof spec.gsc_property !== 'string' || !pageWithinProperty(selected.receipt.target, spec.gsc_property)) throw new Error('performance requires a GSC property covering the receipt target');
  if (spec.confounders != null && (!Array.isArray(spec.confounders) || spec.confounders.some(v => typeof v !== 'string' || !v.trim()))) throw new Error('confounders must be nonempty strings');
  const page = selected.receipt.target;
  const latest = newestWinningRows(gscRows);
  const rows = latest.filter(row => row.kind === 'gsc.page' && row.page === page && row.property === spec.gsc_property
    && row.type === (spec.search_type ?? 'web') && row.aggregationType === 'byPage' && JSON.stringify(row.dimensions) === '["page"]' && row.dataState === 'final');
  const a = rows.find(row => sameWindow(row.window, after)), b = rows.find(row => sameWindow(row.window, before));
  let search;
  if (!a || !b) search = { state: 'missing_window', delta: null };
  else if ([a, b].some(row => latest.some(marker => marker.kind === 'gsc.window' && marker.property === row.property
    && marker.type === row.type && marker.aggregationType === row.aggregationType && marker.dataState === row.dataState
    && JSON.stringify(marker.dimensions) === JSON.stringify(row.dimensions) && sameWindow(marker.window, row.window)
    && (marker.fetched_at ?? '') > (row.fetched_at ?? '')))) search = { state: 'superseded_window', delta: null };
  else if ([a, b].some(row => row.first_incomplete_date || row.incomplete || row.truncated)) search = { state: 'incomplete_window', delta: null };
  else if ([a, b].some(row => ['clicks', 'impressions', 'position'].some(key => !Number.isFinite(row[key])))) search = { state: 'missing_metrics', delta: null };
  else search = windowComparison({ rows: [a, b], windowA: after, windowB: before, property: spec.gsc_property, page });
  search = { ...search, property: spec.gsc_property, page, timezone: 'America/Los_Angeles', before: b ?? null, after: a ?? null, delta_direction: 'after_minus_before' };
  let business = { state: 'ga4_absent', before: null, after: null };
  if (spec.ga4_property) {
    const propertyRows = ga4Rows.filter(row => row.property === spec.ga4_property);
    const read = wanted => ({ ...landingPageContext({ rows: propertyRows, page, window: wanted, connection: { property: spec.ga4_property, grant: 'unknown' } }),
      provenance: propertyRows.filter(row => sameWindow(row.window, wanted)).map(row => ({ fetched_at: row.fetched_at ?? null, retrieved_by: row.retrieved_by ?? null })) });
    business = { relation: 'side_by_side_not_joined', property: spec.ga4_property, before: read(before), after: read(after), delta: null };
    const zones = [business.before.time_zone, business.after.time_zone];
    const comparable = zones[0] && zones[0] === zones[1] && business.before.state === 'ok' && business.after.state === 'ok'
      && before.end < dayIn(selected.receipt.acted_at, zones[0]) && after.start > dayIn(selected.receipt.acted_at, zones[0])
      && after.end < dayIn(now, zones[0]) && business.before.currency_code === business.after.currency_code;
    business.state = comparable ? 'dated_context' : 'not_comparable';
  }
  const performance_context = {
    generated_at: now, receipt_id: selected.receipt.id, acted_at: selected.receipt.acted_at,
    declared_at: selected.receipt.declared_at, verification_baseline: selected.receipt.baseline,
    windows: { before, after, action_day_excluded: actedDay }, search, business,
    confounders: { reported: spec.confounders ?? [], assessment: 'not_ruled_out' }, caveats,
    attribution: 'not_established',
  };
  return history.map(row => row === selected ? { ...row, performance_context } : row);
}
