import {LINK_TYPE_NAMES, LINK_TYPES} from './link-labels.js';

export const LINK_CATEGORY_CONTRACT = 'link-category-v1';
const states = ['suggested', 'accepted_manual', 'accepted_auto'];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const name = (id, alias) => alias || LINK_TYPE_NAMES[id] || id;

/** Group roles before comparing counts. Decision states remain independent within each role. */
export function groupAssessmentRoles(roles = []) {
  const groups = new Map();
  for (const role of roles) {
    if (!LINK_TYPES.includes(role.id) || role.id === 'guest_post' || !states.includes(role.state) || !count(role.count)) continue;
    const group = groups.get(role.id) ?? {id: role.id, name: name(role.id, role.label), standard_name: name(role.id), count: 0,
      states: {suggested: 0, accepted_manual: 0, accepted_auto: 0}};
    group.count += role.count; group.states[role.state] += role.count; groups.set(role.id, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

const decisionState = roles => {
  const present = states.filter(state => roles.some(role => role.states[state] > 0));
  return present.length === 1 ? present[0] : present.length ? 'mixed' : 'none';
};

const reasonNames = {
  CHOSEN_CATEGORY: 'Saved choice', DELIBERATELY_CLEARED: 'No type', CURRENT_ASSESSMENT: 'Current page assessment',
  PREVIOUS_ASSESSMENT: 'Previous assessment', EVIDENCE_EXPIRED: 'Evidence expired', EVIDENCE_NOT_AVAILABLE: 'Evidence not available',
  PAGE_UNAVAILABLE: 'Page unavailable', LATEST_SOURCE_UNCONFIRMED: 'Latest page check inconclusive',
  NOT_CLASSIFIED: 'Not started', CLASSIFICATION_PENDING: 'Assessment pending', CLASSIFICATION_FAILED: 'Classification failed',
  CLASSIFICATION_UNAVAILABLE: 'Could not load assessment', NO_ELIGIBLE_OCCURRENCES: 'No eligible occurrences',
  NO_ROLE_DETERMINED: 'No page role determined', LINK_ABSENT: 'Link missing in latest check',
};

/** Effect-free watch-level category projection. Persisted model labels are compatibility caches only. */
export function resolveLinkCategory(row = {}) {
  const summary = row.classification, available = summary?.status === 'ready';
  const applicability = summary?.applicability ?? 'unavailable';
  const roles = available ? groupAssessmentRoles(summary.roles) : [];
  const classified = available ? roles.reduce((sum, role) => sum + role.count, 0) : null;
  const assessed = available ? count(summary.assessmentCount) ?? classified : null;
  const eligible = available ? count(summary.eligibleCount ?? summary.count) : null;
  const retained = available ? count(summary.retainedCount) : null;
  const coverage = {assessed, classified, eligible, retained, excluded: available ? count(summary.excludedCount) : null,
    unassessed: eligible === null ? null : Math.max(0, eligible - assessed),
    unclassified: eligible === null ? null : Math.max(0, eligible - classified),
    partial: eligible === null ? null : classified > 0 && classified < eligible};
  let reason = !available ? 'CLASSIFICATION_UNAVAILABLE'
    : applicability === 'expired_source_evidence' ? 'EVIDENCE_EXPIRED'
    : applicability === 'unavailable_source_evidence' ? 'EVIDENCE_NOT_AVAILABLE'
    : roles.length && applicability !== 'current' ? 'PREVIOUS_ASSESSMENT'
    : roles.length ? 'CURRENT_ASSESSMENT'
    : applicability === 'historical_absent' ? 'LINK_ABSENT'
    : applicability === 'unconfirmed_latest_source' ? (summary.source?.pageUnavailable ? 'PAGE_UNAVAILABLE' : 'LATEST_SOURCE_UNCONFIRMED')
    : summary.pendingCount > 0 ? 'CLASSIFICATION_PENDING'
    : summary.failedCount > 0 ? 'CLASSIFICATION_FAILED'
    : summary.capture && eligible === 0 ? 'NO_ELIGIBLE_OCCURRENCES'
    : summary.assessmentCount > 0 || summary.jobCount > 0 ? 'NO_ROLE_DETERMINED' : 'NOT_CLASSIFIED';
  const page = {status: available ? 'ready' : 'unavailable', reason, read_reason: summary?.reason ?? null,
    explanation: reasonNames[reason], applicability, binding: summary?.binding ?? null, capture: summary?.capture ?? null,
    source: summary?.source ?? null, assessed_at: date(summary?.assessedAt), revision: summary?.revision ?? null,
    model_revisions: summary?.modelRevisions ?? [], policy_revisions: summary?.policyRevisions ?? [],
    roles, decision_state: decisionState(roles), mixed: roles.length > 1, coverage,
    pending_count: available ? count(summary.pendingCount) : null, failed_count: available ? count(summary.failedCount) : null,
    job_count: available ? count(summary.jobCount) : null,
    review_required_count: available ? count(summary.reviewRequiredCount) : null};
  const deliberate = row.type_source === 'person';
  const chosenId = deliberate && LINK_TYPES.includes(row.type) ? row.type : null;
  const alias = summary?.roleAliases?.[chosenId];
  const chosen = {intent: deliberate ? chosenId === null ? 'cleared' : 'chosen' : 'automatic',
    id: chosenId, name: chosenId === null ? null : name(chosenId, alias), standard_name: chosenId === null ? null : name(chosenId),
    actor_id: deliberate ? row.type_set_by ?? null : null, recorded_at: deliberate ? date(row.type_set_at) : null,
    revision: row.type_revision ?? 0, deliberate_clear: deliberate && chosenId === null};
  const display = {source: deliberate ? 'chosen' : roles.length ? 'page_assessment' : 'none',
    kind: deliberate ? chosenId === null ? 'cleared' : 'category' : roles.length > 1 ? 'mixed' : roles.length ? 'category' : 'unknown',
    id: deliberate ? chosenId : roles.length === 1 ? roles[0].id : null,
    name: deliberate ? chosen.name ?? 'No type' : roles.length > 1 ? 'Mixed types' : roles.length ? roles[0].name : reasonNames[reason],
    state: deliberate ? chosen.intent : page.decision_state,
    reason: deliberate ? chosenId === null ? 'DELIBERATELY_CLEARED' : 'CHOSEN_CATEGORY' : reason,
    applicability: deliberate ? 'chosen' : applicability, coverage};
  return {category_contract: LINK_CATEGORY_CONTRACT, chosen_category: chosen, page_assessment: page, display_category: display};
}

/** Validate the server projection without recomputing its semantics in a client. */
export function readLinkCategory(row, workspaceId = row?.workspace_id) {
  if (row?.category_contract !== LINK_CATEGORY_CONTRACT) return null;
  const {chosen_category: chosen, page_assessment: page, display_category: display} = row;
  const identity = value => typeof value === 'string' && value.trim().length > 0;
  if (![workspaceId, row.workspace_id, row.project_id, row.id].every(identity) || workspaceId !== row.workspace_id) return null;
  if (!chosen || !page || !display || !page.binding || page.binding.workspaceId !== workspaceId
    || page.binding.watchId !== row.id || page.binding.projectId !== row.project_id) return null;
  if (!['chosen', 'cleared', 'automatic'].includes(chosen.intent) || !['ready', 'unavailable'].includes(page.status)
    || !['chosen', 'page_assessment', 'none'].includes(display.source) || !['category', 'mixed', 'cleared', 'unknown'].includes(display.kind)
    || !identity(display.name) || (display.id !== null && !LINK_TYPES.includes(display.id)) || !Array.isArray(page.roles)
    || (chosen.id !== null && (!LINK_TYPES.includes(chosen.id) || !identity(chosen.name) || !identity(chosen.standard_name)))
    || !['suggested', 'accepted_manual', 'accepted_auto', 'mixed', 'none'].includes(page.decision_state)
    || count(chosen.revision) === null || typeof chosen.deliberate_clear !== 'boolean') return null;
  if (page.roles.some(role => !LINK_TYPES.includes(role.id) || role.id === 'guest_post' || typeof role.name !== 'string'
    || !identity(role.name) || !identity(role.standard_name) || !count(role.count) || !role.states || states.some(state => count(role.states[state]) === null)
    || states.reduce((sum, state) => sum + role.states[state], 0) !== role.count)) return null;
  if (new Set(page.roles.map(role => role.id)).size !== page.roles.length) return null;
  const coverage = page.coverage;
  if (!coverage || ['assessed', 'classified', 'eligible', 'retained', 'excluded', 'unassessed', 'unclassified'].some(key => coverage[key] !== null && count(coverage[key]) === null)
    || coverage.partial !== null && typeof coverage.partial !== 'boolean') return null;
  if (page.status === 'ready' && (coverage.classified !== page.roles.reduce((sum, role) => sum + role.count, 0)
    || coverage.assessed < coverage.classified || coverage.eligible !== null && (coverage.eligible < coverage.assessed
      || coverage.unassessed !== coverage.eligible - coverage.assessed || coverage.unclassified !== coverage.eligible - coverage.classified)
    || coverage.retained !== null && coverage.eligible !== null && coverage.retained !== coverage.eligible + coverage.excluded)) return null;
  if (chosen.intent === 'chosen' && (chosen.id === null || chosen.deliberate_clear)
    || chosen.intent === 'cleared' && (chosen.id !== null || !chosen.deliberate_clear)
    || chosen.intent === 'automatic' && (chosen.id !== null || chosen.deliberate_clear)) return null;
  return {category_contract: row.category_contract, chosen_category: chosen, page_assessment: page, display_category: display};
}

/** New category filters have explicit watch/occurrence scope; the old `type` filter is unchanged. */
export function matchesLinkCategory(row, {category, categoryState, categoryScope = 'shown', assessmentScope = 'current'} = {}) {
  const projection = row.category_contract === LINK_CATEGORY_CONTRACT ? row : {...row, ...resolveLinkCategory(row)};
  const page = projection.page_assessment, display = projection.display_category;
  const previous = page.status === 'ready' && page.applicability !== 'current' && (page.capture !== null || page.roles.length > 0);
  const inScope = page.status === 'ready' && (assessmentScope === 'current' ? page.applicability === 'current' : previous);
  const stateMatches = !categoryState || ({cleared: projection.chosen_category.deliberate_clear,
    not_started: page.reason === 'NOT_CLASSIFIED' && ['current', 'not_prepared'].includes(page.applicability),
    pending: inScope && page.pending_count > 0, classifier_failed: inScope && page.failed_count > 0,
    classifier_unavailable: page.status === 'unavailable', page_unavailable: page.status === 'ready' && page.source?.pageUnavailable === true,
    partial: inScope && page.coverage.partial === true, previous: previous && page.roles.length > 0})[categoryState] === true;
  if (!stateMatches) return false;
  if (category === undefined || category === null) return true;
  if (categoryScope === 'page_role') {
    if (!inScope) return false;
    if (category === 'none') return page.roles.length === 0;
    if (category === 'mixed') return page.mixed;
    return page.roles.some(role => role.id === category);
  }
  if (display.source === 'page_assessment' && (assessmentScope === 'current' ? display.applicability !== 'current' : display.applicability === 'current')) return false;
  if (assessmentScope === 'previous' && display.source !== 'page_assessment') return false;
  return category === 'none' ? display.kind === 'unknown' || display.kind === 'cleared'
    : category === 'mixed' || category === 'cleared' ? display.kind === category : display.id === category;
}
