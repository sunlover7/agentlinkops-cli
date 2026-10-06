// `agentlinkops status` and `agentlinkops diff`: where intent and fact disagree, and what changed.
//
// This is the command the direction's selling moment actually runs. The customer commits an
// expectation, closes the laptop, and three weeks later an agent opens the repository and reads
// this. So it answers in the order a person cares about, not the order the data is stored in:
// what appeared, what was lost, what we cannot say, and what needs a decision.
import { latestByEntry } from './mirror.js';

/** A ledger entry whose observations disagree with its declared intent. */
export function disagreements(entries, observations) {
  const latest = latestByEntry(observations);
  const out = [];
  for (const entry of entries) {
    const row = latest.get(entry.id);
    if (!row) { out.push({ entry, kind: 'never_checked' }); continue; }
    if (entry.intent === 'expected') {
      const hostedState = row.source === 'cloud' ? row.result?.watchState : null;
      const confirmed = row.state === 'confirmed_missing'
        || (row.state === 'absent' && hostedState === 'confirmed_missing');
      const suspected = row.state === 'suspected_missing' || row.state === 'absent'
        || (row.state === 'unknown' && hostedState === 'suspected_missing');
      const missing = ['absent', 'suspected_missing', 'confirmed_missing'].includes(row.state);
      // The change mirror omits repeated checks, so raw absence cannot prove confirmation.
      if ((confirmed || suspected) && row.complete === true) {
        out.push({ entry, row, kind: confirmed ? 'lost' : 'suspected_missing' });
      } else if (missing || ['unknown', 'source_unavailable'].includes(row.state)) {
        out.push({ entry, row, kind: 'cannot_say' });
      }
    }
    // Nothing is promoted automatically: whether a link that appeared is one we now EXPECT is
    // a judgement about a relationship, not about HTML. So this proposes the edit and stops.
    if (entry.intent === 'wanted' && row.state === 'present') out.push({ entry, row, kind: 'appeared', suggest: { intent: 'expected' } });
  }
  return out;
}

/** Observation rows added since a marker, newest first. */
export function since(observations, marker) {
  if (!marker) return [...observations].reverse();
  return observations.filter(row => String(row.checked_at) > String(marker)).reverse();
}

/** A state change for one entry, which is the only kind of row worth printing in a diff. */
export function transitions(observations) {
  const byEntry = new Map();
  for (const row of observations) {
    if (!byEntry.has(row.id)) byEntry.set(row.id, []);
    byEntry.get(row.id).push(row);
  }
  const out = [];
  for (const [id, rows] of byEntry) {
    const ordered = [...rows].sort((a, b) => (a.checked_at < b.checked_at ? -1 : 1));
    let previous = null;
    for (const row of ordered) {
      // An `unknown` is not a transition. Treating it as one would publish "your link was lost"
      // every time a publisher's CDN had a bad afternoon.
      if (row.state === 'unknown') continue;
      if (previous && previous !== row.state) out.push({ id, from: previous, to: row.state, at: row.checked_at, row });
      previous = row.state;
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}
