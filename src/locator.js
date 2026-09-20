// The evidence locator (DP-0004-T05): where a recorded link is, without rendering anything.
//
// An agent that has been told a link exists wants two things: to see the occurrence we recorded,
// and to go look at the page. Neither needs the captured HTML, and **the captured HTML must
// never be the thing we render.** The evidence route already refuses to: it serves the snapshot
// as `application/json`, as an attachment, `no-store`, under `default-src 'none'; sandbox`. This
// module gives the other half — a position and a way to open the real page — from metadata
// alone.
//
// Two distinctions run through everything here, and both are about not lying by omission.
//
//   **The locator points into the DOCUMENT WE FETCHED, not into the live page.** Line 1,069 of
//   what we captured on the 11th may be line 900 today, or gone. It is a position in evidence,
//   which is exactly what makes it useful for reading the evidence and useless for anything else.
//
//   **Static and rendered evidence stay apart.** A static observation proves the link was in the
//   served HTML. It says nothing about whether a reader sees it, and a locator that blurred the
//   two would be the most convincing place to do it.
export const LOCATOR_LIMITS = Object.freeze({ occurrences: 50, fragmentChars: 300, contextChars: 320 });

/**
 * A text fragment that makes a browser scroll to and highlight the anchor on the LIVE page.
 *
 * `-`, `,` and `&` are delimiters inside the fragment syntax, so they are percent-encoded beyond
 * what `encodeURIComponent` does. Text spanning a line break cannot be matched as one run, so
 * anything with a newline is refused rather than silently truncated into a fragment that lands
 * somewhere else on the page.
 */
export function textFragment(sourceUrl, text) {
  const phrase = String(text ?? '').trim();
  if (!phrase || /[\r\n]/u.test(phrase)) return null;
  // Too short to be distinctive, and a one-character fragment highlights the wrong thing.
  if (phrase.length < 3) return null;
  const trimmed = phrase.slice(0, LOCATOR_LIMITS.fragmentChars);
  const encoded = encodeURIComponent(trimmed).replace(/-/gu, '%2D').replace(/,/gu, '%2C').replace(/&/gu, '%26');
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (!/^https?:$/u.test(url.protocol)) return null;
  // A text fragment lives after any existing fragment, not instead of it.
  const existing = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  url.hash = `${existing}:~:text=${encoded}`;
  return url.href;
}

const followedOf = (rel, directives) => {
  const tokens = (rel ?? []).map(value => String(value).toLowerCase());
  if (tokens.includes('nofollow') || tokens.includes('sponsored') || tokens.includes('ugc')) return false;
  if (directives?.nofollow) return false;
  return true;
};

/**
 * Turns a stored observation into somewhere to look.
 *
 * Takes the observation's own `result` — the object the verifier produced, which both the cloud
 * and `agentlinkops check` store — so this works identically on a row from either.
 */
export function locateOccurrences(observation, { limit = LOCATOR_LIMITS.occurrences } = {}) {
  const result = observation?.result ?? observation ?? {};
  const occurrences = Array.isArray(result.occurrences) ? result.occurrences : [];
  const sourceUrl = result.finalUrl ?? result.sourceUrl ?? null;
  const rendered = result.evidence?.rendered === true;
  return {
    v: 1,
    observation_id: observation?.id ?? null,
    state: result.state ?? null,
    reason: result.reason ?? null,
    source_url: result.sourceUrl ?? null,
    // Where we actually read, which is not always where we were sent.
    final_url: sourceUrl,
    target_url: result.targetUrl ?? null,
    observed_at: result.checkedAt ?? observation?.checked_at ?? null,
    checker_version: result.evidence?.checkerVersion ?? observation?.checker_version ?? null,
    // Named rather than implied. A static observation is not a claim about what a reader sees.
    evidence_method: rendered ? 'rendered' : 'static_html',
    rendered,
    evidence: {
      key: observation?.evidence_key ?? null,
      sha256: result.evidence?.sha256 ?? null,
      bytes: result.evidence?.bytes ?? null,
      // A reader has to know the snapshot may be gone before they plan around fetching it.
      retrieval: observation?.evidence_key ? 'GET /v1/observations/{id}/evidence, 410 once expired' : null,
    },
    occurrence_count: result.occurrenceCount ?? occurrences.length,
    truncated: occurrences.length > limit || result.occurrencesTruncated === true,
    occurrences: occurrences.slice(0, limit).map((item, index) => ({
      index,
      href: item.href ?? null,
      resolved_target: item.targetUrl ?? null,
      anchor: item.anchor ?? null,
      rel: item.rel ?? [],
      followed: followedOf(item.rel, result.directives),
      context: typeof item.context === 'string' ? item.context.slice(0, LOCATOR_LIMITS.contextChars) : null,
      // A position in the EVIDENCE, labelled as one.
      in_captured_document: item.locator ?? null,
      // A position in the LIVE page, which is where a human should actually look.
      open_at: textFragment(sourceUrl, item.anchor) ?? textFragment(sourceUrl, item.context) ?? sourceUrl,
    })),
    page_directives: result.directives
      ? { noindex: result.directives.noindex ?? null, nofollow: result.directives.nofollow ?? null, indexing_status: result.directives.indexingStatus ?? null }
      : null,
    // Said once, plainly, on every locate. The alternative is a reader who opens the live page,
    // sees something different, and concludes the tool is wrong.
    notes: [
      'Positions are offsets into the captured document, not into the page as it is now.',
      rendered
        ? 'This observation was rendered; occurrences may include links written by the page\'s own scripts.'
        : 'Static HTML observation. JavaScript execution and visual visibility were not checked.',
      'open_at points at the live page with a text fragment. The page may have changed since it was observed.',
    ],
  };
}
