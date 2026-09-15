/**
 * Generate deterministic ELF-identity test fixtures:
 *   - test/fixtures/elf/demo-app.elf — an ELF32-LE binary with a symbol table and a
 *     `.rodata` section for resolving symbols and strings;
 *   - test/fixtures/traces/elf-id.svdat — a minimal FreeRTOS capture whose
 *     svSysDesc carries `ELF_SHA256=<prefix>` matching that ELF.
 *
 * These fixtures allow the unit and e2e test suites to exercise ELF verification
 * and symbolization without hardware.
 *
 *   npx tsx scripts/gen-elf-id-fixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseElfSymbols, sha256Hex } from "../src/elf/index.js";
import { EVTID, MODULE_EVENT_OFFSET, SYNC_LEN } from "../src/trace/events.js";
import { parseTraceFiles } from "../src/trace/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ELF_OUT = join(ROOT, "test/fixtures/elf/demo-app.elf");
const SVDAT_OUT = join(ROOT, "test/fixtures/traces/elf-id.svdat");

/** Number of hexadecimal characters of the SHA-256 hash stored in the trace (esp_sysview truncates). */
const HASH_CHARS = 16;

const STT_OBJECT = 1;
const STT_FUNC = 2;

interface SymSpec {
  name: string;
  value: number;
  size: number;
  type: number;
}

/**
 * Assemble a minimal ELF32-LE binary: 52-byte ELF header, .symtab, .strtab, and an
 * allocated .rodata PROGBITS section.
 */
function buildElf(symbols: SymSpec[], rodata: { addr: number; bytes: Uint8Array }): Uint8Array {
  const EHDR = 52;
  const SHENT = 40;
  const SYMSZ = 16;

  let strtabStr = "\0";
  const nameOff = new Map<string, number>();
  for (const s of symbols) {
    if (!nameOff.has(s.name)) {
      nameOff.set(s.name, strtabStr.length);
      strtabStr += s.name + "\0";
    }
  }
  const strtab = new TextEncoder().encode(strtabStr);

  const symtab = new Uint8Array((symbols.length + 1) * SYMSZ);
  const symDv = new DataView(symtab.buffer);
  symbols.forEach((s, i) => {
    const o = (i + 1) * SYMSZ;
    symDv.setUint32(o + 0, nameOff.get(s.name)!, true);
    symDv.setUint32(o + 4, s.value, true);
    symDv.setUint32(o + 8, s.size, true);
    symtab[o + 12] = s.type & 0xf;
  });

  const symtabOff = EHDR;
  const strtabOff = symtabOff + symtab.byteLength;
  const rodataOff = strtabOff + strtab.byteLength;
  const shoff = rodataOff + rodata.bytes.byteLength;
  const SHNUM = 4; // null, symtab, strtab, rodata
  const buf = new Uint8Array(shoff + SHNUM * SHENT);
  const dv = new DataView(buf.buffer);

  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0); // magic, ELFCLASS32, ELFDATA2LSB, version
  dv.setUint16(16, 2, true); // e_type ET_EXEC
  dv.setUint16(18, 243, true); // e_machine EM_RISCV
  dv.setUint32(20, 1, true); // e_version
  dv.setUint32(32, shoff, true); // e_shoff
  dv.setUint16(46, SHENT, true); // e_shentsize
  dv.setUint16(48, SHNUM, true); // e_shnum

  buf.set(symtab, symtabOff);
  buf.set(strtab, strtabOff);
  buf.set(rodata.bytes, rodataOff);

  dv.setUint32(shoff + 1 * SHENT + 4, 2, true); // sh_type SHT_SYMTAB
  dv.setUint32(shoff + 1 * SHENT + 16, symtabOff, true);
  dv.setUint32(shoff + 1 * SHENT + 20, symtab.byteLength, true);
  dv.setUint32(shoff + 1 * SHENT + 24, 2, true); // sh_link → strtab
  dv.setUint32(shoff + 2 * SHENT + 4, 3, true); // sh_type SHT_STRTAB
  dv.setUint32(shoff + 2 * SHENT + 16, strtabOff, true);
  dv.setUint32(shoff + 2 * SHENT + 20, strtab.byteLength, true);
  dv.setUint32(shoff + 3 * SHENT + 4, 1, true); // sh_type SHT_PROGBITS
  dv.setUint32(shoff + 3 * SHENT + 8, 0x2, true); // sh_flags SHF_ALLOC
  dv.setUint32(shoff + 3 * SHENT + 12, rodata.addr, true); // sh_addr
  dv.setUint32(shoff + 3 * SHENT + 16, rodataOff, true);
  dv.setUint32(shoff + 3 * SHENT + 20, rodata.bytes.byteLength, true);
  return buf;
}

