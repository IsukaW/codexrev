/**
 * Feature 3 / Function 1 — built-in compatibility catalog (Phase P3).
 *
 * CURATED AND SMALL BY DESIGN. Every entry was verified on 2026-10-15
 * against the official documentation/changelog cited in `source.uri`:
 *   1. react-dom: ReactDOM.render REMOVED in 19.0.0 — verified against the
 *      official React 19 Upgrade Guide (react.dev).
 *   2. lru-cache: v7.0.0 renamed options/methods — verified against the
 *      official isaacs/node-lru-cache CHANGELOG.md.
 *   3. highlight.js: v11 deprecates highlightBlock() — verified against the
 *      official VERSION_11_UPGRADE.md.
 *
 * LIMITATIONS (documented, not hidden):
 *   - This is a demonstration-sized catalog, NOT an exhaustive knowledge
 *     base. Absence of a package here means "unknown", never "compatible".
 *   - Entries describe library-level facts only; they say nothing about
 *     whether a specific project uses the affected API (P4 AST analysis).
 *   - Boundaries are exact X.Y.Z semantics; prerelease versions are not
 *     compared (see compat/exactVersion.ts).
 */

import type { CompatCatalogEntry } from './catalogTypes.js';

export const BUILTIN_COMPAT_CATALOG: readonly CompatCatalogEntry[] = [
  {
    id: 'react-dom-19-removed-render',
    package: 'react-dom',
    category: 'removed-api',
    api: 'ReactDOM.render',
    severity: 'high',
    affectedFrom: '19.0.0',
    description:
      'ReactDOM.render was removed in react-dom 19.0.0; code calling it breaks once react-dom is upgraded to >=19.',
    migrationGuidance:
      'Replace ReactDOM.render(el) with createRoot(el).render(<App />) from react-dom/client (hydrateRoot replaces hydrate for server-rendered HTML).',
    source: {
      kind: 'official-docs',
      uri: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide#removed-reactdom-render',
    },
    confidence: 'high',
    reviewStatus: 'verified',
  },
  {
    id: 'lru-cache-7-renamed-options',
    package: 'lru-cache',
    category: 'breaking-change',
    api: 'maxAge/length/stale options; prune()/reset() methods; cache.length property',
    severity: 'medium',
    affectedFrom: '7.0.0',
    description:
      'lru-cache v7.0.0 renamed options and methods: maxAge->ttl, length->sizeCalculation, stale->allowStale, prune()->purgeStale(), reset()->clear(); cache.length became cache.size. cache.load()/cache.dump() payloads from v6 are incompatible.',
    migrationGuidance:
      'Update constructor options and method calls per the v7 changelog; do not reuse v6 dump payloads with v7+.',
    source: {
      kind: 'changelog',
      uri: 'https://github.com/isaacs/node-lru-cache/blob/main/CHANGELOG.md',
    },
    confidence: 'high',
    reviewStatus: 'verified',
  },
  {
    id: 'highlightjs-11-deprecated-highlightblock',
    package: 'highlight.js',
    category: 'deprecated-api',
    api: 'highlightBlock',
    severity: 'low',
    affectedFrom: '11.0.0',
    description:
      'highlight.js v11 deprecated highlightBlock() (removal planned for v12), along with initHighlighting()/initHighlightingOnLoad() and the before/after:highlightBlock callbacks.',
    migrationGuidance:
      'Use highlightElement() instead of highlightBlock(), highlightAll() instead of initHighlighting(), and the highlightElement-named callbacks.',
    source: {
      kind: 'official-docs',
      uri: 'https://github.com/highlightjs/highlight.js/blob/main/VERSION_11_UPGRADE.md',
    },
    confidence: 'high',
    reviewStatus: 'verified',
  },
];
