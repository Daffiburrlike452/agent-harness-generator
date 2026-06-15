# Browser-runtime WASM smoke

Static fixture that loads `@metaharness/kernel`'s WASM bundle in a real browser and asserts the three exports work (`kernelInfo`, `mcpValidate` accept, `mcpValidate` reject).

## Why this exists

The kernel claims to work in browser / Cloudflare Workers / Deno / Bun. We test Node via vitest; this fixture lets a human or Playwright runner test the browser path.

## Run

After building the WASM bundle:

```bash
cd packages/kernel-js
npm run build:wasm     # writes packages/kernel-js/pkg/
cd ../../
npx http-server -p 8080 packages/kernel-js -c-1
# open http://localhost:8080/__tests__/browser-smoke/fixture.html
```

The page shows PASS / FAIL inline + sets `window.__SMOKE_RESULT` for Playwright to read.

## Playwright wiring (queued for iter 16)

```js
// future: __tests__/browser-smoke/playwright.spec.ts
import { test, expect } from '@playwright/test';

test('kernel WASM loads in chromium', async ({ page }) => {
  await page.goto('http://localhost:8080/__tests__/browser-smoke/fixture.html');
  await page.waitForFunction(() => window.__SMOKE_RESULT !== undefined, { timeout: 10_000 });
  const result = await page.evaluate(() => window.__SMOKE_RESULT);
  expect(result.ok).toBe(true);
});
```

Iter 16 wires this up so CI fails on browser regression. For now, the fixture is human-runnable.
