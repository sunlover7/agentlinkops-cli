import { z } from 'zod';
export const CITATION_EVIDENCE_LIMITS = Object.freeze({ records: 5, envelopeBytes: 65536, requestBytes: 196608, projectRows: 10000, projectBytes: 16777216, rawRetentionDays: 30 });
const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.-]+$/).refine(value=>value!=='.'&&value!=='..');
export const citationEvidenceRecordInput = z.object({
  envelopeJson: z.string().min(2).max(CITATION_EVIDENCE_LIMITS.envelopeBytes), sha256: hash,
  cliVersion: z.string().min(1).max(100), localEvidenceSha256: hash.optional(),
  screenshot: z.object({ reference, sha256: hash.nullable().optional() }).strict().optional(),
}).strict();
export const citationEvidenceIngestInput = z.object({ projectId: id, records: z.array(citationEvidenceRecordInput).min(1).max(CITATION_EVIDENCE_LIMITS.records) }).strict();
export const citationEvidenceListInput = z.object({ projectId: id.optional(), epochId: z.string().min(1).max(200).optional(), cellId: z.string().min(1).max(4096).optional(), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const citationEvidenceGetInput = z.object({ observationId: id }).strict();
const screenshot = z.object({ reference: reference.nullable(), sha256: hash.nullable(), retained: z.literal(false) }).strict();
export const citationEvidenceObservation = z.object({
  id, workspace_id: id, project_id: id, epoch_id: z.string(), cell_id: z.string(), run_index: z.number().int().nonnegative(),
  engine_identity: z.string(), engine: z.string(), provider: z.string(), model: z.string().nullable(), provider_model_version: z.string(),
  prompt_sha256: hash, content_sha256: hash, local_evidence_sha256: hash.nullable(), ingest_cli_version: z.string(),
  byte_length: z.number().int().positive(), observed_at: z.string(), created_at: z.string(), expires_at: z.string(),
  evidence_status: z.enum(['retained','expired']), screenshot,
}).strict();
export const citationEvidenceIngestOutput = z.object({
  imported: z.number().int().nonnegative(), deduplicated: z.number().int().nonnegative(), total: z.number().int().positive(), charged_units: z.literal(0),
  observations: z.array(z.object({ id, created: z.boolean(), evidence_status: z.enum(['retained','expired']), sha256: hash, expires_at: z.string() }).strict()),
}).strict();
export const citationEvidenceListOutput = z.object({ observations: z.array(citationEvidenceObservation), cursor: z.string().nullable() }).strict();
export const citationEvidenceGetOutput = z.object({ observation: citationEvidenceObservation, envelopeJson: z.string(), integrity: z.object({ sha256: hash, verified: z.literal(true) }).strict(), screenshot }).strict();
