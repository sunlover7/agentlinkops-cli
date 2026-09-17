// Portable, accountless first result and explicit repository adoption. No hosted client.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { matchesTarget } from '../src/verifier/url.js';
import { validatePublicUrl } from '../src/verifier/index.js';
import { runCheck } from './check.js';
import { normalizeEntry, readLedger } from './ledger.js';
import { readState, applyRun } from './state.js';
import { observationRow, observationKey, readObservations } from './mirror.js';

export const LOCAL_RESULT_SCHEMA = 'agentlinkops.local-check.v1';

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const strings = z.array(z.string());
const redirectSchema = z.strictObject({ from: z.string(), to: z.string(), status: z.number().int() });
const robotsSchema = z.strictObject({ allowed: z.boolean().nullable(), reason: z.string().nullable(),
  matchedRule: z.string().nullable(), crawlDelaySeconds: z.number().nullable(), fetched: z.string().nullable(),
  sourceUrl: z.string().optional(), robotsUrl: z.string().optional(), httpStatus: z.number().int().nullable().optional(),
  productToken: z.string().optional(), redirects: z.array(redirectSchema).max(5).optional(), retryAfterSeconds: z.number().optional() });
const readinessSchema = z.strictObject({ requiresRender: z.boolean(), reason: z.string().nullable(), possibleLoginWall: z.boolean(),
  hasVisiblePassword: z.boolean().optional(), targetInScript: z.boolean().optional(), emptyAppRoot: z.boolean().optional(), emptyProfileRoot: z.boolean().optional() });
const occurrenceSchema = z.strictObject({ href: z.string(), targetUrl: z.string(), anchor: z.string(), rel: strings,
  context: z.string(), locator: z.strictObject({ line: z.number().int(), column: z.number().int(), offset: z.number().int() }).nullable(), visibility: z.literal('not_rendered') });
const observationSchema = z.strictObject({
  state: z.enum(['present','absent','unknown','source_unavailable']), reason: z.string(), sourceUrl: z.string(), finalUrl: z.string(), targetUrl: z.string(),
  targetScope: z.enum(['exact','domain','subdomain','path']), httpStatus: z.number().int().nullable(), checkedAt: timestamp,
  occurrences: z.array(occurrenceSchema).max(1000),
  directives: z.strictObject({ meta: z.array(z.strictObject({ name: z.string(), content: z.string() })), xRobotsTag: strings, noindex: z.boolean(), nofollow: z.boolean(), indexingStatus: z.string() }),
  redirects: z.array(redirectSchema),
  evidence: z.strictObject({ method: z.string(), checkerVersion: z.string(), complete: z.boolean(), fetchedAt: timestamp.nullable(),
    bytes: z.number().optional(), contentType: z.string().nullable().optional(), etag: z.string().nullable().optional(), lastModified: z.string().nullable().optional(),
    baseUrl: z.string().optional(), rendered: z.boolean().optional(), sha256: z.string().optional(), parseErrors: strings.optional(),
    readiness: readinessSchema.optional(), renderEligibility: z.enum(['required', 'comparison']).optional() }),
  robots: robotsSchema.optional(), robotsHistory: z.array(robotsSchema).max(6).optional(),
  sourceResponse: z.strictObject({ url: z.string(), httpStatus: z.number().int(), contentType: z.string().max(128).nullable(),
    retryAfterSeconds: z.number().nullable(), challenge: z.boolean() }).optional(),
  expectations: z.strictObject({ expectedAnchor: z.string().nullable(), expectedRel: strings.nullable(), anchorMatches: z.boolean().nullable(), relMatches: z.boolean().nullable(), satisfied: z.boolean() }).optional(),
  linkSignature: z.string().optional(), warnings: strings.optional(), retryAfterSeconds: z.number().optional(),
});

const identity = value => JSON.stringify([value.source, value.target, value.scope ?? 'exact']);
const resultId = (input, observation) => `lr_${createHash('sha256').update(JSON.stringify({ input, observation })).digest('hex')}`;
const textAt = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
const append = (held, row) => held + (held && !held.endsWith('\n') ? '\n' : '') + JSON.stringify(row) + '\n';

