import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDriftAlerts } from '../../../src/features/living-spec/pipeline/driftAlert.js';
import type { DriftComparison } from '../../../src/features/living-spec/pipeline/driftComparator.js';
import type {
  SpecChangeDriftAlert,
  SpecImplication,
  UrsDocument,
} from '../../../src/features/living-spec/pipeline/types.js';
import {
  alertsLogPath,
  appendDriftAlerts,
  readDriftAlerts,
  writeUrsDocument,
} from '../../../src/features/living-spec/tools/stateStore.js';
import { handleSpecCommand } from '../../../src/features/living-spec/cli/handleSpecCommand.js';
import type { LLMPort } from '../../../src/features/living-spec/pipeline/llmPort.js';
import type { GenerateResponse } from '../../../src/core/types.js';

const NFR6_FIELDS = [
  'changeId',
  'file',
  'reason',
  'affectedRequirement',
  'proposedNextAction',
  'severity',
  'timestamp',
] as const;

const DOC: UrsDocument = {
  schemaVersion: 1,
  title: 'User Requirements Specification',
  sections: [
    {
      id: 'sec-greeting',
      title: 'Greeting',
      text: 'The greeting must include the caller name.',
      type: 'functional',
      version: 1,
      lastChangeId: 'seed',
      sourceRefs: ['src/greet.js:2'],
    },
  ],
};

function imp(overrides: Partial<SpecImplication> & { id: string }): SpecImplication {
  return {
    kind: 'functional',
    text: 'The greeting must include the caller name.',
    confidence: 0.9,
    sourceRefs: ['src/greet.js:2'],
    ...overrides,
  };
}

describe('buildDriftAlerts (FR9/NFR6)', () => {
  it('raises a full NFR6 alert for a conflicting detection', () => {
    const drift: DriftComparison = {
      overall: 'conflicting',
      perImplication: [
        {
          implicationId: 'imp-1',
          status: 'conflicting',
          matchedSectionId: 'sec-greeting',
          similarity: 0.6,
        },
      ],
    };

    const alerts = buildDriftAlerts({
      changeId: 'change-1',
      timestamp: '2026-10-17T00:00:00.000Z',
      implications: [
        imp({ id: 'imp-1', text: 'The greeting must no longer include the caller name.' }),
      ],
      drift,
      doc: DOC,
      proposals: [
        {
          id: 'prop-1',
          changeId: 'change-1',
          createdAt: '2026-10-17T00:00:00.000Z',
          title: 'Update greeting',
          status: 'pending',
          implicationIds: ['imp-1'],
          driftStatus: 'conflicting',
          sectionsTouched: ['sec-greeting'],
        },
      ],
    });

    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(Object.keys(alert).sort()).toEqual([...NFR6_FIELDS].sort());
    expect(alert.changeId).toBe('change-1');
    expect(alert.file).toBe('src/greet.js');
    expect(alert.reason).toContain('sec-greeting');
    expect(alert.reason).toContain('Greeting');
    expect(alert.affectedRequirement).toBe('sec-greeting');
    expect(alert.proposedNextAction).toContain('prop-1');
    expect(alert.severity).toBe('critical');
    expect(alert.timestamp).toBe('2026-10-17T00:00:00.000Z');
  });

  it('classifies modified detections as warnings and skips new/aligned ones', () => {
    const drift: DriftComparison = {
      overall: 'modified',
      perImplication: [
        { implicationId: 'imp-mod', status: 'modified', matchedSectionId: 'sec-greeting', similarity: 0.5 },
        { implicationId: 'imp-new', status: 'new', similarity: 0 },
        { implicationId: 'imp-ok', status: 'aligned', matchedSectionId: 'sec-greeting', similarity: 0.95 },
      ],
    };

    const alerts = buildDriftAlerts({
      changeId: 'change-2',
      timestamp: '2026-10-17T00:00:00.000Z',
      implications: [
        imp({ id: 'imp-mod', text: 'The greeting must include the caller nickname.' }),
        imp({ id: 'imp-new', text: 'A brand new requirement appears.' }),
        imp({ id: 'imp-ok', text: 'The greeting must include the caller name.' }),
      ],
      drift,
      doc: DOC,
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].affectedRequirement).toBe('sec-greeting');
  });
});

