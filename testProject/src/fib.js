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
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}
