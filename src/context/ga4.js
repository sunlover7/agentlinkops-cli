// Optional GA4 business context (DP-0017-T04), implemented against the
// [first-party context contract](../../docs/initiatives/DP-0017-first-party-search-context/first-party-context-contract.md).
//
// The rule this module is built on: GA4 measures SITE behavior in aggregate. It never identifies a
// person, it never carries a search query, and it never says a placement, a query or this tool's
// work earned anything. So the module is structurally incapable of the invention the acceptance
// forbids: the report validator allowlists exactly three aggregate dimensions (landing page,
// event name, date), refuses the query-bearing dimensions by name, refuses person-level
// dimensions by name, and every output carries property, window and measurement caveats with the
// two-layer (search / business) presentation constructed side by side, never joined.
//
// The consent is separate: analytics.readonly ONLY, never bundled into the GSC grant, and no other
// Google scope is requested here. Absent GA4 is a valid complete configuration — `client: null`
// resolves to `ga4_absent`, writes nothing, throws nothing, and the manual/GSC core path never
// consults this module. No credentials are authorized for this repository; every state below is
// proven by fixture clients in test/context-ga4.test.js, and the HTTP transports at the bottom
// exist for the day a customer connects their own property.
//
// Google facts this module encodes were verified against official documentation on 2026-09-12;
// see ga4-context-implementation-2026-09-12.md in the card folder for the citations.
import { rm, readFile } from 'node:fs/promises';
import { readJsonl, appendJsonl, readJson, writeJson, isValidDay, daysBetween, numberOrNullOr } from './util.js';
import { ContextError, recentWindows, pageContext as gscPageContext } from './gsc.js';

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const GA4_RETRIEVED_BY = 'linktrail-ga4';

export const GA4_STATES = Object.freeze([
  'ok', 'ga4_absent', 'ga4_not_authorized', 'ga4_revoked', 'ga4_property_not_found',
  'ga4_empty_window', 'ga4_no_row_for_page', 'ga4_thresholded', 'ga4_sampled',
  'ga4_data_loss_other_row', 'ga4_metric_restricted', 'ga4_truncated', 'ga4_no_key_events_configured',
  'ga4_quota_exceeded',
]);

export const GA4_LIMITS = Object.freeze({
  // The product envelope, enforced on ourselves so a refresh is cheap by construction. GA4's own
  // documented envelope is far larger (200,000 core tokens per property per day, 40,000 per hour;
  // 10 concurrent per property — we run strictly sequential), so this cap can never surprise it.
  refreshReportsPerProperty: 4,     // default budget: one window x (landing pages, landing pages x key events)
  hardCapReportsPerRun: 10,         // absolute ceiling across every property in one run
  keyEventListPageSize: 200,        // the Admin API's documented maximum for keyEvents.list
  keyEventListPages: 2,             // bounded pagination; beyond this the config read is partial and says so
  defaultRowLimit: 10_000,          // the Data API's documented default when limit is unspecified
  rowLimitCap: 250_000,             // the Data API's documented maximum rows returned per request
  freshnessMs: 6 * 60 * 60 * 1000,  // identical re-query inside this window is served from the repo
  quotaRetries: 1,                  // one retry after the wait, then stop
  quotaRetryWaitMs: 15 * 60_000,
});

// The three aggregate shapes this module may request. Nothing else: no channel, no source, no
// audience, no query. The allowlist is the "no invented query-to-person join" acceptance made
// structural — a join cannot be built downstream from data that was never fetched.
export const GA4_REPORT_SHAPES = Object.freeze([
  Object.freeze(['landingPagePlusQueryString']),
  Object.freeze(['landingPagePlusQueryString', 'eventName']),
  Object.freeze(['date']),
]);
export const GA4_REPORT_METRICS = Object.freeze(['sessions', 'keyEvents', 'eventCount', 'totalRevenue']);

// Refused by name, each with the rule that made the refusal. These names exist in GA4's wider
// dictionary (paid-ads search queries, site-search terms, person identifiers, thresholded
// audiences); none of them may enter a business-context report.
export const GA4_QUERY_DIMENSIONS = Object.freeze(['searchTerm', 'googleAdsQuery', 'firstUserGoogleAdsQuery', 'sa360Query', 'firstUserSa360Query']);
export const GA4_PERSON_DIMENSIONS = Object.freeze(['userId', 'clientId', 'userKey']);
export const GA4_THRESHOLD_DIMENSIONS = Object.freeze(['userAgeBracket', 'userGender', 'brandingInterest', 'audienceId', 'audienceName']);

