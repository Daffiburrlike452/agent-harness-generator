// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../src/validate.js';

async function makeHarnessDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-validate-test-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'test-harness',
    version: '0.1.0',
    dependencies: { '@ruflo/kernel': '^0.1.0' },
  }, null, 2));
  await mkdir(join(dir, '.harness'), { recursive: true });
  await writeFile(join(dir, '.harness', 'manifest.json'), JSON.stringify({
    vars: { name: 'test-harness' }, files: {},
  }));
  // The sha256 of the manifest content above (no formatting) — same algo as
  // subcommands.ts:doctor: sha256 over the literal file bytes.
  const { createHash } = await import('node:crypto');
  const m = await import('node:fs/promises').then(m =>
    m.readFile(join(dir, '.harness', 'manifest.json'), 'utf-8')
  );
  const hash = createHash('sha256').update(m, 'utf-8').digest('hex');
  await writeFile(join(dir, '.harness', 'manifest.sha256'), hash);
  // At-least-one host artifact for doctor to pass.
  await writeFile(join(dir, 'AGENTS.md'), '# Pi-Dev agents\n');
  return dir;
}

describe('harness validate', () => {
  // iter 76 — diag is the new 6th check.
  it('chains diag as the 6th informational check (iter 76)', async () => {
    const dir = await makeHarnessDir();
    try {
      const r = await validate([dir, '--skip-gcp']);
      // diag is informational — surface SKIP / PASS / WARN but never
      // FAIL the umbrella. On a hand-rolled manifest with no meta block,
      // diag should SKIP (no kernel_version recorded).
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/SKIP\s+diag\s+—\s+manifest pre-iter-58/);
      // Umbrella verdict unchanged — HEALTHY despite diag SKIP
      expect(txt).toMatch(/Result: HEALTHY/);
      expect(r.code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs all 5 checks and returns HEALTHY on a clean harness', async () => {
    const dir = await makeHarnessDir();
    try {
      const { code, lines } = await validate([dir, '--skip-gcp']);
      const txt = lines.join('\n');
      // Must mention all 5 checks
      expect(txt).toMatch(/doctor/);
      expect(txt).toMatch(/verify/);
      expect(txt).toMatch(/path-guard/);
      expect(txt).toMatch(/mcp/);
      expect(txt).toMatch(/secrets/);
      expect(code).toBe(0);
      expect(txt).toMatch(/Result: HEALTHY/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // iter 94 — symmetric with iter 93 doctor fix
  it('umbrella FAIL message recommends diag --bundle (iter 94)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-val-fail-'));
    try {
      // Empty dir → doctor fails (no package.json, no .harness),
      // umbrella FAILs → must recommend the bundle.
      const r = await validate([dir, '--skip-gcp']);
      expect(r.code).toBe(1);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/Next:\s*capture the full diagnostic state/);
      expect(txt).toMatch(/harness diag .* --bundle > bundle\.json/);
      expect(txt).toContain('github.com/ruvnet/agent-harness-generator/issues');
      expect(txt).toMatch(/secret_\/token_\/key_\/password_ fields are redacted/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('HEALTHY result has no bundle suggestion noise (iter 94)', async () => {
    const dir = await makeHarnessDir();
    try {
      const r = await validate([dir, '--skip-gcp']);
      expect(r.code).toBe(0);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/Result: HEALTHY/);
      // Crucially: NO "Next:" block on HEALTHY runs
      expect(txt).not.toMatch(/Next:\s*capture/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns 1 and explains which check failed', async () => {
    // Empty dir → doctor fails (no package.json)
    const dir = await mkdtemp(join(tmpdir(), 'ahg-validate-empty-'));
    try {
      const { code, lines } = await validate([dir, '--skip-gcp']);
      expect(code).toBe(1);
      const txt = lines.join('\n');
      expect(txt).toMatch(/FAIL doctor/);
      expect(txt).toMatch(/Result: .* FAILED/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('path-guard catches a hardcoded /tmp/ in user TS files', async () => {
    const dir = await makeHarnessDir();
    await writeFile(join(dir, 'bad.ts'),
      `// SPDX-License-Identifier: MIT\nexport const path = '/tmp/agent-state.json';\n`);
    try {
      const { code, lines } = await validate([dir, '--skip-gcp']);
      const txt = lines.join('\n');
      expect(txt).toMatch(/FAIL path-guard/);
      expect(code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips verify when no witness file is present', async () => {
    const dir = await makeHarnessDir();
    try {
      const { lines } = await validate([dir, '--skip-gcp']);
      expect(lines.join('\n')).toMatch(/PASS verify\s+— no witness/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('mcp check passes when no .mcp/servers.json exists', async () => {
    const dir = await makeHarnessDir();
    try {
      const { lines } = await validate([dir, '--skip-gcp']);
      expect(lines.join('\n')).toMatch(/PASS mcp\s+— no \.mcp/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('mcp check catches missing required fields', async () => {
    const dir = await makeHarnessDir();
    await mkdir(join(dir, '.mcp'), { recursive: true });
    await writeFile(join(dir, '.mcp', 'servers.json'),
      JSON.stringify({ mcpServers: [{ command: ['x'] }] }));
    try {
      const { lines, code } = await validate([dir, '--skip-gcp']);
      expect(lines.join('\n')).toMatch(/FAIL mcp\s+— server\[0\] missing name/);
      expect(code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('honors --skip-gcp by skipping the secrets check', async () => {
    const dir = await makeHarnessDir();
    try {
      const { lines } = await validate([dir, '--skip-gcp']);
      expect(lines.join('\n')).toMatch(/PASS secrets\s+— skipped/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
