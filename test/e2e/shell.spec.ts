/**
 * End-to-end tests for the application shell.
 *
 * Asserts mounting of the two toolbars, status bar, and the surfaces of the
 * Timeline workspace, file loading and saving workflows, multi-core fixture
 * parsing, zoom selector controls, and visual baseline appearance.
 */

import { expect, test } from "@playwright/test";
import { gotoEmptyApp, settle, VISUAL_ENABLED } from "./helpers.js";

/** Surfaces of the Timeline workspace that are on screen by default. */
const PANES = ["events", "timeline"];

test("shell + the Timeline workspace mount with no trace loaded", async ({ page }) => {
  await gotoEmptyApp(page);
  await expect(page.locator(".appbar")).toBeVisible();
  await expect(page.getByTestId("timeline-controls")).toBeVisible();
  await expect(page.locator(".statusbar")).toBeVisible();
  for (const id of PANES) {
    await expect(page.locator(`[data-pane="${id}"]`)).toBeVisible();
  }
  // Logs shares the dock with Events and waits behind its tab.
  await expect(page.locator('[data-pane="logs"]')).toBeHidden();
  await page.getByTestId("dock-tab-logs").click();
  await expect(page.locator('[data-pane="logs"]')).toBeVisible();

  await expect(page.getByTestId("sb-events")).toHaveText("No trace loaded");
  // The Timeline controls are present.
  await expect(page.locator(".tb-zoom")).toBeVisible();
  await expect(page.getByTestId("toggle-lanes")).toBeVisible();
  // Statistics is one click away, and its table is not in the layout until then.
  await expect(page.getByTestId("workspace-statistics")).toBeVisible();
  await expect(page.locator('[data-pane="statistics"]')).toBeHidden();
});

test("the File menu disables Save and Clear until a trace is loaded", async ({ page }) => {
  await gotoEmptyApp(page);
  await page.getByTestId("menu-file").click();
  await expect(page.getByTestId("menu-save")).toBeDisabled();
  await expect(page.getByTestId("menu-clear")).toBeDisabled();
  await expect(page.getByTestId("menu-open")).toBeEnabled();
});

test("Save writes the loaded trace back to a .svdat file", async ({ page }) => {
  await page.goto("/?fixture=dualcore");
  await expect(page.getByTestId("sb-events")).toHaveText("164 703 events");
  await page.getByTestId("menu-file").click();
  const saveItem = page.getByTestId("menu-save");
  await expect(saveItem).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");
  await saveItem.click();
  const download = await downloadPromise;
  // Saved under the source filename.
  expect(download.suggestedFilename()).toBe("dualcore.svdat");
  expect(await download.path()).toBeTruthy();
});

test("loads the dual-core demo capture and shows 164 703 events", async ({ page }) => {
  await page.goto("/?fixture=dualcore");
  await expect(page.getByTestId("sb-events")).toHaveText("164 703 events");
  await expect(page.getByTestId("sb-duration")).toContainText("capture");
  // Events table renders rows in the dock.
  await expect(page.getByTestId("events-body").locator(".ev-row").first()).toBeVisible();
  // The Statistics workspace populates from the same trace.
  await page.getByTestId("workspace-statistics").click();
  await expect(page.getByTestId("ctx-body").locator(".ctx-row").first()).toBeVisible();
});

test("opens a P4 single-file multi-core capture (auto-split)", async ({ page }) => {
  await page.goto("/?fixture=p4-mcore");
  await expect(page.getByTestId("sb-events")).toHaveText("3 274 events");
  await expect(page.getByTestId("sb-source")).toContainText("p4-mcore.svdat");
});

test("zoom selector narrows the visible span", async ({ page }) => {
  await page.goto("/?fixture=dualcore");
  await expect(page.getByTestId("sb-events")).toContainText("164 703");
  await page.locator(".tb-zoom").selectOption("1 ms");
  // The status bar reports the visible range; a 1 ms span keeps both endpoints in the same second.
  await expect(page.getByTestId("sb-range")).toContainText("–");
});

test("visual baseline: shell with the dual-core demo capture loaded", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await page.goto("/?fixture=dualcore");
  await expect(page.getByTestId("sb-events")).toHaveText("164 703 events");
  // Await render settlement.
  await settle(page);
  await expect(page).toHaveScreenshot("shell-dualcore.png", { maxDiffPixelRatio: 0.02 });
});
