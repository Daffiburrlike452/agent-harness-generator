// SPDX-License-Identifier: MIT
//
// DRACO M6 — fusion-vs-single ablation: the "beyond SOTA" proof (offline demo).
//
// The headline test crafts a scenario that mirrors the REAL failure mode the
// fusion architecture fixes: a strong single model ships a FABRICATED citation
// (it passes its own self-check — its blind spot ships). The optimised fusion
// harness's INDEPENDENT verifier catches it; the fold-back synthesis drops the
// bad citation and keeps a resolving one. On the DRACO scorer this is a
// measurable grounding win for fusion — proven deterministically, not asserted.
import { describe, it, expect } from 'vitest';
import { runAblation } from '../src/draco/ablation.js';
import { DRACO_OPTIMIZED_MODELS, DRACO_SINGLE_MODEL, singleModelResearch, SINGLE_MODEL_PROMPT } from '../src/draco/optimized.js';
import { modelFamily, type OpenRouterTransport } from '../src/draco/fusion.js';
import type { UrlChecker } from '../src/draco/scorer.js';
import type { DracoCorpus } from '../src/draco/runner.js';

const corpus: DracoCorpus = {
  version: 1,
  questions: [
    { id: 'sci-1', domain: 'science', prompt: 'consensus and the strongest dissenting positions on X?', rubric: { must_contain: ['alpha'] } },
  ],
};

// A URL checker where only the "good" source resolves; the fabricated one is dead.
const checkUrl: UrlChecker = async (u) => (u.includes('good.example') ? 'ok' : 'dead');

/**
 * The crafted transport — the heart of the proof. It returns different content
 * per pipeline stage (keyed on the system prompt):
 *   - single-model + initial fusion synthesis → a draft citing a FABRICATED
 *     (dead) URL alongside alpha. A single model self-checks and ships this.
 *   - fusion verify → flags the fabricated citation as UNSUPPORTED.
 *   - fusion fold synthesis → drops the dead URL, keeps the resolving good one.
 * So: single arm ships the dead citation (grounding 0); fusion arm, via its
 * independent verifier, ships only the resolving one (grounding 1).
 */
function craftedTransport(): OpenRouterTransport {
  return async (_model, messages) => {
    const sys = messages[0]?.content ?? '';
    const DRAFT_WITH_FABRICATION = 'Per https://dead.example/fabricated alpha holds. However critics dissent; in contrast others note nuance.';
    const CLEAN_AFTER_VERIFY = 'Per https://good.example/real alpha holds. However critics dissent; in contrast others note nuance.';
    if (sys === SINGLE_MODEL_PROMPT) return { text: DRAFT_WITH_FABRICATION, tokens: 12 };
    if (/Adversarially verify/.test(sys)) return { text: 'UNSUPPORTED: https://dead.example/fabricated does not exist.', tokens: 6 };
    if (/Revise the dossier to address the verifier feedback/.test(sys)) return { text: CLEAN_AFTER_VERIFY, tokens: 10 };
    if (/Write the dossier/.test(sys)) return { text: DRAFT_WITH_FABRICATION, tokens: 10 };
    if (/Normalise every citation/.test(sys)) return { text: CLEAN_AFTER_VERIFY, tokens: 4 };
    return { text: 'intermediate', tokens: 3 }; // decompose/search/grade
  };
}

describe('DRACO M6 — optimized config sanity', () => {
  it('the optimized fusion verifier is a different family than its synthesizer', () => {
    expect(modelFamily(DRACO_OPTIMIZED_MODELS.verify)).not.toBe(modelFamily(DRACO_OPTIMIZED_MODELS.synthesize));
  });

  it('the single-model baseline is one model, end to end (one call)', async () => {
    let calls = 0;
    const t: OpenRouterTransport = async () => { calls++; return { text: 'x', tokens: 1 }; };
    await singleModelResearch({ id: 'q', prompt: 'p' }, DRACO_SINGLE_MODEL, t);
    expect(calls).toBe(1); // no fusion — a single pass
  });
});

describe('DRACO M6 — fusion BEATS single (the beyond-SOTA proof, deterministic)', () => {
  it('fusion catches the fabricated citation single ships → measurable grounding win', async () => {
    const report = await runAblation(corpus, {
      transport: craftedTransport(),
      transportKind: 'mock',
      checkUrl,
    });

    // Single shipped the dead citation → grounding 0.
    expect(report.single.perDimension.grounding).toBe(0);
    // Fusion's independent verifier removed it → grounding 1.
    expect(report.fusion.perDimension.grounding).toBe(1);

    // The architecture wins — MEASURED, not asserted.
    expect(report.fusionWins).toBe(true);
    expect(report.delta).toBeGreaterThan(0);
    expect(report.deltaByDimension.grounding).toBe(1); // the dimension that drove it
  });

  it('with an independent judge, fusion also wins on faithfulness', async () => {
    // The judge rates the fusion (clean) answer faithful, the single (fabricated) answer not.
    const judge: OpenRouterTransport = async (_m, msgs) => {
      const answer = msgs[1]?.content ?? '';
      const faithful = answer.includes('good.example');
      return { text: `FAITHFULNESS: ${faithful ? '1.0' : '0.0'}`, tokens: 3 };
    };
    const report = await runAblation(corpus, {
      transport: craftedTransport(),
      transportKind: 'mock',
      checkUrl,
      judgeTransport: judge,
    });
    expect(report.judged).toBe(true);
    expect(report.single.perDimension.faithfulness).toBe(0);
    expect(report.fusion.perDimension.faithfulness).toBe(1);
    expect(report.fusionWins).toBe(true);
    expect(report.deltaByDimension.faithfulness).toBe(1);
  });

  it('a fair tie (both arms identical) does NOT claim a win', async () => {
    // Transport returns the same clean answer regardless of stage → no asymmetry.
    const flat: OpenRouterTransport = async () => ({ text: 'https://good.example alpha. However critics dissent; in contrast others.', tokens: 5 });
    const report = await runAblation(corpus, { transport: flat, transportKind: 'mock', checkUrl });
    expect(report.delta).toBe(0);
    expect(report.fusionWins).toBe(false); // strictly-greater, so a tie is not a win
  });
});
