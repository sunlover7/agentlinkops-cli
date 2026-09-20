# agentlinkops

A backlink ledger that lives in your repository. `agentlinkops check` fetches a source page,
looks for the link you declared and records an observation with the HTTP status, redirect
chain, robots posture and a SHA-256 of the fetched bytes. Page HTML never enters the repository.
A check that cannot conclude says `unknown` with a named reason, and unknown never means the
link was removed.

The CLI imports the same verifier module the hosted AgentLinkOps service runs, and its tests
assert both paths return the same shape. The hosted checks, evidence store and MCP server are a
separate service; this package is the local half and needs no account.

## Give your agent AgentLinkOps

Four steps, the same ones the docs and the landing page show. Node.js 22.13 or later.

1. **Install the skill.** Detects the agent clients on this machine (Claude Code, Codex,
   Cursor, Gemini CLI, Hermes), installs the skill pack at each one's skills path and writes
   its MCP entry; stores no credential and prints what it changed.

   ```sh
   npx -y agentlinkops agent setup
   ```

   With the `skills` CLI instead: `npx -y skills add https://agentlinkops.com`, then add
   `https://app.agentlinkops.com/mcp` as a remote HTTP MCP server in your client.
2. **Sign in when your agent asks.** The client opens the AgentLinkOps sign-in; you pick the
   account, workspace and scopes. Nothing is pasted into a chat.
3. **Verify.** Ask your agent to list your AgentLinkOps projects, or run `agentlinkops doctor`.
4. **Check a placement.** Ask: "check whether [publisher page] links to [my page], show the
   dated observation and any uncertainty." No account yet? The same verifier runs locally:

   ```sh
   npx -y agentlinkops check --source https://publisher.example/resources --target https://your-site.example/guide
   ```

The skill is a short door: the first time your agent uses AgentLinkOps in a session it reads
the full agent reference, which `agentlinkops skill` prints and
https://agentlinkops.com/SKILL.md serves. Hosted monitoring is an invitation-only pilot; the
local commands below need no account. The package is `agentlinkops` on npm, published by the
`agentlinkops` account; the source is https://github.com/sunlover7/agentlinkops-cli.

## Install the CLI on its own

```sh
npm install -g agentlinkops
agentlinkops --help
```

Or run it once without installing:

```sh
npx agentlinkops check
```

## Check one link with no account

```sh
cd your-repository
agentlinkops init
agentlinkops add --source https://publisher.example.com/resources --target https://example.com/guide --intent expected
agentlinkops check
agentlinkops status
```

`init` creates `.agentlinkops/` with an empty ledger. `add` writes one entry. `check` fetches
the source page and appends an observation to the mirror. `status` names every entry whose
observations disagree with its intent and proposes the edit; applying it is a commit you make.

Exit codes: `0` when every expected link is present, `1` only when an expected link is observed
absent with complete evidence, `2` for a usage, configuration or ledger error. An unknown never
fails the run. Pass `--fail-on-unknown` when your CI wants it to.

`agentlinkops doctor` verifies the ledger, the verifier self-test, cloud reachability and the
token, and prints a fix line for anything that fails.

## The ledger

Intent and fact never share a file. You write intent; the verifier writes fact.

```
.agentlinkops/
  config.json          project identity, cloud origin, defaults. Yours, committed
  links.jsonl          the ledger: intent. Yours, committed
  observations.jsonl   fact mirror, tool-owned, committed
  events.jsonl         cloud event mirror by cursor, tool-owned, committed
  candidates.jsonl     imported and discovered rows, tool-owned, committed
  state.json           cursors and last-check marks, tool-owned, committed
```

One ledger entry:

```json
{"id":"lk_9f3ac1","intent":"expected","source":"https://publisher.example.com/resources","target":"https://example.com/guide","scope":"exact","expect":{"anchor":"guide","rel":["nofollow"]},"cadence":"daily","ref":"q3-resource-pages/441","tags":["resource-page"],"added":"2026-09-11","note":"editor confirmed"}
```

Three intents: `wanted` (we want this publisher to link to us; present is the news),
`expected` (it should be there now; absent is the alarm) and `retired` (stop checking, keep
the history). Nothing promotes an entry automatically. `id` is random and permanent, so a
corrected URL keeps its history. Everything is plain JSON Lines, one entry per line, that you
can read without this tool.

## Imports and adoption

Supplier exports import through presets or an explicit column map, and a preview writes nothing:

```sh
agentlinkops import ahrefs-export.csv --target example.com --from ahrefs
agentlinkops import any-export.csv --target example.com --map "source=Referring page URL,target=Target URL"
```

Presets: Ahrefs, Semrush, Majestic, Moz, DataForSEO, Linkody, Google Search Console and generic
CSV. A preset is a convenience over `--map`, never a requirement. Every rejected row is reported
with its line and reason. Count-per-site Search Console exports are refused, because importing
them would invent placements.

An existing SQLite CRM (the reference adapter in `scripts/agentlinkops.py`) adopts into ledger
entries read-only with `agentlinkops adopt crm.sqlite`; there is no reverse direction.

