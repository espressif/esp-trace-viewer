/**
 * Tests for the standalone `.svdat` trace parser (src/trace).
 *
 * Two layers:
 *  - Synthetic streams that exercise each decode path deterministically, with
 *    no external dependencies.
 *  - An oracle comparison against IDF's committed reference output: the parser
 *    is run over `tools/esp_app_trace/test/sysview/*.svdat` and its event model
 *    is checked, event-for-event, against the `expected_output*.json` produced
 *    by `sysviewtrace_proc.py`. This proves the port matches the reference on
 *    real captures (per-core pair + combined multi-core file). Gated on
 *    IDF_PATH so the synthetic layer still runs in a bare checkout.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  isSeggerMulticore,
  parseTraceFiles,
  parseCoreStream,
  processTraces,
  resolveOsEvents,
  splitSeggerMulticore,
  EVTID,
  type ParamValue,
  type TraceEvent,
  type TraceModel,
} from "../../src/trace/index.js";
import { ElfSymbols } from "../../src/elf/index.js";
import { clampDrainSeam } from "../../src/trace/processor.js";
import { reconstructTimeline } from "../../web/ui/panes/timeline-rows.js";

// ---------------------------------------------------------------------------
// Byte-stream builders for synthetic tests.
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

/** The 32-bit pattern of a float, as SEGGER's `_EncodeFloat` would LEB128 it. */
const _f32 = new DataView(new ArrayBuffer(4));
function floatBits(v: number): number {
  _f32.setFloat32(0, v, true);
  return _f32.getUint32(0, true);
}

/** Length-prefixed UTF-8 string (short form; <0xFF bytes). */
function str(s: string): number[] {
  const bytes = [...Buffer.from(s, "utf8")];
  assert.ok(bytes.length < 0xff, "test helper only emits short strings");
  return [bytes.length, ...bytes];
}

/** Length-prefixed UTF-8 string in the long (0xFF + 2 big-endian bytes) form. */
function strLong(s: string): number[] {
  const bytes = [...Buffer.from(s, "utf8")];
  return [0xff, (bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];
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

// A self-contained stream exercising init, naming tables, tasks and ISRs.
const SYS_FREQ = 1_000_000;
function richStream(): Uint8Array {
  return svdat(
    event(EVTID.TRACE_START, [], 0),
    event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(2_000_000), ...u32(0), ...u32(0)], 100),
    event(EVTID.SYSDESC, str("I#5=TIMER"), 0),
    event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("main")], 0),
    event(EVTID.TASK_START_EXEC, u32(1), 50),
    event(EVTID.MARK_START, u32(7), 10),
    event(EVTID.ISR_ENTER, u32(5), 5),
    event(EVTID.ISR_EXIT, [], 5),
  );
}

function byId(events: TraceEvent[], id: number): TraceEvent {
  const e = events.find((x) => x.id === id);
  assert.ok(e, `no event with id ${id}`);
  return e;
}

// ---------------------------------------------------------------------------
// Synthetic decode tests.
// ---------------------------------------------------------------------------

describe("parser: stream framing", () => {
  it("parses the textual header lines and validates the sync sequence", () => {
    const trace = parseCoreStream(richStream());
    assert.equal(trace.header[0], ";\n");
    assert.match(trace.header.join(""), /SEGGER SystemViewer V2\.42/);
    assert.match(trace.header.join(""), /Espressif Inc/);
  });

  it("tolerates extra header lines before the second separator", () => {
    const header =
      ";\n; Version     SEGGER SystemView V2.42\n; RecordTime  06 Jul 2016\n" +
      "; Author      Someone\n; Title       App\n; Description \n;\n";
    const buf = Uint8Array.from([
      ...Buffer.from(header, "utf8"),
      ...new Array(10).fill(0),
      ...event(EVTID.IDLE, [], 1),
    ]);
    const trace = parseCoreStream(buf);
    assert.equal(trace.events.length, 1);
    assert.equal(trace.events[0]!.id, EVTID.IDLE);
  });

  it("rejects a non-zero sync sequence", () => {
    const head = [...Buffer.from(HEADER, "utf8")];
    const badSync = new Array(10).fill(0);
    badSync[4] = 0x7;
    assert.throws(() => parseCoreStream(Uint8Array.from([...head, ...badSync])), /sync/);
  });

  it("stops cleanly at a truncated trailing packet", () => {
    // A complete IDLE, then a PRINT claiming a 5-byte payload that runs off end.
    const buf = svdat(event(EVTID.IDLE, [], 1), [EVTID.PRINT_FORMATTED, 5]);
    const trace = parseCoreStream(buf);
    assert.equal(trace.events.length, 1);
    assert.equal(trace.events[0]!.id, EVTID.IDLE);
  });
});

