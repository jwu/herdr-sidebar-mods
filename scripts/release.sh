#!/bin/sh
# Cuts a release: scripts/release.sh <x.y.z> [--push]
#
# 1. Checks: on main, clean tree, not behind origin/main, tag is new, version is
#    newer than the mods' VERSION, CHANGELOG.md has entries under ## Unreleased.
# 2. Sets VERSION in both update.js files and turns ## Unreleased into
#    ## <x.y.z> - <date>.
# 3. Runs the tests and `herdr-app check` on each mod (when herdr-app exists).
# 4. Commits "Release v<x.y.z>" and makes the annotated tag v<x.y.z>.
# 5. With --push: pushes main and the tag together; the Release workflow then
#    publishes the GitHub release with the changelog notes and a tarball.
# Anything failing before the commit puts the files back as they were.
set -eu
cd "$(dirname "$0")/.."

die() { echo "release: $*" >&2; exit 1; }

v=${1:-}
push=${2:-}
echo "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "usage: scripts/release.sh <x.y.z> [--push]"
[ -z "$push" ] || [ "$push" = --push ] || die "unknown option: $push"

[ "$(git branch --show-current)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "the working tree has changes; commit them first"
git fetch -q --tags origin main
git merge-base --is-ancestor origin/main HEAD || die "main is behind origin/main; pull first"
! git rev-parse -q --verify "refs/tags/v$v" >/dev/null || die "tag v$v already exists"

FILES="mods/sidebar-spaces/update.js mods/sidebar-agents/update.js"
cur=$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' mods/sidebar-spaces/update.js)
[ -n "$cur" ] || die "no VERSION in mods/sidebar-spaces/update.js"
node -e '
  const p = v => v.split(".").map(Number), [a, b] = [p(process.argv[1]), p(process.argv[2])];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1);
  process.exit(1);' "$v" "$cur" || die "$v is not newer than the current $cur"
node scripts/changelog.mjs unreleased >/dev/null || die "write the release's entries under ## Unreleased in CHANGELOG.md first"

restore() { git checkout -q -- CHANGELOG.md $FILES; }
trap 'restore; echo "release: failed; files restored" >&2' EXIT

for f in $FILES; do
  node -e '
    const fs = require("fs"), [f, v] = process.argv.slice(1);
    const s = fs.readFileSync(f, "utf8"), t = s.replace(/^export const VERSION = ".*";$/m, `export const VERSION = "${v}";`);
    if (s === t && !s.includes(`VERSION = "${v}"`)) process.exit(1);
    fs.writeFileSync(f, t);' "$f" "$v" || die "could not set VERSION in $f"
done
node scripts/changelog.mjs cut "$v"

log=$(mktemp)
node --test tests/*.test.mjs >"$log" 2>&1 || { tail -40 "$log" >&2; die "tests failed"; }
rm -f "$log"
if command -v herdr-app >/dev/null 2>&1; then
  for m in mods/*/; do herdr-app check "${m%/}" >/dev/null || die "herdr-app check failed: $m"; done
else
  echo "release: herdr-app not found; skipped herdr-app check" >&2
fi

git add CHANGELOG.md $FILES
git commit -q -m "Release v$v"
git tag -a "v$v" -m "v$v"
trap - EXIT

echo "Release v$v committed and tagged."
echo "--- notes ---"
node scripts/changelog.mjs notes "$v"
echo "-------------"
if [ "$push" = --push ]; then
  git push --atomic origin main "v$v"
  echo "Pushed. Watch the Release workflow: gh run watch \$(gh run list --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')"
else
  echo "Not pushed. Publish with: git push --atomic origin main v$v"
  echo "Undo with: git tag -d v$v && git reset --hard HEAD~1"
fi
