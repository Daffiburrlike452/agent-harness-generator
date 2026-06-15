// SPDX-License-Identifier: MIT
//
// iter 58: verify the scaffolder populates manifest.meta.kernel_version
// at write time so the ADR-027 diagnostic is load-bearing (not just an
// optional field that nobody ever fills in).
//
// The test runs the real scaffold() against a tmpdir, reads back the
// .harness/manifest.json that was written, and asserts:
//
//   1. meta.surface === 'cli' (default — only the web-UI port sets 'web-ui')
//   2. meta.kernel_version === @metaharness/kernel's package.json version
//
// If the workspace doesn't have @metaharness/kernel resolvable (CI on a clean
// checkout without `npm install`), we accept undefined as a soft-pass —
// the resolveKernelVersion() implementation deliberately never throws
// because a broken kernel install should not block scaffolding.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '..');
const KERNEL_PKG = resolve(REPO_ROOT, 'packages', 'kernel-js', 'package.json');

let scaffold: (opts: any) => Promise<any>;

beforeAll(async () => {
  const distPath = resolve(REPO_ROOT, 'packages', 'create-agent-harness', 'dist', 'index.js');
  if (!existsSync(distPath)) {
    throw new Error(`create-agent-harness dist missing — run npm run build first (${distPath})`);
  }
  const mod = await import(`file://${distPath}`);
  scaffold = mod.scaffold;
});

describe('manifest.meta.kernel_version (iter 58 — ADR-027 diagnostic)', () => {
  it('scaffold writes meta.surface = "cli" and meta.kernel_version matches @metaharness/kernel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-kernver-'));
    try {
      await scaffold({
        name: 'kernver-bot',
        template: 'minimal',
        host: 'claude-code',
        description: 'iter 58 test',
        targetDir: dir,
        force: true,
        generatorVersion: '0.1.0',
      });

      const manifestPath = join(dir, '.harness', 'manifest.json');
      expect(existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
      expect(manifest.meta).toBeDefined();
      expect(manifest.meta.surface).toBe('cli');

      if (existsSync(KERNEL_PKG)) {
        const kpkg = JSON.parse(readFileSync(KERNEL_PKG, 'utf-8'));
        expect(manifest.meta.kernel_version).toBe(kpkg.version);
      } else {
        // Soft-pass: no kernel available on this checkout. Field should
        // be undefined (not present), which is the documented fallback.
        expect(manifest.meta.kernel_version).toBeUndefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scaffold writes meta.kernel_version as a non-empty semver-shaped string when present', async () => {
    if (!existsSync(KERNEL_PKG)) {
      // Cannot assert version shape when no kernel is resolvable.
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'ahg-kernver2-'));
    try {
      await scaffold({
        name: 'kernver2-bot',
        template: 'minimal',
        host: 'codex',
        targetDir: dir,
        force: true,
        generatorVersion: '0.1.0',
      });
      const manifest = JSON.parse(
        await readFile(join(dir, '.harness', 'manifest.json'), 'utf-8'),
      );
      expect(typeof manifest.meta.kernel_version).toBe('string');
      expect(manifest.meta.kernel_version.length).toBeGreaterThan(0);
      // Loose semver shape (N.N.N optionally + prerelease)
      expect(manifest.meta.kernel_version).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
