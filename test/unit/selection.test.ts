/**
 * Unit tests for selection state (`web/core/selection.ts`): {@link selectEvent}
 * deriving cursor position from the selected event, {@link focusedContext}
 * resolving highlighted context, and selection propagation across store subscriptions.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TraceEvent, TraceModel } from "../../src/trace/index.js";
import { eventTime, focusedContext, selectEvent } from "../../web/core/selection.js";
import { initialState, Store } from "../../web/core/store.js";

/** A minimal event carrying just the fields the selection layer reads. */
function ev(ts: number, ctxName: string): TraceEvent {
  return { id: 0, coreId: 0, name: "e", ts, tsDelta: 0, plen: 0, params: {}, ctxName, inIrq: false };
}

/** A store preloaded with a model of the given (ts, context) events. */
function storeWith(events: TraceEvent[]): Store {
  const model: TraceModel = { traces: [], events, gaps: [] };
  return new Store({ ...initialState(), model });
}

describe("selectEvent", () => {
  it("derives the cursor from the selected event's time", () => {
    const store = storeWith([ev(1.0, "A"), ev(2.5, "B")]);
    selectEvent(store, 1);
    assert.equal(store.get().selectedEventIndex, 1);
    assert.equal(store.get().cursorTime, 2.5);
  });

  it("clears an explicit context selection so the event's context takes over", () => {
    const store = storeWith([ev(1.0, "A")]);
    store.set({ selectedContext: "B" });
    selectEvent(store, 0);
    assert.equal(store.get().selectedContext, null);
    assert.equal(focusedContext(store.get()), "A");
  });

  it("is idempotent — re-selecting the same event notifies no one", () => {
    const store = storeWith([ev(1.0, "A"), ev(2.0, "B")]);
    selectEvent(store, 1);
    let calls = 0;
    store.subscribe(() => calls++);
    selectEvent(store, 1);
    assert.equal(calls, 0, "no-op write fires no listeners");
    assert.equal(store.get().cursorTime, 2.0);
  });

  it("clearing with null clears the selection but leaves the cursor", () => {
    const store = storeWith([ev(1.0, "A")]);
    selectEvent(store, 0);
    selectEvent(store, null);
    assert.equal(store.get().selectedEventIndex, null);
    assert.equal(store.get().cursorTime, 1.0, "cursor remains at the selected timestamp");
  });

  it("ignores an out-of-range index (no model / bad index)", () => {
    const empty = new Store(initialState());
    selectEvent(empty, 5);
    assert.equal(empty.get().selectedEventIndex, null);
    assert.equal(empty.get().cursorTime, null);

    const store = storeWith([ev(1.0, "A")]);
    selectEvent(store, 9);
    assert.equal(store.get().selectedEventIndex, null);
  });
});

describe("focusedContext", () => {
  it("returns the owning context of the selected event when no explicit context is set", () => {
    const store = storeWith([ev(1.0, "Task-A"), ev(2.0, "Task-B")]);
    selectEvent(store, 1);
    assert.equal(focusedContext(store.get()), "Task-B");
  });

  it("prefers an explicitly selected context over the event's", () => {
    const store = storeWith([ev(1.0, "Task-A")]);
    store.set({ selectedEventIndex: 0, selectedContext: "Task-Z" });
    assert.equal(focusedContext(store.get()), "Task-Z");
  });

  it("is null when nothing is selected", () => {
    const store = storeWith([ev(1.0, "A")]);
    assert.equal(focusedContext(store.get()), null);
  });
});

describe("eventTime", () => {
  it("maps an index to its event time, or null when absent", () => {
    const store = storeWith([ev(3.0, "A"), ev(4.0, "B")]);
    assert.equal(eventTime(store.get(), 0), 3.0);
    assert.equal(eventTime(store.get(), null), null);
    assert.equal(eventTime(store.get(), 7), null);
  });
});

describe("selection round-trips across store subscriptions", () => {
  it("notifies pane-keyed subscriptions", () => {
    const store = storeWith([ev(1.0, "A"), ev(2.0, "B")]);
    let cursorFires = 0;
    let selFires = 0;
    let ctxFires = 0;
    store.select(["cursorTime"], () => cursorFires++);
    store.select(["selectedEventIndex"], () => selFires++);
    store.select(["selectedContext"], () => ctxFires++);

    store.set({ selectedContext: "B" }); // explicitly set a context first
    assert.equal(ctxFires, 1);

    selectEvent(store, 0); // event pick updates cursor and selection, clears explicit context
    assert.equal(cursorFires, 1, "timeline/cpu-load cursor subscription fired");
    assert.equal(selFires, 1, "events/terminal selection subscription fired");
    assert.equal(ctxFires, 2, "contexts subscription fired as explicit context was cleared");
  });
});
