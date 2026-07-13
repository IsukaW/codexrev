# Deployment

This page covers packaging and shipping Codexrev.

## As an npm package

```bash
npm run build
npm publish --dry-run      # sanity check
npm publish                # actually push
```

The package ships:

- `dist/cli.js` — the CLI binary
- `dist/api.js`, `dist/api.cjs` — programmatic API (ESM + CJS)
- `dist/tools.js`, `dist/tools.cjs` — tool-only entry point
- `dist/assets/` — bundled theme assets
- `version.json`, `package.json`, `LICENSE`, `README.md`

## As a container

A multi-stage Dockerfile:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/cli.js"]
```

Build & run:

```bash
docker build -t codexrev:local .
docker run -it --rm \
  -e OPENAI_API_KEY \
  -v "$PWD:/work" \
  -w /work codexrev:local --print "summarise *.md"
```

## To Azure / Vercel / Fly

The CLI is a standard Node.js process. Any platform that runs long-lived Node processes works:

- **Azure App Service** — set `WEBSITE_NODE_DEFAULT_VERSION` to `~22`, deploy `dist/` as a zip.
- **Vercel Functions** — wrap `runAgent` in a serverless handler.
- **Fly.io** — `fly launch --dockerfile` with the Dockerfile above; pass secrets via `fly secrets set`.

See the platform's docs for the specifics; Codexrev exposes no platform-specific code.
