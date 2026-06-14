// SPDX-License-Identifier: MIT
//
// DRACO M4 — LLM-judge faithfulness dimension (ADR-037 §3, dimension 4).
//
// Faithfulness asks: is the synthesis actually SUPPORTED by the sources it
// cites? This is the one dimension a regex cannot check — it needs a model.
// To keep it honest + reproducible:
//   - the judge model is PINNED per corpus version and is a model NOT used
//     anywhere in the fusion harness (independence — a model cannot judge its
//     own work);
//   - the judge PROMPT is pinned (versioned) so a score is comparable across
//     runs on the same corpus version;
//   - the judge transport is INJECTED (same OpenRouterTransport interface as
//     the harness), so M4 is fully offline-testable with a mock — no live key.
//
// The judge returns a single 0-1 faithfulness score per answer. NOTHING here
// runs live by default; a real judged score needs --live + OPENROUTER_API_KEY.

import type { OpenRouterTransport, FusionModelMap } from './fusion.js';
import { modelFamily } from './fusion.js';

/**
 * The pinned DRACO judge. A THIRD model family — distinct from the default
 * synthesize (anthropic) and verify (openai) families — so the judge shares no
 * blind spot with either side of the fusion. Pinned per corpus version.
 */
export const DRACO_JUDGE = {
  model: 'google/gemini-2.5-pro',
  promptVersion: 1,
} as const;

/**
 * The judge prompt (pinned, v1). The judge reads the dossier and rates whether
 * each load-bearing claim is supported by the cited sources, returning ONE line
 * `FAITHFULNESS: <0..1>`. Asking for a single parseable number keeps scoring
 * deterministic to parse even though the judgement itself is a model call.
 */
export const JUDGE_SYSTEM_PROMPT_V1 =
  'You are an impartial faithfulness judge. Read the research dossier below. ' +
  'Rate, from 0.0 to 1.0, the fraction of its load-bearing claims that are ' +
  'genuinely SUPPORTED by the sources it cites (not merely plausible). A claim ' +
  'with a citation that does not actually support it counts as UNSUPPORTED. ' +
  'Respond with EXACTLY one line and nothing else:\nFAITHFULNESS: <number between 0 and 1>';

/**
 * The judge must be a different model family than BOTH the synthesizer and the
 * verifier — otherwise it shares a blind spot with the work it is grading.
 * Throws on violation (ADR-037 §3 independence requirement).
 */
export function assertJudgeIndependent(judgeModel: string, fusion: FusionModelMap): void {
  const j = modelFamily(judgeModel);
  const s = modelFamily(fusion.synthesize);
  const v = modelFamily(fusion.verify);
  if (j === s || j === v) {
    throw new Error(
      `DRACO judge (${judgeModel}, family "${j}") must be a DIFFERENT family than both the ` +
        `synthesizer (${fusion.synthesize}) and verifier (${fusion.verify}). A judge that shares a ` +
        `family with either shares its blind spot (ADR-037 §3).`,
    );
  }
}

/** Parse the judge's `FAITHFULNESS: <n>` line into a clamped 0-1 score. */
export function parseFaithfulness(judgeOutput: string): number {
  const m = judgeOutput.match(/FAITHFULNESS:\s*([0-9]*\.?[0-9]+)/i);
  if (!m) return 0; // unparseable judge output → no credit (fail closed)
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Judge one answer's faithfulness via the (injected) judge transport. Returns
 * a 0-1 score + the raw judge output for the proof trail.
 */
export async function judgeFaithfulness(
  answer: string,
  judgeTransport: OpenRouterTransport,
  judgeModel: string = DRACO_JUDGE.model,
): Promise<{ faithfulness: number; raw: string; tokens: number }> {
  const { text, tokens } = await judgeTransport(judgeModel, [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT_V1 },
    { role: 'user', content: answer },
  ]);
  return { faithfulness: parseFaithfulness(text), raw: text, tokens };
}