describe('alerts.jsonl (append-only JSONL)', () => {
  it('appends alerts as one valid JSON object per line', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-alerts-')));
    try {
      const base: SpecChangeDriftAlert = {
        changeId: 'change-1',
        file: 'src/greet.js',
        reason: 'Requirement "Greeting" (sec-greeting) conflicts with this change.',
        affectedRequirement: 'sec-greeting',
        proposedNextAction: 'Reconcile the conflict with requirement sec-greeting.',
        severity: 'critical',
        timestamp: '2026-10-17T00:00:00.000Z',
      };
      await appendDriftAlerts(tmp, [base]);
      await appendDriftAlerts(tmp, [{ ...base, changeId: 'change-2', severity: 'warning' }]);

      const raw = await fs.readFile(alertsLogPath(tmp), 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

      const read = await readDriftAlerts(tmp);
      expect(read.map((a) => a.changeId)).toEqual(['change-1', 'change-2']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── e2e: a conflicting analysis raises and persists the alert ─────────

let tmpRoot: string;
let logs: string[];

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'codexrev-alertcli-'));
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function initRepo(): Promise<SimpleGit> {
  const git = simpleGit({ baseDir: tmpRoot });
  await git.init();
  await git.addConfig('user.email', 'test@codexrev.dev');
  await git.addConfig('user.name', 'Codexrev Test');
  return git;
}

function response(text: string): GenerateResponse {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  };
}

function fakePort(text: string): LLMPort {
  return { provider: 'lmstudio', model: 'm', generate: async () => response(text) };
}

function conflictingPayload() {
  return {
    implications: [
      {
        id: 'imp-1',
        kind: 'functional',
        text: 'The greeting must no longer include the caller name.',
        rationale: 'The greeting literal no longer interpolates the name.',
        confidence: 0.9,
        sourceRefs: [{ path: 'src/greet.js', line: 2 }],
      },
    ],
    behaviourChangeSummary: 'The greeting no longer includes the caller name.',
    requiresUrsUpdate: true,
  };
}

describe('codexrev spec analyze — conflicting change raises a drift alert', () => {
  it('persists the alert to alerts.jsonl and shows it in status', async () => {
    const git = await initRepo();
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'src', 'greet.js'),
      'export function greet(name) {\n  return `hello ${name}`;\n}\n',
      'utf-8',
    );
    await git.add('src/greet.js');
    await git.commit('initial');
    await fs.writeFile(
      path.join(tmpRoot, 'src', 'greet.js'),
      'export function greet(name) {\n  return "hello";\n}\n',
      'utf-8',
    );
    await git.add('src/greet.js');

    // living URS covering the greeting requirement at the changed line
    await writeUrsDocument(tmpRoot, DOC);

    await handleSpecCommand(
      ['analyze'],
      { project: tmpRoot, output: 'text', model: 'm' },
      { llm: fakePort(JSON.stringify(conflictingPayload())) },
    );

    // alerts.jsonl exists and holds exactly one valid JSONL record
    const raw = await fs.readFile(alertsLogPath(tmpRoot), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const persisted = JSON.parse(lines[0]) as SpecChangeDriftAlert;
    expect(Object.keys(persisted).sort()).toEqual([...NFR6_FIELDS].sort());
    expect(persisted).toMatchObject({
      changeId: expect.stringMatching(/^[0-9a-f]{64}$/),
      file: 'src/greet.js',
      affectedRequirement: 'sec-greeting',
      severity: 'critical',
      timestamp: expect.any(String),
    });

    // and the CLI rendered it
    const summary = logs.join('\n');
    expect(summary).toContain('drift alerts:');
    expect(summary).toContain('CRITICAL');

    // `spec status` shows the latest alerts (bounded list)
    logs.length = 0;
    await handleSpecCommand(['status'], { project: tmpRoot });
    const status = logs.join('\n');
    expect(status).toContain('drift alerts:');
    expect(status).toContain('1 recorded');
    expect(status).toContain('src/greet.js');
    expect(status).toContain('critical');
  });
});
