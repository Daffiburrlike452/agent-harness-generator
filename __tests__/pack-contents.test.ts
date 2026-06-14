// SPDX-License-Identifier: MIT
//
// Pack-content invariants: `npm pack --dry-run --json` lists the file
// catalog a `npm publish` would actually ship. This test asserts each
// package's tarball CONTAINS the files its README + exports promise.
//
// Why this matters:
//   - `publish-dryrun.mjs` (iter 20) confirms the pack BUILDS but not
//     that the right files are IN the tarball.
//   - It's trivial to forget to add `dist/**` to the `files` array;
//     the pack succeeds but users `npm install <pkg>` and import fails
//     because the import target isn't shipped.
//   - It's the exact regression class create-agent-harness@0.1.0 hit
//     when its bin path was "auto-corrected" by npm.
//
// We assert MINIMAL invariants per package — README + LICENSE always,
// dist/ for code packages, templates/ for the scaffolder, pkg/ for
// the kernel.

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

async function packList(pkgDir: string): Promise<{ files: Array<{ path: string }>; size: number; name: string; version: string } | null> {
  const args = ['pack', '--dry-run', '--json'];
  const [bin, finalArgs] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
    : ['npm', args];
  try {
    const { stdout } = await execFile(bin, finalArgs, {
      cwd: pkgDir,
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
    });
    const start = stdout.indexOf('[');
    if (start === -1) return null;
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) && parsed[0]
      ? { files: parsed[0].files, size: parsed[0].unpackedSize, name: parsed[0].name, version: parsed[0].version }
      : null;
  } catch {
    return null;
  }
}

function fileExistsInPack(packed: { files: Array<{ path: string }> } | null, pathSubstr: string): boolean {
  if (!packed) return false;
  return packed.files.some(f => f.path.includes(pathSubstr));
}

describe('npm pack content invariants', () => {
  it('@ruflo/kernel ships README + LICENSE + dist/', async () => {
    const dir = join(PACKAGES_DIR, 'kernel-js');
    if (!existsSync(join(dir, 'package.json'))) return;
    const packed = await packList(dir);
    expect(packed, '@ruflo/kernel pack failed').not.toBeNull();
    expect(packed!.name).toBe('@ruflo/kernel');
    expect(fileExistsInPack(packed, 'README')).toBe(true);
    expect(fileExistsInPack(packed, 'LICENSE')).toBe(true);
    expect(fileExistsInPack(packed, 'dist/'), '@ruflo/kernel missing dist/').toBe(true);
  }, 30_000);

  it('every host adapter ships README + LICENSE + dist/', async () => {
    const hosts = ['host-claude-code', 'host-codex', 'host-pi-dev', 'host-hermes', 'host-openclaw', 'host-rvm'];
    for (const h of hosts) {
      const dir = join(PACKAGES_DIR, h);
      if (!existsSync(join(dir, 'package.json'))) continue;
      const packed = await packList(dir);
      expect(packed, `${h} pack failed`).not.toBeNull();
      expect(packed!.name).toBe(`@ruflo/${h}`);
      expect(fileExistsInPack(packed, 'README'), `${h} missing README`).toBe(true);
      expect(fileExistsInPack(packed, 'LICENSE'), `${h} missing LICENSE`).toBe(true);
      expect(fileExistsInPack(packed, 'dist/'), `${h} missing dist/`).toBe(true);
    }
  }, 120_000);

  it('metaharness (in packages/create-agent-harness/) ships dist/ + templates/ + the bin entrypoints', async () => {
    // The workspace folder is still named create-agent-harness; the package
    // was renamed to `metaharness` at publish (iter 124). The folder rename
    // is tracked separately — assert the PUBLISHED name here.
    const dir = join(PACKAGES_DIR, 'create-agent-harness');
    const packed = await packList(dir);
    expect(packed).not.toBeNull();
    expect(packed!.name).toBe('metaharness');
    expect(fileExistsInPack(packed, 'dist/'), 'missing dist/').toBe(true);
    expect(fileExistsInPack(packed, 'templates/'), 'missing templates/').toBe(true);
    expect(fileExistsInPack(packed, 'dist/bin.js'), 'missing dist/bin.js (create-agent-harness binary)').toBe(true);
    expect(fileExistsInPack(packed, 'dist/harness-bin.js'), 'missing dist/harness-bin.js (harness binary)').toBe(true);
  }, 30_000);

  it('vertical packs ship dist/ + manifest.json + README + LICENSE', async () => {
    const verticals = ['vertical-base', 'vertical-trading'];
    for (const v of verticals) {
      const dir = join(PACKAGES_DIR, v);
      if (!existsSync(join(dir, 'package.json'))) continue;
      const packed = await packList(dir);
      expect(packed, `${v} pack failed`).not.toBeNull();
      expect(packed!.name).toBe(`@ruflo/${v}`);
      expect(fileExistsInPack(packed, 'dist/'), `${v} missing dist/`).toBe(true);
      // iter 63: preflight failed because @ruflo/vertical-base shipped without
      // a README. Pin this invariant so the publish gate catches it before
      // we hit the actual `npm publish` call.
      expect(fileExistsInPack(packed, 'README'), `${v} missing README`).toBe(true);
      expect(fileExistsInPack(packed, 'LICENSE'), `${v} missing LICENSE`).toBe(true);
    }
  }, 60_000);

  it('@ruflo/sdk ships dist/ + README', async () => {
    const dir = join(PACKAGES_DIR, 'sdk');
    if (!existsSync(join(dir, 'package.json'))) return;
    const packed = await packList(dir);
    expect(packed).not.toBeNull();
    expect(packed!.name).toBe('@ruflo/sdk');
    expect(fileExistsInPack(packed, 'dist/')).toBe(true);
    expect(fileExistsInPack(packed, 'README')).toBe(true);
  }, 30_000);

  it('NO package leaks .env, node_modules, or tsconfig.tsbuildinfo', async () => {
    const entries = await import('node:fs/promises').then(m => m.readdir(PACKAGES_DIR, { withFileTypes: true }));
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = join(PACKAGES_DIR, ent.name);
      if (!existsSync(join(dir, 'package.json'))) continue;
      const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'package.json'), 'utf-8'));
      if (pkg.private === true) continue;
      const packed = await packList(dir);
      if (!packed) continue;
      const banned = ['.env', 'node_modules', '.tsbuildinfo', '.DS_Store'];
      for (const b of banned) {
        const leak = packed.files.find(f => f.path.includes(b));
        expect(leak, `${pkg.name} leaks ${b}: ${leak?.path}`).toBeUndefined();
      }
    }
  }, 180_000);
});
