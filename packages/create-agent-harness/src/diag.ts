// SPDX-License-Identifier: MIT
//
// `harness diag` — single-question diagnostic: is the LOCAL @ruflo/kernel
// compatible with the version this harness was scaffolded against?
//
// Surfaces:
//   - manifest.meta.surface     (iter 56) — which surface produced it (cli/web-ui)
//   - manifest.meta.kernel_version (iter 58) — the version the scaffold was built against
//   - the locally-installed @ruflo/kernel version (resolved at runtime)
//   - drift verdict and actionable next step
//
// Why split this out of `harness doctor`?
//   doctor is the generic smoke check (does .harness/ exist? is the
//   manifest hash intact?). diag is the ONE cross-machine question
//   that almost every "support ticket" turns out to be — and the
//   answer needs to be loud, single-line, and copy-pasteable so users
//   can act on it without reading every doctor line.

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Mirror of subcommands.ts's exported shape — kept local to avoid a
 *  cyclic import (subcommands.ts imports from diag.ts via diagCmd). */
export type SubcommandResult = { code: number; lines: string[] };

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse "X.Y.Z[-pre]" into a tuple. Returns null on unrecognised input
 * (e.g. "git+ssh://..." or "*"). We only need the major/minor/patch ints
 * for the skew verdict; pre-release suffixes are ignored.
 */
function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** Compute the skew verdict between two semvers. */
export type SkewVerdict = 'match' | 'patch-diff' | 'minor-diff' | 'major-diff' | 'unparseable';

export function skewVerdict(manifestVer: string | undefined, localVer: string | undefined): SkewVerdict {
  if (!manifestVer || !localVer) return 'unparseable';
  const m = parseSemver(manifestVer);
  const l = parseSemver(localVer);
  if (!m || !l) return 'unparseable';
  if (m.major !== l.major) return 'major-diff';
  if (m.minor !== l.minor) return 'minor-diff';
  if (m.patch !== l.patch) return 'patch-diff';
  return 'match';
}

/**
 * Resolve the locally-installed @ruflo/kernel version. Uses createRequire
 * so it follows real Node resolution from the harness's package.json. We
 * never throw — a missing kernel is the WHOLE POINT of this diagnostic
 * (it gets reported as such).
 */
