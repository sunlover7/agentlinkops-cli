// Read-only GSC context and the manual fallback (DP-0017-T02), implemented against the
// [first-party context contract](../../docs/initiatives/DP-0017-first-party-search-context/first-party-context-contract.md).
//
// The contract's rule runs through every function here: Google OBSERVES search behavior, it
// does not diagnose it, and it never says a placement earned anything. Structured outputs keep
// three layers separate — what Google reported, the derived rate, and nothing else. Inference
// and recommendation live in the human/agent-owned files, never in these rows.
//
// Ownership follows the DP-0014 ledger split: `gsc.jsonl` and `context-state.json` are
// tool-owned facts (appended, never rewritten, newest answer wins at read); `manual.md` is
// human/agent-owned judgment. Absent data follows the verifier's unknown discipline: nulls
// stay null, a truncated top-rows answer is not an inventory, and an unreadable state is
// named, never inferred from emptiness.
//
// No Google credentials are authorized for this project. Every state below is proven by
// fixture clients in test/context-gsc.test.js; the HTTP transport at the bottom exists for the
// day a customer connects their own property and is never exercised by the tests.
import { rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readJsonl, appendJsonl, readJson, writeJson, dayStamp, isValidDay as isDateLike, addDays, daysBetween, parseDay, numberOrNullOr } from './util.js';

