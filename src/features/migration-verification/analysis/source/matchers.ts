/**
 * Feature 3 / Function 1 — catalog-guided AST usage matchers (Phase P4).
 *
 * One matcher per BUILT-IN catalog entry id. Matchers are justified by the
 * evidence in that entry (e.g. react-dom-19-removed-render documents
 * ReactDOM.render) — no blind text search, no invented rules.
 *
 * Confidence model (evidence-based, not invented scores):
 *   'high'   — usage is tied to an actual import/require of the package.
 *   'medium' — matched by a distinctive identifier/member name WITHOUT
 *              import evidence; the limitation is reported on the match.
 *
 * Comments and string literals are never matched: matches are AST nodes only.
 */

import { Node, SyntaxKind, type SourceFile, type PropertyAccessExpression } from 'ts-morph';

export interface MatcherContext {
  sourceFile: SourceFile;
  /** POSIX-style path of the file being analyzed (for evidence refs). */
  relativePath: string;
}

export interface RawMatch {
  start: { line: number; column: number };
  end: { line: number; column: number };
  matchedPattern: string;
  explanation: string;
  confidence: 'high' | 'medium';
  limitation?: string;
}

export interface UsageMatcher {
  entryId: string;
  collect(ctx: MatcherContext): RawMatch[];
}

/** 1-based line and column (ts-morph convention). */
function positionAt(sourceFile: SourceFile, pos: number): { line: number; column: number } {
  const { line, column } = sourceFile.getLineAndColumnAtPos(pos);
  return { line, column };
}

function matchSpan(sourceFile: SourceFile, start: number, end: number): { start: { line: number; column: number }; end: { line: number; column: number } } {
  return { start: positionAt(sourceFile, start), end: positionAt(sourceFile, end) };
}

/**
 * Local identifier names bound to a package via ESM import or CommonJS
 * require (default, namespace, named, and destructured forms).
 */
function importBoundNames(sourceFile: SourceFile, packageName: string): Set<string> {
  const names = new Set<string>();
  for (const imp of sourceFile.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== packageName) continue;
    const def = imp.getDefaultImport();
    if (def) names.add(def.getText());
    const ns = imp.getNamespaceImport();
    if (ns) names.add(ns.getText());
    for (const named of imp.getNamedImports()) {
      const alias = named.getAliasNode();
      names.add(alias ? alias.getText() : named.getName());
    }
  }
  for (const stmt of sourceFile.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (
        Node.isCallExpression(init) &&
        init.getExpression().getText() === 'require' &&
        init.getArguments().length > 0
      ) {
        const arg = init.getArguments()[0];
        if (Node.isStringLiteral(arg) && arg.getLiteralText() === packageName) {
          // ts-morph v28: getName() returns a string; getNameNode() returns the Node.
          const nameNode = decl.getNameNode();
          if (Node.isIdentifier(nameNode)) {
            names.add(nameNode.getText());
          } else if (Node.isObjectBindingPattern(nameNode)) {
            for (const el of nameNode.getElements()) names.add(el.getName());
          }
        }
      }
    }
  }
  return names;
}

function propertyAccesses(sourceFile: SourceFile): PropertyAccessExpression[] {
  return sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression);
}

/**
 * react-dom 19: ReactDOM.render removed.
 * Patterns: `X.render` / `X.render(...)` where X is bound to 'react-dom'
 * (default/namespace import or require) — high confidence; fallback for an
 * unimported receiver literally named `ReactDOM` — medium confidence.
 */
const reactDomMatcher: UsageMatcher = {
  entryId: 'react-dom-19-removed-render',
  collect(ctx) {
    const matches: RawMatch[] = [];
    const bound = importBoundNames(ctx.sourceFile, 'react-dom');
    for (const pat of propertyAccesses(ctx.sourceFile)) {
      if (pat.getName() !== 'render') continue;
      const receiver = pat.getExpression();
      if (!Node.isIdentifier(receiver)) continue;
      const text = receiver.getText();
      const importBound = bound.has(text);
      const namedReactDOM = text === 'ReactDOM';
      if (!importBound && !namedReactDOM) continue;
      matches.push({
        ...matchSpan(ctx.sourceFile, pat.getStart(), pat.getEnd()),
        matchedPattern: 'ReactDOM.render member access/call',
        explanation: `member 'render' accessed on '${text}'${importBound ? ' (imported from react-dom)' : ''} — removed in react-dom 19`,
        confidence: importBound ? 'high' : 'medium',
        ...(importBound
          ? {}
          : {
              limitation:
                "receiver named 'ReactDOM' without an import/require from 'react-dom' — usage is likely but unproven",
            }),
      });
    }
    return matches;
  },
};

