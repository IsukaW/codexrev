import { greet } from './greet.js';
import { fib } from './fib.js';

const name = process.argv[2] ?? 'world';
console.log(greet(name));
console.log(`fib(10) = ${fib(10)}`);