const isValidDay = value => isDateLike(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

// The contract's state table, plus `ok` for a clean read. A read resolves to exactly one of
// these; nothing is left to be inferred from an empty result.
export const CONTEXT_STATES = Object.freeze([
  'ok', 'manual_only', 'not_authorized', 'revoked', 'property_not_verified', 'permission_restricted',
  'empty_site', 'incomplete_window', 'truncated_top_rows', 'page_outside_property', 'quota_exceeded',
  'window_before_available_data',
]);

export const RETRIEVED_BY = 'linktrail-gsc';

export const CONTEXT_LIMITS = Object.freeze({
  // The product envelope, enforced on ourselves so a refresh is cheap by construction.
  refreshCallsPerProperty: 12,   // default budget; the standard window set fits under it
  hardCapCallsPerRun: 50,        // absolute ceiling across every property in one run
  rowLimitCap: 25_000,           // the API's own documented maximum
  defaultRowLimit: 1_000,        // the API's documented default
  availabilityProbes: 24,        // bounded backwards monthly probe
  availabilityCacheDays: 30,     // the floor is re-observed at most monthly
  freshnessMs: 6 * 60 * 60 * 1000, // an identical window re-query inside this window is served from the repo
  quotaRetryHintMinutes: 15,     // Google's documented remediation for load quota
  quotaRetries: 1,               // one retry after the hint, then stop
});

export const SEARCH_TYPES = Object.freeze(['web', 'image', 'video', 'news', 'googleNews', 'discover']);
export const AGGREGATION_TYPES = Object.freeze(['byPage', 'byProperty']);
export const DATA_STATES = Object.freeze(['final', 'all']);

export class ContextError extends Error {
  constructor(reason, details = {}) { super(reason); this.name = 'ContextError'; this.reason = reason; this.details = details; }
}

/** True when an HTTP status means the grant is gone (contract: 401/403). */
export const isAuthorizationLoss = status => status === 401 || status === 403;

/** Recorded stamps are always ISO strings: a `now` may yield a Date, and freshness reads strings. */
const isoOf = value => (value instanceof Date ? value : new Date(value)).toISOString();

// ---------------------------------------------------------------------------
// Paths. Standalone on purpose: cli/config.js is not edited by this card. The same
// `.agentlinkops/config.json` `paths` overrides are honoured, with the contract's defaults.
// ---------------------------------------------------------------------------

const CONTEXT_DEFAULT_FILES = Object.freeze({
  gsc: 'context/gsc.jsonl',
  contextState: 'context/context-state.json',
  siteFacts: 'context/site-facts.jsonl',
  manual: 'context/manual.md',
  siteProfile: 'context/site-profile.md',
  ga4: 'context/ga4.jsonl', // T04's tool-owned GA4 fact rows; same config `paths` override as the rest
});

/**
 * Resolves the context file paths. `dir` is the `.agentlinkops/` directory (from the CLI config);
 * `file` is the parsed config.json when available, because every path is a default the customer
 * may move. The contract is deliberately not opinionated about where files live.
 */
export function contextPaths({ dir, file = {} } = {}) {
  const paths = { ...file.paths };
  const at = name => resolve(dir, paths[name] ?? CONTEXT_DEFAULT_FILES[name]);
  return {
    gsc: at('gsc'), contextState: at('contextState'), siteFacts: at('siteFacts'),
    manual: at('manual'), siteProfile: at('siteProfile'), ga4: at('ga4'),
    contextDir: join(dir, 'context'),
  };
}

/** Reads `.agentlinkops/config.json` when present, for callers that only have the directory. */
export async function loadContextConfig(dir) {
  try { return JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Manual inputs — the floor of the whole card. Every later stage runs on manual.md alone.
// ---------------------------------------------------------------------------

const MANUAL_SECTIONS = Object.freeze({
  'target pages': 'target_pages', 'targets': 'target_pages', 'pages': 'target_pages',
  'site description': 'site_description', 'site or niche': 'site_description', 'niche': 'site_description',
  'what we sell': 'offering', 'offering': 'offering', 'business': 'offering',
  'known assets': 'assets', 'assets': 'assets',
  'competitors': 'competitors', 'competitor domains': 'competitors',
});

/**
 * Parses the human-owned manual.md. Permissive by design: sections are matched case-insensitively
 * by heading, entries are the bullet lines under them, and free prose is kept verbatim. Entries
 * carry `source: 'manual'` and no observation date — which is exactly why they never migrate
 * into fact rows.
 */
export function parseManual(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return { present: false, entries: [], target_pages: [], site_description: null, offering: null, assets: [], competitors: [] };
  const parsed = { present: true, entries: [], target_pages: [], site_description: null, offering: null, assets: [], competitors: [] };
  let field = null, prose = [];
  const flushProse = () => {
    if ((field === 'site_description' || field === 'offering') && prose.length) {
      parsed[field] = prose.join(' ').trim();
      parsed.entries.push({ field, value: parsed[field], source: 'manual' });
    }
    prose = [];
  };
  for (const raw of markdown.replace(/^﻿/u, '').split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(raw.trim());
    if (heading) {
      flushProse();
      field = MANUAL_SECTIONS[heading[1].trim().toLowerCase()] ?? null;
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/u.exec(raw);
    const text = raw.trim();
    if (!text || !field) continue;
    if (Array.isArray(parsed[field])) {
      const value = (bullet ? bullet[1] : text).trim();
      if (!value) continue;
      parsed[field].push(value);
      parsed.entries.push({ field, value, source: 'manual' });
    } else if (field === 'site_description' || field === 'offering') {
      // Prose sections keep their sentences; a bullet under them is still the author's words.
      prose.push((bullet ? bullet[1] : text).trim());
    }
  }
  flushProse();
  return parsed;
}

export async function readManual(path) {
  let text = null;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return text === null ? { present: false, entries: [], target_pages: [], site_description: null, offering: null, assets: [], competitors: [] } : parseManual(text);
}

/**
 * The complete no-Google context path. Nothing here needs a connection: the pages a campaign
 * should consider are the manual targets, nominated by judgment, with observation left null
 * rather than invented. The three contract layers are carried separately so nothing collapses
 * into "Google says pursue this".
 */
export function buildManualContext({ manual, pages = null } = {}) {
  const targets = pages ?? manual.target_pages ?? [];
  return {
    state: 'manual_only',
    source: 'manual.md',
    inputs: manual.entries,
    pages: targets.map(page => ({
      page,
      nominated_by: ['manual'],
      observation: null,
      inference: null,   // editable judgment, lives in the profile — never here
      recommendation: null, // a DP-0009 brief's job
    })),
  };
}

// ---------------------------------------------------------------------------
// Windows. Comparable deltas only; incomparable comparisons are refused, not printed.
// ---------------------------------------------------------------------------

export function windowFromRange(start, end) {
  if (!isValidDay(start) || !isValidDay(end)) throw new ContextError('invalid_window', { start, end });
  if (parseDay(end) < parseDay(start)) throw new ContextError('window_end_before_start', { start, end });
  return { start: String(start).slice(0, 10), end: String(end).slice(0, 10), days: daysBetween(start, end) };
}

/**
 * The last `count` contiguous windows of `days` each ending the day before `end` inclusive.
 * `end` defaults to yesterday: Google's property-days are incomplete at the boundary.
 */
export function recentWindows({ days, count = 1, end = null, now = () => new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new ContextError('invalid_window_length', { days });
  if (end != null && !isValidDay(end)) throw new ContextError('invalid_window', { end });
  const last = end ?? addDays(dayStamp(now()), -1);
  const windows = [];
  for (let index = 0; index < count; index++) {
    const windowEnd = addDays(last, -index * days);
    windows.push(windowFromRange(addDays(windowEnd, -(days - 1)), windowEnd));
  }
  return windows.reverse();
}

const overlaps = (a, b) => parseDay(a.start) <= parseDay(b.end) && parseDay(b.start) <= parseDay(a.end);

/**
 * Two windows may be compared only when they are the same length and do not overlap (contiguous
 * or aligned: last-28 vs prior-28, last-7 vs prior-7, the same dates a year apart). Anything
 * else is refused rather than printed with a percent sign — weekly seasonality makes an
 * incomparable delta decoration.
 */
export function assertComparable(a, b, { purpose = 'comparison' } = {}) {
  for (const window of [a, b]) {
    if (!window || !isValidDay(window.start) || !isValidDay(window.end)) throw new ContextError('invalid_window', { purpose });
  }
  if (windowFromRange(a.start, a.end).days !== windowFromRange(b.start, b.end).days) {
    throw new ContextError('windows_not_comparable', { purpose, reason: 'unequal_length', a: { days: a.days }, b: { days: b.days } });
  }
  if (a.start === b.start && a.end === b.end) throw new ContextError('windows_not_comparable', { purpose, reason: 'same_window' });
  if (overlaps(a, b)) throw new ContextError('windows_not_comparable', { purpose, reason: 'overlapping', a, b });
  return true;
}

// ---------------------------------------------------------------------------
// Query validation. aggregationType and type are always explicit; `auto` is not allowed.
// ---------------------------------------------------------------------------

export function validateSearchQuery({ type = 'web', aggregationType, dimensions = [], filters = [], rowLimit, dataState = 'final' } = {}) {
  if (!SEARCH_TYPES.includes(type)) throw new ContextError('unsupported_type', { type });
  if (!aggregationType || aggregationType === 'auto') throw new ContextError('aggregation_type_required', { aggregationType });
  if (!AGGREGATION_TYPES.includes(aggregationType)) throw new ContextError('unsupported_aggregation_type', { aggregationType });
  if (!DATA_STATES.includes(dataState)) throw new ContextError('unsupported_data_state', { dataState });
  // Google's own constraints, kept next to the rule they constrain.
  if ((type === 'discover' || type === 'googleNews') && aggregationType === 'byProperty') {
    throw new ContextError('byProperty_not_supported_for_type', { type });
  }
  const usesPage = dimensions.includes('page') || filters.some(filter => String(filter?.dimension ?? filter) === 'page');
  if (usesPage && aggregationType === 'byProperty') {
    throw new ContextError('page_grouping_cannot_aggregate_by_property');
  }
  const limit = rowLimit === undefined ? CONTEXT_LIMITS.defaultRowLimit : Math.round(Number(rowLimit));
  if (!Number.isInteger(limit) || limit < 1 || limit > CONTEXT_LIMITS.rowLimitCap) {
    throw new ContextError('row_limit_out_of_range', { rowLimit, max: CONTEXT_LIMITS.rowLimitCap });
  }
  return { type, aggregationType, dimensions: [...dimensions], rowLimit: limit, dataState };
}

// ---------------------------------------------------------------------------
// Property coverage — checked, never assumed.
// ---------------------------------------------------------------------------

/**
 * `sc-domain:example.com` covers the domain and every subdomain; a URL-prefix property covers
 * exactly that prefix. Anything else is outside.
 */
export function pageWithinProperty(pageUrl, siteUrl) {
  let page, site;
  try { page = new URL(pageUrl); } catch { return false; }
  if (typeof siteUrl !== 'string' || !siteUrl) return false;
  if (siteUrl.toLowerCase().startsWith('sc-domain:')) {
    const domain = siteUrl.slice('sc-domain:'.length).toLowerCase().replace(/^www\./u, '');
    if (!domain) return false;
    const host = page.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  try { site = new URL(siteUrl); } catch { return false; }
  if (page.hostname !== site.hostname) return false;
  return (page.pathname + page.search).startsWith(site.pathname);
}

/**
 * The state for a target page against the connected properties: `covered`, or
 * `page_outside_property` — never a row of zeros invented for an uncovered page.
 */
export function classifyPageCoverage(pageUrl, properties) {
  const list = Array.isArray(properties) ? properties : [];
  return list.some(property => pageWithinProperty(pageUrl, typeof property === 'string' ? property : property.siteUrl))
    ? 'covered' : 'page_outside_property';
}

// ---------------------------------------------------------------------------
// Fact rows. Appended, never rewritten; a changed answer is a new row; newest wins at read.
// ---------------------------------------------------------------------------

export function factKey(row) {
  const window = row.window ?? {};
  return [row.kind, row.property ?? '', row.page ?? '', row.query ?? '', row.type ?? 'web',
    row.aggregationType ?? '', (row.dimensions ?? []).join('+'), row.dataState ?? 'final',
    window.start ?? '', window.end ?? ''].join('|');
}

/** Newest row per key. `fetched_at`/`captured_at` order, file order breaking ties (last wins). */
export function newestWinningRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = factKey(row);
    const stamp = row.fetched_at ?? row.captured_at ?? '';
    const held = byKey.get(key);
    if (!held || stamp >= (held.fetched_at ?? held.captured_at ?? '')) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export async function readGscRows(path) { const { rows, problems, missing } = await readJsonl(path); return { rows, problems, missing }; }
export const appendGscRows = (path, rows) => appendJsonl(path, rows);

/**
 * One API answer becomes fact rows. `keys` in the API response map to `page`/`query`/`date`
 * by the dimensions we asked for; metrics are stored raw, rates are computed at read time.
 * A missing metric stays null — zero is an observation, null is the absence of one.
 */
export function rowsFromResponse({ property, request, response, window, fetchedAt, retrievedBy = RETRIEVED_BY }) {
  const apiRows = Array.isArray(response?.rows) ? response.rows : [];
  const dimensions = request.dimensions;
  const daysReported = dimensions.includes('date')
    ? new Set(apiRows.map(row => row.keys?.[dimensions.indexOf('date')]).filter(Boolean)).size
    : null; // not derivable from this grouping; the aggregate says so instead of backfilling
  const common = {
    property, window, type: request.type, aggregationType: request.aggregationType,
    dimensions, dataState: request.dataState, retrieved_by: retrievedBy, fetched_at: fetchedAt,
    rows_returned: apiRows.length,
    truncated: apiRows.length >= request.rowLimit,
    days_requested: window.days,
    days_reported: daysReported,
    days_reported_basis: dimensions.includes('date') ? 'distinct_dates_in_rows' : 'not_derivable_from_grouping',
  };
  const firstIncomplete = response?.responseMetadata?.firstIncompleteDate ?? null;
  const marker = {
    ...common, kind: 'gsc.window', page: null, query: null,
    incomplete: Boolean(firstIncomplete) || request.dataState === 'all',
    first_incomplete_date: firstIncomplete,
    state: apiRows.length ? 'rows' : 'empty_site',
  };
  const factRows = apiRows.map(row => ({
    ...common, kind: dimensions.includes('page') && dimensions.includes('query') ? 'gsc.page_query'
      : dimensions.includes('page') ? 'gsc.page' : dimensions.includes('query') ? 'gsc.query'
      : dimensions.includes('date') ? 'gsc.date' : 'gsc.property',
    page: dimensions.includes('page') ? row.keys?.[dimensions.indexOf('page')] ?? null : null,
    query: dimensions.includes('query') ? row.keys?.[dimensions.indexOf('query')] ?? null : null,
    date: dimensions.includes('date') ? row.keys?.[dimensions.indexOf('date')] ?? null : null,
    clicks: numberOrNullOr(row.clicks), impressions: numberOrNullOr(row.impressions),
    position: numberOrNullOr(row.position),
    first_incomplete_date: firstIncomplete,
  }));
  return { marker, factRows };
}

// ---------------------------------------------------------------------------
// The Google client interface + the (unused-by-default) HTTP transport.
//
// Everything above this line is tested against injected clients. Everything below makes real
// HTTP calls and exists for a customer's own connection; no credentials are authorized for this
// repository, so no test touches it. Tokens come from the customer's environment, are used in
// one header, and are never logged, returned or written to any file.
// ---------------------------------------------------------------------------

export class GscApiError extends Error {
  constructor(status, body) {
    super(`gsc_http_${status}`);
    this.name = 'GscApiError';
    this.status = status;
    this.body = body ?? null;
  }
}

export function apiPath(siteUrl, verb) {
  return `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/${verb}`;
}

/** A client over the real Search Console API. Read-only scope only; there is no write verb here. */
export function createGoogleClient({ fetchImpl = globalThis.fetch, origin = 'https://www.googleapis.com', accessToken = null, getAccessToken = null, now = () => new Date() } = {}) {
  const token = () => accessToken ?? (typeof getAccessToken === 'function' ? getAccessToken() : null);
  async function call(path, body = null) {
    const bearer = token();
    if (!bearer) throw new ContextError('no_access_token');
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof ContextError || error instanceof GscApiError) throw error;
      throw new GscApiError(0, { error: String(error?.message ?? error) });
    }
    if (!response.ok) throw new GscApiError(response.status, await response.json().catch(() => null));
    return response.json();
  }
  // Frozen on purpose: the shipped GSC surface is exactly sites.list + searchanalytics.query —
  // the two read verbs the published API offers that this card uses. No Links verb exists and
  // none may be added quietly; test/context-ga4.test.js asserts the key set.
  return Object.freeze({
    scope: GSC_SCOPE,
    /** sites.list: the properties the customer's account can see, with permission levels. */
    async listSites() {
      const body = await call('/webmasters/v3/sites');
      return (body?.siteEntry ?? []).map(site => ({ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel }));
    },
    /** searchanalytics.query: read-only performance rows for one window and grouping. */
    async searchAnalytics(siteUrl, requestBody) {
      return call(apiPath(siteUrl, 'searchAnalytics/query'), requestBody);
    },
  });
}

// ---------------------------------------------------------------------------
// context-state.json. Connection state, last fetch per window, availability probes.
// Booleans, property names, permission levels and dates only — never tokens.
// ---------------------------------------------------------------------------

export async function readContextState(path) { return (await readJson(path)) ?? {}; }
export const writeContextState = writeJson;

export const fetchKey = ({ property, request }) => [
  property, request.type, request.aggregationType, request.dimensions.join('+'), request.dataState,
  request.window.start, request.window.end,
].join('|');

const freshEnough = (stamp, nowMs, lifetimeMs) => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)) && nowMs - Date.parse(stamp) < lifetimeMs;

// ---------------------------------------------------------------------------
// Availability probe. Google's retention figure is unpinned, so the floor is OBSERVED per
// property: bounded backwards monthly probes, cached, reported as a fact about the property.
// ---------------------------------------------------------------------------

function monthWindow(offset, now) {
  const reference = new Date(now());
  const startOfCurrentMonth = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  const start = new Date(startOfCurrentMonth);
  start.setUTCMonth(start.getUTCMonth() - offset);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return windowFromRange(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
}

/**
 * Probes backwards one month at a time until a month returns no rows; that month's first day is
 * the observed availability floor. Bounded at 24 probes; a floor found by exhaustion is reported
 * as `probe_exhausted`, which is a fact about the probe, not a retention claim.
 */
export async function probeFirstAvailableDate({ client, property, state, now = () => new Date(), onCall = null, maxProbes = CONTEXT_LIMITS.availabilityProbes } = {}) {
  const cached = state.availability?.[property];
  if (cached?.first_available_date !== undefined && freshEnough(cached.probed_at, Date.parse(now()), CONTEXT_LIMITS.availabilityCacheDays * 86_400_000)) {
    return { ...cached, cached: true, calls: 0 };
  }
  let probes = 0;
  for (let offset = 0; offset <= CONTEXT_LIMITS.availabilityProbes; offset++) {
    if (probes >= Math.min(CONTEXT_LIMITS.availabilityProbes, maxProbes)) break;
    const window = monthWindow(offset, now);
    probes++;
    onCall?.();
    const request = validateSearchQuery({ type: 'web', aggregationType: 'byProperty', dimensions: [], rowLimit: 1 });
    const response = await client.searchAnalytics(property, {
      startDate: window.start, endDate: window.end, dimensions: [], type: request.type,
      aggregationType: request.aggregationType, rowLimit: request.rowLimit, dataState: 'final',
    });
    if (!Array.isArray(response?.rows) || response.rows.length === 0) {
      // No rows observed in this month: the floor is its first day. Reported as observed, never
      // as Google's retention policy — a quiet month and a gone month are indistinguishable here,
      // which is exactly why the row carries the probe date and the probe count.
      return { property, first_available_date: window.start, probed_at: isoOf(now()), probes_used: probes, basis: 'observed_first_month_without_rows', calls: probes };
    }
  }
  return { property, first_available_date: null, probed_at: isoOf(now()), probes_used: probes, basis: probes < CONTEXT_LIMITS.availabilityProbes ? 'probe_budget_reached' : 'probe_exhausted_data_in_every_probed_month', calls: probes };
}

// ---------------------------------------------------------------------------
// The bounded refresh.
// ---------------------------------------------------------------------------

const STANDARD_GROUPINGS = Object.freeze([
  { dimensions: ['page'], aggregationType: 'byPage' },
  { dimensions: ['page', 'query'], aggregationType: 'byPage' },
]);

/**
 * Runs the read-only refresh. Cheap by construction: the standard set is three comparable
 * windows x (page, page+query) per property, under the 12-call default budget and the 50-call
 * hard cap; identical re-queries inside the freshness lifetime are served from the repo; a
 * quota refusal becomes `quota_exceeded` with the 15-minute hint, one retry, then stop.
 *
 * Every state in the contract's table is produced here and nothing is inferred from emptiness:
 * authorization loss mid-run keeps the rows already written and labels the run `revoked`;
 * restricted or unverified properties are surfaced and skipped; an authorized property with no
 * rows gets a window marker, not an error and not invented zeros.
 */
export async function refreshContext({
  client = null, paths, properties: wantedProperties = null,
  windows: wantedWindows = null, dataState = 'final', now = () => new Date(), sleep = () => Promise.resolve(),
  freshnessMs = CONTEXT_LIMITS.freshnessMs, limits = {},
}) {
  const cap = { ...CONTEXT_LIMITS, ...limits };
  for (const key of ['refreshCallsPerProperty', 'hardCapCallsPerRun']) {
    if (!Number.isInteger(cap[key]) || cap[key] < 0) throw new ContextError('invalid_call_budget', { key });
    cap[key] = Math.min(cap[key], CONTEXT_LIMITS[key]);
  }
  for (const window of wantedWindows ?? []) windowFromRange(window.start, window.end);
  const state = await readContextState(paths.contextState);
  const existing = await readGscRows(paths.gsc);
  const nowMs = Date.parse(now());
  const fetchedAt = isoOf(now());
  const output = {
    started_at: fetchedAt, state: 'ok', properties: [], rows_written: 0, markers_written: 0,
    calls: { search_analytics: 0, list_sites: 0, budget_per_property: cap.refreshCallsPerProperty, hard_cap_per_run: cap.hardCapCallsPerRun },
    served_from_repo: 0, states: [], quota: null, notes: [],
  };

  if (!client) {
    // No connection configured. This is a valid complete configuration, not a failure: manual
    // inputs are the context and every later stage runs on them.
    state.connection = { ...(state.connection ?? {}), grant: 'none', checked_at: fetchedAt };
    await writeContextState(paths.contextState, state);
    output.state = 'manual_only';
    output.notes.push('no Google connection configured; manual.md is the context and handoff rows (if any) are unaffected');
    return output;
  }

  let sites;
  try {
    output.calls.list_sites++;
    sites = await client.listSites();
  } catch (error) {
    if (error instanceof GscApiError && isAuthorizationLoss(error.status)) {
      state.connection = { ...(state.connection ?? {}), grant: 'refused', last_status: error.status, checked_at: fetchedAt };
      await writeContextState(paths.contextState, state);
      output.state = 'not_authorized';
      return output;
    }
    throw error;
  }

  const requested = [...new Set((wantedProperties ?? state.connection?.properties ?? []).map(String))];
  const known = new Map(sites.map(site => [site.siteUrl, site]));
  for (const siteUrl of requested) {
    const site = known.get(siteUrl);
    if (!site) { output.properties.push({ siteUrl, state: 'not_authorized' }); output.states.push('not_authorized'); continue; }
    if (site.permissionLevel === 'siteUnverifiedUser' || site.permissionLevel === 'siteRestrictedUser') {
      // Surfaced to the customer, never silently used.
      const label = site.permissionLevel === 'siteUnverifiedUser' ? 'property_not_verified' : 'permission_restricted';
      output.properties.push({ siteUrl, permissionLevel: site.permissionLevel, state: label, rows_written: 0 });
      output.states.push(label);
      continue;
    }
    await refreshProperty({ siteUrl, site, state, existing, output, paths, client, wantedWindows, dataState, now, nowMs, fetchedAt, sleep, cap, freshnessMs });
  }

  if (!output.properties.length) {
    output.notes.push('no properties requested; pass --property or record properties in context-state.json');
  }
  // A mid-run revocation already wrote `grant: 'revoked'` inside refreshProperty; writing 'ok'
  // over it would relabel a refusal as a success after the fact. Quota stoppage is not a grant
  // state — authorization held, only the envelope ran out.
  const grant = output.state === 'revoked' ? 'revoked' : 'ok';
  state.connection = { ...(state.connection ?? {}), grant, checked_at: fetchedAt, properties: requested, permission_levels: Object.fromEntries(requested.filter(u => known.has(u)).map(u => [u, known.get(u).permissionLevel])) };
  await writeContextState(paths.contextState, state);
  return output;
}

async function refreshProperty({ siteUrl, state, existing, output, paths, client, wantedWindows, dataState, now, nowMs, fetchedAt, sleep, cap, freshnessMs }) {
  const record = { siteUrl, permissionLevel: null, state: 'ok', rows_written: 0, windows: [], calls: 0 };
  output.properties.push(record);

  const windows = wantedWindows ?? recentWindows({ days: 28, count: 2, now }).concat(recentWindows({ days: 7, count: 2, now }));
  const remaining = () => Math.max(0, Math.min(cap.refreshCallsPerProperty - record.calls, cap.hardCapCallsPerRun - output.calls.search_analytics));
  // Availability is optional context. Reserve report calls so long histories cannot spend
  // the entire refresh on probing, repeatedly starving actual page/query reads.
  const reportReserve = Math.min(remaining(), new Set(windows.map(w => `${w.start}|${w.end}`)).size * STANDARD_GROUPINGS.length);
  const available = await probeFirstAvailableDate({
    client, property: siteUrl, state, now, maxProbes: remaining() - reportReserve,
    onCall: () => { record.calls++; output.calls.search_analytics++; },
  });
  state.availability = { ...(state.availability ?? {}), [siteUrl]: { first_available_date: available.first_available_date, probed_at: available.probed_at, probes_used: available.probes_used, basis: available.basis } };
  record.availability = { ...available };
  delete record.availability.calls;

  if (available.basis === 'probe_budget_reached') output.notes.push(`budget reached while probing availability for ${siteUrl}; availability floor remains unknown`);
  const seenWindows = new Set();
  for (const window of windows) {
    if (seenWindows.has(window.start + window.end)) continue;
    seenWindows.add(window.start + window.end);
    if (available.first_available_date && window.end < available.first_available_date) {
      record.windows.push({ window, state: 'window_before_available_data' });
      output.states.push('window_before_available_data');
      continue;
    }
    for (const grouping of STANDARD_GROUPINGS) {
      if (record.calls >= cap.refreshCallsPerProperty || output.calls.search_analytics >= cap.hardCapCallsPerRun) {
        record.windows.push({ window, grouping: grouping.dimensions, state: 'budget_reached', budget: { per_property: cap.refreshCallsPerProperty, hard_cap: cap.hardCapCallsPerRun } });
        output.notes.push(`budget reached before ${window.start}..${window.end} ${grouping.dimensions.join('+')}`);
        continue;
      }
      const request = { ...validateSearchQuery({ type: 'web', aggregationType: grouping.aggregationType, dimensions: grouping.dimensions, dataState }), window };
      const key = fetchKey({ property: siteUrl, request });
      const lastFetch = state.last_fetch?.[key];
      if (freshEnough(lastFetch, nowMs, freshnessMs) && dataState === request.dataState) {
        // Identical re-query, served from the repo. Idempotence by window key.
        output.served_from_repo++;
        record.windows.push({ window, grouping: grouping.dimensions, state: 'served_from_repo' });
        continue;
      }
      let response, attempt = 0;
      for (;;) {
        if (remaining() === 0) {
          record.windows.push({ window, grouping: grouping.dimensions, state: 'budget_reached' });
          record.state = 'budget_reached';
          output.notes.push(`budget reached before retry for ${siteUrl}`);
          return;
        }
        try {
          record.calls++; output.calls.search_analytics++;
          response = await client.searchAnalytics(siteUrl, {
            startDate: window.start, endDate: window.end, dimensions: request.dimensions,
            type: request.type, aggregationType: request.aggregationType,
            rowLimit: request.rowLimit, dataState: request.dataState,
          });
          break;
        } catch (error) {
          if (error instanceof GscApiError && error.status === 429) {
            output.quota = { hint_minutes: cap.quotaRetryHintMinutes, retries_used: attempt };
            if (attempt >= cap.quotaRetries || remaining() === 0) {
              // One retry after the hint, then stop. A context refresh is never so urgent it
              // spends the customer's per-site 1,200 queries per minute.
              output.state = output.state === 'ok' ? 'quota_exceeded' : output.state;
              output.states.push('quota_exceeded');
              record.state = record.state === 'ok' ? 'quota_exceeded' : record.state;
              record.windows.push({ window, grouping: grouping.dimensions, state: 'quota_exceeded', hint_minutes: cap.quotaRetryHintMinutes });
              await writeContextState(paths.contextState, state);
              return;
            }
            attempt++;
            await sleep(cap.quotaRetryHintMinutes * 60_000);
            continue;
          }
          if (error instanceof GscApiError && isAuthorizationLoss(error.status)) {
            // Revocation mid-run: the rows already appended are the customer's own data and are
            // retained; the run is labeled, not rolled back.
            state.connection = { ...(state.connection ?? {}), grant: 'revoked', last_status: error.status, checked_at: fetchedAt };
            await writeContextState(paths.contextState, state);
            output.state = 'revoked';
            output.states.push('revoked');
            record.state = 'revoked';
            record.windows.push({ window, grouping: grouping.dimensions, state: 'revoked', partial: true });
            return;
          }
          throw error;
        }
      }
      const { marker, factRows } = rowsFromResponse({ property: siteUrl, request, response, window, fetchedAt });
      await appendGscRows(paths.gsc, [...factRows, marker]);
      record.rows_written += factRows.length; record.markers_written = (record.markers_written ?? 0) + 1;
      output.rows_written += factRows.length; output.markers_written++;
      state.last_fetch = { ...(state.last_fetch ?? {}), [key]: fetchedAt };
      const windowState = marker.state === 'empty_site' ? 'empty_site'
        : marker.truncated ? 'truncated_top_rows'
        : marker.incomplete ? 'incomplete_window' : 'ok';
      record.windows.push({ window, grouping: grouping.dimensions, state: windowState, rows_returned: marker.rows_returned, truncated: marker.truncated, first_incomplete_date: marker.first_incomplete_date });
      output.states.push(windowState);
    }
  }
  record.state = record.state === 'ok' && record.windows.every(w => ['ok', 'served_from_repo', 'empty_site'].includes(w.state)) ? 'ok' : record.state;
}

// ---------------------------------------------------------------------------
// Read-time outputs. Counts raw, rates derived, position always labeled an average.
// ---------------------------------------------------------------------------

// A rate is derived at read time, never stored. Absent impressions make the rate null: zero is
// an observation, null is the absence of one.
const ctrOf = (clicks, impressions) => {
  if (impressions === null || impressions === undefined || clicks === null || clicks === undefined) return null;
  if (impressions === 0) return 0;
  return Math.round((clicks / impressions) * 10_000) / 10_000;
};

/**
 * Page/query context for one page and window, from the repo's own rows. Resolves to exactly one
 * state. `final_through` names the last final day when preliminary data is in view; final and
 * preliminary are never blended into one number.
 */
export function pageContext({ rows, page, window: wanted = null, properties = null, connection = null, manual = null } = {}) {
  const latest = newestWinningRows(rows ?? []);
  if (properties !== null && properties.length && classifyPageCoverage(page, properties) === 'page_outside_property') {
    return { state: 'page_outside_property', page, properties, rows_returned: 0, queries: [], page_totals: null, notes: ['the page is not under any connected property; no rows are invented for it'] };
  }
  const windowRows = latest.filter(row => row.kind?.startsWith('gsc.') && row.page === page
    && (!wanted || (row.window?.start === wanted.start && row.window?.end === wanted.end)));
  if (!windowRows.length) {
    // No row for this page and window. Why is named, not inferred: an empty_site marker, a
    // pre-floor window, or no connection at all.
    const marker = latest.find(row => row.kind === 'gsc.window' && (!wanted || (row.window?.start === wanted.start && row.window?.end === wanted.end)));
    if (marker?.state === 'empty_site') return { state: 'empty_site', page, window: wanted, rows_returned: 0, queries: [], page_totals: null, notes: ['authorized, property covered, zero rows in this window — a valid state, not an error'] };
    if (wanted && marker && marker.first_incomplete_date && marker.first_incomplete_date <= wanted.end) {
      return { state: 'incomplete_window', page, window: wanted, rows_returned: 0, queries: [], page_totals: null, first_incomplete_date: marker.first_incomplete_date };
    }
    if (connection?.grant === 'revoked' || connection?.grant === 'refused') {
      return { state: connection.grant === 'revoked' ? 'revoked' : 'not_authorized', page, rows_returned: 0, queries: [], page_totals: null, notes: ['existing rows retained; no new rows are written in this state'] };
    }
    return { state: connection?.grant === 'none' || !connection ? 'manual_only' : 'ok', page, rows_returned: 0, queries: [], page_totals: null,
      notes: connection?.grant === 'none' || !connection
        ? ['no Google connection configured; manual inputs are the context' + (manual?.present ? '' : ' and manual.md is absent')]
        : ['the page is not in the returned top rows for this window — which is not the claim "no impressions"'] };
  }
  const pageRow = windowRows.find(row => row.kind === 'gsc.page') ?? null;
  const queryRows = windowRows.filter(row => row.kind === 'gsc.page_query').sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0));
  const truncated = Boolean(pageRow?.truncated) || queryRows.some(row => row.truncated);
  const incomplete = windowRows.some(row => row.first_incomplete_date || row.dataState === 'all');
  const firstIncomplete = windowRows.map(row => row.first_incomplete_date).filter(Boolean).sort()[0] ?? null;
  const state = truncated ? 'truncated_top_rows' : incomplete ? 'incomplete_window' : 'ok';
  return {
    state, page,
    window: pageRow?.window ?? queryRows[0]?.window ?? wanted ?? null,
    type: pageRow?.type ?? 'web', aggregationType: pageRow?.aggregationType ?? 'byPage',
    dataState: pageRow?.dataState ?? 'final',
    final_through: firstIncomplete ? addDays(firstIncomplete, -1) : (pageRow?.window?.end ?? null),
    rows_returned: 1 + queryRows.length, truncated,
    first_incomplete_date: firstIncomplete,
    days_requested: pageRow?.days_requested ?? null,
    days_reported: pageRow?.days_reported ?? null,
    days_reported_basis: pageRow?.days_reported_basis ?? null,
    page_totals: pageRow ? {
      clicks: pageRow.clicks, impressions: pageRow.impressions,
      ctr: ctrOf(pageRow.clicks, pageRow.impressions),
      average_position: pageRow.position, // the API defines position as an AVERAGE position
    } : null,
    queries: queryRows.map(row => ({
      query: row.query, clicks: row.clicks, impressions: row.impressions,
      ctr: ctrOf(row.clicks, row.impressions), average_position: row.position,
    })),
    notes: truncated ? ['top rows only: Google does not guarantee all data rows; a page absent here is "not in the returned top rows", not "no impressions"'] : [],
  };
}

/**
 * Site totals for one window, from `byProperty` rows. Returned rows are never summed into a
 * "site total" when truncation is set — that number would be a floor wearing a total's clothes.
 */
export function siteTotalsContext({ rows, window: wanted, property = null, connection = null } = {}) {
  const latest = newestWinningRows(rows ?? []).filter(row => row.kind === 'gsc.property'
    && (!property || row.property === property)
    && (!wanted || (row.window?.start === wanted.start && row.window?.end === wanted.end)));
  if (!latest.length) {
    const marker = newestWinningRows(rows ?? []).find(row => row.kind === 'gsc.window' && (!wanted || (row.window?.start === wanted.start && row.window?.end === wanted.end)));
    if (marker?.state === 'empty_site') return { state: 'empty_site', window: wanted, totals: null };
    if (connection?.grant === 'none' || !connection) return { state: 'manual_only', window: wanted, totals: null };
    return { state: 'ok', window: wanted, totals: null, notes: ['no byProperty rows for this window'] };
  }
  const row = latest[0];
  if (row.truncated) return { state: 'truncated_top_rows', window: row.window, totals: null, rows_returned: row.rows_returned, notes: ['returned rows hit the cap; a sum of them would be presented as a site total it is not'] };
  return {
    state: row.first_incomplete_date || row.dataState === 'all' ? 'incomplete_window' : 'ok',
    window: row.window, property: row.property, type: row.type, aggregationType: row.aggregationType, dataState: row.dataState,
    totals: { clicks: row.clicks, impressions: row.impressions, ctr: ctrOf(row.clicks, row.impressions), average_position: row.position },
    days_requested: row.days_requested, days_reported: row.days_reported, days_reported_basis: row.days_reported_basis,
  };
}

/** A delta between two comparable windows. Refuses unequal or overlapping windows, and refuses to mix aggregationTypes. */
export function windowComparison({ rows, windowA, windowB, property = null, page = null } = {}) {
  assertComparable(windowA, windowB);
  const latest = newestWinningRows(rows ?? []);
  const pick = window => {
    const kind = page ? 'gsc.page' : 'gsc.property';
    return latest.find(row => row.kind === kind && (!property || row.property === property)
      && (!page || row.page === page)
      && row.window?.start === window.start && row.window?.end === window.end) ?? null;
  };
  const a = pick(windowA), b = pick(windowB);
  if (!a || !b) return { state: 'ok', windows: { a: windowA, b: windowB }, delta: null, missing: [!a && 'a', !b && 'b'].filter(Boolean), notes: ['a window with no rows cannot be delta-ed; absence is reported, never treated as zero'] };
  if (a.aggregationType !== b.aggregationType) throw new ContextError('aggregation_types_mixed', { a: a.aggregationType, b: b.aggregationType });
  const pct = (now, before) => before === null || before === undefined || before === 0 ? null : Math.round(((now - before) / before) * 10_000) / 10_000;
  return {
    state: 'ok', windows: { a: windowA, b: windowB }, property: a.property, page: a.page,
    aggregationType: a.aggregationType,
    delta: {
      clicks: (a.clicks ?? 0) - (b.clicks ?? 0), clicks_change: pct(a.clicks, b.clicks),
      impressions: (a.impressions ?? 0) - (b.impressions ?? 0), impressions_change: pct(a.impressions, b.impressions),
      ctr: ctrOf(a.clicks, a.impressions) === null || ctrOf(b.clicks, b.impressions) === null ? null : Math.round((ctrOf(a.clicks, a.impressions) - ctrOf(b.clicks, b.impressions)) * 10_000) / 10_000,
      average_position: a.position === null || b.position === null ? null : Math.round((a.position - b.position) * 100) / 100,
    },
    truncated: Boolean(a.truncated || b.truncated),
    notes: a.truncated || b.truncated ? ['a contributing window hit the row cap; deltas over truncated top rows are floor-to-floor'] : [],
  };
}

// ---------------------------------------------------------------------------
// Focus-page selection. Manual works alone; GSC nominates, it never prescribes.
// ---------------------------------------------------------------------------

/**
 * Nominates pages worth a campaign's attention. Manual targets come first (judgment); observed
 * pages follow by clicks then impressions (observation). The three contract layers are carried
 * separately and inference/recommendation are null here on purpose: "high impressions, low
 * clicks" is an observation, "title mismatch" is an editable inference, "pursue resource-page
 * links" is a DP-0009 brief's job.
 */
export function selectFocusPages({ manual, rows = [], window: wanted = null, limit = 10 } = {}) {
  const chosen = [];
  const seen = new Set();
  const latest = rows.length
    ? newestWinningRows(rows).filter(row => row.kind === 'gsc.page' && row.page
      && (!wanted || (row.window?.start === wanted.start && row.window?.end === wanted.end)))
    : [];
  const byPage = new Map(latest.map(row => [row.page, row]));
  const observationOf = row => row ? { window: row.window, clicks: row.clicks, impressions: row.impressions, ctr: ctrOf(row.clicks, row.impressions), average_position: row.position, truncated: Boolean(row.truncated) } : null;
  // Judgment first: a manual target is nominated by judgment, and an observation for it is
  // ATTACHED (a second layer) rather than replacing the nomination — the two never collapse.
  for (const page of manual?.target_pages ?? []) {
    if (seen.has(page) || chosen.length >= limit) continue;
    seen.add(page);
    chosen.push({ page, nominated_by: ['manual'], observation: observationOf(byPage.get(page)), inference: null, recommendation: null });
  }
  const ranked = [...latest].sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0) || (b.impressions ?? 0) - (a.impressions ?? 0));
  for (const row of ranked) {
    if (seen.has(row.page) || chosen.length >= limit) continue;
    seen.add(row.page);
    chosen.push({ page: row.page, nominated_by: ['gsc_clicks'], observation: observationOf(row), inference: null, recommendation: null });
  }
  return { pages: chosen, basis: { manual: (manual?.target_pages ?? []).length, gsc: rows.length ? 'rows_present' : 'no_rows' } };
}

