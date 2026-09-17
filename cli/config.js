// Where the ledger lives, and everything else the CLI needs to know.
//
// Every path is configurable and every default is named here. The product direction is
// opinionated about truth and about the fetch boundary, and explicitly not about where a
// customer keeps their files — so the config is read before anything else is.
//
// The directory has two names for the pilot compatibility window (DP-0029-T03). `.agentlinkops/`
// is the default; `.linktrail/` is read transparently when the new directory is absent, with one
// hint per process pointing at `agentlinkops migrate`. Nothing here moves files: a directory
// rename in a customer's repository is an explicit command with a receipt, never a side effect
// of reading.
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';

export const LEGACY_DIR = '.linktrail';

export const DEFAULTS = Object.freeze({
  dir: '.agentlinkops',
  ledger: 'links.jsonl',
  receipts: 'receipts.jsonl',
  observations: 'observations.jsonl',
  events: 'events.jsonl',
  candidates: 'candidates.jsonl',
  state: 'state.json',
  // A courtesy floor between two requests to the same host. The verifier REFUSES any host
  // stating a robots crawl delay unless a pacing hook is supplied, so a CLI without one would
  // report our own omission as the publisher's fault.
  hostDelayMs: 2000,
  concurrency: 6,
  timeoutMs: 20_000,
});

/** Both spellings, preferred first. Any config or state that names the directory accepts both. */
export const DIR_NAMES = Object.freeze([DEFAULTS.dir, LEGACY_DIR]);

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; this.exitCode = 2; }
}

// Compatibility notices (the legacy-directory hint here, the LINKTRAIL_* warnings in env.js) go
// to one sink, once per process per subject, so a command that loads the config in three places
// does not say the same thing three times.
const noticed = new Set();
let noticeSink = message => console.error(message);
export function setNoticeSink(sink) { noticeSink = typeof sink === 'function' ? sink : message => console.error(message); }
export function resetCompatibilityNotices() { noticed.clear(); }
export function noticeOnce(key, message) {
  if (noticed.has(key)) return false;
  noticed.add(key);
  noticeSink(message);
  return true;
}

export const migrateHint = dir => `${dir} uses the old directory name; run \`agentlinkops migrate\` to rename it to ${DEFAULTS.dir}/ (nothing is moved until you do).`;

const isDirectory = path => stat(path).then(info => info.isDirectory(), () => false);

/**
 * Which directory name is in use under `base`: the preferred one when it exists, the legacy one
 * when only it exists, and the preferred one (not yet created) otherwise.
 */
export async function resolveDirName(base) {
  if (await isDirectory(join(base, DEFAULTS.dir))) return { name: DEFAULTS.dir, legacy: false, exists: true };
  if (await isDirectory(join(base, LEGACY_DIR))) return { name: LEGACY_DIR, legacy: true, exists: true };
  return { name: DEFAULTS.dir, legacy: false, exists: false };
}

/** Finds the ledger directory from `from` upwards, the way git finds its own root. */
export async function findRoot(from = process.cwd(), dir = null) {
  let current = resolve(from);
  const names = dir ? [dir] : DIR_NAMES;
  for (;;) {
    for (const name of names) {
      try {
        await readFile(join(current, name, DEFAULTS.ledger));
        return current;
      } catch { /* keep walking */ }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadConfig({ cwd = process.cwd(), root = null } = {}) {
  const base = root ?? await findRoot(cwd) ?? cwd;
  const which = await resolveDirName(base);
  const dir = join(base, which.name);
  if (which.legacy) noticeOnce(`legacy-dir:${dir}`, migrateHint(dir));
  let file = {};
  try { file = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new ConfigError(`config.json is not valid JSON: ${error.message}`); }
  const paths = { ...DEFAULTS, ...file.paths };
  const at = name => resolve(dir, paths[name]);
  return {
    root: base, dir, dirName: which.name, legacyDir: which.legacy,
    project: file.project ?? null, cloud: file.cloud ?? null,
    defaults: { ...DEFAULTS, ...file.defaults },
    paths: {
      ledger: at('ledger'), observations: at('observations'), events: at('events'),
      candidates: at('candidates'), state: at('state'), receipts: at('receipts'),
    },
  };
}
