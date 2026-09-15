/**
 * End-to-end tests for panel placement in the Timeline workspace.
 *
 * Asserts that the Events/Logs dock moves between the right and bottom edges,
 * hides and comes back, that the Lanes panel opens and closes on its own
 * divider, and that the timeline reclaims the freed width without corrupting
 * the shared TimeScale.
 */

import { expect, test } from "@playwright/test";
import { openFixture, settle } from "./helpers.js";

/** Outer size of an element by selector. */
async function box(
  page: import("@playwright/test").Page,
  sel: string,
): Promise<{ w: number; h: number }> {
  return page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
}

/** Width the timeline canvas maps, as the pane itself reports it. */
async function mappedWidth(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => window.__traceViewer!.panes["timeline"]!().widthPx);
}

test("the dock starts on the right edge and moves to the bottom", async ({ page }) => {
  await openFixture(page, "dualcore");
  await expect(page.getByTestId("dock")).toHaveClass(/dock-side-right/);

  const rightW = (await box(page, '[data-testid="dock"]')).w;
  const timelineRight = await mappedWidth(page);

  await page.getByTestId("dock-bottom").click();
  await settle(page);
  await expect(page.getByTestId("dock")).toHaveClass(/dock-side-bottom/);

  // Docked below, the dock spans the width the timeline used to share with it.
  const bottomW = (await box(page, '[data-testid="dock"]')).w;
  expect(bottomW).toBeGreaterThan(rightW);
  expect(await mappedWidth(page)).toBeGreaterThan(timelineRight);

  // The divider follows the dock onto the other axis.
  await expect(page.locator('[data-splitter="dock"]')).toHaveAttribute("aria-orientation", "horizontal");
});

test("hiding the dock gives the timeline the full width, and it comes back", async ({ page }) => {
  await openFixture(page, "dualcore");
  const shared = await mappedWidth(page);

  await page.getByTestId("dock-close").click();
  await settle(page);
  await expect(page.getByTestId("dock")).toBeHidden();
  // No divider is left behind where the dock was.
  await expect(page.locator('[data-splitter="dock"]')).toBeHidden();
  const alone = await mappedWidth(page);
  expect(alone).toBeGreaterThan(shared);

  // The toolbar toggle brings it back to the same split.
  await page.getByTestId("toggle-dock").click();
  await settle(page);
  await expect(page.getByTestId("dock")).toBeVisible();
  await expect.poll(() => mappedWidth(page)).toBeCloseTo(shared, -1);
});

test("the Lanes panel takes width from the timeline rather than covering it", async ({ page }) => {
  await openFixture(page, "dualcore");
  const closed = await mappedWidth(page);
  await expect(page.locator('[data-pane="lanes"]')).toHaveClass(/is-collapsed/);

  await page.getByTestId("toggle-lanes").click();
  await settle(page);
  await expect(page.locator('[data-pane="lanes"]')).not.toHaveClass(/is-collapsed/);
  // The canvas is resized by a ResizeObserver, which lands a frame after the class change.
  await expect.poll(() => mappedWidth(page)).toBeLessThan(closed);
  expect((await box(page, '[data-pane="lanes"]')).w).toBeGreaterThan(40);

  await page.getByTestId("toggle-lanes").click();
  await expect(page.locator('[data-pane="lanes"]')).toHaveClass(/is-collapsed/);
  await settle(page);
  // The canvas is resized by a ResizeObserver, which lands a frame after the class change.
  await expect.poll(() => mappedWidth(page)).toBeCloseTo(closed, -1);
});

test("the timeline time axis survives the dock moving around it", async ({ page }) => {
  await openFixture(page, "unicore");
  const before = await mappedWidth(page);
  expect(before).toBeGreaterThan(100);

  await page.getByTestId("dock-close").click();
  await settle(page);
  await page.getByTestId("toggle-dock").click();
  await settle(page);
  // The canvas is resized by a ResizeObserver, a frame behind the layout change.
  await expect.poll(() => mappedWidth(page)).toBe(before);

  // Clicking the timeline still sets the cursor at the clicked time.
  const canvas = (await page.locator('[data-pane="timeline"] canvas').boundingBox())!;
  await page.mouse.click(canvas.x + 500, canvas.y + canvas.height * 0.5);
  await settle(page);

  const cursorX = await page.evaluate(() => {
    const ct = window.__traceViewer!.state().cursorTime!;
    const pane = window.__traceViewer!.panes["timeline"]!() as { widthPx: number; timeAtX: (x: number) => number };
    let lo = 0, hi = pane.widthPx;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (pane.timeAtX(m) < ct) lo = m;
      else hi = m;
    }
    return { ct, x: (lo + hi) / 2 };
  });
  expect(cursorX.ct).toBeGreaterThan(0);
  expect(Math.abs(cursorX.x - 500)).toBeLessThan(2);
});
