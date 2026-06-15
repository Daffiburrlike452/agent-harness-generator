// SPDX-License-Identifier: MIT
// ADR-041 scorecard tests — `metaharness score <repo>`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoScorecard, formatRepoScorecard, scoreRepoCmd } from '../src/repo-scorecard.js';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'scorecard-'));
  // a TypeScript SDK-ish repo with build + test + CI signals
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'acme-sdk',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { typescript: '^5', vitest: '^2' },
    }),
  );
  writeFileSync(join(repo, 'README.md'), '# acme-sdk\nA TypeScript SDK / npm client library for the Acme API.\n');
  mkdirSync(join(repo, '.github'), { recursive: true });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('buildRepoScorecard', () => {
  it('produces all six dimensions in 0..100 + a cost + a mode', () => {
    const sc = buildRepoScorecard(repo, '2026-06-15T00:00:00Z');
    for (const k of ['harnessFit', 'compileConfidence', 'taskCoverage', 'toolSafety', 'memoryUsefulness'] as const) {
      expect(sc[k]).toBeGreaterThanOrEqual(0);
      expect(sc[k]).toBeLessThanOrEqual(100);
    }
    expect(sc.estCostPerRunUsd).toBeGreaterThan(0);
    expect(['CLI', 'CLI + MCP']).toContain(sc.recommendedMode);
    expect(sc.repo).toBe('acme-sdk');
  });

  it('rewards build+test signals in compile confidence', () => {
    const withBuild = buildRepoScorecard(repo, 'x');
    // has language + build + test → should be high
    expect(withBuild.compileConfidence).toBeGreaterThanOrEqual(80);
  });

  it('is deterministic for the same repo + timestamp', () => {
    const a = buildRepoScorecard(repo, 'fixed');
    const b = buildRepoScorecard(repo, 'fixed');
    expect(a).toEqual(b);
  });

  it('default-deny policy yields high tool safety', () => {
    expect(buildRepoScorecard(repo, 'x').toolSafety).toBeGreaterThanOrEqual(70);
  });
});

describe('formatRepoScorecard', () => {
  it('renders the 6-line card', () => {
    const lines = formatRepoScorecard(buildRepoScorecard(repo, 'x'));
    const joined = lines.join('\n');
    expect(joined).toMatch(/Harness fit:/);
    expect(joined).toMatch(/Compile confidence:/);
    expect(joined).toMatch(/Task coverage:/);
    expect(joined).toMatch(/Tool safety:/);
    expect(joined).toMatch(/Memory usefulness:/);
    expect(joined).toMatch(/Est\. cost per run:\s+\$/);
    expect(joined).toMatch(/Recommended mode:/);
  });
});

describe('scoreRepoCmd', () => {
  it('exits 0 and prints the card for a valid repo', async () => {
    const r = await scoreRepoCmd([repo]);
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/Harness fit:/);
  });
  it('--json emits valid parseable JSON with schema 1', async () => {
    const r = await scoreRepoCmd([repo, '--json']);
    expect(r.code).toBe(0);
    const sc = JSON.parse(r.lines.join('\n'));
    expect(sc.schema).toBe(1);
    expect(sc.recommendedMode).toBeTruthy();
  });
  it('no path → usage, exit 2', async () => {
    const r = await scoreRepoCmd([]);
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/Usage: metaharness score/);
  });
  it('--help → exit 0 usage', async () => {
    expect((await scoreRepoCmd(['--help'])).code).toBe(0);
  });
});
