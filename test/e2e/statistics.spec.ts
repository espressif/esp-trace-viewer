/**
 * End-to-end tests for the Statistics workspace.
 *
 * Tests rendering of context statistics (cores, priority, stack size, run count, classification),
 * column header sorting, context selection synchronization with the store, the scope selector
 * re-aggregating over the visible window, the context-type selector, and the action that returns to the
 * timeline with the selected context's lane on screen.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle, VISUAL_ENABLED } from "./helpers.js";

const PANE = '[data-pane="statistics"]';

/** Load a fixture and switch to the Statistics workspace. */
async function openStatistics(page: Page, fixture: string): Promise<void> {
  await openFixture(page, fixture);
  await page.getByTestId("workspace-statistics").click();
  await settle(page);
}

/** Locate the rendered row for a context key. */
function row(page: Page, key: string) {
  return page.getByTestId("ctx-body").locator(`[data-context-key="${key}"]`);
}

/** Node identifiers of the bands the timeline is drawing. */
async function bandIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const intro = window.__traceViewer!.panes["timeline"]!() as unknown as { bands: { id: string }[] };
    return intro.bands.map((b) => b.id);
  });
}

/** The data-context-key of every body row, in render order. */
async function rowOrder(page: Page): Promise<string[]> {
  return page.getByTestId("ctx-body").locator(".ctx-row").evaluateAll((rows) =>
    rows.map((r) => r.getAttribute("data-context-key") ?? ""),
  );
}

test("renders per-context run-time stats with type and parser detail", async ({ page }) => {
  await openStatistics(page, "dualcore");

  // tcpip: a task with svTaskInfo/svStackInfo detail and a stable run count.
  const ip = row(page, "tcpip");
  await expect(ip.locator(".ctx-c-type")).toHaveText("Task");
  await expect(ip.locator(".ctx-c-runCount")).toHaveText("1188");
  await expect(ip.locator(".ctx-c-priority")).toHaveText("18");
  await expect(ip.locator(".ctx-c-cores")).toHaveText("0/1"); // tcpip migrates between the two cores
  await expect(ip.locator(".ctx-c-totalRunTime")).toContainText("ms");

  // Idle and interrupt contexts are classified distinctly.
  await expect(row(page, "IDLE0").locator(".ctx-c-type")).toHaveText("Idle");
  await expect(row(page, "SysTick").locator(".ctx-c-type")).toHaveText("ISR");
  await expect(row(page, "SysTick").locator(".ctx-c-runCount")).toHaveText("9006");
});

test("clicking a column header reorders the rows", async ({ page }) => {
  await openStatistics(page, "dualcore");

  // Default sort is Total Run descending → the idle context (most total time) leads.
  expect((await rowOrder(page))[0]).toBe("IDLE0");

  // Sort by Context ascending → alphabetical, a different leader.
  await page.locator(`${PANE} .ctx-head .ctx-c-label`).click();
  const byName = await rowOrder(page);
  expect(byName[0]).toBe("control");
  // The header sorts with localeCompare, which is case-insensitive — not the
  // code-point order a bare Array.sort() would give on these mixed-case names.
  expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));

  // Sort by Run Count ascending (second click flips from the default desc).
  const runCountHead = page.locator(`${PANE} .ctx-head .ctx-c-runCount`);
  await runCountHead.click();
  await runCountHead.click();
  expect((await rowOrder(page))[0]).toBe("ipc0"); // the fewest-runs context
});

test("selecting a row writes selectedContext into the shared store", async ({ page }) => {
  await openStatistics(page, "dualcore");
  expect((await getState(page)).selectedContext).toBeNull();

  await row(page, "tcpip").click();
  expect((await getState(page)).selectedContext).toBe("tcpip");
  await expect(row(page, "tcpip")).toHaveClass(/is-selected/);

  // Clicking the selected row again clears the selection.
  await row(page, "tcpip").click();
  expect((await getState(page)).selectedContext).toBeNull();
});

test("the scope selector re-aggregates over the visible window", async ({ page }) => {
  await openFixture(page, "dualcore");

  // Zoom to a 1 s window on the Timeline, then read the table under each scope.
  await page.selectOption(".tb-zoom", { index: 1 }); // "1 s"
  await settle(page);
  await page.getByTestId("workspace-statistics").click();
  await settle(page);

  await page.getByTestId("stats-scope").selectOption("full");
  const whole = await row(page, "IDLE0").locator(".ctx-c-runCount").innerText();

  await page.getByTestId("stats-scope").selectOption("visible");
  const windowed = await row(page, "IDLE0").locator(".ctx-c-runCount").innerText();

  expect(Number(windowed)).toBeGreaterThan(0);
  expect(Number(windowed)).toBeLessThan(Number(whole)); // fewer runs in the window
});

test("the workspace keeps its own scope, independent of the Events dock", async ({ page }) => {
  await openFixture(page, "dualcore");
  await page.getByTestId("dock-scope").selectOption("full");

  await page.getByTestId("workspace-statistics").click();
  await settle(page);
  await expect(page.getByTestId("stats-scope")).toHaveValue("visible");

  await page.getByTestId("stats-scope").selectOption("selection");
  await page.getByTestId("workspace-timeline").click();
  await expect(page.getByTestId("dock-scope")).toHaveValue("full");
});

test("the context-type selector narrows the table to one kind of context", async ({ page }) => {
  await openStatistics(page, "dualcore");
  const all = await rowOrder(page);
  expect(all).toContain("tcpip");
  expect(all).toContain("SysTick");

  await page.getByTestId("stats-type").selectOption("ISR");
  const isrs = await rowOrder(page);
  expect(isrs.length).toBeGreaterThan(0);
  expect(isrs.length).toBeLessThan(all.length);
  expect(isrs).toContain("SysTick");
  expect(isrs).not.toContain("tcpip");
  for (const key of isrs) await expect(row(page, key).locator(".ctx-c-type")).toHaveText("ISR");

  await page.getByTestId("stats-type").selectOption("all");
  expect(await rowOrder(page)).toEqual(all);
});

test("clicking a Max run figure zooms the timeline to that run", async ({ page }) => {
  await openFixture(page, "dualcore");
  // Switch the Tasks quick filter off so the action has something to undo on the way back.
  await page.getByTestId("filter-tasks").click();
  await page.getByTestId("workspace-statistics").click();
  await settle(page);

  const before = await getState(page);
  await page.getByTestId("stats-locate-tcpip").click();
  await settle(page);

  const after = await getState(page);
  expect(after.selectedContext).toBe("tcpip");
  await expect(page.getByTestId("workspace-timeline")).toHaveAttribute("aria-selected", "true");
  // The window narrowed onto one run, and the lane the quick filter had switched off is drawn again.
  expect(after.view.t1 - after.view.t0).toBeLessThan(before.view.t1 - before.view.t0);
  expect(await bandIds(page)).toContain("c:tcpip");
});

test("visual: statistics table — whole-trace stats (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openStatistics(page, "dualcore");
  await expect(page.locator(PANE)).toHaveScreenshot("statistics-dualcore.png");
});
