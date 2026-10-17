/**
 * Minimal, dependency-free glob matching for living-spec path filters.
 *
 * The feature filters diff files and watch events by configurable globs from
 * `.codexrev/living-spec/config.json`. Only a small, well-defined subset of
 * glob syntax is needed (`**`, `*`, `?`, `{a,b}` groups), so it is translated
 * to a RegExp here instead of pulling a matcher dependency into the feature.
 *
 * Patterns and paths are matched in forward-slash, project-relative form.
 */

export type PathMatcher = (relPath: string) => boolean;

/** Path segments that are never analysed or watched, whatever the config says. */
export const ALWAYS_EXCLUDED_DIRS = ['node_modules', 'dist', '.git', '.codexrev'] as const;

/** Normalizes separators and strips a leading `./` so matching is platform-stable. */
export function normalizeRelPath(relPath: string): string {
  let p = relPath.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

function escapeRegexLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Translates one glob body (no anchors) to a RegExp source. `**` crosses
// directory separators; `*` and `?` never do.
function globBody(pattern: string): string {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` — zero or more whole path segments
          re += '(?:[^/]*\\/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if (ch === '{') {
      let depth = 0;
      let j = i + 1;
      let end = -1;
      for (; j < pattern.length; j++) {
        if (pattern[j] === '{') depth++;
        else if (pattern[j] === '}') {
          if (depth === 0) {
            end = j;
            break;
          }
          depth--;
        }
      }
      if (end === -1) {
        // unterminated group — treat literally
        re += escapeRegexLiteral(ch);
        i += 1;
        continue;
      }
      const inner = pattern.slice(i + 1, end);
      const alts: string[] = [];
      let start = 0;
      depth = 0;
      for (let k = 0; k < inner.length; k++) {
        if (inner[k] === '{') depth++;
        else if (inner[k] === '}') depth--;
        else if (inner[k] === ',' && depth === 0) {
          alts.push(inner.slice(start, k));
          start = k + 1;
        }
      }
      alts.push(inner.slice(start));
      re += `(?:${alts.map((a) => globBody(a)).join('|')})`;
      i = end + 1;
    } else {
      re += escapeRegexLiteral(ch);
      i += 1;
    }
  }
  return re;
}

/** Compiles a single glob (subset above) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globBody(normalizeRelPath(pattern))}$`);
}

/** Builds a matcher that accepts a path matching ANY of the given globs. */
export function createPathMatcher(globs: readonly string[]): PathMatcher {
  const regexes = globs.map(globToRegExp);
  return (relPath: string): boolean => {
    const p = normalizeRelPath(relPath);
    return regexes.some((re) => re.test(p));
  };
}

/**
 * True for paths under a segment that is never analysed or watched
 * (`node_modules`, `dist`, `.git`, `.codexrev`) — applied regardless of
 * the configured globs.
 */
export function isAlwaysExcludedPath(relPath: string): boolean {
  const segments = normalizeRelPath(relPath).split('/');
  return segments.some(
    (seg) => (ALWAYS_EXCLUDED_DIRS as readonly string[]).includes(seg) && seg.length > 0,
  );
}