One page can be checked without a ledger or an account: `agentlinkops check --source URL
--target URL [--scope exact] [--json] [--out result.json]` runs the same verifier and prints one
result. `--out` reserves the file before the fetch and refuses to overwrite. A saved result later
joins a ledger with `agentlinkops adopt-result result.json [--intent wanted|expected]`, which
validates the artifact (no raw HTML, a checksum that must match, a state consistent with its
evidence) and appends the entry and observation once under a writer lock.

## Sync with the hosted service

Local commands need no account. Sync pushes expectations and pulls events and evidence
references into the mirror. It never writes into `links.jsonl`.

```sh
export AGENTLINKOPS_TOKEN=...   # from Agent access > Create API key in the hosted workspace
agentlinkops connect --workspace WORKSPACE_ID --project-id PROJECT_ID --origin https://app.agentlinkops.com
agentlinkops sync --dry-run
agentlinkops sync
```

Hosted access is an invitation-only pilot. The hosted checks, evidence store and MCP server are a
separate service and are not part of this package.

## Citation watches

An AI citation is a placement: a reference to your asset on a surface you do not control,
re-decided by the model on every ask. So the CLI watches it the way it watches a link — a prompt
panel, run against engine APIs on cadence, with dated evidence and honest statistics. A citation
is never reported as "removed": each epoch states the citation rate with a Wilson interval and
its sample size, classified against the previous epoch as declined, grown or
not_distinguishable, or `insufficient_data` when n is too thin to interpret.

```sh
export PERPLEXITY_API_KEY=...          # live engine; omit it and the mock engine runs at $0
agentlinkops citation run panel.json --max-usd 1.00
```

The panel is JSON: `targets` (domain or url, brand, aliases), `prompts`, `engines`
(`mock` or `perplexity`), optional `samples` and `maxUsd`. Every run writes immutable
content-addressed answer snapshots plus append-only observation and epoch rows under
`.agentlinkops/citations/`. The runner reserves estimated cost before each call and retry. A reported supplier
overrun stops later calls; estimates do not enforce a provider invoice cap. A budget
abort leaves a partial-epoch receipt and exit code 2. A cell
that declined with complete evidence exits 1, like an expected link observed absent.

Browser measurement requires `AGENTLINKOPS_PROXY_URL` and refuses direct fallback.
For an explicitly authorized direct diagnostic, set `AGENTLINKOPS_BROWSER_EGRESS=direct-diagnostic`
and leave the proxy unset. The standard URL proxy provides no actual usage meter;
its cost remains an estimate. Browser login and live account acceptance are separate.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `AGENTLINKOPS_TOKEN` or `AGENTLINKOPS_API_KEY` | Scoped credential for `connect`, `sync`, `tools`, `call` and the token probe in `doctor`. If both are set they must agree. |
| `AGENTLINKOPS_API_URL` | Hosted origin when it is not in `config.json`. |
| `AGENTLINKOPS_WEBHOOK_SECRET` | Verifies signed deliveries in `agentlinkops receive`. |
| `AGENTLINKOPS_GSC_TOKEN`, `AGENTLINKOPS_GA4_TOKEN` | First-party context commands under `agentlinkops context`. |
| `AGENTLINKOPS_PROXY_URL` | Proxy URL for browser measurement; credentials are never printed. |
| `AGENTLINKOPS_BROWSER_EGRESS` | Defaults to `proxy-required`; `direct-diagnostic` explicitly permits an authorized diagnostic without a proxy. |
| `PERPLEXITY_API_KEY` | Live engine credential for `agentlinkops citation`. Presence is reported by `doctor`; the value is never printed. |

No value is ever printed. The `LINKTRAIL_*` spellings, the `linktrail` command and a `.linktrail/`
ledger directory are still accepted with a one-line notice on stderr until 2026-10-15; run
`agentlinkops migrate` once to rename the directory. It refuses to merge or delete anything.

## Agent plugin

The package doubles as a plugin: `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`
point at `skills/`, which holds the connect, CRM, campaign and asset skills plus the
content-pipeline skills, with templates in `templates/` and contracts in `references/`.
`agentlinkops agent setup` installs the same skills for any detected client, and the discovery
index at `https://agentlinkops.com/.well-known/agent-skills/index.json` serves them to
`npx skills add` (the content pipeline sits behind `https://agentlinkops.com/content`). Node.js
runs the ledger CLI; Python 3.10 or later runs the optional CRM helper and the watermark
scanner.

## What it does not do

It holds no backlink index, sends no email, verifies no contact address and runs no JavaScript:
observations are static HTML only, and each one says so. Literal IP addresses, reserved hostnames
and non-default ports are refused before any fetch.

## Documentation and source

- Guides: https://docs.agentlinkops.com/guides/first-result and https://docs.agentlinkops.com/guides/connect-cli
- Product: https://agentlinkops.com/
- Source: https://github.com/sunlover7/agentlinkops-cli
- Contract references shipped in this package: `references/cli.md`, `references/disavow.md`, `references/reports.md`

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