// Measurement caveats carried on every output that could be misread. Codes travel on fact rows;
// the sentences travel with the read.
export const GA4_CAVEATS = Object.freeze({
  zero_rows_omitted: 'GA4 omits rows where every metric is 0 (keepEmptyRows defaults to false): a landing page with no returned row had no reported activity, which is not a claim about visitors no tracker saw.',
  other_row: 'Some dimension combinations were rolled into an "(other)" row (dataLossFromOtherRow): sums over the returned rows are floors, never complete totals.',
  thresholding: 'The report was subject to GA4 data thresholds (subjectToThresholding): only data meeting minimum aggregation thresholds is returned.',
  sampling: 'The report was sampled: a subset of the property\'s events was analyzed, not all of them.',
  metric_restricted: 'The viewer\'s role restricts one or more requested metrics (schema restrictions); restricted values are absent rather than approximated.',
  currency: 'Revenue is GA4 totalRevenue in the property\'s currency (currencyCode carried). It is not an earnings claim and is not attributable to any placement, query or campaign.',
  counting: 'keyEvents counts key events per the counting method configured on the property (carried verbatim from the Admin API); the method decides whether one session can contribute more than once.',
  attribution: 'GA4 measures site behavior under its own attribution. Nothing here attributes sessions, key events or revenue to a search query, a backlink, a placement, or this tool\'s work.',
  no_join: 'GSC measures search behavior; GA4 measures site behavior. Different populations, different measurement: the two are carried as separate labeled layers, no join is constructed, and none may be inferred.',
  property_dates: 'Dates are the property\'s calendar days (timeZone carried from the response); windows are requested as whole days and no cross-zone alignment is performed.',
  match_basis: 'GA4 reports landing pages as page path + query string, not full URLs. A page is matched by path after stripping the origin — a path match, not an identity.',
});

const isoOf = value => (value instanceof Date ? value : new Date(value)).toISOString();
export const isGa4AuthorizationLoss = status => status === 401 || status === 403;

/** The shared state file, coalesced: absent means "nothing recorded yet", not null dereference. */
const readGa4State = async path => (await readJson(path)) ?? {};

// ---------------------------------------------------------------------------
// Property identity. GA4 properties are "properties/<numeric id>" in every API path.
// ---------------------------------------------------------------------------

/** Accepts `properties/123`, `123` or `123` numeric; normalizes to `properties/<id>`. */
export function parseGa4Property(input) {
  const text = String(input ?? '').trim();
  const id = text.startsWith('properties/') ? text.slice('properties/'.length) : text;
  if (!/^\d{1,16}$/u.test(id)) throw new ContextError('invalid_ga4_property', { input: String(input).slice(0, 64) });
  return `properties/${id}`;
}

// ---------------------------------------------------------------------------
// Report validation — the structural no-join guard.
// ---------------------------------------------------------------------------

/**
 * Validates one runReport shape. Dimensions must be exactly one of the three allowed combinations;
 * metrics must come from the allowlist. Query-bearing dimensions, person-level dimensions and
 * thresholded dimensions are refused BY NAME, each with its own error reason, so the refusal
 * itself is visible in tests and logs rather than silently absent from an allowlist.
 */
export function validateGa4Report({ dimensions = [], metrics = ['sessions', 'keyEvents', 'eventCount', 'totalRevenue'], rowLimit } = {}) {
  for (const dimension of dimensions) {
    if (GA4_QUERY_DIMENSIONS.includes(dimension)) throw new ContextError('query_dimension_refused', { dimension, rule: 'no invented query-to-person joins: search-query text never enters GA4 business context' });
    if (GA4_PERSON_DIMENSIONS.includes(dimension)) throw new ContextError('person_level_dimension_refused', { dimension, rule: 'aggregate business context only; no person-level data' });
    if (GA4_THRESHOLD_DIMENSIONS.includes(dimension)) throw new ContextError('thresholded_dimension_refused', { dimension, rule: 'kept off the thresholding budget; an aggregate profile does not need demographics or audiences' });
    if (!GA4_REPORT_SHAPES.some(shape => shape.includes(dimension))) throw new ContextError('dimension_not_allowed', { dimension, allowed: GA4_REPORT_SHAPES.flat() });
  }
  const shapeMatches = GA4_REPORT_SHAPES.some(shape => shape.length === dimensions.length && shape.every((d, i) => dimensions[i] === d));
  if (!shapeMatches) throw new ContextError('unsupported_dimension_combination', { dimensions, allowed: GA4_REPORT_SHAPES.map(s => [...s]) });
  for (const metric of metrics) {
    if (!GA4_REPORT_METRICS.includes(metric)) throw new ContextError('metric_not_allowed', { metric, allowed: [...GA4_REPORT_METRICS] });
  }
  const limit = rowLimit === undefined ? GA4_LIMITS.defaultRowLimit : Math.round(Number(rowLimit));
  if (!Number.isInteger(limit) || limit < 1 || limit > GA4_LIMITS.rowLimitCap) {
    throw new ContextError('row_limit_out_of_range', { rowLimit, max: GA4_LIMITS.rowLimitCap });
  }
  return { dimensions: [...dimensions], metrics: [...metrics], rowLimit: limit, keepEmptyRows: false };
}

