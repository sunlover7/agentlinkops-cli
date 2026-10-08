// `agentlinkops status` and `agentlinkops diff`: where intent and fact disagree, and what changed.
//
// This is the command the direction's selling moment actually runs. The customer commits an
// expectation, closes the laptop, and three weeks later an agent opens the repository and reads
// this. So it answers in the order a person cares about, not the order the data is stored in:
// what appeared, what was lost, what we cannot say, and what needs a decision.
import { projectPlacements } from './placement-projection.js';

/** A ledger entry whose observations disagree with its declared intent. */
export function disagreements(entries, observations, { state = null } = {}) {
  const out = [];
  for (const projection of projectPlacements(entries, observations, { state })) {
    const { entry, row, latest_attempt: attempt } = projection;
    const activity = { current_state: projection.current_state, uncertain: projection.uncertain,
      latest_attempt: attempt, last_successful_observation: projection.last_successful_observation,
      last_link_verification: projection.last_link_verification,
      evidence_observed_at: projection.evidence_observed_at, identity_status: projection.identity_status };
    if (!attempt) { out.push({ entry, kind: 'never_checked', activity }); continue; }
    if (entry.intent === 'expected') {
      if (projection.uncertain || attempt.state === 'source_unavailable') {
        out.push({ entry, row, kind: 'cannot_say', activity });
      } else if (['suspected_missing', 'confirmed_missing'].includes(projection.current_state)) {
        out.push({ entry, row, kind: projection.current_state === 'confirmed_missing' ? 'lost' : 'suspected_missing', activity });
      }
    }
    // Nothing is promoted automatically: whether a link that appeared is one we now EXPECT is
    // a judgement about a relationship, not about HTML. So this proposes the edit and stops.
    if (entry.intent === 'wanted' && !projection.uncertain && projection.current_state === 'present') out.push({ entry, row, kind: 'appeared', activity, suggest: { intent: 'expected' } });
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