// ---- SVDAT framing helpers -----------------------------------------------

const u32 = (v: number): number[] => {
  const out: number[] = [];
  let n = v >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
};
const eventId = (id: number): number[] => (id < 0x80 ? [id] : [(id & 0x7f) | 0x80, id >> 7]);
const plen = (v: number): number[] => (v < 0x80 ? [v] : [(v & 0x7f) | 0x80, v >> 7]);
const str = (s: string): number[] => {
  const b = [...Buffer.from(s, "utf8")];
  return [b.length, ...b];
};
const event = (id: number, payload: number[], delta: number): number[] => [
  ...eventId(id),
  ...(id >= 24 ? plen(payload.length) : []),
  ...payload,
  ...u32(delta),
];

const HEADER =
  ";\n; Version     SEGGER SystemViewer V2.42\n; Author      Espressif Inc\n;\n";

/** Heap-module descriptor string emitted by ESP-IDF heap tracing. */
const HEAP_MODULE_DESC_WIRE = "M=ESP32 SystemView Heap Tracing Module";

function buildSvdat(elfHash: string): Uint8Array {
  const sync = new Array(SYNC_LEN).fill(0);
  const events = [
    event(EVTID.TRACE_START, [], 0),
    event(EVTID.INIT, [...u32(1_000_000), ...u32(160_000_000), ...u32(0), ...u32(0)], 100),
    event(EVTID.SYSDESC, str("D=esp32c3,O=FreeRTOS,N=FreeRTOS Application"), 0),
    event(EVTID.SYSDESC, str("I#5=TIMER"), 0),
    event(EVTID.SYSDESC, str(`ELF_SHA256=${elfHash}`), 0),
    // Register the heap-tracing module to decode the allocation event and resolve
    // caller addresses against symbols in the loaded ELF.
    event(EVTID.MODULEDESC, [...u32(0), ...u32(MODULE_EVENT_OFFSET), ...str(HEAP_MODULE_DESC_WIRE)], 0),
    event(EVTID.TASK_INFO, [...u32(1), ...u32(5), ...str("main")], 0),
    event(EVTID.TASK_START_EXEC, u32(1), 50),
    // Heap allocation with caller return addresses inside demo-app.elf symbols:
    // 0x42000110 -> app_main+0x10, 0x42000210 -> loop_task+0x10.
    event(
      MODULE_EVENT_OFFSET,
      [...u32(0x3fc8_0100), ...u32(64), ...u32(0x4200_0110), ...u32(0x4200_0210)],
      5,
    ),
    event(EVTID.ISR_ENTER, u32(5), 5),
    event(EVTID.ISR_EXIT, [], 5),
    event(EVTID.IDLE, [], 10),
    event(EVTID.TASK_START_EXEC, u32(1), 20),
  ];
  return Uint8Array.from([...Buffer.from(HEADER, "utf8"), ...sync, ...events.flat()]);
}

async function main(): Promise<void> {
  const elf = buildElf(
    [
      { name: "app_main", value: 0x4200_0100, size: 0x40, type: STT_FUNC },
      { name: "loop_task", value: 0x4200_0200, size: 0x80, type: STT_FUNC },
      { name: "g_tick_count", value: 0x3fc8_0000, size: 4, type: STT_OBJECT },
    ],
    { addr: 0x3f40_0000, bytes: new TextEncoder().encode("demo-app\0%d ticks\0") },
  );
  const fullHash = await sha256Hex(elf);
  const hash = fullHash.slice(0, HASH_CHARS);
  const svdat = buildSvdat(hash);

  mkdirSync(dirname(ELF_OUT), { recursive: true });
  writeFileSync(ELF_OUT, elf);
  writeFileSync(SVDAT_OUT, svdat);

  // Verify generated fixtures parse successfully.
  const model = parseTraceFiles([svdat]);
  const traceHash = model.traces[0]?.elfSha256;
  const syms = parseElfSymbols(elf);
  if (traceHash !== hash) throw new Error(`svdat ELF_SHA256 ${traceHash} != ${hash}`);

  console.log(`wrote ${ELF_OUT} (${elf.byteLength} B, ${syms.symbolCount} symbols, sha256=${fullHash})`);
  console.log(`wrote ${SVDAT_OUT} (${svdat.byteLength} B, ${model.events.length} events, ELF_SHA256=${hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
