/**
 * ELF32 symbol table and section reader for trace symbolization.
 *
 * Maps virtual addresses to containing symbols and reads null-terminated strings
 * from `.rodata` sections. Used during trace decoding to resolve numeric `func`, `pc`,
 * and pointer values to names, and to retrieve format strings referenced by address.
 *
 * Supports ELF32 little-endian format for ESP targets (RISC-V and Xtensa).
 */

const ELF_MAGIC = 0x7f454c46; // "\x7fELF"
const ELFCLASS32 = 1;
const ELFDATA2LSB = 1;

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;

const SHF_ALLOC = 0x2;

// st_info packs the symbol's binding (high nibble) and type (low nibble).
const STT_OBJECT = 1;
const STT_FUNC = 2;

const SIZEOF_ELF32_SYM = 16;
const SIZEOF_SHDR = 40;

/** Maximum byte length read by {@link ElfSymbols.stringAt}. */
const MAX_STRING_LEN = 4096;

/** Error raised for a malformed or unsupported ELF image. */
export class ElfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElfError";
  }
}

/** Resolved symbol information for an address. */
export interface SymbolHit {
  /** The symbol's name. */
  name: string;
  /** Byte offset from the symbol's start address (`addr - symbol.value`). */
  offset: number;
  /** The symbol's size in bytes, if recorded in the ELF file, otherwise 0. */
  size: number;
}

/** Symbol entry for address lookup. */
interface Sym {
  value: number;
  size: number;
  name: string;
}

/** File-backed section data used by {@link ElfSymbols.stringAt}. */
interface Section {
  /** Virtual address the section is mapped to. */
  addr: number;
  /** Byte length in memory (equal to file size for PROGBITS). */
  size: number;
  /** The section's bytes (a view into the ELF buffer). */
  data: Uint8Array;
}

/**
 * Address-keyed view over an ELF's symbol table and allocated section data.
 */
export class ElfSymbols {
  /** Function and object symbols with non-zero addresses, sorted ascending by value. */
  private readonly syms: Sym[];
  /** Allocated, file-backed sections for reading literal data by address. */
  private readonly sections: Section[];

  constructor(syms: Sym[], sections: Section[]) {
    // Sort symbols by value for binary search lookup; sections retain header order.
    this.syms = syms.slice().sort((a, b) => a.value - b.value);
    this.sections = sections;
  }

  /** Count of code and data symbols available for lookup. */
  get symbolCount(): number {
    return this.syms.length;
  }

  /**
   * Finds the nearest symbol with start address at or below `addr`.
   * Returns `null` if no symbol precedes `addr` or if `addr` exceeds the bounds of
   * a sized symbol. Unsized symbols (`st_size == 0`) match any address at or above their start.
   */
  lookup(addr: number): SymbolHit | null {
    const a = addr >>> 0;
    let lo = 0;
    let hi = this.syms.length - 1;
    let floor = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.syms[mid]!.value <= a) {
        floor = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (floor < 0) return null;
    const sym = this.syms[floor]!;
    const offset = a - sym.value;
    if (sym.size > 0 && offset >= sym.size) return null; // Address exceeds symbol size
    return { name: sym.name, offset, size: sym.size };
  }

  /**
   * Resolves `addr` to a formatted string: exact symbol name, `name+0xNN`
   * for interior offsets, or hexadecimal `0x...` when unresolved.
   */
  resolve(addr: number): string {
    const hit = this.lookup(addr);
    if (!hit) return `0x${(addr >>> 0).toString(16)}`;
    return hit.offset === 0 ? hit.name : `${hit.name}+0x${hit.offset.toString(16)}`;
  }

  /**
   * Reads the NUL-terminated string at virtual address `addr`, returning `null`
   * if no allocated section covers `addr`. Reads at most {@link MAX_STRING_LEN}
   * bytes or up to the section boundary.
   */
  stringAt(addr: number): string | null {
    const a = addr >>> 0;
    for (const s of this.sections) {
      if (a < s.addr || a >= s.addr + s.size) continue;
      const start = a - s.addr;
      const limit = Math.min(s.data.byteLength, start + MAX_STRING_LEN);
      let end = start;
      while (end < limit && s.data[end] !== 0) end++;
      return new TextDecoder().decode(s.data.subarray(start, end));
    }
    return null;
  }
}

