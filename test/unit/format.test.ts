/**
 * Unit tests for the time-string parser ({@link parseTime}) — the inverse of
 * {@link formatDuration} used by the "Go to timestamp" input.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { formatDuration, formatTime, parseTime } from "../../web/core/format.js";

/** Assert a parse result is finite and within a float-error tolerance of `want`. */
function near(got: number | null, want: number): void {
  assert.ok(got !== null && Math.abs(got - want) <= Math.abs(want) * 1e-9 + 1e-15, `${got} ≈ ${want}`);
}

describe("parseTime", () => {
  it("reads a bare number as seconds", () => {
    assert.equal(parseTime("1.5"), 1.5);
    assert.equal(parseTime("0"), 0);
    assert.equal(parseTime(".25"), 0.25);
  });

  it("applies SI suffixes", () => {
    assert.equal(parseTime("1.5 s"), 1.5);
    near(parseTime("1.5ms"), 1.5e-3);
    near(parseTime("100us"), 100e-6);
    near(parseTime("100µs"), 100e-6);
    near(parseTime("12ns"), 12e-9);
  });

  it("ignores spacing, including the thin space the formatter emits", () => {
    near(parseTime("1 234.5 ms"), 1234.5e-3);
    near(parseTime(" 2ms "), 2e-3);
  });

  it("accepts scientific notation and a sign", () => {
    near(parseTime("1e-3"), 1e-3);
    near(parseTime("-5us"), -5e-6);
  });

  it("rejects blank or unparseable input", () => {
    assert.equal(parseTime(""), null);
    assert.equal(parseTime("   "), null);
    assert.equal(parseTime("abc"), null);
    assert.equal(parseTime("5 minutes"), null);
    assert.equal(parseTime("1.2.3"), null);
  });

  it("round-trips a formatted duration back to (about) its value", () => {
    const parsed = parseTime(formatDuration(1.5e-3)); // "1.500 ms"
    assert.ok(parsed !== null && Math.abs(parsed - 1.5e-3) < 1e-12);
  });
});

describe("formatTime at timer-tick resolution", () => {
  it("keeps the 3-decimal default when the tick is unknown (resolution 0)", () => {
    assert.equal(formatTime(1.2345678), "1.235 s");
    assert.equal(formatTime(1.2345678e-3), "1.235 ms");
  });

  it("shows exactly as many decimals as the resolution needs", () => {
    assert.equal(formatTime(1.23456789, 1e-6), "1.234568 s"); // 1 µs → 6 decimals of s
    assert.equal(formatTime(1.23456789, 1e-7), "1.2345679 s"); // 100 ns → 7
    assert.equal(formatTime(1.23456789, 1e-8), "1.23456789 s"); // 10 ns → 8
    assert.equal(formatTime(1.23456789e-3, 1e-6), "1.235 ms"); // 1 µs → 3 decimals of ms
    assert.equal(formatTime(1.23456789e-3, 1e-8), "1.23457 ms"); // 10 ns → 5
  });

  it("resolves a non-power-of-ten tick (80 MHz → 12.5 ns) without losing a step", () => {
    const tick = 1 / 80e6;
    assert.equal(formatTime(2 * tick, tick), "25 ns"); // ns unit already ≤ tick
    assert.equal(formatTime(1e-3 + 3 * tick, tick), "1.00004 ms"); // ceil → 5 decimals (10 ns step ≤ tick)
  });

  it("quantizes the value to the resolution before formatting", () => {
    assert.equal(formatTime(1.2345678e-3, 1e-5), "1.23 ms"); // snapped to 10 µs steps
    assert.equal(formatTime(4.9e-7, 1e-6), "0 s"); // below half a step rounds to zero
  });
});