describe("parser: value decoding", () => {
  it("decodes multi-byte varint deltas", () => {
    const trace = parseCoreStream(svdat(event(EVTID.IDLE, [], 300)));
    assert.equal(trace.events[0]!.tsDelta, 300);
  });

  it("decodes long-form (0xFF-prefixed) strings", () => {
    const long = "x".repeat(300);
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(EVTID.SYSDESC, strLong(long), 0),
      ),
    );
    const desc = byId(trace.events, EVTID.SYSDESC);
    assert.equal(desc.params["desc"], long);
  });

  it("extracts the application ELF SHA-256 from a svSysDesc", () => {
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(EVTID.SYSDESC, str("ELF_SHA256=A1B2C3D4E"), 0),
      ),
    );
    // Normalised to lowercase; an unrelated stream leaves it null.
    assert.equal(trace.elfSha256, "a1b2c3d4e");
    assert.equal(parseCoreStream(richStream()).elfSha256, null);
  });

  it("decodes two-byte event ids and explicit payload lengths", () => {
    // OS event id 200 (uxEventGroupGetNumber, xEventGroup=%u) is a 2-byte id.
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(200, u32(0xabcd), 0),
      ),
    );
    const evt = byId(trace.events, 200);
    assert.equal(evt.name, "uxEventGroupGetNumber");
    assert.equal(evt.params["xEventGroup"], 0xabcd);
  });

  it("decodes svEndCall as the name of the call that returned, with its return value when sent", () => {
    // Zephyr closes every traced API call with SEGGER_SYSVIEW_RecordEndCall(<call id>) and, for
    // calls that return something, RecordEndCallU32(<call id>, ret). 41 is k_sem_give in the
    // Zephyr table; the FreeRTOS fallback table has no 41, so an unknown id keeps its number.
    const zephyr = resolveOsEvents("Zephyr")!;
    const stream = svdat(
      event(EVTID.TRACE_START, [], 0),
      event(EVTID.END_CALL, u32(41), 1),
      event(EVTID.END_CALL, [...u32(42), ...u32(0)], 1),
      event(EVTID.TASK_TERMINATE, u32(9), 1),
    );
    const trace = parseCoreStream(stream, 0, zephyr);
    assert.deepEqual(
      trace.events.slice(1).map((e) => [e.name, e.params]),
      [
        ["svEndCall", { call: "k_sem_give" }],
        ["svEndCall", { call: "k_sem_take", ret: 0 }],
        ["svTaskTerminate", { tid: 9 }],
      ],
    );
    const fallback = parseCoreStream(svdat(event(EVTID.TRACE_START, [], 0), event(EVTID.END_CALL, u32(300), 1)));
    assert.deepEqual(fallback.events[1]!.params, { call: "svEvent_300" });
  });

  it("keeps the payload layout on each decoded event so the viewer knows which values are handles", () => {
    const trace = parseCoreStream(richStream());
    const info = trace.events.find((e) => e.id === EVTID.TASK_INFO)!;
    assert.deepEqual(info.fmt?.params.map((p) => [p.name, p.kind]), [["tid", "id"], ["prio", "u32"], ["name", "str"]]);
    const start = trace.events.find((e) => e.id === EVTID.TRACE_START)!;
    assert.deepEqual(start.fmt, { name: "svTraceStart", params: [] });
  });

  it("assigns kernel object handles the names of the ELF symbols at their addresses", () => {
    // Zephyr records raw object addresses in its OS events and shrunk ones (address - ram_base)
    // in the task events, so both forms must resolve.
    const elf = new ElfSymbols(
      [
        { value: 0x4080_add4, size: 0x14, name: "threadA_sem" },
        { value: 0x4080_e660, size: 0x80, name: "threadB_data" },
        { value: 0x4080_0000, size: 0, name: "_ram_start" },
      ],
      [],
    );
    const stream = svdat(
      event(EVTID.TRACE_START, [], 0),
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(SYS_FREQ), ...u32(0x4080_0000), ...u32(0)], 1),
      event(EVTID.TASK_START_EXEC, u32(0xe660), 1),
      event(41, u32(0x4080_add4), 1), // k_sem_give sem=<raw address>
      event(40, [...u32(0x4080_add4), ...u32(0x4080_add4)], 1), // k_sem_init sem=..., ret=...
      event(41, u32(0x4080_1000), 1), // k_sem_give with no symbol at the address
    );
    const model = processTraces([parseCoreStream(stream, 0, resolveOsEvents("Zephyr")!)], { elf });
    const [, , exec, give, init, unknown] = model.events;
    assert.deepEqual(exec!.handles, { tid: { addr: 0x4080_e660, name: "threadB_data" } });
    assert.deepEqual(give!.handles, { sem: { addr: 0x4080_add4, name: "threadA_sem" } });
    // A count whose value equals a symbol address is not a handle and is left alone.
    assert.deepEqual(init!.handles, { sem: { addr: 0x4080_add4, name: "threadA_sem" } });
    // A sizeless label below the address is not a name for the object.
    assert.equal(unknown!.handles, undefined);
    // Without an ELF nothing is named.
    const plain = processTraces([parseCoreStream(stream, 0, resolveOsEvents("Zephyr")!)]);
    assert.equal(plain.events[3]!.handles, undefined);
  });

  it("decodes DataPlot data-sample id/value and the matching resource name", () => {
    // A named numeric series (res 7 = "Voltage") sampled twice; the parser must
    // surface both samples' (data_id, value) and the resource name so the
    // DataPlot window can build the series.
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(EVTID.NAME_RESOURCE, [...u32(7), ...str("Voltage")], 0),
        event(EVTID.DATA_SAMPLE, [...u32(7), ...u32(3300)], 10),
        event(EVTID.DATA_SAMPLE, [...u32(7), ...u32(3290)], 10),
      ),
    );
    const name = byId(trace.events, EVTID.NAME_RESOURCE);
    assert.equal(name.params["res_id"], 7);
    assert.equal(name.params["name"], "Voltage");

    const samples = trace.events.filter((e) => e.id === EVTID.DATA_SAMPLE);
    assert.equal(samples.length, 2);
    assert.equal(samples[0]!.name, "svDataSample");
    assert.equal(samples[0]!.params["data_id"], 7);
    assert.equal(samples[0]!.params["value"], 3300);
    assert.equal(samples[1]!.params["value"], 3290);
    // The implicit-length predefined event consumed exactly its payload, so the
    // trailing delta still decoded and the clock advanced between samples.
    assert.ok(samples[1]!.ts > samples[0]!.ts);
  });

  it("decodes a DataPlot svRegisterData (EVTID_EX) registration", () => {
    // EVTID_EX (31) sub-id REGISTER_DATA (6): id, name, then the full field set
    // (DataType, Offset, RangeMin, RangeMax, ScalingFactor float, Unit), exactly
    // as SEGGER_SYSVIEW_RegisterData sends when a name is present.
    const scaling = floatBits(0.5);
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(
          EVTID.EX,
          [
            ...u32(6), // REGISTER_DATA
            ...u32(2), // id
            ...str("Voltage"),
            ...u32(1), // DataType = I32
            ...u32((-3 >>> 0)), // Offset (signed)
            ...u32(0), // RangeMin
            ...u32(0), // RangeMax
            ...u32(scaling), // ScalingFactor (float bits)
            ...str("mV"),
          ],
          0,
        ),
      ),
    );
    const reg = byId(trace.events, EVTID.EX);
    assert.equal(reg.name, "svRegisterData");
    assert.equal(reg.params["data_id"], 2);
    assert.equal(reg.params["name"], "Voltage");
    assert.equal(reg.params["data_type"], 1);
    assert.equal(reg.params["offset"], -3); // decoded as signed I32
    assert.equal(reg.params["unit"], "mV");
    assert.ok(Math.abs((reg.params["scaling"] as number) - 0.5) < 1e-6);
  });

  it("decodes a partial svRegisterData with trailing fields omitted", () => {
    // SEGGER omits trailing zero fields; with no name the type-only short form is
    // valid. The decoder must read only what the payload length covers.
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(EVTID.EX, [...u32(6), ...u32(9), ...str("")], 0),
      ),
    );
    const reg = byId(trace.events, EVTID.EX);
    assert.equal(reg.params["data_id"], 9);
    assert.equal(reg.params["name"], "");
    assert.equal(reg.params["data_type"], undefined); // absent ⇒ defaults later
  });
});

