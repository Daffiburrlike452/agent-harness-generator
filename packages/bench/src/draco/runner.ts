// SPDX-License-Identifier: MIT
//
// DRACO M3 — the --no-judge runner (ADR-037 §4).
//
// Drives the fusion harness over the corpus, scores each answer with the
// deterministic scorer, and produces the proof JSON. This is the
// DETERMINISTIC subset — it does NOT run the LLM-judge faithfulness dimension
// (that's M4). It is fully offline-capable: pass a mock transport + mock URL
// checker and the whole run executes with zero network.
//
// HONESTY NOTE: a run with a MOCK transport produces a MACHINERY baseline —
// it proves the scorer + runner work end-to-end and emit a well-formed proof
// JSON. The numbers are NOT a quality measurement of the real research harness;
// that requires a live OPENROUTER_API_KEY (GCP-secret-gated) and lands in M5's
// CI cadence. The runReport records `transport: "mock" | "live"` so a baseline
// can never be mistaken for a real score.

import type { OpenRouterTransport, FusionModelMap } from './fusion.js';
import { fuseResearch, DEFAULT_FUSION_MODELS } from './fusion.js';
import type { Rubric, UrlChecker, DimensionScores } from './scorer.js';
import { scoreAnswer } from './scorer.js';

export interface DracoQuestion {
  id: string;
  domain: string;
  prompt: string;
  rubric: Rubric;
}

export interface DracoCorpus {
  version: number;
  questions: DracoQuestion[];
}

export interface PerQuestionResult extends DimensionScores {
  id: string;
  domain: string;
  tokens: number;
}

export interface DracoRunReport {
  corpusVersion: number;
  transport: 'mock' | 'live';
  fusionModels: FusionModelMap;
  judged: false; // --no-judge: faithfulness (M4) NOT included
  score: number; // mean of per-question quality means
  perDomain: Record<string, number>;
  perQuestion: PerQuestionResult[];
  efficiency: { totalTokens: number; questions: number };
}

export interface RunOptions {
  transport: OpenRouterTransport;
  transportKind: 'mock' | 'live';
  checkUrl: UrlChecker;
  models?: FusionModelMap;
  /** Only run questions in this domain (optional filter). */
  domain?: string;
  /** Cap the number of questions (optional). */
  limit?: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Run DRACO (deterministic subset) over a corpus. Returns the proof report.
 * Pure w.r.t. transport + URL checker — both injected — so it runs offline.
 */
export async function runDraco(corpus: DracoCorpus, opts: RunOptions): Promise<DracoRunReport> {
  const models = opts.models ?? DEFAULT_FUSION_MODELS;
  let questions = corpus.questions;
  if (opts.domain) questions = questions.filter((q) => q.domain === opts.domain);
  if (opts.limit != null) questions = questions.slice(0, opts.limit);

  const perQuestion: PerQuestionResult[] = [];
  for (const q of questions) {
    const fused = await fuseResearch({ id: q.id, prompt: q.prompt }, models, opts.transport);
    const dims = await scoreAnswer(fused.answer, q.rubric, q.prompt, opts.checkUrl);
    perQuestion.push({ id: q.id, domain: q.domain, tokens: fused.totalTokens, ...dims });
  }

  const perDomain: Record<string, number> = {};
  for (const r of perQuestion) {
    (perDomain[r.domain] ??= 0);
  }
  for (const domain of Object.keys(perDomain)) {
    perDomain[domain] = mean(perQuestion.filter((r) => r.domain === domain).map((r) => r.mean));
  }

  return {
    corpusVersion: corpus.version,
    transport: opts.transportKind,
    fusionModels: models,
    judged: false,
    score: mean(perQuestion.map((r) => r.mean)),
    perDomain,
    perQuestion,
    efficiency: {
      totalTokens: perQuestion.reduce((s, r) => s + r.tokens, 0),
      questions: perQuestion.length,
    },
  };
}
