/**
 * Playwright config for the headless + visual-baseline harness.
 *
 * Spins up the Vite dev server (so `.svdat` fixtures are served at `/fixtures/`
 * and the guarded `window.__traceViewer` test API is present) and drives Chromium
 * headlessly. Tests live in `test/e2e/` and use `.spec.ts` so they never
 * collide with the `tsx --test` unit glob (`test/*.test.ts`).
 *
 * Determinism:
 * - `deviceScaleFactor: 1` so the canvas backing store is 1:1 with CSS pixels;
 *   `toHaveScreenshot({ scale: "css" })` captures at CSS resolution regardless
 *   of host DPI.
 * - A single, platform-agnostic baseline per screenshot
 *   (`snapshotPathTemplate` drops the OS/project suffix). Baselines are the
 *   Linux ones generated in the pinned Playwright image — generate/update them
 *   with `npm run test:e2e:docker:update`, never on a macOS host (visual specs
 *   skip off-Linux to keep the canonical baselines clean).
 * - Tight `maxDiffPixelRatio`/`threshold`: AA noise is absorbed, real
 *   regressions still fail.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  // One canonical (Linux/Docker) baseline per screenshot, no OS/project suffix.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  // Cap parallelism in CI: the runner reports dozens of cores, so the default
  // (one worker per core) spins up dozens of Chromium instances that, together
  // with the Vite dev server and the multi-MB .svdat fixtures each test loads,
  // exhaust the container's memory and the OOM-killer takes out the web server
  // ("[WebServer] Killed"). A handful of workers keeps the suite fast without
  // the memory blow-up. Local runs keep Playwright's core-based default.
  workers: process.env["CI"] ? 4 : undefined,
  reporter: process.env["CI"] ? [["line"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:5180",
    deviceScaleFactor: 1,
    trace: "on-first-retry",
  },
  expect: {
    toHaveScreenshot: {
      scale: "css",
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: "npx vite --port 5180 --strictPort",
    url: "http://localhost:5180/",
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