// ---------------------------------------------------------------------------
// Fact rows (ga4.jsonl). Appended, never rewritten; newest answer wins at read.
// ---------------------------------------------------------------------------

export function ga4FactKey(row) {
  const window = row.window ?? {};
  return [row.kind, row.property ?? '', row.landing_page ?? '', row.event_name ?? '', row.date ?? '',
    (row.dimensions ?? []).join('+'), window.start ?? '', window.end ?? ''].join('|');
}

export function newestGa4Rows(rows) {
  const byKey = new Map();
  for (const row of rows ?? []) {
    const key = ga4FactKey(row);
    const stamp = row.fetched_at ?? row.captured_at ?? '';
    const held = byKey.get(key);
    if (!held || stamp >= (held.fetched_at ?? held.captured_at ?? '')) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export async function readGa4Rows(path) { const { rows, problems, missing } = await readJsonl(path); return { rows, problems, missing }; }
export const appendGa4Rows = (path, rows) => appendJsonl(path, rows);

const numberMetric = value => numberOrNullOr(value === undefined || value === null || value === '' ? null : Number(value));

/**
 * One runReport answer becomes fact rows. Metrics are stored raw as GA4 reported them; rates are
 * derived at read time. The response's metadata becomes caveat codes on every row it produced,
 * because a number read without its measurement caveats is a different, stronger claim.
 */
export function rowsFromGa4Response({ property, request, response, window, fetchedAt, retrievedBy = GA4_RETRIEVED_BY }) {
  const apiRows = Array.isArray(response?.rows) ? response.rows : [];
  const metadata = response?.metadata ?? {};
  const sampling = Array.isArray(metadata.samplingMetadatas) && metadata.samplingMetadatas.length
    ? metadata.samplingMetadatas.map(s => ({ samples_read_count: numberMetric(s.samplesReadCount), sampling_space_size: numberMetric(s.samplingSpaceSize) }))
    : null;
  const restrictions = Array.isArray(metadata.schemaRestrictionResponse?.activeMetricRestrictions) ? metadata.schemaRestrictionResponse.activeMetricRestrictions : [];
  const caveats = ['property_dates', 'attribution'];
  if (metadata.dataLossFromOtherRow) caveats.push('other_row');
  if (metadata.subjectToThresholding) caveats.push('thresholding');
  if (sampling) caveats.push('sampling');
  if (restrictions.length) caveats.push('metric_restricted');
  if (request.metrics.includes('keyEvents')) caveats.push('counting');
  if (request.metrics.includes('totalRevenue')) caveats.push('currency');
  const common = {
    property, window, dimensions: [...request.dimensions], metrics: [...request.metrics],
    keep_empty_rows: request.keepEmptyRows, row_count: numberMetric(response?.rowCount) ?? apiRows.length,
    rows_returned: apiRows.length, truncated: apiRows.length >= request.rowLimit,
    currency_code: metadata.currencyCode ?? null, time_zone: metadata.timeZone ?? null,
    empty_reason: metadata.emptyReason ?? null, sampling, metric_restrictions: restrictions.length ? restrictions : null,
    caveats, retrieved_by: retrievedBy, fetched_at: fetchedAt,
  };
  const marker = { ...common, kind: 'ga4.window', landing_page: null, event_name: null, date: null, state: apiRows.length ? 'rows' : 'ga4_empty_window' };
  const indexOf = name => request.dimensions.indexOf(name);
  const factRows = apiRows.map(row => ({
    ...common,
    kind: indexOf('eventName') >= 0 && indexOf('landingPagePlusQueryString') >= 0 ? 'ga4.landing_page_event'
      : indexOf('landingPagePlusQueryString') >= 0 ? 'ga4.landing_page'
        : indexOf('date') >= 0 ? 'ga4.date' : 'ga4.aggregate',
    landing_page: indexOf('landingPagePlusQueryString') >= 0 ? row.dimensionValues?.[indexOf('landingPagePlusQueryString')]?.value ?? null : null,
    event_name: indexOf('eventName') >= 0 ? row.dimensionValues?.[indexOf('eventName')]?.value ?? null : null,
    date: indexOf('date') >= 0 ? row.dimensionValues?.[indexOf('date')]?.value ?? null : null,
    sessions: request.metrics.includes('sessions') ? numberMetric(row.metricValues?.[request.metrics.indexOf('sessions')]?.value) : null,
    key_events: request.metrics.includes('keyEvents') ? numberMetric(row.metricValues?.[request.metrics.indexOf('keyEvents')]?.value) : null,
    event_count: request.metrics.includes('eventCount') ? numberMetric(row.metricValues?.[request.metrics.indexOf('eventCount')]?.value) : null,
    total_revenue: request.metrics.includes('totalRevenue') ? numberMetric(row.metricValues?.[request.metrics.indexOf('totalRevenue')]?.value) : null,
  }));
  return { marker, factRows };
}

/** The configured key events as fact rows (not windowed — they are property configuration). */
export function keyEventsConfigRow({ property, keyEvents, fetchedAt, retrievedBy = GA4_RETRIEVED_BY }) {
  return {
    kind: 'ga4.key_events_config', property, window: null,
    key_events: (keyEvents ?? []).map(event => ({
      event_name: event.eventName ?? null,
      counting_method: event.countingMethod ?? null, // carried verbatim; the enum set is Google's to define
      resource_name: event.name ?? null,
    })),
    retrieved_by: retrievedBy, fetched_at: fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// The Google client interface + the (unused-by-default) HTTP transports. Separate origins for the
// Data API and the Admin API, exactly as documented. Read-only scope only; there is no write verb
// here. Tokens come from the customer's environment at call time — never logged or written.
// ---------------------------------------------------------------------------

export class Ga4ApiError extends Error {
  constructor(api, status, body) { super(`ga4_${api}_http_${status}`); this.name = 'Ga4ApiError'; this.api = api; this.status = status; this.body = body ?? null; }
}

export function createGa4Client({ fetchImpl = globalThis.fetch, dataOrigin = 'https://analyticsdata.googleapis.com', adminOrigin = 'https://analyticsadmin.googleapis.com', accessToken = null, getAccessToken = null } = {}) {
  const token = () => accessToken ?? (typeof getAccessToken === 'function' ? getAccessToken() : null);
  async function call(url, api, method, body = null) {
    const bearer = token();
    if (!bearer) throw new ContextError('no_access_token');
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof ContextError || error instanceof Ga4ApiError) throw error;
      throw new Ga4ApiError(api, 0, { error: String(error?.message ?? error) });
    }
    if (!response.ok) throw new Ga4ApiError(api, response.status, await response.json().catch(() => null));
    return response.json();
  }
  // Frozen on purpose: the surface this card ships is exactly these two read verbs, and the
  // export-boundary test asserts it — no Links verb, no AI-report verb, nothing else.
  return Object.freeze({
    scope: GA4_SCOPE,
    /** Data API runReport: aggregate report rows for one property. */
    async runReport(property, requestBody) {
      return call(`${dataOrigin}/v1beta/${property}:runReport`, 'data', 'POST', requestBody);
    },
    /** Admin API keyEvents.list: the key events configured on the property. */
    async listKeyEvents(property, { pageSize = GA4_LIMITS.keyEventListPageSize, pageToken = null } = {}) {
      const query = new URLSearchParams({ pageSize: String(pageSize), ...(pageToken ? { pageToken } : {}) });
      return call(`${adminOrigin}/v1beta/${property}/keyEvents?${query}`, 'admin', 'GET');
    },
  });
}

// ---------------------------------------------------------------------------
// context-state.json (the shared tool-owned state file; GA4 writes under `ga4`).
// Booleans, property names, dates and key-event names only — never tokens.
// ---------------------------------------------------------------------------

export const ga4FetchKey = ({ property, request }) => [
  property, request.dimensions.join('+'), request.metrics.join('+'),
  request.window.start, request.window.end,
].join('|');

const freshEnough = (stamp, nowMs, lifetimeMs) => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)) && nowMs - Date.parse(stamp) < lifetimeMs;

