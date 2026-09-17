// `agentlinkops doctor` — one command that says whether this installation works.
//
// Each check is one plain line with a verdict, and a failing line carries exactly one fix.
// The command deliberately runs where the ledger cannot yet be trusted: its whole job is to
// name what is broken, so it dispatches before main.js's ledger requirement and inspects every
// file itself. Nothing here repairs anything.
//
// Two boundaries worth naming. The cloud reachability probe is ANONYMOUS — no Authorization
// header reaches it, so reachability can never depend on (or leak) a credential. The token
// probe does send the token, but only to the configured origin, on the same read sync already
// makes; a token's scope lives server-side, so presence alone cannot answer the scope
// question. No secret value is ever printed, recorded or measured — not even its length.
//
// The observation mirror is deliberately not scanned: it can be megabytes a doctor run would
// re-parse for no decision, and `status`/`check` already refuse malformed rows loudly.
import { access } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { loadConfig, setNoticeSink } from './config.js';
import { readLedger } from './ledger.js';
import { readReceipts } from './receipts.js';
import { readState, writeState } from './state.js';
import { createClient, CloudError } from './client.js';
import { cloudConnection } from './connection.js';
import { validatePublicUrl, parseLinks, transitionState, checkObservationKind } from '../src/verifier/index.js';
import { matchesTarget } from '../src/verifier/url.js';

const USAGE = 'agentlinkops doctor   (no flags; verifies ledger, verifier, cloud and token)';

const TOKEN_SHAPE = /^lt_[0-9a-f]{64}$/u;

/**
 * Runs the real verifier exports against fixed local expectations — no network, no fixtures
 * directory, nothing metered. This is not a benchmark; it answers "did the verifier arrive in
 * this install intact", the way `ssh -V` answers whether ssh works at all.
 */
export function verifierSelfTest() {
  const failures = [];
  const step = (name, run) => {
    try { run(); } catch (error) { failures.push(`${name}: ${error?.message ?? String(error)}`); }
  };

  step('url screen', () => {
    const page = validatePublicUrl('https://example.com/post');
    assert.ok(page.valid, `public URL refused (${page.reason})`);
    const refused = validatePublicUrl('http://192.168.0.10/admin');
    assert.ok(!refused.valid, 'a private IP literal passed the public screen');
    assert.equal(refused.reason, 'ip_literal_not_supported');
  });

  const document = '<html><body><p>See the <a href="/guide" rel="nofollow ugc">outreach guide</a> for details.</p></body></html>';
  let occurrences = [];
  step('parser', () => {
    occurrences = parseLinks(document, 'https://example.com/post');
    assert.equal(occurrences.length, 1, `expected one occurrence, found ${occurrences.length}`);
    assert.equal(occurrences[0].targetUrl, 'https://example.com/guide');
    assert.equal(occurrences[0].anchor, 'outreach guide');
    assert.deepEqual(occurrences[0].rel, ['nofollow', 'ugc']);
    assert.ok(matchesTarget(occurrences[0].targetUrl, 'https://example.com/guide', 'exact'), 'exact match failed');
    assert.ok(!matchesTarget(occurrences[0].targetUrl, 'https://example.com/other', 'exact'), 'a different path matched');
  });

  const at = Date.parse('2026-09-12T12:00:00Z');
  let acquired = null;
  step('reducer', () => {
    const present = {
      state: 'present', reason: 'link_found', sourceUrl: 'https://example.com/post',
      finalUrl: 'https://example.com/post', targetUrl: 'https://example.com/guide', targetScope: 'exact',
      httpStatus: 200, checkedAt: new Date(at).toISOString(), occurrences,
      directives: { noindex: false, nofollow: false }, evidence: { complete: true },
    };
    acquired = transitionState(null, present);
    assert.equal(acquired.state, 'present');
    assert.equal(acquired.event?.type, 'placement_acquired', 'first present observation emitted no acquisition event');
    const absent = { ...present, state: 'absent', reason: 'no_matching_link_in_complete_html', occurrences: [],
      checkedAt: new Date(at + 40 * 60 * 1000).toISOString() };
    const missing = transitionState(acquired, absent);
    assert.equal(missing.state, 'suspected_missing', 'one absent observation confirmed loss early');
    assert.ok(missing.nextCheckAt, 'suspected missing scheduled no confirmation check');
  });

  step('kind check', () => {
    const inside = checkObservationKind({ kind: 'internal', sourceUrl: 'https://example.com/post', targetUrl: 'https://example.com/guide' }, ['example.com']);
    assert.ok(inside.valid, `internal kind refused inside the declared site (${inside.reason})`);
    const outside = checkObservationKind({ kind: 'internal', sourceUrl: 'https://example.com/post', targetUrl: 'https://other.com/guide' }, ['example.com']);
    assert.ok(!outside.valid, 'an internal receipt outside the declared site passed');
    assert.match(outside.reason, /other\.com/u, 'the refusal does not name the offending host');
  });

  return { ok: failures.length === 0, failures, steps: ['url screen', 'parser', 'reducer', 'kind check'] };
}

