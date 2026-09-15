/**
 * SVDAT trace parser for binary event streams.
 *
 * Decodes raw SVDAT byte streams into structured trace models containing system
 * information, task and IRQ tables, and decoded events with absolute timestamps
 * and typed parameters.
 *
 * Adapted from Espressif `tools/esp_app_trace/espytrace/sysview.py` (`parse_trace`
 * and `SysViewTraceDataParser`), operating on in-memory buffers (`Uint8Array`).
 * Execution-context tracking and multi-core merging are implemented in {@link ./processor.ts}.
 *
 * Supported events include predefined SystemView events, OS event maps resolved from
 * `svSysDesc` (`O=<os>`, see {@link ./os-registry.ts}), registered module events, and
 * `svPrint` logs. Unknown OS and module events are skipped using their declared payload
 * length (`plen`), allowing streams with unmapped events to parse without errors.
 */

import {
  EventFormat,
  ParamKind,
  EVTID,
  SYSVIEW_EVTID_EX,
  MODULE_EVENT_OFFSET,
  SYSVIEW_PREDEF_EVENTS,
  SYSVIEW_PREDEF_LEN_MAX,
  SYSVIEW_PREDEF_MAX,
  SYNC_LEN,
} from "./events.js";
import {
  DEFAULT_OS_EVENTS,
  type EventMap,
  resolveModuleEvents,
  resolveOsEvents,
} from "./os-registry.js";

/** A decoded parameter value. `arr_u32` decodes to `number[]`; `u64` to `bigint`. */
export type ParamValue = number | bigint | string | number[];

/** System description decoded from `svInit`. */
export interface TraceSystemInfo {
  /** Timestamp clock frequency (Hz) used to convert cycle deltas to seconds. */
  sysFreq: number;
  /** CPU frequency (Hz). */
  cpuFreq: number;
  /** Base address subtracted from pointers by the target before encoding. */
  ramBase: number;
  /** Right-shift applied to IDs before transmission (0 on ESP targets). */
  idShift: number;
}

/** One fully decoded trace event. */
export interface TraceEvent {
  /** Event id. */
  id: number;
  /** Source core id (the per-file core for a single-core stream). */
  coreId: number;
  /** Symbolic event name (e.g. `svTaskStartExec`, `xQueueGenericSend`). */
  name: string;
  /**
   * Event timestamp in seconds relative to `svTraceStart`. Before `svInit`
   * establishes {@link TraceSystemInfo.sysFreq}, this holds the raw cycle delta;
   * afterward it holds absolute time.
   */
  ts: number;
  /** Raw timestamp delta (cycles) decoded from this packet's trailing varint. */
  tsDelta: number;
  /** Declared payload length in bytes (0 for fixed-layout predefined events). */
  plen: number;
  /** Decoded payload parameters, keyed by name. */
  params: Record<string, ParamValue>;
  /** Execution context (task or IRQ name), populated by the processor ("None" prior to processing). */
  ctxName: string;
  /** Whether the event occurred in an IRQ context, populated by the processor. */
  inIrq: boolean;
  /** Payload layout used to decode the parameters, when the event table has one. */
  fmt?: EventFormat;
  /** ELF symbols for the event's kernel object handles, keyed by parameter name. Set by the processor when an ELF is loaded. */
  handles?: Record<string, HandleSymbol>;
}

/** The ELF symbol at a kernel object handle's address. */
export interface HandleSymbol {
  /** Address the handle resolved at: the raw value, or the value expanded by `svInit`'s `ram_base` and `id_shift`. */
  addr: number;
  /** Symbol name, with `+0x<offset>` appended when the address is inside the symbol. */
  name: string;
}

/** Byte offset range `[start, end)` of an event packet within the SVDAT stream. */
export interface EventSpan {
  start: number;
  end: number;
}