describe("parser: system info and name tables", () => {
  it("captures sys info, task and IRQ tables, and absolute timestamps", () => {
    const trace = parseCoreStream(richStream());
    assert.ok(trace.sysInfo);
    assert.equal(trace.sysInfo!.sysFreq, SYS_FREQ);
    assert.equal(trace.sysInfo!.cpuFreq, 2_000_000);
    assert.equal(trace.tasks.get(1), "main");
    assert.equal(trace.irqs.get(5), "TIMER");

    // TRACE_START resets the clock to 0; deltas then accumulate over sys_freq.
    assert.equal(byId(trace.events, EVTID.TRACE_START).ts, 0);
    assert.equal(byId(trace.events, EVTID.INIT).ts, 100 / SYS_FREQ);
    assert.equal(byId(trace.events, EVTID.TASK_START_EXEC).ts, 150 / SYS_FREQ);
    assert.equal(byId(trace.events, EVTID.ISR_EXIT).ts, 170 / SYS_FREQ);
  });

  it("decodes svPrint message and level", () => {
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(EVTID.PRINT_FORMATTED, [...str("hello"), ...u32(3), ...u32(0)], 0),
      ),
    );
    const p = byId(trace.events, EVTID.PRINT_FORMATTED);
    assert.equal(p.params["msg"], "hello");
    assert.equal(p.params["lvl"], 3);
  });

  it("skips unknown OS events gracefully (where the reference would abort)", () => {
    // Id 300 has no FreeRTOS mapping; its payload length is explicit, so the
    // parser can step over it and keep going (e.g. for embOS streams).
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(300, [0x01, 0x02, 0x03], 0),
        event(EVTID.IDLE, [], 1),
      ),
    );
    const unknown = byId(trace.events, 300);
    assert.equal(unknown.name, "svEvent_300");
    assert.deepEqual(unknown.params, {});
    // Decoding resynchronised: the following IDLE parsed fine.
    assert.ok(trace.events.some((e) => e.id === EVTID.IDLE));
  });

  it("decodes heap module events once the module descriptor is seen", () => {
    const callers = [0x4001_0000, 0x4001_0044, 0];
    const allocPayload = [...u32(0x3fc0_1000), ...u32(64), ...callers.flatMap(u32)];
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(
          EVTID.MODULEDESC,
          [...u32(0), ...u32(512), ...str("M=ESP32 SystemView Heap Tracing Module")],
          0,
        ),
        event(512, allocPayload, 5),
      ),
    );
    const alloc = byId(trace.events, 512);
    assert.equal(alloc.name, "esp_sysview_heap_trace_alloc");
    assert.equal(alloc.params["addr"], 0x3fc0_1000);
    assert.equal(alloc.params["size"], 64);
    assert.deepEqual(alloc.params["callers"], callers);
  });

  it("tags events with the task / IRQ context they run in", () => {
    const model = parseTraceFiles([richStream()]);
    const mark = byId(model.events, EVTID.MARK_START);
    assert.equal(mark.ctxName, "main");
    assert.equal(mark.inIrq, false);

    const isr = byId(model.events, EVTID.ISR_ENTER);
    assert.equal(isr.ctxName, "TIMER");
    assert.equal(isr.inIrq, true);

    // After the ISR exits we return to the task context.
    assert.equal(byId(model.events, EVTID.ISR_EXIT).ctxName, "main");

    // Events seen before any context switch are back-filled with IDLE<core>.
    assert.equal(byId(model.events, EVTID.TASK_INFO).ctxName, "IDLE0");
  });

  it("switches to IDLE<core> on a bare svIdle event", () => {
    // ESP-IDF FreeRTOS marks the CPU going idle with a lone svIdle event — the
    // idle task gets no TASK_START_EXEC and the preempted task no TASK_STOP_*.
    // A running task, then svIdle, then a SysTick ISR that fires while idle and
    // returns to idle, then the task resumes.
    const stream = svdat(
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.SYSDESC, str("I#5=TIMER"), 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("worker")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 10),
      event(EVTID.MARK_START, u32(7), 10), // runs in the worker task
      event(EVTID.IDLE, [], 10), // CPU goes idle — no task stop emitted
      event(EVTID.MARK_STOP, u32(7), 10), // runs while idle
      event(EVTID.ISR_ENTER, u32(5), 5), // SysTick fires during idle
      event(EVTID.ISR_EXIT, [], 5), // returns to idle, not the task
      event(EVTID.TASK_START_EXEC, u32(1), 10), // worker resumes
    );
    const model = parseTraceFiles([stream]);
    const ctxOf = (id: number) => byId(model.events, id).ctxName;

    assert.equal(ctxOf(EVTID.MARK_START), "worker");
    // The svIdle event and everything after it (until the task resumes) is idle.
    assert.equal(ctxOf(EVTID.IDLE), "IDLE0");
    assert.equal(ctxOf(EVTID.MARK_STOP), "IDLE0");
    // An ISR taken during idle unwinds back to idle, not the preempted task.
    assert.equal(ctxOf(EVTID.ISR_ENTER), "TIMER");
    assert.equal(ctxOf(EVTID.ISR_EXIT), "IDLE0");
    // The task only runs again from its next TASK_START_EXEC.
    const resume = model.events.filter((e) => e.id === EVTID.TASK_START_EXEC).at(-1)!;
    assert.equal(resume.ctxName, "worker");
  });

  it("synthesises a Scheduler<core> span from ISR_TO_SCHEDULER to the next task", () => {
    // A worker task runs, is preempted by a TIMER ISR, and that ISR hands off to
    // the scheduler (svExitIsrToScheduler) instead of resuming the worker. The
    // scheduler runs until it switches a task back in.
    const stream = svdat(
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.SYSDESC, str("I#5=TIMER"), 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("worker")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 10),
      event(EVTID.MARK_START, u32(7), 10), // runs in the worker task
      event(EVTID.ISR_ENTER, u32(5), 5), // TIMER preempts the worker
      event(EVTID.ISR_TO_SCHEDULER, [], 5), // ISR exits into the scheduler
      event(EVTID.MARK_STOP, u32(7), 10), // runs while the scheduler decides
      event(EVTID.TASK_START_EXEC, u32(1), 10), // scheduler resumes the worker
    );
    const model = parseTraceFiles([stream]);
    const ctxOf = (id: number) => byId(model.events, id).ctxName;

    assert.equal(ctxOf(EVTID.MARK_START), "worker");
    assert.equal(ctxOf(EVTID.ISR_ENTER), "TIMER");
    // ISR_TO_SCHEDULER and everything after it (until the task resumes) is the
    // scheduler — not the preempted worker (espytrace) and not idle.
    const toSched = byId(model.events, EVTID.ISR_TO_SCHEDULER);
    assert.equal(toSched.ctxName, "Scheduler0");
    assert.equal(toSched.inIrq, false);
    assert.equal(ctxOf(EVTID.MARK_STOP), "Scheduler0");
    // The worker only runs again from its next TASK_START_EXEC.
    const resume = model.events.filter((e) => e.id === EVTID.TASK_START_EXEC).at(-1)!;
    assert.equal(resume.ctxName, "worker");

    // It surfaces as a run interval bounded by the ISR exit and the task start.
    const domainEnd = model.events.at(-1)!.ts;
    const sched = reconstructTimeline(model.events, domainEnd).byContext.get("Scheduler0");
    assert.ok(sched && sched.length === 1, "expected one Scheduler0 run interval");
    assert.equal(sched![0]!.start, toSched.ts);
    assert.equal(sched![0]!.end, resume.ts);
    assert.equal(sched![0]!.isr, false);
  });

  it("ends the scheduler span when the core goes idle (ISR_TO_SCHEDULER → svIdle)", () => {
    // The scheduler can decide no task is ready and idle the core; its run then
    // ends at the svIdle, not at some later task start.
    const stream = svdat(
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.SYSDESC, str("I#5=TIMER"), 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("worker")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 10),
      event(EVTID.ISR_ENTER, u32(5), 10), // TIMER preempts the worker
      event(EVTID.ISR_TO_SCHEDULER, [], 5), // ISR exits into the scheduler
      event(EVTID.IDLE, [], 5), // scheduler finds nothing ready → idle
      event(EVTID.MARK_START, u32(7), 10), // runs while idle
    );
    const model = parseTraceFiles([stream]);
    assert.equal(byId(model.events, EVTID.ISR_TO_SCHEDULER).ctxName, "Scheduler0");
    assert.equal(byId(model.events, EVTID.IDLE).ctxName, "IDLE0");
    assert.equal(byId(model.events, EVTID.MARK_START).ctxName, "IDLE0");
  });

  it("enters the scheduler when the running task blocks, but not when a peer is stopped", () => {
    // A direct task-to-task switch (no ISR): the running task blocks
    // (TASK_STOP_READY for itself) and the scheduler picks the next task. A
    // TASK_STOP_READY for a *different* task leaves the current context running.
    const stream = svdat(
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(3), ...str("A")], 0),
      event(EVTID.TASK_INFO, [...u32(2), ...u32(2), ...str("B")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 10), // A runs
      event(EVTID.TASK_STOP_READY, [...u32(2), ...u32(0)], 10), // peer B stopped — A keeps running
      event(EVTID.MARK_START, u32(7), 5),
      event(EVTID.TASK_STOP_READY, [...u32(1), ...u32(0)], 5), // A blocks itself → scheduler
      event(EVTID.MARK_STOP, u32(7), 5), // runs while the scheduler decides
      event(EVTID.TASK_START_EXEC, u32(2), 10), // scheduler switches in B
    );
    const model = parseTraceFiles([stream]);
    // Stopping the peer B did not disturb A.
    assert.equal(byId(model.events, EVTID.MARK_START).ctxName, "A");
    // A blocking itself hands off to the scheduler until B is switched in.
    assert.equal(byId(model.events, EVTID.MARK_STOP).ctxName, "Scheduler0");
    assert.equal(byId(model.events, EVTID.TASK_START_EXEC).ctxName, "A");
    assert.equal(model.events.filter((e) => e.id === EVTID.TASK_START_EXEC).at(-1)!.ctxName, "B");
  });

  it("ends the scheduler span at a software timer (TIMER_ENTER) so timers aren't counted as scheduling", () => {
    // The scheduler dispatches a due software timer; the reference shows that as a
    // separate Timer context. We don't reconstruct Timer yet, but the timer's
    // run must not inflate the Scheduler lane — the scheduler span ends at
    // TIMER_ENTER (the timer body then falls back to idle).
    const stream = svdat(
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.SYSDESC, str("I#5=TIMER"), 0),
      event(EVTID.ISR_ENTER, u32(5), 10),
      event(EVTID.ISR_TO_SCHEDULER, [], 5), // → scheduler
      event(EVTID.TIMER_ENTER, u32(1), 5), // scheduler dispatches a timer
      event(EVTID.MARK_START, u32(7), 10), // runs in the timer body
      event(EVTID.TIMER_EXIT, [], 10),
    );
    const model = parseTraceFiles([stream]);
    assert.equal(byId(model.events, EVTID.ISR_TO_SCHEDULER).ctxName, "Scheduler0");
    // The timer body is no longer attributed to the scheduler.
    assert.notEqual(byId(model.events, EVTID.MARK_START).ctxName, "Scheduler0");
  });

  it("orders a merged multi-core timeline by timestamp", () => {
    const core0 = parseCoreStream(richStream(), 0);
    const core1 = parseCoreStream(richStream(), 1);
    const model = processTraces([core0, core1]);
    assert.equal(model.events.length, core0.events.length + core1.events.length);
    for (let i = 1; i < model.events.length; i++) {
      assert.ok(model.events[i]!.ts >= model.events[i - 1]!.ts, "timeline not sorted by ts");
    }
  });

  it("collapses a trailing TRACE_STOP gap to the last activity", () => {
    // On a live JTAG capture the stop marker is emitted well after the last
    // event — we halt the cores to write the stop command down-channel — so its
    // timestamp would otherwise become the trace end and paint the last-running
    // context across the dead gap. The processor pulls it back to the last
    // activity so the trace terminates on the last received event.
    const stream = svdat(
      event(EVTID.TRACE_START, [], 0),
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("main")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 50),
      event(EVTID.MARK_START, u32(7), 10), // last real activity
      event(EVTID.TRACE_STOP, [], 100_000), // emitted ~0.1s later
    );
    const model = parseTraceFiles([stream]);
    const stop = model.events.find((e) => e.id === EVTID.TRACE_STOP)!;
    const lastActivity = Math.max(
      ...model.events.filter((e) => e.id !== EVTID.TRACE_STOP).map((e) => e.ts),
    );
    assert.equal(stop.ts, lastActivity, "trailing stop pulled back to last activity");
    assert.equal(Math.max(...model.events.map((e) => e.ts)), lastActivity, "trace ends on last event");
  });

  it("leaves a non-trailing TRACE_STOP untouched", () => {
    // A stop *followed* by more activity (a mid-stream stop/restart) is real and
    // must keep its timestamp — only a dangling tail marker is clamped.
    const stream = svdat(
      event(EVTID.TRACE_START, [], 0),
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("main")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 50),
      event(EVTID.TRACE_STOP, [], 10), // stop...
      event(EVTID.MARK_START, u32(7), 100), // ...but activity continues after
    );
    const model = parseTraceFiles([stream]);
    const stop = model.events.find((e) => e.id === EVTID.TRACE_STOP)!;
    const mark = model.events.find((e) => e.id === EVTID.MARK_START)!;
    assert.ok(stop.ts < mark.ts, "a stop followed by activity keeps its timestamp");
  });

  it("collapses a trailing drain-seam burst, in-flight event included", () => {
    // The host stop/drain seam can flush an in-flight event alongside TRACE_STOP,
    // both stamped at the drain instant — far past the last real activity (see
    // p4-mcore.svdat, where a trailing xQueueGenericReceive, not the stop, stretched
    // the domain to 1.68 s). Clamping only the stop would leave that
    // in-flight event painting the dead gap, so the whole trailing burst — tightly
    // clustered and fronted by a large idle gap — is reseated onto the last pre-gap
    // activity.
    const stream = svdat(
      event(EVTID.TRACE_START, [], 0),
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("main")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 50),
      event(EVTID.MARK_START, u32(7), 10), // last real activity
      event(EVTID.MARK_STOP, u32(7), 1_000_000), // in-flight, flushed ~1s later at drain
      event(EVTID.TRACE_STOP, [], 5), // stop, a few cycles after, same drain instant
    );
    const model = parseTraceFiles([stream]);
    const markStart = model.events.find((e) => e.id === EVTID.MARK_START)!;
    const markStop = model.events.find((e) => e.id === EVTID.MARK_STOP)!;
    const stop = model.events.find((e) => e.id === EVTID.TRACE_STOP)!;
    assert.equal(markStop.ts, markStart.ts, "in-flight drain event reseated to last activity");
    assert.equal(stop.ts, markStart.ts, "trailing stop reseated to last activity");
    assert.equal(
      Math.max(...model.events.map((e) => e.ts)),
      markStart.ts,
      "trace ends on the last real event, not the drain instant",
    );
  });

  it("leaves a tight terminal burst with no idle gap untouched", () => {
    // A brief in-flight event right before the stop, with no large gap before it,
    // is genuine end-of-trace activity — not a drain seam. It must keep its time.
    const stream = svdat(
      event(EVTID.TRACE_START, [], 0),
      event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("main")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 50),
      event(EVTID.MARK_START, u32(7), 100),
      event(EVTID.MARK_STOP, u32(7), 100), // real, only 100 µs later
      event(EVTID.TRACE_STOP, [], 5),
    );
    const model = parseTraceFiles([stream]);
    const markStart = model.events.find((e) => e.id === EVTID.MARK_START)!;
    const markStop = model.events.find((e) => e.id === EVTID.MARK_STOP)!;
    assert.ok(markStop.ts > markStart.ts, "genuine pre-stop activity keeps its timestamp");
  });
});

