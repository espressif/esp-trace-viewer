/**
 * End-to-end tests for the test harness infrastructure.
 *
 * Validates DOM assertion helpers, the window.__traceViewer introspection API,
 * render settlement detection, and canvas screenshot baselines.
 */

import { expect, test } from "@playwright/test";
import { getState, getView, openFixture, paneWindow, settle, VISUAL_ENABLED } from "./helpers.js";

test("DOM: shell boots and the status bar reflects the loaded fixture", async ({ page }) => {
  await openFixture(page, "dualcore");
  await expect(page.getByTestId("sb-events")).toHaveText("164 703 events");
  await expect(page.locator('[data-pane="timeline"] canvas')).toBeVisible();
});

test("introspection: the test API reports the loaded model at the data layer", async ({ page }) => {
  await openFixture(page, "dualcore");

  const state = await getState(page);
  expect(state.eventCount).toBe(164703);
  expect(state.sourceNames).toContain("dualcore.svdat");
  expect(state.loadError).toBeNull();

  // Freshly fitted: the view window covers the whole trace domain.
  const view = await getView(page);
  expect(view.isFullyZoomedOut).toBe(true);
  expect(view.t0).toBeCloseTo(view.domainStart, 9);
  expect(view.t1).toBeCloseTo(view.domainEnd, 9);
  expect(view.widthPx).toBeGreaterThan(0);
});

test("introspection: the timeline pane exposes its window and a lane hit-test", async ({ page }) => {
  await openFixture(page, "dualcore");

  // The pane maps the same window as the shared TimeScale.
  const paneWin = await paneWindow(page, "timeline");
  const view = await getView(page);
  expect(paneWin.t0).toBeCloseTo(view.t0, 9);
  expect(paneWin.t1).toBeCloseTo(view.t1, 9);

  // Hit-testing the center of the first context-lane band resolves to lane 0;
  // out-of-bounds coordinates return null.
  const hit = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      contentHeight: number;
      lanes: { key: string; label: string }[];
      bands: { kind: string; centerY: number; source: { kind: string } | null }[];
      laneAtY(y: number): { index: number; label: string } | null;
    };
    const firstCtx = tl.bands.find((b) => b.kind === "lane" && b.source?.kind === "context")!;
    return { count: tl.lanes.length, first: tl.laneAtY(firstCtx.centerY), miss: tl.laneAtY(tl.contentHeight + 10_000) };
  });
  expect(hit.count).toBeGreaterThan(0);
  expect(hit.first?.index).toBe(0);
  expect(hit.miss).toBeNull();
});

test("render-settled: the data layer is stable across two settled reads", async ({ page }) => {
  await openFixture(page, "dualcore");
  const a = await getView(page);
  await settle(page);
  const b = await getView(page);
  // Settled reads remain identical when no interaction occurs.
  expect(b).toEqual(a);
});

test("visual: timeline canvas baseline (dual-core demo fixture)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await expect(page.locator('[data-pane="timeline"] canvas')).toHaveScreenshot("timeline-dualcore.png");
});