/** The parsed model of one single-core SVDAT stream. */
export interface CoreTrace {
  /** Core id this stream belongs to. */
  coreId: number;
  /** Verbatim textual header lines (including trailing newlines). */
  header: string[];
  /** System description from `svInit`, or `null` if the stream had none. */
  sysInfo: TraceSystemInfo | null;
  /** Task id → task name, accumulated from `svTaskInfo`. */
  tasks: Map<number, string>;
  /** IRQ number → name, accumulated from `svSysDesc` `I#<n>=<name>` entries. */
  irqs: Map<number, string>;
  /**
   * Absolute timestamp (seconds) on the target clock corresponding to time zero on
   * this core's timeline: the cycle count offset established at `svTraceStart`, or `0`
   * if the stream omits `svTraceStart`. Multi-core merging uses this offset to align
   * timestamps across cores to a unified timebase.
   */
  tsOrigin: number;
  /**
   * Truncated application ELF SHA-256 digest reported by the target in `svSysDesc`
   * (`ELF_SHA256=...`), or `null` if omitted.
   */
  elfSha256: string | null;
  /** Decoded events, in stream order. */
  events: TraceEvent[];
}

/** Thrown internally when a read operation reaches the end of the buffer. */
class EndOfStream extends Error {
  constructor() {
    super("end of stream");
    this.name = "EndOfStream";
  }
}

/** Raised for malformed streams (invalid sync sequence or inconsistent payload length). */
export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceParseError";
  }
}

/**
 * Sequential byte reader for SVDAT streams. Decoding methods implement LEB128
 * integer and length-prefixed string decoders matching `espytrace/sysview.py`.
 * Reading past buffer bounds throws {@link EndOfStream}.
 */
class ByteReader {
  private readonly buf: Uint8Array;
  pos: number;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.byteLength;
  }

  readByte(): number {
    if (this.pos >= this.buf.byteLength) throw new EndOfStream();
    return this.buf[this.pos++]!;
  }

  /** Read `n` raw bytes (a view into the underlying buffer). */
  read(n: number): Uint8Array {
    if (this.pos + n > this.buf.byteLength) throw new EndOfStream();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Skip `n` bytes. */
  forward(n: number): void {
    if (this.pos + n > this.buf.byteLength) throw new EndOfStream();
    this.pos += n;
  }

  /** Decode a 7-bit-per-byte little-endian LEB128 unsigned 32-bit integer. */
  decodeU32(): number {
    let val = 0;
    let shift = 0;
    for (;;) {
      const b = this.readByte();
      if (b & 0x80) {
        val |= (b & 0x7f) << shift;
      } else {
        val |= b << shift;
        break;
      }
      shift += 7;
    }
    return val >>> 0;
  }

  /** Decode an unsigned 64-bit integer (low `u32` then high `u32`). */
  decodeU64(): bigint {
    const lo = BigInt(this.decodeU32());
    const hi = BigInt(this.decodeU32());
    return lo | (hi << 32n);
  }

  /** Decode a length-prefixed UTF-8 string. */
  decodeStr(): string {
    let len = this.readByte();
    if (len === 0xff) {
      const b = this.read(2);
      len = (b[0]! << 8) | b[1]!; // 2-byte length is big-endian
    }
    return new TextDecoder().decode(this.read(len));
  }

  /** Decode an event payload length (1 byte, or 2 bytes if the high bit is set). */
  decodePlen(): number {
    const b0 = this.readByte();
    if (b0 & 0x80) {
      const b1 = this.readByte();
      return (b1 << 7) | (b0 & 0x7f);
    }
    return b0;
  }

  /** Read one line including its trailing `\n` (used for the textual header). */
  readLine(): string {
    const start = this.pos;
    while (this.pos < this.buf.byteLength && this.buf[this.pos] !== 0x0a) this.pos++;
    if (this.pos < this.buf.byteLength) this.pos++; // include the newline
    return new TextDecoder().decode(this.buf.subarray(start, this.pos));
  }
}

/**
 * Reads textual header lines up to and including the second `;` line separator.
 */
function readHeader(reader: ByteReader): string[] {
  const lines: string[] = [];
  let emptyCount = 0;
  while (emptyCount < 2) {
    const line = reader.readLine();
    lines.push(line);
    // Tolerate CRLF line endings (Windows exports use ";\r\n").
    if (line === ";\n" || line === ";\r\n") emptyCount++;
    if (reader.eof) break; // defensive: malformed header without two separators
  }
  return lines;
}

/**
 * Advances the reader past the first occurrence of {@link SYNC_LEN} consecutive zero bytes.
 * Scans forward from the current position to accommodate header padding bytes.
 * Throws {@link TraceParseError} if no synchronization sequence is found.
 */
