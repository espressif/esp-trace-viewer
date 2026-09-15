/**
 * Unit tests for zoom and pan state synchronization: verifying that each action
 * updates the shared {@link TimeScale} and reflects the new window in {@link AppState.view}.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TraceEvent, TraceModel } from "../../src/trace/index.js";
import { initialState, Store } from "../../web/core/store.js";
import { TimeScale } from "../../web/trace-ui-toolkit/time-scale.js";
import {
  panByFraction,
  publishWindow,
  zoomIn,
  zoomOut,
  zoomToFit,
  zoomToRange,
  zoomToSelectedEvent,
  zoomToSpan,
} from "../../web/core/zoom.js";

function ev(ts: number): TraceEvent {
  return { id: 0, coreId: 0, name: "e", ts, tsDelta: 0, plen: 0, params: {}, ctxName: "A", inIrq: false };
}

/** A store + scale sharing the domain `[0, 100]`, optionally preloaded events. */
function setup(events: TraceEvent[] = []): { store: Store; ts: TimeScale } {
  const model: TraceModel = { traces: [], events, gaps: [] };
  const store = new Store({ ...initialState(), model, domain: { start: 0, end: 100 } });
  const ts = new TimeScale({ domainStart: 0, domainEnd: 100, widthPx: 1000 });
  return { store, ts };
}

describe("zoom synchronization (store and TimeScale)", () => {
  it("publishWindow mirrors the live scale window into store.view", () => {
    const { store, ts } = setup();
    ts.zoomToSpan(20, 50); // [40, 60]
    publishWindow(store, ts);
    assert.ok(Math.abs(store.get().view.t0 - 40) < 1e-9);
    assert.ok(Math.abs(store.get().view.t1 - 60) < 1e-9);
  });

  it("every action leaves store.view equal to the scale window", () => {
    const { store, ts } = setup();
    const matches = (): boolean =>
      Math.abs(store.get().view.t0 - ts.t0) < 1e-12 && Math.abs(store.get().view.t1 - ts.t1) < 1e-12;

    zoomToSpan(store, ts, 10, 50);
    assert.ok(matches(), "zoomToSpan");
    zoomIn(store, ts, 50);
    assert.ok(matches() && ts.spanSeconds < 10, "zoomIn shrinks the span and mirrors");
    zoomOut(store, ts, 50);
    assert.ok(matches(), "zoomOut");
    panByFraction(store, ts, 0.2);
    assert.ok(matches(), "panByFraction");
    zoomToRange(store, ts, 30, 35);
    assert.ok(matches(), "zoomToRange");
    zoomToFit(store, ts);
    assert.ok(matches() && ts.isFullyZoomedOut, "zoomToFit restores the domain");
  });

  it("zoomToSelectedEvent zooms onto the selected event and reports success", () => {
    const { store, ts } = setup([ev(10), ev(80)]);
    store.set({ selectedEventIndex: 1 });
    const before = ts.spanSeconds;
    const ok = zoomToSelectedEvent(store, ts);
    assert.equal(ok, true);
    assert.ok(ts.spanSeconds < before, "zoomed in");
    assert.ok(ts.t0 <= 80 && ts.t1 >= 80, "window brackets the selected event");
    assert.ok(Math.abs(store.get().view.t0 - ts.t0) < 1e-12, "mirrored to the store");
  });

  it("zoomToSelectedEvent fits a shift-selected range in the window", () => {
    const { store, ts } = setup([ev(10), ev(50), ev(80)]);
    store.set({ selectedEventIndex: 2, selectionAnchorIndex: 0 });
    const ok = zoomToSelectedEvent(store, ts);
    assert.equal(ok, true);
    assert.ok(ts.t0 <= 10 && ts.t1 >= 80, "window spans the whole range");
    assert.ok(ts.spanSeconds < 100, "tighter than the full domain");
    assert.ok(Math.abs(store.get().view.t0 - ts.t0) < 1e-12, "mirrored to the store");
  });

  it("zoomToSelectedEvent is a no-op returning false with no selection", () => {
    const { store, ts } = setup([ev(10)]);
    let calls = 0;
    store.subscribe(() => calls++);
    const ok = zoomToSelectedEvent(store, ts);
    assert.equal(ok, false);
    assert.equal(calls, 0, "nothing published");
  });
});
