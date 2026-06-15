// SPDX-License-Identifier: MIT
//
// ADR-041 scorecard — `metaharness score <repo>`. The killer feature: point it
// at a repo and get a 6-line scorecard (harness fit, compile confidence, task
// coverage, tool safety, memory usefulness, est. $/run + recommended mode).
//
// Reuses the no-exec repo analyzer (analyze-repo.ts): inventory → profile →
// recommendPlan. Every dimension is derived from REAL repo signals, not invented
// — the scorecard's job is to tell the truth about whether a generated harness
// fits this repo and what it would cost, before you scaffold anything.

import { resolve, basename } from 'node:path';
import { inventory, analyzeFiles, recommendPlan, ruvllmSemantic, type HarnessPlan } from './analyze-repo.js';

export type SubcommandResult = { code: number; lines: string[] };

export interface RepoScorecard {
  schema: 1;
  repo: string;
  /** 0-100 each. */
  harnessFit: number;
  compileConfidence: number;
  taskCoverage: number;
  toolSafety: number;
  memoryUsefulness: number;
  /** Estimated USD per harness run (cheap-tier routing, DRACO finding). */
  estCostPerRunUsd: number;
  recommendedMode: 'CLI' | 'CLI + MCP';
  archetype: string;
  template: string;
  generatedAt: string;
}

const clamp100 = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Cheap-tier blended $/1M tokens (DRACO: route DRACO-style work to a cheap model). */
const CHEAP_USD_PER_MTOK = 3;
/** Rough per-agent token budget for one harness run (analysis estimate). */
const TOKENS_PER_AGENT = 4000;

/**
 * Build the ADR-041 scorecard for a repo directory. Pure + no-exec (only reads
 * high-signal files via inventory). `generatedAt` is injected for determinism.
 */
export function buildRepoScorecard(dir: string, generatedAt: string = new Date().toISOString()): RepoScorecard {
  const files = inventory(dir);
  // Prefer the package.json name (more meaningful than a temp/checkout dir name);
  // fall back to the directory basename.
  let name = basename(resolve(dir)) || 'repo';
  try {
    const pkgName = files['package.json'] ? (JSON.parse(files['package.json']) as { name?: string }).name : undefined;
    if (pkgName && pkgName.length > 0) name = pkgName;
  } catch {
    /* keep basename */
  }
  const profile = analyzeFiles(name, files);
  const plan: HarnessPlan = recommendPlan(profile, ruvllmSemantic(profile));

  // Harness fit — how confidently the recommended archetype matches this repo.
  const harnessFit = clamp100(plan.confidence * 100);

  // Compile confidence — signals a generated harness will build/run cleanly:
  // a detected language is the floor; build + test commands + CI raise it.
  const compileConfidence = clamp100(
    (profile.languages.length ? 40 : 12) +
      (profile.buildCommands.length ? 25 : 0) +
      (profile.testCommands.length ? 25 : 0) +
      (profile.hasCi ? 10 : 0),
  );

  // Task coverage — how much inferred work the recommended agents/skills/commands
  // span, tempered by how much repo signal (tokens) we actually observed.
  const surface = plan.agents.length + plan.skills.length + plan.commands.length;
  const taskCoverage = clamp100(Math.min(surface, 10) * 7 + Math.min(profile.tokens.length, 20) * 1.5);

  // Tool safety — the default-deny policy posture, minus MCP exposure.
  const p = plan.policy;
  let safety = 0;
  if (p.defaultDeny) safety += 35;
  if (!p.allowShell) safety += 15;
  if (!p.allowNetwork) safety += 10;
  if (!p.allowFileWrite) safety += 10;
  if (p.requireApprovalForDangerous) safety += 15;
  if (p.auditLog) safety += 15;
  if (plan.mcp === 'remote') safety -= 10; // remote MCP is more attack surface
  const toolSafety = clamp100(safety);

  // Memory usefulness — repo scale: more files / languages / distinct tokens →
  // a persistent memory layer pays off more.
  const fileCount = Object.keys(files).length;
  const memoryUsefulness = clamp100(
    Math.min(fileCount, 30) * 2 + profile.languages.length * 5 + Math.min(profile.tokens.length, 25),
  );

  // Est. $/run — agents × per-agent budget at the cheap tier (DRACO routing).
  const estTokens = (plan.agents.length || 1) * TOKENS_PER_AGENT;
  const estCostPerRunUsd = round3((estTokens / 1_000_000) * CHEAP_USD_PER_MTOK);

  const recommendedMode: RepoScorecard['recommendedMode'] = plan.mcp === 'off' ? 'CLI' : 'CLI + MCP';

  return {
    schema: 1,
    repo: name,
    harnessFit,
    compileConfidence,
    taskCoverage,
    toolSafety,
    memoryUsefulness,
    estCostPerRunUsd,
    recommendedMode,
    archetype: plan.archetypeId,
    template: plan.template,
    generatedAt,
  };
}

/** Format the scorecard as the ADR-041 6-line card. */
export function formatRepoScorecard(sc: RepoScorecard): string[] {
  return [
    `Scorecard — ${sc.repo}  (best-fit archetype: ${sc.archetype})`,
    ``,
    `  Harness fit:        ${sc.harnessFit}/100`,
    `  Compile confidence: ${sc.compileConfidence}/100`,
    `  Task coverage:      ${sc.taskCoverage}/100`,
    `  Tool safety:        ${sc.toolSafety}/100`,
    `  Memory usefulness:  ${sc.memoryUsefulness}/100`,
    `  Est. cost per run:  $${sc.estCostPerRunUsd.toFixed(3)}`,
    `  Recommended mode:   ${sc.recommendedMode}  (template ${sc.template})`,
  ];
}

function usage(): string[] {
  return [
    'Usage: metaharness score <repo-path> [--json]',
    '',
    'Produces the ADR-041 scorecard: harness fit, compile confidence, task',
    'coverage, tool safety, memory usefulness, est. $/run, recommended mode.',
    'No-exec: only reads high-signal files; never runs repo code.',
  ];
}

/** CLI: `metaharness score <repo> [--json]`. Mirrors genomeCmd's shape. */
export async function scoreRepoCmd(args: string[]): Promise<SubcommandResult> {
  const json = args.includes('--json');
  const positional: string[] = [];
  for (const a of args) {
    if (a === '--json') continue;
    if (a === '--help' || a === '-h') return { code: 0, lines: usage() };
    if (a.startsWith('--')) {
      const err = { schema: 1 as const, error: `unknown-flag-${a.replace(/^--?/, '')}`, exitCode: 2 };
      return { code: 2, lines: [json ? JSON.stringify(err, null, 2) : `Unknown flag: ${a}`] };
    }
    positional.push(a);
  }
  if (positional.length === 0) return { code: 2, lines: usage() };

  const dir = resolve(positional[0]!);
  try {
    const sc = buildRepoScorecard(dir);
    return { code: 0, lines: json ? [JSON.stringify(sc, null, 2)] : formatRepoScorecard(sc) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const e = { schema: 1 as const, error: 'score-failed', detail: msg, exitCode: 1 };
    return { code: 1, lines: [json ? JSON.stringify(e, null, 2) : `score failed: ${msg}`] };
  }
}