function readSync(reader: ByteReader): void {
  let run = 0;
  while (!reader.eof) {
    if (reader.readByte() === 0) {
      if (++run === SYNC_LEN) return; // reader is positioned directly past the sync
    } else {
      run = 0;
    }
  }
  throw new TraceParseError("invalid sync sequence");
}

/** Decode one parameter and return its value, advancing the reader. */
function decodeParam(reader: ByteReader, kind: ParamKind, remaining: number): ParamValue {
  switch (kind) {
    case "u32":
    case "id":
      return reader.decodeU32();
    case "u64":
      return reader.decodeU64();
    case "str":
      return reader.decodeStr();
    case "arr_u32": {
      const vals: number[] = [];
      const start = reader.pos;
      while (reader.pos - start < remaining) vals.push(reader.decodeU32());
      return vals;
    }
  }
}

/**
 * Decodes an `svEndCall` payload: the event ID of the API call that returned, resolved to
 * that event's name through `nameFor`, plus the return value when one was recorded.
 */
function decodeEndCall(
  payload: Uint8Array,
  nameFor: (id: number) => string | undefined,
): Record<string, ParamValue> {
  const r = new ByteReader(payload);
  const callId = r.decodeU32();
  const params: Record<string, ParamValue> = { call: nameFor(callId) ?? `svEvent_${callId}` };
  if (r.pos < payload.length) params["ret"] = r.decodeU32();
  return params;
}

/** DataView used to convert `u32` bit patterns to IEEE-754 float32 values. */
const f32View = new DataView(new ArrayBuffer(4));

/** Converts a 32-bit unsigned integer to an IEEE-754 float32 value. */
function bitsToFloat32(bits: number): number {
  f32View.setUint32(0, bits >>> 0, true);
  return f32View.getFloat32(0, true);
}

/**
 * Decodes an extended ({@link EVTID.EX}) event payload.
 *
 * Extended packets multiplex sub-IDs via their first `u32` value (`SYSVIEW_EVTID_EX_*`).
 * Decodes `REGISTER_DATA` payloads containing series metadata: `data_id`, `name`,
 * and optional trailing fields `data_type`, `offset`, `range_min`, `range_max`,
 * `scaling`, and `unit`. Returns `null` for unhandled sub-IDs.
 */
function decodeExtendedEvent(
  payload: Uint8Array,
): { name: string; params: Record<string, ParamValue> } | null {
  const r = new ByteReader(payload);
  const subId = r.decodeU32();
  if (subId !== SYSVIEW_EVTID_EX.REGISTER_DATA) return null;
  const params: Record<string, ParamValue> = {
    data_id: r.decodeU32(),
    name: r.decodeStr(),
  };
  // Signed reading: Offset/RangeMin/RangeMax are I32 on the target.
  const i32 = (v: number): number => v | 0;
  if (r.pos < payload.length) params["data_type"] = r.decodeU32();
  if (r.pos < payload.length) params["offset"] = i32(r.decodeU32());
  if (r.pos < payload.length) params["range_min"] = i32(r.decodeU32());
  if (r.pos < payload.length) params["range_max"] = i32(r.decodeU32());
  if (r.pos < payload.length) params["scaling"] = bitsToFloat32(r.decodeU32());
  if (r.pos < payload.length) params["unit"] = r.decodeStr();
  return { name: "svRegisterData", params };
}

/**
 * Decodes event parameters according to the specified {@link EventFormat}.
 * `totalLen` specifies the maximum byte length for trailing `arr_u32` parameters;
 * pass 0 for fixed-layout events.
 */
function decodeParams(
  reader: ByteReader,
  fmt: EventFormat,
  totalLen: number,
): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  let consumed = 0;
  for (const p of fmt.params) {
    const before = reader.pos;
    params[p.name] = decodeParam(reader, p.kind, totalLen - consumed);
    consumed += reader.pos - before;
  }
  return params;
}

/**
 * Per-core SVDAT stream parser. Decodes events, calculates timestamps,
 * maintains task and IRQ tables, and registers module event offsets.
 */
