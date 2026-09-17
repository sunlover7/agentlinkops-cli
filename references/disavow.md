# User-managed disavow lists

This is an offline record/file tool. It does not evaluate whether a link
should be disavowed, connect to Search Console, or upload a file. Record the
user's explicit choices and their provenance.

Google's documented file format uses one page URL or `domain:hostname` per
line, UTF-8 or ASCII `.txt` files, and `#` comment lines. The limits are 2,048
characters per URL, 100,000 lines including comments/blanks, and 2 MB. Domain
and subdomain rules are supported; a path prefix is not a domain-wide rule.
The tool does not support Search Console Domain properties. Uploading a new
list replaces the list for the selected property; local merging here does
not establish what Google currently holds. Google says most sites do not
need disavowals. [Official format and usage guidance](https://support.google.com/webmasters/answer/2648487?hl=en),
checked September 9, 2026.

## Commands

Run from the installed plugin root and keep the database outside its cache:

```sh
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite migrate
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite disavow import --property https://my-product.com/ --source "User-reviewed existing list" --file existing-list.txt
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite disavow list --property https://my-product.com/
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite disavow export --property https://my-product.com/ --output reviewed-disavow.txt
```

Every command requires the exact URL-prefix property. HTTP and HTTPS remain
separate; a subdomain or path prefix remains separate from its parent. The
helper records this local scope; it does not verify property ownership.

Imports merge rules transactionally. Any invalid line rejects the entire
file with no new rules or source record. Duplicates reuse stable rule IDs.
Each source retains its label, original text and SHA-256; provenance records
the original line, line number and associated comments. Reimporting identical
content under the same source label is idempotent. A new source label adds
provenance without duplicating the rule. Imports never overwrite local notes
or reactivate a rule the user disabled.

To add or explicitly change a rule, prepare `rule.json` and run:

```sh
python3 scripts/agentlinkops.py --db ./agentlinkops.sqlite disavow upsert --property https://my-product.com/ --source "User decision after review" --file rule.json
```

```json
{"kind":"domain","value":"publisher.example","active":false,"notes":"User removed this rule after reviewing the source."}
```

`kind` is `domain` or `url`. `active` defaults to the existing value, or true
for a new rule. Omitted notes are preserved. Deactivation is reversible and
retains provenance; there is no destructive delete command.

Domain normalization changes case and a terminal DNS dot only. Hostnames
must be ASCII or already Punycode; the helper does not guess IDN conversion.
URLs preserve path case, query strings and fragments. A path ending in `/`
is still one exact page URL; wildcard patterns are rejected. URL credentials
and malformed domains are rejected. UTF-8 paths, LF/CRLF and an optional UTF-8
BOM are accepted. Original source text remains available in the full JSON
CRM export.

`.txt` exports contain active rules for one property, sorted by rule kind and
value with stable header comments. They omit timestamps and private notes,
so unchanged rules produce identical bytes. The export is checked against
the documented line limit and a conservative 2,000,000-byte ceiling, and never
overwrites an existing file. The same byte ceiling applies to imports.
Without `--output`, it writes the same text to stdout. The local list can be
empty; an empty export is not evidence that a Google-side list was cleared.

`disavow list --active-only` filters the view. The general `export` command
includes all disavow rules, sources and provenance in the local JSON backup.
No monitoring result, authority metric or contact inspection automatically
creates a rule.
