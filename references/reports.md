# Branded HTML placement reports

Reports are generated entirely from the local CRM. They make no network
requests, run no additional checks, and do not imply broader backlink-index
coverage. The output is standalone HTML with embedded styles and print
styling; it is not a generated PDF.

```sh
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite report --project project-id --brand "My Agency" --title "Placement monitoring report" --output placements.html
```

Omit `--project` only when the requested report covers every local placement.
By default, a report includes source/destination URLs, cloud-observed state,
observation timestamp, report timestamp and aggregate placement counts.
It excludes local notes, local costs, contacts, outreach activity, credentials,
disavow rules, workspace IDs and raw event payloads. URLs are the selected
records' actual URLs; review the selection before sharing the file.

`--include-notes` and `--include-costs` explicitly add those private local
fields. Use these only when the user requests that content. Included cost
totals are calculated separately per currency without exchange rates.
Local CRM status is not substituted for a verified cloud observation.

Record a cost with an ordinary partial placement upsert:

```json
{"id":"placement-id","cost_amount":"12.50","cost_currency":"USD"}
```

Amounts are nonnegative decimal strings with at most six decimal places,
not JSON floating-point numbers. Both amount and currency are required for
a newly recorded cost. The currency is an uppercase three-letter label;
the helper does not perform a current currency-directory lookup. Updating
other fields or synchronizing cloud events preserves local costs. Set both
cost fields to null to clear a cost explicitly.

The generator escapes all text/attributes and creates clickable links only
for HTTP(S) URLs without credentials. It loads no external scripts, fonts,
logos or tracking pixels. The title and brand are user-selected text labels.
Local notes remain escaped text, even if they contain HTML.

Rows have a stable ordering. Supply a fixed `--generated-at` ISO 8601
timestamp to reproduce identical output from the same data and options:

```sh
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite report --title "Placement report" --generated-at 2026-09-09T14:00:00Z --output reproducible.html
```

Otherwise the timestamp is the current time. Coverage reports the range of
stored observation times separately from report generation. Unknown and
unobserved states remain distinct from confirmed loss. Existing output files
are never overwritten. Browser printing, PDF generation and automated report
delivery are separate capabilities and are not performed by this helper.
