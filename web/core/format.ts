/**
 * Format trace timestamps, durations, and counts using space-grouped thousands and SI-suffixed units.
 */

/** Group thousands with a thin space separator (e.g. `164 703`). */
export function groupThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Format a duration in seconds with an SI suffix and 3 decimal places (`0.000 s`, `1.234 ms`, `987.000 µs`, `12.000 ns`).
 *
 * When `resolution` is positive, renders decimal places necessary to distinguish steps of `resolution` seconds.
 */
export function formatDuration(seconds: number, resolution = 0): string {
  if (!Number.isFinite(seconds)) return "—";
  const abs = Math.abs(seconds);
  if (abs === 0) return "0 s";
  const units: [number, string][] = [
    [1, "s"],
    [1e-3, "ms"],
    [1e-6, "µs"],
    [1e-9, "ns"],
  ];
  // Minimum decimal places where step size is <= resolution.
  const decimals = (scale: number): number =>
    resolution > 0 && Number.isFinite(resolution)
        ? Math.min(9, Math.max(0, Math.ceil(Math.log10(scale / resolution) - 1e-9)))
        : 3;
  for (const [scale, suffix] of units) {
    // Tolerance for values near unit boundaries due to floating-point rounding.
    if (abs >= scale * (1 - 1e-9)) return `${(seconds / scale).toFixed(decimals(scale))} ${suffix}`;
  }
  return `${(seconds / 1e-9).toFixed(decimals(1e-9))} ns`;
}

/**
 * Round a duration or timestamp to a display resolution in seconds.
 *
 * A resolution of 0 or non-finite value leaves the value unchanged. Positive values round to the nearest multiple of `resolution`.
 */
export function roundToResolution(seconds: number, resolution: number): number {
  if (!(resolution > 0) || !Number.isFinite(resolution)) return seconds;
  return Math.round(seconds / resolution) * resolution;
}

/**
 * Format an absolute trace timestamp in seconds, optionally quantized to `resolution`.
 */
export function formatTime(seconds: number, resolution = 0): string {
  return formatDuration(roundToResolution(seconds, resolution), resolution);
}

/** Mapping of SI unit suffix to seconds for {@link parseTime}. */
const TIME_UNITS: Readonly<Record<string, number>> = {
  s: 1,
  ms: 1e-3,
  us: 1e-6,
  µs: 1e-6,
  "μs": 1e-6, // Greek small mu (U+03BC)
  ns: 1e-9,
};

/**
 * Parse a human time input string into seconds.
 *
 * Accepts a number with an optional SI suffix (`s`, `ms`, `µs`/`us`, `ns`). Plain numbers parse as seconds. Strips whitespace before parsing. Returns `null` for invalid or empty input.
 */
export function parseTime(input: string): number | null {
  const cleaned = input.replace(/[\s  ]/g, "").toLowerCase();
  if (cleaned === "") return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(s|ms|us|µs|μs|ns)?$/.exec(cleaned);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return value * (m[2] ? TIME_UNITS[m[2]]! : 1);
}