function resolveLocalKernelVersion(harnessDir: string): string | undefined {
  try {
    const require = createRequire(join(harnessDir, 'package.json'));
    const pkgPath = require.resolve('@ruflo/kernel/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    // Fall back to the workspace's kernel package if running uninstalled
    // (e.g. dev work inside the monorepo before publish).
    const wsPath = resolve(__dirname, '..', '..', 'kernel-js', 'package.json');
    if (existsSync(wsPath)) {
      try {
        const pkg = JSON.parse(readFileSync(wsPath, 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * iter 71: resolve the version of create-agent-harness this process is
 * running from. Used to compare against `manifest.generator`. Falls
 * through the same 3-path lookup as the kernel resolver: workspace
 * checkout, installed sibling, top-level node_modules.
 */
function resolveLocalGeneratorVersion(): string | undefined {
  const candidates = [
    // Workspace: packages/create-agent-harness/dist/ → ../package.json
    resolve(__dirname, '..', 'package.json'),
    // Installed: node_modules/create-agent-harness/package.json
    resolve(__dirname, '..', '..', 'create-agent-harness', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name === 'create-agent-harness' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export interface DiagReport {
  dir: string;
  surface: string | undefined;
  manifestKernelVersion: string | undefined;
  localKernelVersion: string | undefined;
  verdict: SkewVerdict;
  actionable: string | undefined;
  // iter 71: also surface generator-version skew. The manifest's
  // `generator` field records the create-agent-harness version at
  // scaffold time. If the user installed a newer create-agent-harness
  // since, `harness upgrade` may produce different output than they'd
  // expect — that's exactly the kind of cross-machine surprise diag is
  // designed to surface.
  manifestGeneratorVersion: string | undefined;
  localGeneratorVersion: string | undefined;
  generatorVerdict: SkewVerdict;
}

export async function buildDiagReport(harnessDir: string): Promise<DiagReport> {
  const manifestPath = join(harnessDir, '.harness', 'manifest.json');
  let surface: string | undefined;
  let manifestKernelVersion: string | undefined;
  let manifestGeneratorVersion: string | undefined;
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(await readFile(manifestPath, 'utf-8'));
      surface = m.meta?.surface;
      manifestKernelVersion = m.meta?.kernel_version;
      // iter 71: manifest.generator is the top-level field stamped by
      // emptyManifest() — predates the meta block, present in every
      // scaffold from iter 4 onward.
      manifestGeneratorVersion = typeof m.generator === 'string' ? m.generator : undefined;
    } catch {
      /* leave both undefined */
    }
  }
  const localKernelVersion = resolveLocalKernelVersion(harnessDir);
  const verdict = skewVerdict(manifestKernelVersion, localKernelVersion);
  const localGeneratorVersion = resolveLocalGeneratorVersion();
  const generatorVerdict = skewVerdict(manifestGeneratorVersion, localGeneratorVersion);
  let actionable: string | undefined;
  if (verdict === 'major-diff') {
    actionable = `Run: npm install @ruflo/kernel@${manifestKernelVersion} (major skew — APIs may break)`;
  } else if (verdict === 'minor-diff') {
    actionable = `Run: npm install @ruflo/kernel@${manifestKernelVersion} (minor skew — new features may be missing)`;
  } else if (verdict === 'patch-diff') {
    actionable = `Optional: npm install @ruflo/kernel@${manifestKernelVersion} (patch skew — usually safe)`;
  } else if (verdict === 'unparseable' && manifestKernelVersion && !localKernelVersion) {
    actionable = `Run: npm install @ruflo/kernel@${manifestKernelVersion} (kernel not installed locally)`;
  }
  return {
    dir: harnessDir,
    surface,
    manifestKernelVersion,
    localKernelVersion,
    verdict,
    actionable,
    manifestGeneratorVersion,
    localGeneratorVersion,
    generatorVerdict,
  };
}

/**
 * Format a diag report for human reading. Returns the lines + an exit
 * code suitable for the CLI: 0 on match/patch, 1 on minor/major, 2 if
 * the manifest is missing entirely.
 */
export function formatDiagReport(report: DiagReport): SubcommandResult {
  const lines: string[] = [];
  lines.push(`harness diag — checking ${report.dir}`);
  lines.push('');
  if (!report.manifestKernelVersion && !existsSync(join(report.dir, '.harness', 'manifest.json'))) {
    lines.push('  FAIL no .harness/manifest.json found at this path');
    lines.push('       (this directory is not a scaffolded harness — run harness diag from a harness root)');
    return { code: 2, lines };
  }
  lines.push(`  surface:              ${report.surface ?? '(unknown — pre-iter-56 manifest)'}`);
  lines.push(`  manifest kernel:      ${report.manifestKernelVersion ?? '(unset — pre-iter-58 manifest)'}`);
  lines.push(`  installed kernel:     ${report.localKernelVersion ?? '(not installed)'}`);
  lines.push(`  manifest generator:   ${report.manifestGeneratorVersion ?? '(unset)'}`);
  lines.push(`  installed generator:  ${report.localGeneratorVersion ?? '(not installed)'}`);
  lines.push('');
  const tag: Record<SkewVerdict, string> = {
    'match':         'PASS',
    'patch-diff':    'WARN',
    'minor-diff':    'WARN',
    'major-diff':    'FAIL',
    'unparseable':   'WARN',
  };
  const blurb: Record<SkewVerdict, string> = {
    'match':         'kernel versions match exactly',
    'patch-diff':    'patch-level skew (usually safe; may include bugfixes)',
    'minor-diff':    'minor-level skew (new kernel features may be missing)',
    'major-diff':    'MAJOR skew — APIs may have changed; expect breakage',
    'unparseable':   'could not parse one or both kernel versions',
  };
  lines.push(`  ${tag[report.verdict]} ${blurb[report.verdict]}`);
  // iter 71: generator-skew is informational — never fails. The
  // generator can change without the harness becoming incompatible
  // (templates evolve, but the *generated* harness is self-contained).
  // Surfacing it just lets `harness upgrade` users predict whether
  // they'll see new template files after re-run.
  const genBlurb: Record<SkewVerdict, string> = {
    'match':         'generator versions match exactly',
    'patch-diff':    'patch-level generator skew (template fixes since this scaffold)',
    'minor-diff':    'minor-level generator skew (new template features available)',
    'major-diff':    'MAJOR generator skew (template may have moved — re-run `harness upgrade` to preview drift)',
    'unparseable':   'generator version unknown',
  };
  const genTag: Record<SkewVerdict, string> = {
    'match':         'PASS',
    'patch-diff':    'INFO',
    'minor-diff':    'INFO',
    'major-diff':    'WARN',
    'unparseable':   'INFO',
  };
  lines.push(`  ${genTag[report.generatorVerdict]} ${genBlurb[report.generatorVerdict]}`);
  if (report.actionable) {
    lines.push('');
    lines.push(`  → ${report.actionable}`);
  }
  // Exit codes:
  //   0 — match (always)
  //   0 — patch-diff (informational)
  //   1 — minor-diff or major-diff (action needed)
  //   1 — unparseable when manifest version is set but local isn't
  // generatorVerdict NEVER fails — it's informational only.
  let code = 0;
  if (report.verdict === 'minor-diff' || report.verdict === 'major-diff') code = 1;
  if (report.verdict === 'unparseable' && report.manifestKernelVersion && !report.localKernelVersion) code = 1;
  return { code, lines };
}

/**
 * Format a report as JSON for programmatic consumers. Includes the full
 * report shape + the resolved exit code (delegated to formatDiagReport
 * so the verdict-to-exit-code mapping has exactly ONE definition) so
 * callers can gate on either the structured data or the exit code.
 */
export function formatDiagReportJson(report: DiagReport): SubcommandResult {
  const human = formatDiagReport(report);
  return {
    code: human.code,
    lines: [
      JSON.stringify({ ...report, exitCode: human.code }, null, 2),
    ],
  };
}

export async function diagCmd(args: string[]): Promise<SubcommandResult> {
  // iter 73: --json emits machine-readable output. Useful for CI
  // scripts that want to gate on the structured verdict rather than
  // parsing the human text.
  const json = args.includes('--json');
  const positional = args.filter(a => !a.startsWith('--'));
  const dir = resolve(positional[0] ?? process.cwd());
  const report = await buildDiagReport(dir);
  return json ? formatDiagReportJson(report) : formatDiagReport(report);
}
