import {parseArgs as parseArguments} from './args.js';
// `agentlinkops context …` — the DP-0017 first-party context surface (T02 GSC + manual, T03 site
// profile). STANDALONE BY CONFLICT RULE: this card may not edit src/mcp.js or register tools,
// so nothing here is dispatched from cli/main.js yet. The module is directly runnable:
//
//   node cli/context.js status
//   node cli/context.js gsc page https://example.com/guide --json
//
// and the wiring into main.js's USAGE/dispatch (plus any MCP tool registration) is the recorded
// follow-up for the next wave. Everything below needs no account; `gsc refresh` needs a
// customer-supplied token in AGENTLINKOPS_GSC_TOKEN (LINKTRAIL_GSC_TOKEN still accepted) and refuses quietly into `manual_only`
// without one — the path with no Google is a complete configuration, not a failure.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig, ConfigError } from './config.js';
import { readEnv } from './env.js';
import {
  contextPaths, loadContextConfig, readManual, buildManualContext, parseManual,
  readContextState, readGscRows, refreshContext, pageContext, selectFocusPages,
  importHandoff, forgetContext, createGoogleClient, recentWindows, windowFromRange,
} from '../src/context/gsc.js';
import { buildSiteProfile, renderSiteProfile, validateProfileCitations, readSiteFacts } from '../src/context/site-profile.js';
import {
  refreshGa4Context, landingPageContext, keyEventsContext, businessContextForPage,
  importGa4Handoff, forgetGa4Context, createGa4Client, readGa4Rows, GA4_SCOPE,
} from '../src/context/ga4.js';

const USAGE = `agentlinkops context — first-party search context in your repository (DP-0017)

  agentlinkops context status [--json]                 connection state, windows, availability floors
  agentlinkops context manual [--json]                 the manual.md context (works with no Google)
  agentlinkops context focus [--json]                  nominated focus pages (manual, then GSC clicks)
  agentlinkops context gsc refresh [--property P]… [--data-state all] [--json]
                                                    bounded read-only refresh (<=12 calls/property,
                                                    hard cap 50; needs AGENTLINKOPS_GSC_TOKEN, else
                                                    reports manual_only)
  agentlinkops context gsc page URL [--start D] [--end D] [--json]
                                                    page/query context for a supplied page, from
                                                    repo rows — no Google needed
  agentlinkops context gsc import FILE [--json]        import an agent/connector handoff snapshot
  agentlinkops context gsc forget [--source gsc|site|all] [--json]
                                                    remove tool-owned context files; manual.md and
                                                    site-profile.md are never touched
  agentlinkops context profile build [--site ORIGIN] [--page URL]… [--json]
                                                    bounded public sitemap + <=10 page profile
  agentlinkops context profile render [--force] [--json]
                                                    write the editable site-profile.md scaffold
                                                    (never overwrites judgments without --force)
  agentlinkops context profile check [--json]          every [fact:…]/[manual:…] citation resolves
  agentlinkops context ga4 refresh --property P [--start D --end D] [--json]
                                                    optional GA4 business context (<=4 reports/
                                                    property, hard cap 10; needs
                                                    AGENTLINKOPS_GA4_TOKEN, else reports ga4_absent)
  agentlinkops context ga4 page URL [--start D] [--end D] [--json]
                                                    aggregate landing-page context + configured
                                                    key events, with measurement caveats
  agentlinkops context ga4 key-events [--json]         the configured key events and their totals
  agentlinkops context ga4 import FILE [--json]        import an agent/connector GA4 handoff snapshot
  agentlinkops context ga4 forget [--json]             remove GA4 rows + GA4 state only
  agentlinkops context business URL [--start D] [--end D] [--json]
                                                    GSC search layer and GA4 business layer for a
                                                    page, side by side — never joined

Read-only. Google scopes requested: webmasters.readonly (GSC) and analytics.readonly (GA4,
separate consent) only. No CMS, no paid index, no Links API, no AI-report API.`;

const parseArgs = argv => parseArguments(argv,["property", "page"],{property:[],page:[]});

