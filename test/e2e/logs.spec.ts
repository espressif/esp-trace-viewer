/**
 * End-to-end tests for the Logs list pane.
 *
 * Asserts rendering of svPrint log lines, table column headers, virtual scrolling,
 * row selection synchronization, and visual appearance.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openLogs, settle, VISUAL_ENABLED } from "./helpers.js";

const ROW_H = 20;

/** Locate the rendered log line for an absolute event index. */
function line(page: Page, eventIndex: number) {
  return page.getByTestId("logs-body").locator(`[data-event-index="${eventIndex}"]`);
}

/** Set the Logs list's vertical scroll offset (fires the windowing render). */
async function scrollLogsTo(page: Page, top: number): Promise<void> {
  await page.getByTestId("logs-scroll").evaluate((el, t) => {
    (el as HTMLElement).scrollTop = t;
  }, top);
}

test("renders log lines with the decoded timestamp/context/message", async ({ page }) => {
  await openLogs(page, "dualcore");

  // Header labels.
  const head = page.locator('[data-pane="logs"] .logs-head');
  await expect(head.locator(".logs-ts")).toHaveText("Timestamp");
  await expect(head.locator(".logs-ctx")).toHaveText("Context");
  await expect(head.locator(".logs-msg")).toHaveText("Message");

  // First log line in the trace (absolute event index 3008).
  const first = line(page, 3008);
  await expect(first.locator(".logs-ts")).toHaveText("573.744 ms");
  await expect(first.locator(".logs-ctx")).toHaveText("main");
  await expect(first.locator(".logs-msg")).toHaveText(
    "I (1396) esp_eth.netif.netif_glue: 32:ed:a0:ed:6d:d5",
  );
});

test("spans every log line on the scrollbar (the fixture logs 81 lines)", async ({ page }) => {
  await openLogs(page, "dualcore");
  await expect(page.getByTestId("logs-scroll")).toHaveAttribute("data-total-rows", "81");
  await expect(page.getByTestId("logs-body").locator(".logs-line").first()).toBeVisible();
});

test("shows a deeper line once scrolled to it (a DHCP lease log line)", async ({ page }) => {
  await openLogs(page, "dualcore");
  // Line 18 of 81 from the sys_evt task (event index 19865).
  await scrollLogsTo(page, 14 * ROW_H);
  await expect(line(page, 19865).locator(".logs-ctx")).toHaveText("sys_evt");
  await expect(line(page, 19865).locator(".logs-msg")).toContainText("eth ip: 192.168.33.108");
});

test("clicking a line selects its source event index", async ({ page }) => {
  await openLogs(page, "dualcore");
  await line(page, 3008).click();
  expect((await getState(page)).selectedEventIndex).toBe(3008);
  await expect(line(page, 3008)).toHaveClass(/is-selected/);
});

test("visual: terminal pane with the dual-core demo log output", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openLogs(page, "dualcore");
  await expect(line(page, 3008)).toBeVisible();
  await settle(page);
  await expect(page.locator('[data-pane="logs"]')).toHaveScreenshot("terminal-dualcore.png");
});
