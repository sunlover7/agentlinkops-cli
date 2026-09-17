import { readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, ConfigError } from './config.js';
import { createClient } from './client.js';
import { readLedger } from './ledger.js';
import { resolveEnv } from './env.js';

export const SYNC_SCOPES = ['projects:read', 'watches:read', 'watches:write', 'events:read', 'exports:create'];

// Both TOKEN and API_KEY have shipped in customer installations, under both the AGENTLINKOPS_
// and the LINKTRAIL_ prefix (env.js owns that alias rule). Reject ambiguous identities: a
// TOKEN that disagrees with an API_KEY fails the same way a new name that disagrees with its
// old spelling does.
export function cloudConnection(config, env = process.env) {
  const { values, sources } = resolveEnv(env);
  if (values.TOKEN && values.API_KEY && values.TOKEN !== values.API_KEY)
    throw new ConfigError(`${sources.TOKEN} and ${sources.API_KEY} disagree; select one credential.`);
  if (values.API_URL && config.cloud?.origin && new URL(values.API_URL).origin !== new URL(config.cloud.origin).origin)
    throw new ConfigError(`${sources.API_URL} disagrees with the saved cloud origin.`);
  if (new Set([config.cloud?.workspaceId, config.cloud?.workspace_id].filter(Boolean)).size > 1 || new Set([config.project?.id, config.cloud?.projectId, config.cloud?.project_id].filter(Boolean)).size > 1)
    throw new ConfigError('Saved cloud identity fields disagree.');
  return { origin: values.API_URL || config.cloud?.origin,
    token: values.TOKEN || values.API_KEY || config.cloud?.token,
    tokenSource: values.TOKEN ? sources.TOKEN : values.API_KEY ? sources.API_KEY : null,
    workspaceId: config.cloud?.workspaceId || config.cloud?.workspace_id, projectId: config.project?.id || config.cloud?.projectId || config.cloud?.project_id };
}

export function keySetup(origin) {
  return `Open ${origin}/app, select the workspace, then Agent access > Create API key. Select the project and scopes ${SYNC_SCOPES.join(', ')}. Supply the key through AGENTLINKOPS_TOKEN (AGENTLINKOPS_API_KEY also works; the LINKTRAIL_ spellings remain accepted during the pilot compatibility window), then rerun connect. MCP OAuth credentials remain in the MCP client.`;
}

// Verify an existing project before saving only non-secret connection metadata.
export async function connectMain(args, { cwd, env = process.env, out = console.log, fetchImpl = globalThis.fetch } = {}) {
  const config = await loadConfig({ cwd });
  const connection = cloudConnection(config, env);
  const origin = args.origin || connection.origin || 'https://app.agentlinkops.com';
  const workspaceId = args.workspace || connection.workspaceId;
  const projectId = args['project-id'] || connection.projectId;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new ConfigError('connect --origin requires an HTTPS origin.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/')
    throw new ConfigError('connect --origin requires an HTTPS origin without a path.');
  if (!connection.token) { out(keySetup(parsed.origin)); return 2; }
  if (!/^lt_[0-9a-f]{64}$/.test(connection.token)) throw new ConfigError('Supply a complete API key through AGENTLINKOPS_TOKEN or AGENTLINKOPS_API_KEY.');
  if (typeof workspaceId !== 'string' || !workspaceId || typeof projectId !== 'string' || !projectId)
    throw new ConfigError('connect requires --workspace ID and --project-id ID from the existing cloud project.');
  if (config.cloud?.origin && new URL(config.cloud.origin).origin !== parsed.origin || connection.workspaceId && connection.workspaceId !== workspaceId || connection.projectId && connection.projectId !== projectId)
    throw new ConfigError('This ledger is connected elsewhere; use a separate ledger to preserve its cursors and mapping.');
  let ledgerIds;
  if (args.selection !== undefined) {
    if (typeof args.selection !== 'string') throw new ConfigError('--selection requires a JSON file of ledger IDs or mapping entries.');
    const selection = JSON.parse(await readFile(resolve(cwd || process.cwd(), args.selection), 'utf8'));
    ledgerIds = Array.isArray(selection) ? selection : selection.entries?.map(entry => entry.local_id);
    const ledger = await readLedger(config.paths.ledger);
    if (ledger.missing || ledger.problems.length || !Array.isArray(ledgerIds) || ledgerIds.some(id => typeof id !== 'string' || !ledger.entries.some(entry => entry.id === id)))
      throw new ConfigError('Selection must name existing ledger IDs in a valid ledger.');
    ledgerIds = [...new Set(ledgerIds)];
  }
  const client = createClient({ origin: parsed.origin, token: connection.token, workspaceId, fetchImpl });
  const account = await client.getWorkspace();
  if (account.workspace?.id !== workspaceId) throw new ConfigError('Cloud workspace does not match the selected workspace.');
  const missing = SYNC_SCOPES.filter(scope => !account.access?.scopes?.includes(scope));
  if (missing.length) throw new ConfigError(`Key lacks sync scopes: ${missing.join(', ')}.`);
  const project = await client.getProject(projectId);
  if (project.id !== projectId || project.workspace_id !== workspaceId) throw new ConfigError('Cloud project does not match the selected workspace.');
  const lockPath = join(config.dir, 'sync.lock');
  const lock = await open(lockPath, 'wx');
  const file = join(config.dir, 'config.json'), temporary = join(config.dir, `.connect-${crypto.randomUUID()}.tmp`);
  try {
    const before = await readFile(file, 'utf8');
    const saved = JSON.parse(before);
    const savedIdentity = cloudConnection(saved, {});
    if (savedIdentity.workspaceId && savedIdentity.workspaceId !== workspaceId || savedIdentity.projectId && savedIdentity.projectId !== projectId)
      throw new ConfigError('This ledger is connected to another workspace or project; use a separate ledger to preserve its cursors and mapping.');
    if (saved.cloud?.origin && new URL(saved.cloud.origin).origin !== parsed.origin)
      throw new ConfigError('This ledger is connected to another origin; use a separate ledger to preserve its cursors and mapping.');
    saved.cloud = { ...saved.cloud, origin: parsed.origin, workspaceId };
    if (ledgerIds !== undefined) saved.cloud.ledgerIds = ledgerIds;
    delete saved.cloud.token;
    saved.project = { ...saved.project, id: projectId };
    await writeFile(temporary, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (await readFile(file, 'utf8') !== before) throw new ConfigError('Connection configuration changed; retry.');
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lock.close(); await unlink(lockPath);
  }
  out(`Verified workspace ${workspaceId}, project ${projectId}. Saved connection metadata; keep the key in the environment. Run agentlinkops sync --dry-run to review uploads, or agentlinkops sync --pull-only to retrieve history.`);
  return 0;
}
