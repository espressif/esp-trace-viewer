/**
 * Computes SHA-256 over a byte buffer, returning a lowercase hexadecimal string.
 *
 * Used during ELF verification to match the loaded application binary against the
 * `ELF_SHA256` prefix recorded in the trace system description.
 *
 * Uses `crypto.subtle.digest` available in standard web and Node runtimes.
 */

/** Computes the lowercase hexadecimal SHA-256 digest of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy bytes to ensure the digest covers only the sliced range and satisfies BufferSource.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return toHex(new Uint8Array(digest));
}

/** Formats bytes as a lowercase hexadecimal string. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
