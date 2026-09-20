import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');

function suppliedFieldsPreserved(raw, parsed) {
  if (raw === null || typeof raw !== 'object') return Object.is(raw, parsed);
  if (Array.isArray(raw)) return Array.isArray(parsed) && raw.length === parsed.length && raw.every((value, index) => suppliedFieldsPreserved(value, parsed[index]));
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
    Object.keys(raw).every(key => Object.hasOwn(parsed, key) && suppliedFieldsPreserved(raw[key], parsed[key]));
}

// Historical files were written by JSON.stringify. Retain whitespace and key
// order compatibility, but reject duplicate keys and alternate encodings that
// JSON.parse would discard before semantic reconstruction. Quoted whitespace
// remains part of its token. This is not a replacement JSON grammar parser.
function canonicalEncoding(text, raw) {
  return (text.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s]/g) ?? []).join('') === JSON.stringify(raw);
}

// The v1 runner hashes its construction-order object BEFORE schema parsing and
// before adding screenshot_file. Do not rename or rewrite those historical files.
export function verifyLocalEvidenceDigest({ envelope, text, digest }) {
  if (!envelope || typeof text !== 'string' || !/^[a-f0-9]{64}$/.test(digest ?? '')) return false;
  try {
    const raw = JSON.parse(text);
    if (!suppliedFieldsPreserved(raw, envelope) || !canonicalEncoding(text, raw)) return false;
  } catch { return false; }
  if (envelope.screenshot_file && envelope.screenshot_file !== `${digest}.screenshot.png`) return false;
  if (hash(text) === digest) return true;
  const original = {
    schema_version: envelope.schema_version, epoch_id: envelope.epoch_id,
    cell_id: envelope.cell_id, run_index: envelope.run_index, prompt: envelope.prompt,
    engine_identity: envelope.engine_identity,
    ...(envelope.locale_context ? { locale_context: envelope.locale_context } : {}),
    provider_model_version: envelope.provider_model_version,
    answer: envelope.answer, citations: envelope.citations, fan_out: envelope.fan_out,
    usage: envelope.usage, cost_estimate_usd: envelope.cost_estimate_usd, at: envelope.at,
    ...(envelope.provenance ? { provenance: envelope.provenance } : {}),
    ...(envelope.browser_context ? { browser_context: envelope.browser_context } : {}),
    ...(envelope.failure ? { failure: envelope.failure } : {}),
  };
  // Token counts default to zero at schema parse. Try only those lossless zero
  // defaults, not arbitrary omitted evidence or alternative citation contents.
  for (const omitInput of [false, true]) for (const omitOutput of [false, true]) {
    if ((omitInput && envelope.usage.input_tokens !== 0) || (omitOutput && envelope.usage.output_tokens !== 0)) continue;
    const usage = { ...envelope.usage };
    if (omitInput) delete usage.input_tokens;
    if (omitOutput) delete usage.output_tokens;
    if (hash(JSON.stringify({ ...original, usage })) === digest) return true;
  }
  return false;
}