/**
 * Parses an ELF32 little-endian buffer into an {@link ElfSymbols} instance.
 * Throws {@link ElfError} for non-ELF32-LE images or truncated headers.
 * Stripped ELFs return an empty symbol table.
 */
export function parseElfSymbols(buf: Uint8Array): ElfSymbols {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 52) throw new ElfError("buffer too short to be an ELF32 header");
  if (dv.getUint32(0, false) !== ELF_MAGIC) throw new ElfError("not an ELF file (bad magic)");
  if (buf[4] !== ELFCLASS32) throw new ElfError("only ELF32 is supported");
  if (buf[5] !== ELFDATA2LSB) throw new ElfError("only little-endian ELF is supported");

  const shoff = dv.getUint32(32, true);
  const shentsize = dv.getUint16(46, true) || SIZEOF_SHDR;
  const shnum = dv.getUint16(48, true);

  // Collect symbol tables with linked string tables and allocated file-backed sections.
  const syms: Sym[] = [];
  const sections: Section[] = [];
  for (let i = 0; i < shnum; i++) {
    const s = shoff + i * shentsize;
    requireRange(buf, s, SIZEOF_SHDR, "section header");
    const type = dv.getUint32(s + 4, true);
    const flags = dv.getUint32(s + 8, true);
    const addr = dv.getUint32(s + 12, true);
    const offset = dv.getUint32(s + 16, true);
    const size = dv.getUint32(s + 20, true);
    const link = dv.getUint32(s + 24, true);

    if (type === SHT_SYMTAB || type === SHT_DYNSYM) {
      readSymbols(buf, dv, offset, size, link, shoff, shentsize, shnum, syms);
    } else if (type === SHT_PROGBITS && (flags & SHF_ALLOC) !== 0 && size > 0) {
      requireRange(buf, offset, size, `section ${i} data`);
      sections.push({ addr, size, data: buf.subarray(offset, offset + size) });
    }
  }
  return new ElfSymbols(syms, sections);
}

/** Reads FUNC and OBJECT entries from a symbol table into `out`, resolving names via its string table. */
function readSymbols(
  buf: Uint8Array,
  dv: DataView,
  symOff: number,
  symSize: number,
  strSecIdx: number,
  shoff: number,
  shentsize: number,
  shnum: number,
  out: Sym[],
): void {
  if (strSecIdx >= shnum) return;
  const strHdr = shoff + strSecIdx * shentsize;
  requireRange(buf, strHdr, SIZEOF_SHDR, "string-table section header");
  if (dv.getUint32(strHdr + 4, true) !== SHT_STRTAB) return;
  const strOff = dv.getUint32(strHdr + 16, true);
  const strSize = dv.getUint32(strHdr + 20, true);

  requireRange(buf, symOff, symSize, "symbol table");
  for (let off = symOff; off + SIZEOF_ELF32_SYM <= symOff + symSize; off += SIZEOF_ELF32_SYM) {
    const value = dv.getUint32(off + 4, true);
    const size = dv.getUint32(off + 8, true);
    const info = buf[off + 12]!;
    const type = info & 0xf;
    // Retain only addressable function and object symbols with non-zero values.
    if (value === 0) continue;
    if (type !== STT_FUNC && type !== STT_OBJECT) continue;
    const nameIdx = dv.getUint32(off, true);
    if (nameIdx === 0 || nameIdx >= strSize) continue;
    const name = readCString(buf, strOff + nameIdx, strOff + strSize);
    if (name) out.push({ value, size, name });
  }
}

/** Decodes a NUL-terminated string starting at `at` and bounded by `end`. */
function readCString(buf: Uint8Array, at: number, end: number): string {
  let p = at;
  const limit = Math.min(end, buf.byteLength);
  while (p < limit && buf[p] !== 0) p++;
  return new TextDecoder().decode(buf.subarray(at, p));
}

function requireRange(buf: Uint8Array, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > buf.byteLength) {
    throw new ElfError(`${what} at 0x${offset.toString(16)} (+${length}) runs past end of ELF buffer`);
  }
}