// ---------------------------------------------------------------------------
// The bounded refresh. Sequential by construction (GA4 caps concurrency at 10 per property; we
// spend 1), under a self-imposed report budget, idempotent by window+shape key inside the
// freshness lifetime, one retry on quota then stop.
// ---------------------------------------------------------------------------

export async function refreshGa4Context({
  client = null, paths, property: wantedProperty = null, windows: wantedWindows = null,
  now = () => new Date(), sleep = () => Promise.resolve(), freshnessMs = GA4_LIMITS.freshnessMs, limits = {},
}) {
  const cap = { ...GA4_LIMITS, ...limits };
  const state = await readGa4State(paths.contextState);
  const fetchedAt = isoOf(now());
  const output = {
    started_at: fetchedAt, state: 'ok', property: null, rows_written: 0, markers_written: 0,
    key_events_configured: null, key_events_config_partial: false,
    calls: { run_report: 0, list_key_events: 0, budget_per_property: cap.refreshReportsPerProperty, hard_cap_per_run: cap.hardCapReportsPerRun },
    served_from_repo: 0, states: [], quota: null, notes: [],
  };

  if (!client) {
    // Absent GA4 is a valid complete configuration. Nothing is written to ga4.jsonl, nothing
    // throws, and the manual/GSC core path never consults this module.
    state.ga4 = { ...(state.ga4 ?? {}), grant: 'none', checked_at: fetchedAt };
    await writeJson(paths.contextState, state);
    output.state = 'ga4_absent';
    output.notes.push('no GA4 connection configured; GSC and manual context are unaffected — absent GA4 never blocks the core path');
    return output;
  }
  if (!wantedProperty) throw new ContextError('ga4_property_required');

  const property = parseGa4Property(wantedProperty);
  output.property = property;

  // 1. The configured key events (Admin API). Bounded pagination; a partial config read says so.
  let keyEvents = [], pageToken = null, pages = 0, configPartial = false;
  for (;;) {
    output.calls.list_key_events++; pages++;
    let body;
    try {
      body = await client.listKeyEvents(property, { pageToken });
    } catch (error) {
      if (error instanceof Ga4ApiError && isGa4AuthorizationLoss(error.status)) {
        state.ga4 = { ...(state.ga4 ?? {}), grant: 'refused', property, last_status: error.status, checked_at: fetchedAt };
        await writeJson(paths.contextState, state);
        output.state = 'ga4_not_authorized';
        return output;
      }
      if (error instanceof Ga4ApiError && error.status === 404) {
        state.ga4 = { ...(state.ga4 ?? {}), grant: 'not_found', property, checked_at: fetchedAt };
        await writeJson(paths.contextState, state);
        output.state = 'ga4_property_not_found';
        output.notes.push(`the Admin API has no property ${property} visible to this grant`);
        return output;
      }
      throw error;
    }
    keyEvents = keyEvents.concat(body?.keyEvents ?? []);
    pageToken = body?.nextPageToken ?? null;
    if (!pageToken || pages >= cap.keyEventListPages) { configPartial = Boolean(pageToken); break; }
  }
  output.key_events_config_partial = configPartial;
  await appendGa4Rows(paths.ga4, [keyEventsConfigRow({ property, keyEvents, fetchedAt })]);
  state.ga4 = { ...(state.ga4 ?? {}), grant: 'ok', property, checked_at: fetchedAt,
    key_events_config: keyEvents.map(event => ({ event_name: event.eventName ?? null, counting_method: event.countingMethod ?? null })) };
  output.key_events_configured = state.ga4.key_events_config;
  if (configPartial) output.notes.push(`key-events config read stopped at ${cap.keyEventListPages} page(s); the list is partial`);
  if (!keyEvents.length) {
    output.states.push('ga4_no_key_events_configured');
    output.notes.push('no key events are configured on this property; keyEvents metrics will report 0 by configuration, not by observation');
  }

  // 2. The report set: one window by default x (landing pages, landing pages x configured key events).
  const windows = wantedWindows ?? recentWindows({ days: 28, count: 1, now });
  const keyEventNames = keyEvents.map(event => event.eventName).filter(Boolean);
  const shapes = [validateGa4Report({ dimensions: ['landingPagePlusQueryString'] })];
  if (keyEventNames.length) shapes.push(validateGa4Report({ dimensions: ['landingPagePlusQueryString', 'eventName'] }));
  const nowMs = Date.parse(now());
  let revoked = false;

  for (const window of windows) {
    for (const shape of shapes) {
      if (output.calls.run_report >= cap.refreshReportsPerProperty || output.calls.run_report >= cap.hardCapReportsPerRun) {
        output.notes.push(`budget reached before ${window.start}..${window.end} ${shape.dimensions.join('+')}`);
        continue;
      }
      const request = { ...shape, window };
      const key = ga4FetchKey({ property, request });
      const lastFetch = state.ga4?.last_fetch?.[key];
      if (freshEnough(lastFetch, nowMs, freshnessMs)) {
        output.served_from_repo++;
        output.states.push('served_from_repo');
        continue;
      }
      const body = {
        dateRanges: [{ startDate: window.start, endDate: window.end }],
        dimensions: shape.dimensions.map(name => ({ name })),
        metrics: shape.metrics.map(name => ({ name })),
        limit: String(shape.rowLimit),
        keepEmptyRows: shape.keepEmptyRows,
        returnPropertyQuota: true,
        ...(shape.dimensions.includes('eventName') && keyEventNames.length
          ? { dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: keyEventNames } } } }
          : {}),
      };
      let response, attempt = 0;
      for (;;) {
        try {
          output.calls.run_report++;
          response = await client.runReport(property, body);
          break;
        } catch (error) {
          if (error instanceof Ga4ApiError && error.status === 429) {
            output.quota = { retries_used: attempt, wait_ms: cap.quotaRetryWaitMs };
            if (attempt >= cap.quotaRetries) {
              output.state = output.state === 'ok' ? 'ga4_quota_exceeded' : output.state;
              output.states.push('ga4_quota_exceeded');
              output.notes.push('GA4 quota refused the request; one retry was made and then the run stopped — a context refresh is never urgent enough to spend the customer\'s tokens');
              await writeJson(paths.contextState, state);
              return output;
            }
            attempt++;
            await sleep(cap.quotaRetryWaitMs);
            continue;
          }
          if (error instanceof Ga4ApiError && isGa4AuthorizationLoss(error.status)) {
            // Revocation mid-run: rows already appended are the customer's own data and are kept.
            state.ga4 = { ...(state.ga4 ?? {}), grant: 'revoked', last_status: error.status, checked_at: fetchedAt };
            await writeJson(paths.contextState, state);
            output.state = 'ga4_revoked';
            output.states.push('ga4_revoked');
            output.notes.push('authorization was lost mid-run; rows already written are retained');
            revoked = true;
            break;
          }
          throw error;
        }
      }
      if (revoked) break;
      const { marker, factRows } = rowsFromGa4Response({ property, request, response, window, fetchedAt });
      await appendGa4Rows(paths.ga4, [...factRows, marker]);
      output.rows_written += factRows.length; output.markers_written++;
      state.ga4 = { ...(state.ga4 ?? {}), last_fetch: { ...(state.ga4?.last_fetch ?? {}), [key]: fetchedAt } };
      const windowState = marker.state === 'ga4_empty_window' ? 'ga4_empty_window'
        : marker.caveats.includes('thresholding') ? 'ga4_thresholded'
          : marker.caveats.includes('sampling') ? 'ga4_sampled'
            : marker.caveats.includes('other_row') ? 'ga4_data_loss_other_row'
              : marker.caveats.includes('metric_restricted') ? 'ga4_metric_restricted'
                : marker.truncated ? 'ga4_truncated' : 'ok';
      output.states.push(windowState);
    }
    if (revoked) break;
  }
  if (state.ga4.grant !== 'revoked') state.ga4.grant = 'ok'; // a later write cannot relabel a refusal
  await writeJson(paths.contextState, state);
  return output;
}