/**
 * Build a combined multi-core SVDAT: a shared textual header carrying one
 * `; Offset CoreN` line per core, followed by each core's region concatenated.
 * Each region is its own sync sequence + events (no per-core textual header) —
 * the real single-file format. Offsets are byte positions relative to the first
 * sync (= the end of the shared header), so they are just the running lengths of
 * the preceding regions.
 */
function multicoreSvdat(
  version: string,
  author: string,
  regions: number[][][],
): Uint8Array {
  const bodies = regions.map((evts) => [...new Array(10).fill(0), ...evts.flat()]);
  const offsets: number[] = [];
  let acc = 0;
  for (const b of bodies) {
    offsets.push(acc);
    acc += b.length;
  }
  const offLines = offsets.map((o, i) => `; Offset Core${i} ${o}`).join("\n");
  const header = `;\n; Version      ${version}\n; Author       ${author}\n${offLines}\n;\n`;
  return Uint8Array.from([...Buffer.from(header, "utf8"), ...bodies.flat()]);
}

describe("multicore split detection", () => {
  it("ignores single-core files", () => {
    assert.equal(isSeggerMulticore(richStream()), false);
    assert.equal(splitSeggerMulticore(richStream()), null);
  });

  it("detects the combined format vendor-neutrally (genuine SEGGER, N cores)", () => {
    // A third-party recording: Author SEGGER, three cores — none of the
    // Espressif Version/Author markers the old detector required.
    const buf = multicoreSvdat("SEGGER SystemView V3.60", "SEGGER", [
      [event(EVTID.IDLE, [], 1)],
      [event(EVTID.IDLE, [], 1)],
      [event(EVTID.IDLE, [], 1)],
    ]);
    assert.equal(isSeggerMulticore(buf), true);

    const split = splitSeggerMulticore(buf);
    assert.ok(split, "expected an N-core split");
    assert.equal(split!.length, 3);
    // Each emitted buffer is a standalone single-core SVDAT that parses to one
    // core tagged with its index, sharing the original header verbatim.
    split!.forEach((core, i) => {
      const trace = parseCoreStream(core, i);
      assert.match(trace.header.join(""), /SEGGER SystemView V3\.60/);
      assert.equal(trace.events.length, 1);
      assert.equal(trace.coreId, i);
    });
  });

  it("splits an N-core stream and merges every core's events", () => {
    const buf = multicoreSvdat("SEGGER SystemView V3.60", "SEGGER", [
      [
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(EVTID.IDLE, [], 5),
      ],
      [event(EVTID.IDLE, [], 1), event(EVTID.IDLE, [], 1)],
      [event(EVTID.IDLE, [], 1)],
    ]);
    const split = splitSeggerMulticore(buf)!;
    assert.equal(split.length, 3);

    const model = parseTraceFiles([buf]);
    // Per-core event counts survive the split; the merge is their sum.
    assert.deepEqual(
      model.traces.map((t) => t.events.length),
      [2, 2, 1],
    );
    assert.equal(model.events.length, 5);
    assert.deepEqual(
      model.traces.map((t) => t.coreId),
      [0, 1, 2],
    );
  });

  it("stays backward-compatible with the Espressif two-core header", () => {
    const buf = multicoreSvdat("SEGGER SystemViewer V3.60", "Espressif Inc", [
      [event(EVTID.IDLE, [], 1)],
      [event(EVTID.IDLE, [], 1)],
    ]);
    assert.equal(isSeggerMulticore(buf), true);
    assert.equal(splitSeggerMulticore(buf)!.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Multi-core timebase alignment.
// ---------------------------------------------------------------------------

/** Absolute cycle count (1 ms at {@link SYS_FREQ}) the recorder was started at. */
const TRACE_ORIGIN = 1000;

const INIT_PAYLOAD = [...u32(SYS_FREQ), ...u32(2_000_000), ...u32(0), ...u32(0)];

/**
 * A two-core capture in ESP-IDF's shape: only core 0 emits `svTraceStart` (whose
 * delta is the absolute time the recorder was started at, which the parser
 * zeroes away), so core 1's stream opens with `svInit` still carrying that same
 * absolute time in its own first delta. Both cores then switch in a task at the
 * same absolute instant, {@link TRACE_ORIGIN}` + 10` cycles.
 *
 * With `origins` given, every core opens with its own `svTraceStart` at that
 * delta instead — the shape a capture whose cores were started together has.
 */
function twoCoreCapture(origins?: [number, number]): Uint8Array {
  const core = (tid: number, name: string, start: number, traceStart: boolean): number[][] => [
    ...(traceStart ? [event(EVTID.TRACE_START, [], start)] : []),
    event(EVTID.INIT, INIT_PAYLOAD, traceStart ? 3 : start + 3),
    event(EVTID.TASK_INFO, [...u32(tid), ...u32(2), ...str(name)], 0),
    event(EVTID.TASK_START_EXEC, u32(tid), 7),
  ];
  return multicoreSvdat("SEGGER SystemViewer V2.42", "Espressif Inc", [
    core(1, "a", origins ? origins[0] : TRACE_ORIGIN, true),
    core(2, "b", origins ? origins[1] : TRACE_ORIGIN, origins !== undefined),
  ]);
}

/** The `svTaskStartExec` timestamp of each core, in core order. */
function execTimes(model: TraceModel): number[] {
  return model.traces.map(
    (t) => t.events.find((e) => e.id === EVTID.TASK_START_EXEC)!.ts,
  );
}

/** Compare timestamps to within a tenth of a cycle of the test clock. */
function assertTs(actual: number[], expected: number[]): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Math.abs(actual[i]! - expected[i]!) < 0.1 / SYS_FREQ,
      `ts[${i}]: ${actual[i]} vs ${expected[i]}`,
    );
  }
}

describe("processor: multi-core timebase alignment", () => {
  it("reports the absolute origin each core's timestamps are measured from", () => {
    const traces = splitSeggerMulticore(twoCoreCapture())!.map((b, i) => parseCoreStream(b, i));
    assert.equal(traces[0]!.tsOrigin, TRACE_ORIGIN / SYS_FREQ);
    assert.equal(traces[1]!.tsOrigin, 0); // no svTraceStart: already absolute
  });

  it("pulls a core with no svTraceStart onto the same axis as core 0", () => {
    const raw = splitSeggerMulticore(twoCoreCapture())!.map((b, i) => parseCoreStream(b, i));
    // Unmerged, the two cores' identical instants differ by the origin delta.
    assert.equal(
      raw[1]!.events.find((e) => e.id === EVTID.TASK_START_EXEC)!.ts -
        raw[0]!.events.find((e) => e.id === EVTID.TASK_START_EXEC)!.ts,
      TRACE_ORIGIN / SYS_FREQ,
    );

    assertTs(execTimes(parseTraceFiles([twoCoreCapture()])), [10 / SYS_FREQ, 10 / SYS_FREQ]);
  });

  it("keeps the merged timeline starting at zero", () => {
    const model = parseTraceFiles([twoCoreCapture()]);
    assertTs([Math.min(...model.events.map((e) => e.ts))], [0]);
    for (let i = 1; i < model.events.length; i++) {
      assert.ok(model.events[i]!.ts >= model.events[i - 1]!.ts, "timeline not sorted by ts");
    }
  });

  it("leaves cores that already share an origin untouched", () => {
    const data = twoCoreCapture([TRACE_ORIGIN, TRACE_ORIGIN]);
    const raw = splitSeggerMulticore(data)!.map((b, i) => parseCoreStream(b, i));
    const before = raw.map((t) => t.events.map((e) => e.ts));
    assertTs(execTimes(parseTraceFiles([data])), [10 / SYS_FREQ, 10 / SYS_FREQ]);
    assert.deepEqual(
      raw.map((t) => t.events.map((e) => e.ts)),
      before,
    );
  });

  it("shifts each event exactly once however often the merge re-runs", () => {
    const traces = splitSeggerMulticore(twoCoreCapture())!.map((b, i) => parseCoreStream(b, i));
    const first = execTimes(processTraces(traces));
    assert.deepEqual(execTimes(processTraces(traces)), first);
    assert.deepEqual(execTimes(processTraces(traces)), first);
  });
});

describe("processor: overflow gaps", () => {
  const INIT = [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)];
  /** Timestamp of the last event on `core` before index `idx`, or `null` if there is none. */
  const prevOnCore = (events: TraceEvent[], idx: number): number | null => {
    for (let j = idx - 1; j >= 0; j--) if (events[j]!.coreId === events[idx]!.coreId) return events[j]!.ts;
    return null;
  };

  /**
   * One core that overflows three times: a first overflow with a raw count, a second
   * whose cumulative count is differenced against the first, and a third whose count
   * went backwards, which is a counter reset.
   */
  function overflowingStream(): Uint8Array {
    return svdat(
      event(EVTID.INIT, INIT, 0),
      event(EVTID.SYSDESC, str("I#5=TIMER"), 0),
      event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("worker")], 0),
      event(EVTID.TASK_INFO, [...u32(2), ...u32(2), ...str("other")], 0),
      event(EVTID.TASK_START_EXEC, u32(1), 10), // t=10: worker runs
      event(EVTID.MARK_START, u32(7), 10), // t=20: last event before the gap
      event(EVTID.OVERFLOW, u32(5), 100), // t=120: 5 events lost in [20, 120]
      event(EVTID.MARK_STOP, u32(7), 10), // t=130: context unknown until the next switch
      event(EVTID.TASK_STOP_READY, [...u32(2), ...u32(0)], 5), // t=135: `other` was running
      event(EVTID.TASK_START_EXEC, u32(1), 10), // t=145: worker again
      event(EVTID.OVERFLOW, u32(12), 50), // t=195: cumulative 12 → 7 lost in [145, 195]
      event(EVTID.OVERFLOW, u32(3), 20), // t=215: counter reset → 3 lost in [195, 215]
    );
  }

  it("records one gap per overflow with cumulative counts differenced across the capture", () => {
    const model = parseTraceFiles([overflowingStream()]);
    assert.equal(model.gaps.length, 3);
    assert.deepEqual(
      model.gaps.map((g) => [g.coreId, g.dropCount, g.lost]),
      [
        [0, 5, 5],
        [0, 12, 7],
        [0, 3, 3], // lower than the previous count: a reset, so the raw value stands
      ],
    );
    assertTs(model.gaps.map((g) => g.start), [20 / SYS_FREQ, 145 / SYS_FREQ, 195 / SYS_FREQ]);
    assertTs(model.gaps.map((g) => g.end), [120 / SYS_FREQ, 195 / SYS_FREQ, 215 / SYS_FREQ]);
    for (const g of model.gaps) {
      const e = model.events[g.eventIndex]!;
      assert.equal(e.id, EVTID.OVERFLOW, "eventIndex points at the svOverflow event");
      assert.equal(e.ts, g.end);
      assert.equal(prevOnCore(model.events, g.eventIndex), g.start);
    }
  });

  it("starts a gap at the overflow itself when it is the first event on the core", () => {
    const model = parseTraceFiles([
      svdat(
        event(EVTID.OVERFLOW, u32(4), 0),
        event(EVTID.INIT, INIT, 0),
        event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("worker")], 0),
        event(EVTID.TASK_START_EXEC, u32(1), 10),
      ),
    ]);
    assert.equal(model.gaps.length, 1);
    const g = model.gaps[0]!;
    assert.equal(g.eventIndex, 0);
    assert.equal(g.start, g.end);
    assert.deepEqual([g.dropCount, g.lost], [4, 4]);
  });

  it("forgets the pre-gap context: post-gap events are back-filled from the post-gap inference", () => {
    const model = parseTraceFiles([overflowingStream()]);
    const ctxOf = (id: number) => byId(model.events, id).ctxName;
    assert.equal(ctxOf(EVTID.MARK_START), "worker"); // before the gap
    // The overflow marks a region that belongs to no context and is never back-filled.
    const overflow = byId(model.events, EVTID.OVERFLOW);
    assert.equal(overflow.ctxName, "None");
    assert.equal(overflow.inIrq, false);
    // svTaskStopReady(other) is the first switch after the gap, so `other` is inferred to
    // have been running since the gap — not the stale `worker` from before it.
    assert.equal(ctxOf(EVTID.MARK_STOP), "other");
    assert.equal(ctxOf(EVTID.TASK_STOP_READY), "IDLE0");
    assert.equal(byId(model.events, EVTID.TASK_START_EXEC).ctxName, "worker");
    // Every overflow stays without context, including ones with no events in between.
    for (const e of model.events.filter((e) => e.id === EVTID.OVERFLOW)) assert.equal(e.ctxName, "None");
  });

  it("gaps are sorted by start, then core", () => {
    const core = (drop: number, delay: number): Uint8Array =>
      svdat(
        event(EVTID.INIT, INIT, 0),
        event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("worker")], 0),
        event(EVTID.TASK_START_EXEC, u32(1), delay),
        event(EVTID.OVERFLOW, u32(drop), 100),
      );
    // Core 1's gap starts later (its last pre-gap event is at t=30, core 0's at t=10).
    const model = processTraces([parseCoreStream(core(2, 10), 0), parseCoreStream(core(9, 30), 1)]);
    assert.deepEqual(
      model.gaps.map((g) => [g.coreId, g.lost]),
      [
        [0, 2],
        [1, 7], // one counter serves every core: core 1's 9 includes the 2 core 0 reported
      ],
    );
    assertTs(model.gaps.map((g) => g.start), [10 / SYS_FREQ, 30 / SYS_FREQ]);
  });

  it("treats the same count from another core as the same loss, not a second one", () => {
    const core = (delay: number): Uint8Array =>
      svdat(
        event(EVTID.INIT, INIT, 0),
        event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("worker")], 0),
        event(EVTID.TASK_START_EXEC, u32(1), delay),
        event(EVTID.OVERFLOW, u32(5), 100),
        event(EVTID.TASK_START_EXEC, u32(1), 10),
        event(EVTID.OVERFLOW, u32(8), 100),
      );
    const model = processTraces([parseCoreStream(core(10), 0), parseCoreStream(core(30), 1)]);
    assert.deepEqual(
      model.gaps.map((g) => [g.coreId, g.dropCount, g.lost]),
      [
        [0, 5, 5],
        [1, 5, 5],
        [0, 8, 3],
        [1, 8, 3],
      ],
    );
  });
});

