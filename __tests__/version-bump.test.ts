// SPDX-License-Identifier: MIT
//
// Tests for the version-bump.mjs semver math + Cargo regex. These pin
// the cross-package version-lockstep invariant that preflight.mjs
// validates — if version-bump produces an inconsistent set, preflight
// catches it but ONLY in CI. These tests catch it pre-commit.

import { describe, it, expect } from 'vitest';
// @ts-ignore — JS module
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

const SCRIPT = join(process.cwd(), 'scripts', 'version-bump.mjs');

async function runBump(cwd: string, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], { cwd, windowsHide: true });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

async function setupFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-bump-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', version: '0.1.0', workspaces: ['packages/*'],
  }));
  await mkdir(join(dir, 'packages', 'a'), { recursive: true });
  await writeFile(join(dir, 'packages', 'a', 'package.json'), JSON.stringify({
    name: '@metaharness/a', version: '0.1.0',
    dependencies: { '@metaharness/b': '0.1.0', 'other': '^1.0.0' },
  }));
  await mkdir(join(dir, 'packages', 'b'), { recursive: true });
  await writeFile(join(dir, 'packages', 'b', 'package.json'), JSON.stringify({
    name: '@metaharness/b', version: '0.1.0',
  }));
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'fixture', version: '0.1.0',
  }));
  await writeFile(join(dir, 'Cargo.toml'),
    `[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n`);
  return dir;
}

describe('version-bump.mjs', () => {
  it('patch bump: 0.1.0 -> 0.1.1 across root + packages + plugin + Cargo', async () => {
    const dir = await setupFixture();
    try {
      const r = await runBump(dir, ['patch']);
      expect(r.code).toBe(0);
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')).version).toBe('0.1.1');
      expect(JSON.parse(await readFile(join(dir, 'packages', 'a', 'package.json'), 'utf-8')).version).toBe('0.1.1');
      expect(JSON.parse(await readFile(join(dir, 'packages', 'b', 'package.json'), 'utf-8')).version).toBe('0.1.1');
      expect(JSON.parse(await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')).version).toBe('0.1.1');
      expect(await readFile(join(dir, 'Cargo.toml'), 'utf-8')).toMatch(/version = "0\.1\.1"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('minor bump: 0.1.0 -> 0.2.0', async () => {
    const dir = await setupFixture();
    try {
      await runBump(dir, ['minor']);
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')).version).toBe('0.2.0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('major bump: 0.1.0 -> 1.0.0', async () => {
    const dir = await setupFixture();
    try {
      await runBump(dir, ['major']);
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')).version).toBe('1.0.0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('explicit version: 0.1.0 -> 0.5.7', async () => {
    const dir = await setupFixture();
    try {
      await runBump(dir, ['0.5.7']);
      expect(JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')).version).toBe('0.5.7');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('workspace deps to other @metaharness/* packages get bumped in lockstep', async () => {
    const dir = await setupFixture();
    try {
      await runBump(dir, ['patch']);
      const a = JSON.parse(await readFile(join(dir, 'packages', 'a', 'package.json'), 'utf-8'));
      // @metaharness/b was 0.1.0 in deps, should become 0.1.1
      expect(a.dependencies['@metaharness/b']).toBe('0.1.1');
      // non-@metaharness dep stays put
      expect(a.dependencies['other']).toBe('^1.0.0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('--dry-run does not touch files', async () => {
    const dir = await setupFixture();
    try {
      const before = await readFile(join(dir, 'package.json'), 'utf-8');
      await runBump(dir, ['patch', '--dry-run']);
      const after = await readFile(join(dir, 'package.json'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects unparseable target', async () => {
    const dir = await setupFixture();
    try {
      const r = await runBump(dir, ['not-a-version']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/unknown bump kind|unparseable/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
