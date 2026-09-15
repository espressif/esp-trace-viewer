/**
 * Unit tests for the state the redesigned shell added: the workspace switch, the Events/Logs dock's
 * placement, the two independent scope choices, the lane-group quick filters and the lane density.
 *
 * These slices are what keeps the two workspaces from silently changing each other, so what is asserted
 * here is mostly independence: what one surface writes, the other does not read.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { inScope, resolveScope } from "../../web/core/list-scope.js";
import { QUICK_FILTERS, quickFilterOn, toggleQuickFilter } from "../../web/core/lanes/quick-filters.js";
import { initialState, LANE_DENSITIES, Store, type AppState } from "../../web/core/store.js";

/** A state with a two-event model, a 0…10 s domain and a 2…8 s visible window. */
function stateWithEvents(over: Partial<AppState> = {}): AppState {
  const events = [
    { ts: 1, coreId: 0, name: "a", ctxName: "TaskA", id: 1, params: {} },
    { ts: 5, coreId: 0, name: "b", ctxName: "TaskA", id: 1, params: {} },
    { ts: 9, coreId: 0, name: "c", ctxName: "TaskA", id: 1, params: {} },
  ];
  return {
    ...initialState(),
    model: { events, traces: [], elf: null } as unknown as AppState["model"],
    domain: { start: 0, end: 10 },
    view: { t0: 2, t1: 8 },
    ...over,
  };
}

describe("initial shell state", () => {
  it("opens on the Timeline with the dock on the right and the overview shown", () => {
    const s = initialState();
    assert.equal(s.workspace, "timeline");
    assert.deepEqual(s.dock, { side: "right", tab: "events", hidden: false });
    assert.equal(s.overview, true);
    assert.equal(s.groupsOff.size, 0);
    assert.ok(LANE_DENSITIES.includes(s.laneDensity as (typeof LANE_DENSITIES)[number]));
  });

  it("gives the dock and the Statistics table their own scope, both starting on the visible window", () => {
    const s = initialState();
    assert.equal(s.listScope, "visible");
    assert.equal(s.statsScope, "visible");
    assert.equal(s.statsType, "all");
    assert.equal(s.listContextOnly, false);
  });

  it("keeps the two scopes independent when one is changed", () => {
    const store = new Store(initialState());
    store.set({ listScope: "full" });
    assert.equal(store.get().statsScope, "visible");
    store.set({ statsScope: "selection" });
    assert.equal(store.get().listScope, "full");
  });
});

describe("resolveScope", () => {
  it("resolves the full range to the trace domain and the visible scope to the window", () => {
    const s = stateWithEvents();
    assert.deepEqual(resolveScope(s, "full"), { t0: 0, t1: 10 });
    assert.deepEqual(resolveScope(s, "visible"), { t0: 2, t1: 8 });
  });

  it("resolves a single selected event to a zero-length interval at its timestamp", () => {
    const s = stateWithEvents({ selectedEventIndex: 1 });
    assert.deepEqual(resolveScope(s, "selection"), { t0: 5, t1: 5 });
  });

  it("spans the anchor and the focus of a range selection, whichever way round it was made", () => {
    assert.deepEqual(
      resolveScope(stateWithEvents({ selectionAnchorIndex: 0, selectedEventIndex: 2 }), "selection"),
      { t0: 1, t1: 9 },
    );
    assert.deepEqual(
      resolveScope(stateWithEvents({ selectionAnchorIndex: 2, selectedEventIndex: 0 }), "selection"),
      { t0: 1, t1: 9 },
    );
  });

  it("reports nothing — not everything — for a selection scope with nothing selected", () => {
    assert.equal(resolveScope(stateWithEvents(), "selection"), null);
    assert.equal(inScope(null, 5), false);
  });

  it("counts both endpoints as in scope", () => {
    const w = { t0: 2, t1: 8 };
    assert.equal(inScope(w, 2), true);
    assert.equal(inScope(w, 8), true);
    assert.equal(inScope(w, 1.9), false);
    assert.equal(inScope(w, 8.1), false);
  });
});

describe("lane group quick filters", () => {
  const system = QUICK_FILTERS.find((f) => f.key === "system")!;
  const tasks = QUICK_FILTERS.find((f) => f.key === "tasks")!;

  it("starts with every filter on", () => {
    const off = new Set<string>();
    for (const f of QUICK_FILTERS) assert.ok(quickFilterOn(off, f), f.key);
  });

  it("switches every group a filter covers off and back on together", () => {
    assert.ok(system.groups.length > 1); // System covers the scheduler spans and the idle lanes
    const off = toggleQuickFilter(new Set(), system);
    assert.deepEqual([...off].sort(), [...system.groups].sort());
    assert.equal(quickFilterOn(off, system), false);
    assert.equal(quickFilterOn(off, tasks), true); // the other filters are untouched

    assert.equal(toggleQuickFilter(off, system).size, 0);
  });

  it("switches a partly-off filter fully on, so one click always reaches a definite state", () => {
    const half = new Set([system.groups[0]!]);
    assert.equal(quickFilterOn(half, system), false);
    assert.equal(toggleQuickFilter(half, system).size, 0);
  });

  it("leaves the input set alone", () => {
    const off = new Set<string>();
    toggleQuickFilter(off, tasks);
    assert.equal(off.size, 0);
  });
});
