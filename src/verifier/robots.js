// RFC 9309 matching, with conservative treatment of unavailable/access-blocked files
// performed by the fetcher. Unknown extension directives are not access grants.
function normalizedOctets(value) {
  return value.replace(/%([0-9a-f]{2})/giu, (_, hex) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[a-z0-9._~-]/iu.test(char) ? char : `%${hex.toUpperCase()}`;
  }).replace(/[^\x00-\x7f]/gu, (char) => encodeURIComponent(char));
}

// Linear-space wildcard matcher; avoids regex backtracking on origin-controlled patterns.
function matches(pattern, path, budget) {
  let anchored = pattern.endsWith('$');
  if (anchored) pattern = pattern.slice(0, -1);
  else pattern += '*';
  let pi = 0;
  let si = 0;
  let star = -1;
  let retry = 0;
  while (si < path.length) {
    if (--budget.remaining < 0) return null;
    if (pattern[pi] === '*') { star = pi++; retry = si; }
    else if (pattern[pi] === path[si]) { pi++; si++; }
    else if (star !== -1) { pi = star + 1; si = ++retry; }
    else return false;
  }
  while (pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

export function robotsDecision(text, url, productToken = 'LinktrailBot') {
  const groups = [];
  let group = null;
  let hasDirectives = false;
  let ruleCount = 0;
  for (const original of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const line = original.split('#', 1)[0].trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!group || hasDirectives) {
        group = { agents: [], rules: [], crawlDelays: [] };
        groups.push(group);
        hasDirectives = false;
      }
      if (value) group.agents.push(value.toLowerCase());
    } else if (group && ['allow', 'disallow', 'crawl-delay'].includes(key)) {
      hasDirectives = true;
      if (key === 'crawl-delay') {
        const delay = Number(value);
        if (value && Number.isFinite(delay) && delay >= 0) group.crawlDelays.push(delay);
      } else if (value.startsWith('/')) {
        if (++ruleCount > 5000 || value.length > 8192) return { allowed: null, reason: 'robots_too_complex' };
        group.rules.push({ allow: key === 'allow', path: normalizedOctets(value) });
      }
    }
  }
  const token = productToken.toLowerCase();
  // PREFIX, not substring. RFC 9309 and Google's implementation both match a robots `User-agent`
  // value against the beginning of the crawler's product token — which is why `googlebot` selects
  // the group for `Googlebot-News`. Substring matching additionally selected a group written for
  // `bot` or `trail`, and since the common case is `Disallow: /`, that refused fetches we were
  // allowed to make and reported them as the publisher's choice.
  //
  // A short prefix like `link` still matches, and that is the spec working as designed rather than
  // a defect: it is the reason crawler names are chosen to be distinctive.
  const specific = groups.filter((item) => item.agents.some((agent) => agent !== '*' && token.startsWith(agent)));
  const applicable = specific.length ? specific : groups.filter((item) => item.agents.includes('*'));
  const path = normalizedOctets(`${new URL(url).pathname}${new URL(url).search}`);
  const matching = [];
  const budget = { remaining: 2_000_000 };
  for (const rule of applicable.flatMap((item) => item.rules)) {
    const matched = matches(rule.path, path, budget);
    if (matched === null) return { allowed: null, reason: 'robots_too_complex' };
    if (matched) matching.push(rule);
  }
  matching.sort((a, b) => b.path.replace(/[\*$]/gu, '').length - a.path.replace(/[\*$]/gu, '').length || Number(b.allow) - Number(a.allow));
  return {
    allowed: matching.length ? matching[0].allow : true,
    reason: matching.length && !matching[0].allow ? 'robots_disallowed' : 'robots_allowed',
    matchedRule: matching[0]?.path ?? null,
    crawlDelaySeconds: Math.max(0, ...applicable.flatMap((item) => item.crawlDelays)),
  };
}
