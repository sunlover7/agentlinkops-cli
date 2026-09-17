#!/usr/bin/env python3
"""Stage 2b of the content pipeline: invisible-Unicode / provenance-mark scan.

Wraps the vendored watermarks-remover Layer A engine (see UPSTREAM.json) and
reports every invisible or undisplayable character in the files you point it at,
with the line each one sits on.

    wm-scan.py <path> [<path> ...]        # report; exit 1 if anything is found
    wm-scan.py --fix <path> [...]         # clean in place, then re-verify
    wm-scan.py --json <path>              # machine-readable, for a gate
    wm-scan.py --quiet <path>             # exit code only

Exit codes:  0 = clean   1 = findings   2 = usage/read error

Why this is a required step and not a nicety: these characters are invisible in
every editor and every review, they survive copy-paste out of PDFs, Word and LLM
output, and they silently break the things that check our prose. A zero-width
space inside "affidavit" means the banned-phrase scan, the citation audits and
every grep in the repo stop seeing the word.

WHAT THIS DOES NOT DO, on purpose:
  - It does not strip C2PA manifests. C2PA on one of our own generated covers is
    a signal worth investigating, not noise worth deleting. Report it, ask why.
  - It does not run Layer B (rewriting text to defeat statistical watermarks).
    Our humanize stage already rewrites AI-pattern prose on quality grounds.
  - It does not touch image pixels. Our covers are our own generated assets.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
sys.path.insert(0, VENDOR)
try:
    import text_unicode as tu
except ImportError:  # pragma: no cover
    sys.stderr.write("wm-scan: vendored engine missing at %s\n" % VENDOR)
    sys.stderr.write("         re-run the kit install, or ./revendor.sh\n")
    sys.exit(2)

# Fast pre-filter. The engine is thorough and therefore per-character, which is far
# too slow across a 14,000-file data tree. This regex is a deliberate SUPERSET of what
# the engine flags: anything it misses cannot be suspicious, and its false positives
# just fall through to the engine, which makes the real call. Without it a full scan of
# one sibling repo did not finish in two minutes; with it, seconds.
SUSPECT = re.compile(
    "[\u00A0\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E"
    "\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\u3164\uFE00-\uFE0F"
    "\uFEFF\uFFA0\uFFF9-\uFFFB\uE000-\uF8FF]"
    "|[\U000E0000-\U000E007F]|[\U000F0000-\U0010FFFD]"
)

TEXT_EXT = (".mdx", ".md", ".tsx", ".ts", ".jsx", ".js", ".json", ".html", ".css", ".txt", ".yaml", ".yml")
SKIP_DIRS = {".git", "node_modules", ".next", "out", ".contentlayer", "cache", ".venv", "__pycache__", "vendor"}

# Paths holding ARCHIVED SOURCE EVIDENCE: scraped snapshots, extracted policy PDFs,
# price history. --fix refuses to touch these, and it is not a configurable nicety.
# The marks in there are PDF glyph artifacts in a document somebody else published,
# and that archive is what every `_source` and `verified_quote` on the site resolves
# against. Rewriting it to make a scan pass is the tampering the provenance chain
# exists to detect: one edited file and one re-forged hash is the whole failure story.
# Report them, leave them, and treat any quote LIFTED from them as the thing to check.
ARCHIVE_MARKERS = ("/sources/", "/snapshots/", "/evidence/", "/_sources/", "/price-history/", "/raw/")


# LOAD-BEARING LITERALS. An invisible character sitting inside a regex character class
# is not contamination, it is the sanitizer that REMOVES contamination, written with the
# literal characters it strips. Three of these exist across the estate:
#   .replace(/[<zwsp><zwnj><zwj><bom>]+/g, '')   covered-weight EHB extractor
#   .replace(/&nbsp;| |<zwsp>/g, " ")            proxy-compare proxyscrape
#   .replace(/<nbsp>/g, " ")                     proxy-compare rayobyte
# Auto-fixing them empties the character class and silently breaks the sanitizer, letting
# through exactly the marks it existed to catch. High-precision guard: refuse when the
# hit's own line carries regex-replacement syntax.
LOAD_BEARING = re.compile(r"\.replace\s*\(|new\s+RegExp\(|/\[[^\]]*\]|\\u[0-9A-Fa-f]{4}")


def is_load_bearing(text, index):
    start = text.rfind("\n", 0, index) + 1
    end = text.find("\n", index)
    line = text[start:] if end == -1 else text[start:end]
    return bool(LOAD_BEARING.search(line))


def is_archive(path):
    norm = "/" + path.replace(os.sep, "/").strip("/") + "/"
    return any(marker in norm for marker in ARCHIVE_MARKERS)


def walk(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
            continue
        for dirpath, dirnames, filenames in os.walk(p):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for f in sorted(filenames):
                # AppleDouble shadows: these volumes are exFAT and every file has one
                if f.startswith("._") or not f.endswith(TEXT_EXT):
                    continue
                yield os.path.join(dirpath, f)


def line_of(text, index):
    return text.count("\n", 0, index) + 1


def scan_file(path):
    try:
        text = io.open(path, encoding="utf-8").read()
    except (UnicodeDecodeError, OSError):
        return None
    if not SUSPECT.search(text):
        return None
    report = tu.inspect_text(text)
    if not report.suspicious_total:
        return None
    findings = []
    load_bearing = False
    for hit in report.hits:
        if any(is_load_bearing(text, i) for i in hit.samples):
            load_bearing = True
        findings.append({
            "codepoint": "U+%04X" % hit.codepoint,
            "label": hit.label,
            "kind": hit.kind,
            "count": hit.count,
            "lines": sorted({line_of(text, i) for i in hit.samples}),
        })
    return {"file": path, "total": report.suspicious_total,
            "archive": is_archive(path), "load_bearing": load_bearing,
            "findings": findings}


def main():
    ap = argparse.ArgumentParser(description="Scan content for invisible Unicode / provenance marks.")
    ap.add_argument("paths", nargs="+", help="Files or directories to scan")
    ap.add_argument("--fix", action="store_true", help="Clean in place, then re-verify")
    ap.add_argument("--json", action="store_true", help="Machine-readable output")
    ap.add_argument("--quiet", action="store_true", help="Exit code only")
    ap.add_argument("--keep-nbsp", action="store_true",
                    help="With --fix, leave no-break spaces alone (they are sometimes deliberate)")
    args = ap.parse_args()

    results, scanned = [], 0
    for path in walk(args.paths):
        scanned += 1
        found = scan_file(path)
        if found:
            results.append(found)

    if args.fix and results:
        refused = [r["file"] for r in results if r["archive"]]
        held = [r["file"] for r in results if r["load_bearing"] and not r["archive"]]
        for result in results:
            if result["archive"] or result["load_bearing"]:
                continue
            text = io.open(result["file"], encoding="utf-8").read()
            cleaned, _stats = tu.clean_text(text, normalize_spaces=not args.keep_nbsp)
            if cleaned != text:
                io.open(result["file"], "w", encoding="utf-8").write(cleaned)
                result["fixed"] = True
        results = [r for r in (scan_file(x["file"]) for x in results) if r]
        if refused and not args.json:
            sys.stderr.write(
                "\nwm-scan: REFUSED to fix %d archived source file(s).\n"
                "         That tree is the evidence every citation resolves against; the marks in it\n"
                "         belong to a document somebody else published. Check the QUOTES lifted from\n"
                "         it instead, and leave the archive byte-identical.\n" % len(refused))
            for f in refused[:10]:
                sys.stderr.write("           %s\n" % f)
        if held and not args.json:
            sys.stderr.write(
                "\nwm-scan: HELD BACK %d file(s) whose marks look LOAD-BEARING.\n"
                "         The character sits on a line with regex-replacement syntax, which usually\n"
                "         means it IS the sanitizer that strips these marks, written literally.\n"
                "         Emptying that character class breaks the guard. Review by hand.\n" % len(held))
            for f in held[:10]:
                sys.stderr.write("           %s\n" % f)

    if args.json:
        json.dump({"scanned": scanned, "dirty": len(results), "results": results}, sys.stdout, indent=2)
        sys.stdout.write("\n")
    elif not args.quiet:
        if not results:
            print("wm-scan: %d files scanned, clean." % scanned)
        else:
            print("wm-scan: %d files scanned, %d carry invisible characters.\n" % (scanned, len(results)))
            for result in results:
                tag = ""
                if result["archive"]:
                    tag = "   [ARCHIVE - report only, never fix]"
                elif result["load_bearing"]:
                    tag = "   [LOAD-BEARING? regex literal on that line - review by hand]"
                print("  %s%s" % (result["file"], tag))
                for f in result["findings"]:
                    lines = ",".join(str(n) for n in f["lines"][:6])
                    print("      %-46s x%-3d [%s] line %s" % (f["label"], f["count"], f["kind"], lines))
            print("\nFix with:  wm-scan.py --fix <path>")
            print("Then read the diff. A character inside a sourced quote is a provenance")
            print("question before it is a formatting one: check it against the document.")

    return 1 if results else 0


if __name__ == "__main__":
    sys.exit(main())
