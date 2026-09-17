import { loadConfig, DEFAULTS, LEGACY_DIR } from './config.js';
import { readEnv } from './env.js';
import {
    contextPaths, loadContextConfig, readManual, buildManualContext, readContextState, readGscRows,
    pageContext, selectFocusPages, refreshContext, importHandoff, createGoogleClient,
    recentWindows, windowFromRange,
  } from '../src/context/gsc.js';
import { buildSiteProfile, validateProfileCitations, readSiteFacts } from '../src/context/site-profile.js';
// Repository-local MCP over stdio. Host root is chosen at startup, never by tool arguments.
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { registerContextTools } from '../src/context-tool-registry.js';

// Injecting path semantics lets the boundary be verified on Windows as well as POSIX.
export function isWithinContextRoot(root, file, paths = { relative, isAbsolute, sep }) {
  const rel = paths.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
}

const propertyName = value => {
  if (typeof value !== 'string') return false;
  if (/^sc-domain:[a-z0-9.-]+$/i.test(value)) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
};
const connectionGrants = new Set(['none', 'ok', 'refused', 'revoked', 'token_present_unverified']);
const permissionLevels = new Set(['siteOwner', 'siteFullUser', 'siteRestrictedUser', 'siteUnverifiedUser']);

// State files are editable local input. Never spread them into an agent response: even a
// nested credential field or malformed typed field must not become connection metadata.
export function connectionStatus(connection, tokenPresent) {
  const raw = connection && typeof connection === 'object' ? connection : {};
  const result = { grant: connectionGrants.has(raw.grant) ? raw.grant : (tokenPresent ? 'token_present_unverified' : 'none'),
    token_in_env: Boolean(tokenPresent) };
  if (typeof raw.checked_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw.checked_at) && Number.isFinite(Date.parse(raw.checked_at))) result.checked_at = new Date(raw.checked_at).toISOString();
  if (Number.isInteger(raw.last_status) && raw.last_status >= 100 && raw.last_status <= 599) result.last_status = raw.last_status;
  if (Array.isArray(raw.properties)) result.properties = raw.properties.filter(propertyName);
  if (raw.permission_levels && typeof raw.permission_levels === 'object' && !Array.isArray(raw.permission_levels)) {
    result.permission_levels = Object.fromEntries(Object.entries(raw.permission_levels)
      .filter(([property, level]) => propertyName(property) && permissionLevels.has(level)));
  }
  return result;
}

// Resolve existing ancestors as well as leaves: nonexistent outputs can still escape through
// a symlinked parent. Recheck on every call so config edits do not silently widen the root.
async function contained(root, file) {
  const inside = path => {
    if (!isWithinContextRoot(root, path)) throw new Error('Context path is outside the configured repository root');
  };
  inside(file);
  let parent = file;
  for (;;) {
    try { inside(await realpath(parent)); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      parent = dirname(parent);
    }
  }
  return file;
}