describe("processor: per-core context back-fill", () => {
  it("back-fills each core's pending events from that core's own inferred context", () => {
    const INIT = [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)];
    const core0 = parseCoreStream(
      svdat(
        event(EVTID.INIT, INIT, 0),
        event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("A")], 0),
        event(EVTID.MARK_START, u32(7), 5), // t=5
        event(EVTID.TASK_START_EXEC, u32(1), 5), // t=10: core 0 establishes context first
      ),
      0,
    );
    const core1 = parseCoreStream(
      svdat(
        event(EVTID.INIT, INIT, 0),
        event(EVTID.TASK_INFO, [...u32(2), ...u32(2), ...str("B")], 0),
        event(EVTID.MARK_START, u32(8), 7), // t=7
        event(EVTID.TASK_START_EXEC, u32(2), 13), // t=20: core 1 establishes context later
      ),
      1,
    );
    const model = processTraces([core0, core1]);

    // Merged order is the timestamp order, core 0 first on ties, whether or not an
    // event's context was known when it arrived.
    assert.deepEqual(
      model.events.map((e) => [e.coreId, e.name]),
      [
        [0, "svInit"],
        [0, "svTaskInfo"],
        [1, "svInit"],
        [1, "svTaskInfo"],
        [0, "svUserStart"],
        [1, "svUserStart"],
        [0, "svTaskStartExec"],
        [1, "svTaskStartExec"],
      ],
    );
    // Core 1's events were still pending when core 0 switched in A; they take core 1's
    // own inferred idle context once core 1 switches in B, never core 0's.
    for (const e of model.events) {
      if (e.id === EVTID.TASK_START_EXEC) continue;
      assert.equal(e.ctxName, `IDLE${e.coreId}`, `${e.name} on core ${e.coreId}`);
    }
  });

  it("leaves a core's events without context if the core never establishes one", () => {
    const INIT = [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)];
    const core0 = parseCoreStream(
      svdat(
        event(EVTID.INIT, INIT, 0),
        event(EVTID.TASK_INFO, [...u32(1), ...u32(2), ...str("A")], 0),
        event(EVTID.TASK_START_EXEC, u32(1), 10),
      ),
      0,
    );
    const core1 = parseCoreStream(svdat(event(EVTID.INIT, INIT, 0), event(EVTID.MARK_START, u32(8), 7)), 1);
    const model = processTraces([core0, core1]);
    for (const e of model.events) {
      if (e.coreId === 1) assert.equal(e.ctxName, "None");
      else assert.notEqual(e.ctxName, "None");
    }
  });
});

