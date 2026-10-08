#!/usr/bin/env bash
# Convert sample.drawio and render every page to PNG via LibreOffice for visual checks.
set -e
cd "$(dirname "$0")"
rm -rf out && mkdir -p out
npx tsx src/cli.ts "${1:-sample.drawio}" -o out/P32-diagramy.vsdx
cd out
timeout 120 soffice --headless --convert-to pdf P32-diagramy.vsdx >/dev/null 2>&1
pdftoppm -r 80 -png P32-diagramy.pdf pg
ls