// ---------------------------------------------------------------------------
// Existing-agent context import (the handoff). A connector's rows are never re-labeled.
// ---------------------------------------------------------------------------

function parseHandoffText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { rows: [], error: 'empty file' };
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return { rows: Array.isArray(parsed) ? parsed : [parsed] };
    } catch {
      // Not one JSON document; try JSONL before giving up.
      const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
      const rows = [];
      for (const line of lines) {
        try { rows.push(JSON.parse(line)); } catch { return { rows: [], error: 'not_json' }; }
      }
      return { rows };
    }
  }
  // A Markdown snapshot: a pipe table whose header names the row fields.
  const lines = trimmed.split(/\r?\n/u).filter(line => line.trim());
  const divider = /^\s*\|?[\s:|-]+\|?\s*$/u;
  if (!lines.some(line => line.includes('|'))) return { rows: [], error: 'unrecognized_handoff_format' };
  const headerIndex = lines.findIndex(line => line.includes('|') && !divider.test(line));
  if (headerIndex < 0 || headerIndex + 1 >= lines.length || !divider.test(lines[headerIndex + 1])) return { rows: [], error: 'not_a_markdown_table' };
  const cells = line => line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map(cell => cell.trim());
  const header = cells(lines[headerIndex]);
  const rows = [];
  for (const line of lines.slice(headerIndex + 1).filter(line => line.includes('|'))) {
    if (divider.test(line)) continue;
    const values = cells(line);
    rows.push(Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
  }
  return { rows };
}

