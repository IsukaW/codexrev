# Publishing to npm

## Pre-flight checklist

- [ ] All five bundles build without errors (`npm run build`).
- [ ] `node dist/cli.js --version` matches `package.json#version`.
- [ ] `node dist/cli.js --help` shows the full option list.
- [ ] `node dist/cli.js extensions list` reports `No extensions installed.`
- [ ] `API_KEY=<…> node -e "require('./dist/api.cjs').createAgent({provider:'openai',model:'gpt-4o-mini'})"` returns an `Agent` (and closes cleanly).
- [ ] `LICENSE` (Apache-2.0) is at the repo root.
- [ ] `README.md` matches the shipped CLI.
- [ ] `package.json#repository`, `bugs`, and `homepage` are filled in.
- [ ] `package.json#files` lists every directory shipped (`dist`, `LICENSE`, `README.md`, `package.json`).

## Doing the publish

```bash
# 1) bump the version (semver)
npm version patch

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
  "files": ["dist", "LICENSE", "README.md", "package.json"]
}
```

## Tagging

By default the first publish goes on the `latest` tag. For pre-releases:

```bash
npm publish --tag beta
npm dist-tag ls codexrev
npm dist-tag add codexrev@1.2.3 latest    # promote when ready
```
