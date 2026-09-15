/**
 * End-to-end tests for the Events list pane.
 *
 * Tests rendering of decoded event rows (Context, Event, Detail), virtualization,
 * keyboard navigation, multi-row range selection, and markdown clipboard copying.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle, VISUAL_ENABLED } from "./helpers.js";

const ROW_H = 20;

/** Set the events table's vertical scroll offset (fires the windowing render). */
async function scrollEventsTo(page: Page, top: number): Promise<void> {
  await page.getByTestId("events-scroll").evaluate((el, t) => {
    (el as HTMLElement).scrollTop = t;
  }, top);
}

/** Locate the rendered row for an absolute event index. */
function row(page: Page, index: number) {
  return page.getByTestId("events-body").locator(`[data-event-index="${index}"]`);
}

test("renders specific event rows with the decoded context/event/detail", async ({ page }) => {
  await openFixture(page, "dualcore");

  // The first rows are in the DOM at the top of the scroll.
  await expect(row(page, 0).locator(".ev-name")).toHaveText("svTraceStart");
  await expect(row(page, 0).locator(".ev-ctx")).toHaveText("IDLE0");

  await expect(row(page, 1).locator(".ev-name")).toHaveText("svInit");
  await expect(row(page, 1).locator(".ev-detail")).toHaveText(
    "sys_freq=1000000, cpu_freq=320000000, ram_base=1073741824, id_shift=0",
  );

  // A deeper row only exists once scrolled to — proof it is windowed.
  await expect(row(page, 372)).toHaveCount(0);
  await scrollEventsTo(page, 372 * ROW_H);
  await expect(row(page, 372).locator(".ev-name")).toHaveText("svTaskStartExec");
  await expect(row(page, 372).locator(".ev-ctx")).toHaveText("ipc0");
  await expect(row(page, 372).locator(".ev-detail")).toHaveText("tid=4009914260");
});

test("decodes svDataSample rows to their registered name, value, and unit", async ({ page }) => {
  // The demo registers eight FLOAT series and samples them from the stats
  // window; their sample rows must show the decoded reading, not the raw
  // `data_id=…, value=…`.
  await openFixture(page, "dualcore");
  await scrollEventsTo(page, 16_064 * ROW_H);

  await expect(row(page, 16_067).locator(".ev-name")).toHaveText("svDataSample");
  await expect(row(page, 16_067).locator(".ev-detail")).toHaveText("temp = 36.000000 C");
  await expect(row(page, 16_068).locator(".ev-detail")).toHaveText("cpu0_load = 0.000000 %");
  await expect(row(page, 16_069).locator(".ev-detail")).toHaveText("cpu1_load = 0.000000 %");
  await expect(row(page, 16_070).locator(".ev-detail")).toHaveText("timer_jitter = 15.000000 us");
});

test("colour-classes rows by event kind", async ({ page }) => {
  await openFixture(page, "dualcore");
  await expect(row(page, 0)).toHaveClass(/ev-cls-system/); // svTraceStart
  await scrollEventsTo(page, 372 * ROW_H);
  await expect(row(page, 372)).toHaveClass(/ev-cls-task/); // svTaskStartExec
  await expect(row(page, 384)).toHaveClass(/ev-cls-api/); // xQueueGenericReceive
});

test("virtualizes: a small window in the DOM, full count on the scrollbar", async ({ page }) => {
  await openFixture(page, "dualcore");

  // The scrollbar/sizer spans every event…
  await expect(page.getByTestId("events-scroll")).toHaveAttribute("data-total-rows", "164703");
  // …but only a viewport-sized window of rows is materialized.
  const rendered = await page.getByTestId("events-body").locator(".ev-row").count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(120);

  // Scrolling deep keeps the window small and swaps which rows exist.
  await scrollEventsTo(page, 20_000 * ROW_H);
  await expect(row(page, 20_000)).toHaveCount(1);
  await expect(row(page, 0)).toHaveCount(0);
  const deepRendered = await page.getByTestId("events-body").locator(".ev-row").count();
  expect(deepRendered).toBeLessThan(120);
});

test("keyboard navigation moves selection and scrolls it into view", async ({ page }) => {
  await openFixture(page, "dualcore");
  const scroll = page.getByTestId("events-scroll");
  await scroll.focus();

  // Down from nothing selects the first row, then advances.
  await page.keyboard.press("ArrowDown");
  expect((await getState(page)).selectedEventIndex).toBe(0);
  await page.keyboard.press("ArrowDown");
  expect((await getState(page)).selectedEventIndex).toBe(1);
  await expect(row(page, 1)).toHaveClass(/is-selected/);

  // End jumps to the last event and scrolls it into view.
  await page.keyboard.press("End");
  expect((await getState(page)).selectedEventIndex).toBe(164702);
  await expect(row(page, 164702)).toBeVisible();
  expect(await scroll.evaluate((el) => (el as HTMLElement).scrollTop)).toBeGreaterThan(0);

  // Home returns to the top.
  await page.keyboard.press("Home");
  expect((await getState(page)).selectedEventIndex).toBe(0);
  await expect(row(page, 0)).toBeVisible();
});

