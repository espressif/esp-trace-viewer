/**
 * Unit tests for {@link TimeScale} window calculations (zoom, pan,
 * time-to-pixel mapping, domain clamping), the pub/sub {@link Store} (subscribe,
 * notify, keyed selection, no-op suppression), and {@link RafScheduler} render coalescing.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { TimeScale } from "../../web/trace-ui-toolkit/time-scale.js";
import { RafScheduler } from "../../web/trace-ui-toolkit/raf-scheduler.js";
import { initialState, Store } from "../../web/core/store.js";

describe("TimeScale window math", () => {
  it("maps the full domain across the pixel width and round-trips", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 10, widthPx: 1000 });
    assert.equal(ts.t0, 0);
    assert.equal(ts.t1, 10);
    assert.equal(ts.timeToX(0), 0);
    assert.equal(ts.timeToX(10), 1000);
    assert.equal(ts.timeToX(5), 500);
    for (const x of [0, 1, 123.4, 750, 1000]) {
      assert.ok(Math.abs(ts.timeToX(ts.xToTime(x)) - x) < 1e-9, `round-trip at ${x}`);
    }
  });

  it("insets the plot area so t0 maps to offsetPx, not x=0", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 10, widthPx: 232 });
    ts.setOffsetPx(132); // 132 px gutter + 100 px plot
    assert.equal(ts.offsetPx, 132);
    assert.equal(ts.plotWidthPx, 100);
    assert.equal(ts.timeToX(0), 132); // window left edge is positioned after the gutter
    assert.equal(ts.timeToX(10), 232); // window right at the canvas edge
    assert.equal(ts.timeToX(5), 182);
    // secondsPerPixel and round-trips honour the plot area, not the full width.
    assert.ok(Math.abs(ts.secondsPerPixel - 10 / 100) < 1e-12);
    for (const x of [132, 150, 182, 232]) {
      assert.ok(Math.abs(ts.timeToX(ts.xToTime(x)) - x) < 1e-9, `round-trip at ${x}`);
    }
  });

  it("zooms about an anchor pixel measured from the plot-area edge", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 232 });
    ts.setOffsetPx(132);
    const anchorX = 182; // halfway across the 100 px plot
    const anchorTime = ts.xToTime(anchorX);
    ts.zoomAt(anchorX, 0.5);
    assert.ok(Math.abs(ts.spanSeconds - 50) < 1e-9, "span halved");
    assert.ok(Math.abs(ts.xToTime(anchorX) - anchorTime) < 1e-9, "anchor time fixed");
  });

  it("clamps the offset to keep at least one plot pixel", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 10, widthPx: 100 });
    ts.setOffsetPx(1000); // absurd inset
    assert.equal(ts.offsetPx, 99);
    assert.equal(ts.plotWidthPx, 1);
  });

  it("zooms about a fixed anchor pixel (anchor time stays put)", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000 });
    const anchorX = 250;
    const anchorTime = ts.xToTime(anchorX);
    ts.zoomAt(anchorX, 0.5); // zoom in 2×
    assert.ok(Math.abs(ts.spanSeconds - 50) < 1e-9, "span halved");
    assert.ok(Math.abs(ts.xToTime(anchorX) - anchorTime) < 1e-9, "anchor time fixed");
  });

  it("pans by a pixel delta and clamps to the domain", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000 });
    ts.zoomToSpan(10, 50); // window [45, 55]
    ts.panByPixels(100); // +100 px * (10/1000 spp) = +1 s
    assert.ok(Math.abs(ts.t0 - 46) < 1e-9 && Math.abs(ts.t1 - 56) < 1e-9);
    // Pan hard right past the domain end — window sticks to [90, 100].
    ts.panByPixels(1e6);
    assert.ok(Math.abs(ts.t1 - 100) < 1e-9, "clamped to domain end");
    assert.ok(Math.abs(ts.spanSeconds - 10) < 1e-9, "span preserved when clamped");
  });

  it("zoomByFactor scales the span about the window midpoint by default", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000 });
    ts.zoomByFactor(0.5); // zoom in 2×
    assert.ok(Math.abs(ts.spanSeconds - 50) < 1e-9, "span halved");
    assert.ok(Math.abs(ts.t0 - 25) < 1e-9 && Math.abs(ts.t1 - 75) < 1e-9, "centred on the midpoint");
  });

  it("zoomByFactor keeps a given centre time fixed in the window", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000 });
    const center = 10;
    const fracBefore = (center - ts.t0) / ts.spanSeconds;
    ts.zoomByFactor(0.5, center);
    assert.ok(Math.abs(ts.spanSeconds - 50) < 1e-9, "span halved");
    const fracAfter = (center - ts.t0) / ts.spanSeconds;
    assert.ok(Math.abs(fracAfter - fracBefore) < 1e-9, "centre time stays at the same fraction");
  });

  it("zoomByFactor clamps zoom-out to the domain and zoom-in to minSpan", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000, minSpan: 1e-6 });
    ts.zoomToSpan(10, 50); // [45, 55]
    ts.zoomByFactor(1000); // absurd zoom-out
    assert.ok(ts.spanSeconds <= 100 + 1e-9, "never exceeds the domain span");
    assert.ok(ts.t0 >= -1e-9 && ts.t1 <= 100 + 1e-9, "stays within the domain");
    ts.zoomByFactor(1e-20); // absurd zoom-in
    assert.ok(ts.spanSeconds >= 1e-6 - 1e-12, "never below minSpan");
  });

  it("zoomToSelection fits a range with padding, order-independent and clamped", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000 });
    ts.zoomToSelection(20, 40); // 5% padding each side → [19, 41]
    assert.ok(Math.abs(ts.t0 - 19) < 1e-9 && Math.abs(ts.t1 - 41) < 1e-9, "padded around the range");
    for (const x of [0, 250, 500, 1000]) {
      assert.ok(Math.abs(ts.timeToX(ts.xToTime(x)) - x) < 1e-9, `round-trip at ${x}`);
    }
    const reversed = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000 });
    reversed.zoomToSelection(40, 20);
    assert.ok(Math.abs(reversed.t0 - ts.t0) < 1e-12 && Math.abs(reversed.t1 - ts.t1) < 1e-12, "order-independent");
    // A range extending past the domain edge is clamped within bounds.
    ts.zoomToSelection(-10, 40);
    assert.ok(ts.t0 >= -1e-9 && ts.t1 <= 100 + 1e-9, "clamped into the domain");
  });

  it("zoomToSelection on a degenerate range widens to minSpan", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000, minSpan: 1e-6 });
    ts.zoomToSelection(50, 50);
    assert.ok(ts.spanSeconds >= 1e-6 - 1e-12, "honours the minSpan floor");
    assert.ok(ts.t0 < 50 && ts.t1 > 50, "still brackets the point");
  });

  it("never collapses below minSpan and zoomToFit restores the domain", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000, minSpan: 1e-6 });
    ts.zoomToSpan(0); // degenerate request
    // Allow a few ULPs of float drift from measuring a 1 µs span near t=50.
    assert.ok(ts.spanSeconds >= 1e-6 - 1e-12, "honours minSpan floor");
    ts.zoomToFit();
    assert.equal(ts.t0, 0);
    assert.equal(ts.t1, 100);
    assert.ok(ts.isFullyZoomedOut);
  });

  it("re-clamps the window when the domain changes", () => {
    const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 800 });
    ts.zoomToSpan(20, 90); // [80, 100]
    ts.setDomain(0, 50); // domain reduced below window bounds
    assert.ok(ts.t1 <= 50 + 1e-9, "window clamped inside the new domain");
    assert.ok(ts.t0 >= 0 - 1e-9);
  });
});

describe("Store pub/sub", () => {
  it("notifies subscribers on a real change and merges shallowly", () => {
    const store = new Store(initialState());
    let calls = 0;
    let lastCursor: number | null = -1;
    store.subscribe((s) => {
      calls++;
      lastCursor = s.cursorTime;
    });
    store.set({ cursorTime: 1.5 });
    assert.equal(calls, 1);
    assert.equal(lastCursor, 1.5);
    assert.equal(store.get().cursorTime, 1.5);
    // Other slices untouched by the merge.
    assert.equal(store.get().model, null);
  });

  it("suppresses no-op writes (every key Object.is-equal)", () => {
    const store = new Store(initialState());
    let calls = 0;
    store.subscribe(() => calls++);
    store.set({ cursorTime: null }); // already null
    store.set({ loadError: null }); // already null
    assert.equal(calls, 0);
  });

  it("select() fires only when a watched key changes", () => {
    const store = new Store(initialState());
    let modelChanges = 0;
    store.select(["model"], () => modelChanges++);
    store.set({ cursorTime: 2 }); // not watched
    assert.equal(modelChanges, 0);
    store.set({ model: { traces: [], events: [], gaps: [] } });
    assert.equal(modelChanges, 1);
  });

  it("unsubscribe stops further notifications", () => {
    const store = new Store(initialState());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.set({ cursorTime: 1 });
    off();
    store.set({ cursorTime: 2 });
    assert.equal(calls, 1);
  });
});

describe("RafScheduler coalescing", () => {
  it("coalesces multiple invalidations into one draw per frame", async () => {
    let frame: (() => void) | null = null;
    const raf = (cb: (t: number) => void): number => {
      frame = () => cb(0);
      return 1;
    };
    const scheduler = new RafScheduler(raf, () => {});
    let draws = 0;
    const drawable = { draw: () => draws++ };
    scheduler.add(drawable);
    scheduler.requestDraw(drawable);
    scheduler.requestDraw(drawable);
    scheduler.requestDraw(drawable);
    assert.equal(draws, 0, "nothing drawn until the frame fires");
    frame!();
    assert.equal(draws, 1, "three requests collapsed into one draw");
    // A new request after the frame schedules another.
    scheduler.requestDraw(drawable);
    frame!();
    assert.equal(draws, 2);
  });
});
