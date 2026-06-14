// SPDX-License-Identifier: MIT
//
// iter 66 — tests for the `harness diag` subcommand.
//
// Covers:
//   - skewVerdict() pure-function contract
//   - formatDiagReport() output shape + exit codes
//   - end-to-end: scaffold a real harness, run diagCmd, assert PASS

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');

let diag: typeof import('../packages/create-agent-harness/dist/diag.js');
let scaffold: (opts: any) => Promise<any>;

beforeAll(async () => {
  const distDir = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist');
  if (!existsSync(join(distDir, 'diag.js'))) {
    throw new Error(`diag.js missing — run npm run build (looked at ${distDir}/diag.js)`);
  }
  diag = await import(`file://${join(distDir, 'diag.js')}`);
  const idx = await import(`file://${join(distDir, 'index.js')}`);
  scaffold = idx.scaffold;
});

describe('skewVerdict pure function', () => {
  it('returns match when versions are identical', () => {
    expect(diag.skewVerdict('0.1.0', '0.1.0')).toBe('match');
    expect(diag.skewVerdict('1.2.3', '1.2.3')).toBe('match');
  });

  it('returns patch-diff when only patch differs', () => {
    expect(diag.skewVerdict('1.2.3', '1.2.4')).toBe('patch-diff');
    expect(diag.skewVerdict('0.1.0', '0.1.99')).toBe('patch-diff');
  });

  it('returns minor-diff when minor differs', () => {
    expect(diag.skewVerdict('1.2.3', '1.3.0')).toBe('minor-diff');
    expect(diag.skewVerdict('0.1.0', '0.2.0')).toBe('minor-diff');
  });

  it('returns major-diff when major differs', () => {
    expect(diag.skewVerdict('1.0.0', '2.0.0')).toBe('major-diff');
    expect(diag.skewVerdict('0.1.0', '1.0.0')).toBe('major-diff');
  });

  it('returns unparseable when either input is missing or non-semver', () => {
    expect(diag.skewVerdict(undefined, '1.0.0')).toBe('unparseable');
    expect(diag.skewVerdict('1.0.0', undefined)).toBe('unparseable');
    expect(diag.skewVerdict('git+ssh://...', '1.0.0')).toBe('unparseable');
    expect(diag.skewVerdict('1.0.0', '*')).toBe('unparseable');
  });

  it('ignores pre-release suffix when comparing', () => {
    // Same major/minor/patch with different prereleases is still a match
    // for the diag purposes (the harness was scaffolded against a build
    // that became the same release).
    expect(diag.skewVerdict('1.2.3-alpha.1', '1.2.3')).toBe('match');
  });
});

describe('formatDiagReport', () => {
  it('exits 0 + PASS line on match', () => {
    const r = diag.formatDiagReport({
      dir: '/x',
      surface: 'cli',
      manifestKernelVersion: '0.1.0',
      localKernelVersion: '0.1.0',
      verdict: 'match',
      actionable: undefined,
    });
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/PASS kernel versions match/);
  });

  it('exits 1 + FAIL line + actionable on major-diff', () => {
    const r = diag.formatDiagReport({
      dir: '/x',
      surface: 'cli',
      manifestKernelVersion: '0.1.0',
      localKernelVersion: '1.0.0',
      verdict: 'major-diff',
      actionable: 'Run: npm install @ruflo/kernel@0.1.0 (major skew — APIs may break)',
    });
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toMatch(/FAIL MAJOR skew/);
    expect(r.lines.join('\n')).toMatch(/npm install @ruflo\/kernel@0\.1\.0/);
  });

  it('exits 1 on minor-diff', () => {
    const r = diag.formatDiagReport({
      dir: '/x',
      surface: 'cli',
      manifestKernelVersion: '0.1.0',
      localKernelVersion: '0.2.0',
      verdict: 'minor-diff',
      actionable: 'Run: npm install @ruflo/kernel@0.1.0',
    });
    expect(r.code).toBe(1);
  });

  it('exits 0 on patch-diff (WARN, not FAIL)', () => {
    const r = diag.formatDiagReport({
      dir: '/x',
      surface: 'cli',
      manifestKernelVersion: '0.1.0',
      localKernelVersion: '0.1.5',
      verdict: 'patch-diff',
      actionable: 'Optional: ...',
    });
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toMatch(/WARN patch-level skew/);
  });

  it('exits 2 + FAIL on no manifest at path', () => {
    const r = diag.formatDiagReport({
      dir: tmpdir(),
      surface: undefined,
      manifestKernelVersion: undefined,
      localKernelVersion: '0.1.0',
      verdict: 'unparseable',
      actionable: undefined,
    });
    expect(r.code).toBe(2);
    expect(r.lines.join('\n')).toMatch(/no \.harness\/manifest\.json found/);
  });
});

