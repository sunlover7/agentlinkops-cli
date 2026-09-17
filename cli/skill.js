import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// DP-0037-T02: `agentlinkops skill` prints the agent reference, the one text an agent reads once
// per session before its first AgentLinkOps call. The text ships inside the connect skill of the
// pack beside this CLI (references/agentlinkops.md, generated from site/SKILL.md), so what the
// agent reads is the version it has installed, not whatever the website serves today. A
// checkout without a built pack falls back to site/SKILL.md itself. The nudge goes where a
// person reads (stdout after init, stderr after a terminal `tools`, the setup report's next
// steps); a machine reader of `tools --json` or of stderr error objects never sees it.
export const REFERENCE_URL = 'https://agentlinkops.com/SKILL.md';
export const NUDGE = `Run \`agentlinkops skill\` and read it in full before the first AgentLinkOps call in a session (also at ${REFERENCE_URL}).`;
const USAGE = 'skill [--url]';

export async function readReference({ from = fileURLToPath(import.meta.url), packDir = null } = {}) {
  // The pack beside the CLI (the published package), then this repository's generated copy,
  // then a built plugin; a stale dist/ must not shadow the generated source in a checkout.
  const base = dirname(from);
  const packs = packDir ? [packDir] : [join(base, '..', 'skills'), join(base, '..', 'toolkit', 'plugin', 'agentlinkops', 'skills'), join(base, '..', 'dist', 'plugin', 'agentlinkops', 'skills')];
  for (const pack of packs) {
    const path = join(pack, 'agentlinkops-connect', 'references', 'agentlinkops.md');
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text) return { text, source: path };
  }
  const site = resolve(dirname(from), '..', 'site', 'SKILL.md');
  const text = await readFile(site, 'utf8').catch(() => null);
  if (text) return { text: text.replace(/^---\n[\s\S]*?\n---\n\n?/u, ''), source: site };
  throw new Error(`No agent reference found beside this CLI; read ${REFERENCE_URL}.`);
}

export async function skillMain(argv, { out = console.log, from, packDir = null } = {}) {
  const rest = argv.slice(1);
  if (rest.some(a => !['--url'].includes(a))) { out(USAGE); return 2; }
  if (rest.includes('--url')) { out(REFERENCE_URL); return 0; }
  const { text } = await readReference({ from, packDir });
  out(text.replace(/^<!--[^\n]*-->\n/u, '').trimEnd());
  return 0;
}