function normalizedInput(input) {
  const source = validatePublicUrl(input?.source), target = validatePublicUrl(input?.target);
  if (!source.valid || !target.valid) throw new Error(`invalid ${!source.valid ? 'source' : 'target'}: ${!source.valid ? source.reason : target.reason}`);
  const entry = normalizeEntry({ source: source.url, target: target.url, scope: input.scope ?? 'exact', intent: 'wanted' }, { assignId: true });
  return { source: entry.source, target: entry.target, scope: entry.scope };
}

export async function localCheck(input, options = {}) {
  const normalized = normalizedInput(input);
  const [row] = await runCheck([{ id: 'lk_portable', intent: 'wanted', ...normalized }], options);
  const observation = row.result;
  return { schema: LOCAL_RESULT_SCHEMA, result_id: resultId(normalized, observation), input: normalized,
    checked_at: observation.checkedAt, observation, provenance: { execution: 'local', verifier: 'agentlinkops-shared-verifier', raw_html_included: false } };
}

export async function checkToFile(input, file, options = {}) {
  // Reserve before fetching, so a collision does not even spend another publisher request.
  const handle = file ? await open(file, 'wx') : null;
  try {
    const result = await localCheck(input, options);
    if (handle) await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  } catch (error) {
    if (handle) await unlink(file).catch(() => {});
    throw error;
  } finally { if (handle) await handle.close(); }
}

export function validateLocalResult(result) {
  if (result?.schema !== LOCAL_RESULT_SCHEMA) throw new Error('unsupported local result schema');
  const input = normalizedInput(result.input), observation = result.observation;
  if (JSON.stringify(result).length > 512 * 1024 || !observationSchema.safeParse(observation).success) throw new Error('invalid portable observation schema');
  if (!observation || !['present', 'absent', 'unknown', 'source_unavailable'].includes(observation.state)
    || typeof observation.checkedAt !== 'string' || !Number.isFinite(Date.parse(observation.checkedAt))
    || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observation.checkedAt) || observation.checkedAt !== result.checked_at || !Array.isArray(observation.occurrences)
    || observation.sourceUrl !== input.source || observation.targetUrl !== input.target || observation.targetScope !== input.scope
    || typeof observation.evidence?.complete !== 'boolean') throw new Error('invalid portable observation');
  const fields = new Set(['state','reason','sourceUrl','finalUrl','targetUrl','targetScope','httpStatus','checkedAt','occurrences','directives','redirects','evidence','robots','robotsHistory','sourceResponse','expectations','linkSignature','warnings','retryAfterSeconds']);
  if (Object.keys(observation).some(key => !fields.has(key))) throw new Error('unsupported portable observation field');
  const rejectBytes = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['html','body','headers'].includes(key.toLowerCase())) throw new Error('portable observations cannot contain raw HTML/body/headers');
      rejectBytes(child);
    }
  };
  rejectBytes(observation);
  if (observation.occurrences.some(item => !item || typeof item.targetUrl !== 'string' || !Array.isArray(item.rel)
    || !matchesTarget(item.targetUrl, input.target, input.scope))) throw new Error('invalid portable occurrence');
  if (observation.state === 'present' && (!observation.evidence.complete || !observation.occurrences.length)) throw new Error('present requires complete matching occurrences');
  if (observation.state === 'absent' && (!observation.evidence.complete || observation.occurrences.length)) throw new Error('absent requires complete evidence without occurrences');
  if (observation.state === 'unknown' && observation.occurrences.length) throw new Error('unknown cannot assert matching occurrences');
  if (observation.state === 'source_unavailable' && (![404,410].includes(observation.httpStatus) || observation.occurrences.length)) throw new Error('source_unavailable requires a dated404/410 observation');
  if (observation.html != null || observation.evidence.html != null || observation.evidence.body != null) throw new Error('portable observations cannot contain raw HTML');
  if (result.result_id !== resultId(input, observation)) throw new Error('local result checksum mismatch');
  return { ...result, input };
}

