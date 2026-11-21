#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${ORBIT_TEST_TOOLS:-/tmp/orbit-test-tools}"
if ! node -e "if(require('$TOOLS/node_modules/@playwright/test/package.json').version !== '1.65.1' || require('$TOOLS/node_modules/@axe-core/playwright/package.json').version !== '4.14.0' || !require('node:fs').existsSync(require('$TOOLS/node_modules/playwright').chromium.executablePath())) process.exit(1)" > /dev/null 2>&1; then
  npm install --prefix "$TOOLS" @playwright/test@1.65.1 @axe-core/playwright@4.14.0
  "$TOOLS/node_modules/.bin/playwright" install --with-deps chromium
fi
export NODE_PATH="$TOOLS/node_modules"
cd "$ROOT"
python3 scripts/vendor-ui-sdk.py
mkdir -p artifacts
node --check app/app.js
node --test tests/static.test.cjs
"$TOOLS/node_modules/.bin/playwright" test --config tests/playwright.config.cjs
