// Environment variable names, and the compatibility window between the two sets of them.
//
// The product is AgentLinkOps. "Linktrail" was a working name, and the private pilot's installed
// CLI and LaunchAgent still export `LINKTRAIL_*` (DP-0029 inventory, 2026-09-15). So every
// variable has exactly two spellings here: the AgentLinkOps name is preferred, the Linktrail name
// is an alias, and the rules are the same for every pair:
//
//   - only the new name set      -> used, silently
//   - only the old name set      -> used, with ONE warning per process naming the new variable
//   - both set, same value       -> used, silently (an operator mid-migration exports both)
//   - both set, different values -> ConfigError, the same conflict rule that already refuses a
//                                   TOKEN that disagrees with an API_KEY. Guessing between two
//                                   credentials is how a sync lands in the wrong workspace.
//
// No value is ever printed: the warning and the error name variables, never contents.
import { ConfigError, noticeOnce, resetCompatibilityNotices, setNoticeSink } from './config.js';

export { resetCompatibilityNotices, setNoticeSink };

export const ENV_PREFIX = 'AGENTLINKOPS';
export const LEGACY_ENV_PREFIX = 'LINKTRAIL';

/** Every suffix the CLI reads from the environment. */
export const ENV_NAMES = Object.freeze(['TOKEN', 'API_KEY', 'API_URL', 'WEBHOOK_SECRET', 'GSC_TOKEN', 'GA4_TOKEN']);

export const envName = suffix => `${ENV_PREFIX}_${suffix}`;
export const legacyEnvName = suffix => `${LEGACY_ENV_PREFIX}_${suffix}`;

export function deprecationNotice(oldName, newName) {
  return `${oldName} is deprecated; set ${newName} instead. The old name keeps working during the pilot compatibility window.`;
}

/**
 * Reads one variable under both names. Returns `{ value, name }` where `name` is the variable
 * the value actually came from (or null), so a caller can say "set in the environment (X)"
 * truthfully.
 */
export function readEnv(env, suffix, { warn = null } = {}) {
  const preferred = envName(suffix), legacy = legacyEnvName(suffix);
  const fresh = env[preferred], old = env[legacy];
  if (fresh !== undefined && fresh !== '' && old !== undefined && old !== '' && fresh !== old)
    throw new ConfigError(`${preferred} and ${legacy} disagree; select one value.`);
  if (fresh !== undefined && fresh !== '') return { value: fresh, name: preferred };
  if (old !== undefined && old !== '') {
    // Once per process, per variable, so a command that resolves the environment in three
    // places (config, doctor, context) warns once rather than three times.
    if (warn) warn(deprecationNotice(legacy, preferred));
    else noticeOnce(`legacy-env:${legacy}`, deprecationNotice(legacy, preferred));
    return { value: old, name: legacy };
  }
  return { value: undefined, name: null };
}

/**
 * Every variable the CLI reads, resolved through the alias rule. `values` is keyed by suffix
 * (`TOKEN`, `API_KEY`, …); `sources` says which spelling supplied each one.
 */
export function resolveEnv(env = process.env, options = {}) {
  const values = {}, sources = {};
  for (const suffix of ENV_NAMES) {
    const { value, name } = readEnv(env, suffix, options);
    values[suffix] = value;
    sources[suffix] = name;
  }
  return { values, sources };
}
