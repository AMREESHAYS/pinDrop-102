#!/usr/bin/env sh
# Build a drag-and-drop deploy bundle for Netlify.
# Manual deploys skip `npm install`, so the function is bundled with its deps.
set -e
cd "$(dirname "$0")"
npm run build
rm -rf .deploy ../pinDrop-102.zip
mkdir -p .deploy/netlify/functions
cp -r dist/. .deploy/
for fn in vault r2; do
  npx esbuild "netlify/functions/$fn.mjs" \
    --bundle --platform=node --format=esm --target=node20 \
    --outfile=".deploy/netlify/functions/$fn.mjs" --log-level=warning
done
cat > .deploy/netlify.toml <<'TOML'
# Manual (drag-and-drop) deploy — no build runs here.
[functions]
  directory = "netlify/functions"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
TOML
cp ../work/R2-SETUP.md .deploy/ 2>/dev/null || cp R2-SETUP.md .deploy/
cd .deploy && zip -rq ../../pinDrop-102.zip .
echo "wrote $(cd ../.. && pwd)/pinDrop-102.zip"