/**
 * Imports a connector snapshot into `gsc.jsonl`. Inherited from the DP-0014 import doctrine:
 * the connector is named in `retrieved_by` and never re-labeled as fetched by us; `captured_at`
 * stays the connector's date, separate from any later fetch of ours; rows missing `window` or
 * `aggregationType` are refused per file with what is missing; imports never overwrite rows we
 * fetched. A handoff with no Google grant from us at all is a complete configuration.
 */
export async function importHandoff({ paths, text = null, file = null, now = () => new Date() } = {}) {
  const raw = text ?? (await readFile(file, 'utf8'));
  const parsed = parseHandoffText(raw);
  if (parsed.error) return { error: parsed.error, accepted: 0, refused: [{ reason: parsed.error }] };
  const existing = (await readGscRows(paths.gsc)).rows;
  const ours = new Set(newestWinningRows(existing).filter(row => row.retrieved_by === RETRIEVED_BY).map(factKey));
  const accepted = [], refused = [];
  parsed.rows.forEach((candidate, index) => {
    // A Markdown table row is flat: `window.start`/`window.end` columns become the nested window.
    if ((!candidate.window || typeof candidate.window !== 'object') && candidate['window.start'] && candidate['window.end']) {
      candidate.window = { start: candidate['window.start'], end: candidate['window.end'] };
    }
    const missing = [];
    if (!candidate.window || !isValidDay(candidate.window.start) || !isValidDay(candidate.window.end)) missing.push('window');
    if (!candidate.aggregationType) missing.push('aggregationType');
    if (!candidate.retrieved_by || candidate.retrieved_by === RETRIEVED_BY) missing.push('retrieved_by (the connector must be named, and never us)');
    if (!candidate.property) missing.push('property');
    if (missing.length) { refused.push({ row: index + 1, reason: `missing ${missing.join(' and ')}` }); return; }
    const row = {
      ...candidate,
      window: { start: candidate.window.start.slice(0, 10), end: candidate.window.end.slice(0, 10), days: candidate.window.days ?? daysBetween(candidate.window.start, candidate.window.end) },
      captured_at: candidate.captured_at ?? null, // the connector's date, never fabricated
      // No fetched_at: nothing here was fetched by us, and the label must not drift.
    };
    if (ours.has(factKey(row))) { refused.push({ row: index + 1, reason: 'a row we fetched for this key exists; ours is kept' }); return; }
    accepted.push(row);
  });
  await appendGscRows(paths.gsc, accepted);
  const state = await readContextState(paths.contextState);
  const connectors = [...new Set([...(state.handoff?.connectors ?? []), ...accepted.map(row => row.retrieved_by)])];
  state.handoff = { ...(state.handoff ?? {}), connectors, last_import_at: now(), rows_imported: (state.handoff?.rows_imported ?? 0) + accepted.length };
  await writeContextState(paths.contextState, state);
  return { accepted: accepted.length, refused, connectors };
}

