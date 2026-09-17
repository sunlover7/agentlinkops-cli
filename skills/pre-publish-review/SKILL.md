---
name: pre-publish-review
description: The combined pre-publish gate - one pass for SEO (meta tags, structured data, internal linking, content optimization) and one for editorial quality (grammar, tone, clarity, reading level, terminology, claims policy). Use before shipping any new or rewritten page, or when asked to review, edit, proofread, or QA a page. This is the final review after the required content passes.
---

<!-- publisher-seo-kit:content-workflow-route v2 -->
## Required content passes

When this skill writes or revises public-facing prose, follow this package's pipeline order (the skills are siblings in this package): `source-cited-content-builder` →
`source-cited-humanizer` → `content-defingerprinting` → `internal-linking-optimizer`,
then the applicable image and `pre-publish-review` steps. Apply linking and review to
the actual surface, including outreach email and third-party placements. Keep existing
send/publish approvals. A pass not run is not a pass completed.
<!-- /publisher-seo-kit:content-workflow-route -->


# Pre-Publish Review

Two review passes over the page, one report. Pass A is the SEO gate; pass B is the
editorial gate. Resolve the site's domain, niche, page types, voice, and claims
policy from `.claude/SITE.md` before starting (start from
`templates/SITE.template.md` in this package if the project has none). Review the RENDERED page where
possible, not just the source.

## Pass A: SEO review

### Meta tags and titles

- Title tag: 50-60 characters (and under ~600 rendered pixels), primary keyword included
- Meta description: 150-160 characters, compelling, ends on a complete sentence
- Canonical URL set; Open Graph and Twitter Card tags present
- No duplicate titles or descriptions across pages

### Structured data (JSON-LD)

- Organization schema site-wide; BreadcrumbList for navigation
- Page-type schema where it fits: Article for editorial pages, Product/Review ONLY
  where the page genuinely contains a review, FAQPage where a real FAQ renders,
  HowTo for step-by-step guides, LocalBusiness only if the site serves local intent
- The same content must feed the schema and the visible page (no schema-only FAQs)
- Validate: no errors in Google's Rich Results Test

### Internal linking

- 3+ outbound internal links to related pages, descriptive anchors (never "click here")
- 3+ INBOUND links from established pages: run the orphan check from
  `internal-linking-optimizer`; a page nothing links to is invisible
- Hub pages link to all their spokes; important pages within 3 clicks of home

### Content optimization

- Exactly one H1, matching page intent; clean H1 > H2 > H3 hierarchy
- Primary keyword in the first 100 words; natural density (do not stuff)
- Alt text on all images; keyword or synonym in alt text and file name where honest
- External links to authoritative sources
- No keyword cannibalization: this page's title and inbound anchors must not
  compete with an existing page's primary target

### Technical

- Clean URL structure; page present in the sitemap; mobile responsive; no broken links

### Page types and keyword targets

Derive the real patterns from SITE.md. Generic examples for a comparison publisher:

| Page type | Key SEO elements | Keyword pattern |
|-----------|------------------|-----------------|
| Category hub (`/guides/`) | Head keywords, links to every child | "[category]", "best [category]" |
| Comparison (`/compare/x-vs-y/`) | "X vs Y" intent, comparison table, FAQ | "[X] vs [Y]", "difference between [X] and [Y]" |
| Review (`/reviews/<vendor>/`) | Review/Product schema, evidence-first, disclosure | "[brand] review", "is [brand] legit" |
| Topic explainer (`/what-is-[topic]/`) | Definitional intent, answer-first intro | "what is [topic]", "[topic] explained" |
| Tool (`/[task]-calculator/`) | Utility intent | "[task] calculator" |

## Pass B: Editorial review

### Tone and voice

Resolve the target voice from SITE.md and hold every page to it. For a comparison
site the reader is a careful buyer checking your work, so evidence beats enthusiasm.
Reader-first, direct, trustworthy; claims carry evidence. No hype, no condescension,
no undefined niche jargon.

### Clarity and readability

- Reading level: target 8th grade (Flesch-Kincaid)
- Sentences: 15-20 words average; paragraphs: 2-4 sentences
- Active voice: "You compare the prices", not "The prices are compared"
- Define technical terms on first use

### Consistency

- One term per concept, enforced from the SITE.md terminology table. Sample for a
  health-adjacent comparison site (note the claims-policy rows):

| Use | Don't use |
|-----|-----------|
| research compound | supplement, medication |
| third-party tested (with a published CoA) | lab tested (unverified) |
| certificate of analysis (CoA) | test paper, lab sheet |
| price per mg | cost (when comparing value) |
| you | one, the customer |

- Spell out one through nine, numerals for 10+; always numerals for money,
  percentages, ages. Dates spelled out (January 15, 2026).
- Consistent bold/bullets/callouts; descriptive link text

### Accuracy and currency

- Verify numbers, dates, names against their sources; is the information still current?
- Links work and go to the right place; sources cited where needed; nothing missing

### Claims policy (health-adjacent niches)

Any medical, dosage, or "safe/effective for humans" language about research
compounds is a CRITICAL finding. Affiliate disclosure must be present on pages
with affiliate links. See SITE.md claims policy.

## Red flags to report (either pass)

1. Duplicate meta/title across pages, missing H1, or thin content (<300 words on a substantive topic)
2. Keyword stuffing or unnatural repetition
3. Missing or wrong schema on key pages; schema asserting content the page lacks
4. Orphan pages and broken internal links
5. Missing image alt text
6. Hype where the reader wants evidence; passive-voice walls; undefined jargon
7. Inconsistent terminology ("CoA" here, "lab report" there)
8. Outdated facts (old prices, defunct links); incomplete instructions
9. Claims-policy violations and missing affiliate disclosure

## Output format

```markdown
## Pre-Publish Review: [Page URL]

### Verdict: SHIP | FIX FIRST | REWORK   (overall grade A-F)

### SEO (Pass A)
- Title: "[current]" - [OK/issue]
- Description: "[current]" - [OK/issue]
- Canonical/OG: [OK/missing]
- Schema: [types present] - [missing/errors]
- H1 + hierarchy: [OK/issue]
- Internal links: [X] out / [X] in - orphan: [yes/no]
- Keyword: "[primary]" placement [OK/issue]; cannibalization risk: [none/page]

### Editorial (Pass B)
- Voice fit (SITE.md): [good/needs work]
- Grade level: [X]; avg sentence: [X] words; passive: [X]%
- Terminology: [consistent/list conflicts]
- Claims policy: [clean/VIOLATIONS listed first]

### Issues (ranked, most severe first)
1. [Location]: "[original]" -> issue -> "[suggested fix]"

### Quick wins
1. [Easy improvement]
```

## Sample rewrites (the editorial bar)

Too vague:
> This vendor is arguably one of the better options currently available on the market.

Evidence-first:
> This vendor publishes a third-party CoA for every batch and shipped our test order in two days. Most competitors do neither.

Too complex:
> The product is subjected to independent HPLC verification protocols to substantiate purity assertions.

Simple and direct:
> An independent lab tests each batch for purity using HPLC. The vendor publishes the results, so you can check them yourself.

## Relationship to sibling skills

- `onpage-seo-audit` REFACTORS a page (keyword/entity/schema work); this skill GATES
  it. Run the audit to fix, this review to ship.
- The banned-phrase scan is `source-cited-humanizer`, using `source-cited-content-builder` rules;
  run it before this review, not instead of it.
