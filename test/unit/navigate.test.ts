/**
 * Unit tests for navigation operations: {@link nearestEventIndex} timestamp
 * resolution, and go/step actions routed through the selection state.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TraceEvent, TraceModel } from "../../src/trace/index.js";
import {
  goToEnd,
  goToEventNumber,
  goToStart,
  goToTimestamp,
  nearestEventIndex,
  snapToNearestTime,
  stepEvent,
  stepEventInContext,
} from "../../web/core/navigate.js";
import { initialState, Store } from "../../web/core/store.js";

/** A minimal event carrying just the fields navigation reads. */
function ev(ts: number, ctxName = "A"): TraceEvent {
  return { id: 0, coreId: 0, name: "e", ts, tsDelta: 0, plen: 0, params: {}, ctxName, inIrq: false };
}

/** A store preloaded with a model of the given events (ascending ts). */
function storeWith(events: TraceEvent[]): Store {
  const model: TraceModel = { traces: [], events, gaps: [] };
  return new Store({ ...initialState(), model });
}

describe("snapToNearestTime", () => {
  const times = [0, 1, 2, 10];

  it("snaps onto the nearest instant within the tolerance", () => {
    assert.equal(snapToNearestTime(times, 1.9, 0.2), 2);
    assert.equal(snapToNearestTime(times, 9.85, 0.2), 10);
  });

  it("keeps the picked time when no instant is close enough", () => {
    assert.equal(snapToNearestTime(times, 5, 0.2), 5);
  });

  it("snaps at the tolerance edge and is a no-op on an exact hit", () => {
    assert.equal(snapToNearestTime(times, 2.25, 0.25), 2);
    assert.equal(snapToNearestTime(times, 1, 0.2), 1);
  });

  it("snaps beyond both ends of the domain", () => {
    assert.equal(snapToNearestTime(times, -0.1, 0.2), 0);
    assert.equal(snapToNearestTime(times, 10.1, 0.2), 10);
  });

  it("keeps the picked time with an empty domain", () => {
    assert.equal(snapToNearestTime([], 5, 0.2), 5);
  });
});

describe("nearestEventIndex", () => {
  const events = [ev(0), ev(1), ev(2), ev(3), ev(10)];

  it("returns null when there are no events", () => {
    assert.equal(nearestEventIndex([], 5), null);
  });

  it("finds an exact hit", () => {
    assert.equal(nearestEventIndex(events, 2), 2);
  });

  it("rounds to the closer neighbour", () => {
    assert.equal(nearestEventIndex(events, 2.4), 2);
    assert.equal(nearestEventIndex(events, 2.6), 3);
    assert.equal(nearestEventIndex(events, 8), 4); // 10 is closer than 3
  });

  it("clamps to the ends for out-of-range times", () => {
    assert.equal(nearestEventIndex(events, -100), 0);
    assert.equal(nearestEventIndex(events, 1e9), 4);
  });

  it("prefers the earlier index on a tie", () => {
    // 2.5 is equidistant from index 2 (ts 2) and index 3 (ts 3) → earlier wins.
    assert.equal(nearestEventIndex(events, 2.5), 2);
  });
});

describe("goToTimestamp", () => {
  it("selects the nearest event and derives its cursor", () => {
    const store = storeWith([ev(0), ev(1), ev(2)]);
    goToTimestamp(store, 1.4);
    assert.equal(store.get().selectedEventIndex, 1);
    assert.equal(store.get().cursorTime, 1);
  });

  it("is a no-op with no model loaded", () => {
    const store = new Store(initialState());
    goToTimestamp(store, 5);
    assert.equal(store.get().selectedEventIndex, null);
  });
});

describe("goToEventNumber", () => {
  it("selects by 1-based number", () => {
    const store = storeWith([ev(0), ev(1), ev(2)]);
    goToEventNumber(store, 2);
    assert.equal(store.get().selectedEventIndex, 1);
  });

  it("clamps below/above range onto the first/last event", () => {
    const store = storeWith([ev(0), ev(1), ev(2)]);
    goToEventNumber(store, 0);
    assert.equal(store.get().selectedEventIndex, 0);
    goToEventNumber(store, 999);
    assert.equal(store.get().selectedEventIndex, 2);
  });
});

describe("goToStart / goToEnd", () => {
  it("jump to the first and last events", () => {
    const store = storeWith([ev(0), ev(1), ev(2)]);
    goToEnd(store);
    assert.equal(store.get().selectedEventIndex, 2);
    goToStart(store);
    assert.equal(store.get().selectedEventIndex, 0);
  });
});

describe("stepEvent", () => {
  it("advances and retreats by one, with no wrap at the ends", () => {
    const store = storeWith([ev(0), ev(1), ev(2)]);
    stepEvent(store, 1); // nothing selected → first
    assert.equal(store.get().selectedEventIndex, 0);
    stepEvent(store, 1);
    assert.equal(store.get().selectedEventIndex, 1);
    stepEvent(store, -1);
    assert.equal(store.get().selectedEventIndex, 0);
    stepEvent(store, -1); // already at start → stays
    assert.equal(store.get().selectedEventIndex, 0);
  });

  it("steps from the end when nothing is selected and dir is -1", () => {
    const store = storeWith([ev(0), ev(1), ev(2)]);
    stepEvent(store, -1);
    assert.equal(store.get().selectedEventIndex, 2);
  });
});

describe("stepEventInContext", () => {
  it("skips to the next/previous event of the focused context", () => {
    // ctx:  A  B  A  B  A   (indices 0..4)
    const store = storeWith([ev(0, "A"), ev(1, "B"), ev(2, "A"), ev(3, "B"), ev(4, "A")]);
    store.set({ selectedEventIndex: 0 }); // focused context derives to "A"
    stepEventInContext(store, 1);
    assert.equal(store.get().selectedEventIndex, 2);
    stepEventInContext(store, 1);
    assert.equal(store.get().selectedEventIndex, 4);
    stepEventInContext(store, 1); // no further "A" → no-op
    assert.equal(store.get().selectedEventIndex, 4);
    stepEventInContext(store, -1);
    assert.equal(store.get().selectedEventIndex, 2);
  });

  it("prioritizes an explicitly selected context over the event context", () => {
    const store = storeWith([ev(0, "A"), ev(1, "B"), ev(2, "A"), ev(3, "B")]);
    store.set({ selectedEventIndex: 0, selectedContext: "B" });
    stepEventInContext(store, 1);
    assert.equal(store.get().selectedEventIndex, 1); // first "B" after index 0
  });

  it("is a no-op when no context is focused", () => {
    const store = storeWith([ev(0, "A"), ev(1, "B")]);
    stepEventInContext(store, 1);
    assert.equal(store.get().selectedEventIndex, null);
  });
});
