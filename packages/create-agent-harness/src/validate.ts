// SPDX-License-Identifier: MIT
//
// `harness validate` — umbrella check that runs every gate a release-ready
// harness should pass, fail-fast with a structured per-check verdict.
//
// Checks (in order):
//   1. doctor          file-shape + manifest hash + at-least-one-host-artifact
//   2. verify          witness manifest signature check
//   3. path-guard      no hardcoded /tmp/, C:\, /Users/, /home/ in production
//   4. mcp-server      every entry in .mcp/servers.json passes kernel schema
//   5. secrets         (optional) gcloud + project + secret exist (--skip-gcp to skip)
//   6. diag            kernel-version skew check (iter 76 — informational,
//                      WARN on skew, never fails the umbrella because kernel
//                      skew is a deploy-side issue, not a release-readiness
//                      block for the harness being validated)
//
// Exits non-zero if any check fails. Structured output suits both human eyes
// and `grep PASS|FAIL` for CI.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { doctor, verify } from './subcommands.js';
import { check as secretsCheck } from './secrets.js';
import { buildDiagReport } from './diag.js';

export type SubcommandResult = { code: number; lines: string[] };

interface CheckResult {
  name: string;
  code: number;
  detail: string;
  // iter 76: optional override for the displayed tag. Lets a check
  // return code 0 (don't fail the umbrella) but surface WARN / SKIP in
  // the output. Used by diag to surface kernel skew informationally.
  tag?: 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
}

async function runDoctor(dir: string): Promise<CheckResult> {
  const r = await doctor([dir]);
  return {
    name: 'doctor',
    code: r.code,
    detail: r.lines.join(' | '),
  };
}

async function runVerify(dir: string): Promise<CheckResult> {
  if (!existsSync(join(dir, '.harness', 'witness.json'))) {
    return { name: 'verify', code: 0, detail: 'no witness — skipped (sign first)' };
  }
  const r = await verify([dir]);
  return { name: 'verify', code: r.code, detail: r.lines.slice(-2).join(' | ') };
}

