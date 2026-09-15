/**
 * End-to-end tests for synchronized selection and cursor behavior across panes.
 *
 * Asserts event and context selection across the Events table, Timeline canvas,
 * Logs pane, and Contexts table, verifying that cursor position, view panning,
 * row highlighting, and lane focus synchronize consistently.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, getView, openFixture, paneWindow, settle, VISUAL_ENABLED } from "./helpers.js";

const ROW_H = 20;
const CANVAS = '[data-pane="timeline"] canvas';

/** Locate the rendered Events row for an absolute event index. */
function eventRow(page: Page, index: number) {
  return page.getByTestId("events-body").locator(`[data-event-index="${index}"]`);
}

/** Locate the rendered Terminal line for an absolute event index. */
function termLine(page: Page, index: number) {
  return page.getByTestId("logs-body").locator(`[data-event-index="${index}"]`);
}

/** Set the Events table's scroll offset (fires the windowing render). */
async function scrollEventsTo(page: Page, top: number): Promise<void> {
  await page.getByTestId("events-scroll").evaluate((el, t) => {
    (el as HTMLElement).scrollTop = t;
  }, top);
}

/** The timeline pane's introspection, with the fields these specs read. */
type TimelineIntro = {
  gutterWidth: number;
  contentTop: number;
  laneHeight: number;
  focusedContext: string | null;
  eventAt(x: number, y: number): { index: number; key: string } | null;
};
async function timeline(page: Page): Promise<TimelineIntro> {
  return page.evaluate(
    () => window.__traceViewer!.panes["timeline"]!() as unknown as TimelineIntro,
  );
}

test("Events pick moves the shared cursor onto the event and reveals it on the timeline", async ({ page }) => {
  await openFixture(page, "dualcore");

  // Zoom into a 1 ms slice so most events are culled out of the timeline window.
  await page.selectOption(".tb-zoom", { index: 4 }); // "1 ms"
  // Widen the list past that window so an event outside it can still be picked.
  await page.getByTestId("dock-scope").selectOption("full");
  await settle(page);
  const before = await paneWindow(page, "timeline");

  // Pick the first web-server log event — far in time from the zoomed window.
  const target = 3008;
  await scrollEventsTo(page, target * ROW_H);
  await eventRow(page, target).click();
  await settle(page);

  const state = await getState(page);
  expect(state.selectedEventIndex).toBe(target);
  expect(state.cursorTime).not.toBeNull();

  // The cursor is within the timeline window, verifying that selecting an event
  // pans the view to bring it into view.
  const after = await paneWindow(page, "timeline");
  expect(state.cursorTime!).toBeGreaterThanOrEqual(after.t0);
  expect(state.cursorTime!).toBeLessThanOrEqual(after.t1);
  expect(after.t0).not.toBeCloseTo(before.t0, 6);
  // View span is preserved; panning does not alter zoom level.
  const view = await getView(page);
  expect(view.span).toBeCloseTo(before.t1 - before.t0, 9);
});

test("Timeline click selects the event in the Events list and scrolls it into view", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;

  // Probe a point on the Unified track so the
  // selected index is large enough that the Events list has to scroll to it.
  const hit = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      gutterWidth: number;
      contentTop: number;
      laneHeight: number;
      eventAt(x: number, y: number): { index: number } | null;
    };
    const x = tl.gutterWidth + 600;
    const y = tl.contentTop + tl.laneHeight / 2;
    const e = tl.eventAt(x, y);
    return e ? { x, y, index: e.index } : null;
  });
  expect(hit).not.toBeNull();

  await page.mouse.click(box.x + hit!.x, box.y + hit!.y);
  await settle(page);

  expect((await getState(page)).selectedEventIndex).toBe(hit!.index);
  // The Events list scrolled the selected row into the rendered DOM window.
  await expect(eventRow(page, hit!.index)).toHaveClass(/is-selected/);
  await expect(eventRow(page, hit!.index)).toBeVisible();
  expect(await page.getByTestId("events-scroll").evaluate((el) => (el as HTMLElement).scrollTop)).toBeGreaterThan(0);
});

test("Logs click selects the same event everywhere", async ({ page }) => {
  await openFixture(page, "dualcore");
  const target = 3008; // first log line

  await page.getByTestId("dock-tab-both").click();
  await settle(page);
  await termLine(page, target).click();
  await settle(page);

  const state = await getState(page);
  expect(state.selectedEventIndex).toBe(target);
  expect(state.cursorTime).not.toBeNull();
  // The Events list reflects the same selection, scrolled into its DOM window.
  await expect(eventRow(page, target)).toHaveClass(/is-selected/);
  await expect(termLine(page, target)).toHaveClass(/is-selected/);
});

test("selecting a Statistics row highlights that context's lane on the timeline", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.getByTestId("workspace-statistics").click();
  await settle(page);

  const ctxRow = page.getByTestId("ctx-body").locator(".ctx-row").first();
  const key = (await ctxRow.getAttribute("data-context-key"))!;
  await ctxRow.click();
  await settle(page);

  expect((await getState(page)).selectedContext).toBe(key);
  await expect(ctxRow).toHaveClass(/is-selected/);
  // The timeline focuses the same lane (data-layer assertion on the highlight).
  await page.getByTestId("workspace-timeline").click();
  await settle(page);
  expect((await timeline(page)).focusedContext).toBe(key);
});

test("selecting an event highlights its owning context in the Statistics table", async ({ page }) => {
  await openFixture(page, "dualcore");

  // Select a log event and verify the owning context row is highlighted.
  const target = 3008;
  await page.getByTestId("dock-tab-logs").click();
  await settle(page);
  await termLine(page, target).click();
  await settle(page);

  const focused = (await timeline(page)).focusedContext;
  expect(focused).not.toBeNull();
  await page.getByTestId("workspace-statistics").click();
  await settle(page);
  const ownerRow = page.getByTestId("ctx-body").locator(`[data-context-key="${focused}"]`);
  await expect(ownerRow).toHaveClass(/is-selected/);
});

test("visual: synchronized selected state across every pane", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");

  // Select an event to verify synchronized highlights across panes: Events row,
  // Terminal line, Timeline cursor and lane tint, and Contexts table row.
  const target = 3008;
  await scrollEventsTo(page, target * ROW_H);
  await eventRow(page, target).click();
  await expect(eventRow(page, target)).toHaveClass(/is-selected/);
  await expect(termLine(page, target)).toHaveClass(/is-selected/);
  await settle(page);

  // Capture full workspace baseline to assert cross-pane synchronization.
  await expect(page).toHaveScreenshot("selection-sync.png", { maxDiffPixelRatio: 0.02 });
});
