# Branded HTML placement reports

Reports are generated entirely from the local CRM. They make no network
requests, run no additional checks, and do not imply broader backlink-index
coverage. The output is standalone HTML with embedded styles and print
styling; it is not a generated PDF.

```sh
python3 references/portable/scripts/agentlinkops.py --db ./agentlinkops.sqlite report --project project-id --brand "My Agency" --title "Placement monitoring report" --output placements.html
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
python3 references/portable/scripts/agentlinkops.py --db ./agentlinkops.sqlite report --title "Placement report" --generated-at 2026-09-09T14:00:00Z --output reproducible.html
```

Otherwise the timestamp is the current time. Coverage reports the range of
stored observation times separately from report generation. Unknown and
unobserved states remain distinct from confirmed loss. Existing output files
are never overwritten. Browser printing, PDF generation and automated report
delivery are separate capabilities and are not performed by this helper.

## Hosted one-page client report

When the user wants the product's own numbers for a client, call
`get_client_link_report` instead of building them from local rows. It covers
one website: links live now, plus links new, back, lost, went missing,
changed and won in a calendar month or the last 1 to 90 days. It counts with
the same rules as `get_link_summary` and the Changes page, so its numbers
match the console. Pass `month` (`YYYY-MM`) or `days`, not both, and
`branding` (`agentlinkops`, `agency` with a `name`, or `none`).

- Give each count with the period's exact `from` and `to`. Live is the state
  when the report was read, even for a past month.
- Won counts saved prospects that a check found live in the period. An
  outreach status set by hand, a reply or a promise is never a win.
- Live now excludes archived and candidate-only records. Period changes and Won use retained events, so their counts can include records outside the current link list.
- `counts.paused` includes retired prospects. Keep that distinction when describing the current record total.
- `counts.prospects` are saved prospects. They're inside `counts.links` but
  aren't monitored links yet, so don't report them as missing or never live.
- Each section lists up to `limit` items (default 50, at most 200). When
  `truncated` is true, say the list is partial. Links exports use their own
  record selection; they do not export this report's period events.
- `coverage.changes_complete: false` means older changes in the period may be
  missing.
- In the console, open Reports > Client report and choose Save as PDF to open the
  browser print dialog. Check the preview for the selected report, check dates and evidence references. Share links aren't available yet.

For an agency review across client websites, call `get_client_results_report`
with up to 10 `projectIds`. Each website stays its own population; never add
their numbers together. Per website it returns earned (found by a check in the
period, the same as New), retained, recovered, lost, went missing, changed,
never live and won,
plus review groups (lost, back, changed, can't reach for more than a week)
with the observation behind each link.

- `earned_by_origin` says how each earned link entered monitoring: imported,
  added from Find backlinks, a prospect that went live, or added directly or
  not recorded. Origin is not who earned the link. An imported link is not
  proof that recorded outreach earned it.
- An earned link's `outreach` is its saved pipeline record (status, last
  contact date, campaign). Report it as recorded. Only `verified_win_at`, the
  check that found a saved prospect live, makes it a win.
- `comparison.state: no_comparable_cohort_yet` means there is no competitor or
  pooled comparison. Don't build one from these numbers.
- Review groups are links to look at with their evidence. They don't diagnose
  negative SEO, call for a disavow or explain ranking changes.
