# Codexrev — minimal container image
# Use this when running Codexrev inside a hardened sandbox or a CI worker.

FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache git tini
ENTRYPOINT ["/sbin/tini", "--"]

# ---- dependencies stage ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM base AS runtime
ENV NODE_ENV=production \
    CODEXREV_NO_UPDATE=1
COPY --from=deps /app/node_modules ./node_modules
COPY dist ./dist
COPY package.json ./
COPY README.md LICENSE NOTICE ./
RUN addgroup -S codexrev && adduser -S codexrev -G codexrev && \
    chmod -R 555 /app/dist /app/node_modules
USER codexrev
EXPOSE 3000
CMD ["node", "dist/cli.js"]
