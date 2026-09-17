#!/usr/bin/env bash
# Re-vendor the watermarks-remover Layer A engine from upstream.
#
#   ./revendor.sh [ref]        # default: main
#
# The vendored files are byte-identical to upstream and MUST stay that way. If a
# behaviour needs changing, change it in wm-scan.py (ours) or send a PR upstream.
# Editing vendor/ in place produces a house rule nobody agreed to, in a file that
# looks like somebody else's source of truth. That has happened here before with a
# banned-phrase list.
set -euo pipefail

REF="${1:-main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="https://github.com/guillaumemeyer/watermarks-remover"
FILES=(common.py text_unicode.py inspect_text.py clean_text.py score_stylometry.py)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Fetching $REPO @ $REF ..."
git clone --quiet --depth 1 --branch "$REF" "$REPO" "$TMP/src" 2>/dev/null \
  || git clone --quiet "$REPO" "$TMP/src"
git -C "$TMP/src" checkout --quiet "$REF" 2>/dev/null || true

for f in "${FILES[@]}"; do
  cp "$TMP/src/service/scripts/$f" "$HERE/vendor/$f"
done
cp "$TMP/src/LICENSE" "$HERE/vendor/LICENSE.upstream"

SHA="$(git -C "$TMP/src" rev-parse HEAD)"
DATE="$(git -C "$TMP/src" log -1 --format=%cI)"
TODAY="$(date +%Y-%m-%d)"

python3 - "$HERE" "$SHA" "$DATE" "$TODAY" <<'PY'
import hashlib, io, json, os, sys
here, sha, date, today = sys.argv[1:5]
m = json.load(io.open(os.path.join(here, 'UPSTREAM.json'), encoding='utf-8'))
files = {}
for f in sorted(os.listdir(os.path.join(here, 'vendor'))):
    if f.startswith('._'):            # AppleDouble shadows on the exFAT volumes
        continue
    files[f] = hashlib.sha256(io.open(os.path.join(here, 'vendor', f), 'rb').read()).hexdigest()
changed = [f for f, h in files.items() if m['sha256'].get(f) != h]
m.update(pinned_commit=sha, pinned_commit_date=date, vendored_on=today, sha256=files)
io.open(os.path.join(here, 'UPSTREAM.json'), 'w', encoding='utf-8').write(json.dumps(m, indent=2) + "\n")
print("pinned %s (%s)" % (sha[:12], date))
print("changed: %s" % (", ".join(changed) if changed else "nothing"))
PY

echo
echo "Now re-run the scan on a repo you know the answer for, before trusting it:"
echo "  python3 $HERE/wm-scan.py <a path with a known hit>"
