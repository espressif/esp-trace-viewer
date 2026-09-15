/**
 * ELF processing for trace symbolization and verification.
 *
 * Functions:
 * - Map trace addresses to symbol names and read literal strings referenced by address ({@link ElfSymbols}, {@link parseElfSymbols}).
 * - Verify that an ELF image matches the trace capture digest ({@link sha256Hex}, {@link verifyElfHash}) against `ELF_SHA256`.
 *
 * {@link loadElf} parses the symbol table and computes the SHA-256 digest, returning an {@link ElfFile}.
 */

import { ElfSymbols, parseElfSymbols } from "./elf-symbols.js";
import { sha256Hex } from "./sha256.js";

export { ElfError, ElfSymbols, parseElfSymbols, type SymbolHit } from "./elf-symbols.js";
export { sha256Hex } from "./sha256.js";
export { type ElfVerifyStatus, verifyElfHash } from "./verify.js";

/** Loaded ELF representation containing raw bytes, SHA-256 digest, and symbol resolver. */
export interface ElfFile {
  /** The ELF file bytes. */
  bytes: Uint8Array;
  /** Lowercase hexadecimal SHA-256 digest of {@link bytes}. */
  sha256: string;
  /** Symbol table and string resolver. */
  symbols: ElfSymbols;
}

/**
 * Parses `bytes` as an ELF32 image and computes its SHA-256 digest, returning an {@link ElfFile}.
 * Throws {@link ElfError} if the buffer is not a valid ELF32-LE image.
 */
export async function loadElf(bytes: Uint8Array): Promise<ElfFile> {
  const symbols = parseElfSymbols(bytes);
  const sha256 = await sha256Hex(bytes);
  return { bytes, sha256, symbols };
}