// ---------------------------------------------------------------------------
// Read-time outputs. Counts raw, rates derived, caveats attached to the number.
// ---------------------------------------------------------------------------

/** A full page URL becomes the GA4 landing-page key: path + query string, origin stripped. */
export function ga4LandingPageOf(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return url.pathname + url.search;
  } catch { return null; }
}

const landingPageMatches = (ga4LandingPage, wantedPath) => {
  if (typeof ga4LandingPage !== 'string' || !wantedPath) return false;
  if (ga4LandingPage === wantedPath) return true;
  try { return decodeURIComponent(ga4LandingPage) === decodeURIComponent(wantedPath); } catch { return false; }
};

const caveatNotes = codes => [...new Set(codes ?? [])].map(code => ({ code, note: GA4_CAVEATS[code] ?? code }));
const keyEventsPerSession = (keyEvents, sessions) => keyEvents === null || sessions === null ? null : sessions === 0 ? null : Math.round((keyEvents / sessions) * 10_000) / 10_000;

/**
 * Aggregate landing-page context for one page and window, from the repo's own rows. Resolves to
 * exactly one state, carries property and window on every answer, and attaches the measurement
 * caveats the contributing rows earned. A page with no returned row is named, not zeroed and not
 * mystified: GA4 omits all-zero rows, so absence means "no reported activity".
 */
