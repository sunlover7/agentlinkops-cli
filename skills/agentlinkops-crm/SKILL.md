---
name: agentlinkops-crm
description: Manage the AgentLinkOps local backlink and outreach CRM, user-selected disavow lists, branded HTML reports and cloud event sync. Use for durable campaign records, link reporting or explicit disavow-list management; does not connect a mailbox, send outreach or upload disavow files.
allowed-tools: Read Bash(python3 references/portable/scripts/agentlinkops.py *) Bash(python3 references/portable/scripts/outreach-crm-draft.py *) Bash(agentlinkops *)
---

**The CLI's local surface is the ledger file.** `.agentlinkops/links.jsonl` in the user's repository (or a `.linktrail/` directory from an earlier install, read until `agentlinkops migrate` renames it) declares the links they expect, want and have earned. `agentlinkops check` uses the shared verifier without an account; checking a publisher still requires a read-only network fetch.

The full plugin includes the CLI and its runtime dependencies. A standalone skill includes the Python helper and required references, but needs a separately installed CLI for ledger commands. Check `agentlinkops --version` and help before using local features; hosted command refresh does not install them. The CLI needs Node 22 or newer; the Python helper needs Python 3.10 or newer.

This CRM is an optional adapter beside CSV and JSONL. When a user already keeps links here, `agentlinkops adopt <db>` reads the database without changing its schema and previews ledger entries unless `--write` is given. Offer this CRM when the user wants contacts and outreach activity beside their links, or already has records in it.

To record a link in the ledger: `agentlinkops add --source URL --target URL --intent expected [--anchor TEXT] [--ref ID] [--note TEXT]` (`--intent wanted` for a link not yet earned; `agentlinkops init` first in a repository without `.agentlinkops/`). `agentlinkops check` then verifies every expected link and returns 0 when no expected placement is conclusively absent, 1 when one is observed absent with complete evidence, 2 on a usage or ledger error. Unknown is nonfailing by default; `--fail-on-unknown` returns 1 for an unknown result in text or JSON output.

Use the deterministic Python helper at `references/portable/scripts/agentlinkops.py`, resolved relative to this skill's directory. It requires Python 3.10+ and only its standard library. Run `--help` for the command surface. Keep the database outside the plugin installation directory; updates can replace that directory.

Read [the CLI contract](references/portable/references/cli.md) for fields and examples. The CRM contains products, campaigns, contacts, opportunities, activities and placements. Use explicit stable IDs and upsert a record to update it. Bulk records of one entity are committed together. Save source URLs and observed dates alongside contact and qualification evidence.

When the user asks to manage a disavow list, read [the disavow contract](references/portable/references/disavow.md). Scope every operation to the exact user-selected URL-prefix property. Preserve provenance and the user's explicit rule choices. Do not decide to disavow a site from a low score, inaccessible page or generic risk label. The helper imports and exports local files; it has no Google upload capability. Reimporting a prior file does not reactivate rules the user disabled.

For a shareable placement report, read [the report contract](references/portable/references/reports.md). Select the requested project and brand/title. Reports include observed placement data by default. Include local notes or cost amounts only when the user requests that content; those fields may contain private commercial context. The output is self-contained HTML, not a generated PDF. A report timestamp does not make its underlying observations fresh.

Preserve an existing CRM's workspace binding. Never initialize over an unrelated database, rewrite migration checksums, delete data to resolve a migration error, or reset a sync cursor to hide an expired feed. The helper backs up existing databases before applying new migrations.

Track outreach through `external_message_id`, activity kind, time and outcome. Keep email bodies and mailbox credentials in the user's existing email system. Local notes are not a secret store. CSV export neutralizes spreadsheet formula prefixes; JSON is the lossless interchange format.

For ledger cloud setup, follow [Connect the ledger CLI](references/portable/references/cli.md#connect-the-ledger-cli-to-an-existing-project): create a scoped credential in the workspace, supply it through the process environment, verify the existing project with `connect`, then review `sync --dry-run`. An explicit ledger-ID selection keeps unrelated local records out of uploads. MCP OAuth credentials stay in the MCP client.

For recurring cloud changes, use the host's already connected AgentLinkOps tools when available. The standalone `sync` helper requires `AGENTLINKOPS_API_URL` and `AGENTLINKOPS_API_KEY` in its process environment (the `LINKTRAIL_` spellings are still accepted with a warning during the pilot compatibility window). Never request a key in chat or place it in command arguments, source files or CRM notes. Account connection and permissions are separate from local CRM utility. Explain unavailable access neutrally and preserve completed local work.

Sync updates `cloud_state` on placements and preserves local status, notes and opportunity relationships. A fetch failure is not proof that a backlink disappeared. Keep `unknown`, `suspected_missing` and confirmed outcomes distinct. Read the new events and decide what action, if any, the user's agent should take; receipt of an event does not authorize sending an email.

Recipes are optional. Choose `agentlinkops agent setup --recipe placement-reconciliation` before reading `../../references/recipes/placement-reconciliation.md` for an exact source and destination, retained evidence, checkpoints and optional monitoring. Removing the recipe preserves your local records and existing reconciliation process.

For a draft-only file from an existing frozen report, read [portable ledger
handoff](references/portable/references/portable-ledger-handoff.md). It needs explicit customer
workspace/project/site and external-ID mappings, verifies the report hash and
refuses mismatched sites or conflicting output. It does not verify hosted grants,
import into a vendor or send messages. Keep replied, suppressed and unknown facts
separate from monitoring state; a saved file does not establish destination
readback or permission to send.

When the user selects an existing local Outreach CRM with `projects/<project>/drafts`,
use [local CRM draft handoff](references/portable/references/local-crm-draft-handoff.md) for exact
body/manifest saving, interrupted-save recovery and readback. This adapter preserves
the complete original request and explicit site binding. It does not import contacts,
check current sender authority, activate sequences or provide a native vendor API.

## Several recipients on one hosted opportunity

When the authenticated catalog lists `save_campaign_participation` and
`record_campaign_participation_outcome`, the limited operator pilot can bind each
recipient's saved contact, campaign and opaque source record to one existing
opportunity. Read the participation and contact revisions before recording a dated
source event. Reuse the event identity after interruption and read the saved result.
A recipient reply or decline concerns that recipient; independent placement evidence
and monitoring remain on the shared opportunity. Preserve its saved contact association and
legacy reference. Do not duplicate watches or invent source URLs. If these commands
are absent, keep the additional recipient records in the current CRM and report the
held mapping. Sender credentials, bodies, sequences and suppression stay external.