/**
 * Anonymous, bounded reachability probe of the configured cloud. No credential is sent, no
 * redirect is followed, and the outcome is meant to be recorded: a doctor run months later
 * should be able to say when the cloud was last reachable from this machine.
 */
export async function probeCloud({ origin, fetchImpl, timeoutMs = 5000 }) {
  const base = String(origin).replace(/\/$/u, '');
  const started = Date.now();
  try {
    const response = await fetchImpl(`${base}/healthz`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { reachable: false, ok: false, status: null, ms: Date.now() - started,
      error: timedOut ? 'timeout' : 'network error', timedOut };
  }
}

/**
 * Asks the cloud whether the configured token actually works, using the same client sync
 * uses. Scope is a server-side fact, so this read (a plain watch listing, metered as none) is
 * the only honest answer to "is this token good for anything here".
 */
export async function probeToken({ origin, token, workspaceId, fetchImpl }) {
  try {
    await createClient({ origin, token, workspaceId, fetchImpl }).listWatches({ limit: 1 });
    return { verified: true };
  } catch (error) {
    if (error instanceof CloudError) return { verified: false, code: error.code, status: error.status, scope: error.details?.scope ?? null };
    return { verified: null, error: error?.name ?? 'network error' };
  }
}

/** One line per check, a fix under every failure. Plain words, no symbols to look up. */
function render(checks, out) {
  let ok = 0, skip = 0, fail = 0;
  for (const check of checks) {
    if (check.status === 'ok') ok++; else if (check.status === 'skip') skip++; else fail++;
    out(`${check.status.padEnd(6)} ${check.name.padEnd(9)} — ${check.detail}`);
    if (check.status === 'fail' && check.fix) out(`${''.padEnd(6)} ${'fix'.padEnd(9)} — ${check.fix}`);
  }
  out('');
  out(fail ? `${fail} of ${checks.length} check(s) failed` : `all checks passed (${ok} ok, ${skip} skipped)`);
  return fail;
}

export async function doctorMain(argv = [], { cwd = process.cwd(), out = console.log, err = console.error,
  env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (argv.length) { err(USAGE); return 2; }
  setNoticeSink(err);

  const config = await loadConfig({ cwd });
  const checks = [];

  const ledger = await readLedger(config.paths.ledger);
  if (ledger.missing) {
    checks.push({ status: 'fail', name: 'ledger', detail: `no ledger at ${config.paths.ledger}`,
      fix: 'run `agentlinkops init` in the repository root' });
  } else if (ledger.problems.length) {
    const first = ledger.problems[0];
    checks.push({ status: 'fail', name: 'ledger',
      detail: `${ledger.problems.length} unreadable line(s); first at line ${first.line}: ${first.reason}`,
      fix: 'repair that line in the ledger file; `agentlinkops fmt` lists every problem without writing' });
  } else {
    const n = ledger.entries.length;
    checks.push({ status: 'ok', name: 'ledger', detail: `${n} ${n === 1 ? 'entry parses' : 'entries parse'}` });
  }

  // Receipts are optional until the first claim is written; unreadable once written is fatal
  // to every receipt verb, so doctor names it the same way the verbs will.
  const hasReceipts = await access(config.paths.receipts).then(() => true, () => false);
  if (!hasReceipts) {
    checks.push({ status: 'skip', name: 'receipts', detail: 'none written yet' });
  } else {
    try {
      const receipts = await readReceipts(config.paths.receipts);
      checks.push({ status: 'ok', name: 'receipts', detail: `${receipts.length} ${receipts.length === 1 ? 'claim parses' : 'claims parse'}` });
    } catch (error) {
      checks.push({ status: 'fail', name: 'receipts', detail: error.message,
        fix: 'repair or remove the named line in receipts.jsonl; a claim that cannot parse was never verified' });
    }
  }

  let state = null;
  try {
    state = await readState(config.paths.state);
    checks.push({ status: 'ok', name: 'state', detail: `v${state.v}, ${Object.keys(state.entries).length} entr${Object.keys(state.entries).length === 1 ? 'y' : 'ies'} tracked` });
  } catch (error) {
    checks.push({ status: 'fail', name: 'state', detail: `state.json is not readable: ${error.message}`,
      fix: `restore ${config.dirName}/state.json from version control (cursors and first-present dates live there)` });
  }

  const selfTest = verifierSelfTest();
  checks.push(selfTest.ok
    ? { status: 'ok', name: 'verifier', detail: `self-test passed (${selfTest.steps.join(', ')})` }
    : { status: 'fail', name: 'verifier', detail: `self-test failed: ${selfTest.failures[0]}`,
        fix: 'the verifier modules are broken in this install; re-install or check local modifications under src/verifier/' });

  // Cloud reachability: anonymous, bounded, recorded. A repository with no cloud configured is
  // a legitimate local-only install, reported as a skip rather than a failure.
  const connection = cloudConnection(config, env);
  const origin = connection.origin || null;
  const record = { at: new Date().toISOString() };
  let probed = false;
  if (!origin) {
    checks.push({ status: 'skip', name: 'cloud', detail: 'no cloud configured (local-only repository)' });
  } else {
    const cloud = await probeCloud({ origin, fetchImpl, timeoutMs });
    record.cloud = { ok: cloud.ok, status: cloud.status, ms: cloud.ms };
    if (!cloud.reachable) {
      checks.push({ status: 'fail', name: 'cloud',
        detail: `cannot reach ${origin} (${cloud.error}${cloud.timedOut ? ` after ${timeoutMs} ms` : ''})`,
        fix: `check the network and cloud.origin in ${config.dirName}/config.json` });
    } else if (!cloud.ok) {
      checks.push({ status: 'fail', name: 'cloud', detail: `${origin} answered HTTP ${cloud.status}`,
        fix: 'the cloud is reachable but unhealthy; check its deployment before syncing' });
    } else {
      checks.push({ status: 'ok', name: 'cloud', detail: `${origin} answered ${cloud.status} in ${cloud.ms} ms` });
    }
    probed = true;
  }

  // Token: presence, shape, and — only when the cloud just proved reachable — whether the
  // cloud accepts it. The value itself is never printed, hashed or measured here.
  const token = connection.token || null;
  const source = connection.tokenSource ? `the environment (${connection.tokenSource})` : `${config.dirName}/config.json (cloud.token)`;
  if (!token) {
    if (origin) {
      checks.push({ status: 'fail', name: 'token', detail: 'no token is set; sync and receive need one',
        fix: 'run agentlinkops connect for the app API-key setup path; supply AGENTLINKOPS_TOKEN or AGENTLINKOPS_API_KEY in the environment' });
    } else {
      checks.push({ status: 'skip', name: 'token', detail: 'no token (and no cloud configured)' });
    }
  } else if (!TOKEN_SHAPE.test(token)) {
    checks.push({ status: 'fail', name: 'token', detail: `set in ${source} but it does not look like an AgentLinkOps API key (lt_ plus 64 hex characters)`,
      fix: 'copy the full key without truncation or line breaks; the key itself is never printed here' });
  } else if (!origin) {
    checks.push({ status: 'skip', name: 'token', detail: `set in ${source}; no cloud configured to verify against` });
  } else {
    const cloudLine = checks.find(check => check.name === 'cloud');
    if (cloudLine?.status === 'ok') {
      const probed = await probeToken({ origin, token, workspaceId: config.cloud?.workspaceId, fetchImpl });
      if (probed.verified) {
        record.token = { ok: true };
        checks.push({ status: 'ok', name: 'token', detail: `set in ${source}; the cloud accepted it (watches:read works)` });
      } else if (probed.verified === false) {
        record.token = { ok: false, code: probed.code };
        const fix = probed.code === 'INSUFFICIENT_SCOPE' ? `issue a key carrying ${probed.scope ?? 'watches:read'}`
          : probed.code === 'WORKSPACE_DENIED' ? `check cloud.workspaceId in ${config.dirName}/config.json against the workspace the key belongs to`
          : probed.code === 'UNAUTHORIZED' ? 'issue a fresh key (this one is invalid or expired) and update where it is set'
          : 'sync will fail the same way; act on the code above';
        const detail = probed.code === 'INSUFFICIENT_SCOPE' ? `the cloud accepted it but scope ${probed.scope ?? 'watches:read'} is missing`
          : probed.code === 'WORKSPACE_DENIED' ? 'the credential belongs to a different workspace'
          : probed.code === 'UNAUTHORIZED' ? 'the cloud rejected it (invalid or expired)'
          : `the cloud answered ${probed.code}${probed.status ? ` (HTTP ${probed.status})` : ''}`;
        checks.push({ status: 'fail', name: 'token', detail, fix });
      } else {
        checks.push({ status: 'skip', name: 'token', detail: `set in ${source}; not verified (${probed.error})` });
      }
    } else {
      checks.push({ status: 'skip', name: 'token', detail: `set in ${source}; not verified (cloud unreachable)` });
    }
  }
  // Citation engines: presence only, never the value. A missing credential is a skip,
  // not a failure — the mock engine runs everything, and a repository that never set a
  // live key has not broken anything it asked for.
  if (env.PERPLEXITY_API_KEY) {
    checks.push({ status: 'ok', name: 'citations', detail: 'PERPLEXITY_API_KEY is set; live citation runs available' });
  } else {
    checks.push({ status: 'skip', name: 'citations', detail: 'no engine credential set; mock citation runs work, live runs need PERPLEXITY_API_KEY' });
  }

  // Browser engines: the Camoufox stack. Each missing piece names its fix; none
  // of it fails doctor, because API and mock engines do not need it.
  try {
    await import('playwright-core');
    const { execFile } = await import('node:child_process');
    const camoufoxOk = await new Promise((resolve) => {
      execFile('camoufox', ['--version'], { timeout: 8000 }, (error) => resolve(!error));
    });
    if (camoufoxOk) {
      checks.push({ status: 'ok', name: 'browser', detail: 'playwright-core + camoufox present; browser engines available' });
    } else {
      checks.push({ status: 'skip', name: 'browser', detail: 'playwright-core ok but camoufox missing', fix: 'python3 -m pip install cloverlabs-camoufox[geoip] && python3 -m camoufox fetch' });
    }
  } catch {
    checks.push({ status: 'skip', name: 'browser', detail: 'browser engines unavailable: playwright-core not installed', fix: 'npm install playwright-core (API and mock engines are unaffected)' });
  }

  out(`agentlinkops doctor — ${config.dir}`);

  // Record the probe outcomes beside the cursors they protect — BEFORE rendering, so the
  // "(recorded in state.json)" note on the cloud line is a fact rather than an intention. A
  // state file that cannot be read was already reported above; the note then says so instead
  // of failing doctor twice.
  if (probed) {
    const cloudLine = checks.find(check => check.name === 'cloud');
    try {
      const current = state ?? await readState(config.paths.state);
      await writeState(config.paths.state, { ...current, doctor: record });
      if (cloudLine) cloudLine.detail += ' (recorded in state.json)';
    } catch (error) {
      if (cloudLine) cloudLine.detail += ` (result NOT recorded: ${error.message})`;
    }
  }

  const failed = render(checks, out);
  return failed ? 1 : 0;
}
