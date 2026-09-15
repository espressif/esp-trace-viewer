/**
 * Regenerate src/trace/os/freertos.ts from IDF's SYSVIEW_FreeRTOS.txt.
 *
 * Usage (needs IDF_PATH, or pass the file path as the first argument):
 *   npx tsx scripts/gen-freertos-events.ts > src/trace/os/freertos.ts
 *
 * Mirrors espytrace.sysview._read_events_map: each non-empty line is
 *   <id> <name> [<param>=%<fmt> ...]
 * where %u -> u32, %s -> str, %t/%T/%I/%p -> id. Other format characters
 * (%x on heap callers) are omitted; dedicated module handlers decode those events.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ParamKind } from "../src/trace/events.ts";

function kindFor(fmt: string): ParamKind | null {
  const f = fmt.startsWith("%") ? fmt.slice(1) : fmt;
  if (f === "u") return "u32";
  if (f === "s") return "str";
  if (f === "t" || f === "T" || f === "I" || f === "p") return "id";
  return null;
}

const src =
  process.argv[2] ??
  join(process.env["IDF_PATH"] ?? "", "tools", "esp_app_trace", "SYSVIEW_FreeRTOS.txt");

const lines: string[] = [];
for (const line of readFileSync(src, "utf8").split("\n")) {
  const comps = line.split(/\s+/).filter(Boolean);
  if (comps.length < 2) continue;
  const id = parseInt(comps[0]!, 10);
  const name = comps[1]!;
  const params: string[] = [];
  for (const p of comps.slice(2)) {
    const [pname, fmt] = p.split("=");
    if (!pname || !fmt) continue;
    const kind = kindFor(fmt);
    if (kind) params.push(`{ name: "${pname}", kind: "${kind}" }`);
  }
  lines.push(`  ${id}: { name: "${name}", params: [${params.join(", ")}] },`);
}

const out = `// AUTO-GENERATED from IDF tools/esp_app_trace/SYSVIEW_FreeRTOS.txt.
// Do not edit by hand; regenerate with scripts/gen-freertos-events.ts.
// Mirrors espytrace.sysview._read_events_map: each line is
//   <id> <name> [<param>=%<fmt> ...]   where %u->u32, %s->str, %t/%T/%I/%p->id.
// Other format characters (%x on heap callers) are omitted here and decoded
// by dedicated module handlers.

import type { EventFormat } from "../events.js";

export const FREERTOS_OS_EVENTS: Readonly<Record<number, EventFormat>> = {
${lines.join("\n")}
};
`;

process.stdout.write(out);
