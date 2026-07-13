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

### 4. Run the CLI in non-interactive ("print") mode

```sh
codexrev -p "summarize src/"
codexrev -p "find any obvious bugs in src/fib.js and fix them" --approval-mode never
codexrev --print "explain what src/index.js does" --output-format json
```

### 5. Launch the interactive TUI

```sh
codexrev
```

Then try prompts like:

- `write a unit test for src/greet.js`
- `refactor src/fib.js to be iterative and handle n=0 correctly`
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
| `codexrev -p "…"` with valid config | Runs non-interactively, prints the model response. |
| Tamper with `config.json` | Next run throws `ConfigError: failed to decrypt API key in …`. |
| `codexrev -p "…"` without config, no env key | Prints the "Run `codexrev init`" nudge; non-zero exit for CLI tools that need a key. |
| `codexrev init --reset` | Old config + DEK removed; new ones written. |
| Delete only the DEK from the keychain | Next run throws "no matching DEK in OS keychain". |
