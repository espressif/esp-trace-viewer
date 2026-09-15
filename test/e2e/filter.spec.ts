/**
 * End-to-end tests for the Event Filter subsystem.
 *
 * Tests Filter menu controls and keyboard shortcuts, verifying filter effects
 * on Events list row counts, timeline visibility, and store state.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle, VISUAL_ENABLED } from "./helpers.js";

/** Total rows the Events virtualizer is sizing the scrollbar for. */
async function totalRows(page: Page): Promise<number> {
  return Number(await page.getByTestId("events-scroll").getAttribute("data-total-rows"));
}

/** The timeline pane's data-layer introspection (hidden classes). */
async function timeline(page: Page): Promise<{ hiddenClasses: string[] }> {
  return page.evaluate(() => {
    const intro = window.__traceViewer!.panes["timeline"]!() as unknown as { hiddenClasses: string[] };
    return { hiddenClasses: intro.hiddenClasses };
  });
}

/** Open the Filter dropdown and choose an item by its test id. */
async function chooseMenu(page: Page, itemTestId: string): Promise<void> {
  await page.getByTestId("menu-classes").click();
  await page.getByTestId(itemTestId).click();
}

test("toggling a class hides it from the Events list and the timeline", async ({ page }) => {
  await openFixture(page, "dualcore");
  expect(await totalRows(page)).toBe(164703);
  expect((await timeline(page)).hiddenClasses).toEqual([]);

  // Hide ISRs via the menu.
  await chooseMenu(page, "menu-show-isr");
  expect((await getState(page)).filters.classes).toContain("isr");

  // The Events table now sizes for fewer rows, and the timeline drops ISR bars.
  const filtered = await totalRows(page);
  expect(filtered).toBeGreaterThan(0);
  expect(filtered).toBeLessThan(164703);
  expect((await timeline(page)).hiddenClasses).toContain("isr");

  // Reset restores the full set everywhere.
  await chooseMenu(page, "menu-reset");
  expect((await getState(page)).filters.classes).toEqual([]);
  expect(await totalRows(page)).toBe(164703);
  expect((await timeline(page)).hiddenClasses).toEqual([]);
});

test("the Show … only accelerator solos a class; ⌥Space resets", async ({ page }) => {
  await openFixture(page, "dualcore");

  // ⌥⌘T → show only Tasks (every other class hidden).
  await page.keyboard.press("Alt+Meta+KeyT");
  const solo = (await getState(page)).filters.classes;
  expect(solo).not.toContain("task");
  expect(solo).toContain("isr");
  expect(solo.length).toBe(5);
  const soloed = await totalRows(page);
  expect(soloed).toBeGreaterThan(0);
  expect(soloed).toBeLessThan(164703);

  // ⌥Space → Reset All Filters.
  await page.keyboard.press("Alt+Space");
  expect((await getState(page)).filters.classes).toEqual([]);
  expect(await totalRows(page)).toBe(164703);
});

test("the menu reflects the live hidden/checked state", async ({ page }) => {
  await openFixture(page, "dualcore");
  // Hide ISRs, reopen the menu: the row is now unchecked.
  await chooseMenu(page, "menu-show-isr");
  await page.getByTestId("menu-classes").click();
  await expect(page.getByTestId("menu-show-isr")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("menu-show-task")).toHaveAttribute("aria-checked", "true");
});

test("loading a trace derives the display resolution from the timer frequency", async ({ page }) => {
  await openFixture(page, "dualcore");
  // The readout precision is derived from the trace's reported sysFreq.
  expect((await getState(page)).timeResolution).toBeGreaterThan(0);
  await expect(page.getByTestId("tb-res-select")).toHaveCount(0);
});

test("visual: filtered state with ISRs hidden (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await chooseMenu(page, "menu-show-isr");
  await settle(page);
  await expect(page).toHaveScreenshot("filter-isr-hidden.png", { maxDiffPixelRatio: 0.02 });
});
