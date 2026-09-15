/**
 * Generate the Zephyr OS event table from Zephyr's SystemView tracing headers.
 *
 * `subsys/tracing/sysview/tracing_sysview_ids.h` gives each `TID_*` its event ID
 * (`(<n>u + TID_OFFSET)`). `tracing_sysview.h` gives each event its payload: the
 * `sys_port_trace_*` macro whose body records the event, with `RecordVoid` / `RecordU32` /
 * `RecordU32x2..4` / `RecordString` fixing the field count and the macro arguments naming
 * the fields. An argument cast through `(uintptr_t)` is a kernel object pointer (`id`); a
 * `RecordString` argument is a `str`; everything else is a `u32`. `RecordEndCall*` bodies
 * describe the shared `svEndCall` event, not a layout. The event name is the API the macro
 * instruments (`sys_port_trace_k_mutex_lock_enter` → `k_mutex_lock`).
 *
 * `named_event` is built by hand in `sysview.c` and has a fixed entry below.
 *
 * Usage:
 *   npx tsx scripts/gen-zephyr-events.ts <zephyr-root> > src/trace/os/zephyr.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ParamKind } from "../src/trace/events.ts";

/** One decoded event description: id, symbolic name, ordered payload layout. */
interface ParsedEvent {
  id: number;
  name: string;
  params: { name: string; kind: ParamKind }[];
}

const SYSVIEW_DIR = "subsys/tracing/sysview";

/** Events whose packets `sysview.c` assembles by hand, keyed by `TID_*` name. */
const HAND_BUILT: Record<string, { name: string; params: { name: string; kind: ParamKind }[] }> = {
  TID_NAMED_EVENT: {
    name: "named_event",
    params: [{ name: "name", kind: "str" }, { name: "arg0", kind: "u32" }, { name: "arg1", kind: "u32" }],
  },
};

/** Reads `#define TID_<name> (<n>u + TID_OFFSET)` lines into a `TID_*` → id map. */
function parseIds(text: string): Map<string, number> {
  const ids = new Map<string, number>();
  const offset = /#define TID_OFFSET\s+\((\d+)u\)/.exec(text);
  if (!offset) throw new Error("TID_OFFSET not found in tracing_sysview_ids.h");
  const base = parseInt(offset[1]!, 10);
  for (const m of text.matchAll(/#define (TID_\w+)\s+\((\d+)u \+ TID_OFFSET\)/g)) {
    ids.set(m[1]!, parseInt(m[2]!, 10) + base);
  }
  return ids;
}

/** Splits a C argument list on top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((a) => a.trim());
}

/** Returns `name` made unique within `params` by appending `_2`, `_3`, … as needed. */
function uniqueName(params: { name: string }[], name: string): string {
  let candidate = name;
  for (let n = 2; params.some((p) => p.name === candidate); n++) candidate = `${name}_${n}`;
  return candidate;
}

/**
 * Names and types one recorded argument. Casts are stripped from the front and the
 * leading identifier is the field name: `(uint32_t)(uintptr_t)mutex` → `mutex` (id),
 * `(uint32_t)timeout.ticks` → `timeout` (u32), `(const char *)#name` → `name` (str).
 */
function argParam(arg: string, kind: ParamKind): { name: string; kind: ParamKind } {
  const isPointer = /\(\s*uintptr_t\s*\)/.test(arg);
  const stripped = arg.replace(/^(\s*\([\w\s*]+\)\s*)+/, "").replace(/^#/, "");
  const ident = /([A-Za-z_]\w*)/.exec(stripped);
  return { name: ident?.[1] ?? "arg", kind: kind === "u32" && isPointer ? "id" : kind };
}

const RECORD_ARITY: Record<string, number> = { Void: 0, U32: 1, U32x2: 2, U32x3: 3, U32x4: 4, String: 1 };

/**
 * Walks the `sys_port_trace_*` macros and returns the layout of every event they record,
 * keyed by event ID. Where several macros record the same ID (an `_enter` variant and a
 * plain one, say) the first layout wins; they agree in Zephyr's tree.
 */
function parseMacros(text: string, ids: Map<string, number>): Map<number, ParsedEvent> {
  const events = new Map<number, ParsedEvent>();
  const joined = text.replace(/\\\r?\n/g, " ");
  const macro = /#define sys_port_trace_(\w+?)(?:_enter)?\(([^)]*)\)\s+(.*)/g;
  for (const m of joined.matchAll(macro)) {
    const api = m[1]!;
    const body = m[3]!;
    const rec = /SEGGER_SYSVIEW_Record(Void|U32x4|U32x3|U32x2|U32|String)\(\s*(TID_\w+)\s*(?:,(.*))?\)\s*$/.exec(body);
    if (!rec) continue;
    const id = ids.get(rec[2]!);
    if (id === undefined) throw new Error(`${rec[2]} has no ID in tracing_sysview_ids.h`);
    if (events.has(id)) continue;
    const arity = RECORD_ARITY[rec[1]!]!;
    const args = rec[3] ? splitArgs(rec[3]) : [];
    if (args.length !== arity) throw new Error(`${rec[2]}: expected ${arity} arguments, got ${args.length}`);
    const kind: ParamKind = rec[1] === "String" ? "str" : "u32";
    const params: { name: string; kind: ParamKind }[] = [];
    for (const a of args) {
      const p = argParam(a, kind);
      params.push({ name: uniqueName(params, p.name), kind: p.kind });
    }
    events.set(id, { id, name: api, params });
  }
  return events;
}

const root = process.argv[2];
if (!root) throw new Error("usage: gen-zephyr-events.ts <zephyr-root>");
const read = (file: string): string => readFileSync(join(root, SYSVIEW_DIR, file), "utf8");

const ids = parseIds(read("tracing_sysview_ids.h"));
const events = parseMacros(read("tracing_sysview.h"), ids);
for (const [tid, e] of Object.entries(HAND_BUILT)) {
  const id = ids.get(tid);
  if (id === undefined) throw new Error(`${tid} has no ID in tracing_sysview_ids.h`);
  events.set(id, { id, ...e });
}

const lines = [...events.values()]
  .sort((a, b) => a.id - b.id)
  .map((e) => {
    const params = e.params
      .map((p) => `{ name: ${JSON.stringify(p.name)}, kind: "${p.kind}" }`)
      .join(", ");
    return `  ${e.id}: { name: ${JSON.stringify(e.name)}, params: [${params}] },`;
  });

process.stdout.write(`// AUTO-GENERATED from Zephyr's subsys/tracing/sysview/tracing_sysview_ids.h
// and tracing_sysview.h (Apache-2.0).
// Do not edit by hand; regenerate with scripts/gen-zephyr-events.ts.

import type { EventFormat } from "../events.js";

export const ZEPHYR_OS_EVENTS: Readonly<Record<number, EventFormat>> = {
${lines.join("\n")}
};
`);
