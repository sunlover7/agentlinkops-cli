# Recipe command notes

`agentlinkops setup --plan --goal verify-links|prepare-campaign|build-content --mode local|hosted|external` inspects known workspace paths and returns a plan. It does not connect an account or change records.

`agentlinkops check --source SOURCE_URL --target TARGET_URL --scope exact --json` checks one supplied pair. Exit zero means it returned a result; read the structured observation to determine presence and evidence limits.

A ledger check exits one when an expected link is observed absent with complete evidence. Unknown results do not establish removal. Usage or configuration errors supply no new observation. Other commands and flags have their own exit rules; inspect `agentlinkops --help` and the returned result.

Continue with [placement reconciliation](placement-reconciliation.md) or the [site brief](site-context-brief.md). These notes describe the packaged CLI behavior reviewed on September 20, 2026.
