/**
 * End-to-end tests for lane interaction behavior.
 *
 * Asserts gutter drag-to-resize, vertical scrolling during pane overflow,
 * and multi-core Unified track rendering.
 */

import { expect, test } from "@playwright/test";
import { gotoApp, openFixture, settle, VISUAL_ENABLED } from "./helpers.js";

/** Row height activity lanes take at the default Lanes-panel density. */
const DEFAULT_ROW_H = 20;

const CANVAS = '[data-pane="timeline"] canvas';

/** The lane-tree facts these specs read off the timeline introspection. */
interface LaneInfo {
  unifiedCount: number;
  contextLanes: number;
  hiddenLaneCount: number;
  unifiedLabels: string[];
}

const laneInfo = (page: import("@playwright/test").Page): Promise<LaneInfo> =>
  page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as {
      bands: Band[];
      lanes: { key: string }[];
      unifiedCount: number;
      hiddenLaneCount: number;
    };
    return {
      unifiedCount: tl.unifiedCount,
      contextLanes: tl.lanes.length,
      hiddenLaneCount: tl.hiddenLaneCount,
      unifiedLabels: tl.bands.filter((b) => b.source?.kind === "unified").map((b) => b.label),
    };
  });

interface Band {
  id: string;
  kind: "group-header" | "lane";
  depth: number;
  height: number;
  centerY: number;
  label: string;
  source: { kind: "unified"; coreId: number } | { kind: "context"; key: string } | null;
}

/** Returns the first two context-lane bands with gutter x positions at their indent. */
async function firstTwoContextLanes(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as { bands: Band[] };
    const ctx = tl.bands.filter((b) => b.kind === "lane" && b.source?.kind === "context");
    const at = (b: Band) => ({
      key: (b.source as { kind: "context"; key: string }).key,
      gutterX: b.depth * 12 + 60, // over the label, clear of checkbox/swatch
      centerY: b.centerY,
      bottomY: b.centerY + b.height / 2 - 2, // the resize grip
      height: b.height,
    });
    return { a: at(ctx[0]!), b: at(ctx[1]!) };
  });
}

// Lane reordering is configured in the Lanes editor; drag interactions are covered in
// lane-config-panel.spec.ts. The gutter retains resize, collapse, and scroll actions.

test("drag the bottom grip of a lane to resize it", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;
  const { a } = await firstTwoContextLanes(page);
  expect(a.height).toBe(DEFAULT_ROW_H); // the density the Lanes panel starts at

  // Drag the lane's bottom edge down by 40 px.
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY);
  await page.mouse.down();
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY + 40, { steps: 10 });
  await page.mouse.up();
  await settle(page);

  const height = await page.evaluate((key) => {
    const b = (window.__traceViewer!.panes["timeline"]!() as unknown as { bands: Band[]; lanes: { key: string; label: string }[]; scrollTop: number; contentHeight: number; viewportHeight: number }).bands.find(
      (bb) => bb.kind === "lane" && (bb.source as { key?: string }).key === key,
    )!;
    return b.height;
  }, a.key);
  expect(height).toBeGreaterThan(DEFAULT_ROW_H + 33); // the drag distance, allowing for grip offset
  expect(height).toBeLessThan(DEFAULT_ROW_H + 48);

  // The new height is persisted on the lane node, not just the view.
  const persisted = await page.evaluate((key) => {
    const find = (nodes: any[]): any =>
      nodes.reduce((hit, n) => hit ?? (n.source?.key === key ? n : n.children ? find(n.children) : null), null);
    return find(window.__traceViewer!.state().laneLayout.roots as any[])?.height ?? null;
  }, a.key);
  expect(persisted).toBeGreaterThan(55);
});

test("hovering a lane's bottom edge shows a resize cursor", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;
  const { a } = await firstTwoContextLanes(page);

  // Mid-lane: the default cursor; over the gutter bottom edge: row-resize.
  await page.mouse.move(box.x + a.gutterX, box.y + a.centerY);
  expect(await page.locator(CANVAS).evaluate((el) => getComputedStyle(el).cursor)).not.toBe("row-resize");
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY);
  expect(await page.locator(CANVAS).evaluate((el) => getComputedStyle(el).cursor)).toBe("row-resize");
});

