/**
 * End-to-end tests for the Timeline pane lane host.
 *
 * Asserts band layout, Unified tracks, hit testing, tooltip details, gutter controls,
 * cursor snapping, pan performance budgets, ready intervals, context-switch connectors,
 * and visual baselines.
 */

import { expect, test } from "@playwright/test";
import { getState, openFixture, settle, timelineGroups, VISUAL_ENABLED, zoomToEventCluster } from "./helpers.js";

/** Scroll the lane area by `dy` px so a lane further down the list is fully drawn. */
async function scrollLanes(page: import("@playwright/test").Page, dy: number): Promise<void> {
  await page.evaluate((d) => {
    const c = document.querySelector('[data-pane="timeline"] canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(
      new WheelEvent("wheel", { deltaY: d, shiftKey: true, clientX: r.left + 60, clientY: r.top + 60, bubbles: true, cancelable: true }),
    );
  }, dy);
  await settle(page);
}

const CANVAS = '[data-pane="timeline"] canvas';

/** A laid-out band, as the introspection reports it. */
interface Band {
  id: string;
  kind: "group-header" | "lane";
  type: string;
  depth: number;
  top: number;
  height: number;
  centerY: number;
  label: string;
  collapsed: boolean;
  groupId: string | null;
  groupLabel: string | null;
  source: { kind: "unified"; coreId: number } | { kind: "context"; key: string } | null;
}

/** The subset of the timeline introspection these specs read. */
declare global {
  interface Window {
    __tl?: {
      contentTop: number;
      laneHeight: number;
      gutterWidth: number;
      unifiedCount: number;
      scrollTop: number;
      contentHeight: number;
      viewportHeight: number;
      bands: Band[];
      bandCenterY(id: string): number | null;
      lanes: { key: string; label: string }[];
      hiddenLaneCount: number;
      laneAtY(y: number): { index: number; key: string; label: string } | null;
      eventAt(x: number, y: number): { index: number; name: string; key: string; kind: string } | null;
      hitTest(x: number, y: number): { kind: string; key?: string } | null;
      markProbe(): { x: number; y: number; index: number; name: string } | null;
      markCount(key: string): number;
      readyCount(key: string): number;
      switchConnectorCount(): number;
      visibleWindow: { t0: number; t1: number };
      widthPx: number;
      timeAtX(x: number): number;
      cursorSnapPx: number;
      eventTimeAt(index: number): number | null;
      lastFrameMs(): number;
    };
  }
}

test("introspection: lays out a Unified track over the per-context lanes", async ({ page }) => {
  await openFixture(page, "dualcore");
  const info = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>;
    // The visible context lanes the layout tree holds, in tree order.
    const labels: string[] = [];
    const walk = (nodes: any[], hidden: boolean): void => {
      for (const n of nodes) {
        const h = hidden || !!n.hidden;
        if (n.kind === "group") walk(n.children, h);
        else if (n.type === "timespan" && n.source?.kind === "context" && !h) labels.push(n.label ?? n.source.key);
      }
    };
    walk(window.__traceViewer!.state().laneLayout.roots as any[], false);
    return { unified: tl.unifiedCount, lanes: tl.lanes.map((l) => l.label), layoutLabels: labels };
  });
  // Dual-core fixture → one Unified row per core.
  expect(info.unified).toBe(2);
  // The pane's lanes mirror the visible context lanes of the layout, in order.
  expect(info.lanes.length).toBeGreaterThan(0);
  expect(info.lanes).toEqual(info.layoutLabels);
});

test("introspection: context lanes carry in-run API/log marks", async ({ page }) => {
  await openFixture(page, "dualcore");
  const total = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>;
    return tl.lanes.reduce((n, l) => n + tl.markCount(l.key), 0);
  });
  expect(total).toBeGreaterThan(0);
});

test("the default layout groups contexts by kind, in stacking order", async ({ page }) => {
  await openFixture(page, "dualcore");
  const info = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>;
    const headers = tl.bands.map((b) => b.groupLabel).filter((l): l is string => !!l);
    return { headers, firstIsUnified: tl.bands[0]?.source?.kind === "unified" };
  });
  expect(info.firstIsUnified).toBe(true); // Unified track on top
  // Scheduler spans and ISRs above the tasks, idle below them, plots at the bottom.
  // Function Trace is collapsed by default, so it has no lane to carry a label and
  // appears only in the Lanes panel — task lanes show their functions inline instead.
  expect(info.headers).toEqual(["Sys", "IRQ", "Task", "Idle", "Load", "Data"]);
});

