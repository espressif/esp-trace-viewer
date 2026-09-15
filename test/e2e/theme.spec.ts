/**
 * End-to-end tests for theme toggling behavior.
 *
 * Verifies that switching themes repaints canvas-backed panes with the updated palette, by sampling pixel
 * luminance from the top of the timeline canvas, and that the three-way choice behaves: auto follows the
 * system as it changes, an explicit light or dark ignores it, and the cycle returns to auto.
 */

import { expect, test } from "@playwright/test";
import { settle } from "./helpers.js";

/** Read one device pixel (r,g,b) from the named pane's canvas. */
async function canvasPixel(
  page: import("@playwright/test").Page,
  pane: string,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  return page.evaluate(
    ({ pane, x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(`[data-pane="${pane}"] canvas`);
      const ctx = canvas?.getContext("2d");
      if (!ctx) throw new Error(`no canvas for pane ${pane}`);
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    { pane, x, y },
  );
}

/** Mean channel value — a cheap proxy for "how light is this pixel". */
const luma = ([r, g, b]: [number, number, number]): number => (r + g + b) / 3;

/** The theme the root element is painted in. */
const painted = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

/** The choice the toolbar button is currently offering. */
const choice = (page: import("@playwright/test").Page) =>
  page.getByTestId("tb-theme").getAttribute("data-theme-choice");

test("choosing a theme repaints the timeline canvas", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?fixture=dualcore");
  await expect(page.getByTestId("sb-events")).toContainText("164 703");
  await settle(page);

  // The strip along the top of the canvas, away from the density curve and the tick marks.
  const light = await canvasPixel(page, "timeline", 2, 2);
  expect(luma(light)).toBeGreaterThan(180);

  // Starting from auto, one click is light and the second is dark.
  expect(await choice(page)).toBe("auto");
  await page.getByTestId("tb-theme").click();
  await page.getByTestId("tb-theme").click();
  await settle(page);

  expect(await choice(page)).toBe("dark");
  const dark = await canvasPixel(page, "timeline", 2, 2);
  expect(luma(dark)).toBeLessThan(120);
});

test("the choice cycles back to auto, which follows the system again", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?fixture=dualcore");
  await settle(page);

  // auto → light → dark → auto, so an explicit choice is never a one-way door.
  expect(await choice(page)).toBe("auto");
  for (const want of ["light", "dark", "auto"]) {
    await page.getByTestId("tb-theme").click();
    expect(await choice(page)).toBe(want);
  }

  // Back on auto, the system's preference drives the paint again — without a reload.
  expect(await painted(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => painted(page)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => painted(page)).toBe("light");
});

test("an explicit choice survives a reload and ignores the system", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?fixture=dualcore");
  await settle(page);

  await page.getByTestId("tb-theme").click(); // auto → light
  await page.getByTestId("tb-theme").click(); // light → dark
  expect(await painted(page)).toBe("dark");

  await page.reload();
  await settle(page);
  expect(await choice(page)).toBe("dark");
  expect(await painted(page)).toBe("dark");

  // The system switching to light does not disturb an explicit dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  expect(await painted(page)).toBe("dark");
});
