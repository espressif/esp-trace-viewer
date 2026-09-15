/**
 * End-to-end tests for the Lanes configuration side panel.
 *
 * Asserts lane tree mutations from the panel DOM (toggle, add/remove, hide, rename,
 * drag-and-drop and button reordering, grouping, and ungrouping) against panel DOM state,
 * application state (`state().laneLayout`), and rendered timeline bands.
 */

import { expect, test, type Page } from "@playwright/test";
import { getState, openFixture, settle, VISUAL_ENABLED } from "./helpers.js";

/** A laid-out timeline band, as its introspection reports it. */
interface Band {
  id: string;
  kind: "group-header" | "lane";
  label: string;
  groupId: string | null;
  groupLabel: string | null;
  source: { kind: "unified"; coreId: number } | { kind: "context"; key: string } | null;
}

declare global {
  interface Window {
    __tlbands?: { bands: Band[]; lanes: { key: string; label: string }[]; hiddenLaneCount: number };
  }
}

const bands = (page: Page) =>
  page.evaluate(() => window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tlbands"]>);

/** Opens the Lanes panel via the toolbar toggle and waits for visibility. */
async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("toggle-lanes").click();
  await expect(page.locator('[data-pane="lanes"]')).not.toHaveClass(/is-collapsed/);
  await expect(page.getByTestId("lanes-list")).toBeVisible();
}

test("the timeline corner toggle opens and closes the panel, reflecting its pressed state", async ({ page }) => {
  await openFixture(page, "dualcore");
  const toggle = page.getByTestId("toggle-lanes");
  const panel = page.locator('[data-pane="lanes"]');

  // Closed by default.
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(panel).toHaveClass(/is-collapsed/);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(panel).not.toHaveClass(/is-collapsed/);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(panel).toHaveClass(/is-collapsed/);
});

test("rows mirror the lane tree: a Unified lane, a Tasks group, the context lanes", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  // The Unified track and the Tasks group render as rows.
  await expect(page.getByTestId("lane-row-u:0")).toBeVisible();
  await expect(page.getByTestId("lane-row-g:tasks")).toBeVisible();
  await expect(page.getByTestId("lane-label-g:tasks")).toHaveText("Task");

  // One row per visible node: collapsed groups omit child rows.
  const expected = await page.evaluate(() => {
    const count = (nodes: any[]): number =>
      nodes.reduce(
        (n, x) => n + 1 + (x.children && !x.collapsed ? count(x.children) : 0),
        0,
      );
    return count(window.__traceViewer!.state().laneLayout.roots as any[]);
  });
  await expect(page.locator('[data-lane-row]')).toHaveCount(expected);
});

test("adding a lane from the inline menu appears in the panel and the timeline", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  const before = (await bands(page)).bands.length;

  // The root "＋ New lane" row opens a source menu; pick the Unified track.
  await page.getByTestId("lane-add").click();
  await page.getByTestId("lane-add-opt-unified-core-0").click();

  // Appends a new root lane with an id derived from the source label.
  await expect(page.getByTestId("lane-row-timespan:unified-core-0")).toBeVisible();
  const after = await bands(page);
  expect(after.bands.length).toBe(before + 1);
  expect(after.bands.some((b) => b.id === "timespan:unified-core-0")).toBe(true);
});

test("a group's inline ＋ New lane adds into that group", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  // Adding a lane via a group action appends the lane inside that group.
  await page.getByTestId("lane-add-g:tasks").click();
  await page.getByTestId("lane-add-opt-unified-core-0").click();

  const inTasks = await page.evaluate(() => {
    const tasks = (window.__traceViewer!.state().laneLayout.roots as any[]).find((n) => n.id === "g:tasks");
    return (tasks?.children ?? []).some((c: any) => c.id === "timespan:unified-core-0");
  });
  expect(inTasks).toBe(true);
});

test("removing a lane removes it from the panel and the timeline", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  await expect(page.getByTestId("lane-row-c:tcpip")).toBeVisible();
  expect((await bands(page)).lanes.some((l) => l.key === "tcpip")).toBe(true);

  await page.getByTestId("lane-remove-c:tcpip").click();

  await expect(page.getByTestId("lane-row-c:tcpip")).toHaveCount(0);
  expect((await bands(page)).lanes.some((l) => l.key === "tcpip")).toBe(false);
  // Verifies removal from state.
  const present = await page.evaluate(() =>
    JSON.stringify(window.__traceViewer!.state().laneLayout).includes('"c:tcpip"'),
  );
  expect(present).toBe(false);
});

test("hiding a lane in the panel hides it in the timeline (shared state)", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  expect((await bands(page)).hiddenLaneCount).toBe(0);

  await page.getByTestId("lane-hide-c:tcpip").click();

  const after = await bands(page);
  expect(after.hiddenLaneCount).toBe(1);
  expect(after.lanes.some((l) => l.key === "tcpip")).toBe(false); // dropped from the host
  await expect(page.getByTestId("lane-row-c:tcpip")).toHaveClass(/is-hidden/);
});