test("collapsing a group in the Lanes panel drops its lanes from the timeline", async ({ page }) => {
  await openFixture(page, "dualcore");

  const laneCount = async (): Promise<number> =>
    page.evaluate(
      () =>
        (window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>).bands
          .length,
    );
  const before = await laneCount();
  expect(before).toBeGreaterThan(0);

  // Group structure is edited in the Lanes panel; the timeline gutter has no carets of its own.
  await page.getByTestId("toggle-lanes").click();
  await page.getByTestId("lane-caret-g:tasks").click();
  await settle(page);

  expect(await laneCount()).toBeLessThan(before);
  // With no lane left to carry it, the group's label is gone from the gutter too.
  expect(await timelineGroups(page)).not.toContain("Task");
});

test("Classes ▸ Show All Hidden Lanes restores lanes hidden from the timeline", async ({ page }) => {
  await openFixture(page, "dualcore");

  // The menu item is disabled while nothing is hidden.
  await page.getByTestId("menu-classes").click();
  await expect(page.getByTestId("menu-show-all-lanes")).toBeDisabled();
  await page.keyboard.press("Escape");

  // Hide the first lane through its Lanes panel checkbox. Lane visibility lives there, not in the
  // timeline gutter and not in the Statistics table, which never hides a row for a hidden lane.
  await page.getByTestId("toggle-lanes").click();
  await page.locator(".lanes-row-lane .lanes-visible").first().click();
  expect(await page.evaluate(() => (window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>).hiddenLaneCount)).toBe(1);

  // The menu item is now enabled; choosing it shows every lane again.
  await page.getByTestId("menu-classes").click();
  await expect(page.getByTestId("menu-show-all-lanes")).toBeEnabled();
  await page.getByTestId("menu-show-all-lanes").click();
  expect(await page.evaluate(() => (window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>).hiddenLaneCount)).toBe(0);
});

test("hover over a run span: the tooltip shows the event ID, context + duration", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;

  // The top band of the Unified track is over bare execution, so the hit-test
  // reports a span and the tooltip shows the opener's event ID (run bars
  // display no event ID label), the running context, and a duration delta.
  const hit = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>;
    const x = tl.gutterWidth + 120;
    const y = tl.contentTop + 5;
    const h = tl.hitTest(x, y);
    return h ? { x, y, kind: h.kind, key: h.key } : null;
  });
  expect(hit).not.toBeNull();
  expect(hit!.kind).toBe("span");

  await page.mouse.move(box.x + hit!.x, box.y + hit!.y);
  const tip = page.getByTestId("timeline-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip.locator(".tl-tt-head")).toContainText(hit!.key!);
  await expect(tip.locator(".tl-tt-head")).toContainText(/#\d+/);
  await expect(tip.locator(".tl-tt-delta")).toContainText("Δ");
});

test("hover over an event marker: the tooltip shows the marked event, not the span", async ({ page }) => {
  await openFixture(page, "dualcore");
  await zoomToEventCluster(page);
  const box = (await page.locator(CANVAS).boundingBox())!;

  const probe = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>;
    const p = tl.markProbe();
    if (!p) return null;
    const h = tl.hitTest(p.x, p.y);
    return { ...p, kind: h?.kind };
  });
  expect(probe).not.toBeNull();
  expect(probe!.kind).toBe("mark");

  await page.mouse.move(box.x + probe!.x, box.y + probe!.y);
  const tip = page.getByTestId("timeline-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(`#${probe!.index + 1}`);
  await expect(tip.locator(".tl-tt-head")).toContainText(probe!.name);
});

test("click: sets the shared cursor, snapping onto the nearest event", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;

  // Frame a short stretch of events so individual events resolve to distinct
  // pixels, and locate a known event's exact x by inverting timeAtX.
  await page.evaluate(() => window.__traceViewer!.zoomToEventRange(500, 520));
  await settle(page);
  const at = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>;
    const ts = tl.eventTimeAt(510)!;
    let lo = tl.gutterWidth;
    let hi = tl.widthPx;
    while (hi - lo > 0.01) {
      const mid = (lo + hi) / 2;
      if (tl.timeAtX(mid) < ts) lo = mid;
      else hi = mid;
    }
    const secondsPerPixel = tl.timeAtX(tl.gutterWidth + 1) - tl.timeAtX(tl.gutterWidth);
    // Event times near the framed range to verify cursor snapping.
    const nearby: number[] = [];
    for (let i = 495; i <= 525; i++) {
      const t = tl.eventTimeAt(i);
      if (t !== null) nearby.push(t);
    }
    return { eventX: (lo + hi) / 2, snapPx: tl.cursorSnapPx, secondsPerPixel, nearby, y: tl.contentTop + 4 };
  });

  // Click within snap radius to verify cursor snaps to event timestamp.
  const clickX = Math.round(at.eventX + at.snapPx / 2);
  const clickT = await page.evaluate(
    (x) => (window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>).timeAtX(x),
    clickX,
  );
  await page.mouse.click(box.x + clickX, box.y + at.y);
  const snapped = (await getState(page)).cursorTime;
  expect(snapped).not.toBeNull();
  expect(at.nearby).toContainEqual(snapped!);
  expect(Math.abs(snapped! - clickT)).toBeLessThanOrEqual(at.snapPx * at.secondsPerPixel * 1.001);
});

