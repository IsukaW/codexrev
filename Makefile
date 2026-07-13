# Codexrev — Makefile convenience targets
# Use `make help` to see all targets.

.PHONY: help install build dev test lint format typecheck clean start publish

help:
	@echo "Codexrev — available targets:"
	@echo "  make install     — npm install (production + dev)"
	@echo "  make build       — build dist/ via esbuild"
	@echo "  make dev         — run CLI from source (no build)"
	@echo "  make start       — run the built CLI"
	@echo "  make test        — run vitest"
	@echo "  make lint        — run eslint"
	@echo "  make format      — run prettier --write"
	@echo "  make typecheck   — tsc --noEmit"
	@echo "  make clean       — remove dist/, coverage/"
	@echo "  make publish     — npm publish (after build)"

install:
	npm install

build:
	npm run build

dev:
	npm run dev

start: build
	node dist/cli.js

test:
	npm test

lint:
	npm run lint

format:
	npm run format

typecheck:
	npm run typecheck

clean:
	npm run clean

publish: build
	npm publish --access public
