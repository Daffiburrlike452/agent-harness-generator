// SPDX-License-Identifier: MIT
//
// DRACO M6 — the OPTIMIZED research harness + the single-model baseline to beat.
//
// "Push beyond SOTA" means: a research harness TUNED for the DRACO rubric that
// measurably beats a strong single model run end-to-end on the SAME corpus.
// The win is not a bigger model — it's the FUSION ARCHITECTURE:
//
//   single-model end-to-end:  one model synthesises AND self-checks. A model
//     that hallucinates a citation passes its own work — its blind spot ships.
//
//   optimised fusion:  an INDEPENDENT verifier (different model family) checks
//     every load-bearing claim against its cited source, the synthesis is
//     re-folded to DROP unsupported claims + unconfirmable citations, and an
//     independent JUDGE (a third family) scores faithfulness. A blind spot in
//     one family is caught by another.
//
// On the DRACO scorer this shows up as higher GROUNDING (fabricated citations
// removed) and higher FAITHFULNESS (unsupported claims dropped) — the two
// dimensions a single model cannot self-correct. That is the beyond-SOTA claim,
// and the ablation (ablation.ts) MEASURES it rather than asserting it.

import type { FusionModelMap, OpenRouterTransport, ChatMessage } from './fusion.js';

/**
 * The DRACO-optimised fusion model map. Each stage gets the cheapest model that
 * clears the bar for that stage; the load-bearing stages (synthesize, verify)
 * get strong models of DIFFERENT families; the judge (ablation) is a third
 * family. This is the configuration the M6 ablation runs as the "fusion" arm.
 */
export const DRACO_OPTIMIZED_MODELS: FusionModelMap = {
  decompose: 'anthropic/claude-haiku-4',
  search: 'anthropic/claude-haiku-4',
  grade: 'anthropic/claude-sonnet-4',
  synthesize: 'anthropic/claude-opus-4',
  verify: 'openai/gpt-5', // independent family — catches anthropic blind spots
  cite: 'anthropic/claude-haiku-4',
};

/**
 * The single-model baseline: ONE strong model does decompose+search+synthesize+
 * self-check in a single pass. This is the "SOTA single model" arm — what most
 * deep-research wrappers ship. It has no independent verifier, so it cannot
 * catch its own hallucinated citations or unsupported claims.
 */
export const DRACO_SINGLE_MODEL = 'anthropic/claude-opus-4';

/** System prompt for the single-model baseline — strong, but self-checked only. */
export const SINGLE_MODEL_PROMPT =
  'You are a careful deep-research analyst. Answer the question with a cited ' +
  'dossier: every load-bearing claim carries a source URL, present the consensus ' +
  'AND the strongest dissenting positions, and self-check that each citation ' +
  'supports its claim before finalising.';

/**
 * Run the single-model baseline for one question: one model call, end to end.
 * Same transport interface as the fusion harness, so the ablation drives both
 * with the same (injected) transport.
 */
export async function singleModelResearch(
  question: { id: string; prompt: string },
  model: string,
  transport: OpenRouterTransport,
): Promise<{ questionId: string; answer: string; totalTokens: number }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SINGLE_MODEL_PROMPT },
    { role: 'user', content: question.prompt },
  ];
  const { text, tokens } = await transport(model, messages);
  return { questionId: question.id, answer: text, totalTokens: tokens };
}
