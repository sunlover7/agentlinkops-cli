---
name: content-defingerprinting
description: Run the required invisible-character and text-artifact cleanup after humanizing public content, using this package's watermark scanner. Preserve citations, source evidence and meaningful text.
---

# Content defingerprinting

This is stage 2b of the content workflow: deterministic text cleanup after the separate
editorial humanize pass. Read this skill's `scripts/watermarks/README.md` for
scanner behavior and the distinction between authored prose and archived evidence.

Run against the final authored files, including titles, descriptions, email/social
copy and page text embedded in templates:

```bash
python3 scripts/watermarks/wm-scan.py <authored-file>   # relative to this skill's directory
```

Inspect findings before changing them. For removable artifacts in authored prose,
use `--fix` and rerun the scanner until it passes. Preserve the scanner's protections
for archived evidence, sourced quotations, meaningful Unicode and load-bearing code
literals; resolve those findings individually. Do not rewrite sources to clear a check.

For content composed directly in a browser, first save the final authored text to a
local UTF-8 draft, scan that file, and paste the checked version. Repeat if text changes.
This step does not replace the humanizer or alter source/provenance records.

Then use `internal-linking-optimizer`. Record the scanned paths and outcome with the
content's normal review notes. Do not call an unrun scan passed.
