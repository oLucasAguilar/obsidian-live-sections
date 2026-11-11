#!/usr/bin/env bash
# Publishes the GitHub release that BRAT and Obsidian install from:
# tag = manifest version, assets = main.js, manifest.json and styles.css from the pushed commit.
#
#   dev/release.sh           simulate (default): run every check, print what would be published
#   dev/release.sh --apply   publish
#   dev/release.sh check     warn when the code changed since the last release but the version did not
#
# Its only write is `gh release create`. It never commits, pushes a branch, moves or deletes
# a tag, or edits an existing release.
set -euo pipefail
cd "$(dirname "$0")/.."

mode=${1:-dry}
case "$mode" in dry | --apply | check) ;; *) echo "usage: dev/release.sh [--apply | check]"; exit 2 ;; esac

version=$(node -p "require('./manifest.json').version")
assets=(main.js manifest.json)
[ -f styles.css ] && assets+=(styles.css)
last=$(git tag --list --sort=-v:refname | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
changed_since_last() { [ -z "$last" ] || ! git diff --quiet "$last" HEAD -- "${assets[@]}"; }

if [ "$mode" = check ]; then
  if [ -n "$last" ] && [ "$version" = "$last" ] && changed_since_last; then
    echo "⚠️  $(basename "$PWD"): ${assets[*]} changed since release $last, but manifest.json is still $version."
    echo "   BRAT users stay on $last. Bump the version, push, then run dev/release.sh"
  fi
  exit 0
fi

fail() { echo "✗ $*"; exit 1; }

git fetch -q --tags origin
branch=$(git branch --show-current)
[ "$branch" = main ] || fail "not on main (on '$branch')"
[ -z "$(git status --porcelain)" ] || fail "uncommitted changes"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "HEAD is not origin/main: push or pull first"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "manifest version '$version' is not x.y.z"
! git rev-parse -q --verify "refs/tags/$version" >/dev/null || fail "tag $version already exists: bump the version in manifest.json"
! gh release view "$version" >/dev/null 2>&1 || fail "release $version already exists"
if [ -n "$last" ]; then
  [ "$(printf '%s\n%s\n' "$last" "$version" | sort -V | tail -1)" = "$version" ] || fail "version $version is lower than the last release $last"
  changed_since_last || fail "nothing changed in ${assets[*]} since $last"
fi
if [ -f versions.json ]; then
  node -e "process.exit(require('./versions.json')['$version'] ? 0 : 1)" || fail "versions.json has no entry for $version"
fi

sha=$(git rev-parse HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for f in "${assets[@]}"; do git show "$sha:$f" > "$tmp/$f"; done
if [ -n "$last" ]; then notes=$(git log --format='- %s' "$last..$sha"); else notes="First release."; fi

echo "repo     $(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "release  $version  (last: ${last:-none})"
echo "commit   $sha"
echo "assets   ${assets[*]}"
echo "notes"
printf '%s\n' "$notes" | sed 's/^/  /'

if [ "$mode" != --apply ]; then
  echo "(simulation: nothing published. To publish: dev/release.sh --apply)"
  exit 0
fi
files=()
for f in "${assets[@]}"; do files+=("$tmp/$f"); done
gh release create "$version" --target "$sha" --title "$version" --notes "$notes" "${files[@]}"
git fetch -q --tags origin
