#!/bin/sh
# Build the iPhone/web version and publish it to GitHub Pages (the gh-pages branch of origin).
# gh-pages holds only the latest build, so it is replaced on every deploy.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REMOTE="$(git remote get-url origin)"
NAME="$(git config user.name)"
EMAIL="$(git config user.email)"

node scripts/gen-licenses.mjs
node scripts/build-web.mjs
touch web-dist/.nojekyll # otherwise GitHub's Jekyll step drops node_modules/

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R web-dist/. "$TMP"
cd "$TMP"
git init -q -b gh-pages
git -c user.name="$NAME" -c user.email="$EMAIL" add -A
git -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "Deploy Pagewright web app ($(date '+%Y-%m-%d %H:%M'))"
git push -q -f "$REMOTE" gh-pages
echo "Deployed. GitHub Pages usually updates within a minute."
