/**
 * End-to-end tests for CPU-load lanes.
 *
 * Tests default creation of the CPU Load group and per-core lanes,
 * group placement below activity lanes, and collapsible group behavior.
 */

import { expect, test } from "@playwright/test";
import { openFixture, scrollTimelineToBottom, settle, timelineBands, timelineGroups, VISUAL_ENABLED } from "./helpers.js";

test("a CPU Load group with one per-core lane is created by default", async ({ page }) => {
  await openFixture(page, "dualcore");
  const bands = await timelineBands(page);
  // The group's label rides on its first lane rather than taking a header row.
  expect(bands.some((b) => b.groupId === "g:cpuload" && b.groupLabel === "Load")).toBe(true);
  const cpu = bands.filter((b) => b.type === "cpuload");
  expect(cpu.length).toBe(2); // dual-core trace → one lane per core
  expect(cpu.map((b) => b.label)).toEqual(["CPU Load (core 0)", "CPU Load (core 1)"]);
});

test("a dual-core P4 trace gets one CPU-load lane per core", async ({ page }) => {
  await openFixture(page, "p4-mcore");
  const cpu = (await timelineBands(page)).filter((b) => b.type === "cpuload");
  expect(cpu.map((b) => b.label)).toEqual(["CPU Load (core 0)", "CPU Load (core 1)"]);
});

test("the CPU Load group renders below the activity lanes", async ({ page }) => {
  await openFixture(page, "dualcore");
  const bands = await timelineBands(page);
  const groupIdx = bands.findIndex((b) => b.groupId === "g:cpuload");
  const lastTimespan = bands.map((b) => b.type).lastIndexOf("timespan");
  expect(groupIdx).toBeGreaterThan(lastTimespan);
});

test("folding the CPU Load group hides its histogram lanes", async ({ page }) => {
  await openFixture(page, "p4-mcore");
  expect((await timelineBands(page)).filter((b) => b.type === "cpuload").length).toBe(2);

  // Collapse the group from the Lanes editor caret; its lanes drop out of the host.
  await page.getByTestId("toggle-lanes").click();
  await page.getByTestId("lane-caret-g:cpuload").click();
  await settle(page);

  const bands = await timelineBands(page);
  expect(bands.filter((b) => b.type === "cpuload").length).toBe(0); // charts hidden
  // With no lane to carry it, the group's label goes with them.
  expect(await timelineGroups(page)).not.toContain("Load");
});

test("visual: CPU-load lanes inside the timeline (dual-core P4 fixture)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "p4-mcore");
  await scrollTimelineToBottom(page);
  await settle(page);
  await expect(page.locator('[data-pane="timeline"] canvas')).toHaveScreenshot("cpuload-lanes-p4.png");
});
