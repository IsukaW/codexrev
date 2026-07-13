/**
 * Greet someone in a friendly tone.
 *
 * @param {string} name
 * @returns {string}
 */
export function greet(name = 'world') {
  const cleaned = String(name).trim();
  // BUG: forgot to handle empty / whitespace-only name — falls through to
  // template-literal interpolation and produces "Hello, !" instead of the
  // documented "Hello, stranger!" fallback.
  return `Hello, ${cleaned}!`;
}
