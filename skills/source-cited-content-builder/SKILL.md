---
name: source-cited-content-builder
description: Write or refactor source-cited web content with a concise human tone, strict citation fields, grammar constraints, no em dashes, and a large banned phrase list. Use for content building, content humanizing, blog/page copy, guides, comparison and review pages, and SEO content drafts that must follow the site's exact source and style rules.
---

<!-- publisher-seo-kit:content-workflow-route v2 -->
## Required content passes

When this skill writes or revises public-facing prose, follow this package's pipeline order (the skills are siblings in this package): `source-cited-content-builder` →
`source-cited-humanizer` → `content-defingerprinting` → `internal-linking-optimizer`,
then the applicable image and `pre-publish-review` steps. Apply linking and review to
the actual surface, including outreach email and third-party placements. Keep existing
send/publish approvals. A pass not run is not a pass completed.
<!-- /publisher-seo-kit:content-workflow-route -->


# Source-Cited Content Builder

Use this skill when writing or revising content that must follow the user's citation, grammar, and banned-phrase rules.

## Workflow

1. Read `references/source-prompt.md` before writing or editing content.
2. Gather facts from reputable, citable sources. Favor government, standards bodies, utilities, manufacturers, and recognized industry publications. Add your niche's preferred primary sources on top (SITE.md). For a comparison site in a regulated niche that means peer-reviewed literature, supplier certificates of analysis, and the relevant regulator's pages, and never marketing claims from vendors.
3. Record each unique source with Title, Publisher, Publication Date, and URL.
4. Draft concise, conversational copy using active voice.
5. Check the copy against the banned word and phrase list in the source prompt.
6. Remove em dashes from the final content.
7. Before treating the page as ready, run your site's pre-publish SEO checklist (info-gain, answer-first, entity/keyword discipline, internal links, meta length).

## Humanize pass on existing copy

This skill is also the standalone humanizer: run it on ANY content after it is
written, whoever or whatever wrote it (this is stage 2 of the content pipeline).

1. Read `references/source-prompt.md`.
2. Scan the file(s) against the full banned word and phrase list, the grammar rules
   (active voice, concise conversational sentences), and the em-dash ban.
3. Fix each violation in place; keep meaning, citations, and structure intact.
4. Report what changed: each banned term found and its replacement.

Nothing else in a typical build chain checks tone. A page can pass every structural
gate and still read as AI slop; this pass is the only thing standing in the way.

## Guardrails

- Do not invent facts or cite weak sources when official sources exist.
- Keep source records near the content or in the repo's existing citation field format.
- In a YMYL or YMYL-adjacent niche (legal, financial, health-adjacent, research compounds), pair this skill with your site's compliance review (SITE.md claims policy) before public-facing publication.

## The prompt reference

`references/source-prompt.md` is generic and applies to any site: the citation
fields, the grammar rules, and the ~600-term banned-phrase list are in force
verbatim. The one thing the operator adds is niche-specific source preferences
(step 2 above), recorded in SITE.md, not by editing the reference.
