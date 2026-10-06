# Portable ledger handoff

Capability: local draft-only file. Native vendor acceptance: untested. No network
or messages. Workspace/project identities are supplied by the customer and are
not verified against hosted grants by this helper.

Run the CLI's frozen report first:

```sh
agentlinkops report --json --as-of 2026-09-30T12:00:00Z --out report.json
python3 scripts/portable-handoff.py --report report.json --mapping mapping.json --out handoff.json
```

Use your own observation cutoff, rather than copying this example's date.
`mapping.json` requires version 1, workspace_id, project_id, site (an explicit URL),
destination `portable-file`, source_report_sha256 and records. Compute the report
hash from JSON encoded with sorted keys, compact separators and UTF-8; the helper's
`digest` function defines it. This local command prints the value:

```sh
python3 -c 'import hashlib,json; r=json.load(open("report.json")); print(hashlib.sha256(json.dumps(r,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest())'
```

Each records key is an actual local ledger ID, with
external_id, reply (`unknown`, `none`, `replied`) and suppression (`unknown`,
`suppressed`, `clear`). Supply these from your own tools; an empty field never
means permission to send. Every report row needs an explicit mapping. Unknown
customer IDs must stay unknown; do not fabricate a mapping to make export pass.

The handoff carries the original report state, observation date and evidence block,
including any hash and locator, plus a stable operation ID. Notes and optional
commercial references are not copied. `ref` is private by default in the report;
this helper uses your explicit mapping instead. Identical reruns read the original
file. A different report, site or existing output refuses before replacement.
Keep a distinct output for a new snapshot; this is a dated artifact, not a monitor.

Read the saved JSON back before claiming persistence. Its destination outcome is
`not_attempted`, and `send_eligible` remains false on every row. Passing this helper
does not prove a CRM import or sequencer readback. Follow the
[qualified campaign handoff](recipes/qualified-campaign-handoff.md) for explicit
mapping, original-operation reconciliation and destination readback. After a
response-lost import, preserve its actual operation identity and unknown outcome;
do not replace it with this file's operation ID or repeat a create to repair an
artifact error. [Placement reconciliation](recipes/placement-reconciliation.md)
keeps monitoring facts apart from sent/replied/suppressed records.

Package invocation assumes the plugin's root directory. Local source invocation
uses toolkit/plugin/agentlinkops/scripts/portable-handoff.py. Unsupported native
vendors, mailbox access and automatic suppression synchronization remain outside
this helper. No account, credential or send action is installed by it.
