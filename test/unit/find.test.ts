/**
 * Unit tests for content search: the match predicate over event names,
 * contexts, and parameters, match list generation across filtered indices,
 * and match navigation with wrapping.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { TraceEvent } from "../../src/trace/index.js";
import {
  findMatches,
  firstMatchPos,
  matchesQuery,
  nextMatchPos,
  prevMatchPos,
  searchableText,
} from "../../web/core/find.js";

/** A minimal event with overridable fields. */
function ev(over: Partial<TraceEvent>): TraceEvent {
  return {
    id: 0,
    coreId: 0,
    name: "svNop",
    ts: 0,
    tsDelta: 0,
    plen: 0,
    params: {},
    ctxName: "IDLE0",
    inIrq: false,
    ...over,
  };
}

describe("searchableText / matchesQuery", () => {
  const e = ev({ name: "svTaskStartExec", ctxName: "IP_Task", params: { tid: 5663, prio: 152 } });

  it("matches against event name, context, and params (case-insensitive)", () => {
    assert.ok(matchesQuery(e, "taskstart")); // name
    assert.ok(matchesQuery(e, "ip_task")); // context, lowercased
    assert.ok(matchesQuery(e, "tid=5663")); // key=value
    assert.ok(matchesQuery(e, "5663")); // bare param value
    assert.ok(!matchesQuery(e, "zzz"));
  });

  it("renders address-run params as hex for search", () => {
    const stack = ev({ name: "svStackInfo", params: { addrs: [0x4000_1234, 0xdead_beef] } });
    assert.ok(searchableText(stack).includes("0x40001234"));
    assert.ok(matchesQuery(stack, "0xdeadbeef"));
  });
});

describe("findMatches", () => {
  const events = [
    ev({ name: "svTaskStartExec", ctxName: "IP_Task" }), // 0
    ev({ name: "svIsrEnter", ctxName: "IRQ#7" }), // 1
    ev({ name: "svTaskStartExec", ctxName: "LED_Task" }), // 2
    ev({ name: "svIdle", ctxName: "IDLE0" }), // 3
    ev({ name: "svTaskStopExec", ctxName: "IP_Task" }), // 4
  ];

  it("returns ascending absolute indices of all matches", () => {
    assert.deepEqual(findMatches(events, "task", null), [0, 2, 4]);
    assert.deepEqual(findMatches(events, "ip_task", null), [0, 4]);
  });

  it("is inert for a blank query", () => {
    assert.deepEqual(findMatches(events, "", null), []);
    assert.deepEqual(findMatches(events, "   ", null), []);
  });

  it("searches only the visible (filtered) set when given an index list", () => {
    // Visible = indices {0, 3, 4} — index 2 (the LED_Task match) is filtered out.
    const visible = Int32Array.from([0, 3, 4]);
    assert.deepEqual(findMatches(events, "task", visible), [0, 4]);
  });
});

describe("match cursoring (next / prev / first) with wrap", () => {
  const matches = [2, 5, 9];

  it("resolves the match index at or after the current selection", () => {
    assert.equal(firstMatchPos(matches, null), 0);
    assert.equal(firstMatchPos(matches, 0), 0); // before first → first
    assert.equal(firstMatchPos(matches, 5), 1); // on a match → returns current index
    assert.equal(firstMatchPos(matches, 6), 2); // between → next
    assert.equal(firstMatchPos(matches, 100), 0); // past last → wrap to first
    assert.equal(firstMatchPos([], 3), -1);
  });

  it("nextMatchPos steps strictly forward and wraps", () => {
    assert.equal(nextMatchPos(matches, null), 0);
    assert.equal(nextMatchPos(matches, 2), 1); // from a match → the next
    assert.equal(nextMatchPos(matches, 9), 0); // from the last → wrap
    assert.equal(nextMatchPos(matches, 3), 1); // from between → next above
    assert.equal(nextMatchPos([], 1), -1);
  });

  it("prevMatchPos steps strictly backward and wraps", () => {
    assert.equal(prevMatchPos(matches, null), 2);
    assert.equal(prevMatchPos(matches, 5), 0); // from a match → the previous
    assert.equal(prevMatchPos(matches, 2), 2); // from the first → wrap to last
    assert.equal(prevMatchPos(matches, 6), 1); // from between → prev below
    assert.equal(prevMatchPos([], 1), -1);
  });
});
