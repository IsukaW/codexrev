import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  generateProposals,
  proposalsToUrsPatch,
  validatePatch,
} from '../../../src/features/living-spec/pipeline/ursPatcher.js';
import { compareDrift } from '../../../src/features/living-spec/pipeline/driftComparator.js';
import {
  renderUrsMarkdown,
  sectionCloseMarker,
  sectionOpenMarker,
} from '../../../src/features/living-spec/pipeline/ursModel.js';
import type {
  ScopedUrsPatch,
  SpecImplication,
  UrsDocument,
} from '../../../src/features/living-spec/pipeline/types.js';

function docWith3(): UrsDocument {
  return {
    schemaVersion: 1,
    title: 'URS',
    sections: ['a', 'b', 'c'].map((n) => ({
      id: `req-${n}`,
      title: `Section ${n}`,
      text: `Requirement ${n} body text.`,
      type: 'functional' as const,
      version: 1,
      lastChangeId: 'c0',
      sourceRefs: [`src/${n}.ts:1`],
    })),
  };
}

function sectionBlock(markdown: string, id: string): string {
  const start = markdown.indexOf(sectionOpenMarker(id));
  const end = markdown.indexOf(sectionCloseMarker(id)) + sectionCloseMarker(id).length;
  expect(start).toBeGreaterThan(-1);
  return markdown.slice(start, end);
}

function modifyOp(doc: UrsDocument, id: string, newText: string): ScopedUrsPatch {
  const existing = doc.sections.find((s) => s.id === id)!;
  return {
    summary: `update ${id}`,
    ops: [
      {
        op: 'modify',
        sectionId: id,
        section: { ...existing, text: newText },
        markdown: newText,
      },
    ],
  };
}

describe('applyPatch — scoped to relevant sections only (SO4)', () => {
  it('touches only the patched section; untouched sections are byte-identical', () => {
    const doc = docWith3();
    const before = renderUrsMarkdown(doc);
    const patched = applyPatch(doc, modifyOp(doc, 'req-b', 'Requirement b body text. UPDATED.'));

    expect(patched.sections.map((s) => s.id)).toEqual(['req-a', 'req-b', 'req-c']);
    const after = renderUrsMarkdown(patched);

    // untouched sections render byte-identically
    expect(sectionBlock(after, 'req-a')).toBe(sectionBlock(before, 'req-a'));
    expect(sectionBlock(after, 'req-c')).toBe(sectionBlock(before, 'req-c'));
    // the touched section changed
    expect(sectionBlock(after, 'req-b')).toContain('UPDATED');
    expect(sectionBlock(after, 'req-b')).not.toBe(sectionBlock(before, 'req-b'));
  });

  it('adds a section without disturbing existing ones', () => {
    const doc = docWith3();
    const before = renderUrsMarkdown(doc);
    const patch: ScopedUrsPatch = {
      summary: 'add req-d',
      ops: [
        {
          op: 'add',
          sectionId: 'req-d',
          section: {
            id: 'req-d',
            title: 'Section d',
            text: 'Requirement d body text.',
            type: 'nfr',
            version: 1,
            lastChangeId: 'c1',
            sourceRefs: [],
          },
          markdown: 'Requirement d body text.',
        },
      ],
    };
    const patched = applyPatch(doc, patch);
    const after = renderUrsMarkdown(patched);

    expect(patched.sections.map((s) => s.id)).toEqual(['req-a', 'req-b', 'req-c', 'req-d']);
    for (const id of ['req-a', 'req-b', 'req-c']) {
      expect(sectionBlock(after, id)).toBe(sectionBlock(before, id));
    }
  });

  it('removes a section, leaving the rest byte-identical', () => {
    const doc = docWith3();
    const before = renderUrsMarkdown(doc);
    const patch: ScopedUrsPatch = {
      summary: 'remove req-b',
      ops: [{ op: 'remove', sectionId: 'req-b', markdown: '' }],
    };
    const patched = applyPatch(doc, patch);
    const after = renderUrsMarkdown(patched);

    expect(patched.sections.map((s) => s.id)).toEqual(['req-a', 'req-c']);
    expect(after).toContain(sectionOpenMarker('req-a'));
    expect(after).not.toContain(sectionOpenMarker('req-b'));
    expect(sectionBlock(after, 'req-c')).toBe(sectionBlock(before, 'req-c'));
  });

  it('stamps version/lastChangeId onto touched sections only', () => {
    const doc = docWith3();
    const patched = applyPatch(doc, modifyOp(doc, 'req-a', 'changed'), {
      version: 7,
      changeId: 'change-7',
    });
    expect(patched.sections[0].version).toBe(7);
    expect(patched.sections[0].lastChangeId).toBe('change-7');
    expect(patched.sections[1].version).toBe(1);
    expect(patched.sections[1].lastChangeId).toBe('c0');
  });
});

