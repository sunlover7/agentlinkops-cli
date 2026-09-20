// The evidence reference (DP-0004-T21): one stable, linkable name for one observation.
//
// A report row says a link was present on a date. A reference is the part that lets a reader
// point at the observation BEHIND that sentence — after the document was forwarded, after the
// session that produced it is gone, and, for the repository mirror, after the hosted account
// is cancelled. The buyer-lane demand this answers: an agency has to show a client WHY it
// believes a placement state, not just that it does.
//
// Two storages, because that is where observations actually live:
//
//   hosted — the workspace's immutable observation row. Resolves through `locate_link`,
//            `get_evidence` or `GET /v1/observations/{id}/evidence` while the workspace
//            exists; the raw snapshot answers 410 EVIDENCE_EXPIRED once its lifecycle
//            removes the bytes, and the reference still names the observation.
//   mirror — the customer's repository observations file, keyed the way `observationKey`
//            keys a row: which entry, when it was checked, and who ran the check. Resolves
//            offline with `agentlinkops locate --ref …` from the repository alone.
//
// A reference is DERIVED, never minted. Every component comes from immutable observation
// data, so the same observation produces the same reference on any machine on any day, and
// nothing in a reference is live session state — which is what makes an export that carries
// them survivable past cancelation. Anchoring (DP-0042-T07) will later make the content hash
// independently verifiable; the reference is the handle that hash attaches to.
export const EVIDENCE_REFERENCE_VERSION = 1;
const PREFIX = `agentlinkops:evidence/${EVIDENCE_REFERENCE_VERSION}`;
const ID = /^[\w-]{1,128}$/u;
const ORIGINS = Object.freeze(['local', 'cloud']);

const validTimestamp = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));

/** A reference to a hosted observation row. Null rather than a reference that cannot resolve. */
export function hostedEvidenceReference(observationId) {
  if (typeof observationId !== 'string' || !ID.test(observationId)) return null;
  return `${PREFIX}/link/hosted/${observationId}`;
}

/**
 * A reference to an observation in the repository mirror.
 *
 * `checkedAt` is the check's own timestamp (the cloud's, for cloud rows) rather than a local
 * clock, so a replayed event produces the same reference. `origin` says who ran the check,
 * because a local check and a cloud check of the same entry at the same instant are two real
 * observations, not a duplicate.
 */
export function mirrorEvidenceReference(input = {}) {
  const { entryId, checkedAt, origin } = input ?? {};
  if (typeof entryId !== 'string' || !ID.test(entryId)) return null;
  if (!ORIGINS.includes(origin)) return null;
  if (!validTimestamp(checkedAt)) return null;
  return `${PREFIX}/link/mirror/${entryId}/${origin}/${encodeURIComponent(checkedAt)}`;
}

/**
 * Parses a reference back into what it names. Strict on purpose: a malformed reference is a
 * reader's typo or a forged document, and resolving it by similarity would point at the wrong
 * observation while appearing to verify the right one.
 *
 * Target-kind references are not part of this version; a future version adds them rather than
 * this parser accepting a shape nothing resolves.
 */
export function parseEvidenceReference(reference) {
  if (typeof reference !== 'string' || reference.length > 512) return null;
  const parts = reference.split('/');
  if (parts[0] !== 'agentlinkops:evidence' || parts[1] !== String(EVIDENCE_REFERENCE_VERSION)) return null;
  if (parts[2] === 'index') {
    if(parts[3]==='mirror' && parts.length===5 && /^[a-f0-9]{64}$/.test(parts[4]))return {v:1,subject:'index',storage:'mirror',receiptId:parts[4]};
    if(parts[3]==='hosted' && parts.length===7 && ID.test(parts[4]) && ID.test(parts[5]) && /^[a-f0-9]{64}$/.test(parts[6]))return {v:1,subject:'index',storage:'hosted',projectId:parts[4],watchId:parts[5],receiptId:parts[6]};
    return null;
  }
  if (parts[2] !== 'link') return null;
  const [storage, ...rest] = parts.slice(3);
  if (storage === 'hosted') {
    const [observationId] = rest;
    if (rest.length !== 1 || !ID.test(observationId ?? '')) return null;
    return { v: EVIDENCE_REFERENCE_VERSION, subject: 'link', storage: 'hosted', observationId };
  }
  if (storage === 'mirror') {
    const [entryId, origin, encodedAt] = rest;
    if (rest.length !== 3 || !ID.test(entryId ?? '') || !ORIGINS.includes(origin ?? '')) return null;
    let checkedAt;
    try { checkedAt = decodeURIComponent(encodedAt ?? ''); } catch { return null; }
    if (!validTimestamp(checkedAt)) return null;
    return { v: EVIDENCE_REFERENCE_VERSION, subject: 'link', storage: 'mirror', entryId, checkedAt, origin };
  }
  return null;
}

/** How a holder resolves a reference, stated beside the reference rather than guessed at. */
export function describeEvidenceReference(reference) {
  const parsed = parseEvidenceReference(reference);
  if (!parsed) return null;
  if(parsed.subject==='index')return {reference,...parsed,resolves:parsed.storage==='mirror'?['agentlinkops locate --ref <reference> (offline exported index receipt)']:[`agentlinkops call get_index_observation --set projectId=${parsed.projectId} --set watchId=${parsed.watchId} --set receiptId=${parsed.receiptId}`],survives_cancelation:parsed.storage==='mirror'};
  return {
    reference,
    ...parsed,
    resolves: parsed.storage === 'hosted'
      ? [
        'agentlinkops call locate_link --set observationId=<id>  (positions and live-page handoff)',
        'agentlinkops call get_evidence --set subject=link --set observationId=<id>  (retained snapshot; 410 once expired)',
        'GET /v1/observations/<id>/evidence  (HTTP, workspace credentials)',
      ]
      : ['agentlinkops locate --ref <reference>  (offline, from the repository ledger and observations)'],
    survives_cancelation: parsed.storage === 'mirror',
  };
}

export function indexEvidenceReference({receiptId,projectId,watchId,storage='mirror'}={}){
 if(!/^[a-f0-9]{64}$/.test(receiptId??''))return null;
 if(storage==='mirror')return `${PREFIX}/index/mirror/${receiptId}`;
 if(storage==='hosted'&&ID.test(projectId??'')&&ID.test(watchId??''))return `${PREFIX}/index/hosted/${projectId}/${watchId}/${receiptId}`;
 return null;
}
