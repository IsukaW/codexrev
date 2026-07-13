/**
 * Greet someone in a friendly tone.
 *
 * @param {string} name
 * @returns {string}
 */
export function greet(name = 'world') {
  const cleaned = String(name).trim();
  if (!cleaned) return 'Hello, stranger!';
  return `Hello, ${cleaned}!`;
}
