# Local CRM contract

Version 0.2.0; SQLite schema version 4. Python 3.10+ is the only prerequisite.
Examples assume the working directory is this plugin root. Resolve paths from
the installed plugin location when running from a skill. Choose a database
path in the user's working directory, outside the replaceable plugin cache.

```sh
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite init --workspace local-example
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite status
python3 scripts/agentlinkops.py templates
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite product upsert --file product.json
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite opportunity list
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite export --format json --output crm-export.json
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite export --format csv --entity placement --output placements.csv
```

`init` binds this database to exactly one workspace ID. Use an actual cloud
workspace ID if cloud sync is planned. For a purely offline CRM, choose a
stable local name. Workspace and cloud-origin binding cannot be silently
changed. A separate local database is required for a different workspace.

`migrate` creates a SQLite backup before applying pending migrations. It
refuses unrelated databases, newer schema versions and changed migration
checksums. Initialization is idempotent for the same workspace. The CLI has
no destructive reset command. SQLite is not encrypted; rely on the user's
device security and store the file in an appropriate location.

`upsert` reads one object or an atomic array of objects from a file or stdin
(`--file -`, the default). IDs are explicit, stable strings; updating an
existing record changes only supplied fields. References must already exist;
insert product, campaign/contact, opportunity, then activity/placement.

| Entity | Required for a new record, plus `id` | Optional editable fields |
|---|---|---|
| product | `name`, `url` | `audience`, `description`, `target_pages` (URL array), `notes` |
| campaign | `name`, `type` | `product_id`, `template_version`, `status`, `goal`, `target_url`, `notes` |
| contact | `publisher_url` | `name`, `email`, `contact_url`, `source_url`, `observed_at`, `confidence`, `notes` |
| opportunity | `source_url`, `target_url` | `campaign_id`, `contact_id`, `type`, `status`, `evidence` (object), `notes` |
| activity | `kind`, `occurred_at` | `opportunity_id`, `contact_id`, `campaign_id`, `channel`, `external_message_id`, `outcome`, `notes` |
| placement | `source_url`, `target_url` | `opportunity_id`, `project_id`, `watch_id`, `status`, `notes`, `cost_amount`, `cost_currency` |

Timestamps require ISO 8601 with a timezone. Link fields require HTTP(S) URLs.
Null clears an optional relationship ID. Passwords, API keys, tokens,
mailbox credentials and email/message body fields are rejected. Never put
those values into free-text notes either. Contact confidence describes the
evidence, not a promise of email delivery.

Example `product.json`:

```json
{"id":"product-example","name":"Example Resource","url":"https://example.com/","audience":"Resource-page readers","target_pages":["https://example.com/guide"]}
```

Example opportunity evidence:

```json
{"id":"opportunity-example","source_url":"https://publisher.example/resources","target_url":"https://example.com/guide","type":"resource_addition","evidence":{"source_url":"https://publisher.example/resources","observed_at":"2026-09-09T12:00:00Z","context":"Relevant resources section; candidate requires browser review."}}
```

Use `entity list --id ID` to retrieve a specific record. JSON exports preserve
all fields, raw events, the sync cursor, disavow rules and their source provenance. They are portable data exports,
not an automatic full-database restore format. CSV exports select one entity
and prefix possible spreadsheet formulas with `'`; JSON is lossless.
Export files are created with restrictive permissions and never overwritten.
For a restorable database backup, use SQLite's backup API or the SQLite CLI
`.backup` command; do not copy a live database file while a write is running.

## Disavow lists and placement reports

For user-selected disavow files, read [the disavow contract](disavow.md).
The `disavow import/upsert/list/export` commands work offline, require an
explicit URL-prefix property and preserve source provenance. No command
uploads to Google or chooses rules from automated risk labels.

For branded HTML output, read [the report contract](reports.md). The `report`
command supports a project filter and optional local notes/cost fields. Notes
and costs are excluded unless explicitly included. Record a placement cost
as a decimal string paired with an uppercase currency label, for example
`"cost_amount":"12.50","cost_currency":"USD"`. Clear both fields with null.
The CLI validates decimal precision and reports each currency separately.
It does not verify currency labels against a current exchange-rate service.

Existing CRM databases require `migrate` before using version 0.2.0. Schema
versions 3 and 4 add disavow provenance tables and optional placement cost
fields. Existing placements, notes, event history and workspace bindings are
preserved; the helper creates a restorable database backup before upgrading.

## Connect the ledger CLI to an existing project

Local ledger commands work without an account. Cloud sync uses a separate scoped
API key. MCP OAuth credentials stay in the MCP client and cannot authorize REST.

1. Open the invited account's workspace at `https://app.agentlinkops.com/app`.
   An owner or admin selects **Agent access > Create API key**. Choose the
   existing project and the scopes `projects:read`, `watches:read`,
   `watches:write`, `events:read`, and `exports:create`.