describe('validatePatch — rejects malformed patches', () => {
  const good = modifyOp(docWith3(), 'req-a', 'new text');

  it('accepts a well-formed patch', () => {
    expect(validatePatch(good).ok).toBe(true);
  });

  it('rejects a remove op that still carries a section', () => {
    const bad = {
      summary: 'x',
      ops: [{ op: 'remove', sectionId: 'req-a', section: { id: 'req-a' }, markdown: '' }],
    };
    expect(validatePatch(bad).ok).toBe(false);
  });

  it('rejects an add/modify op without a section', () => {
    const bad = { summary: 'x', ops: [{ op: 'add', sectionId: 'req-z', markdown: 'text' }] };
    expect(validatePatch(bad).ok).toBe(false);
  });

  it('rejects an invalid op kind', () => {
    const bad = { summary: 'x', ops: [{ op: 'upsert', sectionId: 'req-a', markdown: '' }] };
    expect(validatePatch(bad).ok).toBe(false);
  });

  it('rejects duplicate sectionIds', () => {
    const a = good.ops[0];
    const bad = { summary: 'x', ops: [a, { ...a }] };
    expect(validatePatch(bad).ok).toBe(false);
  });

  it('rejects a section whose id does not match sectionId', () => {
    const bad = {
      summary: 'x',
      ops: [
        {
          op: 'modify',
          sectionId: 'req-a',
          section: { id: 'req-b', title: 't', text: 'x', type: 'functional' },
          markdown: 'x',
        },
      ],
    };
    expect(validatePatch(bad).ok).toBe(false);
  });

  it('rejects a non-object patch and a non-array ops', () => {
    expect(validatePatch('nope').ok).toBe(false);
    expect(validatePatch({ summary: 'x', ops: 'nope' }).ok).toBe(false);
  });
});

describe('generateProposals — scoped, one per actionable implication', () => {
  function imp(o: Partial<SpecImplication>): SpecImplication {
    return { id: 'i', kind: 'functional', text: 'Requirement.', confidence: 0.9, sourceRefs: [], ...o };
  }

  it('creates an add proposal for a new requirement touching only its own section', () => {
    const doc = docWith3();
    const implications = [
      imp({ id: 'imp-n', text: 'Administrative login mandates a second verification step.', sourceRefs: ['src/login.js:20'] }),
    ];
    const drift = compareDrift(implications, doc);
    const proposals = generateProposals({
      implications,
      drift,
      doc,
      changeId: 'abc',
      timestamp: '2026-10-17T00:00:00.000Z',
    });

    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.id).toBe('abc-1');
    expect(p.driftStatus).toBe('new');
    expect(p.patch.ops).toHaveLength(1);
    expect(p.patch.ops[0].op).toBe('add');
    expect(p.sectionsTouched).toHaveLength(1);
    expect(p.status).toBe('pending');
  });

  it('creates a modify proposal scoped to the matched section', () => {
    const doc = docWith3();
    const implications = [
      imp({ id: 'imp-m', text: 'Requirement a body text. UPDATED wording.', sourceRefs: ['src/a.ts:1'] }),
    ];
    const drift = compareDrift(implications, doc);
    const proposals = generateProposals({
      implications,
      drift,
      doc,
      changeId: 'abc',
      timestamp: '2026-10-17T00:00:00.000Z',
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].driftStatus).toBe('modified');
    expect(proposals[0].sectionsTouched).toEqual(['req-a']);
    expect(proposals[0].patch.ops[0].op).toBe('modify');
  });

  it('creates no proposal for aligned or inert implications', () => {
    const doc = docWith3();
    const implications = [
      imp({ id: 'imp-a', text: 'Requirement a body text.', sourceRefs: ['src/a.ts:1'] }),
      imp({ id: 'imp-z', text: 'noop', confidence: 0, sourceRefs: [] }),
    ];
    const drift = compareDrift(implications, doc);
    const proposals = generateProposals({
      implications,
      drift,
      doc,
      changeId: 'abc',
      timestamp: '2026-10-17T00:00:00.000Z',
    });
    expect(proposals).toHaveLength(0);
  });

  it('proposalsToUrsPatch collapses ops into the report contract shape', () => {
    const doc = docWith3();
    const implications = [
      imp({ id: 'imp-n', text: 'Administrative login mandates a second verification step.', sourceRefs: ['src/login.js:20'] }),
    ];
    const drift = compareDrift(implications, doc);
    const proposals = generateProposals({
      implications,
      drift,
      doc,
      changeId: 'abc',
      timestamp: '2026-10-17T00:00:00.000Z',
    });
    const ursPatch = proposalsToUrsPatch(proposals);
    expect(ursPatch.entries).toHaveLength(1);
    expect(ursPatch.entries[0].op).toBe('add');
    expect(proposalsToUrsPatch([]).entries).toEqual([]);
  });
});