export function landingPageContext({ rows, page, window: wanted = null, connection = null, config = null } = {}) {
  const latest = newestGa4Rows(rows ?? []);
  const sameWindow = row => !wanted || (row.window?.start === wanted.start && row.window?.end === wanted.end);
  const wantedPath = ga4LandingPageOf(page);
  if (wantedPath === null) return { state: 'ga4_no_row_for_page', page, property: null, window: wanted, totals: null, events: [], caveats: [], notes: ['the page is not a parseable URL; GA4 landing pages are page path + query string'] };
  const pageRows = latest.filter(row => (row.kind === 'ga4.landing_page' || row.kind === 'ga4.landing_page_event')
    && sameWindow(row) && landingPageMatches(row.landing_page, wantedPath));
  const property = pageRows[0]?.property ?? connection?.property ?? null;
  const baseCaveats = ['property_dates', 'match_basis', 'attribution'];
  if (!pageRows.length) {
    if (!connection || connection.grant === 'none') {
      return { state: 'ga4_absent', page, property, window: wanted, totals: null, events: [], caveats: caveatNotes(baseCaveats),
        notes: ['no GA4 connection configured; this business layer is absent and the core path is unaffected'] };
    }
    const marker = latest.find(row => row.kind === 'ga4.window' && sameWindow(row));
    if (marker?.state === 'ga4_empty_window') {
      return { state: 'ga4_empty_window', page, property, window: wanted, totals: null, events: [], caveats: caveatNotes([...baseCaveats, 'zero_rows_omitted']),
        notes: ['GA4 returned no rows at all for this window — a valid state, not an error'] };
    }
    if (connection.grant === 'revoked' || connection.grant === 'refused') {
      return { state: connection.grant === 'revoked' ? 'ga4_revoked' : 'ga4_not_authorized', page, property, window: wanted, totals: null, events: [], caveats: caveatNotes(baseCaveats),
        notes: ['existing rows retained; no new rows are written in this state'] };
    }
    return { state: 'ga4_no_row_for_page', page, property, window: wanted, totals: null, events: [],
      caveats: caveatNotes([...baseCaveats, 'zero_rows_omitted']),
      notes: ['GA4 returned no row for this landing page; the API omits rows where every metric is 0, so this is "no reported activity", not an unknown and not a zero invented by us'] };
  }
  const pageRow = pageRows.find(row => row.kind === 'ga4.landing_page') ?? null;
  const eventRows = pageRows.filter(row => row.kind === 'ga4.landing_page_event');
  const caveats = [...baseCaveats, ...new Set(pageRows.flatMap(row => row.caveats ?? []))];
  const truncated = pageRows.some(row => row.truncated);
  const state = caveats.includes('thresholding') ? 'ga4_thresholded'
    : caveats.includes('sampling') ? 'ga4_sampled'
      : caveats.includes('other_row') ? 'ga4_data_loss_other_row'
        : caveats.includes('metric_restricted') ? 'ga4_metric_restricted'
          : truncated ? 'ga4_truncated' : 'ok';
  return {
    state, page, property,
    window: pageRow?.window ?? eventRows[0]?.window ?? wanted ?? null,
    landing_page: pageRow?.landing_page ?? eventRows[0]?.landing_page ?? null,
    match_basis: 'path_after_origin_strip',
    currency_code: pageRow?.currency_code ?? eventRows[0]?.currency_code ?? null,
    time_zone: pageRow?.time_zone ?? eventRows[0]?.time_zone ?? null,
    totals: pageRow ? {
      sessions: pageRow.sessions, key_events: pageRow.key_events,
      event_count: pageRow.event_count, total_revenue: pageRow.total_revenue,
      key_events_per_session: keyEventsPerSession(pageRow.key_events, pageRow.sessions), // derived at read time
    } : null,
    events: eventRows.map(row => ({
      event_name: row.event_name, key_events: row.key_events, event_count: row.event_count,
      total_revenue: row.total_revenue,
    })),
    rows_returned: pageRows.length, truncated,
    caveats: caveatNotes(caveats),
    notes: truncated ? ['the contributing report hit its row cap; these numbers are the returned rows, not necessarily every row'] : [],
  };
}

