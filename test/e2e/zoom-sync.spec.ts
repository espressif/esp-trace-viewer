/**
 * End-to-end tests for synchronized zoom and pan controls.
 *
 * Asserts time window updates driven by the toolbar zoom selector, mouse wheel,
 * canvas drag gestures, and keyboard navigation, verifying that visible time ranges,
 * application state, and cursor positions synchronize consistently.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, getView, openFixture, paneWindow, settle, VISUAL_ENABLED } from "./helpers.js";

const TIMELINE = '[data-pane="timeline"] canvas';

/** A pane's time axis as the harness reads it (a superset of PaneIntrospection). */
interface AxisIntrospect {
  gutterWidth: number;
  contentTop: number;
  laneHeight: number;
  timeAtX(x: number): number;
}

/** Dispatch `ticks` wheel events at a canvas-local x (negative deltaY zooms in). */
async function wheelOn(page: Page, selector: string, deltaY: number, ticks: number, atX: number): Promise<void> {
  await page.evaluate(
    ({ selector, deltaY, ticks, atX }) => {
      const c = document.querySelector(selector) as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      for (let i = 0; i < ticks; i++) {
        c.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY,
            clientX: r.left + atX,
            clientY: r.top + 60,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    },
    { selector, deltaY, ticks, atX },
  );
  await settle(page);
}

test("toolbar zoom selector drives the shared window, mirrored into the store", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.selectOption(".tb-zoom", { index: 4 }); // "1 ms"
  await settle(page);

  const tl = await paneWindow(page, "timeline");
  // The store mirrors the shared window, and the chosen 1 ms span is honoured.
  const state = await getState(page);
  expect(state.view.t0).toBeCloseTo(tl.t0, 9);
  expect(state.view.t1).toBeCloseTo(tl.t1, 9);
  expect(tl.t1 - tl.t0).toBeCloseTo(1e-3, 6);
});

test("wheel-zoom over the timeline narrows the shared window", async ({ page }) => {
  await openFixture(page, "dualcore");
  const before = await paneWindow(page, "timeline");

  await wheelOn(page, TIMELINE, -100, 30, 140);

  const tl = await paneWindow(page, "timeline");
  expect(tl.t1 - tl.t0).toBeLessThan(before.t1 - before.t0); // zoomed in
  const state = await getState(page);
  expect(state.view.t0).toBeCloseTo(tl.t0, 9);
  expect(state.view.t1).toBeCloseTo(tl.t1, 9);
});

test("dragging the timeline plot pans the shared window", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.selectOption(".tb-zoom", { index: 4 }); // 1 ms, so a pan actually moves
  await settle(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const before = await paneWindow(page, "timeline");
  const box = (await page.locator(TIMELINE).boundingBox())!;
  // Drag inside the plot area (right of the gutter, below the ruler).
  const at = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as AxisIntrospect;
    return { x: tl.gutterWidth + 260, y: tl.contentTop + tl.laneHeight + 4 };
  });
  const y = box.y + at.y;
  await page.mouse.move(box.x + at.x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + at.x - i * 15, y); // drag left → later in time
  await page.mouse.up();
  await settle(page);

  const tl = await paneWindow(page, "timeline");
  expect(tl.t0).toBeGreaterThan(before.t0); // the drag moved the shared window later
});

test("keyboard shortcuts zoom and pan the shared window", async ({ page }) => {
  await openFixture(page, "dualcore");

  const full = await getView(page);
  await page.keyboard.press("="); // '+' without shift on common layouts → zoom in
  await settle(page);
  expect((await getView(page)).span).toBeLessThan(full.span);

  await page.keyboard.press("0"); // zoom to fit
  await settle(page);
  expect((await getView(page)).isFullyZoomedOut).toBe(true);

  // Zoom in via the selector, defocus it, then pan with the arrow key.
  await page.selectOption(".tb-zoom", { index: 4 });
  await settle(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const before = await paneWindow(page, "timeline");
  await page.keyboard.press("ArrowRight");
  await settle(page);

  expect((await paneWindow(page, "timeline")).t0).toBeGreaterThan(before.t0);
});

test("the cursor holds its instant across zoom", async ({ page }) => {
  await openFixture(page, "dualcore");

  // Click the timeline to place a cursor.
  const box = (await page.locator(TIMELINE).boundingBox())!;
  const at = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as AxisIntrospect;
    return { x: tl.gutterWidth + 200, y: tl.contentTop + tl.laneHeight + 4 };
  });
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await settle(page);

  const cursor = (await getState(page)).cursorTime;
  expect(cursor).not.toBeNull();

  // Zoom in and verify that the cursor timestamp remains constant.
  await wheelOn(page, TIMELINE, -100, 10, at.x);
  expect((await getState(page)).cursorTime).toBeCloseTo(cursor!, 9);
});

test("clicking the capture overview moves the window there at the same zoom", async ({ page }) => {
  await openFixture(page, "dualcore");
  const domain = (await getState(page)).domain;

  // Zoom in so the window is a small part of the capture and has somewhere to move to.
  await page.evaluate(() => window.__traceViewer!.zoomToEventRange(0, 4000));
  await settle(page);
  const before = await getView(page);
  expect(before.span).toBeLessThan((domain.end - domain.start) / 4);

  // Click three quarters of the way along the overview strip.
  const strip = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      gutterWidth: number;
      overviewHeight: number;
      widthPx: number;
    };
    return tl;
  });
  expect(strip.overviewHeight).toBeGreaterThan(0);
  const box = (await page.locator(TIMELINE).boundingBox())!;
  const plotW = strip.widthPx - strip.gutterWidth;
  await page.mouse.click(
    box.x + strip.gutterWidth + plotW * 0.75,
    box.y + strip.overviewHeight / 2,
  );
  await settle(page);

  const after = await getView(page);
  // The span is untouched and the window is centred on the point clicked.
  expect(after.span).toBeCloseTo(before.span, 6);
  const wanted = domain.start + (domain.end - domain.start) * 0.75;
  expect((after.t0 + after.t1) / 2).toBeCloseTo(wanted, 2);
});

test("a click on the overview does not move the cursor the way a click on the plot does", async ({ page }) => {
  await openFixture(page, "dualcore");
  const strip = await page.evaluate(
    () => window.__traceViewer!.panes["timeline"]!() as unknown as { gutterWidth: number; overviewHeight: number },
  );
  const box = (await page.locator(TIMELINE).boundingBox())!;
  await page.mouse.click(box.x + strip.gutterWidth + 120, box.y + strip.overviewHeight / 2);
  await settle(page);
  expect((await getState(page)).cursorTime).toBeNull();
});

test("visual: timeline with its lanes — full recording (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await settle(page);
  await expect(page).toHaveScreenshot("zoom-sync-fit.png");
});

test("visual: timeline with its lanes — zoomed to 1 ms (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await page.selectOption(".tb-zoom", { index: 4 }); // "1 ms"
  await settle(page);
  await expect(page).toHaveScreenshot("zoom-sync-1ms.png");
});
