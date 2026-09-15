import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ElfError, loadElf, parseElfSymbols, sha256Hex } from "../../src/elf/index.js";

/**
 * Address-keyed ELF reader unit tests. Verifies synthetic ELF32 symbol decoding
 * (symbol type filters, nearest-floor lookup, size bounding, .rodata string reading,
 * and header guards) and real binary parsing.
 */

const STT_OBJECT = 1;
const STT_FUNC = 2;

interface SymSpec {
  name: string;
  value: number;
  size: number;
  type: number;
}

/**
 * Assemble a minimal ELF32-LE with a `.symtab` (+ `.strtab`) and one allocated
 * `.rodata` PROGBITS section. Layout:
 *   [52 ehdr][symtab][strtab][rodata bytes][shdrs: null, symtab, strtab, rodata]
 */
function buildElf(opts: { symbols: SymSpec[]; rodata?: { addr: number; bytes: Uint8Array } }): Uint8Array {
  const EHDR = 52;
  const SHENT = 40;
  const SYMSZ = 16;

  // .strtab: a leading NUL, then each name NUL-terminated; record each offset.
  const names = opts.symbols.map((s) => s.name);
  let strtabStr = "\0";
  const nameOff = new Map<string, number>();
  for (const n of names) {
    if (!nameOff.has(n)) {
      nameOff.set(n, strtabStr.length);
      strtabStr += n + "\0";
    }
  }
  const strtab = new TextEncoder().encode(strtabStr);

  // .symtab: index 0 is the reserved null symbol, then ours.
  const symCount = opts.symbols.length + 1;
  const symtab = new Uint8Array(symCount * SYMSZ);
  const symDv = new DataView(symtab.buffer);
  opts.symbols.forEach((s, i) => {
    const o = (i + 1) * SYMSZ;
    symDv.setUint32(o + 0, nameOff.get(s.name)!, true); // st_name
    symDv.setUint32(o + 4, s.value, true); // st_value
    symDv.setUint32(o + 8, s.size, true); // st_size
    symtab[o + 12] = s.type & 0xf; // st_info (bind 0 | type)
  });

  const rodata = opts.rodata?.bytes ?? new Uint8Array(0);

  const symtabOff = EHDR;
  const strtabOff = symtabOff + symtab.byteLength;
  const rodataOff = strtabOff + strtab.byteLength;
  const shoff = rodataOff + rodata.byteLength;
  const SHNUM = 4; // null, symtab, strtab, rodata
  const total = shoff + SHNUM * SHENT;

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0); // magic, ELFCLASS32, ELFDATA2LSB, version
  dv.setUint32(32, shoff, true); // e_shoff
  dv.setUint16(46, SHENT, true); // e_shentsize
  dv.setUint16(48, SHNUM, true); // e_shnum

  buf.set(symtab, symtabOff);
  buf.set(strtab, strtabOff);
  buf.set(rodata, rodataOff);

  // sh[1] symtab → links sh[2] strtab.
  dv.setUint32(shoff + 1 * SHENT + 4, 2, true); // sh_type SHT_SYMTAB
  dv.setUint32(shoff + 1 * SHENT + 16, symtabOff, true); // sh_offset
  dv.setUint32(shoff + 1 * SHENT + 20, symtab.byteLength, true); // sh_size
  dv.setUint32(shoff + 1 * SHENT + 24, 2, true); // sh_link → strtab
  // sh[2] strtab.
  dv.setUint32(shoff + 2 * SHENT + 4, 3, true); // sh_type SHT_STRTAB
  dv.setUint32(shoff + 2 * SHENT + 16, strtabOff, true); // sh_offset
  dv.setUint32(shoff + 2 * SHENT + 20, strtab.byteLength, true); // sh_size
  // sh[3] rodata: PROGBITS, SHF_ALLOC, mapped at rodata.addr.
  if (opts.rodata) {
    dv.setUint32(shoff + 3 * SHENT + 4, 1, true); // sh_type SHT_PROGBITS
    dv.setUint32(shoff + 3 * SHENT + 8, 0x2, true); // sh_flags SHF_ALLOC
    dv.setUint32(shoff + 3 * SHENT + 12, opts.rodata.addr, true); // sh_addr
    dv.setUint32(shoff + 3 * SHENT + 16, rodataOff, true); // sh_offset
    dv.setUint32(shoff + 3 * SHENT + 20, rodata.byteLength, true); // sh_size
  }
  return buf;
}

