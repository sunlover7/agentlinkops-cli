import { isAccessChallenge } from './readiness.js';

// A caller holding HTML can supply private readiness analysis without expanding
// any public evidence DTO. Existing parsed-document-only callers keep their contract.
export function pageQualityReason(parsed, analysis = null) {
  if (parsed.incomplete) return 'incomplete_html';
  if (isAccessChallenge(parsed, analysis ?? {})) return 'access_challenge';
  if (!parsed.links.length && parsed.meta.some(item => item.name === 'refresh')) return 'navigation_requires_browser';
  if (!parsed.links.length && (analysis ? analysis.readiness.possibleLoginWall : parsed.hasPasswordInput)) return 'possible_login_wall';
  if (analysis?.readiness.requiresRender) return 'possible_render_required';
  if (!parsed.links.length && parsed.hasScript && parsed.visibleText.length < 80) return 'possible_render_required';

  return null;
}
