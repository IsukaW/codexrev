# Publishing to npm

## Pre-flight checklist

- [ ] All five bundles build without errors (`npm run build`).
- [ ] `node dist/cli.js --version` matches `package.json#version`.
- [ ] `node dist/cli.js --help` shows the full option list.
- [ ] `node dist/cli.js init --help` shows the new init subcommand.
- [ ] `node dist/cli.js extensions list` reports `No extensions installed.`
- [ ] `API_KEY=<…> node -e "require('./dist/api.cjs').createAgent({provider:'openai',model:'gpt-4o-mini'})"` returns an `Agent` (and closes cleanly).
- [ ] `LICENSE` (Apache-2.0) is at the repo root.
- [ ] `README.md` matches the shipped CLI.
- [ ] `package.json#repository`, `bugs`, and `homepage` are filled in.
- [ ] `package.json#files` lists every directory shipped (`dist`, `LICENSE`, `README.md`, `package.json`, `NOTICE`).
- [ ] `keytar` is listed in `dependencies` (it is a native module — its `prebuild-install` runs on `npm i`).
- [ ] `npm test` is green.

## Doing the publish

```bash
# 1) bump the version (semver)
npm version patch   # or minor / major

# 2) build
npm run build

# 3) inspect the package
npm pack --dry-run

# 4) publish (with `--tag beta` for a pre-release)
npm publish
```

## Files allowed in the package

Set `package.json#files`:

```jsonc
{
  "files": ["dist", "LICENSE", "README.md", "NOTICE", "package.json"]
}
```

## Tagging

By default the first publish goes on the `latest` tag. For pre-releases:

```bash
npm publish --tag beta
npm dist-tag ls codexrev
npm dist-tag add codexrev@1.2.3 latest    # promote when ready
```

## Native module notes

The CLI uses `keytar` to persist project DEKs in the OS keychain. `keytar` ships prebuilt binaries via `prebuild-install`, so most users will not need a compiler. On Linux, the keychain backend requires `libsecret-1-0` — the CLI will print a clear error if it is missing rather than silently degrading to plaintext.