test("renaming a group updates the tree and the timeline label", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  await page.getByTestId("lane-label-g:tasks").dblclick();
  const input = page.getByTestId("lane-rename-g:tasks");
  await input.fill("Threads");
  await input.press("Enter");

  await expect(page.getByTestId("lane-label-g:tasks")).toHaveText("Threads");
  // The group's label rides on its first lane, so that is where the new name shows up.
  const opener = (await bands(page)).bands.find((b) => b.groupId === "g:tasks");
  expect(opener?.groupLabel).toBe("Threads");
});

test("dragging a row's handle reorders it above another (panel ↔ timeline)", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  // The first two context lanes, in tree order.
  const ctx = (await bands(page)).lanes.map((l) => l.key);
  const [first, second] = [ctx[0]!, ctx[1]!];

  const handle = page.getByTestId(`lane-handle-c:${second}`);
  const target = page.getByTestId(`lane-row-c:${first}`);
  const h = (await handle.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });
  await page.mouse.up();
  await settle(page);

  const after = (await bands(page)).lanes.map((l) => l.key);
  expect(after[0]).toBe(second);
  expect(after[1]).toBe(first);
});

test("the up and down buttons reorder a lane among its siblings", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  const ctx = (await bands(page)).lanes.map((l) => l.key);
  const [first, second] = [ctx[0]!, ctx[1]!];

  // The first row cannot move further up, so the second row moves up instead.
  await expect(page.getByTestId(`lane-up-c:${first}`)).toBeDisabled();
  await page.getByTestId(`lane-up-c:${second}`).click();
  await settle(page);
  expect((await bands(page)).lanes.map((l) => l.key).slice(0, 2)).toEqual([second, first]);

  // Moving it back down restores the original order.
  await page.getByTestId(`lane-down-c:${second}`).click();
  await settle(page);
  expect((await bands(page)).lanes.map((l) => l.key).slice(0, 2)).toEqual([first, second]);
});

test("a drop indicator appears while dragging a row", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  const ctx = (await bands(page)).lanes.map((l) => l.key);
  const handle = page.getByTestId(`lane-handle-c:${ctx[1]}`);
  const target = page.getByTestId(`lane-row-c:${ctx[0]}`);
  const h = (await handle.boundingBox())!;
  const t = (await target.boundingBox())!;

  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + 3, { steps: 6 });
  // Displays drag styling and drop line during pointer drag.
  await expect(page.locator(".lanes-drop-line")).toBeVisible();
  await expect(page.getByTestId(`lane-row-c:${ctx[1]}`)).toHaveClass(/is-drag-src/);

  await page.mouse.up();
  // Cleared once the drop completes.
  await expect(page.locator(".lanes-drop-line")).toHaveCount(0);
});

test("a new group can hold a lane dragged into it", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  // Collapse default groups so drag source and drop target remain in viewport.
  for (const g of ["g:interrupts", "g:tasks", "g:cpuload", "g:data", "g:functrace"]) {
    const caret = page.getByTestId(`lane-caret-${g}`);
    if ((await caret.count()) && (await caret.getAttribute("aria-expanded")) === "true") {
      await caret.click();
    }
  }

  await page.getByTestId("lane-new-group").click();
  const groupRow = page.getByTestId("lane-row-group");
  await expect(groupRow).toBeVisible();

  // Dragging the Unified lane onto a group nests the lane inside that group.
  const handle = page.getByTestId("lane-handle-u:0");
  const h = (await handle.boundingBox())!;
  const g = (await groupRow.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2, { steps: 8 });
  await page.mouse.up();
  await settle(page);

  const nested = await page.evaluate(() => {
    const roots = window.__traceViewer!.state().laneLayout.roots as any[];
    const group = roots.find((n) => n.id === "group");
    return { childIds: (group?.children ?? []).map((c: any) => c.id), rootHasUnified: roots.some((n) => n.id === "u:0") };
  });
  expect(nested.childIds).toContain("u:0");
  expect(nested.rootHasUnified).toBe(false); // lane moved from root list into group
});

test("ungrouping dissolves a group but keeps its lanes", async ({ page }) => {
  await openFixture(page, "dualcore");
  await openPanel(page);

  const lanesBefore = (await bands(page)).lanes.length;
  await page.getByTestId("lane-ungroup-g:tasks").click();

  // Tasks group header is removed; child context lanes become root lanes.
  await expect(page.getByTestId("lane-row-g:tasks")).toHaveCount(0);
  await expect(page.getByTestId("lane-row-g:interrupts")).toBeVisible();
  const after = await bands(page);
  expect(after.bands.some((b) => b.kind === "group-header" && b.id === "g:tasks")).toBe(false);
  expect(after.lanes.length).toBe(lanesBefore); // context lane count is preserved
});

// Visual baseline (Linux/Docker only)

test("visual: the Lanes panel open beside the timeline (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await openPanel(page);
  await settle(page);
  await expect(page.locator('[data-pane="lanes"]')).toHaveScreenshot("lanes-panel-open.png");
});
