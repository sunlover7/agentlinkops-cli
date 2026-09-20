# Changelog

All notable changes to the `agentlinkops` package are recorded here. The version follows the
plugin manifests in `.claude-plugin/` and `.codex-plugin/`.

## 0.6.2 (unreleased)

- Citation panels support competitor targets and explicit locale contexts. New panels default to the free mock engine; prompt suggestions remain editable.
- Citation reports show bounded epoch history, retained evidence and unknown results. Local cadence commands preserve configured paths and require explicit webhook opt-in.
- Citation statistics retain null rates for all-unknown samples and add supplemental confidence sequences and exploratory change candidates. These do not establish a real-world change date.
- Google AI Overview ingestion validates supplier responses and provenance. Live use requires configured credentials and a budget; missing credentials never select fixture results.
- Cloud-synced link receipts preserve content hashes and checker metadata when the hosted event supplies them.
- Packaging follows dynamic imports and retains the maintained browser providers, with declared runtime dependencies.

## 0.5.1 (2026-09-17)

- The plugin's `.mcp.json` ships in the tarball. 0.5.0 left it out, so a marketplace install
  got the skills but no MCP server entry; the package build now carries and requires it.
- Package identity: `author` is AgentLinkOps (https://agentlinkops.com); `repository` and
  `bugs` point at `sunlover7/agentlinkops-cli`. No personal identity in the registry metadata.
- `agentlinkops citation run PANEL.json --engine chatgpt:web-own-browser`: measures the
  consumer UI through the customer's own Camoufox browser instead of an API, with a screenshot
  of every answer in the evidence. `--engine NAME[:PROVIDER]` overrides the panel's engine list.
  `playwright-core` is an optional dependency; `doctor` reports the browser stack as a skip,
  never a failure, when it is absent (API and mock engines need none of it).
- Repository: CI on every push and a tag-driven release workflow that publishes through npm
  trusted publishing with provenance.

## 0.5.0 (2026-09-16; DP-0036 agent surface)

- `agentlinkops tools [TOOLSET]`, `agentlinkops describe NAME` and `agentlinkops call NAME`:
  the three discovery verbs, answered offline from the bundled catalog snapshot (`--refresh`
  reads the live one). The index prints each toolset's summary; `call` adds `--set`,
  `--dry-run` and `-y`, and retired command names resolve to their canonical command.
- `agentlinkops agent setup` and `agentlinkops agent status`: install the skill pack and the
  right MCP view for each detected client (Claude Code, Codex, Cursor, Gemini CLI, Hermes)
  without storing a credential.
- Skill pack v2: the new `agentlinkops-connect` skill (views, verbs, evidence rules), per-client
  `allowed-tools` and Codex `agents/openai.yaml` metadata, the plugin's `.mcp.json`, and a
  discovery index with deterministic per-skill archives served at
  `/.well-known/agent-skills/index.json`.
- Skill-first onboarding (DP-0037): `agentlinkops skill [--url]` prints the agent reference
  that ships inside the connect skill (`references/agentlinkops.md`); the connect skill is a
  stub that has the agent read it once per session; `init`, a terminal `tools` and
  `agent setup` point at it once. The discovery index now follows the Agent Skills discovery
  specification (`$schema`, `type: archive`) so `npx skills add https://agentlinkops.com`
  installs the four product skills; the content pipeline sits behind
  `https://agentlinkops.com/content`.
- `agentlinkops check --source URL --target URL [--out FILE]`: one accountless local check that
  produces a portable result artifact, and `agentlinkops adopt-result FILE` to save that artifact
  into a ledger once, validated and under the ledger writer lock.
- `agentlinkops setup --plan --goal verify-links|prepare-campaign|build-content [--mode …]`: a
  read-only setup plan from metadata-only workspace inspection; no writes, network or account.
- `agentlinkops receipt history --performance FILE.json`: attaches dated Search Console and
  optional GA4 context from the local context files beside a claim, without claiming causation.
- `node cli/context-mcp.js --root DIR`: the repository-local stdio MCP host for the eight
  context tools. Adds the runtime dependency `@modelcontextprotocol/server` 2.0.0.

## 0.4.0 (2026-09-15)

First public release under the Apache License 2.0.

- `agentlinkops` command: `init`, `add`, `check`, `status`, `diff`, `report`, `import`, `adopt`,
  `sync`, `connect`, `doctor`, `migrate`, `tools`, `call`, `fleet`, `platforms`, `context`,
  `mix`, `receive`, `receipt`, `fmt` and `compact`.
- `linktrail` alias: runs the same command with a one-line notice on stderr. The alias, the
  `LINKTRAIL_*` environment variables and the `.linktrail/` ledger directory stop working on
  2026-10-15; `agentlinkops migrate` renames the directory.
- Shared verifier (`src/verifier/`): the module the hosted service runs, unchanged.
- Import adapters for Ahrefs, Semrush, Majestic, Moz, DataForSEO, Linkody, Google Search Console
  and generic CSV, with an explicit `--map` for any other layout.
- Agent plugin manifests and skills (`agentlinkops-crm`, `agentlinkops-campaigns`,
  `agentlinkops-assets` and the content-pipeline skills), campaign templates and the Python
  CRM helper.
- Dependencies declared instead of vendored: parse5 8.0.1 and zod 4.6.0.