/**
 * The configured key events with their observed totals in a window. Config comes from the newest
 * `ga4.key_events_config` fact row (or the state file); totals come from the landing-page x event
 * report. Totals are summed only when no contributing report was capped — a capped sum would be a
 * floor wearing a total's clothes.
 */
export function keyEventsContext({ rows, config = null, window: wanted = null } = {}) {
  const latest = newestGa4Rows(rows ?? []);
  const configRow = latest.find(row => row.kind === 'ga4.key_events_config');
  const configured = config ?? configRow?.key_events ?? [];
  const sameWindow = row => !wanted || (row.window?.start === wanted.start && row.window?.end === wanted.end);
  const eventRows = latest.filter(row => row.kind === 'ga4.landing_page_event' && sameWindow(row));
  const capped = eventRows.some(row => row.truncated) || latest.some(row => row.kind === 'ga4.window' && sameWindow(row) && row.truncated);
  const property = eventRows[0]?.property ?? configRow?.property ?? null;
  const baseCaveats = ['property_dates', 'counting', 'attribution'];
  if (eventRows.some(row => (row.caveats ?? []).includes('currency'))) baseCaveats.push('currency');
  const events = configured.map(entry => {
    const mine = eventRows.filter(row => row.event_name === entry.event_name);
    return {
      event_name: entry.event_name, counting_method: entry.counting_method ?? null,
      key_events: capped || !mine.length ? null : mine.reduce((sum, row) => sum + (row.key_events ?? 0), 0),
      total_revenue: capped || !mine.length ? null : mine.reduce((sum, row) => sum + (row.total_revenue ?? 0), 0),
      basis: capped ? 'rows_capped_totals_withheld' : !mine.length ? 'no_rows_for_event' : 'sum_of_returned_rows',
    };
  });
  return {
    state: configured.length ? (capped ? 'ga4_truncated' : 'ok') : 'ga4_no_key_events_configured',
    property, window: wanted ?? eventRows[0]?.window ?? null,
    key_events: events, totals_withheld_because_capped: capped,
    caveats: caveatNotes(baseCaveats),
    notes: capped ? ['a contributing report hit its row cap; per-event totals are withheld rather than summed from a floor'] : [],
  };
}

/**
 * The side-by-side read the acceptance asks for: the GSC observation layer and the GA4 business
 * layer for one page, carried as SEPARATE labeled layers. This function constructs no join
 * between them, exposes no field that combines a query with a conversion or a revenue figure, and
 * attaches the no-join caveat. The join the customer's agent writes in its own judgment file is
 * its inference to make and label — never this tool's output.
 */
export function businessContextForPage({ gscRows = [], ga4Rows = [], page, window: wanted = null, properties = null, connection = null, ga4Connection = null, manual = null } = {}) {
  const search = gscPageContext({ rows: gscRows, page, window: wanted, properties, connection, manual });
  const business = landingPageContext({ rows: ga4Rows, page, window: wanted, connection: ga4Connection });
  return {
    state: search.state === 'ok' && business.state === 'ok' ? 'ok' : (search.state === 'ok' || business.state === 'ok' ? 'partial' : search.state === 'manual_only' ? 'manual_only' : `${search.state}+${business.state}`),
    page, window: wanted,
    relation: 'side_by_side_not_joined',
    layers: { search, business },
    caveats: caveatNotes(['no_join']),
    notes: ['the search layer observes Google-reported search behavior; the business layer observes GA4-reported site behavior; they measure different populations and are never joined here'],
  };
}

