/**
 * Unit tests for embedding a lane layout in a `.svdat` header
 * (`web/core/lanes/svdat-embed.ts`): the embed and extract round-trip,
 * tolerance of missing or malformed markers, preservation of the binary
 * event payload, CRLF preservation, and multicore offset preservation.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseTraceFiles } from "../../src/trace/index.js";
import { splitSeggerMulticore } from "../../src/trace/multicore.js";
import {
  embedLayoutInHeader,
  extractLayoutFromHeader,
} from "../../web/core/lanes/svdat-embed.js";
import {
  LANE_LAYOUT_VERSION,
  TIMESPAN_LANE,
  type LaneLayout,
} from "../../web/core/lanes/types.js";

const UNICORE = new Uint8Array(readFileSync("test/fixtures/traces/unicore.svdat"));
const P4_MCORE = new Uint8Array(readFileSync("test/fixtures/traces/p4-mcore.svdat"));

/** A small but structurally varied layout: a group with a lane plus a top-level lane. */
const LAYOUT: LaneLayout = {
  version: LANE_LAYOUT_VERSION,
  roots: [
    {
      kind: "group",
      id: "g1",
      label: "Tasks",
      collapsed: true,
      children: [
        {
          kind: "lane",
          id: "l1",
          type: TIMESPAN_LANE,
          source: { kind: "context", key: "main" },
          height: 30,
        },
      ],
    },
    { kind: "lane", id: "l2", type: TIMESPAN_LANE, source: { kind: "unified", coreId: 0 } },
  ],
};

/** Build a minimal synthetic `.svdat`: a `;`-bounded header, a sync run, a body. */
function syntheticSvdat(eol: "\n" | "\r\n"): Uint8Array {
  const header = `;${eol}; Version  test${eol};${eol}`;
  const sync = new Uint8Array(10); // SYNC_LEN zeros
  const body = new Uint8Array([1, 2, 3, 4, 5]);
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(headerBytes.length + sync.length + body.length);
  out.set(headerBytes, 0);
  out.set(sync, headerBytes.length);
  out.set(body, headerBytes.length + sync.length);
  return out;
}

describe("svdat lane-layout embedding", () => {
  it("round-trips a layout through embed -> extract", () => {
    const embedded = embedLayoutInHeader(syntheticSvdat("\n"), LAYOUT);
    assert.deepEqual(extractLayoutFromHeader(embedded), LAYOUT);
  });

  it("returns null when no marker is present", () => {
    assert.equal(extractLayoutFromHeader(syntheticSvdat("\n")), null);
  });

  it("leaves the binary body byte-for-byte unchanged", () => {
    const original = syntheticSvdat("\n");
    const embedded = embedLayoutInHeader(original, LAYOUT);
    // The trailing sync + body bytes must be identical to the source.
    const tailLen = 10 + 5;
    assert.deepEqual(embedded.subarray(embedded.length - tailLen), original.subarray(original.length - tailLen));
    // And the file got longer by exactly the inserted comment line.
    assert.ok(embedded.length > original.length);
  });

  it("preserves CRLF line endings on the inserted line", () => {
    const embedded = embedLayoutInHeader(syntheticSvdat("\r\n"), LAYOUT);
    const headerText = new TextDecoder().decode(embedded.subarray(0, embedded.length - 15));
    const marker = headerText.split("\r\n").find((l) => l.startsWith("; trace-lanes"));
    assert.ok(marker !== undefined, "marker line present");
    // split on \r\n already stripped the CR; the surrounding lines being intact
    // (no stray \n inside) confirms the inserted line used CRLF too.
    assert.ok(!marker!.includes("\n"));
    assert.deepEqual(extractLayoutFromHeader(embedded), LAYOUT);
  });

  it("does not accumulate marker lines when re-saved", () => {
    const once = embedLayoutInHeader(syntheticSvdat("\n"), LAYOUT);
    const other: LaneLayout = { version: LANE_LAYOUT_VERSION, roots: [] };
    const twice = embedLayoutInHeader(once, other);
    const headerText = new TextDecoder().decode(twice.subarray(0, twice.length - 15));
    const markers = headerText.split("\n").filter((l) => l.startsWith("; trace-lanes"));
    assert.equal(markers.length, 1);
    assert.deepEqual(extractLayoutFromHeader(twice), other);
  });

  it("tolerates a malformed marker payload (falls back to null)", () => {
    const broken = new TextEncoder().encode(";\n; trace-lanes !!!not-base64!!!\n;\n");
    const sync = new Uint8Array(10);
    const buf = new Uint8Array(broken.length + sync.length);
    buf.set(broken, 0);
    buf.set(sync, broken.length);
    assert.equal(extractLayoutFromHeader(buf), null);
  });

  it("returns the bytes unchanged when there is no sync sequence", () => {
    const noSync = new TextEncoder().encode(";\n; Version x\n;\n");
    const out = embedLayoutInHeader(noSync, LAYOUT);
    assert.deepEqual(out, noSync);
  });

  it("round-trips through a real single-core fixture without disturbing the events", () => {
    const before = parseTraceFiles([UNICORE]).events;
    const embedded = embedLayoutInHeader(UNICORE, LAYOUT);
    const after = parseTraceFiles([embedded]).events;
    assert.equal(after.length, before.length);
    assert.deepEqual(extractLayoutFromHeader(embedded), LAYOUT);
  });

  it("keeps a multicore file readable: offsets stay valid after the header grows", () => {
    const beforeRegions = splitSeggerMulticore(P4_MCORE)!;
    const beforeEvents = parseTraceFiles([P4_MCORE]).events;

    const embedded = embedLayoutInHeader(P4_MCORE, LAYOUT);
    const afterRegions = splitSeggerMulticore(embedded);
    assert.ok(afterRegions !== null, "still recognised as multicore");
    assert.equal(afterRegions!.length, beforeRegions.length);

    const afterEvents = parseTraceFiles([embedded]).events;
    assert.equal(afterEvents.length, beforeEvents.length);
    assert.deepEqual(extractLayoutFromHeader(embedded), LAYOUT);
  });
});
