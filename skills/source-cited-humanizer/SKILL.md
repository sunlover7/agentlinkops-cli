---
name: source-cited-humanizer
description: Run the required editorial humanizing pass after drafting or revising public content. Apply the source-cited-content-builder's canonical voice and banned-phrase rules while preserving facts, meaning and citations.
---

# Source-cited humanizer

Run as a separate pass after writing, including outreach copy, contributed articles,
placement content and adapted social posts. Read the sibling
`source-cited-content-builder/SKILL.md` and its `references/source-prompt.md`; they
own the voice rules and banned list. Use the site's more specific voice references
when present. Do not maintain a second copy of the banned list.

Review titles, headings, descriptions and body copy. Remove formulaic framing,
repetition, unsupported certainty, banned phrases and em dashes. Keep useful specifics,
source records and the author's actual meaning. Never invent anecdotes or measurements.
Use the builder's humanize-pass procedure and report the material edits.

Next run `content-defingerprinting`, then `internal-linking-optimizer` for the actual
publishing surface. A clean technical build does not replace this editorial pass.