test("revealing a later event scrolls it fully into view, not past the bottom edge", async ({ page }) => {
  // Verify that jumping selection downward scrolls the selected row completely
  // into view: positioned below the header and above the viewport bottom edge.
  await openFixture(page, "dualcore");
  const scroll = page.getByTestId("events-scroll");
  await scroll.focus();

  // PageDown jumps the selection a viewport down, so the newly-selected row must
  // be revealed by scrolling downward — the path that exposed the bug.
  await page.keyboard.press("PageDown");
  const sel = (await getState(page)).selectedEventIndex!;
  expect(sel).toBeGreaterThan(0);

  const geom = await page.evaluate(() => {
    const scrollEl = document.querySelector('[data-testid="events-scroll"]') as HTMLElement;
    const headEl = scrollEl.querySelector(".ev-head") as HTMLElement;
    const rowEl = scrollEl.querySelector(".ev-row.is-selected") as HTMLElement | null;
    if (!rowEl) return null;
    const s = scrollEl.getBoundingClientRect();
    const h = headEl.getBoundingClientRect();
    const r = rowEl.getBoundingClientRect();
    return { sBottom: s.bottom, hBottom: h.bottom, rTop: r.top, rBottom: r.bottom };
  });
  expect(geom).not.toBeNull();
  // Fully below the sticky header…
  expect(geom!.rTop).toBeGreaterThanOrEqual(geom!.hBottom - 0.5);
  // …and fully above the viewport's lower edge (the part the bug broke).
  expect(geom!.rBottom).toBeLessThanOrEqual(geom!.sBottom + 0.5);
});

test("clicking a row selects its absolute event index", async ({ page }) => {
  await openFixture(page, "dualcore");
  await scrollEventsTo(page, 26 * ROW_H);
  await row(page, 26).click();
  expect((await getState(page)).selectedEventIndex).toBe(26);
  await expect(row(page, 26)).toHaveClass(/is-selected/);
});

test("shift-click selects a contiguous range, plain click collapses it", async ({ page }) => {
  await openFixture(page, "dualcore");

  // Plain click anchors the selection on row 2…
  await row(page, 2).click();
  // …shift-click on row 5 stretches it down to a four-row range.
  await row(page, 5).click({ modifiers: ["Shift"] });
  expect((await getState(page)).selectedEventIndex).toBe(5);
  for (const i of [2, 3, 4, 5]) await expect(row(page, i)).toHaveClass(/is-selected/);
  for (const i of [1, 6]) await expect(row(page, i)).not.toHaveClass(/is-selected/);
  // The focus end carries the extra marker; the anchor does not.
  await expect(row(page, 5)).toHaveClass(/is-focus/);
  await expect(row(page, 2)).not.toHaveClass(/is-focus/);

  // Shift-click works upward too, re-spanning from the same anchor.
  await row(page, 0).click({ modifiers: ["Shift"] });
  for (const i of [0, 1, 2]) await expect(row(page, i)).toHaveClass(/is-selected/);
  for (const i of [3, 4, 5]) await expect(row(page, i)).not.toHaveClass(/is-selected/);

  // A plain click collapses the range back to a single row.
  await row(page, 4).click();
  expect((await getState(page)).selectedEventIndex).toBe(4);
  await expect(row(page, 4)).toHaveClass(/is-selected/);
  await expect(row(page, 4)).not.toHaveClass(/is-focus/);
  for (const i of [0, 1, 2, 3]) await expect(row(page, i)).not.toHaveClass(/is-selected/);
});

test("shift+ArrowDown extends the selection from the keyboard", async ({ page }) => {
  await openFixture(page, "dualcore");
  const scroll = page.getByTestId("events-scroll");
  await scroll.focus();

  await page.keyboard.press("ArrowDown"); // select row 0
  await page.keyboard.press("Shift+ArrowDown"); // extend to row 1
  await page.keyboard.press("Shift+ArrowDown"); // extend to row 2
  expect((await getState(page)).selectedEventIndex).toBe(2);
  for (const i of [0, 1, 2]) await expect(row(page, i)).toHaveClass(/is-selected/);
  await expect(row(page, 3)).not.toHaveClass(/is-selected/);
});

test("Ctrl/Cmd-C copies the selected range as a markdown table", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openFixture(page, "dualcore");

  const scroll = page.getByTestId("events-scroll");
  await row(page, 0).click();
  await row(page, 1).click({ modifiers: ["Shift"] });
  await scroll.focus();
  await page.keyboard.press("ControlOrMeta+c");

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(
    [
      "| # | Time | Core | Context | Event | Detail |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 1 | 0 s | 0 | IDLE0 | svTraceStart |  |",
      "| 2 | 3.000 µs | 0 | IDLE0 | svInit | sys_freq=1000000, cpu_freq=320000000, ram_base=1073741824, id_shift=0 |",
    ].join("\n"),
  );
});

test("visual: events table at a fixed scroll offset (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await scrollEventsTo(page, 200 * ROW_H);
  await expect(row(page, 200)).toBeVisible();
  await settle(page);
  await expect(page.locator('[data-pane="events"]')).toHaveScreenshot("events-dualcore.png");
});

test("visual: decoded svDataSample rows", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  // Frame a run of decoded sample rows, so the baseline shows the registered
  // names + units in the Detail column.
  await scrollEventsTo(page, 16_064 * ROW_H);
  await expect(row(page, 16_067).locator(".ev-detail")).toHaveText("temp = 36.000000 C");
  await settle(page);
  await expect(page.locator('[data-pane="events"]')).toHaveScreenshot("events-dataplot.png");
});
