---
name: agentlinkops-assets
description: Improve a code-built site's resource, guide or research page for a specific backlink campaign, with sourced claims and useful internal links. Use when a campaign requires a better linkable asset; avoid unrelated site-wide rewrites.
allowed-tools: Read Grep Glob Edit Bash(npm run *) Bash(agentlinkops call *)
---

Read the repository's applicable instructions and the campaign's publisher/audience evidence before editing. Define what the target reader needs and what the current page lacks. Prefer an asset with independent utility: a sourced reference, comparison, original dataset, calculator, template or practical guide that fits the product.

Preserve the project's rendering and routing conventions. Inspect nearby pages before changing a Next.js or other code-built site. Keep factual claims tied to sources and dates, distinguish original analysis from reported facts, and preserve qualifications that affect accuracy. Do not invent expertise, statistics, citations or endorsements.

Write plainly and specifically. Remove repetition and generic filler without deleting necessary evidence. Add internal links only where the destination answers the reader's next relevant question; inspect the actual routes before linking. Check for an existing competing page before creating a new URL.

Use the site's existing validation commands appropriate to the change. Record the final target URL, reader benefit and evidence in the customer's chosen files, CRM or other record system. The bundled local CRM is optional; use [its contract](../../references/cli.md) only when the customer chooses that store. A completed local edit does not establish that the page is deployed or that a publisher accepted it.

Recipes are optional. Choose `agentlinkops agent setup --recipe sourced-linkable-asset` before reading `../../references/recipes/sourced-linkable-asset.md` for draft review receipts and publication state. Select `--recipe site-context-brief` separately before reading that recipe if the audience or evidence needs clarification. Your own brief and editorial process can serve the same task.