test("double-clicking the resize grip resets a lane to its default height", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;
  const { a } = await firstTwoContextLanes(page);

  // Grow the lane well past its default row height.
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY);
  await page.mouse.down();
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY + 40, { steps: 8 });
  await page.mouse.up();
  await settle(page);

  // The grip moved down with the lane; double-click it to reset.
  const grip = await page.evaluate((key) => {
    const b = (window.__traceViewer!.panes["timeline"]!() as unknown as { bands: Band[] }).bands.find(
      (bb) => bb.kind === "lane" && (bb.source as { key?: string }).key === key,
    )!;
    return { x: 40, y: b.centerY + b.height / 2 - 2 }; // x in the gutter, y on the grip
  }, a.key);
  await page.mouse.dblclick(box.x + grip.x, box.y + grip.y);
  await settle(page);

  const height = await page.evaluate((key) => {
    const b = (window.__traceViewer!.panes["timeline"]!() as unknown as { bands: Band[] }).bands.find(
      (bb) => bb.kind === "lane" && (bb.source as { key?: string }).key === key,
    )!;
    return b.height;
  }, a.key);
  expect(height).toBe(DEFAULT_ROW_H); // back to the density default

  // The override was cleared from the node (not just set back).
  const persisted = await page.evaluate((key) => {
    const find = (nodes: any[]): any =>
      nodes.reduce((hit, n) => hit ?? (n.source?.key === key ? n : n.children ? find(n.children) : null), null);
    return find(window.__traceViewer!.state().laneLayout.roots as any[])?.height ?? null;
  }, a.key);
  expect(persisted).toBeNull();
});

test("scrolls vertically when the lanes overflow the pane", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;
  const { a } = await firstTwoContextLanes(page);

  // Force overflow by growing one lane far past the viewport.
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY);
  await page.mouse.down();
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY + 500, { steps: 12 });
  await page.mouse.up();
  await settle(page);

  const overflow = await page.evaluate(() => {
    const tl = (window.__traceViewer!.panes["timeline"]!() as unknown as { bands: Band[]; lanes: { key: string; label: string }[]; scrollTop: number; contentHeight: number; viewportHeight: number });
    return { content: tl.contentHeight, viewport: tl.viewportHeight, scroll: tl.scrollTop };
  });
  expect(overflow.content).toBeGreaterThan(overflow.viewport);
  expect(overflow.scroll).toBe(0);

  // Shift-wheel over the lane area scrolls it vertically.
  await page.evaluate(() => {
    const c = document.querySelector('[data-pane="timeline"] canvas')!;
    c.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await settle(page);

  const scrolled = await page.evaluate(() => (window.__traceViewer!.panes["timeline"]!() as unknown as { bands: Band[]; lanes: { key: string; label: string }[]; scrollTop: number; contentHeight: number; viewportHeight: number }).scrollTop);
  expect(scrolled).toBeGreaterThan(0);
});

test("multicore: a Unified track per core, each labelled by its core", async ({ page }) => {
  await openFixture(page, "p4-mcore");
  const info = await laneInfo(page);
  expect(info.unifiedCount).toBe(2);
  expect(info.unifiedLabels).toEqual(["Unified (core 0)", "Unified (core 1)"]);
  expect(info.contextLanes).toBeGreaterThan(0);
});

// Visual baselines (Linux/Docker only)

test("visual: a resized (tall) lane in the timeline", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;
  const { a } = await firstTwoContextLanes(page);
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY);
  await page.mouse.down();
  await page.mouse.move(box.x + a.gutterX, box.y + a.bottomY + 60, { steps: 10 });
  await page.mouse.up();
  await settle(page);
  await expect(page.locator(CANVAS)).toHaveScreenshot("lanes-resized.png");
});

test("visual: a collapsed Task group in the timeline", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  // A group's label rides on its first lane rather than taking a header row of its own, so the timeline
  // has no caret to click: collapsing is the Lanes panel's job.
  await page.getByTestId("toggle-lanes").click();
  await page.getByTestId("lane-caret-g:tasks").click();
  await page.getByTestId("toggle-lanes").click();
  await settle(page);
  await expect(page.locator(CANVAS)).toHaveScreenshot("lanes-collapsed-group.png");
});

test("visual: the multicore timeline with two Unified tracks (P4)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "p4-mcore");
  await settle(page);
  await expect(page.locator(CANVAS)).toHaveScreenshot("timeline-multicore.png");
});