class CoreParser {
  readonly coreId: number;
  private lastTs = 0;
  /** Cycle count `svTraceStart` zeroed away; see {@link CoreTrace.tsOrigin}. */
  private tsOriginCycles = 0;
  sysInfo: TraceSystemInfo | null = null;
  readonly tasks = new Map<number, string>();
  readonly irqs = new Map<number, string>();
  readonly events: TraceEvent[] = [];
  /** OS event table for IDs 32..511, selected from `svSysDesc` `O=` metadata. */
  private osEvents: EventMap;
  /** Whether {@link osEvents} was explicitly specified by the caller. */
  private readonly osForced: boolean;
  /** OS name from the most recent `svSysDesc` `O=` field. */
  private osName: string | null = null;
  /** Truncated application ELF SHA-256 digest from `svSysDesc` `ELF_SHA256=`. */
  elfSha256: string | null = null;
  /** Registered module event maps and their base offsets from `svModuleDesc`. */
  private readonly modules: { off: number; events: EventMap }[] = [];
  /**
   * Byte offset span `[start, end)` of each event within the stream, parallel to {@link events}.
   * Populated when `collectSpans` is enabled in the constructor.
   */
  readonly spans: EventSpan[] = [];
  private readonly collectSpans: boolean;

  constructor(coreId: number, osOverride?: EventMap, collectSpans = false) {
    this.coreId = coreId;
    this.osEvents = osOverride ?? DEFAULT_OS_EVENTS;
    this.osForced = osOverride !== undefined;
    this.collectSpans = collectSpans;
  }

  /** Decode one event at the reader's cursor. */
  private readEvent(reader: ByteReader): TraceEvent {
    const hdr = reader.readByte();
    let id: number;
    if (hdr & 0x80) {
      // Two-byte event id: high 7 bits in the next byte, low 7 bits in hdr.
      const b = reader.readByte();
      id = (b << 7) | (hdr & 0x7f);
    } else {
      id = hdr;
    }

    const fmt = this.formatFor(id);
    let plen = 0;
    let params: Record<string, ParamValue> = {};
    let name: string | null = null;
    let decoded = true;

    if (id >= SYSVIEW_PREDEF_LEN_MAX) {
      // Explicit payload length defines packet boundary. The reader advances
      // exactly `plen` bytes to prevent unknown or mismatched layouts from
      // desynchronizing subsequent packet reads.
      plen = reader.decodePlen();
      const payload = reader.read(plen);
      if (id === EVTID.EX) {
        // Extended events multiplex sub-IDs in the first payload field.
        try {
          const ex = decodeExtendedEvent(payload);
          if (ex) {
            params = ex.params;
            name = ex.name;
          } else {
            decoded = false;
          }
        } catch (e) {
          if (e instanceof EndOfStream) decoded = false;
          else throw e;
        }
      } else if (id === EVTID.END_CALL) {
        try {
          params = decodeEndCall(payload, (callId) => this.formatFor(callId)?.name);
        } catch (e) {
          if (e instanceof EndOfStream) decoded = false;
          else throw e;
        }
      } else if (fmt) {
        try {
          const sub = new ByteReader(payload);
          const p = decodeParams(sub, fmt, plen);
          if (sub.pos === plen) params = p;
          else decoded = false;
        } catch (e) {
          if (e instanceof EndOfStream) decoded = false;
          else throw e;
        }
      } else {
        decoded = false;
      }
    } else {
      // Predefined event with fixed layout defined by the event table.
      params = decodeParams(reader, fmt!, 0);
    }

    const tsDelta = reader.decodeU32();
    return {
      id,
      coreId: this.coreId,
      name: decoded ? (name ?? fmt?.name ?? `svEvent_${id}`) : `svEvent_${id}`,
      ts: tsDelta,
      tsDelta,
      plen,
      params: decoded ? params : {},
      ctxName: "None",
      inIrq: false,
      ...(decoded && fmt ? { fmt } : {}),
    };
  }

  /** Resolve the payload layout for an event id, or `null` to skip its payload. */
  private formatFor(id: number): EventFormat | null {
    if (id <= SYSVIEW_PREDEF_MAX) return SYSVIEW_PREDEF_EVENTS[id] ?? null;
    if (id < MODULE_EVENT_OFFSET) return this.osEvents[id] ?? null;
    // Search registered modules in reverse order so higher offset registrations
    // take precedence on overlapping ID ranges.
    for (let i = this.modules.length - 1; i >= 0; i--) {
      const mod = this.modules[i]!;
      if (id >= mod.off) {
        const fmt = mod.events[id - mod.off];
        if (fmt) return fmt;
      }
    }
    return null;
  }