async function finishAdoption(journalPath, tx, config, afterWrite = async () => {}) {
  if (tx.version !== 1 || !Array.isArray(tx.parts) || tx.parts.length > 3
    || tx.parts.some(part => ![config.paths.ledger, config.paths.observations, config.paths.state].includes(part.path)
      || typeof part.before !== 'string' || typeof part.after !== 'string')) throw new Error('invalid adoption recovery journal');
  for (const part of tx.parts) {
    const held = await textAt(part.path);
    if (held === part.after) continue;
    if (held !== part.before) throw new Error(`adoption recovery conflict at ${part.path}; preserve edits and reconcile ${journalPath}`);
    await mkdir(dirname(part.path), { recursive: true });
    const temporary = `${part.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, part.after, 'utf8'); await rename(temporary, part.path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    await afterWrite(part.path);
  }
  await unlink(journalPath);
}

export async function adoptLocalResult(config, supplied, { intent = 'wanted', afterWrite } = {}) {
  if (!['wanted', 'expected'].includes(intent)) throw new Error('adoption intent must be wanted or expected');
  const result = validateLocalResult(supplied);
  if (new Set([config.paths.ledger, config.paths.observations, config.paths.state]).size !== 3) throw new Error('adoption destinations must be distinct');
  const lockPath = `${config.paths.ledger}.lock`;
  const lock = await open(lockPath, 'wx');
  const journalPath = join(config.dir, 'adopt-result-transaction.json');
  try {
    const pending = await textAt(journalPath);
    if (pending) await finishAdoption(journalPath, JSON.parse(pending), config, afterWrite);
    const ledger = await readLedger(config.paths.ledger), observations = await readObservations(config.paths.observations);
    if (ledger.missing || ledger.problems.length || observations.problems.length) throw new Error('adoption requires a valid initialized ledger and observation mirror');
    const matches = ledger.entries.filter(entry => identity(entry) === identity(result.input));
    if (matches.length > 1) throw new Error('ambiguous placement: multiple ledger entries');
    const replay = observations.rows.find(row => row.local_result_id === result.result_id);
    if (replay && !matches.some(entry => entry.id === replay.id)) throw new Error('re-adoption conflicts with current ledger placement');
    if (replay) return { result_id: result.result_id, ledger_id: replay.id, created: false, observation_added: false };
    const entry = matches[0] ?? normalizeEntry({ ...result.input, intent, added: result.checked_at.slice(0, 10) }, { assignId: true });
    const row = { ...observationRow(entry.id, result.observation), local_result_id: result.result_id, imported_from: LOCAL_RESULT_SCHEMA };
    const collision = observations.rows.find(held => observationKey(held) === observationKey(row));
    if (collision) {
      if (JSON.stringify(collision.result) !== JSON.stringify(row.result)) throw new Error('conflicting observation at the same placement and check time');
      return { result_id: result.result_id, ledger_id: entry.id, created: false, observation_added: false };
    }
    const state = await readState(config.paths.state);
    const heldAt = state.entries?.[entry.id]?.last_checked;
    const nextState = heldAt && Date.parse(heldAt) >= Date.parse(row.checked_at) ? state : applyRun(state, [row]);
    const parts = [];
    for (const [path, value] of [[config.paths.ledger, matches[0] ? null : entry], [config.paths.observations, row]]) {
      if (!value) continue;
      const before = await textAt(path);
      parts.push({ path, before, after: append(before, value) });
    }
    if (nextState !== state) parts.push({ path: config.paths.state, before: await textAt(config.paths.state), after: `${JSON.stringify(nextState, null, 1)}\n` });
    await writeFile(journalPath, JSON.stringify({ version: 1, parts }), { flag: 'wx' });
    await finishAdoption(journalPath, { version: 1, parts }, config, afterWrite);
    return { result_id: result.result_id, ledger_id: entry.id, created: !matches[0], observation_added: true };
  } finally { await lock.close(); await unlink(lockPath); }
}
