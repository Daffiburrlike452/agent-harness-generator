#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/version-bump.mjs — bump version across all 11+ publishable
// packages atomically, plus the root, in lockstep.
//
// Why: preflight.mjs already validates that all packages share a version
// (cross-pack drift detector). When you bump, you have to hit EVERY
// `package.json` in the same commit or preflight refuses to greenlight
// the tag. This script does that bump deterministically.
//
// Usage:
//   node scripts/version-bump.mjs patch
//   node scripts/version-bump.mjs minor
//   node scripts/version-bump.mjs major
//   node scripts/version-bump.mjs 0.2.0           # explicit version
//   node scripts/version-bump.mjs patch --dry-run # no writes, just report
//
// Side effect: also bumps `.claude-plugin/plugin.json` and the
// `crates/*/Cargo.toml` workspace package.version, so the witness
// manifest + marketplace entry + Rust crates all match.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');
const PLUGIN_PATH = join(ROOT, '.claude-plugin', 'plugin.json');
const WORKSPACE_CARGO = join(ROOT, 'Cargo.toml');

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--')) ?? 'patch';
const DRY_RUN = args.includes('--dry-run');

function log(tag, msg) { process.stderr.write(`[version-bump] ${tag}: ${msg}\n`); }

function bumpSemver(current, kind) {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) throw new Error(`unparseable semver: ${current}`);
  const [, ma, mi, pa] = m.map(Number);
  if (kind === 'patch') return `${ma}.${mi}.${pa + 1}`;
  if (kind === 'minor') return `${ma}.${mi + 1}.0`;
  if (kind === 'major') return `${ma + 1}.0.0`;
  if (/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(kind)) return kind;
  throw new Error(`unknown bump kind: ${kind}`);
}

async function bumpJson(path, newVersion, label) {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  const pkg = JSON.parse(raw);
  if (!pkg.version) return null;
  const old = pkg.version;
  pkg.version = newVersion;
  // Keep workspace deps pinned to the new version.
  for (const depBlock of ['dependencies', 'peerDependencies', 'devDependencies']) {
    if (!pkg[depBlock]) continue;
    for (const dep of Object.keys(pkg[depBlock])) {
      if (dep.startsWith('@metaharness/') || dep === 'create-agent-harness') {
        if (pkg[depBlock][dep] === old) pkg[depBlock][dep] = newVersion;
      }
    }
  }
  if (!DRY_RUN) {
    await writeFile(path, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  }
  log('PASS', `${label}: ${old} -> ${newVersion}`);
  return { old, new: newVersion };
}

async function bumpCargo(path, newVersion) {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  const re = /^(\[workspace\.package\][\s\S]*?\bversion\s*=\s*)"(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)"/m;
  const m = raw.match(re);
  if (!m) {
    log('WARN', `Cargo.toml has no [workspace.package].version — skipped`);
    return null;
  }
  const old = m[2];
  const next = raw.replace(re, `$1"${newVersion}"`);
  if (!DRY_RUN) await writeFile(path, next, 'utf-8');
  log('PASS', `Cargo.toml workspace: ${old} -> ${newVersion}`);
  return { old, new: newVersion };
}

async function main() {
  const rootPkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
  const currentVersion = rootPkg.version;
  const newVersion = bumpSemver(currentVersion, target);

  log('INFO', `${DRY_RUN ? 'DRY-RUN: ' : ''}bumping ${currentVersion} -> ${newVersion}`);

  // 1. Root package.json
  await bumpJson(join(ROOT, 'package.json'), newVersion, 'root');

  // 2. Every workspace package
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const pkgPath = join(PACKAGES_DIR, ent.name, 'package.json');
    await bumpJson(pkgPath, newVersion, `packages/${ent.name}`);
  }

  // 3. Marketplace plugin.json
  await bumpJson(PLUGIN_PATH, newVersion, '.claude-plugin/plugin.json');

  // 4. Cargo workspace
  await bumpCargo(WORKSPACE_CARGO, newVersion);

  log('INFO', DRY_RUN ? 'DRY-RUN complete — no files changed' : 'ALL VERSIONS BUMPED');
  if (!DRY_RUN) {
    log('INFO', 'Next: `node scripts/preflight.mjs` then `git tag v' + newVersion + '` then push');
  }
  process.exit(0);
}

main().catch(err => {
  log('FAIL', err?.message ?? err);
  process.exit(1);
});