// ---------------------------------------------------------------------------
// Oracle comparison against IDF's reference output.
// ---------------------------------------------------------------------------

/** Reference JSON shapes from `SysViewTraceDataJsonEncoder`. */
interface RefEvent {
  core_id: number;
  ctx_name: string;
  id: number;
  in_irq: boolean;
  ts: number;
  params?: Record<string, ParamValue>;
  msg?: string;
  lvl?: number;
  addr?: string;
  size?: number;
  callers?: string[];
}

const hex = (v: ParamValue): string => "0x" + (Number(v) >>> 0).toString(16);

/**
 * Render the parsed model the way `sysviewtrace_proc.py -j` serialises events,
 * so the two can be compared directly. Notably the reference lists each svPrint
 * event twice (once as a log-stream event, once as a predefined event); we
 * reproduce that here. Generic (undecoded) extension events are omitted, as the
 * encoder omits them.
 */
function toReferenceEvents(model: TraceModel): RefEvent[] {
  const out: RefEvent[] = [];
  for (const e of model.events) {
    const base = { core_id: e.coreId, ctx_name: e.ctxName, id: e.id, in_irq: e.inIrq, ts: e.ts };
    if (e.id >= 512 && "addr" in e.params) {
      out.push({
        ...base,
        addr: hex(e.params["addr"]!),
        size: "size" in e.params ? (e.params["size"] as number) : 0,
        callers: (e.params["callers"] as number[]).map((a) => hex(a)),
      });
    } else if (e.id === EVTID.PRINT_FORMATTED) {
      const ev = { ...base, msg: e.params["msg"] as string, lvl: e.params["lvl"] as number };
      out.push(ev, { ...ev }); // svPrint is emitted twice by the reference encoder
    } else if (e.id < 512) {
      const params: Record<string, ParamValue> = {};
      for (const [k, v] of Object.entries(e.params)) params[k] = typeof v === "bigint" ? Number(v) : v;
      out.push({ ...base, params });
    }
    // else: generic extension event (>=512, undecoded) — omitted, as in the encoder.
  }
  return out;
}

