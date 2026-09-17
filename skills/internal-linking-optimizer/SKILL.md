---
name: internal-linking-optimizer
description: Audit content pages and add strategic internal links across TSX templates and MDX files. Use for internal linking, topical clusters, orphaned content, contextual links, SEO link strategy, or content network improvements.
---

# Internal Linking Optimizer

Use this skill when adding internal links to existing content pages. This skill does not create new content pages.

## The orphan-page doctrine (the trap this skill exists to close)

A new page with zero inbound internal links is invisible: no authority flows in and
no user can reach it. This is the DEFAULT state of every new page, and it survives
every build gate. A broken-link audit only proves outbound links resolve; it cannot
tell you nothing links IN. After publishing any page, prove inbound links exist from
established pages:

```bash
# Must return at least one file that is NOT the page itself and NOT the sitemap.
# Run over your content roots (SITE.md).
grep -rl '"/<new-slug>/"' <your-content-roots> | grep -v "<new-slug>" | grep -v sitemap
```

If it returns nothing, the page is orphaned. Fix it by editing established, related
pages to link in (3+ inbound links is the working floor), not by waiting for it to
"get picked up".

## Workflow

1. Read `references/source-prompt.md` before changing files.
2. Scan content pages and separate them from application or functional pages.
3. Map topics, content relationships, orphaned pages, and content clusters.
4. Choose natural anchor text already present in the content when possible.
5. Add a conservative number of contextual links per page.
6. Verify destinations exist and links use the repo's expected relative path or routing pattern.
7. Report source page, destination page, anchor text, and reason for each link added.

## Linking heuristics

- 3-5 contextual links per content page is the working baseline; stay natural, not
  quota-driven.
- Link bidirectionally between closely related pages; a one-way link between
  siblings is usually half-done.
- Route authority downhill: link from high-authority pages to important but
  lower-authority pages, not only the reverse.
- Prefer links in the main content body over sidebar/footer/nav slots; body links
  carry the semantic signal.
- Build pillar-cluster shape: overview pages link to every variant page and each
  variant links back.

## Guardrails

- Do not change application logic or functional components.
- Preserve existing content and valuable links.
- Use React or Next.js link patterns in TSX, and markdown or MDX link patterns in MDX.
- Avoid generic anchors and repeated identical anchors to the same destination.