// ---------------------------------------------------------------------------
// Existing-agent GA4 handoff import (connector-supplied, no grant from us). The contract left
// whether GA4 handoffs share the GSC handoff shape to T04: they do, one decision recorded here.
// `retrieved_by` names the connector and is never re-labeled as us; `captured_at` stays the
// connector's; rows missing required fields are refused per file with what is missing; imports
// never overwrite rows we fetched. A GA4 handoff with no Google grant from us is a complete
// configuration, exactly like the GSC one.
// ---------------------------------------------------------------------------

function parseGa4HandoffText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { rows: [], error: 'empty file' };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return { rows: Array.isArray(parsed) ? parsed : [parsed] };
    } catch {
      const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
      const rows = [];
      for (const line of lines) {
        try { rows.push(JSON.parse(line)); } catch { return { rows: [], error: 'not_json' }; }
      }
      return { rows };
    }
  }
  return { rows: [], error: 'unrecognized_handoff_format' };
}

export async function importGa4Handoff({ paths, text = null, file = null, now = () => new Date() } = {}) {
  const raw = text ?? (await readFile(file, 'utf8'));
  const parsed = parseGa4HandoffText(raw);
  if (parsed.error) return { error: parsed.error, accepted: 0, refused: [{ reason: parsed.error }] };
  const existing = (await readGa4Rows(paths.ga4)).rows;
  const ours = new Set(newestGa4Rows(existing).filter(row => row.retrieved_by === GA4_RETRIEVED_BY).map(ga4FactKey));
  const accepted = [], refused = [];
  parsed.rows.forEach((candidate, index) => {
    const missing = [];
    if (!candidate.kind || !String(candidate.kind).startsWith('ga4.')) missing.push('kind (must start "ga4.")');
    if (!candidate.window || !isValidDay(candidate.window.start) || !isValidDay(candidate.window.end)) missing.push('window');
    if (!candidate.property) missing.push('property');
    if (!candidate.retrieved_by || candidate.retrieved_by === GA4_RETRIEVED_BY) missing.push('retrieved_by (the connector must be named, and never us)');
    if (candidate.kind === 'ga4.key_events_config' && missing.length === 1 && missing[0] === 'window') {
      missing.length = 0; // configuration rows are not windowed; the other required fields still apply
    }
    if (missing.length) { refused.push({ row: index + 1, reason: `missing ${missing.join(' and ')}` }); return; }
    const row = {
      ...candidate,
      window: candidate.window ? { start: candidate.window.start.slice(0, 10), end: candidate.window.end.slice(0, 10), days: candidate.window.days ?? daysBetween(candidate.window.start, candidate.window.end) } : null,
      captured_at: candidate.captured_at ?? null,
    };
    if (ours.has(ga4FactKey(row))) { refused.push({ row: index + 1, reason: 'a row we fetched for this key exists; ours is kept' }); return; }
    accepted.push(row);
  });
  await appendGa4Rows(paths.ga4, accepted);
  const state = await readGa4State(paths.contextState);
  const connectors = [...new Set([...(state.ga4?.handoff?.connectors ?? []), ...accepted.map(row => row.retrieved_by)])];
  state.ga4 = { ...(state.ga4 ?? {}), handoff: { connectors, last_import_at: now(), rows_imported: (state.ga4?.handoff?.rows_imported ?? 0) + accepted.length } };
  await writeJson(paths.contextState, state);
  return { accepted: accepted.length, refused, connectors };
}

// ---------------------------------------------------------------------------
// Forget. Deletion is a decision. `--source ga4` removes the GA4 fact rows and the GA4 half of the
// shared state file, and touches nothing else — not manual.md, not site-profile.md, not the GSC
// rows or the GSC connection state.
// ---------------------------------------------------------------------------

export async function forgetGa4Context({ paths } = {}) {
  const removed = [{ name: 'ga4', path: paths.ga4 }];
  await rm(paths.ga4, { force: true });
  const state = await readGa4State(paths.contextState);
  if (state.ga4) {
    delete state.ga4;
    await writeJson(paths.contextState, state);
  }
  return {
    removed,
    kept: [
      { name: 'gsc', path: paths.gsc, owner: 'tool' },
      { name: 'manual', path: paths.manual, owner: 'human/agent' },
      { name: 'siteProfile', path: paths.siteProfile, owner: 'human/agent' },
    ],
    note: 'GA4 fact rows and the GA4 half of the connection state are removed; GSC rows, manual.md and site-profile.md are untouched',
  };
}