/**
 * Collapse idle *and* scheduler regions to their synthetic context names on a
 * reference-event stream, so the oracle can compare everything *except* the two
 * places this parser deliberately improves on `sysviewtrace_proc.py` (see
 * `processor.ts`): the bare `svIdle` event and the OS scheduler span.
 *
 * - **Idle.** espytrace never treats `svIdle` as a context switch, so on captures
 *   where the idle task emits no `TASK_START_EXEC` and the preempted task no
 *   `TASK_STOP_*` (the ESP-IDF FreeRTOS norm — every oracle fixture has zero stop
 *   events), it leaves the *preempted* task on its context stack for the whole
 *   idle stretch and mis-attributes hundreds of idle events to that task. This parser
 *   treats `svIdle` as a switch to `IDLE<core>`, matching the reference GUI.
 * - **Scheduler.** espytrace treats `ISR_TO_SCHEDULER` exactly like `ISR_EXIT`
 *   (a one-level pop) and never models the scheduler, so it tags the window with
 *   whatever the pop reveals (idle, here). This parser enters a synthetic
 *   `Scheduler<core>` from `ISR_TO_SCHEDULER` until the scheduler hands off
 *   (`TASK_START_EXEC`/`IDLE`/`TIMER_ENTER`).
 *
 * Applied identically to both sides, this masks exactly those windows. From an
 * `IDLE` until the next `TASK_START_EXEC`, and from an `ISR_TO_SCHEDULER` until
 * the next `TASK_START_EXEC`/`IDLE`/`TIMER_ENTER`, every non-ISR event is pinned
 * to the synthetic name. Real ISR events (`in_irq`) are left untouched and
 * compared exactly — including the ISRs that legitimately fire *within* a
 * scheduler window — as are event count, order, timestamps, and the *position*
 * of every boundary. The synthetic processor tests below lock in the positive
 * behaviour the oracle can no longer assert byte-for-byte.
 *
 * Only the `ISR_TO_SCHEDULER` scheduler path is exercised here: the oracle
 * fixtures carry no `TASK_STOP_*` or `TIMER_ENTER` events (the masking handles
 * `TIMER_ENTER` purely as a window terminator for completeness).
 */
function normalizeSyntheticRegions(events: RefEvent[]): RefEvent[] {
  const idleActive = new Map<number, boolean>();
  const schedActive = new Map<number, boolean>();
  return events.map((e) => {
    const core = e.core_id;
    switch (e.id) {
      case EVTID.IDLE:
        idleActive.set(core, true);
        schedActive.set(core, false);
        return { ...e, ctx_name: `IDLE${core}`, in_irq: false };
      case EVTID.ISR_TO_SCHEDULER:
        schedActive.set(core, true);
        idleActive.set(core, false);
        return { ...e, ctx_name: `Scheduler${core}`, in_irq: false };
      case EVTID.TASK_START_EXEC:
        idleActive.set(core, false);
        schedActive.set(core, false);
        return e;
      case EVTID.TIMER_ENTER:
        schedActive.set(core, false);
        break;
    }
    if (e.in_irq) return e; // genuine ISR events match byte-for-byte on both sides
    if (schedActive.get(core)) return { ...e, ctx_name: `Scheduler${core}`, in_irq: false };
    if (idleActive.get(core)) return { ...e, ctx_name: `IDLE${core}`, in_irq: false };
    return e;
  });
}

/**
 * Reproduce this parser's trailing-drain-seam clamp *and* its multi-core merge order
 * on a reference-event stream, masking the second place this parser deliberately
 * improves on the reference: the timestamps of the trailing stop seam.
 *
 * `espytrace` keeps the trailing packets at whatever timestamp they carry — on
 * these IDF captures (as on a live JTAG capture) the `TRACE_STOP`, and sometimes
 * an in-flight event flushed with it, occur well after the last real event, so the
 * reference leaves a dead gap the timeline/CPU-load would attribute to the
 * last-running context. This parser reseats that whole trailing burst onto the last
 * pre-gap activity (see `clampDrainSeam` in `processor.ts`)
 * *before* merging the cores by timestamp — which also pulls the reseated events
 * earlier in the merged order. So we apply the identical per-core clamp and the
 * identical stable, core-ordered re-sort to both sides; this masks only the seam
 * timestamps (and the merge position that follows from them). The synthetic
 * clamp tests above lock in the positive behaviour the oracle can no longer
 * assert byte-for-byte.
 */
function normalizeDrainSeam(events: RefEvent[]): RefEvent[] {
  const byCore = new Map<number, RefEvent[]>();
  for (const e of events) {
    let arr = byCore.get(e.core_id);
    if (!arr) byCore.set(e.core_id, (arr = []));
    arr.push({ ...e });
  }
  for (const arr of byCore.values()) clampDrainSeam(arr);
  // Re-merge core-by-core (ascending id) then stable-sort by ts, mirroring the
  // processor's `[core0…, core1…].sort((a, b) => a.ts - b.ts)`. Push in a loop
  // (not a spread) so a large capture can't overflow the call stack.
  const merged: RefEvent[] = [];
  for (const core of [...byCore.keys()].sort((a, b) => a - b))
    for (const e of byCore.get(core)!) merged.push(e);
  return merged.sort((a, b) => a.ts - b.ts);
}

