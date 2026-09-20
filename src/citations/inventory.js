import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { citationPanelSchema, evidenceEnvelopeSchema, targetKey } from './contract.js';
import { panelEpochs } from './report.js';
import { analyzeRetainedAnswer } from './match.js';
import { parseOpportunityRecord, opportunityRecordId, ELIGIBILITY_GATES } from '../../shared/opportunity-record.js';
const hash = value => createHash('sha256').update(value).digest('hex');

export async function freezeCitationInventory({ dir, panel: input, epochId }) {
  const panel = citationPanelSchema.parse(input);
  const epochs = await panelEpochs({ dir, panel });
  const cells = epochId ? epochs.find(rows => rows[0]?.epoch_id === epochId) : epochs[0];
  if (!cells) throw new Error('No matching panel epoch to freeze');
  epochId = cells[0].epoch_id;
  if (!/^[A-Za-z0-9_.-]+$/.test(epochId) || ['.', '..'].includes(epochId)) throw new Error('Invalid epoch reference');
  const root = await realpath(resolve(dir)); const evidenceDir = join(root, 'citations/evidence', epochId);
  let files = [];
  try {
    if (!(await lstat(evidenceDir)).isDirectory() || !(await realpath(evidenceDir)).startsWith(root + '/')) throw new Error('Unsafe evidence directory');
    files = await readdir(evidenceDir);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const observations = []; const identities = new Set(); let invalid = 0;
  for (const file of files.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const path = join(evidenceDir, file);
    if (!(await lstat(path)).isFile()) { invalid++; continue; }
    let envelope, text;
    try { text = await readFile(path, 'utf8'); envelope = evidenceEnvelopeSchema.parse(JSON.parse(text)); }
    catch { invalid++; continue; }
    if (envelope.epoch_id !== epochId || !cells.some(cell => cell.cell_id === envelope.cell_id)) continue;
    const identity = `${envelope.cell_id}|${envelope.run_index}`;
    if (identities.has(identity)) throw new Error('Duplicate observation identity in retained evidence'); identities.add(identity);
    const [, promptId, key] = envelope.cell_id.split('|');
    const target = panel.targets.find(target => targetKey(target) === key);
    if (!target) continue;
    const prompt = panel.prompts.find(prompt => { const id = prompt.id ?? hash(prompt.text).slice(0, 10); return id === promptId || promptId?.startsWith(`${id}@`); });
    const analysis = envelope.engine_identity.startsWith('google-aio:') && !envelope.provenance ? { mentioned: null, cited: null, outcome: 'unknown' } : analyzeRetainedAnswer(target, envelope);
    observations.push({ cell_id: envelope.cell_id, run_index: envelope.run_index, engine_identity: envelope.engine_identity,
      prompt_id: promptId, prompt: envelope.prompt, headline_eligible: !prompt?.branded, prompt_provenance: prompt?.provenance ?? null,
      intent_cluster: prompt?.intent_cluster ?? null, target: key, observed_at: envelope.at,
      provider_model_version: envelope.provider_model_version, locale_context: envelope.locale_context ?? null,
      mentioned: analysis.mentioned, cited: analysis.cited, outcome: analysis.outcome,
      citations: analysis.outcome === 'unknown' ? [] : envelope.citations,
      evidence_sha256: hash(text), fixture: envelope.engine_identity.startsWith('mock:') });
  }
  const expected = cells.reduce((count, cell) => count + (cell.n ?? 0) + (cell.unknowns ?? 0), 0);
  const payload = { schema_version: 1, kind: 'frozen_citation_inventory', epoch_id: epochId, frozen_at: new Date().toISOString(),
    scope: 'Only the retained observations in this fixed panel epoch; missing rows do not prove absence.',
    absence_claim: 'not_supported', panel: { ...panel, mockFixtures: undefined }, cells,
    spent_estimate_usd: Math.max(0, ...cells.map(cell => cell.spent_estimate_usd ?? 0)),
    missing_envelopes: Math.max(0, expected - observations.length), invalid_envelopes: invalid, observations };
  return { ...payload, inventory_sha256: hash(JSON.stringify(payload)) };
}

function validateInventory(inventory) {
  if (inventory?.kind !== 'frozen_citation_inventory') throw new Error('A frozen citation inventory is required');
  const { inventory_sha256, ...payload } = inventory;
  if (hash(JSON.stringify(payload)) !== inventory_sha256) throw new Error('Frozen inventory checksum does not match');
}

export function citationGap(inventory) {
  validateInventory(inventory);
  return { inventory_sha256: inventory.inventory_sha256, absence_claim: 'not_supported',
    scope: 'Citation and mention counts describe this dataset only, separately by engine, prompt and target.',
    cells: inventory.cells.map(cell => {
      const rows = inventory.observations.filter(row => row.cell_id === cell.cell_id);
      const known = rows.filter(row => row.outcome !== 'unknown');
      const cited = known.filter(row => row.cited).length;
      return { cell_id: cell.cell_id, n: known.length, cited, mentioned: known.filter(row => row.mentioned).length,
        unknowns: rows.length - known.length, missing_envelopes: Math.max(0, (cell.n ?? 0) + (cell.unknowns ?? 0) - rows.length),
        headline_eligible: rows.length > 0 && rows.every(row => row.headline_eligible),
        finding: !known.length ? 'unknown' : cited ? 'cited_in_this_dataset' : 'not_cited_in_these_known_samples' };
    }),
    mentioned_not_cited: inventory.observations.filter(row => row.mentioned === true && row.cited === false).map(row => ({ cell_id: row.cell_id, prompt: row.prompt, evidence_sha256: row.evidence_sha256 })) };
}

export async function exportCitationSources(inventory, { niche, consentRef, excludedInputsAttested = false } = {}) {
  if (!consentRef || !excludedInputsAttested) throw new Error('Library export requires a written consent reference and an explicit excluded-inputs attestation');
  validateInventory(inventory);
  const records = new Map();
  for (const row of inventory.observations) {
    if (row.outcome === 'unknown' || !row.headline_eligible) continue;
    // Private named-brand questions are not public opportunity-library fields.
    if (inventory.panel.targets.some(target => [target.brand, ...(target.aliases ?? []), target.domain].filter(Boolean).some(value => row.prompt.toLowerCase().includes(value.toLowerCase())))) continue;
    for (const citation of row.citations) {
      const host = new URL(citation.url).hostname; const subject = { host, page_url: citation.url, route_url: null, surface: 'ai_citation' };
      const id = await opportunityRecordId(niche?.id, subject);
      if (records.has(id)) continue;
      const at = row.observed_at;
      const record = { schema_version: 1, record_id: id, status: 'held', niche, opportunity_type: 'ai_citation_source', type_basis: 'observed', subject,
        observed: { rel_tokens: null, indexing: 'unknown', cost_basis: 'unknown', audience_statement: null, cited_destinations: [],
          ai_citation: { query: row.prompt, model: row.provider_model_version ?? 'unknown', observed_at: at } },
        contact_route: { class: 'unknown', deliverability: 'not_checked', observed_at: null },
        eligibility: { gates: ELIGIBILITY_GATES.map(gate => ({ gate, verdict: 'not_satisfied', because: row.fixture ? 'fixture_not_live_evidence' : 'public_page_and_rights_review_pending', observed_at: null })) },
        verification: { route_state: 'unverified', listing_state: 'not_checked', last_verified_at: null, next_due_at: null, window_days: 90, unknown_streak: 0, reason: 'page_verification_pending' },
        provenance: { source_class: 'consented_project_lane', run_id: inventory.epoch_id, seed_reason: row.fixture ? 'fixture_only' : 'retained_assistant_citation', consent_ref: consentRef, first_seen_at: at, last_seen_at: at },
        rights: { basis: 'owned_observation_of_public_page', redistributable: false, excluded_inputs_attested: true, takedown_route: 'withdraw_on_request' },
        evidence: [{ observed_at: at, observer: 'assistant_query', outcome: row.fixture ? 'unknown' : 'present', reason: row.fixture ? 'fixture_only' : null, page_url: citation.url, http_status: null, sha256: row.evidence_sha256,
          complete: !row.fixture, run_id: inventory.epoch_id, checker_version: 'citation-inventory-v1', rel_tokens: null, anchor: null }],
        dates: { created_at: at, updated_at: at, last_observed_at: at }, withdrawal: null };
      records.set(id, parseOpportunityRecord(record));
    }
  }
  return [...records.values()];
}
