# Local Outreach CRM draft handoff

Use only when the customer selects a local Outreach CRM with an existing
`projects/<crm_project>/config.json` and `drafts/` directory. The config must contain
that exact `project` and a `site` URL with the same hostname as the request.
This adapter writes an inert body and companion manifest under that project's
drafts directory. It does not write contacts, replies, suppression, send logs or
sequence state. Native vendor APIs remain unsupported by this adapter.

Run from the plugin root:

```sh
python3 scripts/outreach-crm-draft.py --crm-root /path/to/customer-crm --request request.json --body-file reviewed-body.txt
python3 scripts/outreach-crm-draft.py --crm-root /path/to/customer-crm --request request.json --body-file reviewed-body.txt --readback
```

`request.json` contains exactly these fields; use actual saved identities rather
than copying the example values:

```json
{
  "version": 1,
  "crm_project": "customer-project",
  "workspace_id": "saved-workspace",
  "project_id": "saved-project",
  "site": "https://customer.invalid",
  "operation_id": "original-operation",
  "original_request": {
    "destination": "saved-service-destination",
    "workspace_id": "saved-workspace",
    "project_id": "saved-project",
    "command": "saved-command",
    "arguments": {"saved-non-secret-argument": "saved-value"},
    "idempotency_key": "original-request-key"
  },
  "local_id": "saved-local-record",
  "external_id": "saved-crm-record",
  "observation": "unknown",
  "reply": "unknown",
  "suppression": "unknown",
  "subject": "Reviewed draft subject",
  "body_sha256": "exact-sha256-of-reviewed-body-bytes"
}
```

Preserve the original request tuple from its checkpoint, including its exact
non-secret arguments. Never place credentials in it. Workspace/project binding
is customer supplied; this helper does not authenticate it against hosted grants
or confirm that an external ID exists in CRM contacts. Its local config check
prevents an explicit site/project mismatch, not a forged customer mapping.

`observation` is `unknown`, `present`, `provisional_loss` or `confirmed_loss`;
`reply` is `unknown`, `none` or `replied`; `suppression` is `unknown`, `clear` or
`suppressed`. These are retained observations, not refreshed sender decisions.
Drafts always have `send_eligible: false`, including apparently clear rows.
Follow the qualified campaign recipe's content review before saving a real draft.

The original operation and local/external identities determine one stable draft
directory. The helper verifies the supplied UTF-8 body hash, publishes `body.txt`
and `manifest.json`, then rereads their exact bytes. An identical retry reports
`identical_readback`. If interrupted between files, repeat the original save;
it completes the missing artifact without replacing the existing body. A changed
subject, body, request or mapping at that identity refuses rather than overwrites.
Inspect and preserve the conflicting original artifact; a legitimate new operation
requires a separately recorded identity, not a fabricated replay key.

`--readback` verifies both artifacts and refuses missing or partial saves. It does
not create a draft directory. Keep the receipt's operation, destination directory,
body and manifest hashes with the customer's checkpoint. Saving here is actual
local filesystem destination readback, not a mailbox/vendor acknowledgement.

Publication reuses the portable helper's cooperating-writer locking and ExFAT
fallback. Destination symlinks are refused. This does not sandbox arbitrary local
applications or prove power-loss durability. No email system or network dependency
is installed. Current sender reply/suppression/quota/mailbox gates must still be
checked by the customer's existing sender at its separately authorized send step.
