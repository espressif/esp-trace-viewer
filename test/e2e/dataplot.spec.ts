/**
 * End-to-end tests for DataPlot lanes.
 *
 * Tests conditional creation of the Data group for traces with data samples,
 * per-series lane generation, cursor-value tooltip readouts, and sample snapping.
 */

import { expect, test } from "@playwright/test";
import { getState, openFixture, scrollTimelineToBottom, settle, timelineBands, VISUAL_ENABLED } from "./helpers.js";

const CANVAS = '[data-pane="timeline"] canvas';

/** Centre (canvas-local x, y) of an on-screen data-plot lane, with the gutter x. */
async function dataPlotProbe(page: import("@playwright/test").Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      gutterWidth: number;
      contentTop: number;
      bands: { type: string; centerY: number }[];
    };
    // The demo registers more data series than fit on screen at once, so pick a
    // lane the scrolled viewport actually shows.
    const height = document.querySelector('[data-pane="timeline"] canvas')!.getBoundingClientRect().height;
    const band = tl.bands.find(
      (b) => b.type === "dataplot" && b.centerY > tl.contentTop + 8 && b.centerY < height - 8,
    )!;
    return { x: tl.gutterWidth + 200, y: band.centerY };
  });
}

test("a data-free trace has no data-plot lane", async ({ page }) => {
  await openFixture(page, "p4-mcore");
  expect((await timelineBands(page)).some((b) => b.type === "dataplot")).toBe(false);
  expect((await timelineBands(page)).some((b) => b.groupId === "g:data")).toBe(false);
});

test("a trace with data samples grows a Data group of one lane per series", async ({ page }) => {
  await openFixture(page, "unicore");
  const bands = await timelineBands(page);

  // The "Data" group announces itself on its first lane…
  expect(bands.some((b) => b.groupLabel === "Data")).toBe(true);

  // …with one data-plot lane per registered series, labelled name (unit).
  const plots = bands.filter((b) => b.type === "dataplot");
  expect(plots.length).toBe(7);
  expect(plots.map((b) => b.label).sort()).toEqual([
    "cpu0_load (%)",
    "filtered (mV)",
    "heap_free (KB)",
    "raw (mV)",
    "temp (C)",
    "throttle (%)",
    "timer_jitter (us)",
  ]);
});

test("the data-plot lanes share the timeline's visible window", async ({ page }) => {
  // They are lanes in the timeline host and share the TimeScale time axis.
  await openFixture(page, "unicore");
  const win = await page.evaluate(() => window.__traceViewer!.panes["timeline"]!().visibleWindow);
  expect(win.t1).toBeGreaterThan(win.t0);
  expect((await timelineBands(page)).filter((b) => b.type === "dataplot").length).toBe(7);
});

test("hovering near the cursor in a data-plot lane shows the value at the cursor", async ({ page }) => {
  await openFixture(page, "unicore");
  await scrollTimelineToBottom(page);
  await settle(page);

  const box = (await page.locator(CANVAS).boundingBox())!;
  const probe = await dataPlotProbe(page);

  // Click to set the shared cursor in this lane, then hover just beside it.
  await page.mouse.click(box.x + probe.x, box.y + probe.y);
  await settle(page);
  await page.mouse.move(box.x + probe.x + 6, box.y + probe.y);

  const tip = page.getByTestId("timeline-tooltip");
  await expect(tip).toBeVisible();
  // The readout names the series and its value at the cursor (e.g. "temp (C) = 21.5").
  await expect(tip.locator(".tl-tt-detail")).toContainText("=");

  // Hovering far from the cursor (still in the lane) shows nothing.
  await page.mouse.move(box.x + probe.x + 200, box.y + probe.y);
  await expect(tip).toBeHidden();
});

test("a data-plot lane click snaps only onto its own samples", async ({ page }) => {
  await openFixture(page, "unicore");
  await scrollTimelineToBottom(page);
  await settle(page);
  const box = (await page.locator(CANVAS).boundingBox())!;

  // Pick two consecutive samples of an on-screen data-plot lane (mid-trace) and
  // resolve their event indices, so the window can frame exactly that pair.
  const probeY = (await dataPlotProbe(page)).y;
  const pick = await page.evaluate((y) => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      eventTimeAt(index: number): number | null;
      snapTimesAt(y: number): number[];
    };
    const times = tl.snapTimesAt(y);
    let a = Math.floor(times.length / 2);
    while (a + 1 < times.length && times[a + 1]! <= times[a]!) a++;
    const tA = times[a]!;
    const tB = times[a + 1]!;
    const count = window.__traceViewer!.state().eventCount;
    const idx = (t: number): number => {
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((tl.eventTimeAt(mid) ?? Infinity) < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return { y, tA, tB, iA: idx(tA), iB: idx(tB) };
  }, probeY);
  expect(pick.tB).toBeGreaterThan(pick.tA);
  await page.evaluate(({ iA, iB }) => window.__traceViewer!.zoomToEventRange(iA, iB), pick);
  await settle(page);

  // The pair spans the plot, separating the samples on screen.
  const at = await page.evaluate(({ y, tA, tB }) => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      gutterWidth: number;
      cursorSnapPx: number;
      timeAtX(x: number): number;
    };
    const t0 = tl.timeAtX(tl.gutterWidth);
    const spp = tl.timeAtX(tl.gutterWidth + 1) - t0;
    const xOf = (t: number): number => tl.gutterWidth + (t - t0) / spp;
    return { y, snapPx: tl.cursorSnapPx, sampleX: xOf(tA), midX: Math.round((xOf(tA) + xOf(tB)) / 2) };
  }, pick);

  // A click just beside a sample snaps the cursor exactly onto the sample…
  await page.mouse.click(box.x + Math.round(at.sampleX + at.snapPx / 2), box.y + at.y);
  expect((await getState(page)).cursorTime!).toBeCloseTo(pick.tA, 12);

  // …while a click midway between samples places the cursor exactly on the
  // clicked pixel's time — other events near that instant must not attract it.
  const midT = await page.evaluate(
    (x) => (window.__traceViewer!.panes["timeline"]!() as unknown as { timeAtX(x: number): number }).timeAtX(x),
    at.midX,
  );
  await page.mouse.click(box.x + at.midX, box.y + at.y);
  expect((await getState(page)).cursorTime!).toBeCloseTo(midT, 9);
});

test("visual: DataPlot lanes inside the timeline (single-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "unicore");
  await scrollTimelineToBottom(page);
  await settle(page);
  await expect(page.locator('[data-pane="timeline"] canvas')).toHaveScreenshot("dataplot-lanes.png");
});
