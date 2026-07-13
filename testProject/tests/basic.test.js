import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';
import { fib } from '../src/fib.js';

test('greet trims and defaults', () => {
  assert.equal(greet('  Alice  '), 'Hello, Alice!');
  assert.equal(greet(), 'Hello, world!');
  assert.equal(greet(''), 'Hello, stranger!');
  assert.equal(greet('   '), 'Hello, stranger!');
});

test('fib base cases', () => {
  assert.equal(fib(0), 0);
  assert.equal(fib(1), 1);
  assert.equal(fib(2), 1);
});

test('fib larger values', () => {
  assert.equal(fib(10), 55);
  assert.equal(fib(20), 6765);
});

test('fib rejects invalid input', () => {
  assert.throws(() => fib(-1), RangeError);
  assert.throws(() => fib(1.5), RangeError);
});