2. Save the once-shown credential in the user's secret store. Supply it through
   `AGENTLINKOPS_API_KEY` in the CLI process environment. The ledger CLI also accepts
   `AGENTLINKOPS_TOKEN`; if both are set, they must agree. The `LINKTRAIL_` spellings are
   still read, with a one-line warning, during the pilot compatibility window. Never paste credentials
   into chat, command arguments, or ledger files.
3. Run the installed CLI from the directory containing the existing `.agentlinkops/` (or `.linktrail/`)
   ledger. Replace the script path and IDs below with the installed package path
   and IDs returned by `get_workspace` and `list_projects`.

```sh
node /path/to/installed/plugin/cli/agentlinkops.mjs connect --origin https://app.agentlinkops.com --workspace WORKSPACE_ID --project-id PROJECT_ID --selection selected-links.json
node /path/to/installed/plugin/cli/agentlinkops.mjs sync --dry-run
node /path/to/installed/plugin/cli/agentlinkops.mjs sync --pull-only
```

`selected-links.json` contains an array of existing ledger IDs, such as
`["local-placement-1", "local-placement-2"]`. A mapping file with
`entries: [{"local_id": "local-placement-1"}]` also works. Save an explicit
selection when only part of an existing ledger belongs in cloud monitoring.

`connect` verifies workspace identity, project access and required scopes through
read-only REST calls. It saves connection metadata and the selection in
`.agentlinkops/config.json`, without saving the credential or creating cloud records.
`sync --dry-run` reads local files only and previews uploads. `sync --pull-only`
retrieves cloud history without creating watches. After reviewing the plan, run
`sync` when the user has authorized its proposed monitoring. A saved selection
limits uploads; without one, sync selects expected or earned entries and pauses mapped retired
entries. Wanted entries require `--include-wanted`.

The cloud stores normalized source URLs: `https://example.com` becomes
`https://example.com/`. Send the ledger ID as `localReference` and join returned
rows using `local_reference`. Raw URL string equality can miss an existing watch.
Copy watch IDs from tool results without shortening them.

The Python CRM helper has its own environment settings and workspace binding,
described in [optional cloud sync](#optional-cloud-sync). Ledger `connect` does
not configure that helper. If account access or permission to create a credential
is unavailable, use the existing MCP connection for cloud work and keep local
records intact.

## Optional cloud sync

Set `AGENTLINKOPS_API_URL` to the actual service origin and
`AGENTLINKOPS_API_KEY` using the shell's existing secure environment mechanism.
Create the scoped credential in **Agent access > Create API key** as described
[above](#connect-the-ledger-cli-to-an-existing-project). For this read-only event
sync, select `events:read` and the projects whose events the CRM should receive.
This toolkit does not bundle credentials or create an account. Never paste keys into chat or command-line arguments.

```sh
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite sync --limit 100 --max-pages 100
```

The client requests `GET /v1/events?limit=100&cursor=...`. Production origins
require HTTPS. Loopback HTTP is supported for local development. Redirects
are rejected so bearer credentials never follow an endpoint redirect.
Requests time out after 30 seconds and responses are limited to 4 MiB.

Expected response:

```json
{
  "workspace_id": "workspace-example",
  "events": [{
    "id": "event-example", "workspace_id": "workspace-example",
    "cursor": "opaque-cursor", "type": "watch.state_changed",
    "project_id": "project-example", "watch_id": "watch-example",
    "created_at": "2026-09-09T12:00:00Z",
    "data": {
      "before": {"state": "unknown"},
      "after": {"state": "present", "source_url": "https://publisher.example/resources", "target_url": "https://example.com/guide"},
      "observation_id": "observation-example", "evidence_key": null
    }
  }],
  "next_cursor": "opaque-cursor", "has_more": false
}
```

Each page commits new events, placement overlays and its cursor in one
transaction. Duplicate event IDs are ignored only when the payload is
identical. A changed payload, malformed event or mismatched workspace rolls
back the entire page. Earlier successful pages remain committed if a later
page fails; rerunning resumes at the last committed cursor. Two concurrent
syncs detect a cursor conflict and require a retry.

Events update placement `cloud_state`, `cloud_observed_at` and
`cloud_event_id`. Existing local `status`, `notes` and opportunity links are
preserved. URLs follow the cloud watch snapshot. A previously unseen watch
creates `id: cloud:<watch_id>` only when the snapshot supplies source and
destination URLs. Partial snapshots without a URL pair and unknown event types are retained in the event
feed for later interpretation; they do not fabricate a placement.

HTTP 410 reports `CURSOR_EXPIRED` and does not advance the cursor. Preserve
the database and export first; obtain a current watch snapshot and recover
into a separate database before replaying retained events. Automated snapshot
recovery is not implemented in this version. Removing the cursor alone would
hide a history gap and is not a supported recovery procedure.

All success output is JSON except requested CSV export. Errors are JSON on
stderr with nonzero exit status. HTTP response bodies and credential values
are never included in errors. Local operation has no telemetry.