async function resolvePaths(cwd) {
  const config = await loadConfig({ cwd });
  const file = await loadContextConfig(config.dir);
  return { config, paths: contextPaths({ dir: config.dir, file }) };
}

export async function contextMain(argv = process.argv.slice(2), { cwd = process.cwd(), out = console.log, err = console.error, env = process.env } = {}) {
  const args = parseArgs(argv);
  const area = args._[0] ?? 'help';
  const command = args._[1] ?? null;
  if (area === 'help' || args.help) { out(USAGE); return 0; }
  try {
    const { config, paths } = await resolvePaths(cwd);

    if (area === 'status') {
      const state = await readContextState(paths.contextState);
      const { rows, problems, missing } = await readGscRows(paths.gsc);
      const ga4 = await readGa4Rows(paths.ga4);
      const manual = await readManual(paths.manual);
      const facts = await readSiteFacts(paths.siteFacts);
      const gscToken = readEnv(env, 'GSC_TOKEN'), ga4Token = readEnv(env, 'GA4_TOKEN');
      const tokenPresent = Boolean(gscToken.value);
      const ga4TokenPresent = Boolean(ga4Token.value);
      const summary = {
        project: config.project,
        connection: { ...(state.connection ?? { grant: tokenPresent ? 'token_present_unverified' : 'none' }), token_in_env: tokenPresent },
        handoff: state.handoff ?? null,
        availability: state.availability ?? {},
        last_fetch_count: Object.keys(state.last_fetch ?? {}).length,
        ga4: { ...(state.ga4 ?? { grant: ga4TokenPresent ? 'token_present_unverified' : 'none' }), token_in_env: ga4TokenPresent, rows: ga4.rows.length, file_missing: ga4.missing },
        gsc_rows: rows.length, gsc_file_missing: missing, gsc_problems: problems,
        site_fact_rows: facts.rows.length,
        manual_present: manual.present, manual_entries: manual.entries.length,
      };
      if (args.json) { out(JSON.stringify(summary, null, 1)); return 0; }
      out(`connection grant: ${summary.connection.grant}${tokenPresent ? ` (${gscToken.name} present)` : ''}`);
      out(`gsc rows: ${rows.length}${missing ? ' (no gsc.jsonl yet)' : ''}`);
      const ga4Configured = (state.ga4?.key_events_config ?? []).length;
      out(`ga4: ${summary.ga4.grant}${summary.ga4.property ? ` ${summary.ga4.property}` : ''}  rows ${ga4.rows.length}${ga4Configured ? `  ${ga4Configured} key event(s) configured` : ''}`);
      out(`site facts: ${facts.rows.length}  manual: ${manual.present ? `${manual.entries.length} entr(ies)` : 'absent'}`);
      if (Object.keys(summary.availability).length) out(`availability floors: ${JSON.stringify(summary.availability)}`);
      return 0;
    }

    if (area === 'manual') {
      const manual = await readManual(paths.manual);
      if (!manual.present) { err(`no manual.md at ${paths.manual} — the no-Google floor; create it with target pages, site description, offering, assets, competitors`); return 2; }
      const context = buildManualContext({ manual });
      if (args.json) { out(JSON.stringify(context, null, 1)); return 0; }
      out(JSON.stringify(context.inputs, null, 1));
      out(`${context.pages.length} target page(s) nominated by manual alone`);
      return 0;
    }

    if (area === 'focus') {
      const manual = await readManual(paths.manual);
      const { rows } = await readGscRows(paths.gsc);
      const state = await readContextState(paths.contextState);
      const window = args.start && args.end ? windowFromRange(args.start, args.end) : (recentWindows({ days: 28, count: 1 })[0]);
      const focus = selectFocusPages({ manual, rows, window, connection: state.connection ?? null });
      if (args.json) { out(JSON.stringify({ ...focus, window }, null, 1)); return 0; }
      for (const entry of focus.pages) out(`${entry.page}  ${entry.nominated_by.join('+')}${entry.observation ? `  clicks ${entry.observation.clicks ?? 'null'}` : ''}`);
      return 0;
    }

    if (area === 'gsc') {
      if (command === 'refresh') {
        const token = readEnv(env, 'GSC_TOKEN').value ?? null;
        const client = token ? createGoogleClient({ accessToken: token }) : null;
        const result = await refreshContext({
          client, paths,
          properties: args.property?.length ? args.property : null,
          dataState: args['data-state'] === 'all' ? 'all' : 'final',
        });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`state: ${result.state}`);
        for (const property of result.properties) out(`  ${property.siteUrl}: ${property.state}${property.rows_written ? `, ${property.rows_written} row(s)` : ''}`);
        out(`calls: ${JSON.stringify(result.calls)}  served from repo: ${result.served_from_repo}`);
        for (const note of result.notes) out(`note: ${note}`);
        return 0;
      }
      if (command === 'page') {
        const page = args._[2];
        if (!page) { err('agentlinkops context gsc page URL'); return 2; }
        const { rows } = await readGscRows(paths.gsc);
        const state = await readContextState(paths.contextState);
        const manual = await readManual(paths.manual);
        const window = args.start && args.end ? windowFromRange(args.start, args.end) : null;
        const result = pageContext({ rows, page, window, properties: state.connection?.properties ?? null, connection: state.connection ?? null, manual });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`state: ${result.state}  window: ${result.window ? `${result.window.start}..${result.window.end}` : 'n/a'}${result.final_through ? `  final through ${result.final_through}` : ''}`);
        if (result.page_totals) out(`totals: clicks ${result.page_totals.clicks}  impressions ${result.page_totals.impressions}  ctr ${result.page_totals.ctr}  avg position ${result.page_totals.average_position}`);
        for (const query of result.queries.slice(0, 20)) out(`  "${query.query}"  ${query.clicks} clicks  ${query.impressions} impr  ctr ${query.ctr}  avg ${query.average_position}`);
        for (const note of result.notes) out(`note: ${note}`);
        return 0;
      }
      if (command === 'import') {
        const file = args._[2];
        if (!file) { err('agentlinkops context gsc import FILE'); return 2; }
        const result = await importHandoff({ paths, file });
        if (result.error) { err(result.error); return 2; }
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`imported ${result.accepted} row(s) from connector(s): ${result.connectors.join(', ')}`);
        for (const refused of result.refused.slice(0, 20)) out(`  refused row ${refused.row}: ${refused.reason}`);
        if (result.refused.length > 20) out(`  … and ${result.refused.length - 20} more`);
        return result.refused.length ? 0 : 0;
      }
      if (command === 'forget') {
        const source = args.source === true ? 'gsc' : (args.source ?? 'gsc');
        const result = await forgetContext({ paths, source });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        for (const item of result.removed) out(`removed ${item.path}`);
        for (const item of result.kept) out(`kept ${item.path} (${item.owner}-owned)`);
        out(result.note);
        return 0;
      }
      err(`unknown context gsc command: ${command ?? '(none)'}\n\n${USAGE}`);
      return 2;
    }

    if (area === 'ga4') {
      if (command === 'refresh') {
        const token = readEnv(env, 'GA4_TOKEN').value ?? null;
        const client = token ? createGa4Client({ accessToken: token }) : null;
        const property = Array.isArray(args.property) ? args.property[0] : args.property;
        if (client && !property) { err('agentlinkops context ga4 refresh --property properties/123 (or a bare numeric id)'); return 2; }
        const window = args.start && args.end ? windowFromRange(args.start, args.end) : undefined;
        const result = await refreshGa4Context({ client, paths, property, windows: window ? [window] : null });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`state: ${result.state}${result.property ? `  property: ${result.property}` : ''}`);
        if (result.key_events_configured) out(`key events configured: ${result.key_events_configured.map(e => e.event_name).join(', ') || '(none)'}`);
        out(`calls: ${JSON.stringify(result.calls)}  served from repo: ${result.served_from_repo}  rows: ${result.rows_written}`);
        for (const note of result.notes) out(`note: ${note}`);
        return 0;
      }
      if (command === 'page') {
        const page = args._[2];
        if (!page) { err('agentlinkops context ga4 page URL'); return 2; }
        const { rows } = await readGa4Rows(paths.ga4);
        const state = await readContextState(paths.contextState);
        const window = args.start && args.end ? windowFromRange(args.start, args.end) : null;
        const result = landingPageContext({ rows, page, window, connection: state.ga4 ?? null });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`state: ${result.state}  property: ${result.property ?? 'n/a'}  window: ${result.window ? `${result.window.start}..${result.window.end}` : 'n/a'}`);
        if (result.totals) out(`totals: sessions ${result.totals.sessions}  key events ${result.totals.key_events}  per session ${result.totals.key_events_per_session}  revenue ${result.totals.total_revenue}${result.currency_code ? ` ${result.currency_code}` : ''}`);
        for (const event of result.events.slice(0, 20)) out(`  key event "${event.event_name}"  ${event.key_events} (s)  revenue ${event.total_revenue}`);
        for (const caveat of result.caveats) out(`caveat ${caveat.code}: ${caveat.note}`);
        for (const note of result.notes) out(`note: ${note}`);
        return 0;
      }
      if (command === 'key-events') {
        const { rows } = await readGa4Rows(paths.ga4);
        const window = args.start && args.end ? windowFromRange(args.start, args.end) : null;
        const result = keyEventsContext({ rows, window });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`state: ${result.state}  property: ${result.property ?? 'n/a'}${result.window ? `  window: ${result.window.start}..${result.window.end}` : ''}`);
        for (const event of result.key_events) out(`  "${event.event_name}" (${event.counting_method ?? 'counting method unknown'})  key events: ${event.key_events ?? 'withheld/null'}  [${event.basis}]`);
        for (const caveat of result.caveats) out(`caveat ${caveat.code}: ${caveat.note}`);
        for (const note of result.notes) out(`note: ${note}`);
        return 0;
      }
      if (command === 'import') {
        const file = args._[2];
        if (!file) { err('agentlinkops context ga4 import FILE'); return 2; }
        const result = await importGa4Handoff({ paths, file });
        if (result.error) { err(result.error); return 2; }
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`imported ${result.accepted} row(s) from connector(s): ${result.connectors.join(', ')}`);
        for (const refused of result.refused.slice(0, 20)) out(`  refused row ${refused.row}: ${refused.reason}`);
        return 0;
      }
      if (command === 'forget') {
        const result = await forgetGa4Context({ paths });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        for (const item of result.removed) out(`removed ${item.path}`);
        for (const item of result.kept) out(`kept ${item.path} (${item.owner}-owned)`);
        out(result.note);
        return 0;
      }
      err(`unknown context ga4 command: ${command ?? '(none)'}\n\n${USAGE}`);
      return 2;
    }

    if (area === 'business') {
      const page = args._[1];
      if (!page) { err('agentlinkops context business URL'); return 2; }
      const gsc = await readGscRows(paths.gsc);
      const ga4 = await readGa4Rows(paths.ga4);
      const state = await readContextState(paths.contextState);
      const manual = await readManual(paths.manual);
      const window = args.start && args.end ? windowFromRange(args.start, args.end) : null;
      const result = businessContextForPage({
        gscRows: gsc.rows, ga4Rows: ga4.rows, page, window,
        properties: state.connection?.properties ?? null, connection: state.connection ?? null,
        ga4Connection: state.ga4 ?? null, manual,
      });
      if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
      out(`state: ${result.state}  relation: ${result.relation}`);
      const search = result.layers.search, business = result.layers.business;
      out(`search layer: ${search.state}${search.page_totals ? ` — clicks ${search.page_totals.clicks}, impressions ${search.page_totals.impressions}` : ''}`);
      out(`business layer: ${business.state}${business.totals ? ` — sessions ${business.totals.sessions}, key events ${business.totals.key_events}` : ''}`);
      for (const caveat of result.caveats) out(`caveat ${caveat.code}: ${caveat.note}`);
      return 0;
    }

    if (area === 'profile') {
      if (command === 'build') {
        const result = await buildSiteProfile({
          site: args.site === true ? null : (args.site ?? null),
          paths, extraPages: args.page ?? [],
        });
        if (args.json) { out(JSON.stringify(result, null, 1)); return 0; }
        out(`origin ${result.origin}: robots ${result.robots.outcome}${result.robots.reason ? ` (${result.robots.reason})` : ''}, ${result.sitemaps.documents} sitemap document(s), ${result.sitemaps.urls_found} URL(s)`);
        out(`pages: ${result.pages.length} (cap ${result.limits.selected_pages}${result.limits.pages_capped ? ', CAPPED' : ''})`);
        for (const page of result.pages) out(`  ${page.outcome === 'fetched' ? 'ok      ' : page.outcome.padEnd(8, ' ')}  ${page.url}${page.outcome !== 'fetched' ? `  [${page.reason}]` : ''}`);
        out(`sitemap counters: failures ${JSON.stringify(result.sitemaps.failures)} skipped ${JSON.stringify(result.sitemaps.skipped)} truncated ${result.sitemaps.truncated}`);
        for (const note of result.notes) out(`note: ${note}`);
        return 0;
      }
      if (command === 'render') {
        const { rows } = await readSiteFacts(paths.siteFacts);
        if (!rows.length) { err(`no site facts at ${paths.siteFacts} — run \`agentlinkops context profile build\` first`); return 2; }
        const manual = await readManual(paths.manual);
        let existing = null;
        try { existing = await readFile(paths.siteProfile, 'utf8'); } catch { /* absent is the normal first run */ }
        if (existing && !args.force) {
          err(`site-profile.md already exists at ${paths.siteProfile} and holds judgments; pass --force to regenerate (this discards edits)`);
          return 2;
        }
        const origin = rows.find(row => row.kind === 'site.robots')?.url?.replace(/\/robots\.txt$/u, '') ?? null;
        const markdown = renderSiteProfile({ facts: rows, manual, origin });
        const { writeFile, mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await mkdir(dirname(paths.siteProfile), { recursive: true });
        await writeFile(paths.siteProfile, markdown, 'utf8');
        const check = validateProfileCitations({ profileText: markdown, facts: rows, manual });
        out(`wrote ${paths.siteProfile} (${check.citations} citation(s), ${check.unresolved.length} unresolved)${existing ? ' --force: previous judgments were replaced' : ''}`);
        return 0;
      }
      if (command === 'check') {
        let markdown;
        try { markdown = await readFile(paths.siteProfile, 'utf8'); } catch { err(`no site-profile.md at ${paths.siteProfile}`); return 2; }
        const { rows } = await readSiteFacts(paths.siteFacts);
        const manual = await readManual(paths.manual);
        const check = validateProfileCitations({ profileText: markdown, facts: rows, manual });
        if (args.json) { out(JSON.stringify(check, null, 1)); return check.unresolved.length ? 1 : 0; }
        out(`${check.citations} citation(s) checked, ${check.unresolved.length} unresolved`);
        for (const ref of check.unresolved) out(`  UNRESOLVED ${ref}`);
        out('facts are read-only to the profile: editing a judgment never edits a fact row');
        return check.unresolved.length ? 1 : 0;
      }
      err(`unknown context profile command: ${command ?? '(none)'}\n\n${USAGE}`);
      return 2;
    }

    err(`unknown context area: ${area}\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof ConfigError) { err(error.message); return 2; }
    err(`agentlinkops context: ${error?.message ?? error}`);
    return 2;
  }
}

// Directly runnable: `node cli/context.js …`. Registration in cli/main.js (USAGE + dispatch)
// and any MCP tool registration in src/mcp.js are the recorded follow-up for the next wave.
const invokedDirectly = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (invokedDirectly) {
  contextMain().then(code => process.exit(code), error => { console.error(error); process.exit(2); });
}
