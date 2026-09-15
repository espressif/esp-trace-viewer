/**
 * End-to-end tests for Find and Go navigation.
 *
 * Tests the Find bar (query input, match cycling, match counts),
 * Go menu dialogs (timestamp, event number), keyboard accelerators,
 * and search filtering across active class filters.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle, VISUAL_ENABLED } from "./helpers.js";

/** The selected event row, if one is materialized in the Events viewport. */
function selectedRow(page: Page) {
  return page.getByTestId("events-body").locator(".ev-row.is-selected");
}

/** Parse the `N of M` Find readout into `[position, total]`, or null. */
async function readCount(page: Page): Promise<[number, number] | null> {
  const text = (await page.getByTestId("find-count").textContent()) ?? "";
  const m = /^(\d+) of (\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

test("Ctrl/⌘-F reveals the Find bar and focuses the query field", async ({ page }) => {
  await openFixture(page, "dualcore");
  await expect(page.getByTestId("findbar")).toBeHidden();

  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.getByTestId("findbar")).toBeVisible();
  await expect(page.getByTestId("find-input")).toBeFocused();

  // Escape dismisses it again.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("findbar")).toBeHidden();
});

test("typing a query selects the first match and brings it into view", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByTestId("find-input").fill("svTaskStartExec");

  // Selects the first match: the readout displays "1 of M" with M > 1.
  await expect(page.getByTestId("find-count")).toHaveText(/^1 of [2-9]\d*$/);
  const count = await readCount(page);
  expect(count).not.toBeNull();
  const [pos, total] = count!;
  expect(pos).toBe(1);
  expect(total).toBeGreaterThan(1);

  // …the store selection + derived cursor moved (so every synced pane follows)…
  const s = await getState(page);
  expect(s.selectedEventIndex).not.toBeNull();
  expect(s.cursorTime).not.toBeNull();

  // …and the matched row is revealed and highlighted in the Events list.
  await expect(selectedRow(page)).toBeVisible();
});

test("Enter / Shift-Enter cycle matches with wrap", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.keyboard.press("ControlOrMeta+f");
  const input = page.getByTestId("find-input");
  await input.fill("svTaskStartExec");

  const total = (await readCount(page))![1];
  const first = (await getState(page)).selectedEventIndex!;

  // Enter advances to the next match (a later event).
  await input.press("Enter");
  expect(await readCount(page)).toEqual([2, total]);
  expect((await getState(page)).selectedEventIndex!).toBeGreaterThan(first);

  // Shift-Enter steps back to the first…
  await input.press("Shift+Enter");
  expect(await readCount(page)).toEqual([1, total]);
  expect((await getState(page)).selectedEventIndex).toBe(first);

  // …and again wraps to the last match.
  await input.press("Shift+Enter");
  expect(await readCount(page)).toEqual([total, total]);
});

test("the ◂ ▸ buttons step matches too", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByTestId("find-input").fill("svTaskStartExec");

  await page.getByTestId("find-next").click();
  const [pos] = (await readCount(page))!;
  expect(pos).toBe(2);
  await page.getByTestId("find-prev").click();
  expect((await readCount(page))![0]).toBe(1);
});

test("a query with no hits reports No matches and leaves the selection", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByTestId("find-input").fill("zzz-no-such-event");
  await expect(page.getByTestId("find-count")).toHaveText("No matches");
  expect((await getState(page)).selectedEventIndex).toBeNull();
});

test("Navigate ▸ Go to Timestamp resolves to the nearest event and moves the cursor", async ({ page }) => {
  await openFixture(page, "dualcore");
  const { domain, eventCount } = await getState(page);

  // Open the timestamp field from the Navigate dropdown, jump near the end.
  await page.getByTestId("menu-navigate").click();
  await page.getByTestId("go-timestamp").click();
  await expect(page.getByTestId("goto-time")).toBeFocused();
  await page.getByTestId("goto-time").fill(`${domain.end} s`);
  await page.getByTestId("goto-time").press("Enter");

  let s = await getState(page);
  expect(s.selectedEventIndex).toBeGreaterThan(eventCount / 2);
  expect(s.cursorTime).not.toBeNull();
  expect(s.cursorTime!).toBeLessThanOrEqual(domain.end + 1e-9);

  // Navigating near the start selects an early event.
  await page.getByTestId("goto-time").fill(`${domain.start} s`);
  await page.getByTestId("goto-time").press("Enter");
  s = await getState(page);
  expect(s.selectedEventIndex).toBeLessThan(eventCount / 2);
});

test("Navigate ▸ Go to Event # selects by 1-based number", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.getByTestId("menu-navigate").click();
  await page.getByTestId("go-number").click();
  await page.getByTestId("goto-event").fill("100");
  await page.getByTestId("goto-event").press("Enter");
  expect((await getState(page)).selectedEventIndex).toBe(99);
});

test("the [ and ] accelerators step the selection by one event", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.getByTestId("menu-navigate").click();
  await page.getByTestId("go-start").click();
  expect((await getState(page)).selectedEventIndex).toBe(0);

  await page.keyboard.press("]");
  expect((await getState(page)).selectedEventIndex).toBe(1);
  await page.keyboard.press("]");
  expect((await getState(page)).selectedEventIndex).toBe(2);
  await page.keyboard.press("[");
  expect((await getState(page)).selectedEventIndex).toBe(1);
});

test("Find searches only the visible (filtered) set", async ({ page }) => {
  await openFixture(page, "dualcore");

  // Baseline: ISR events match before any filter.
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByTestId("find-input").fill("svIsrEnter");
  expect((await readCount(page))![1]).toBeGreaterThan(0);

  // Hide ISRs via the Filter dropdown, then the same query finds nothing — Find
  // honours the active class filter (content search composes with class visibility).
  await page.getByTestId("menu-classes").click();
  await page.getByTestId("menu-show-isr").click();
  await expect(page.getByTestId("find-count")).toHaveText("No matches");
});

test("visual: the Find bar with an active match highlighted", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByTestId("find-input").fill("svTaskStartExec");
  await expect(selectedRow(page)).toBeVisible();
  await settle(page);

  // The Find UI itself (query + "N of M" readout)…
  await expect(page.getByTestId("findbar")).toHaveScreenshot("find-bar.png");
  // …and the matched row highlighted in the Events list.
  await expect(page.locator('[data-pane="events"]')).toHaveScreenshot("find-events-match.png");
});