function assertMatchesReference(rawGot: RefEvent[], rawExpected: RefEvent[]): void {
  const got = normalizeDrainSeam(normalizeSyntheticRegions(rawGot));
  const expected = normalizeDrainSeam(normalizeSyntheticRegions(rawExpected));
  assert.equal(got.length, expected.length, "event count");
  for (let i = 0; i < expected.length; i++) {
    const a = got[i]!;
    const b = expected[i]!;
    // Timestamps are floating-point; compare with a tight relative tolerance.
    assert.ok(
      Math.abs(a.ts - b.ts) <= Math.abs(b.ts) * 1e-9 + 1e-12,
      `ts mismatch at event ${i} (id ${b.id}): ${a.ts} vs ${b.ts}`,
    );
    const aa: Partial<RefEvent> = { ...a };
    const bb: Partial<RefEvent> = { ...b };
    delete aa.ts;
    delete bb.ts;
    assert.deepEqual(aa, bb, `event ${i} (id ${b.id})`);
  }
}

const SYSVIEW_FIXTURES = process.env["IDF_PATH"]
  ? join(process.env["IDF_PATH"], "tools", "esp_app_trace", "test", "sysview")
  : "";
const haveFixtures = SYSVIEW_FIXTURES !== "" && existsSync(join(SYSVIEW_FIXTURES, "expected_output.json"));

describe("parser: IDF reference oracle", { skip: !haveFixtures }, () => {
  it("matches the reference for a per-core pair (heap_log0 + heap_log1)", () => {
    const core0 = readFileSync(join(SYSVIEW_FIXTURES, "heap_log0.svdat"));
    const core1 = readFileSync(join(SYSVIEW_FIXTURES, "heap_log1.svdat"));
    const model = parseTraceFiles([core0, core1]);

    // Sanity on the data model itself.
    assert.ok(model.traces[0]!.sysInfo);
    assert.equal(model.traces[0]!.sysInfo!.sysFreq, 40_000_000);
    assert.ok([...model.traces[0]!.tasks.values()].includes("main"));
    assert.ok(model.traces[0]!.irqs.size > 0);

    const expected = JSON.parse(readFileSync(join(SYSVIEW_FIXTURES, "expected_output.json"), "utf8"));
    assertMatchesReference(toReferenceEvents(model), expected.events);
  });

  it("matches the reference for a combined multi-core file (auto-split)", () => {
    const combined = readFileSync(join(SYSVIEW_FIXTURES, "heap_log_mcore.svdat"));
    assert.equal(isSeggerMulticore(combined), true);
    const model = parseTraceFiles([combined]);

    const expected = JSON.parse(
      readFileSync(join(SYSVIEW_FIXTURES, "expected_output_mcore.json"), "utf8"),
    );
    // `sysviewtrace_proc.py`'s splitter prepends a rebuilt header *plus* an extra
    // 10-byte sync to each core, even though every region already begins with its
    // own sync. The reference parser reads the 5 leftover zero bytes per core as
    // svNop events, so its expected_output_mcore.json carries 10 spurious NOPs
    // (5/core × 2 cores). this parser prepends only the shared header (no extra sync),
    // so it emits none. Drop NOPs from both sides; every real event still matches.
    const dropNops = (evts: RefEvent[]) => evts.filter((e) => e.id !== EVTID.NOP);
    assertMatchesReference(dropNops(toReferenceEvents(model)), dropNops(expected.events));
  });
});

// A real ESP32-P4 *multicore* capture (committed fixture), produced
// by OpenOCD's `esp sysview_mcore start file://…` off the dual-core P4 running
// the IDF `sysview_tracing_heap_log` example, and accepted by
// sysviewtrace_proc.py. This validates multi-core parsing on real target
// data: the parser auto-splits the single
// multicore file into both cores and merges them into one
// timestamp-ordered, per-core-tagged timeline. It replaces the legacy per-core
// `.svdat` *pair* with the single multicore file OpenOCD now generates.
const P4_MCORE = join(import.meta.dirname, "..", "fixtures", "traces", "p4-mcore.svdat");
const haveP4Mcore = existsSync(P4_MCORE);

describe("parser: live ESP32-P4 multicore capture", { skip: !haveP4Mcore }, () => {
  const loadMcore = () => parseTraceFiles([new Uint8Array(readFileSync(P4_MCORE))]);
  const assertSaneTrace = (m: TraceModel, core: number) => {
    const t = m.traces[core]!;
    assert.ok(t.sysInfo, `core ${core}: no svInit decoded`);
    assert.ok(t.sysInfo!.sysFreq > 0, `core ${core}: non-positive sysFreq`);
    assert.ok(t.tasks.size > 0, `core ${core}: no tasks decoded`);
    assert.ok(t.irqs.size > 0, `core ${core}: no IRQs decoded`);
  };

  it("auto-splits the multicore file and reconstructs a sane two-core model", () => {
    const m = loadMcore();
    assert.equal(m.traces.length, 2, "expected two cores in the multicore capture");
    assert.ok(m.events.length > 50, `decoded too few events (${m.events.length})`);
    assertSaneTrace(m, 0);
    assertSaneTrace(m, 1);
    // Both cores contribute to the merged, timestamp-ordered, per-core-tagged
    // timeline; every event is assigned to a known execution context.
    assert.ok(
      m.events.some((e) => e.coreId === 0) && m.events.some((e) => e.coreId === 1),
      "merged timeline is missing one of the cores",
    );
    assert.ok(m.events.every((e) => e.ctxName !== "None"), "events left without context");
    for (let i = 1; i < m.events.length; i++) {
      assert.ok(m.events[i]!.ts >= m.events[i - 1]!.ts, "timestamps not monotonic");
    }
  });

  // Strict event-for-event agreement with sysviewtrace_proc.py is asserted on the
  // IDF heap_log_mcore.svdat oracle above. It is *not* re-asserted on this
  // P4 capture: its richer ISR/idle interleaving exercises the deliberate
  // divergence from espytrace (this parser treats svIdle as a switch to IDLE),
  // so an ISR that makes a task ready during idle is attributed to the ISR
  // by espytrace but to IDLE by this parser — a difference the oracle's idle-region
  // normalization cannot mask (it assumes in_irq matches on both sides).
});

// The OS event table is picked from the stream's own `O=<name>`. Only ESP-IDF
// FreeRTOS and Zephyr are supported; anything else falls back to the default.
describe("parser: OS table selection", () => {
  it("resolveOsEvents picks the table from the announced OS", () => {
    // Event id 33 is the cleanest tell for the IDF FreeRTOS numbering.
    assert.equal(resolveOsEvents("FreeRTOS")![33]!.name, "vTaskDelete");
    assert.equal(resolveOsEvents("Zephyr")![41]!.name, "k_sem_give");
    assert.equal(resolveOsEvents("embOS"), null);
    assert.equal(resolveOsEvents("nonesuch"), null);
  });

  it("decodes id 33 as vTaskDelete on a FreeRTOS stream (IDF numbering)", () => {
    const trace = parseCoreStream(
      svdat(
        event(EVTID.INIT, [...u32(SYS_FREQ), ...u32(1), ...u32(0), ...u32(0)], 0),
        event(EVTID.SYSDESC, str("N=App,D=esp32p4,C=core0,O=FreeRTOS"), 0),
        event(33, u32(0x1234), 1),
      ),
    );
    assert.ok(trace.events.some((e) => e.name === "vTaskDelete"));
  });
});

