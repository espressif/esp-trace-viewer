/**
 * Unit tests for trace save target calculations (`web/core/save-trace.ts`):
 * pairing trace buffers with filenames and extension normalization.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { saveTargets } from "../../web/core/save-trace.js";

const bytes = (n: number): Uint8Array => new Uint8Array(n);

describe("saveTargets", () => {
  it("keeps the source filename for a single buffer", () => {
    const targets = saveTargets([bytes(4)], ["dualcore.svdat"]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.name, "dualcore.svdat");
    assert.equal(targets[0]!.bytes.length, 4);
  });

  it("pairs each buffer of a per-core capture with its own name, in order", () => {
    const targets = saveTargets([bytes(1), bytes(2)], ["core0.svdat", "core1.svdat"]);
    assert.deepEqual(
      targets.map((t) => t.name),
      ["core0.svdat", "core1.svdat"],
    );
    assert.equal(targets[0]!.bytes.length, 1);
    assert.equal(targets[1]!.bytes.length, 2);
  });

  it("falls back to trace.svdat for a single unnamed buffer", () => {
    assert.equal(saveTargets([bytes(1)])[0]!.name, "trace.svdat");
    assert.equal(saveTargets([bytes(1)], [""])[0]!.name, "trace.svdat");
    assert.equal(saveTargets([bytes(1)], ["   "])[0]!.name, "trace.svdat");
  });

  it("numbers the fallback when several buffers are unnamed", () => {
    assert.deepEqual(
      saveTargets([bytes(1), bytes(1)]).map((t) => t.name),
      ["trace-0.svdat", "trace-1.svdat"],
    );
  });

  it("forces an .svdat extension on a bare name", () => {
    assert.equal(saveTargets([bytes(1)], ["capture"])[0]!.name, "capture.svdat");
    // An existing extension (any case) is left intact.
    assert.equal(saveTargets([bytes(1)], ["trace.SVDAT"])[0]!.name, "trace.SVDAT");
  });
});
