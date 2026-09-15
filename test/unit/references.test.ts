/**
 * Unit tests for reference markers (`web/core/references.ts`):
 * marker set management (add, toggle, clear, and identifier allocation)
 * and delta measurements (time and event-count deltas) against synthetic
 * timestamps and fixture trace data.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles } from "../../src/trace/index.js";
import {
  clearReferences,
  deltaSpan,
  eventsInRange,
  measureReferences,
  nextReferenceId,
  sortedByTime,
  toggleReference,
} from "../../web/core/references.js";
import type { ReferenceMarker } from "../../web/core/store.js";

const R = (id: number, time: number): ReferenceMarker => ({ id, time });

describe("nextReferenceId", () => {
  it("starts at 1 and is one past the current maximum", () => {
    assert.equal(nextReferenceId([]), 1);
    assert.equal(nextReferenceId([R(1, 0), R(2, 1)]), 3);
    // Robust to gaps / unsorted ids — it tracks the max, not the length.
    assert.equal(nextReferenceId([R(5, 0), R(2, 1)]), 6);
  });
});

describe("toggleReference", () => {
  it("adds a marker at the cursor time when none is near", () => {
    const out = toggleReference([], 0.001);
    assert.deepEqual(out, [{ id: 1, time: 0.001 }]);
  });

  it("appends with a fresh id, preserving order", () => {
    const a = toggleReference([], 1);
    const b = toggleReference(a, 2);
    assert.deepEqual(b, [{ id: 1, time: 1 }, { id: 2, time: 2 }]);
  });

  it("removes an existing marker within tolerance (toggle off)", () => {
    const refs = [R(1, 1), R(2, 2)];
    const out = toggleReference(refs, 2, 1e-9);
    assert.deepEqual(out, [R(1, 1)]);
  });

  it("removes only the nearest within tolerance, keeps the rest", () => {
    const refs = [R(1, 1.0), R(2, 1.4), R(3, 3.0)];
    const out = toggleReference(refs, 1.35, 0.1);
    assert.deepEqual(out.map((r) => r.id), [1, 3]);
  });

  it("with zero tolerance only collapses an exact-time match", () => {
    const refs = [R(1, 1)];
    assert.equal(toggleReference(refs, 1.0000001, 0).length, 2); // not exact → add
    assert.equal(toggleReference(refs, 1, 0).length, 0); // exact → remove
  });

  it("returns a fresh array (immutability)", () => {
    const refs = [R(1, 1)];
    const out = toggleReference(refs, 2);
    assert.notEqual(out, refs);
    assert.deepEqual(refs, [R(1, 1)]); // input untouched
  });
});

describe("clearReferences", () => {
  it("returns an empty array", () => {
    assert.deepEqual(clearReferences(), []);
  });
});

describe("sortedByTime", () => {
  it("orders by ascending time without mutating the input", () => {
    const refs = [R(1, 3), R(2, 1), R(3, 2)];
    assert.deepEqual(sortedByTime(refs).map((r) => r.id), [2, 3, 1]);
    assert.deepEqual(refs.map((r) => r.id), [1, 2, 3]);
  });
});

describe("eventsInRange", () => {
  const ts = [0, 1, 1, 2, 3, 5, 8];
  it("counts events in the half-open [lo, hi)", () => {
    assert.equal(eventsInRange(ts, 1, 3), 3); // the two 1s and the 2 (3 excluded)
    assert.equal(eventsInRange(ts, 0, 9), ts.length);
    assert.equal(eventsInRange(ts, 5, 5), 0); // empty range
  });
  it("is order-independent in its bounds", () => {
    assert.equal(eventsInRange(ts, 3, 1), eventsInRange(ts, 1, 3));
  });
  it("handles bounds outside the data", () => {
    assert.equal(eventsInRange(ts, -10, -1), 0);
    assert.equal(eventsInRange(ts, 100, 200), 0);
  });
});

describe("deltaSpan", () => {
  it("orders endpoints and reports dt + event count", () => {
    const ts = [0, 1, 2, 3];
    const s = deltaSpan(3, 1, ts);
    assert.equal(s.from, 1);
    assert.equal(s.to, 3);
    assert.equal(s.dt, 2);
    assert.equal(s.events, 2); // ts 1 and 2 (3 excluded)
  });
});

describe("measureReferences", () => {
  const ts = [0, 1, 2, 3, 4, 5];
  it("yields nothing useful for zero or one reference without a cursor", () => {
    assert.deepEqual(measureReferences([], null, ts), { refs: [], spans: [], toCursor: null });
    const one = measureReferences([R(1, 2)], null, ts);
    assert.deepEqual(one.refs, [2]);
    assert.equal(one.spans.length, 0);
    assert.equal(one.toCursor, null);
  });

  it("computes adjacent-pair Δs in time order", () => {
    const m = measureReferences([R(1, 4), R(2, 1)], null, ts);
    assert.deepEqual(m.refs, [1, 4]);
    assert.equal(m.spans.length, 1);
    assert.equal(m.spans[0]!.dt, 3);
    assert.equal(m.spans[0]!.events, 3); // ts 1,2,3
  });

  it("measures the nearest reference to a cursor right of every mark", () => {
    const m = measureReferences([R(1, 1), R(2, 2)], 4.5, ts);
    assert.equal(m.toCursor!.from, 2);
    assert.equal(m.toCursor!.to, 4.5);
    assert.equal(m.toCursor!.dt, 2.5);
    assert.equal(m.toCursor!.events, 3); // ts 2,3,4 (cursor 4.5 excludes 5)
  });

  it("measures the nearest reference to a cursor left of every mark", () => {
    const m = measureReferences([R(1, 3), R(2, 4)], 0.5, ts);
    assert.equal(m.toCursor!.from, 0.5);
    assert.equal(m.toCursor!.to, 3);
    assert.equal(m.toCursor!.dt, 2.5);
  });

  it("measures the nearest reference to a cursor between marks", () => {
    const m = measureReferences([R(1, 0), R(2, 4)], 3, ts);
    assert.equal(m.toCursor!.from, 3);
    assert.equal(m.toCursor!.to, 4);
    assert.equal(m.toCursor!.dt, 1);
  });

  it("suppresses the cursor span when the cursor coincides with its nearest reference", () => {
    const m = measureReferences([R(1, 1), R(2, 2)], 2, ts);
    assert.equal(m.toCursor, null);
  });
});

// Event-index deltas against real fixture timestamps: the binary-search count
// must match a brute-force filter over the committed dual-core demo trace.
describe("event-index deltas with dual-core demo capture", () => {
  const events = parseTraceFiles([
    new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat")),
  ]).events;
  const ts = events.map((e) => e.ts);

  it("matches a brute-force count over a mid-trace window", () => {
    const lo = ts[Math.floor(ts.length * 0.25)]!;
    const hi = ts[Math.floor(ts.length * 0.75)]!;
    const brute = ts.filter((t) => t >= lo && t < hi).length;
    assert.equal(eventsInRange(ts, lo, hi), brute);
    assert.equal(deltaSpan(hi, lo, ts).events, brute);
  });

  it("counts the whole trace between its first and last timestamps", () => {
    const last = ts[ts.length - 1]!;
    // [first, last) excludes the final event(s) sharing the last timestamp.
    const brute = ts.filter((t) => t >= ts[0]! && t < last).length;
    assert.equal(eventsInRange(ts, ts[0]!, last), brute);
  });
});
