import { readFile, readdir } from 'node:fs/promises';
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
const USAGE = 'skill [--url | --list [--json] | NAME]';

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

export async function readSkillSet({ from = fileURLToPath(import.meta.url), packDir = null } = {}) {
  const base = dirname(from);
  const packs = packDir ? [packDir] : [join(base, '..', 'skills'), join(base, '..', 'toolkit', 'plugin', 'agentlinkops', 'skills'), join(base, '..', 'dist', 'plugin', 'agentlinkops', 'skills')];
  for (const pack of packs) {
    const entries = await readdir(pack, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^agentlinkops-[a-z0-9-]+$/.test(entry.name)) continue;
      const text = await readFile(join(pack, entry.name, 'SKILL.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!text) continue;
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
      const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1] ?? '';
      skills.push({ name: entry.name, description, text, source: join(pack, entry.name, 'SKILL.md') });
    }
    if (!skills.length) continue;
    let version = 'unversioned';
    for (const file of [join(pack, '..', '.claude-plugin', 'plugin.json'), join(pack, '..', 'package.json')]) {
      const manifest = await readFile(file, 'utf8').catch(() => null);
      if (manifest) { version = JSON.parse(manifest).version ?? version; break; }
    }
    return { version, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  throw new Error('No shipped skill set found beside this CLI');
}

export async function skillMain(argv, { out = console.log, from, packDir = null } = {}) {
  const rest = argv.slice(1);
  if (rest.length === 1 && rest[0] === '--url') { out(REFERENCE_URL); return 0; }
  if (rest[0] === '--list' && rest.every(flag => ['--list', '--json'].includes(flag))) {
    const { version, skills } = await readSkillSet({ from, packDir });
    const listing = { version, skills: skills.map(({ name, description }) => ({ name, description })) };
    out(rest.includes('--json') ? JSON.stringify(listing) : `AgentLinkOps skills ${version}\n` + listing.skills.map(skill => `${skill.name} — ${skill.description}`).join('\n'));
    return 0;
  }
  if (rest.length === 1 && /^agentlinkops-[a-z0-9-]+$/.test(rest[0])) {
    const { skills } = await readSkillSet({ from, packDir });
    const selected = skills.find(skill => skill.name === rest[0]);
    if (!selected) { out('Unknown shipped skill; run agentlinkops skill --list'); return 2; }
    out(`<!-- Installed skill source: ${selected.source} -->\n${selected.text.trimEnd()}`); return 0;
  }
  if (rest.length) { out(USAGE); return 2; }
  const { text } = await readReference({ from, packDir });
  out(text.replace(/^<!--[^\n]*-->\n/u, '').trimEnd());
  return 0;
}
