// The Java detection fixtures are for the LLM roles: the defects in them are logic, design and
// requirement defects, never compile errors. If one stopped compiling (or the javac fallback started
// treating its missing Spring/JUnit jars as defects), Build would block it and every evaluation run
// would credit the wrong role — and a clean baseline would show up as a false positive.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { onPath } from '../../../src/core/toolchains/index.js';
import { JAVA_DETECTION_FIXTURES, makeFixtureRepo } from '../../../src/features/review-pipeline/testing/detectionFixtures.js';
import { readDiff } from '../../../src/features/review-pipeline/pipeline/diffReader.js';
import { runBuildRole } from '../../../src/features/review-pipeline/roles/build.js';
import { ContextAggregator } from '../../../src/features/review-pipeline/pipeline/contextAggregator.js';
import type { ILLMProvider } from '../../../src/features/review-pipeline/pipeline/illmProvider.js';

const llm: ILLMProvider = {
  id: 'openai',
  generate: () => {
    throw new Error('Build role must not call the LLM');
  },
  stream: () => {
    throw new Error('Build role must not call the LLM');
  },
};

const hasJavac = await onPath('javac');

describe.skipIf(!hasJavac)('Java detection fixtures — Build role', () => {
  for (const fixture of JAVA_DETECTION_FIXTURES) {
    const expectation = fixture.expectRole === null ? 'passes outright (clean baseline)' : 'is not blocked by Build';
    it(`${fixture.name}: ${expectation}`, async () => {
      const cwd = await makeFixtureRepo({ [fixture.file]: fixture.content });
      try {
        const diff = await readDiff(cwd);
        const out = await runBuildRole({ llm, model: 'm', diff, aggregator: new ContextAggregator(diff), cwd });
        if (fixture.expectRole === null) expect(out.verdict, out.summary).toBe('pass');
        else expect(out.verdict, `${out.summary}\n${out.findings.map((f) => f.description).join('\n')}`).not.toBe('block');
        expect(out.summary).toMatch(/javac: 0 error\(s\) in 1 file/);
        // nothing compiled into the fixture repo
        expect(await fs.readdir(path.dirname(path.join(cwd, fixture.file)))).toEqual([path.basename(fixture.file)]);
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

describe('Java detection fixtures — shape', () => {
  it('mirror every TypeScript category, with two clean baselines', () => {
    expect(JAVA_DETECTION_FIXTURES.filter((f) => f.expectRole === null)).toHaveLength(2);
    expect(new Set(JAVA_DETECTION_FIXTURES.map((f) => f.expectRole))).toEqual(new Set(['architect', 'qa', 'dev', 'ba', null]));
    for (const f of JAVA_DETECTION_FIXTURES) {
      expect(f.language).toBe('java');
      // the file sits where its package says, so javac's -sourcepath and the reviewers both see a normal layout
      const pkg = /^package ([\w.]+);/m.exec(f.content)![1]!;
      expect(f.file).toContain(pkg.replace(/\./g, '/'));
    }
  });
});
