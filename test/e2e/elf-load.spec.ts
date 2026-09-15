/**
 * End-to-end tests for application ELF binary loading: toolbar ELF picker,
 * SHA-256 checking against embedded trace hashes, and status-bar indicators.
 *
 * An ELF the capture disowns is refused rather than loaded with a warning, so the mismatch cases assert
 * that nothing was loaded and the status bar says why.
 */

import { expect, test } from "@playwright/test";
import { getState, gotoApp, loadElfFile, openSvdatFile, rejectElfFile, settle } from "./helpers.js";

const SVDAT = "test/fixtures/traces/elf-id.svdat";
const MATCHING_ELF = "test/fixtures/elf/demo-app.elf";
// A real toolchain ELF (the dual-core demo build) whose hash does NOT match the
// trace — the mismatch path.
const OTHER_ELF = "test/fixtures/traces/dualcore.elf";

test("loading the matching ELF verifies against the trace", async ({ page }) => {
  await gotoApp(page);
  await openSvdatFile(page, SVDAT);

  let s = await getState(page);
  expect(s.eventCount).toBeGreaterThan(0);
  expect(s.elf).toBeNull(); // no ELF yet

  // Before the ELF, the heap alloc's caller stack is bare hex in the Events Detail.
  const events = page.locator('[data-pane="events"]');
  await expect(events).toContainText("0x42000110");
  await expect(events).not.toContainText("app_main");

  await loadElfFile(page, MATCHING_ELF);

  s = await getState(page);
  expect(s.elf).not.toBeNull();
  expect(s.elf!.name).toBe("demo-app.elf");

  // Loading the ELF after the trace re-processes it: the caller stack now
  // symbolizes in place (the committed consumer, end-to-end through the store).
  await expect(events).toContainText("app_main+0x10");

  // The File menu row is named for what it does and says nothing about what is loaded.
  await page.getByTestId("menu-file").click();
  await expect(page.getByTestId("menu-elf")).toHaveText("Load ELF");
  await page.keyboard.press("Escape");
  // The status bar names the ELF. Anything named there belongs to the capture, so there is no mark.
  const chip = page.getByTestId("sb-elf");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText("demo-app.elf");
  // The digest stays in the tooltip, off the crowded status line.
  await expect(chip).toHaveAttribute("title", /demo-app\.elf/);
});

test("a non-matching ELF is refused", async ({ page }) => {
  await gotoApp(page);
  await openSvdatFile(page, SVDAT);
  await rejectElfFile(page, OTHER_ELF);

  // Nothing was loaded, so nothing symbolizes against the wrong build.
  expect((await getState(page)).elf).toBeNull();
  await expect(page.getByTestId("sb-elf")).toBeHidden();
  await expect(page.getByTestId("sb-error")).toContainText("dualcore.elf");
  await expect(page.getByTestId("sb-error")).toContainText("not built from this capture");
});

test("a refused ELF leaves the one already loaded in place", async ({ page }) => {
  await gotoApp(page);
  await openSvdatFile(page, SVDAT);
  await loadElfFile(page, MATCHING_ELF);
  await rejectElfFile(page, OTHER_ELF);

  expect((await getState(page)).elf!.name).toBe("demo-app.elf");
  await expect(page.getByTestId("sb-elf")).toHaveText("demo-app.elf");
});

test("an ELF loaded before the trace is kept when the trace turns out to match", async ({ page }) => {
  await gotoApp(page);
  // With no trace open there is no digest to check against, so the file loads on its own terms.
  await loadElfFile(page, MATCHING_ELF);
  const chip = page.getByTestId("sb-elf");
  await expect(chip).toHaveText("demo-app.elf");

  // Opening the matching trace checks the already-loaded ELF and keeps it.
  await openSvdatFile(page, SVDAT);
  const s = await getState(page);
  expect(s.elf!.name).toBe("demo-app.elf");
  expect(s.eventCount).toBeGreaterThan(0);
  expect(s.loadError).toBeNull();
});

test("an ELF loaded before the trace is unloaded when the trace disowns it", async ({ page }) => {
  await gotoApp(page);
  await loadElfFile(page, OTHER_ELF);
  await expect(page.getByTestId("sb-elf")).toHaveText("dualcore.elf");

  // The trace names a different build, so the ELF goes rather than symbolizing against the wrong one.
  await openSvdatFile(page, SVDAT);
  const s = await getState(page);
  expect(s.elf).toBeNull();
  expect(s.eventCount).toBeGreaterThan(0);
  await expect(page.getByTestId("sb-elf")).toBeHidden();
  await expect(page.getByTestId("sb-error")).toContainText("has been unloaded");
});

test("clearing the trace unloads the loaded ELF", async ({ page }) => {
  await gotoApp(page);
  await openSvdatFile(page, SVDAT);
  await loadElfFile(page, MATCHING_ELF);
  expect((await getState(page)).elf).not.toBeNull();

  await page.getByTestId("menu-file").click();
  await page.getByTestId("menu-clear").click();
  await settle(page);
  const s = await getState(page);
  expect(s.elf).toBeNull();
  await expect(page.getByTestId("sb-elf")).toBeHidden();
});
