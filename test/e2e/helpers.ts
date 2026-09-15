/**
 * Shared Playwright helpers for the viewer harness.
 *
 * Provides common fixtures and routines for end-to-end tests: initializing the app,
 * loading fixtures, waiting for render completion, and reading the `window.__traceViewer`
 * test introspection API.
 */

import { type Page } from "@playwright/test";
import type { StateSnapshot, ViewSnapshot } from "../../web/core/test-api.js";

/**
 * Whether visual (screenshot) assertions run in this environment. The canonical
 * baselines are the Linux ones generated in the pinned Playwright image, so a
 * macOS host would diff purely on rasterization. Visual specs therefore skip
 * off-Linux unless `TRACE_VIEWER_FORCE_VISUAL` is set; run them via
 * `npm run test:e2e:docker`. DOM/introspection specs always run.
 */
export const VISUAL_ENABLED = process.platform === "linux" || !!process.env["TRACE_VIEWER_FORCE_VISUAL"];

/** Navigate to a route and wait until the guarded test API is attached. */
export async function gotoApp(page: Page, route = "/"): Promise<void> {
  await page.goto(route);
  await page.waitForFunction(() => Boolean(window.__traceViewer));
}

/** Wait for fonts + a quiesced rAF loop, so nothing is captured mid-frame. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => window.__traceViewer!.whenSettled());
}

/**
 * Boot the app and deterministically load a committed fixture by name
 * (`dualcore`, `unicore`, `p4-mcore`, …), then wait until rendering settles.
 */
export async function openFixture(page: Page, name: string): Promise<void> {
  await gotoApp(page);
  await page.evaluate((n) => window.__traceViewer!.loadFixture(n), name);
  await settle(page);
}

/**
 * Boot the app, load a fixture, and bring the Logs list to the front of the dock.
 *
 * The dock shows one list at a time, so a Logs assertion has to select its tab first.
 */
export async function openLogs(page: Page, name: string): Promise<void> {
  await openFixture(page, name);
  await page.getByTestId("dock-tab-logs").click();
  await settle(page);
}

/** Boot the app with no trace and dismiss the welcome modal that opens over it. */
export async function gotoEmptyApp(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByTestId("welcome-close").click();
  await page.getByTestId("welcome-modal").waitFor({ state: "hidden" });
}

/** Open a `.svdat` file through the real Open picker (the `.svdat` file input). */
export async function openSvdatFile(page: Page, path: string): Promise<void> {
  await page.locator('input[accept=".svdat"]').setInputFiles(path);
  // The picker handler reads the file asynchronously before publishing the model.
  // Wait for the model to load into the store before settling.
  await page.waitForFunction(() => window.__traceViewer!.state().eventCount > 0);
  await settle(page);
}

/**
 * Offer an ELF the open capture disowns through the toolbar picker, and wait for the refusal.
 *
 * {@link loadElfFile} waits for the file to land in the store, which never happens here.
 */
export async function rejectElfFile(page: Page, path: string): Promise<void> {
  await page.locator('input[accept=".elf"]').setInputFiles(path);
  await page.waitForFunction(() => window.__traceViewer!.state().loadError !== null);
  await settle(page);
}

/** Load an application ELF through the toolbar ELF picker. */
export async function loadElfFile(page: Page, path: string): Promise<void> {
  await page.locator('input[accept=".elf"]').setInputFiles(path);
  // loadElf parses and hashes the bytes asynchronously off the rAF loop.
  // Wait until the ELF is recorded in the store before settling.
  const name = path.split("/").pop()!;
  await page.waitForFunction((n) => window.__traceViewer!.state().elf?.name === n, name);
  await settle(page);
}

/** Read a serializable snapshot of the shared store. */
export async function getState(page: Page): Promise<StateSnapshot> {
  return page.evaluate(() => window.__traceViewer!.state());
}

/** Read a serializable snapshot of the shared time scale. */
export async function getView(page: Page): Promise<ViewSnapshot> {
  return page.evaluate(() => window.__traceViewer!.view());
}

/** Read a canvas pane's current visible trace-time window. */
export async function paneWindow(page: Page, id: string): Promise<{ t0: number; t1: number }> {
  return page.evaluate((paneId) => window.__traceViewer!.panes[paneId]!().visibleWindow, id);
}

/** One flattened timeline lane band, as the timeline introspection reports it. */
export interface TimelineBand {
  id: string;
  kind: "group-header" | "lane";
  type: string;
  label: string;
  /** Group this band opens, or null when it does not open one. Group labels ride on their first lane. */
  groupId: string | null;
  /** Label of that group, or null. */
  groupLabel: string | null;
}

/** Group labels in draw order, as the gutter announces them down the lane list. */
export async function timelineGroups(page: Page): Promise<string[]> {
  const bands = await timelineBands(page);
  return bands.map((b) => b.groupLabel).filter((l): l is string => l !== null);
}

/** The timeline's flattened lane bands (groups + lanes), in draw order. */
export async function timelineBands(page: Page): Promise<TimelineBand[]> {
  return page.evaluate(
    () => (window.__traceViewer!.panes["timeline"]!() as unknown as { bands: TimelineBand[] }).bands,
  );
}

/**
 * Scroll the timeline lane area to the bottom, so lanes below the activity
 * groups (the CPU-load and Data lanes) are in view for a screenshot. Clamps at
 * the content end, so a large shift-wheel is deterministic; a no-op when the
 * lanes already fit.
 */
export async function scrollTimelineToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = document.querySelector('[data-pane="timeline"] canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      c.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 1200, shiftKey: true, clientX: r.left + 60, clientY: r.top + 60, bubbles: true, cancelable: true }),
      );
    }
  });
  await settle(page);
}

/**
 * Event-index range covering a dense ~4 ms activity cluster in the dual-core
 * demo capture, containing runs across contexts and API/log marks. Used for
 * consistent visual baseline framing across specs.
 */
export const EVENT_CLUSTER = { from: 13183, to: 13672 } as const;

/** Frame {@link EVENT_CLUSTER} across every time-aligned pane, then settle. */
export async function zoomToEventCluster(page: Page): Promise<void> {
  await page.evaluate((c) => window.__traceViewer!.zoomToEventRange(c.from, c.to), EVENT_CLUSTER);
  await settle(page);
}