// ---------------------------------------------------------------------------
// Forget. Deletion is a decision; the human-owned files are never its collateral.
// ---------------------------------------------------------------------------

/**
 * Removes tool-owned context files and leaves the human-owned `manual.md` and `site-profile.md`
 * untouched. `--source gsc` (the default) removes the search facts and the connection state the
// tool wrote; `--source site` removes the site facts; `--source all` removes all three.
 */
export async function forgetContext({ paths, source = 'gsc' } = {}) {
  const toolOwned = { gsc: ['gsc', 'contextState'], site: ['siteFacts'], all: ['gsc', 'contextState', 'siteFacts'] }[source];
  if (!toolOwned) throw new ContextError('unknown_forget_source', { source });
  const removed = [], kept = [];
  for (const name of ['gsc', 'contextState', 'siteFacts', 'manual', 'siteProfile']) {
    const path = paths[name];
    if (name === 'manual' || name === 'siteProfile') { kept.push({ name, path, owner: 'human/agent' }); continue; }
    if (toolOwned.includes(name)) {
      await rm(path, { force: true });
      removed.push({ name, path });
    } else kept.push({ name, path, owner: 'tool' });
  }
  return { removed, kept, note: 'disconnecting Google stops new rows and retains old ones; rows already fetched are the customer’s own data in their own repo' };
}
