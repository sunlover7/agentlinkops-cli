# Recipe command notes

Source review: October 6, 2026. The selection guidance below describes maintained source; package and client release acceptance are separate. Older published versions may lack these flags. Inspect `agentlinkops --help` before using them.

`agentlinkops setup --plan --goal verify-links|prepare-campaign|build-content --mode local|hosted|external` inspects known workspace paths and returns a plan. It does not connect an account or change records.

`agentlinkops check --source SOURCE_URL --target TARGET_URL --scope exact --json` checks one supplied pair. Exit zero means it returned a result; read the structured observation to determine presence and evidence limits.

A ledger check exits one when an expected link is observed absent with complete evidence. Unknown results do not establish removal. Usage or configuration errors supply no new observation. Other commands and flags have their own exit rules; inspect `agentlinkops --help` and the returned result.

The plan and check behavior above retains the CLI review from September 20, 2026.

## Optional writing and review guidance

Use the customer's chosen source, editorial and review process. Selecting a recipe does not select the packaged content skills. If the customer chooses that pack's writing method, explicitly select each required stage:

```sh
agentlinkops agent setup --skill source-cited-content-builder --skill source-cited-humanizer --skill content-defingerprinting --skill internal-linking-optimizer --skill pre-publish-review
```

Alternatively, choose `agentlinkops agent setup --all-skills` when the customer wants the complete pack. Read the selected skills and follow their own rules, including the separate editorial pass and final-text scan. Keep reviews tied to the actual revision and message or page format. A missing or unrun required review leaves that review incomplete; recipe selection, installation or a green build does not pass it.

## Optional continuations

Use the customer's own next-step process, or select a packaged continuation separately. Choose `agentlinkops agent setup --recipe placement-reconciliation` before reading [placement reconciliation](placement-reconciliation.md), or `agentlinkops agent setup --recipe site-context-brief` before reading the [site brief](site-context-brief.md). A catalog entry or link does not establish that the recipe is installed.
