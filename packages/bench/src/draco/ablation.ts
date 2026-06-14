// SPDX-License-Identifier: MIT
//
// DRACO M6 — the fusion-vs-single ablation (ADR-037 §M6, "the proof").
//
// Runs the SAME corpus through two arms with the SAME injected transports:
//   - single: one strong model, end to end (DRACO_SINGLE_MODEL) — the baseline.
//   - fusion: the DRACO-optimised harness (DRACO_OPTIMIZED_MODELS) — independent
//             verifier (different family) + optional independent judge.
// Both are scored by the identical DRACO scorer, so the delta is attributable to
// the ARCHITECTURE, not the score function. The claim "beyond SOTA" is then a
// MEASURED delta — `fusionWins` is true only if fusion's mean score strictly
// exceeds single's. Fully offline: pass mock transports.

import type { OpenRouterTransport } from './fusion.js';
import { fuseResearch } from './fusion.js';
import type { UrlChecker } from './scorer.js';
import { scoreAnswer, type DimensionScores } from './scorer.js';
import { judgeFaithfulness, assertJudgeIndependent, DRACO_JUDGE } from './judge.js';
import {
  DRACO_OPTIMIZED_MODELS,
  DRACO_SINGLE_MODEL,
  singleModelResearch,
} from './optimized.js';
import type { DracoCorpus } from './runner.js';

export interface ArmResult {
  arm: 'single' | 'fusion';
  score: number; // mean quality across questions
  perDimension: { grounding: number; coverage: number; balance: number; cleanliness: number; faithfulness?: number };
  totalTokens: number;
}

export interface AblationReport {
  corpusVersion: number;
  transport: 'mock' | 'live';
  judged: boolean;
  judge?: { model: string; promptVersion: number };
  single: ArmResult;
  fusion: ArmResult;
  /** fusion.score − single.score. Positive → fusion wins. */
  delta: number;
  /** The dimensions that drove the delta (fusion − single per dimension). */
  deltaByDimension: { grounding: number; coverage: number; balance: number; cleanliness: number; faithfulness?: number };
  fusionWins: boolean;
}

export interface AblationOptions {
  /** Transport used for BOTH arms (fair comparison). */
  transport: OpenRouterTransport;
  transportKind: 'mock' | 'live';
  checkUrl: UrlChecker;
  /** Optional independent judge (folds faithfulness into both arms' scores). */
  judgeTransport?: OpenRouterTransport;
  judgeModel?: string;
  singleModel?: string;
  limit?: number;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

function avgDims(rows: DimensionScores[], faith: number[] | null) {
  const base = {
    grounding: mean(rows.map((r) => r.grounding)),
    coverage: mean(rows.map((r) => r.coverage)),
    balance: mean(rows.map((r) => r.balance)),
    cleanliness: mean(rows.map((r) => r.cleanliness)),
  };
  return faith ? { ...base, faithfulness: mean(faith) } : base;
}

/**
 * Run the ablation. Returns a report whose `fusionWins` is a MEASURED claim:
 * true iff the optimised fusion harness scores strictly higher than the
 * single-model baseline on the same corpus + scorer.
 */
export async function runAblation(corpus: DracoCorpus, opts: AblationOptions): Promise<AblationReport> {
  const judged = !!opts.judgeTransport;
  const judgeModel = opts.judgeModel ?? DRACO_JUDGE.model;
  if (judged) assertJudgeIndependent(judgeModel, DRACO_OPTIMIZED_MODELS);
  const singleModel = opts.singleModel ?? DRACO_SINGLE_MODEL;

  let questions = corpus.questions;
  if (opts.limit != null) questions = questions.slice(0, opts.limit);

  const singleDims: DimensionScores[] = [];
  const fusionDims: DimensionScores[] = [];
  const singleFaith: number[] = [];
  const fusionFaith: number[] = [];
  let singleTokens = 0;
  let fusionTokens = 0;

  const scoreOne = async (answer: string, q: typeof questions[number]) => {
    const dims = await scoreAnswer(answer, q.rubric, q.prompt, opts.checkUrl);
    let faith: number | undefined;
    if (judged && opts.judgeTransport) {
      const j = await judgeFaithfulness(answer, opts.judgeTransport, judgeModel);
      faith = j.faithfulness;
    }
    return { dims, faith };
  };

  for (const q of questions) {
    // single arm
    const single = await singleModelResearch({ id: q.id, prompt: q.prompt }, singleModel, opts.transport);
    singleTokens += single.totalTokens;
    const s = await scoreOne(single.answer, q);
    singleDims.push(s.dims);
    if (s.faith != null) singleFaith.push(s.faith);

    // fusion arm
    const fused = await fuseResearch({ id: q.id, prompt: q.prompt }, DRACO_OPTIMIZED_MODELS, opts.transport);
    fusionTokens += fused.totalTokens;
    const f = await scoreOne(fused.answer, q);
    fusionDims.push(f.dims);
    if (f.faith != null) fusionFaith.push(f.faith);
  }

  const meanOf = (dims: DimensionScores[], faith: number[]) => {
    const perQ = dims.map((d, i) => {
      const vals = [d.grounding, d.coverage, d.balance, d.cleanliness];
      if (judged) vals.push(faith[i] ?? 0);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    });
    return mean(perQ);
  };

  const singleScore = meanOf(singleDims, singleFaith);
  const fusionScore = meanOf(fusionDims, fusionFaith);
  const sd = avgDims(singleDims, judged ? singleFaith : null);
  const fd = avgDims(fusionDims, judged ? fusionFaith : null);

  const deltaByDimension = {
    grounding: fd.grounding - sd.grounding,
    coverage: fd.coverage - sd.coverage,
    balance: fd.balance - sd.balance,
    cleanliness: fd.cleanliness - sd.cleanliness,
    ...(judged ? { faithfulness: (fd as { faithfulness: number }).faithfulness - (sd as { faithfulness: number }).faithfulness } : {}),
  };

  return {
    corpusVersion: corpus.version,
    transport: opts.transportKind,
    judged,
    ...(judged ? { judge: { model: judgeModel, promptVersion: DRACO_JUDGE.promptVersion } } : {}),
    single: { arm: 'single', score: singleScore, perDimension: sd, totalTokens: singleTokens },
    fusion: { arm: 'fusion', score: fusionScore, perDimension: fd, totalTokens: fusionTokens },
    delta: fusionScore - singleScore,
    deltaByDimension,
    fusionWins: fusionScore > singleScore,
  };
}
