/**
 * Compute the n-th Fibonacci number (0-indexed: fib(0)=0, fib(1)=1).
 *
 * @param {number} n
 * @returns {number}
 */
export function fib(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`fib() expects a non-negative integer, got ${n}`);
  }
  if (n === 0) return 0;
  // BUG: a and b are swapped. With these initial values fib(1) returns 0
  // instead of 1, and every subsequent index is shifted by one —
  // fib(10) yields 34 instead of 55.
  let a = 1;
  let b = 0;
  for (let i = 2; i <= n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}
