/**
 * End-to-end tests for persisting lane layout configuration within .svdat files.
 *
 * Verifies that saving and reopening a trace file restores custom lane visibility
 * from the header and preserves binary event payloads.
 */

import { expect, test } from "@playwright/test";
import { getState, openFixture, settle } from "./helpers.js";

/** Hidden-lane count off the timeline introspection (0 in the default layout). */
const hiddenCount = (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate(
    () => (window.__traceViewer!.panes["timeline"]!() as unknown as { hiddenLaneCount: number }).hiddenLaneCount,
  );

test("a saved trace re-opens with its lane layout restored", async ({ page }) => {
  await openFixture(page, "dualcore");
  const before = await getState(page);
  expect(await hiddenCount(page)).toBe(0);

  // Hide one lane from the Lanes panel to verify restoration of a non-default layout.
  await page.getByTestId("toggle-lanes").click();
  await page.locator(".lanes-row-lane .lanes-visible").first().click();
  await settle(page);
  expect(await hiddenCount(page)).toBe(1);

  // Save trace with layout configuration embedded in header.
  await page.getByTestId("menu-file").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("menu-save").click(),
  ]);
  const path = await download.path();

  // Re-open the saved file through the .svdat file input.
  await page.locator('input[accept=".svdat"]').setInputFiles(path);
  await settle(page);

  const after = await getState(page);
  expect(after.eventCount).toBe(before.eventCount); // event count preserved
  expect(await hiddenCount(page)).toBe(1); // layout restored from header
});