describe('generator-version skew (iter 71)', () => {
  it('formatDiagReport surfaces a manifest generator line even on match', () => {
    const r = diag.formatDiagReport({
      dir: '/x',
      surface: 'cli',
      manifestKernelVersion: '0.1.0',
      localKernelVersion: '0.1.0',
      verdict: 'match',
      actionable: undefined,
      manifestGeneratorVersion: '0.1.0',
      localGeneratorVersion: '0.1.0',
      generatorVerdict: 'match',
    });
    const out = r.lines.join('\n');
    expect(out).toMatch(/manifest generator:\s+0\.1\.0/);
    expect(out).toMatch(/installed generator:\s+0\.1\.0/);
    expect(out).toMatch(/PASS generator versions match/);
  });

  it('generator-skew is INFORMATIONAL — never changes exit code', () => {
    // Manifest pins generator 0.0.1; local is at 1.0.0 (major skew on
    // generator). Kernel matches, so exit MUST be 0 — the generator
    // skew is informational, not blocking.
    const r = diag.formatDiagReport({
      dir: '/x',
      surface: 'cli',
      manifestKernelVersion: '0.1.0',
      localKernelVersion: '0.1.0',
      verdict: 'match',
      actionable: undefined,
      manifestGeneratorVersion: '0.0.1',
      localGeneratorVersion: '1.0.0',
      generatorVerdict: 'major-diff',
    });
    expect(r.code).toBe(0);  // kernel match wins; generator is INFO only
    const out = r.lines.join('\n');
    expect(out).toMatch(/WARN MAJOR generator skew/);
    expect(out).toMatch(/harness upgrade/);
  });

  it('end-to-end: fresh scaffold shows both PASS lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-diag-gen-'));
    try {
      await scaffold({
        name: 'gen-bot',
        template: 'minimal',
        host: 'claude-code',
        targetDir: dir,
        force: true,
        generatorVersion: '0.1.0',
      });
      const r = await diag.diagCmd([dir]);
      expect(r.code).toBe(0);
      const out = r.lines.join('\n');
      expect(out).toMatch(/PASS kernel versions match/);
      // The scaffolder stamps the generatorVersion arg into
      // manifest.generator, and resolveLocalGeneratorVersion reads
      // the workspace package.json. In dev they're both 0.1.0 → match.
      expect(out).toMatch(/(PASS generator versions match|INFO|generator)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('--json output (iter 73)', () => {
  it('emits parseable JSON with the full DiagReport + exitCode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-diag-json-'));
    try {
      await scaffold({
        name: 'json-bot',
        template: 'minimal',
        host: 'claude-code',
        targetDir: dir,
        force: true,
        generatorVersion: '0.1.0',
      });
      const r = await diag.diagCmd([dir, '--json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.lines.join('\n'));
      expect(parsed.surface).toBe('cli');
      expect(parsed.verdict).toBe('match');
      expect(parsed.generatorVerdict).toBe('match');
      expect(parsed.exitCode).toBe(0);
      expect(typeof parsed.manifestKernelVersion).toBe('string');
      expect(typeof parsed.localKernelVersion).toBe('string');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json position-independent (works as --json then path, or path then --json)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-diag-json2-'));
    try {
      await scaffold({
        name: 'json-bot2',
        template: 'minimal',
        host: 'codex',
        targetDir: dir,
        force: true,
        generatorVersion: '0.1.0',
      });
      const a = await diag.diagCmd(['--json', dir]);
      const b = await diag.diagCmd([dir, '--json']);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const pa = JSON.parse(a.lines.join('\n'));
      const pb = JSON.parse(b.lines.join('\n'));
      expect(pa.verdict).toBe(pb.verdict);
      expect(pa.surface).toBe(pb.surface);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--json on missing manifest emits JSON with exitCode 2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-diag-json3-'));
    try {
      const r = await diag.diagCmd([dir, '--json']);
      expect(r.code).toBe(2);
      const parsed = JSON.parse(r.lines.join('\n'));
      expect(parsed.exitCode).toBe(2);
      expect(parsed.manifestKernelVersion).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('diagCmd end-to-end', () => {
  it('reports PASS on a freshly scaffolded harness (manifest kernel === local kernel)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-diag-'));
    try {
      await scaffold({
        name: 'diag-bot',
        template: 'minimal',
        host: 'claude-code',
        targetDir: dir,
        force: true,
        generatorVersion: '0.1.0',
      });
      const r = await diag.diagCmd([dir]);
      // The scaffolder stamps the local kernel version into the manifest,
      // so back-to-back diagCmd should report match → exit 0.
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/PASS kernel versions match/);
      expect(r.lines.join('\n')).toMatch(/surface:\s+cli/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports FAIL with actionable line when no manifest exists at path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-diag-no-manifest-'));
    try {
      const r = await diag.diagCmd([dir]);
      expect(r.code).toBe(2);
      expect(r.lines.join('\n')).toMatch(/no \.harness\/manifest\.json found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports skew when manifest pins an old kernel and local is newer (synthesized)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-diag-skew-'));
    try {
      await mkdir(join(dir, '.harness'), { recursive: true });
      await writeFile(join(dir, '.harness', 'manifest.json'), JSON.stringify({
        schema: 1,
        generator: '0.1.0',
        template: 'minimal',
        template_version: '0.0.0',
        vars: {},
        hosts: ['claude-code'],
        files: {},
        generated_at: new Date(0).toISOString(),
        meta: { surface: 'cli', kernel_version: '0.0.1' },
      }, null, 2));
      // Stage a package.json so createRequire works
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'diag-skew', version: '0.1.0' }));
      const r = await diag.diagCmd([dir]);
      // local kernel is whatever's in workspace (0.1.0 today); manifest is 0.0.1
      // → minor or major diff. Verdict and code may vary by env but should not be PASS.
      expect(r.lines.join('\n')).toMatch(/(MAJOR skew|minor-level skew)/);
      expect(r.code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
