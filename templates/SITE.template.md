# SITE.md — fill-in template

Copy this file to `.claude/SITE.md` in the site's repository and fill in every section. The
content skills in this package resolve their rules from it: remove a section only if it truly
does not apply, and say so in its place — an empty section reads as "no rules", which is a
different statement than "not applicable here". Placeholder text in brackets is not a value;
nothing ships with brackets left in.

Nothing in this file is sent anywhere. It is the customer's own judgment about their own site,
kept in their own repository.

## Site identity

- **Public site:** [https://example.com/] — [static export / SSR / plain HTML; where content lives in the repo]
- **What the business sells:** [one sentence, in the reader's words]
- **Niche:** [the niche, stated narrowly enough that "relevant publisher" is decidable]
- **Page types:** [hub / comparison / review / explainer / tool — the real URL patterns, e.g. /compare/x-vs-y/]

## Voice

[2-4 sentences a new writer can hold every page to. Name the reader and what they are checking.
Evidence beats enthusiasm, or whatever is true for this site. If a fuller voice reference exists
in the repo, link it here and keep this section as the summary. Read by: source-cited-content-builder
(drafting), source-cited-humanizer (the pass), pre-publish-review (Pass B).]

## Terminology table

One term per concept. Enforced by pre-publish-review; used by the humanizer pass.

| Use | Don't use | Notes |
| --- | --- | --- |
| [preferred term] | [term to avoid] | [why, or a claims-policy pointer] |
| [preferred term] | [term to avoid] | |

## Claims policy

[What may be claimed, with what evidence, and what may never be claimed. For health-adjacent,
legal or financial niches this section is load-bearing: state the categories that are CRITICAL
findings if asserted without evidence (medical, dosage, legal, financial outcomes), the disclosure
rules (e.g. affiliate disclosure placement), and who signs off on edge cases. Read by:
source-cited-content-builder (guardrails) and pre-publish-review (claims-policy findings).]

## Niche primary sources

[The sources this niche's facts must come from, ranked. Government, standards bodies, utilities,
manufacturers, recognized industry publications — then the niche's own credible primary sources.
Name any source class that must NEVER be cited (e.g. vendor marketing claims for health-adjacent
facts). Read by: source-cited-content-builder, step 2 — this list is what "your niche's preferred
primary sources (SITE.md)" resolves to.]

## Content roots

[The directories or URL prefixes where publishable content lives, for the orphan check and the
internal-link pass. Example: content pages under /guides/ built from content/ in the repo. Read
by: internal-linking-optimizer (scan scope, orphan grep) and pre-publish-review (Pass A linking).]

- Content directories: [paths in the repository]
- Published URL patterns: [patterns, e.g. /guides/<slug>/]
- Sitemap: [path or URL, if one exists]
