/**
 * End-to-end tests for the welcome modal.
 *
 * Asserts empty-state presentation, dismissal via close button, Escape key,
 * and backdrop click, demo trace selection and loading, startup persistence
 * preferences, and visual baseline appearance across light and dark themes.
 */

import { expect, test } from "@playwright/test";
import { getState, gotoApp, settle, VISUAL_ENABLED } from "./helpers.js";

test("appears on an empty boot with both route tiles", async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByTestId("welcome-modal")).toBeVisible();
  for (const id of ["welcome-demo", "welcome-open"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.locator(".welcome-tile")).toHaveCount(2);
});

test("dismisses via the close button, Escape, and the backdrop", async ({ page }) => {
  const modal = page.getByTestId("welcome-modal");

  await gotoApp(page);
  await expect(modal).toBeVisible();
  await page.getByTestId("welcome-close").click();
  await expect(modal).toBeHidden();

  // Re-open from the toolbar, then dismiss with Escape.
  await page.getByTestId("tb-welcome").click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // Re-open and dismiss by clicking the backdrop overlay corner.
  await page.getByTestId("tb-welcome").click();
  await expect(modal).toBeVisible();
  await modal.click({ position: { x: 4, y: 4 } });
  await expect(modal).toBeHidden();
});

test("the demo tile opens an in-modal picker of the bundled samples", async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByTestId("welcome-modal")).toBeVisible();

  await page.getByTestId("welcome-demo").click();
  // The route grid transitions to the demo picker listing curated demo traces.
  await expect(page.getByTestId("welcome-view-main")).toBeHidden();
  await expect(page.getByTestId("welcome-view-demos")).toBeVisible();
  await expect(page.getByTestId("welcome-demo-unicore")).toContainText("Single core demo");
  await expect(page.getByTestId("welcome-demo-dualcore")).toContainText("Dual core demo");
  await expect(page.getByTestId("welcome-demo-zephyr")).toContainText("Zephyr demo");

  // Back returns to the route grid without leaving the modal.
  await page.getByTestId("welcome-demo-back").click();
  await expect(page.getByTestId("welcome-view-demos")).toBeHidden();
  await expect(page.getByTestId("welcome-view-main")).toBeVisible();
});

test("choosing a demo loads its bundled trace and ELF and closes the modal", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("welcome-demo").click();
  await page.getByTestId("welcome-demo-dualcore").click();

  // The demo loads and closes the modal.
  await expect(page.getByTestId("welcome-modal")).toBeHidden();
  await expect.poll(async () => (await getState(page)).eventCount).toBeGreaterThan(0);
  const state = await getState(page);
  expect(state.loadError).toBeNull();
  expect(state.sourceNames).toContain("dualcore.svdat");

  // The demo ELF file auto-loads; it would have been refused had it not matched the capture.
  await expect.poll(async () => (await getState(page)).elf?.name).toBe("dualcore.elf");
});

test("a demo load shows the blocking loading overlay until it finishes", async ({ page }) => {
  await gotoApp(page);
  // Intercept the trace fetch to assert overlay visibility during download.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/*.svdat*", async (route) => {
    await gate;
    await route.continue();
  });

  await page.getByTestId("welcome-demo").click();
  await page.getByTestId("welcome-demo-unicore").click();
  const overlay = page.getByTestId("loading-overlay");
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("loading-label")).toHaveText("Downloading demo trace…");

  // Complete trace fetch and verify overlay dismissal after load finishes.
  release();
  await expect(overlay).toBeHidden();
  await expect.poll(async () => (await getState(page)).eventCount).toBeGreaterThan(0);
  expect((await getState(page)).loadError).toBeNull();
});

test("reopening the modal after the picker returns to the route grid", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("welcome-demo").click();
  await expect(page.getByTestId("welcome-view-demos")).toBeVisible();

  // Dismissing from the demo picker and reopening resets to the initial route grid.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("welcome-modal")).toBeHidden();
  await page.getByTestId("tb-welcome").click();
  await expect(page.getByTestId("welcome-view-main")).toBeVisible();
  await expect(page.getByTestId("welcome-view-demos")).toBeHidden();
});

test("does not appear when a trace is already loaded via ?fixture=", async ({ page }) => {
  await gotoApp(page, "/?fixture=dualcore");
  await expect(page.getByTestId("sb-events")).toHaveText("164 703 events");
  await expect(page.getByTestId("welcome-modal")).toBeHidden();
  // Still re-openable from the toolbar over a loaded trace.
  await page.getByTestId("tb-welcome").click();
  await expect(page.getByTestId("welcome-modal")).toBeVisible();
});

test("'don't show on startup' persists and suppresses the modal on reload", async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByTestId("welcome-modal")).toBeVisible();

  await page.getByTestId("welcome-hide").check();
  const stored = await page.evaluate(() =>
    localStorage.getItem("trace-viewer.welcome.hideOnStartup.v1"),
  );
  expect(stored).toBe("1");

  // Subsequent reload suppresses the modal; toolbar button reopens it.
  await gotoApp(page);
  await expect(page.getByTestId("welcome-modal")).toBeHidden();
  await page.getByTestId("tb-welcome").click();
  await expect(page.getByTestId("welcome-modal")).toBeVisible();
  // The checkbox reflects the persisted preference.
  await expect(page.getByTestId("welcome-hide")).toBeChecked();
});

// Visual baselines for light and dark color schemes (Linux/Docker only).
for (const theme of ["light", "dark"] as const) {
  test(`visual baseline: welcome modal on empty boot (${theme})`, async ({ page }) => {
    test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
    await page.emulateMedia({ colorScheme: theme });
    await gotoApp(page);
    await expect(page.getByTestId("welcome-modal")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`welcome-modal-${theme}.png`, { maxDiffPixelRatio: 0.02 });
  });

  test(`visual baseline: demo-trace picker (${theme})`, async ({ page }) => {
    test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
    await page.emulateMedia({ colorScheme: theme });
    await gotoApp(page);
    await page.getByTestId("welcome-demo").click();
    await expect(page.getByTestId("welcome-view-demos")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`welcome-demo-picker-${theme}.png`, { maxDiffPixelRatio: 0.02 });
  });
}
