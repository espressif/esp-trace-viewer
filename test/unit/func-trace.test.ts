/**
 * Tests for decoding the ESP-IDF function-instrumentation module.
 *
 * Covers:
 *  - Automatic decoding from the `svModuleDesc` over the JTAG/app_trace
 *    transport, via both the known-module table and generic inline
 *    event-descriptor parser, as well as fallback behavior when the
 *    descriptor is missing.
 *  - Symbolization of `func` and `call_site` addresses in the Events pane's
 *    Detail column against a loaded ELF symbol table.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  parseModuleDescEvents,
  parseTraceFiles,
  parseCoreStream,
  EVTID,
} from "../../src/trace/index.js";
import { ElfSymbols, parseElfSymbols } from "../../src/elf/index.js";
import { formatDetail } from "../../web/ui/panes/events-rows.js";
import { buildFuncTraceData } from "../../web/ui/panes/functrace-rows.js";

// ---------------------------------------------------------------------------
// Byte-stream builders (the same encodings trace-parser.test.ts uses).
// ---------------------------------------------------------------------------

/** LEB128 7-bit-per-byte unsigned varint, as the stream uses for u32 and deltas. */
function u32(v: number): number[] {
  const out: number[] = [];
  let n = v >>> 0;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** Length-prefixed UTF-8 string (short form; <0xFF bytes). */
function str(s: string): number[] {
  const bytes = [...Buffer.from(s, "utf8")];
  assert.ok(bytes.length < 0xff, "test helper only emits short strings");
  return [bytes.length, ...bytes];
}

/** Explicit payload length (1 byte, or 2 if >= 0x80). */
function plen(v: number): number[] {
  if (v < 0x80) return [v];
  return [(v & 0x7f) | 0x80, v >> 7];
}

/** Encode an event id header (1 byte, or 2 bytes when >= 128). */
function eventId(id: number): number[] {
  if (id < 0x80) return [id];
  return [(id & 0x7f) | 0x80, id >> 7];
}

/** Assemble one event: id header, optional plen (id >= 24), payload, then delta. */
function event(id: number, payload: number[], delta: number): number[] {
  const head = eventId(id);
  const len = id >= 24 ? plen(payload.length) : [];
  return [...head, ...len, ...payload, ...u32(delta)];
}

const HEADER =
  ";\n; Version     SEGGER SystemViewer V2.42\n; Author      Espressif Inc\n;\n";

/** Build a full SVDAT buffer: textual header, sync sequence, then the events. */
function svdat(...eventBytes: number[][]): Uint8Array {
  const head = [...Buffer.from(HEADER, "utf8")];
  const sync = new Array(10).fill(0);
  return Uint8Array.from([...head, ...sync, ...eventBytes.flat()]);
}

// Registered sModule string from esp_sysview's function_trace_sysview.c,
// sent verbatim as the svModuleDesc `desc`.
const FUNC_TRACE_DESC =
  "M=ESP_FunctionTrace, " +
  "0 function_enter func=%p call_site=%p, " +
  "1 function_exit func=%p call_site=%p";

const OFF = 512;
const FUNC_ADDR = 0x40080000;
const SITE_ADDR = 0x40080123;

/** enter/exit pair at the module offset, each carrying func + call_site. */
function funcTracePair(): number[][] {
  return [
    event(OFF + 0, [...u32(FUNC_ADDR), ...u32(SITE_ADDR)], 10),
    event(OFF + 1, [...u32(FUNC_ADDR), ...u32(SITE_ADDR)], 10),
  ];
}

describe("function-instrumentation module decode", () => {
  it("auto-decodes function_enter/function_exit from an intact svModuleDesc", () => {
    const buf = svdat(
      event(EVTID.MODULEDESC, [...u32(0), ...u32(OFF), ...str(FUNC_TRACE_DESC)], 0),
      ...funcTracePair(),
    );
    const trace = parseCoreStream(buf);
    const [enter, exit] = trace.events.slice(-2);
    assert.equal(enter!.name, "function_enter");
    assert.equal(enter!.params["func"], FUNC_ADDR);
    assert.equal(enter!.params["call_site"], SITE_ADDR);
    assert.equal(exit!.name, "function_exit");
    assert.equal(exit!.params["func"], FUNC_ADDR);
  });

  it("leaves the events undecoded when the svModuleDesc is missing", () => {
    const trace = parseCoreStream(svdat(...funcTracePair()));
    assert.equal(trace.events[0]!.name, `svEvent_${OFF}`);
    assert.deepEqual(trace.events[0]!.params, {});
  });

});

describe("generic inline module-descriptor event parsing", () => {
  it("parses SEGGER sModule event descriptions into an event map", () => {
    const map = parseModuleDescEvents(
      "M=MyModule, S=Some module, 0 my_start id=%u name=%s, 1 my_stop handle=%p",
    );
    assert.ok(map);
    assert.equal(map[0]!.name, "my_start");
    assert.deepEqual(
      map[0]!.params.map((p) => [p.name, p.kind]),
      [["id", "u32"], ["name", "str"]],
    );
    assert.equal(map[1]!.name, "my_stop");
    assert.deepEqual(map[1]!.params.map((p) => [p.name, p.kind]), [["handle", "id"]]);
  });

  it("returns null for a descriptor that defines no events", () => {
    assert.equal(parseModuleDescEvents("M=Plain, V=30800"), null);
  });

  it("decodes an unknown custom module's events end-to-end from its desc", () => {
    const buf = svdat(
      event(
        EVTID.MODULEDESC,
        [...u32(1), ...u32(600), ...str("M=Custom, 0 blink led=%u state=%u")],
        0,
      ),
      event(600, [...u32(3), ...u32(1)], 5),
    );
    const trace = parseCoreStream(buf);
    const e = trace.events.at(-1)!;
    assert.equal(e.name, "blink");
    assert.deepEqual(e.params, { led: 3, state: 1 });
  });
});

describe("func-trace symbolization in the Events Detail column", () => {
  const symbols = new ElfSymbols(
    [{ value: FUNC_ADDR, size: 0x40, name: "demo_work" }],
    [],
  );

  const enter = {
    id: OFF,
    coreId: 0,
    name: "function_enter",
    ts: 0.1,
    tsDelta: 10,
    plen: 8,
    params: { func: FUNC_ADDR, call_site: SITE_ADDR + 0x1000 },
    ctxName: "main",
    inIrq: false,
  };

  it("resolves func/call_site through the loaded ELF", () => {
    const detail = formatDetail(enter, undefined, symbols);
    assert.equal(
      detail,
      "func=0x40080000 (demo_work), call_site=0x40081123",
    );
  });

  it("falls back to bare hex without an ELF", () => {
    assert.equal(formatDetail(enter), "func=0x40080000, call_site=0x40081123");
  });
});

/**
 * Regression test on the single-core demo capture, recorded over JTAG/app_trace
 * from an application whose DSP pipeline is compiled with
 * `-finstrument-functions`. The `svModuleDesc` handshake lets the module
 * decode without an offset hint, and the committed demo ELF supplies the
 * instrumented function addresses.
 */
describe("single-core demo fixture: instrumented DSP pipeline", () => {
  const FIXTURE = join(import.meta.dirname, "../fixtures/traces/unicore.svdat");
  const ELF = join(import.meta.dirname, "../fixtures/traces/unicore.elf");
  const symbols = parseElfSymbols(new Uint8Array(readFileSync(ELF)));
  const model = parseTraceFiles([new Uint8Array(readFileSync(FIXTURE))]);

  it("auto-decodes every ESP_FunctionTrace event from the svModuleDesc", () => {
    const enters = model.events.filter((e) => e.name === "function_enter");
    const exits = model.events.filter((e) => e.name === "function_exit");
    assert.equal(enters.length, 4543);
    // Three calls, dsp_task among them, were still on the stack when the capture stopped.
    assert.equal(exits.length, 4540);
    // Nothing at the module's own offsets is left undecoded (512 enter, 513 exit).
    assert.equal(model.events.filter((e) => /^svEvent_51[23]$/.test(e.name)).length, 0);
    // Every recorded func address resolves to a known instrumented function.
    for (const e of enters) {
      const name = symbols.resolve(e.params["func"] as number);
      assert.ok(!name.startsWith("0x"), `unresolved func address ${name}`);
    }
  });

  it("reconstructs call stack hierarchy per context", () => {
    const end = model.events.at(-1)!.ts;
    const data = buildFuncTraceData(model.events, end);
    const dsp = data.framesByContext.get("dsp")!;
    assert.ok(dsp, "no frames for the dsp task");
    // Only the instrumented task traces; the rest of the application does not.
    assert.deepEqual([...data.framesByContext.keys()], ["dsp"]);
    assert.equal(data.maxDepthByContext.get("dsp"), 3);
    const name = (f: { func: number }): string => symbols.resolve(f.func);
    // Depth layering: dsp_task at 0, one frame per batch under it, then the
    // filter/statistics stages, and the threshold check under those.
    assert.deepEqual(
      [...new Set(dsp.map((f) => `${f.depth}:${name(f)}`))].sort(),
      [
        "0:dsp_task",
        "1:dsp_process_batch",
        "2:batch_peak_to_peak",
        "2:fir_apply",
        "2:stats_update",
        "3:threshold_check",
      ],
    );
    // Every batch runs the FIR stage exactly once.
    const batches = dsp.filter((f) => name(f) === "dsp_process_batch");
    assert.ok(batches.length > 100, `too few batch frames (${batches.length})`);
    assert.equal(dsp.filter((f) => name(f) === "fir_apply").length, batches.length);
  });
});
