/**
 * End-to-end tests for the CPUs menu on the Timeline controls bar.
 *
 * The menu switches cores off. What follows checks that the choice reaches everywhere the design says it
 * should: the lanes that belong to one core leave the timeline, a task that migrated between cores keeps its
 * lane but loses the runs recorded on the switched-off core, the Events and Logs lists narrow to the
 * remaining cores, and the core-neutral data plots stay put even with every core switched off.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle } from "./helpers.js";

/** Node identifiers of the bands the timeline is drawing. */
async function bandIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const intro = window.__traceViewer!.panes["timeline"]!() as unknown as { bands: { id: string }[] };
    return intro.bands.map((b) => b.id);
  });
}

/** Total rows the Events virtualizer is sizing the scrollbar for. */
async function totalRows(page: Page): Promise<number> {
  return Number(await page.getByTestId("events-scroll").getAttribute("data-total-rows"));
}

/** Switch one core off or back on through the CPUs menu. */
async function toggleCore(page: Page, core: number): Promise<void> {
  await page.getByTestId("menu-cpus").click();
  await page.getByTestId(`menu-cpu-${core}`).click();
  await settle(page);
}

test("switching a core off drops its lanes and narrows the lists", async ({ page }) => {
  await openFixture(page, "dualcore");
  await expect(page.getByTestId("sb-lanes")).toHaveText("37/37 lanes");
  const before = await bandIds(page);
  expect(before).toContain("u:0");
  expect(before).toContain("cpu:0");
  const allRows = await totalRows(page);

  await toggleCore(page, 0);
  expect((await getState(page)).filters.cores).toEqual([0]);

  const after = await bandIds(page);
  // Lanes belonging to core 0 alone are gone; core 1's are untouched.
  expect(after).not.toContain("u:0");
  expect(after).not.toContain("cpu:0");
  expect(after).not.toContain("c:ipc0");
  expect(after).toContain("u:1");
  expect(after).toContain("cpu:1");
  expect(after).toContain("c:ipc1");
  // A task that ran on both cores keeps its lane.
  expect(after).toContain("c:tcpip");

  // The Events list drops the core 0 events, and the status bar counts what is drawn.
  expect(await totalRows(page)).toBeLessThan(allRows);
  // 16 of the demo's 37 lanes belong to core 0 alone.
  await expect(page.getByTestId("sb-lanes")).toHaveText("21/37 lanes");

  // Switching it back on restores everything.
  await toggleCore(page, 0);
  expect((await getState(page)).filters.cores).toEqual([]);
  expect(await bandIds(page)).toEqual(before);
  expect(await totalRows(page)).toBe(allRows);
  await expect(page.getByTestId("sb-lanes")).toHaveText("37/37 lanes");
});

test("a migrating task keeps its lane but loses the runs on the switched-off core", async ({ page }) => {
  await openFixture(page, "dualcore");

  /**
   * Events the run bars along the width of `tcpip`'s lane would select. Only execution bars count: the
   * ready-to-run boxes underneath belong to the task rather than to a core, so the CPU filter leaves them.
   */
  const runsHit = async (): Promise<number[]> =>
    page.evaluate(() => {
      const intro = window.__traceViewer!.panes["timeline"]!() as unknown as {
        bands: { id: string; centerY: number }[];
        eventAt: (x: number, y: number) => { index: number; kind: string } | null;
      };
      const band = intro.bands.find((b) => b.id === "c:tcpip")!;
      const seen = new Set<number>();
      for (let x = 200; x < 1200; x += 2) {
        const hit = intro.eventAt(x, band.centerY);
        if (hit?.kind === "span") seen.add(hit.index);
      }
      return [...seen].sort((a, b) => a - b);
    });

  // Zoomed all the way out a tcpip run is far narrower than a pixel; this window puts real bars on screen.
  await page.evaluate(() => window.__traceViewer!.zoomToEventRange(100000, 101000));
  await settle(page);

  const both = await runsHit();
  expect(both.length).toBeGreaterThan(0);

  await toggleCore(page, 0);
  // The lane survives, because tcpip also ran on core 1 ...
  expect(await bandIds(page)).toContain("c:tcpip");
  // ... but what it draws is now a strict subset: the runs recorded on core 0 are gone.
  const one = await runsHit();
  expect(one.length).toBeGreaterThan(0);
  expect(one.length).toBeLessThan(both.length);
  expect(one.every((i) => both.includes(i))).toBe(true);
});

test("with every core switched off only the core-neutral data plots remain", async ({ page }) => {
  await openFixture(page, "dualcore");
  await toggleCore(page, 0);
  await toggleCore(page, 1);
  expect((await getState(page)).filters.cores).toEqual([0, 1]);

  const ids = await bandIds(page);
  expect(ids.length).toBeGreaterThan(0);
  // Every remaining lane is a data plot; its group header rides along with it.
  expect(ids.filter((id) => !id.startsWith("g:")).every((id) => id.startsWith("d:"))).toBe(true);
  expect(await totalRows(page)).toBe(0);
});
