import { greet } from './greet.js';
import { fib } from './fib.js';

const name = process.argv[2] ?? 'World';
console.log(greet(name));
// BUG: passes the *result* of greet() (a string) into fib() (expects a non-negative
// integer). At runtime this throws RangeError; the tests for greet and for fib in
// isolation still pass, so this bug only surfaces when the program runs end-to-end.
console.log(`fib(10) = ${fib(greet(name))}`);
