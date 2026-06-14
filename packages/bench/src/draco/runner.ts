// SPDX-License-Identifier: MIT
//
// DRACO M3/M4 — the runner (ADR-037 §4).
//
// Drives the fusion harness over the corpus, scores each answer with the
// deterministic scorer (M3), and OPTIONALLY adds the LLM-judge faithfulness
// dimension (M4). Fully offline-capable: pass a mock transport + mock URL
// checker (+ optional mock judge transport) and the whole run executes with
// zero network.
//
// HONESTY NOTE: a run with a MOCK transport produces a MACHINERY baseline —
// it proves the scorer + runner work end-to-end and emit a well-formed proof
// JSON. The numbers are NOT a quality measurement of the real research harness;
// that requires a live OPENROUTER_API_KEY (GCP-secret-gated). The report records
// `transport: "mock" | "live"` + `judged: boolean` so a baseline can never be
// mistaken for a real judged score.

import type { OpenRouterTransport, FusionModelMap } from './fusion.js';
import { fuseResearch, DEFAULT_FUSION_MODELS } from './fusion.js';
import type { Rubric, UrlChecker, DimensionScores } from './scorer.js';
import { scoreAnswer } from './scorer.js';
import { judgeFaithfulness, assertJudgeIndependent, DRACO_JUDGE } from './judge.js';

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
  /** Present only on a judged run (M4): the LLM-judge faithfulness score. */
  faithfulness?: number;
}

export interface DracoRunReport {
  corpusVersion: number;
  transport: 'mock' | 'live';
  fusionModels: FusionModelMap;
  /** true → faithfulness (M4) IS folded into each question's mean. */
  judged: boolean;
  judge?: { model: string; promptVersion: number };
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
  /**
   * Optional LLM-judge transport (M4). When provided, faithfulness is scored
   * per question and FOLDED INTO the quality mean (5 dimensions), and the
   * report is marked judged:true. The judge model must be independent of the
   * harness (assertJudgeIndependent) — enforced before any call.
   */
  judgeTransport?: OpenRouterTransport;
  judgeModel?: string;
  /** Only run questions in this domain (optional filter). */
  domain?: string;
  /** Cap the number of questions (optional). */
  limit?: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Run DRACO over a corpus. Returns the proof report. Pure w.r.t. transport +
 * URL checker (+ optional judge transport) — all injected — so it runs offline.
 *
 * Deterministic subset (M3) when no judgeTransport; judged (M4) when present.
 */
export async function runDraco(corpus: DracoCorpus, opts: RunOptions): Promise<DracoRunReport> {
  const models = opts.models ?? DEFAULT_FUSION_MODELS;
  const judged = !!opts.judgeTransport;
  const judgeModel = opts.judgeModel ?? DRACO_JUDGE.model;
  if (judged) assertJudgeIndependent(judgeModel, models); // fail before any call

  let questions = corpus.questions;
  if (opts.domain) questions = questions.filter((q) => q.domain === opts.domain);
  if (opts.limit != null) questions = questions.slice(0, opts.limit);

  const perQuestion: PerQuestionResult[] = [];
  for (const q of questions) {
    const fused = await fuseResearch({ id: q.id, prompt: q.prompt }, models, opts.transport);
    const dims = await scoreAnswer(fused.answer, q.rubric, q.prompt, opts.checkUrl);
    let tokens = fused.totalTokens;
    let row: PerQuestionResult = { id: q.id, domain: q.domain, tokens, ...dims };

    if (judged && opts.judgeTransport) {
      const { faithfulness, tokens: judgeTokens } = await judgeFaithfulness(
        fused.answer,
        opts.judgeTransport,
        judgeModel,
      );
      tokens += judgeTokens;
      // Fold faithfulness into the mean → 5 dimensions.
      const fiveMean = (dims.grounding + dims.coverage + dims.balance + dims.cleanliness + faithfulness) / 5;
      row = { ...row, tokens, faithfulness, mean: fiveMean };
    }
    perQuestion.push(row);
  }

  const perDomain: Record<string, number> = {};
  for (const r of perQuestion) (perDomain[r.domain] ??= 0);
  for (const domain of Object.keys(perDomain)) {
    perDomain[domain] = mean(perQuestion.filter((r) => r.domain === domain).map((r) => r.mean));
  }

  return {
    corpusVersion: corpus.version,
    transport: opts.transportKind,
    fusionModels: models,
    judged,
    ...(judged ? { judge: { model: judgeModel, promptVersion: DRACO_JUDGE.promptVersion } } : {}),
    score: mean(perQuestion.map((r) => r.mean)),
    perDomain,
    perQuestion,
    efficiency: {
      totalTokens: perQuestion.reduce((s, r) => s + r.tokens, 0),
      questions: perQuestion.length,
    },
  };
}
