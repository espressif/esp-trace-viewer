/**
 * End-to-end tests for inline function traces within task lanes.
 *
 * Asserts preview and expanded flame graph modes for instrumented tasks in the
 * timeline gutter disclosure and the Lanes configuration panel.
 */

import { expect, test, type Page } from "@playwright/test";

/** Row height activity lanes take at the default Lanes-panel density. */
const DEFAULT_ROW_H = 20;
import { openFixture, settle, VISUAL_ENABLED } from "./helpers.js";

const CANVAS = '[data-pane="timeline"] canvas';

/**
 * Event-index range spanning nested function calls in the dsp task.
 */
const DSP_CALL = { from: 62_650, to: 62_800 } as const;

/** What the timeline reports about a context's inline function trace. */
interface FuncTraceProbe {
  count: number;
  maxDepth: number;
  mode: "off" | "peek" | "expanded";
  bandId: string | null;
  bandHeight: number;
}

const probe = async (page: Page, key: string): Promise<FuncTraceProbe | null> =>
  page.evaluate(
    (k) =>
      (
        window.__traceViewer!.panes["timeline"]!() as unknown as {
          funcTraceProbe: (key: string) => FuncTraceProbe | null;
        }
      ).funcTraceProbe(k),
    key,
  );

/**
 * Scrolls the lane area so the top of the specified band is positioned `offset` pixels below the ruler.
 */
async function scrollBandIntoView(page: Page, bandId: string, offset = 24): Promise<void> {
  await page.evaluate(
    ({ id, off }) => {
      const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
        bands: { id: string; top: number }[];
        scrollTop: number;
      };
      const band = tl.bands.find((b) => b.id === id)!;
      const c = document.querySelector('[data-pane="timeline"] canvas') as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      c.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: band.top - tl.scrollTop - off,
          shiftKey: true,
          clientX: r.left + 60,
          clientY: r.top + 60,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { id: bandId, off: offset },
  );
  await settle(page);
}

/**
 * Clicks the gutter inline function-trace disclosure for a lane band,
 * targeting the band label row near the top.
 */
async function clickDisclosure(page: Page, bandId: string): Promise<void> {
  const geom = await page.evaluate((id) => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      bands: { id: string; top: number }[];
      contentTop: number;
      scrollTop: number;
      gutterWidth: number;
      funcTraceToggleX: number;
    };
    const band = tl.bands.find((b) => b.id === id)!;
    const c = document.querySelector('[data-pane="timeline"] canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    return {
      y: tl.contentTop + band.top - tl.scrollTop + 11,
      // Aim at the middle of the glyph the gutter actually drew.
      x: tl.funcTraceToggleX + 6,
      left: r.left,
      top: r.top,
    };
  }, bandId);
  await page.mouse.click(geom.left + geom.x, geom.top + geom.y);
  await settle(page);
}

test("an instrumented task lane previews its function trace in the run bars", async ({ page }) => {
  await openFixture(page, "unicore");
  const dsp = await probe(page, "dsp");
  expect(dsp).not.toBeNull();
  expect(dsp!.count).toBeGreaterThan(100);
  // Instrumented task defaults to peek mode with standard row height.
  expect(dsp!.mode).toBe("peek");
  expect(dsp!.bandHeight).toBe(DEFAULT_ROW_H);

  // An uninstrumented task has no inline trace.
  expect(await probe(page, "httpd")).toBeNull();
});

test("the gutter disclosure expands the lane into its flame graph", async ({ page }) => {
  await openFixture(page, "unicore");
  const dsp = (await probe(page, "dsp"))!;

  await clickDisclosure(page, dsp.bandId!);
  const expanded = (await probe(page, "dsp"))!;
  expect(expanded.mode).toBe("expanded");
  // Height accommodates the activity strip and stack depth levels.
  expect(expanded.bandHeight).toBeGreaterThan(DEFAULT_ROW_H + expanded.maxDepth * 12);

  await clickDisclosure(page, dsp.bandId!);
  expect((await probe(page, "dsp"))!.mode).toBe("peek");
});

test("the Lanes editor toggle mirrors the gutter disclosure", async ({ page }) => {
  await openFixture(page, "unicore");
  await page.getByTestId("toggle-lanes").click();
  await expect(page.getByTestId("lanes-list")).toBeVisible();
  const button = page.getByTestId("lane-functrace-c:dsp");
  await expect(button).toHaveAttribute("data-mode", "peek");
  await button.click();
  await expect(button).toHaveAttribute("data-mode", "expanded");
  // State matches the timeline probe report.
  expect((await probe(page, "dsp"))!.mode).toBe("expanded");
  await button.click();
  await expect(button).toHaveAttribute("data-mode", "peek");
});

test("visual: the coarse in-bar preview inside the dsp run bars", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "unicore");
  await page.evaluate((w) => window.__traceViewer!.zoomToEventRange(w.from, w.to), DSP_CALL);
  const dsp = (await probe(page, "dsp"))!;
  await scrollBandIntoView(page, dsp.bandId!);
  await expect(page.locator(CANVAS)).toHaveScreenshot("inline-functrace-peek.png");
});

test("visual: the dsp lane expanded into its flame graph", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "unicore");
  await page.evaluate((w) => window.__traceViewer!.zoomToEventRange(w.from, w.to), DSP_CALL);
  const dsp = (await probe(page, "dsp"))!;
  await scrollBandIntoView(page, dsp.bandId!);
  await clickDisclosure(page, dsp.bandId!);
  await scrollBandIntoView(page, dsp.bandId!); // re-align after lane expansion
  await expect(page.locator(CANVAS)).toHaveScreenshot("inline-functrace-expanded.png");
});
