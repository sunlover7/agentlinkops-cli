# Synthetic discovery fixtures

All URLs, task IDs, dates, costs, counts and link attributes here are invented test
data. Reserved `example.com`, `example.org` and `example.net` names are used without
fetching them. These files are neither supplier captures nor coverage/pricing
evidence. No account, paid query or sandbox request was used to create them.

`cases.json` wraps a request query, a raw supplier-shaped response and expected
normalization outcomes. The wrapper is local test metadata, not a supplier field.
Success, partial invalid rows, successful empty results and a task failure inside
HTTP 200 are required contract cases. The adapter tests also mutate these fixtures
to exercise transport, duplicate, pagination and malformed-envelope failures.

Response field names were checked against the official
[Backlinks endpoint](https://docs.dataforseo.com/v3/backlinks/backlinks/live/) on
2026-09-10. The executable contract and interpretation are owned by
[DP-0002](../../../docs/initiatives/DP-0002-bounded-backlink-discovery/discovery-contract.md).
