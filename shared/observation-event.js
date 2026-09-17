export function eventSnapshot(state) {
  const latest = state.latestAttempt || {};
  const occurrences = (latest.occurrences || []).slice(0, 20).map(item => ({
    targetUrl: String(item.targetUrl || '').slice(0, 4096),
    anchor: String(item.anchor || '').slice(0, 256),
    rel: (item.rel || []).slice(0, 20),
  }));
  return {
    schema_version: 1, target_scope: state.target_scope,
    check_state: latest.state ?? 'unknown', link_signature: latest.linkSignature ?? null,
    checker_version: latest.evidence?.checkerVersion ?? null,
    state: state.state || 'unknown', uncertain: state.uncertain ?? true,
    watch_id: state.watch_id, source_url: state.source_url, target_url: state.target_url,
    checked_at: state.checked_at, reason: latest.reason || null,
    http_status: latest.httpStatus ?? null, expectations: latest.expectations || null,
    occurrences, occurrence_count: latest.occurrences?.length || 0,
    occurrences_truncated: (latest.occurrences?.length || 0) > occurrences.length,
    next_check_at: state.nextCheckAt || null,
  };
}

/** Accept v1 flat events and pre-version snapshots. Reject unknown versions explicitly. */
export function observationFromSnapshot(snapshot) {
  if (snapshot.schema_version !== undefined && snapshot.schema_version !== 1) throw new Error('Unsupported observation event version.');
  if (typeof snapshot.checked_at !== 'string' || !Number.isFinite(Date.parse(snapshot.checked_at))) throw new Error('Invalid observation event timestamp.');
  const latest = snapshot.latestAttempt ?? {};
  const occurrences = snapshot.occurrences ?? latest.occurrences ?? [];
  if (!Array.isArray(occurrences)) throw new Error('Invalid observation event occurrences.');
  return {
    sourceUrl: snapshot.source_url ?? latest.sourceUrl,
    targetUrl: snapshot.target_url ?? latest.targetUrl,
    targetScope: snapshot.target_scope ?? latest.targetScope,
    state: snapshot.uncertain !== false ? 'unknown' : snapshot.state === 'confirmed_missing' ? 'absent' : snapshot.state === 'present' ? 'present' : 'unknown',
    watchState: snapshot.state,
    checkState: snapshot.check_state ?? latest.state ?? null,
    reason: snapshot.reason ?? latest.reason ?? null,
    checkedAt: snapshot.checked_at, occurrences,
    occurrencesTruncated: snapshot.occurrences_truncated ?? false,
    occurrenceCount: snapshot.occurrence_count ?? occurrences.length,
    linkSignature: snapshot.link_signature ?? latest.linkSignature ?? null,
    evidence: {complete: snapshot.uncertain === false, checkerVersion: snapshot.checker_version ?? latest.evidence?.checkerVersion ?? null},
  };
}