const LRU_CTOR_OPTIONS = ['maxAge', 'length', 'stale'] as const;
const LRU_INSTANCE_MEMBERS = ['prune', 'reset', 'length'] as const;

/**
 * lru-cache v7 renames. Patterns (all require import/require evidence for
 * the LRU constructor):
 *   - `new LRU({ maxAge|length| stale: ... })` option properties — high
 *   - `<v>.prune()` / `<v>.reset()` / `<v>.length` where `v = new LRU(...)`
 *     in the same file — high
 * Not supported (documented limitation): `new LRU().prune()` chaining and
 * `require('lru-cache').LRU` constructor expressions.
 */
const lruCacheMatcher: UsageMatcher = {
  entryId: 'lru-cache-7-renamed-options',
  collect(ctx) {
    const matches: RawMatch[] = [];
    const ctors = importBoundNames(ctx.sourceFile, 'lru-cache');
    const instanceVars = new Set<string>();

    for (const newExpr of ctx.sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const callee = newExpr.getExpression();
      if (!Node.isIdentifier(callee) || !ctors.has(callee.getText())) continue;
      const arg = newExpr.getArguments()[0];
      if (Node.isObjectLiteralExpression(arg)) {
        for (const prop of arg.getProperties()) {
          if (!Node.isPropertyAssignment(prop)) continue;
          const name = prop.getName();
          if ((LRU_CTOR_OPTIONS as readonly string[]).includes(name)) {
            matches.push({
              ...matchSpan(ctx.sourceFile, prop.getStart(), prop.getEnd()),
              matchedPattern: `LRU constructor option '${name}'`,
              explanation: `option '${name}' passed to new ${callee.getText()}(...) — renamed in lru-cache v7`,
              confidence: 'high',
            });
          }
        }
      }
      const parent = newExpr.getParent();
      if (Node.isVariableDeclaration(parent)) {
        const nameNode = parent.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          instanceVars.add(nameNode.getText());
        }
      }
    }

    for (const pat of propertyAccesses(ctx.sourceFile)) {
      const receiver = pat.getExpression();
      if (!Node.isIdentifier(receiver) || !instanceVars.has(receiver.getText())) continue;
      const name = pat.getName();
      if ((LRU_INSTANCE_MEMBERS as readonly string[]).includes(name)) {
        matches.push({
          ...matchSpan(ctx.sourceFile, pat.getStart(), pat.getEnd()),
          matchedPattern: `LRU instance member '${name}'`,
          explanation: `'${name}' accessed on an lru-cache instance — renamed in lru-cache v7`,
          confidence: 'high',
        });
      }
    }
    return matches;
  },
};

/**
 * highlight.js v11: highlightBlock deprecated.
 * Pattern: `X.highlightBlock` where X is bound to 'highlight.js' (high);
 * fallback: any `Y.highlightBlock` member (distinctive name) — medium.
 */
const highlightJsMatcher: UsageMatcher = {
  entryId: 'highlightjs-11-deprecated-highlightblock',
  collect(ctx) {
    const matches: RawMatch[] = [];
    const bound = importBoundNames(ctx.sourceFile, 'highlight.js');
    for (const pat of propertyAccesses(ctx.sourceFile)) {
      if (pat.getName() !== 'highlightBlock') continue;
      const receiver = pat.getExpression();
      if (!Node.isIdentifier(receiver)) continue;
      const importBound = bound.has(receiver.getText());
      matches.push({
        ...matchSpan(ctx.sourceFile, pat.getStart(), pat.getEnd()),
        matchedPattern: 'highlightBlock member access/call',
        explanation: `member 'highlightBlock' accessed on '${receiver.getText()}'${importBound ? ' (imported from highlight.js)' : ''} — deprecated in highlight.js v11`,
        confidence: importBound ? 'high' : 'medium',
        ...(importBound
          ? {}
          : {
              limitation:
                "matched by member name 'highlightBlock' without import evidence from 'highlight.js' — may be another API",
            }),
      });
    }
    return matches;
  },
};

export const BUILTIN_MATCHERS: readonly UsageMatcher[] = [
  reactDomMatcher,
  lruCacheMatcher,
  highlightJsMatcher,
];

export function findMatcher(entryId: string): UsageMatcher | undefined {
  return BUILTIN_MATCHERS.find((m) => m.entryId === entryId);
}
