// Suggested prompts are editable starting points, never measured search demand.
import { citationPanelSchema, CITATION_PANEL_VERSION } from './contract.js';
import { validatePublicUrl } from '../verifier/url.js';

function domainName(value) {
  if (typeof value !== 'string' || /[\s/?#@:]/.test(value)) throw new Error('domain must be a hostname without a path');
  const url = new URL(`https://${value}/`);
  if (!validatePublicUrl(url.href).valid) throw new Error('domain must be a public hostname');
  return url.hostname.toLowerCase().replace(/^www\./, '');
}
export function buildStarterPanel({ domain, brand, topic, aliases = [], engines = [{ engine: 'mock' }],
  samples = 10, maxUsd = 1, competitors = [], prompts, locale = 'en-US', country } = {}) {
  if (!domain || !brand) throw new Error('domain and brand are required');
  const targets = [{ domain: domainName(domain), scope: 'domain', brand, aliases }];
  const normalizedCompetitors = competitors.map(c => ({ ...c, domain: domainName(c.domain), aliases: c.aliases ?? [] }));
  return citationPanelSchema.parse({
    schema_version: CITATION_PANEL_VERSION, note: `Editable prompt suggestions for ${brand}; verify audience relevance before running.`,
    targets, competitors: normalizedCompetitors, prompts: prompts ?? defaultPrompts(topic || brand),
    engines, samples, maxUsd, locale, country: country ?? locale.split('-').at(-1),
  });
}
function defaultPrompts(topic) {
  return [
    { id: 'definition', text: `What is ${topic}?` },
    { id: 'options', text: `Which ${topic} tools should I compare?` },
    { id: 'workflow', text: `How can I get started with ${topic}?` },
    { id: 'alternatives', text: `What alternatives to ${topic} should I consider?` },
    { id: 'evidence', text: `What evidence should I check when choosing ${topic}?` },
  ];
}

// The input is the user's retained research, never a claim that this command queried a source.
export function selectResearchPrompts(records, { limit = 50 } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > 5000) throw new Error('Research must contain 1–5000 prompt records');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Prompt limit must be 1–500');
  const seen = new Set(); const groups = new Map();
  for (const record of records) {
    if (!record || typeof record.text !== 'string' || !record.intent_cluster || !record.provenance) throw new Error('Each researched prompt needs text, intent_cluster and provenance');
    const text = record.text.trim().replace(/\s+/g, ' '); const key = text.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    const prompt = { text, intent_cluster: record.intent_cluster, branded: record.branded === true, provenance: { ...record.provenance, basis: 'user_supplied' } };
    const group = groups.get(record.intent_cluster) ?? []; group.push(prompt); groups.set(record.intent_cluster, group);
  }
  const selected = [];
  while (selected.length < limit && [...groups.values()].some(group => group.length)) {
    for (const group of groups.values()) if (group.length && selected.length < limit) selected.push(group.shift());
  }
  return selected.map((prompt, index) => ({ id: `research-${index + 1}`, ...prompt }));
}
