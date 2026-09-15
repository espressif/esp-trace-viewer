/**
 * End-to-end tests for the timeline's overflow overlay.
 *
 * The `overflow` fixture is a synthetic dual-core capture with two `svOverflow` packets per core, each
 * preceded by a 10 ms gap: both cores from 30 ms to 40 ms, then core 1 from 60 ms to 70 ms and core 0 from
 * 79 ms to 89 ms (see `scripts/gen-overflow-fixture.ts`). What follows checks that the model reports the
 * gaps, that the timeline paints them as merged bands, that hovering one reads out the loss, that the CPUs
 * menu drops a switched-off core's bands, and that clicking one selects its overflow packet.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle } from "./helpers.js";

const CANVAS = '[data-pane="timeline"] canvas';

/** The subset of the timeline introspection this spec reads. */
interface TimelineIntrospection {
  contentTop: number;
  gutterWidth: number;
  widthPx: number;
  bandCenterY(id: string): number | null;
  gapRects(): { x0: number; x1: number; cores: number[] }[];
}

/** The overflow bands the timeline is painting, left to right. */
async function gapRects(page: Page): Promise<{ x0: number; x1: number; cores: number[] }[]> {
  return page.evaluate(() => (window.__traceViewer!.panes["timeline"]!() as unknown as TimelineIntrospection).gapRects());
}

/** Canvas y of the first lane row, where the bands start. */
async function laneTop(page: Page): Promise<number> {
  return page.evaluate(() => (window.__traceViewer!.panes["timeline"]!() as unknown as TimelineIntrospection).contentTop);
}

/** Switch one core off or back on through the CPUs menu. */
async function toggleCore(page: Page, core: number): Promise<void> {
  await page.getByTestId("menu-cpus").click();
  await page.getByTestId(`menu-cpu-${core}`).click();
  await settle(page);
}

test("the model reports one gap per overflow packet", async ({ page }) => {
  await openFixture(page, "overflow");
  const { gaps } = await getState(page);
  expect(gaps.map((g) => [g.coreId, g.start, g.end, g.lost])).toEqual([
    [0, 0.03, 0.04, 40],
    [1, 0.03, 0.04, 40],
    [1, 0.06, 0.07, 60],
    [0, 0.079, 0.089, 60],
  ]);
});

test("the timeline paints the gaps as bands, merging the ones that overlap", async ({ page }) => {
  await openFixture(page, "overflow");
  const rects = await gapRects(page);
  expect(rects.map((r) => r.cores)).toEqual([[0, 1], [1], [0]]);
  // Left to right, each at least the minimum width and well inside the plot area.
  const { gutterWidth, widthPx } = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as TimelineIntrospection;
    return { gutterWidth: tl.gutterWidth, widthPx: tl.widthPx };
  });
  for (const r of rects) {
    expect(r.x1 - r.x0).toBeGreaterThanOrEqual(2);
    expect(r.x0).toBeGreaterThanOrEqual(gutterWidth);
    expect(r.x1).toBeLessThanOrEqual(widthPx);
  }
  expect(rects[0]!.x1).toBeLessThanOrEqual(rects[1]!.x0);
  expect(rects[1]!.x1).toBeLessThanOrEqual(rects[2]!.x0);
});

test("hovering a merged band reads out every core's loss", async ({ page }) => {
  await openFixture(page, "overflow");
  const box = (await page.locator(CANVAS).boundingBox())!;
  const [merged] = await gapRects(page);
  const y = (await laneTop(page)) + 5;

  await page.mouse.move(box.x + (merged!.x0 + merged!.x1) / 2, box.y + y);
  const tip = page.getByTestId("timeline-tooltip");
  await expect(tip).toBeVisible();
  // One episode reported by both cores: the loss once, the extent per core.
  await expect(tip.locator(".tl-tt-head")).toHaveText(["Overflow on cores 0, 1"]);
  await expect(tip.locator(".tl-tt-detail")).toHaveText(["40 events lost"]);
  await expect(tip.locator(".tl-tt-delta")).toHaveText([/Δ 10.* on core 0/, /Δ 10.* on core 1/]);
});

test("switching a core off drops the bands that belong to it alone", async ({ page }) => {
  await openFixture(page, "overflow");
  await toggleCore(page, 1);
  expect((await getState(page)).filters.cores).toEqual([1]);
  // The merged band stays for core 0, the 60-70 ms band was core 1's alone.
  expect((await gapRects(page)).map((r) => r.cores)).toEqual([[0], [0]]);

  await toggleCore(page, 1);
  expect((await gapRects(page)).map((r) => r.cores)).toEqual([[0, 1], [1], [0]]);
});

test("clicking a band selects its overflow packet", async ({ page }) => {
  await openFixture(page, "overflow");
  const box = (await page.locator(CANVAS).boundingBox())!;
  const rects = await gapRects(page);
  const core1 = rects.find((r) => r.cores.length === 1 && r.cores[0] === 1)!;
  // Core 0 kept running through core 1's gap, so its lane has a run there that a click would select instead; core 1's own track is blank under the band.
  const y = await page.evaluate(
    () => (window.__traceViewer!.panes["timeline"]!() as unknown as TimelineIntrospection).bandCenterY("u:1")!,
  );

  await page.mouse.click(box.x + (core1.x0 + core1.x1) / 2, box.y + y);
  const state = await getState(page);
  const gap = state.gaps.find((g) => g.coreId === 1 && g.start === 0.06)!;
  expect(state.selectedEventIndex).toBe(gap.eventIndex);
  expect(state.selectedContext).toBeNull();
  // The cursor lands inside the gap.
  expect(state.cursorTime).toBeGreaterThanOrEqual(gap.start);
  expect(state.cursorTime).toBeLessThanOrEqual(gap.end);
});
