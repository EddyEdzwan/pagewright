#!/bin/sh
# Rebuild web-dist and copy it to the preview server's folder (dev helper).
set -e
cd "$(dirname "$0")/.."
node scripts/build-web.mjs
rm -rf "$1/web-dist" && cp -R web-dist "$1/web-dist"
