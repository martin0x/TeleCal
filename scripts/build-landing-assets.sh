#!/usr/bin/env bash
# Rebuilds the landing page's images in src/web/public/. macOS only (sips, Chrome).
# Run from the repo root:  bash scripts/build-landing-assets.sh
#
# Raw phone screenshots go in scripts/screenshots/ (gitignored), named
# shot-log, shot-today and shot-charts with any image extension. Missing ones are skipped.
# scripts/telegram-mock/render.ts writes all three as mock Telegram screens.
set -euo pipefail

OUT=src/web/public
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME" ]; then
  echo "error: Google Chrome not found at $CHROME" >&2
  exit 1
fi

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --screenshot="$OUT/og.png" "file://$PWD/scripts/og.html" 2>/dev/null
echo "wrote $OUT/og.png"

for name in shot-log shot-today shot-charts; do
  src=$(ls scripts/screenshots/"$name".* 2>/dev/null | head -1 || true)
  if [ -z "$src" ]; then
    echo "skip $name (no scripts/screenshots/$name.*)"
    continue
  fi
  sips -s format jpeg -s formatOptions 85 --resampleWidth 720 "$src" --out "$OUT/$name.jpg" >/dev/null
  echo "wrote $OUT/$name.jpg"
done
