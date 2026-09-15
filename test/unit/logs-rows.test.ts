/**
 * Unit tests for the Logs list row model (`web/ui/panes/logs-rows.ts`):
 * log event detection (`svPrint`), event-to-terminal-line projection
 * (timestamp, context, message extraction), and filtered line generation.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles, type TraceEvent } from "../../src/trace/index.js";
import { formatTime } from "../../web/core/format.js";
import {
  buildLogLines,
  eventToLogLine,
  isLogEvent,
  LOG_EVENT_NAME,
} from "../../web/ui/panes/logs-rows.js";
import type { Filters } from "../../web/core/store.js";

/** A minimal event with overridable fields, for predicate/format unit cases. */
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

const noFilter: Filters = { text: "", cores: new Set(), classes: new Set() };

const fixture = (): TraceEvent[] =>
  parseTraceFiles([new Uint8Array(readFileSync("test/fixtures/traces/dualcore.svdat"))]).events;

describe("isLogEvent", () => {
  it("accepts svPrint events carrying a string message", () => {
    assert.equal(isLogEvent(ev({ name: LOG_EVENT_NAME, params: { msg: "hi" } })), true);
  });

  it("rejects non-print events and print events without a string message", () => {
    assert.equal(isLogEvent(ev({ name: "svTaskStartExec", params: { tid: 1 } })), false);
    assert.equal(isLogEvent(ev({ name: LOG_EVENT_NAME, params: {} })), false);
    assert.equal(isLogEvent(ev({ name: LOG_EVENT_NAME, params: { msg: 42 } })), false);
  });
});

describe("eventToLogLine", () => {
  it("extracts the timestamp, context, and verbatim message + source index", () => {
    const e = ev({
      name: LOG_EVENT_NAME,
      ts: 0.5,
      ctxName: "IP_Task",
      params: { msg: "WebS: Get /Logo.gif", lvl: 0 },
    });
    const line = eventToLogLine(e, 1234);
    assert.equal(line.eventIndex, 1234);
    assert.equal(line.ctx, "IP_Task");
    assert.equal(line.msg, "WebS: Get /Logo.gif");
    assert.equal(line.ts, formatTime(0.5));
  });

  it("preserves message text verbatim (leading/trailing whitespace kept)", () => {
    const e = ev({ name: LOG_EVENT_NAME, params: { msg: "  spaced \t" } });
    assert.equal(eventToLogLine(e, 0).msg, "  spaced \t");
  });
});

describe("buildLogLines", () => {
  it("keeps only log events, in timeline order, tagged with their event index", () => {
    const events = [
      ev({ name: "svTaskStartExec", params: { tid: 1 } }),
      ev({ name: LOG_EVENT_NAME, ctxName: "A", params: { msg: "first" } }),
      ev({ name: "svIsrExit" }),
      ev({ name: LOG_EVENT_NAME, ctxName: "B", params: { msg: "second" } }),
    ];
    const lines = buildLogLines(events, noFilter);
    assert.deepEqual(
      lines.map((l) => [l.eventIndex, l.ctx, l.msg]),
      [
        [1, "A", "first"],
        [3, "B", "second"],
      ],
    );
  });

  it("honours the active core filter", () => {
    const events = [
      ev({ name: LOG_EVENT_NAME, coreId: 0, params: { msg: "core0" } }),
      ev({ name: LOG_EVENT_NAME, coreId: 1, params: { msg: "core1" } }),
    ];
    const lines = buildLogLines(events, { text: "", cores: new Set([1]), classes: new Set() });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.msg, "core0"); // core 1 is the one switched off
  });
});

describe("dual-core demo capture", () => {
  it("extracts every svPrint line, in order, matching the parser's decode", () => {
    const events = fixture();
    const lines = buildLogLines(events, noFilter);

    // The fixture is the dual-core demo web-server demo, which logs via svPrint.
    assert.ok(lines.length > 0, "expected some svPrint log lines in the fixture");

    // Every built line corresponds, in order, to an svPrint event, and the
    // projection reproduces exactly what the parser decoded for it.
    const expected = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => isLogEvent(e));
    assert.equal(lines.length, expected.length);
    for (let k = 0; k < expected.length; k++) {
      const { e, i } = expected[k]!;
      const line = lines[k]!;
      assert.equal(line.eventIndex, i);
      assert.equal(line.ctx, e.ctxName);
      assert.equal(line.msg, e.params["msg"]);
      assert.equal(line.ts, formatTime(e.ts));
    }

    // Clicking a line must be able to recover the exact source event.
    const first = lines[0]!;
    assert.equal(events[first.eventIndex]!.name, LOG_EVENT_NAME);
    assert.equal(typeof first.msg, "string");
    assert.ok(first.msg.length > 0);
  });
});
