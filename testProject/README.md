# codexrev testProject

A tiny throwaway Node.js project you can point `codexrev` at to exercise the CLI end-to-end.

The repo contains:

```
testProject/
├── package.json
├── src/
│   ├── index.js     # entry point — prints a greeting + fib(10)
│   ├── greet.js     # greet(name)  — a small string helper
│   └── fib.js       # fib(n)      — non-recursive Fibonacci
└── tests/
    └── basic.test.js # node:test cases
```

It's a normal `type: "module"` project — `node --test tests/*.test.js` runs the tests.

## ⚠️  Intentionally broken

Three real-looking bugs are seeded into `src/` to exercise the agent's
debug/refactor path. They are:

| File | Bug | Symptom |
| --- | --- | --- |
| `src/greet.js` | Dropped the empty / whitespace-name fallback — falls through to template-literal interpolation | `greet('')` returns `Hello, !` instead of `Hello, stranger!` |
| `src/fib.js` | `a` and `b` initial values are swapped | `fib(1) = 0`, `fib(10) = 34`, every index shifted by one |
| `src/index.js` | Passes the *result* of `greet(name)` into `fib(...)`, expecting a number | Runtime `RangeError: fib() expects a non-negative integer, got Hello, Isk!` |

Current state on disk:

```
$ node src/index.js Isk
Hello, Isk!
file:///.../testProject/src/fib.js:9
  throw new RangeError(`fib() expects a non-negative integer, got ${n}`);
        ^
RangeError: fib() expects a non-negative integer, got Hello, Isk!

$ node --test tests/*.test.js
✖ greet trims and defaults        (greet() with empty / whitespace input)
✖ fib base cases                   (fib(1) returns 0 instead of 1)
✖ fib larger values                (fib(10) returns 34 instead of 55)
✔ fib rejects invalid input        (RangeError path is correct)
```

3 of 4 tests fail and the entry point crashes.

### Prompt ideas for the CLI

- `run the test suite and fix every failing test`
- `node src/index.js throws RangeError — find the bug and fix it without changing the public API`
- `src/fib.js has an off-by-one or a swap bug — diagnose and fix`
- `review src/greet.js: the empty-string case is broken, fix it`
- `after fixing, regenerate the test file to cover the edge cases you discovered`

The "before/after" pattern is the cleanest test of the agent: give it the failing test output and ask it to bring the suite back to green.

## What to try with the CLI

All commands assume your shell is in this directory (`testProject/`).

### 1. First-run setup (encrypted config + DEK)

```sh
codexrev init
```

Follow the TUI wizard. Verify the result:

```sh
cat .codexrev/config.json   # ciphertext envelope — plaintext key must NOT appear
```

### 2. Run non-interactive setup (CI-style)

```sh
codexrev init --non-interactive \
  --provider openai \
  --model gpt-4o \
  --api-key "$OPENAI_API_KEY"
```

### 3. Reset and re-seal the API key

```sh
codexrev init --reset
```

The old DEK and `config.json` are deleted; a fresh DEK is written to the OS keychain.

### 4. Drive the debug workflow

```sh
# show codexrev the failing test output and let it fix the code
node --test tests/*.test.js 2>&1 | codexrev -p "fix all failing tests"

# same workflow, but explicitly hand it the symptom
codexrev -p "node src/index.js Isk crashes with RangeError — find and fix the bug"

# ask it to refactor for clarity *after* the suite is green
codexrev -p "all tests pass now — refactor src/fib.js to be obviously correct"
```

### 5. Launch the interactive TUI

```sh
codexrev
```

Then try prompts like:

- `run the tests, fix what's red, then run them again`
- `summarize src/index.js in one line`
- `add a JSDoc block to every exported function in src/`

Use `/help` inside the TUI to see the slash-command list.

### 6. Verify the encryption path

```sh
# ciphertext should be present, plaintext absent
cat .codexrev/config.json | grep -i "sk-"   # → no match

# macOS — show the DEK in Keychain Access.app:
#   search for  "codexrev"
# Windows — list stored credentials:
cmdkey /list:codexrev*
# Linux (libsecret):
secret-tool list service codexrev
```

### 7. Smoke test the local install

From the codexrev repo root, against this project:

```sh
# from the repo root
cd testProject
node ../dist/cli.js -p "list every file in src/"
```

## Expected behavior matrix

| Scenario | Expected outcome |
| --- | --- |
| `codexrev init` | `.codexrev/config.json` written with `iv`/`tag`/`ciphertext`; DEK in OS keychain. |
| `codexrev -p "fix the failing tests"` | Agent reads the source, identifies the 3 seeded bugs, applies fixes, tests go green. |
| `codexrev -p "…"` with valid config | Runs non-interactively, prints the model response. |
| Tamper with `config.json` | Next run throws `ConfigError: failed to decrypt API key in …`. |
| `codexrev -p "…"` without config, no env key | Prints the "Run `codexrev init`" nudge. |
| `codexrev init --reset` | Old config + DEK removed; new ones written. |
| Delete only the DEK from the keychain | Next run throws "no matching DEK in OS keychain". |
