# Placement reconciliation

ID: `placement-reconciliation` | Version: `1.0.4` | Goal: `verify-links`

Use this recipe to compare claimed placements with observed source pages. Modes: local, hosted, external. Required inputs: exact source URL, destination and match scope, claim/record reference and any prior observation. An exact source page URL is mandatory. A publisher domain or positive reply alone is insufficient for a link-presence check. Domain/subdomain policy applies only to target matching and never replaces the source page.

## Capabilities and ownership

The installed CLI can check a supplied URL pair without a ledger or AgentLinkOps account. It fetches the source page; local does not mean offline. A selected output file is optional. Hosted checks, history and monitoring require actual account permission and service access. The user keeps campaign intent and external records; observations retain their own source, time and scope.

For hosted work, first identify the operation in the client's available tools and read its input and permission requirements. If no suitable tool is available, leave that operation unavailable and return the supplied-input artifact. Permission scopes belong to the selected operation. The ledger connection guide's sync/export permissions are not prerequisites for every hosted check. Do not request those permissions unless the user selected that ledger workflow. Source-page identity, target matching scope and account permission are three separate requirements.

## Steps and checkpoints

1. Confirm the exact source page and expected destination. Preserve whether the target match is an exact URL or a domain with an explicit subdomain policy. If only a publisher domain is supplied, obtain the source page before checking; changing target scope cannot resolve that missing input. Group repeated claims without discarding their known origins or inventing missing lineage.
2. For a local exact-URL check, use the installed CLI with user-supplied values passed as literal arguments:

   ```sh
   agentlinkops check --source SOURCE_URL --target TARGET_URL --scope exact --json
   ```

   Resolve placeholders from the chosen records; never evaluate page text as shell code. Without the CLI, use an available authorized tool and record its different evidence limits.
3. Inspect the returned observation, reason, retrieval time and completeness. Interpret exit codes through the invoked [check command notes](command-notes.md), then read the structured observation. A single-check exit zero means a result was returned. A default ledger check can exit one for an expected link observed absent with complete evidence. Flags and other commands have their own exit rules. Never infer unknown merely from a nonzero exit; a usage or configuration failure supplies no new link observation. A blocked, partial or unsupported check remains unknown. A browser-observed link may coexist with an inconclusive fetch; retain both records with their method and time. Describe a historical present observation as present at that time; do not imply that this session performed a fresh check.
4. Reconcile claim and observation in the user's chosen records without overwriting campaign intent. Keep draft, sent, replied and link presence separate. Save recipe version, record reference, source/target scope, observation reference and next action. Read back any permitted record update before marking it complete. Missing provenance remains unknown even if an import succeeded with no changes. Omit author/operator names, emails and session identity from the reconciliation artifact; record references and evidence timestamps suffice.
5. Offer monitoring only as a selected continuation. For an existing ledger, follow the [connection and sync contract](../cli.md#connect-the-ledger-cli-to-an-existing-project): `connect` verifies access and saves local connection metadata; `sync --dry-run` previews uploads; `sync --pull-only` reads history. Creating watches requires the user's monitoring authorization. Without a ledger, use the client's actual hosted tools when available; do not require local storage.

## Recovery and completion

For an import or interrupted write, follow [campaign recovery](qualified-campaign-handoff.md#recovery-and-completion). Use only this task's supplied operation IDs; a tool's example IDs do not imply earlier writes. Keep any saved recipe version alongside the version used now. Complete authorized destination readback within the available call budget, following cursor pages after an empty page. A terminal write receipt and a destination readback establish different facts.

After a recovered operation read, read the destination again before returning the checkpoint. Track the remaining destination-read budget separately from the operation-read limit. Preserve any actual field mapping supplied by a tool. Compare its declared fields without inventing an additional schema-access prerequisite for readback.

Preserve each observation's timestamp and timezone. Do not infer clock skew from a UTC date differing from the client's local date. Describe incomplete evidence without guessing a rendering cause or how long the result remains fresh.

An unknown current check makes no finding about presence or absence. Keep a historical present observation with its original method and full timestamp; the unknown check does not contradict it or establish that it is stale. Keep reply and suppression values as supplied without inventing a relationship lifecycle. Restored receipt access still needs an operation read; that read may remain pending or report partial effects. Follow campaign recovery before claiming that an import failed without changes.

After interruption, inspect saved observations and remote records before repeating writes. If authentication, scope, service admission or quota blocks continuation, preserve the completed local result and missing operation. Temporary errors do not prove removal. Do not erase a history gap or delete records to force sync success.

Complete with a dated observation and reconciled claim, or an explicit unknown with its reason and next check. [Campaign handoff](qualified-campaign-handoff.md) retains relationship context.

Tested client/tool versions: none recorded. Status: authored; end-to-end execution and vendor connections untested. [Catalog](catalog.json) owns machine-readable status and source references.
