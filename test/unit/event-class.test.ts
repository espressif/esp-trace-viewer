/**
 * Unit tests for the event classifier (`web/core/event-class.ts`): the
 * id-to-EventClass mapping used by row colors, the Event Filter menu, and
 * the filter predicate.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles, type TraceEvent } from "../../src/trace/index.js";
import {
  ALL_EVENT_CLASSES,
  classifyEvent,
  EVENT_CLASS_LABELS,
} from "../../web/core/event-class.js";

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

const fixture = (): TraceEvent[] =>
  parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]).events;

describe("classifyEvent", () => {
  it("maps interrupt and timer ids to isr", () => {
    for (const id of [2, 3, 18, 19, 20]) assert.equal(classifyEvent(ev({ id })), "isr");
  });

  it("maps scheduling / lifecycle ids to task", () => {
    for (const id of [4, 5, 6, 7, 8, 9, 17, 21]) assert.equal(classifyEvent(ev({ id })), "task");
  });

  it("maps svPrint (id 26) to message", () => {
    assert.equal(classifyEvent(ev({ id: 26, name: "svPrint" })), "message");
  });

  it("maps user markers (id 15/16) to the generic event class", () => {
    assert.equal(classifyEvent(ev({ id: 15 })), "event");
    assert.equal(classifyEvent(ev({ id: 16 })), "event");
  });

  it("maps remaining predefined meta ids to system", () => {
    for (const id of [0, 1, 10, 11, 12, 13, 14, 22, 23, 24, 25, 27]) {
      assert.equal(classifyEvent(ev({ id })), "system");
    }
  });

  it("maps anything above the predefined range to api", () => {
    for (const id of [32, 83, 512, 1034]) assert.equal(classifyEvent(ev({ id })), "api");
  });
});

describe("class table", () => {
  it("lists six classes in menu order, each with a label", () => {
    assert.deepEqual([...ALL_EVENT_CLASSES], ["api", "isr", "message", "system", "task", "event"]);
    for (const c of ALL_EVENT_CLASSES) assert.ok(EVENT_CLASS_LABELS[c].length > 0);
  });
});

describe("dual-core demo capture", () => {
  it("classifies every svPrint line as message (and there are some)", () => {
    const prints = fixture().filter((e) => e.name === "svPrint");
    assert.ok(prints.length > 0, "expected svPrint lines in the fixture");
    for (const e of prints) assert.equal(classifyEvent(e), "message");
  });
});
