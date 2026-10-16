import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHelp } from '../../../src/cli/help.js';

let text: string;

beforeEach(() => {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  renderHelp();
  // eslint-disable-next-line no-control-regex
  text = chunks.join('').replace(/\x1b\[[0-9;]*m/g, '');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('codexrev -h: Safety section', () => {
  it('lists safety in usage and in the commands table with its description', () => {
    expect(text).toMatch(/\$ codexrev safety <assess\|verify\|history>/);
    expect(text).toMatch(/safety +Evaluate proposed DevOps actions before execution +\(assess, verify, history\)/);
  });

  it('lists the three subcommands, honestly describing their status', () => {
    expect(text).toMatch(/Safety subcommands \(with `codexrev safety`\)/);
    expect(text).toMatch(/assess +Assess a proposed action \(pipeline incomplete\)/);
    expect(text).toMatch(/verify +Verify a signed Evidence Pack \(not implemented\)/);
    expect(text).toMatch(/history +Show previous assessments \(not connected\)/);
  });

  it('lists the safety flags', () => {
    const section = text.slice(text.indexOf('Safety flags'));
    expect(section).toMatch(/--action <type> +Proposed action type/);
    expect(section).toMatch(/--target <env> +Target environment/);
    expect(section).toMatch(/--input <path> +Structured action\/evidence input file/);
    expect(section).toMatch(/--diff <ref> +Git revision to compare/);
    expect(section).toMatch(/--output <path> +Evidence Pack output destination/);
    expect(section).toMatch(/--file <path> +Evidence Pack to verify/);
  });

  it('places the Safety sections after Review flags and before Learn more', () => {
    const review = text.indexOf('Review flags');
    const safety = text.indexOf('Safety subcommands');
    const learn = text.indexOf('Learn more');
    expect(review).toBeGreaterThan(-1);
    expect(safety).toBeGreaterThan(review);
    expect(learn).toBeGreaterThan(safety);
  });

  it('leaves the existing help content in place', () => {
    for (const expected of [
      'codexrev review scan',
      'Run the six-role adversarial code review pipeline',
      'Initialize this project with an encrypted .codexrev/config.json',
      'Manage AI provider models',
      'Manage installed extensions',
      'Review flags (with `codexrev review scan`)',
      '--max-iterations',
      'Init flags (with `codexrev init`)',
      '--output-format',
    ]) {
      expect(text, expected).toContain(expected);
    }
  });
});
