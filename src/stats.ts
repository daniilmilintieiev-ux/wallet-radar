/**
 * Small shared numeric helpers. Leaf module: no imports, so both the analyzer
 * (which must stay dependency-free of the baseline module) and the baseline
 * module can use the exact same implementations without duplication.
 */

/** Median of a numeric list (0 for empty). */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Maximum without spreading into function arguments (Math.max(...arr) throws
 * RangeError above ~65k elements). Behavior-identical to Math.max(...arr),
 * including -Infinity for an empty list.
 */
export function maxOf(nums: number[]): number {
  let max = -Infinity;
  for (const n of nums) {
    if (n > max) max = n;
  }
  return max;
}

/** Minimum; behavior-identical to Math.min(...arr), including Infinity for an empty list. */
export function minOf(nums: number[]): number {
  let min = Infinity;
  for (const n of nums) {
    if (n < min) min = n;
  }
  return min;
}