test("frame budget: continuous pan over the 165k-event fixture stays responsive", async ({ page }) => {
  await openFixture(page, "dualcore");
  const box = (await page.locator(CANVAS).boundingBox())!;

  await page.selectOption(".tb-zoom", { index: 4 }); // "1 ms"
  await settle(page);

  await page.mouse.move(box.x + 700, box.y + 200);
  await page.mouse.down();
  for (let i = 0; i < 24; i++) await page.mouse.move(box.x + 700 - i * 12, box.y + 200);
  await page.mouse.up();
  await settle(page);

  const ms = await page.evaluate(() => (window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>).lastFrameMs());
  expect(ms).toBeLessThan(50);
});


test("hover over a ready box: the tooltip shows the task + scheduling latency", async ({ page }) => {
  await openFixture(page, "unicore");
  // Frame the window where an ISR preempts the control task before it resumes.
  await page.evaluate(() => window.__traceViewer!.zoomToEventRange(49_769, 49_787));
  await settle(page);
  const box = (await page.locator(CANVAS).boundingBox())!;

  const probe = await page.evaluate(() => {
    const tl = window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>;
    const band = tl.bands.find((b) => b.source?.kind === "context" && b.source.key === "control");
    if (!band) return null;
    const y = tl.bandCenterY(band.id)!;
    const { t0, t1 } = tl.visibleWindow;
    // Middle of the ready interval [8.375524, 8.375595] — no run covers it.
    const tMid = (8.375524 + 8.375595) / 2;
    const x = tl.gutterWidth + ((tMid - t0) / (t1 - t0)) * (tl.widthPx - tl.gutterWidth);
    const h = tl.hitTest(x, y);
    return { x, y, kind: h?.kind, key: h?.key, readyCount: tl.readyCount("control") };
  });
  expect(probe).not.toBeNull();
  expect(probe!.kind).toBe("ready");
  expect(probe!.key).toBe("control");
  expect(probe!.readyCount).toBeGreaterThan(0);

  await page.mouse.move(box.x + probe!.x, box.y + probe!.y);
  const tip = page.getByTestId("timeline-tooltip");
  await expect(tip).toBeVisible();
  await expect(tip.locator(".tl-tt-head")).toContainText("control ready");
  await expect(tip.locator(".tl-tt-delta")).toContainText("Δ");
});

test("context-switch connectors: drawn at readable zoom, LOD-hidden zoomed out", async ({ page }) => {
  await openFixture(page, "dualcore");
  // Whole recording: far more unified intervals than the connector LOD allows.
  const zoomedOut = await page.evaluate(
    () => (window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>).switchConnectorCount(),
  );
  expect(zoomedOut).toBe(0);

  await zoomToEventCluster(page);
  const zoomedIn = await page.evaluate(
    () => (window.__traceViewer!.panes["timeline"]!() as unknown as NonNullable<Window["__tl"]>).switchConnectorCount(),
  );
  expect(zoomedIn).toBeGreaterThan(0);
});

test("visual: ready box, bordered bars and switch connectors (single-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "unicore");
  await page.evaluate(() => window.__traceViewer!.zoomToEventRange(49_769, 49_787));
  await settle(page);
  await expect(page.locator(CANVAS)).toHaveScreenshot("timeline-ready-window.png");
});

test("visual: preempted task drawn ready-to-run under the preemptor (single-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "unicore");
  // A timer ISR readies the sensor task, which preempts dsp; dsp displays a ready box.
  await page.evaluate(() => window.__traceViewer!.zoomToEventRange(56_381, 56_393));
  await scrollLanes(page, 120); // bring the dsp lane fully into the viewport
  await settle(page);
  await expect(page.locator(CANVAS)).toHaveScreenshot("timeline-preempt-ready.png");
});

test("visual: timeline zoomed out — full recording (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await settle(page);
  await expect(page.locator(CANVAS)).toHaveScreenshot("timeline-zoomed-out.png");
});

test("visual: timeline zoomed in — run bars and in-run API/log marks (dual-core demo)", async ({ page }) => {
  test.skip(!VISUAL_ENABLED, "visual baselines are Linux/Docker-only; run `npm run test:e2e:docker`");
  await openFixture(page, "dualcore");
  await zoomToEventCluster(page);
  await expect(page.locator(CANVAS)).toHaveScreenshot("timeline-zoomed-in.png");
});
