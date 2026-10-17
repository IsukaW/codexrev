import { describe, expect, it } from 'vitest';
import {
  classifyImplication,
  compareDrift,
  tokenOverlapSimilarity,
} from '../../../src/features/living-spec/pipeline/driftComparator.js';
import type { SpecImplication, UrsDocument } from '../../../src/features/living-spec/pipeline/types.js';

const doc: UrsDocument = {
  schemaVersion: 1,
  title: 'URS',
  sections: [
    {
      id: 'req-greeting',
      title: 'Greeting',
      text: 'The greeting must include the caller name so users see who is addressed.',
      type: 'functional',
      version: 1,
      lastChangeId: 'c1',
      sourceRefs: ['src/greet.js:3'],
    },
    {
      id: 'req-password',
      title: 'Password',
      text: 'The password must be at least 8 characters long for all accounts.',
      type: 'nfr',
      version: 1,
      lastChangeId: 'c1',
      sourceRefs: ['src/auth.js:10'],
    },
  ],
};

function imp(overrides: Partial<SpecImplication>): SpecImplication {
  return {
    id: 'imp-x',
    kind: 'functional',
    text: 'A requirement.',
    confidence: 0.9,
    sourceRefs: [],
    ...overrides,
  };
}

describe('classifyImplication — one fixture per drift classification', () => {
  it('aligned — near-verbatim match to an existing requirement', () => {
    const r = classifyImplication(
      imp({
        id: 'imp-aligned',
        text: 'The greeting must include the caller name so users see who is addressed.',
        sourceRefs: ['src/greet.js:3'],
      }),
      doc,
    );
    expect(r.status).toBe('aligned');
    expect(r.matchedSectionId).toBe('req-greeting');
  });

  it('modified — same requirement, changed wording', () => {
    const r = classifyImplication(
      imp({
        id: 'imp-modified',
        text:
          'The greeting must include the caller name so users see who is addressed, ' +
          'along with their preferred honorific.',
        sourceRefs: ['src/greet.js:3'],
      }),
      doc,
    );
    expect(r.status).toBe('modified');
    expect(r.matchedSectionId).toBe('req-greeting');
  });

  it('new — no matching requirement by ref or similarity', () => {
    const r = classifyImplication(
      imp({
        id: 'imp-new',
        kind: 'nfr',
        text: 'Administrative login mandates a second verification step.',
        sourceRefs: ['src/login.js:20'],
      }),
      doc,
    );
    expect(r.status).toBe('new');
    expect(r.matchedSectionId).toBeUndefined();
  });

  it('conflicting — contradicts an existing requirement on the same code', () => {
    const r = classifyImplication(
      imp({
        id: 'imp-conflict',
        kind: 'nfr',
        text: 'Password length is no longer enforced for local accounts.',
        sourceRefs: ['src/auth.js:10'],
      }),
      doc,
    );
    expect(r.status).toBe('conflicting');
    expect(r.matchedSectionId).toBe('req-password');
  });

  it('no-semantic-change — inert implication (confidence 0)', () => {
    const r = classifyImplication(
      imp({ id: 'imp-inert', text: 'Renamed a local variable.', confidence: 0, sourceRefs: [] }),
      doc,
    );
    expect(r.status).toBe('no-semantic-change');
    expect(r.matchedSectionId).toBeUndefined();
  });

  it('matches by requirement id before refs/similarity', () => {
    const r = classifyImplication(
      // shares no refs and modest text, but the id pins it to req-greeting
      imp({
        id: 'req-greeting',
        text: 'Greeting behaviour around addressing the caller.',
        sourceRefs: ['src/other.js:1'],
      }),
      doc,
    );
    expect(r.matchedSectionId).toBe('req-greeting');
  });
});

describe('compareDrift — overall aggregation', () => {
  it('reports no-semantic-change when there are no implications', () => {
    expect(compareDrift([], doc).overall).toBe('no-semantic-change');
  });

  it('reports aligned when every implication is aligned', () => {
    const r = compareDrift(
      [imp({ id: 'a', text: 'The greeting must include the caller name so users see who is addressed.', sourceRefs: ['src/greet.js:3'] })],
      doc,
    );
    expect(r.overall).toBe('aligned');
  });

  it('reports the most significant signal (conflicting wins)', () => {
    const r = compareDrift(
      [
        imp({ id: 'a', text: 'The greeting must include the caller name so users see who is addressed.', sourceRefs: ['src/greet.js:3'] }),
        imp({ id: 'b', kind: 'nfr', text: 'Administrative login mandates a second verification step.', sourceRefs: ['src/login.js:20'] }),
        imp({ id: 'c', kind: 'nfr', text: 'Password length is no longer enforced for local accounts.', sourceRefs: ['src/auth.js:10'] }),
      ],
      doc,
    );
    expect(r.overall).toBe('conflicting');
    expect(r.perImplication).toHaveLength(3);
  });

  it('ranks new above modified', () => {
    const r = compareDrift(
      [
        imp({ id: 'm', text: 'The greeting must include the caller name so users see who is addressed, plus a title.', sourceRefs: ['src/greet.js:3'] }),
        imp({ id: 'n', kind: 'nfr', text: 'Administrative login mandates a second verification step.', sourceRefs: ['src/login.js:20'] }),
      ],
      doc,
    );
    expect(r.overall).toBe('new');
  });
});

describe('swappable similarity heuristic', () => {
  it('uses an injected similarity function', () => {
    // A similarity that declares everything identical forces the shared-ref
    // implication to "aligned" regardless of the real text overlap.
    const r = classifyImplication(
      imp({ id: 'i', text: 'Completely different words here.', sourceRefs: ['src/auth.js:10'] }),
      doc,
      { similarity: () => 1 },
    );
    expect(r.status).toBe('aligned');
  });

  it('tokenOverlapSimilarity scores identical text as 1 and disjoint text as 0', () => {
    expect(tokenOverlapSimilarity('hello world', 'hello world')).toBe(1);
    expect(tokenOverlapSimilarity('hello world', 'different entirely')).toBe(0);
  });
});
