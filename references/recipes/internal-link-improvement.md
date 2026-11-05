# Internal-link improvement

ID: `internal-link-improvement` | Version: `1.0.0` | Goal: `build-content`

Use this recipe to review a small set of internal-link changes for a chosen site. Modes: local, hosted, external. Required inputs: the site, intended reader task, supplied pages or a saved scan, and the customer's chosen editing or handoff destination.

## Capabilities and ownership

Supplied pages and scan exports are enough to prepare a useful plan without an AgentLinkOps account. The customer owns semantic choices, site edits and publication. When connected hosted tools are available, inspect their current catalog and permission requirements before using them. This recipe creates no scan, recurring schedule, site edit or publication by installation or selection. Use the customer's source and editorial process; the separate content pack is optional.

## Steps and checkpoints

1. Bind the review to the site and exact supplied files or scan ID, completion time and coverage. Read all pages of a chosen result view using its returned continuation. A truncated crawl or missing page is incomplete coverage. Keep observed broken links, unknown fetches and candidate orphan pages distinct.
2. Choose a small set of useful changes. For each, retain the exact source and destination, passage, proposed anchor, reader benefit and supporting evidence. Check that the destination answers the reader's next question and that the source does not already link there. Attribute semantic choices to the customer or agent. A suggestion score is not a ranking forecast, and this site's linkScore is not Google PageRank.
3. Inspect the current source passage before editing. Prefer a relevant existing phrase; do not insert an unsupported claim to fit an anchor. Reject an unsuitable suggestion with a reason. With available hosted access, `save_internal_link_change` can select or dismiss a saved scan subject. Inspect its current schema, retain the request ID and returned change revision, and reconcile stale-scan or revision conflicts before another write. Without that interface, return the same plan in the customer's chosen files.
4. Make only authorized edits through the customer's site tools, preserving their routing, rendering and review rules. Record the exact before and after revisions and the real validation result. A draft or green build does not establish publication. If the customer publishes, retain the deployment or CMS receipt and actual URL. Recording a change as `published` in AgentLinkOps records the claim; it does not publish or verify the page.
5. Verify the public result when authorized. `verify_internal_link_change` performs a separate page check where supported; page-level findings may need a later scan. Inspect the returned state, evidence, limits and next permitted check time. Unknown access does not prove absence. `list_internal_link_changes` and `get_internal_link_report` can provide readback; report comparison must retain coverage and comparability limits. Starting a scan or scheduling recurrence is a separate, explicitly selected action.

## Cost, recovery and completion

Reviewing supplied material makes no network calls or metered checks. Fresh fetches, hosted verification and scans have their own allowance, billing, cooldown and access rules; inspect those before execution. Saving a selected change does not start a scan, schedule or site edit.

Checkpoint the recipe version, source hashes or scan ID, site binding, selected subject/change IDs, request identity, revision, proposed anchor and passage, actual edits, publication claim and independent verification separately. A failed local note write is not a reason to repeat a remote mutation. Read the original operation and saved change first after interruption. Preserve customer edits and any uncertain outcome; do not replace a request identity to hide a conflict.

Finish with reviewed changes and their evidence, rejected or unresolved items, and the next required action. Report preparation, saved selections, site edits, publication and verified links as separate outcomes. Tested client/tool versions: none recorded. Status: authored; end-to-end execution and vendor connections untested. [Catalog](catalog.json) owns machine-readable status. [Command notes](command-notes.md) explain optional selections and local CLI availability.
