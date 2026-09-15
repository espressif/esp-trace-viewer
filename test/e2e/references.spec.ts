/**
 * End-to-end tests for reference markers and delta measurements.
 *
 * Asserts adding, toggling, clearing, and measuring reference timestamps
 * using navigation menu actions, keyboard shortcuts, and timeline introspection.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle, VISUAL_ENABLED, zoomToEventCluster } from "./helpers.js";

const CANVAS = '[data-pane="timeline"] canvas';

/** The Δ measurement the timeline pane exposes (sorted ref times + deltas). */
interface RefMeasurement {
  refs: number[];
  spans: { from: number; to: number; dt: number; events: number }[];
  toCursor: { from: number; to: number; dt: number; events: number } | null;
}
async function measurement(page: Page): Promise<RefMeasurement> {
  return page.evaluate(
    () => (window.__traceViewer!.panes["timeline"]!() as unknown as { references(): RefMeasurement }).references(),
  );
}

/** The timeline pane's gutter width, so clicks land in the plot area. */
async function gutterWidth(page: Page): Promise<number> {
  return page.evaluate(() => (window.__traceViewer!.panes["timeline"]!() as unknown as { gutterWidth: number }).gutterWidth);
}

/** Click the plot area at canvas-local x (mid-height) to place the cursor there. */
async function clickPlot(page: Page, x: number): Promise<number> {
  const box = (await page.locator(CANVAS).boundingBox())!;
  await page.mouse.click(box.x + x, box.y + box.height / 2);
  await settle(page);
  return (await getState(page)).cursorTime!;
}

/** Open the Navigate dropdown and choose an item by its test id. */
async function chooseMenu(page: Page, itemTestId: string): Promise<void> {
  await page.getByTestId("menu-navigate").click();
  await page.getByTestId(itemTestId).click();
}

test("Toggle Reference creates a marker at the cursor and measures delta between pairs", async ({ page }) => {
  await openFixture(page, "dualcore");
  await zoomToEventCluster(page);
  const gw = await gutterWidth(page);

  // Place the cursor and add references at two distinct positions.
  const tA = await clickPlot(page, gw + 200);
  await chooseMenu(page, "menu-toggle-reference");
  expect((await getState(page)).references).toHaveLength(1);

  const tB = await clickPlot(page, gw + 500);
  await chooseMenu(page, "menu-toggle-reference");
  const refs = (await getState(page)).references;
  expect(refs).toHaveLength(2);

  // The displayed Δ between the two references matches the two cursor times.
  const m = await measurement(page);
  expect(m.refs).toEqual([Math.min(tA, tB), Math.max(tA, tB)]);
  expect(m.spans).toHaveLength(1);
  expect(m.spans[0]!.dt).toBeCloseTo(Math.abs(tB - tA), 9);
  expect(m.spans[0]!.events).toBeGreaterThan(0); // event count within reference interval
});

test("moving the cursor after a reference measures the reference→cursor Δ", async ({ page }) => {
  await openFixture(page, "dualcore");
  await zoomToEventCluster(page);
  const gw = await gutterWidth(page);

  const tRef = await clickPlot(page, gw + 250);
  await chooseMenu(page, "menu-toggle-reference");

  // Moving the cursor updates the measurement from reference to cursor.
  const tCur = await clickPlot(page, gw + 600);
  const m = await measurement(page);
  expect(m.toCursor).not.toBeNull();
  expect(m.toCursor!.dt).toBeCloseTo(Math.abs(tCur - tRef), 9);
});

test("the R accelerator toggles a reference off when pressed on the same cursor", async ({ page }) => {
  await openFixture(page, "dualcore");
  await zoomToEventCluster(page);
  const gw = await gutterWidth(page);

  await clickPlot(page, gw + 300);
  await page.keyboard.press("KeyR"); // place reference
  expect((await getState(page)).references).toHaveLength(1);
  await page.keyboard.press("KeyR"); // same cursor → toggle off
  expect((await getState(page)).references).toHaveLength(0);
});

test("Clear All References removes them from the shared store (every pane)", async ({ page }) => {
  await openFixture(page, "dualcore");
  await zoomToEventCluster(page);
  const gw = await gutterWidth(page);

  await clickPlot(page, gw + 200);
  await chooseMenu(page, "menu-toggle-reference");
  await clickPlot(page, gw + 450);
  await chooseMenu(page, "menu-toggle-reference");
  expect((await getState(page)).references).toHaveLength(2);

  // Shift+R clears references from state and timeline measurement.
  await page.keyboard.press("Shift+KeyR");
  expect((await getState(page)).references).toHaveLength(0);
  const m = await measurement(page);
  expect(m.refs).toEqual([]);
  expect(m.spans).toEqual([]);

  // The menu item is disabled again with nothing to clear.
  await page.getByTestId("menu-navigate").click();
  await expect(page.getByTestId("menu-clear-references")).toBeDisabled();
});

test("visual: two references and the Δ annotation on the timeline", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await zoomToEventCluster(page);
  const gw = await gutterWidth(page);

  await clickPlot(page, gw + 200);
  await chooseMenu(page, "menu-toggle-reference");
  await clickPlot(page, gw + 560);
  await chooseMenu(page, "menu-toggle-reference");
  // Position cursor away from both references to display the ref-to-cursor delta.
  await clickPlot(page, gw + 760);
  await settle(page);

  await expect(page).toHaveScreenshot("references-delta.png", { maxDiffPixelRatio: 0.02 });
});