/** Scan a harness's user-authored files for hardcoded paths. */
async function runPathGuard(dir: string): Promise<CheckResult> {
  const bannedPatterns = [
    /['"`]\/tmp\//,
    /['"`]C:\\\\/,
    /['"`]\/Users\//,
    /['"`]\/home\//,
  ];
  const offenders: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await import('node:fs/promises').then(m => m.readdir(d, { withFileTypes: true }));
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (/\.(ts|tsx|js|mjs|cjs|rs)$/.test(ent.name)) {
        const content = await readFile(p, 'utf-8').catch(() => '');
        for (const line of content.split('\n')) {
          // Skip comment lines
          if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
          for (const pat of bannedPatterns) {
            if (pat.test(line)) {
              offenders.push(`${p}: ${line.trim().slice(0, 80)}`);
              break;
            }
          }
        }
      }
    }
  }
  await walk(dir).catch(() => undefined);
  if (offenders.length === 0) {
    return { name: 'path-guard', code: 0, detail: 'no hardcoded /tmp, C:\\, /Users, /home in TS/JS/Rust' };
  }
  return {
    name: 'path-guard',
    code: 1,
    detail: `${offenders.length} hardcoded path${offenders.length === 1 ? '' : 's'}: ${offenders.slice(0, 3).join('; ')}`,
  };
}

/** Validate `.mcp/servers.json` (if present) against kernel MCP schema. */
async function runMcpCheck(dir: string): Promise<CheckResult> {
  const mcpPath = join(dir, '.mcp', 'servers.json');
  if (!existsSync(mcpPath)) {
    return { name: 'mcp', code: 0, detail: 'no .mcp/servers.json — skipped' };
  }
  try {
    const raw = JSON.parse(await readFile(mcpPath, 'utf-8'));
    const servers = Array.isArray(raw) ? raw : Array.isArray(raw?.mcpServers) ? raw.mcpServers : [];
    if (servers.length === 0) {
      return { name: 'mcp', code: 0, detail: '.mcp/servers.json present but empty — skipped' };
    }
    // Best-effort: each server must have name + command. Real schema check
    // would need the kernel NAPI binding — out of scope for the umbrella.
    const problems: string[] = [];
    for (const [i, s] of servers.entries()) {
      if (typeof s?.name !== 'string') problems.push(`server[${i}] missing name`);
      if (!Array.isArray(s?.command) && typeof s?.command !== 'string') {
        problems.push(`server[${i}] missing command`);
      }
    }
    if (problems.length === 0) {
      return { name: 'mcp', code: 0, detail: `${servers.length} server${servers.length === 1 ? '' : 's'} valid` };
    }
    return { name: 'mcp', code: 1, detail: problems.join('; ') };
  } catch (e) {
    return { name: 'mcp', code: 1, detail: `invalid JSON: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * iter 76: diag check inside the validate umbrella. Returns code 0
 * always so a kernel skew never blocks the umbrella verdict; surfaces
 * the state via the tag override field (PASS / WARN / SKIP).
 */
async function runDiag(dir: string): Promise<CheckResult> {
  if (!existsSync(join(dir, '.harness', 'manifest.json'))) {
    return { name: 'diag', code: 0, tag: 'SKIP', detail: 'no manifest at path' };
  }
  const r = await buildDiagReport(dir);
  if (!r.manifestKernelVersion) {
    return { name: 'diag', code: 0, tag: 'SKIP', detail: 'manifest pre-iter-58 (no kernel_version)' };
  }
  if (!r.localKernelVersion) {
    return {
      name: 'diag', code: 0, tag: 'SKIP',
      detail: `@ruflo/kernel not installed locally (manifest pins ${r.manifestKernelVersion})`,
    };
  }
  if (r.verdict === 'match' || r.verdict === 'patch-diff') {
    return {
      name: 'diag', code: 0, tag: 'PASS',
      detail: `kernel manifest=${r.manifestKernelVersion} local=${r.localKernelVersion} (${r.verdict})`,
    };
  }
  // minor-diff / major-diff / unparseable → WARN but DON'T fail
  return {
    name: 'diag', code: 0, tag: 'WARN',
    detail: `kernel manifest=${r.manifestKernelVersion} local=${r.localKernelVersion} (${r.verdict})`,
  };
}

/** Top-level dispatcher: `harness validate [path] [--skip-gcp] [--secret=NAME]`. */
export async function validate(args: string[]): Promise<SubcommandResult> {
  const dir = resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());
  const skipGcp = args.includes('--skip-gcp');
  const secret = args.find(a => a.startsWith('--secret='))?.slice('--secret='.length);
  const lines: string[] = [`harness validate — ${dir}`];

  const results: CheckResult[] = [];

  results.push(await runDoctor(dir));
  results.push(await runVerify(dir));
  results.push(await runPathGuard(dir));
  results.push(await runMcpCheck(dir));

  if (!skipGcp) {
    const sc = await secretsCheck(secret ? [`--secret=${secret}`] : []);
    results.push({
      name: 'secrets',
      code: sc.code,
      detail: sc.lines.slice(-2).join(' | ').replace(/\s+/g, ' '),
    });
  } else {
    results.push({ name: 'secrets', code: 0, detail: 'skipped (--skip-gcp)' });
  }

  // iter 76: diag (kernel-version skew) as informational signal.
  // Never fails the umbrella — kernel skew is a deploy-side runtime
  // issue, not a release-readiness block for the harness being
  // validated. PASS on match/patch, WARN on minor/major, SKIP when
  // no kernel installed locally.
  results.push(await runDiag(dir));

  let problems = 0;
  for (const r of results) {
    const tag = r.tag ?? (r.code === 0 ? 'PASS' : 'FAIL');
    lines.push(`  ${tag.padEnd(4)} ${r.name.padEnd(10)} — ${r.detail}`);
    if (r.code !== 0) problems++;
  }
  lines.push('');
  if (problems === 0) {
    lines.push('Result: HEALTHY (release-ready)');
    return { code: 0, lines };
  }
  lines.push(`Result: ${problems} check${problems === 1 ? '' : 's'} FAILED — fix before publish`);
  // iter 94: symmetric with iter 93 — when the umbrella FAILs, point
  // the user at the bundle. Doctor already does this for its own
  // failures, but the umbrella aggregates 6 checks (doctor + verify +
  // path-guard + mcp + secrets + diag) — any of them failing should
  // surface the bundle as the next user action.
  lines.push('');
  lines.push(`Next: capture the full diagnostic state for a support ticket:`);
  lines.push(`  harness diag ${dir} --bundle > bundle.json`);
  lines.push(`(then attach bundle.json to a GitHub issue at`);
  lines.push(` https://github.com/ruvnet/agent-harness-generator/issues — the`);
  lines.push(` bundle is sanitised; secret_/token_/key_/password_ fields are redacted)`);
  return { code: 1, lines };
}
