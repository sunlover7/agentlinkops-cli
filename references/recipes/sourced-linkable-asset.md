# Sourced linkable asset

ID: `sourced-linkable-asset` | Version: `1.0.0` | Goal: `build-content`

Use this recipe for a reference, guide, comparison, dataset, calculator or template that helps a named reader. Modes: local, hosted, external. Required inputs: the site/context brief, reader task, candidate asset or existing page, source material and intended output destination.

## Capabilities and ownership

The agent can write a sourced draft without an AgentLinkOps account. Fetching sources and editing a website depend on the user's available tools. Hosted backlink research is optional and requires actual access. The user's site or content system owns the asset; local CRM storage is optional. For page work, preserve the site's rendering and routing conventions and inspect nearby pages before editing. This recipe contains the writing and review sequence; continue below without loading another asset router.

## Steps and checkpoints

1. Read the site's content instructions and inspect existing pages for the same reader task. Define the useful addition before creating another URL. Start with the site's content skill when present, then use the packaged passes below. If a required review resource is unavailable, identify it before marking the asset reviewed.
2. Write through [source-cited-content-builder](../../skills/source-cited-content-builder/SKILL.md). Preserve source title, publisher, publication date when available, URL and the evidence supporting each factual claim. Mark original calculations and assumptions. Do not manufacture experience or results.
3. Run [source-cited-humanizer](../../skills/source-cited-humanizer/SKILL.md) as a separate editorial pass, then [content-defingerprinting](../../skills/content-defingerprinting/SKILL.md) on the final authored text. Save the actual checks and findings.
4. Apply [internal-linking-optimizer](../../skills/internal-linking-optimizer/SKILL.md) to the chosen format. For owned pages, verify destinations and inbound discovery at release. A document or email handoff needs relevant links without webpage quotas. Use the site's image workflow when the asset calls for images.
5. Run [pre-publish-review](../../skills/pre-publish-review/SKILL.md). Checkpoint the draft revision, intended URL, source records, review receipts and unresolved findings. Read back the artifact from its chosen destination.

## Recovery and completion

Missing sources leave claims unverified; remove or qualify them before review. Missing review tools leave the corresponding pass incomplete. Preserve an existing page and customer edits when resuming. A draft, green build or copied command does not prove publication. If release is authorized separately, verify the actual public content after release and attach that receipt.

Complete this recipe with a reviewed draft and explicit publication state, or an unfinished draft with the precise remaining check. Continue to [campaign handoff](qualified-campaign-handoff.md) only with an honest asset state; a pitch must not describe an unpublished asset as live.

Tested client/tool versions: none recorded. Status: authored; end-to-end execution and vendor connections untested. [Catalog](catalog.json) owns machine-readable status and source references.
