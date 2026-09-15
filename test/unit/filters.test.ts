/**
 * Unit tests for Event Filter state transitions (`web/core/filters.ts`) and
 * the filter predicate (`web/ui/panes/events-rows.ts`). Tests toggle, solo,
 * and reset operations against synthetic and fixture event data.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles, type TraceEvent } from "../../src/trace/index.js";
import {
  ALL_EVENT_CLASSES,
  classifyEvent,
  type EventClass,
} from "../../web/core/event-class.js";
import { classHidden, coreHidden, isSolo, resetFilters, soloClass, toggleClass, toggleCore } from "../../web/core/filters.js";
import type { Filters } from "../../web/core/store.js";
import { buildVisibleIndices, eventMatchesFilters, filtersActive } from "../../web/ui/panes/events-rows.js";

/** A filter with overridable parts (no constraint by default). */
function F(over: Partial<Filters> = {}): Filters {
  return { text: "", cores: new Set(), classes: new Set(), ...over };
}

const fixture = (): TraceEvent[] =>
  parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]).events;

/** Count events of each class. */
function countByClass(events: TraceEvent[]): Map<EventClass, number> {
  const m = new Map<EventClass, number>();
  for (const e of events) m.set(classifyEvent(e), (m.get(classifyEvent(e)) ?? 0) + 1);
  return m;
}

describe("toggleCore", () => {
  it("switches a core off and back on, immutably", () => {
    const off = toggleCore(F(), 1);
    assert.ok(coreHidden(off, 1));
    assert.ok(!coreHidden(off, 0));
    assert.deepEqual([...F().cores], []); // the input is untouched

    const on = toggleCore(off, 1);
    assert.ok(!coreHidden(on, 1));
    assert.equal(on.cores.size, 0);
  });

  it("switching every core off is a real state, not a reset", () => {
    const none = toggleCore(toggleCore(F(), 0), 1);
    assert.deepEqual([...none.cores].sort(), [0, 1]);
    assert.ok(coreHidden(none, 0) && coreHidden(none, 1));
  });
});

describe("toggleClass", () => {
  it("hides a visible class and shows it again, immutably", () => {
    const a = toggleClass(F(), "isr");
    assert.ok(classHidden(a, "isr"));
    assert.equal(a.classes.size, 1);
    const b = toggleClass(a, "isr");
    assert.equal(b.classes.size, 0);
    assert.ok(!classHidden(b, "isr"));
  });

  it("leaves text and cores untouched", () => {
    const f = toggleClass(F({ text: "queue", cores: new Set([1]) }), "api");
    assert.equal(f.text, "queue");
    assert.deepEqual([...f.cores], [1]);
  });
});

describe("soloClass", () => {
  it("hides every other class", () => {
    const f = soloClass(F(), "isr");
    assert.ok(isSolo(f, "isr"));
    assert.equal(f.classes.size, ALL_EVENT_CLASSES.length - 1);
    assert.ok(!classHidden(f, "isr"));
    for (const c of ALL_EVENT_CLASSES) if (c !== "isr") assert.ok(classHidden(f, c));
  });

  it("soloing the already-soloed class restores all", () => {
    const solo = soloClass(F(), "message");
    const back = soloClass(solo, "message");
    assert.equal(back.classes.size, 0);
    assert.ok(!isSolo(back, "message"));
  });
});

describe("resetFilters", () => {
  it("clears classes, text, and cores", () => {
    const f = resetFilters();
    assert.equal(f.text, "");
    assert.equal(f.cores.size, 0);
    assert.equal(f.classes.size, 0);
    assert.equal(filtersActive(f), false);
  });
});

describe("predicate filtering with dual-core demo capture", () => {
  it("hiding a class excludes exactly that class's events", () => {
    const events = fixture();
    const counts = countByClass(events);

    const hideIsr = F({ classes: new Set<EventClass>(["isr"]) });
    const idx = buildVisibleIndices(events, hideIsr);
    assert.ok(idx);
    assert.equal(idx!.length, events.length - (counts.get("isr") ?? 0));
    // None of the surviving events is an ISR; order is preserved.
    for (const i of idx!) assert.notEqual(classifyEvent(events[i]!), "isr");
  });

  it("solo keeps only the chosen class (count == that class's tally)", () => {
    const events = fixture();
    const counts = countByClass(events);

    for (const only of ["isr", "task", "message", "system", "api"] as EventClass[]) {
      const idx = buildVisibleIndices(events, soloClass(F(), only));
      assert.ok(idx, `solo ${only} should be an active filter`);
      assert.equal(idx!.length, counts.get(only) ?? 0, `solo ${only} count`);
      for (const i of idx!) assert.equal(classifyEvent(events[i]!), only);
    }
  });

  it("reset shows every event again (no filter)", () => {
    const events = fixture();
    // A reset is not an active filter, so the visible order is the identity.
    assert.equal(buildVisibleIndices(events, resetFilters()), null);
    assert.equal(filtersActive(resetFilters()), false);
  });

  it("class and core filters compose", () => {
    const events = fixture();
    const f = F({ classes: new Set<EventClass>(["isr"]), cores: new Set([0]) });
    for (const e of events) {
      const expected = e.coreId !== 0 && classifyEvent(e) !== "isr";
      assert.equal(eventMatchesFilters(e, f), expected);
    }
  });
});