  /**
   * Updates timestamps and populates system information, task tables, and IRQ tables.
   */
  private onNewEvent(event: TraceEvent): void {
    if (event.id === EVTID.TRACE_START) {
      event.ts = 0;
      this.lastTs = 0;
      this.tsOriginCycles = event.tsDelta;
    } else if (this.sysInfo) {
      event.ts = this.updateTs(event.tsDelta);
    }

    if (event.id === EVTID.INIT) {
      this.sysInfo = {
        sysFreq: event.params["sys_freq"] as number,
        cpuFreq: event.params["cpu_freq"] as number,
        ramBase: event.params["ram_base"] as number,
        idShift: event.params["id_shift"] as number,
      };
      event.ts = this.updateTs(event.tsDelta);
    } else if (event.id === EVTID.TASK_INFO) {
      this.tasks.set(event.params["tid"] as number, event.params["name"] as string);
    } else if (event.id === EVTID.SYSDESC) {
      const { irqs, os, elfSha256 } = parseSysDesc(event.params["desc"] as string);
      for (const irq of irqs) this.irqs.set(irq.num, irq.name);
      // Resolve the OS event table from the specified OS unless explicitly overridden.
      if (os) this.osName = os;
      if (elfSha256) this.elfSha256 = elfSha256;
      if (!this.osForced && this.osName) {
        const map = resolveOsEvents(this.osName);
        if (map) this.osEvents = map;
      }
    } else if (event.id === EVTID.MODULEDESC) {
      const events = resolveModuleEvents(event.params["desc"] as string);
      if (events) this.modules.push({ off: event.params["evt_off"] as number, events });
    }

    this.events.push(event);
  }

  /** Timestamp offset in seconds; 0 until `svInit` provides the timestamp clock frequency. */
  get tsOrigin(): number {
    return this.sysInfo ? this.tsOriginCycles / this.sysInfo.sysFreq : 0;
  }

  /** Converts accumulated cycle counts to seconds using `sysFreq`. */
  private updateTs(delta: number): number {
    this.lastTs += delta;
    return this.lastTs / this.sysInfo!.sysFreq;
  }

  /** Parses events from the byte stream starting after the synchronization sequence. */
  parse(reader: ByteReader): void {
    for (;;) {
      const mark = reader.pos;
      let event: TraceEvent;
      try {
        event = this.readEvent(reader);
      } catch (e) {
        if (e instanceof EndOfStream) {
          reader.pos = mark; // Reset cursor to packet start on incomplete trailing data
          break;
        }
        throw e;
      }
      this.onNewEvent(event);
      if (this.collectSpans) this.spans.push({ start: mark, end: reader.pos });
    }
  }
}

/**
 * Parses a `svSysDesc` system description string.
 *
 * Extracts comma-separated IRQ definitions (`I#<n>=<name>`), OS identifiers (`O=<os>`),
 * device names (`D=<chip>`), and application ELF digests (`ELF_SHA256=<hex>`).
 * Handles single-IRQ and multi-IRQ description entries.
 */
function parseSysDesc(desc: string): {
  irqs: { num: number; name: string }[];
  os: string | null;
  dev: string | null;
  elfSha256: string | null;
} {
  const irqs: { num: number; name: string }[] = [];
  let os: string | null = null;
  let dev: string | null = null;
  let elfSha256: string | null = null;
  for (const entry of desc.split(",")) {
    const irq = /^\s*I#([0-9]+)=(.+)$/.exec(entry);
    if (irq) {
      irqs.push({ num: parseInt(irq[1]!, 10), name: irq[2]!.trim() });
      continue;
    }
    const o = /^\s*O=(.+)$/.exec(entry);
    if (o) {
      os = o[1]!.trim();
      continue;
    }
    const elf = /^\s*ELF_SHA256=([0-9a-fA-F]+)\s*$/.exec(entry);
    if (elf) {
      elfSha256 = elf[1]!.toLowerCase();
      continue;
    }
    const d = /^\s*D=(.+)$/.exec(entry);
    if (d) dev = d[1]!.trim();
  }
  return { irqs, os, dev, elfSha256 };
}