export async function contextService(cwd, env = process.env) {

  const root = await realpath(cwd);
  const pathsOf = async () => {
    for (const dir of [DEFAULTS.dir, LEGACY_DIR]) await contained(root, join(root, dir, 'config.json'));
    const config = await loadConfig({ root });
    const file = await loadContextConfig(config.dir);
    const paths = contextPaths({ dir: config.dir, file });
    for (const path of Object.values(paths)) await contained(root, path);
    return { config, paths };
  };
  const service = {
    status: async () => {
      const { paths } = await pathsOf();
      const state = await readContextState(paths.contextState);
      const { rows, problems, missing } = await readGscRows(paths.gsc);
      const manual = await readManual(paths.manual);
      const facts = await readSiteFacts(paths.siteFacts);
      return {
        project: (await pathsOf()).config.project,
        connection: connectionStatus(state.connection, Boolean(readEnv(env, 'GSC_TOKEN').value)),
        handoff: state.handoff ?? null, availability: state.availability ?? {},
        last_fetch_count: Object.keys(state.last_fetch ?? {}).length,
        gsc_rows: rows.length, gsc_file_missing: missing, gsc_problems: problems,
        site_fact_rows: facts.rows.length,
        manual_present: manual.present, manual_entries: manual.entries.length,
      };
    },
    manual: async () => {
      const { paths } = await pathsOf();
      const manual = await readManual(paths.manual);
      if (!manual.present) return { error: `no manual.md at ${paths.manual}` };
      return buildManualContext({ manual });
    },
    focus: async a => {
      const { paths } = await pathsOf();
      const manual = await readManual(paths.manual);
      const { rows } = await readGscRows(paths.gsc);
      const state = await readContextState(paths.contextState);
      const window = a?.start && a?.end ? windowFromRange(a.start, a.end) : recentWindows({ days: 28, count: 1 })[0];
      return { ...selectFocusPages({ manual, rows, window, connection: state.connection ?? null }), window };
    },
    page: async a => {
      const { paths } = await pathsOf();
      const { rows } = await readGscRows(paths.gsc);
      const state = await readContextState(paths.contextState);
      const manual = await readManual(paths.manual);
      const window = a?.start && a?.end ? windowFromRange(a.start, a.end) : null;
      return pageContext({ rows, page: a.page, window, properties: state.connection?.properties ?? null, connection: state.connection ?? null, manual });
    },
    refresh: async a => {
      const { paths } = await pathsOf();
      const token = readEnv(env, 'GSC_TOKEN').value ?? null;
      const client = token ? createGoogleClient({ accessToken: token }) : null;
      return refreshContext({ client, paths, properties: a?.properties ?? null, dataState: a?.dataState ?? 'final' });
    },
    import: async a => {
      const { paths } = await pathsOf();
      return importHandoff({ paths, file: await contained(root, resolve(root, a.file)) });
    },
    buildProfile: async (a, deps = {}) => {
      const { paths } = await pathsOf();
      return buildSiteProfile({ site: a?.site ?? null, paths, extraPages: a?.pages ?? [], ...(deps.transport ? { transport: deps.transport } : {}), ...(deps.acquisition ? { acquisition: deps.acquisition } : {}) });
    },
    checkProfile: async () => {
      const { paths } = await pathsOf();
      let profileText;
      try { profileText = await readFile(paths.siteProfile, 'utf8'); }
      catch { return { error: `no site-profile.md at ${paths.siteProfile}` }; }
      const { rows } = await readSiteFacts(paths.siteFacts);
      const manual = await readManual(paths.manual);
      return validateProfileCitations({ profileText, facts: rows, manual });
    },
  };
  return Object.fromEntries(Object.entries(service).map(([name, handler]) => [name, async (args = {}) => {
    if (Boolean(args.start) !== Boolean(args.end)) throw new Error('start and end must be supplied together');
    return handler(args);
  }]));
}

export async function createContextServer({ root, env = process.env }) {
  if (!root) throw new Error('A repository --root is required');
  const context = await contextService(root, env);
  const server = new McpServer({ name: 'agentlinkops-local-context', version: '0.1.0' });
  // Serialize file operations, including reads: refresh/import share state files and must not
  // lose updates when an agent submits several calls concurrently.
  let tail = Promise.resolve();
  registerContextTools({ context, contextTool(name, description, scope, input, handler, write) {
    server.registerTool(name, {
      description, inputSchema: z.strictObject(input),
      annotations: { readOnlyHint: !write, destructiveHint: false,
        idempotentHint: !write, openWorldHint: ['context_gsc_refresh', 'context_profile_build'].includes(name) },
    }, args => {
      const result = tail.then(async () => {
        try {
          const value = await handler(args);
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value,
            ...(value.error || value.unresolved?.length ? { isError: true } : {}) };
        } catch (error) {
          // Redact tokens even from third-party exception strings; stdout is protocol-only.
          let message = String(error.message ?? 'Context operation failed');
          for (const secret of [env.AGENTLINKOPS_GSC_TOKEN, env.LINKTRAIL_GSC_TOKEN, env.AGENTLINKOPS_GA4_TOKEN, env.LINKTRAIL_GA4_TOKEN].filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
          return { isError: true, content: [{ type: 'text', text: message }] };
        }
      });
      tail = result.catch(() => {});
      return result;
    });
  } });
  return server;
}

const directlyInvoked = await (async () => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href; }
  catch { return false; }
})();
if (directlyInvoked) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root') {
    console.error('Usage: node cli/context-mcp.js --root /absolute/customer/repository');
    process.exitCode = 2;
  } else {
    // Build once before accepting protocol traffic so invalid roots fail at startup.
    const server = await createContextServer({ root: args[1] });
    serveStdio(() => server, { onerror: () => console.error('Local context MCP transport error') });
  }
}