describe("parseElfSymbols — synthetic ELF32", () => {
  const elf = parseElfSymbols(
    buildElf({
      symbols: [
        { name: "app_main", value: 0x4200_0100, size: 0x40, type: STT_FUNC },
        { name: "loop_task", value: 0x4200_0200, size: 0x80, type: STT_FUNC },
        { name: "g_counter", value: 0x3fc8_0000, size: 4, type: STT_OBJECT },
        { name: "asm_entry", value: 0x4200_0400, size: 0, type: STT_FUNC }, // unsized
        { name: "ignore_section", value: 0x4200_0500, size: 0, type: 3 /* STT_SECTION */ },
      ],
      rodata: { addr: 0x3f40_0000, bytes: new TextEncoder().encode("hello\0%d bytes\0") },
    }),
  );

  it("resolves an exact symbol address to its bare name", () => {
    assert.equal(elf.resolve(0x4200_0100), "app_main");
    assert.equal(elf.lookup(0x4200_0100)?.offset, 0);
  });

  it("resolves an interior address to name+offset", () => {
    assert.equal(elf.resolve(0x4200_0110), "app_main+0x10");
    assert.deepEqual(elf.lookup(0x4200_0210), { name: "loop_task", offset: 0x10, size: 0x80 });
  });

  it("returns null in the gap above a sized symbol", () => {
    // app_main is [0x4200_0100, +0x40); 0x4200_0180 is past its end and below loop_task.
    assert.equal(elf.lookup(0x4200_0180), null);
    assert.equal(elf.resolve(0x4200_0180), "0x42000180");
  });

  it("attributes any address at/above an unsized symbol to it", () => {
    assert.equal(elf.resolve(0x4200_0400), "asm_entry");
    assert.equal(elf.resolve(0x4200_0444), "asm_entry+0x44");
  });

  it("returns null below the lowest symbol", () => {
    assert.equal(elf.lookup(0x1000), null);
  });

  it("skips non-FUNC/OBJECT symbols", () => {
    // STT_SECTION symbol must not appear; address near it resolves to the unsized
    // asm_entry below it, not to ignore_section.
    assert.equal(elf.resolve(0x4200_0500), "asm_entry+0x100");
  });

  it("reads a NUL-terminated string from .rodata by address", () => {
    assert.equal(elf.stringAt(0x3f40_0000), "hello");
    assert.equal(elf.stringAt(0x3f40_0006), "%d bytes"); // after the first NUL
  });

  it("stops at the section end when the string has no terminator", () => {
    // For a .rodata section containing "tail" without a trailing NUL, string
    // reading stops at the section boundary.
    const unterminated = parseElfSymbols(
      buildElf({ symbols: [], rodata: { addr: 0x3f40_0000, bytes: new TextEncoder().encode("tail") } }),
    );
    assert.equal(unterminated.stringAt(0x3f40_0000), "tail");
    assert.equal(unterminated.stringAt(0x3f40_0002), "il");
  });

  it("returns null for an address in no allocated section", () => {
    assert.equal(elf.stringAt(0x1234_5678), null);
  });
});

describe("parseElfSymbols — header guards", () => {
  it("rejects non-ELF, non-ELF32, and big-endian buffers", () => {
    assert.throws(() => parseElfSymbols(new Uint8Array(64)), ElfError);
    const e = buildElf({ symbols: [] });
    const wrongClass = e.slice();
    wrongClass[4] = 2;
    assert.throws(() => parseElfSymbols(wrongClass), /only ELF32/);
    const bigEndian = e.slice();
    bigEndian[5] = 2;
    assert.throws(() => parseElfSymbols(bigEndian), /little-endian/);
  });

  it("parses a stripped ELF (no symtab) to an empty table", () => {
    const elf = parseElfSymbols(buildElf({ symbols: [] }));
    assert.equal(elf.symbolCount, 0);
    assert.equal(elf.lookup(0x4200_0000), null);
  });
});

describe("sha256Hex", () => {
  it("matches a known vector for the empty input", async () => {
    assert.equal(
      await sha256Hex(new Uint8Array(0)),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches a known vector for 'abc'", async () => {
    assert.equal(
      await sha256Hex(new TextEncoder().encode("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes only the view, not the whole backing buffer", async () => {
    const backing = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]); // 'abc' in the middle
    const view = backing.subarray(1, 4);
    assert.equal(
      await sha256Hex(view),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