/**
 * Parses a single-core SVDAT byte stream into a {@link CoreTrace}.
 *
 * @param data Byte buffer containing header, synchronization sequence, and events.
 * @param coreId Core ID assigned to decoded events.
 * @param osOverride Optional OS event table override; defaults to auto-detection with FreeRTOS fallback.
 */
export function parseCoreStream(
  data: Uint8Array,
  coreId = 0,
  osOverride?: EventMap,
): CoreTrace {
  const reader = new ByteReader(data);
  const header = readHeader(reader);
  readSync(reader);
  const parser = new CoreParser(coreId, osOverride);
  parser.parse(reader);
  return {
    coreId,
    header,
    sysInfo: parser.sysInfo,
    tasks: parser.tasks,
    irqs: parser.irqs,
    tsOrigin: parser.tsOrigin,
    elfSha256: parser.elfSha256,
    events: parser.events,
  };
}

/**
 * Parses a single-core SVDAT stream and returns byte spans for each decoded event.
 *
 * Returns byte offset ranges `[start, end)` within `data` parallel to `trace.events`,
 * used by encoders to insert packets without modifying unrelated stream bytes.
 */
export function indexCoreStream(
  data: Uint8Array,
  coreId = 0,
  osOverride?: EventMap,
): { trace: CoreTrace; spans: EventSpan[] } {
  const reader = new ByteReader(data);
  const header = readHeader(reader);
  readSync(reader);
  const parser = new CoreParser(coreId, osOverride, true);
  parser.parse(reader);
  return {
    trace: {
      coreId,
      header,
      sysInfo: parser.sysInfo,
      tasks: parser.tasks,
      irqs: parser.irqs,
      tsOrigin: parser.tsOrigin,
      elfSha256: parser.elfSha256,
      events: parser.events,
    },
    spans: parser.spans,
  };
}

/** Returns the byte offset immediately following the first {@link SYNC_LEN} zero bytes, or -1. */
function syncEnd(buf: Uint8Array): number {
  let run = 0;
  for (let i = 0; i < buf.byteLength; i++) {
    run = buf[i] === 0 ? run + 1 : 0;
    if (run === SYNC_LEN) return i + 1;
  }
  return -1;
}

/** Concatenates two byte arrays into a new buffer. */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * Incremental single-core parser for streaming SVDAT data.
 *
 * Parses incoming byte fragments incrementally without requiring a complete file
 * or textual header. Unconsumed trailing bytes from partial packets remain buffered
 * between calls to {@link push}.
 */
export class StreamingCoreParser {
  /** Core ID assigned to decoded events. */
  readonly coreId: number;

  private readonly parser: CoreParser;
  /** Unconsumed buffered bytes (incomplete packets or pre-synchronization data). */
  private pending: Uint8Array = new Uint8Array(0);
  /** Indicates whether the opening synchronization sequence has been processed. */
  private synced = false;

  constructor(coreId = 0, osOverride?: EventMap) {
    this.coreId = coreId;
    this.parser = new CoreParser(coreId, osOverride);
  }

  /** Appends and decodes incoming byte chunks. */
  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.pending = this.pending.byteLength ? concatBytes(this.pending, bytes) : bytes.slice();

    if (!this.synced) {
      const past = syncEnd(this.pending);
      if (past < 0) return; // Incomplete synchronization sequence; continue buffering
      this.pending = this.pending.slice(past);
      this.synced = true;
    }

    const reader = new ByteReader(this.pending);
    this.parser.parse(reader);
    // Retain unconsumed trailing bytes.
    if (reader.pos > 0) this.pending = this.pending.slice(reader.pos);
  }

  /**
   * Returns the accumulated {@link CoreTrace} decoded from processed input.
   * The `header` array is empty for live streams.
   */
  get trace(): CoreTrace {
    return {
      coreId: this.coreId,
      header: [],
      sysInfo: this.parser.sysInfo,
      tasks: this.parser.tasks,
      irqs: this.parser.irqs,
      tsOrigin: this.parser.tsOrigin,
      elfSha256: this.parser.elfSha256,
      events: this.parser.events,
    };
  }
}
