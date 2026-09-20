# From research to a checked shortlist

Keep research notes beside the user's project. The graph release, source retrieval date and qualification explain why a page is on the shortlist. They do not establish a live backlink.

Use `agentlinkops skill --list` to see the installed set and `agentlinkops skill agentlinkops-discovery` to read the research workflow. `agentlinkops skill` still prints the connection and evidence reference.

Create a CSV with exact source and target pages:

```csv
source_url,target_url
https://publisher.example.org/resources,https://example.com/guide
```

Preview normalization before writing:

```sh
agentlinkops import shortlist.csv --target example.com --from csv --map source=source_url,target=target_url
```

The preview is not a live check or a watch. Inspect accepted and rejected rows. For a selected opportunity that has not been earned, initialize a local ledger when needed and add it as wanted:

```sh
agentlinkops init
agentlinkops add --source https://publisher.example.org/resources --target https://example.com/guide --intent wanted --note "Research candidate; link not yet earned"
agentlinkops check --all --json
```

The local check includes wanted entries; `--all` rechecks the selected rows even if their cadence is not yet due. Keep observed absence separate from unknown access failures. Once the user has an earned placement, record the exact source/target pair as expected and retain the observation date and evidence.

For an already connected workspace, `agentlinkops tools monitoring` and `agentlinkops describe monitor_link` expose the current hosted contract. Inspect project IDs and usage first. Enroll selected source/target pairs only when recurring monitoring is within the user's request; record the returned watch IDs. A successful import or local check alone does not create a recurring hosted job.

The [campaign skill](../skills/agentlinkops-campaigns/SKILL.md) handles subsequent campaign judgment. The [CRM reference](cli.md) covers optional records when the user needs contacts and activities beside the ledger. Outreach stays in the user's chosen tool and requires their instruction.
