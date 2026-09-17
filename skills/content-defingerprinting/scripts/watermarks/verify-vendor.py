#!/usr/bin/env python3
"""Prove this installed copy of the engine is the pinned upstream one.

A vendored dependency nobody checks is a dependency that has quietly drifted.
Exit 0 = matches UPSTREAM.json, 1 = drifted or missing.
"""
import hashlib, io, json, os, sys

here = os.path.dirname(os.path.abspath(__file__))
manifest = json.load(io.open(os.path.join(here, "UPSTREAM.json"), encoding="utf-8"))
bad = []
for name, expected in manifest["sha256"].items():
    path = os.path.join(here, "vendor", name)
    if not os.path.exists(path):
        bad.append((name, "MISSING"))
        continue
    actual = hashlib.sha256(io.open(path, "rb").read()).hexdigest()
    if actual != expected:
        bad.append((name, "MODIFIED"))
if bad:
    print("wm-verify: vendored engine has DRIFTED from %s" % manifest["pinned_commit"][:12])
    for name, why in bad:
        print("  %-24s %s" % (name, why))
    print("\nRestore with ./revendor.sh, and never edit vendor/ in place.")
    sys.exit(1)
print("wm-verify: %d files match upstream %s (%s)"
      % (len(manifest["sha256"]), manifest["pinned_commit"][:12], manifest["pinned_commit_date"][:10]))
