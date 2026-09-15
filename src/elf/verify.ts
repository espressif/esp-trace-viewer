/**
 * Verification of loaded ELF binaries against SHA-256 digests in trace metadata.
 *
 * ESP-IDF `esp_sysview` records a truncated hexadecimal SHA-256 prefix of the application
 * ELF in `svSysDesc` (`ELF_SHA256=...`, length configured by `CONFIG_APP_RETRIEVE_LEN_ELF_SHA`).
 * Verification compares this prefix against the start of the loaded ELF's full SHA-256 digest.
 *
 * This is the comparison only; what to do with the answer is the application's business. Traces omitting
 * the hash evaluate to `unknown`, which is not the same as a mismatch — there was simply nothing to check.
 */

/** Result of comparing a loaded ELF's digest with the hash embedded in a trace. */
export type ElfVerifyStatus = "match" | "mismatch" | "unknown";

/**
 * Compares the trace's embedded `ELF_SHA256` prefix against the start of the loaded ELF's full SHA-256 digest.
 * Returns `unknown` if the trace hash is null or empty.
 */
export function verifyElfHash(traceHash: string | null | undefined, elfSha256: string): ElfVerifyStatus {
  if (!traceHash) return "unknown";
  const want = traceHash.trim().toLowerCase();
  if (want.length === 0) return "unknown";
  const got = elfSha256.toLowerCase().slice(0, want.length);
  return want === got ? "match" : "mismatch";
}
