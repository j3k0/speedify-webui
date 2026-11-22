#!/bin/sh
# Rebuild static/css/tailwind.css from the classes used in templates/ and
# static/js/. Run on a workstation with Node (the Pi doesn't need it) and
# commit the result. Pinned to Tailwind v3 (same engine as the old Play CDN).
set -e
cd "$(dirname "$0")/.."
npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i tailwind/input.css -o static/css/tailwind.css --minify
