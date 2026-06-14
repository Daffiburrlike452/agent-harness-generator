// SPDX-License-Identifier: MIT
//
// DRACO M4 — LLM-judge faithfulness tests (ADR-037 §3 dim 4).
// Fully offline: the judge transport is an injected mock.
import { describe, it, expect } from 'vitest';
import {
  DRACO_JUDGE,
  JUDGE_SYSTEM_PROMPT_V1,
  assertJudgeIndependent,
  parseFaithfulness,
  judgeFaithfulness,
} from '../src/draco/judge.js';
import { DEFAULT_FUSION_MODELS, modelFamily, type OpenRouterTransport, type FusionModelMap } from '../src/draco/fusion.js';
import { runDraco, type DracoCorpus } from '../src/draco/runner.js';
import type { UrlChecker } from '../src/draco/scorer.js';

describe('DRACO judge — independence + parsing', () => {
  it('the pinned judge is a THIRD family, distinct from synthesize + verify', () => {
    const j = modelFamily(DRACO_JUDGE.model);
    expect(j).not.toBe(modelFamily(DEFAULT_FUSION_MODELS.synthesize));
    expect(j).not.toBe(modelFamily(DEFAULT_FUSION_MODELS.verify));
    expect(() => assertJudgeIndependent(DRACO_JUDGE.model, DEFAULT_FUSION_MODELS)).not.toThrow();
  });

  it('REJECTS a judge that shares a family with the synthesizer', () => {
    expect(() => assertJudgeIndependent('anthropic/claude-x', DEFAULT_FUSION_MODELS)).toThrow(/DIFFERENT family/);
  });

  it('REJECTS a judge that shares a family with the verifier', () => {
    expect(() => assertJudgeIndependent('openai/gpt-x', DEFAULT_FUSION_MODELS)).toThrow(/DIFFERENT family/);
  });

  it('parseFaithfulness reads the FAITHFULNESS line + clamps to 0-1', () => {
    expect(parseFaithfulness('FAITHFULNESS: 0.73')).toBeCloseTo(0.73, 5);
    expect(parseFaithfulness('FAITHFULNESS: 1.5')).toBe(1); // clamp high
    expect(parseFaithfulness('FAITHFULNESS: -2')).toBe(0); // clamp low (regex needs the digit)
    expect(parseFaithfulness('blah\nFAITHFULNESS:0.4\nmore')).toBeCloseTo(0.4, 5);
  });

  it('parseFaithfulness fails CLOSED (0) on unparseable judge output', () => {
    expect(parseFaithfulness('I think it is pretty good')).toBe(0);
    expect(parseFaithfulness('')).toBe(0);
  });

  it('the judge prompt is pinned (v1) + asks for one parseable line', () => {
    expect(DRACO_JUDGE.promptVersion).toBe(1);
    expect(JUDGE_SYSTEM_PROMPT_V1).toContain('FAITHFULNESS:');
  });

  it('judgeFaithfulness calls the judge transport with the pinned prompt', async () => {
    const calls: { model: string; system: string }[] = [];
    const judge: OpenRouterTransport = async (model, msgs) => {
      calls.push({ model, system: msgs[0].content });
      return { text: 'FAITHFULNESS: 0.6', tokens: 4 };
    };
    const r = await judgeFaithfulness('some dossier', judge);
    expect(r.faithfulness).toBeCloseTo(0.6, 5);
    expect(r.tokens).toBe(4);
    expect(calls[0].model).toBe(DRACO_JUDGE.model);
    expect(calls[0].system).toBe(JUDGE_SYSTEM_PROMPT_V1);
  });
});

describe('DRACO runner — judged mode (M4, offline)', () => {
  const corpus: DracoCorpus = {
    version: 1,
    questions: [
      { id: 'sci-1', domain: 'science', prompt: 'what is X?', rubric: { must_contain: ['alpha'] } },
    ],
  };
  const richTransport: OpenRouterTransport = async () => ({
    text: 'Per https://src.example alpha holds.',
    tokens: 10,
  });
  const allOk: UrlChecker = async () => 'ok';

  it('folds faithfulness into the mean (5 dimensions) + marks judged:true', async () => {
    const judge: OpenRouterTransport = async () => ({ text: 'FAITHFULNESS: 0.5', tokens: 3 });
    const report = await runDraco(corpus, {
      transport: richTransport,
      transportKind: 'live',
      checkUrl: allOk,
      judgeTransport: judge,
    });
    expect(report.judged).toBe(true);
    expect(report.judge).toEqual({ model: DRACO_JUDGE.model, promptVersion: 1 });
    const q = report.perQuestion[0];
    expect(q.faithfulness).toBeCloseTo(0.5, 5);
    // grounding 1, coverage 1 (alpha), balance 1 (non-balance prompt),
    // cleanliness 1, faithfulness 0.5 → mean = 4.5/5 = 0.9
    expect(q.mean).toBeCloseTo(0.9, 5);
    // judge tokens (3) added to fusion tokens
    expect(q.tokens).toBeGreaterThan(10);
  });

  it('an UNFAITHFUL synthesis drags the score down even when deterministic dims are perfect', async () => {
    const harshJudge: OpenRouterTransport = async () => ({ text: 'FAITHFULNESS: 0.0', tokens: 3 });
    const report = await runDraco(corpus, {
      transport: richTransport,
      transportKind: 'live',
      checkUrl: allOk,
      judgeTransport: harshJudge,
    });
    // 4 perfect deterministic dims + 0 faithfulness → 4/5 = 0.8
    expect(report.perQuestion[0].mean).toBeCloseTo(0.8, 5);
  });

  it('a no-judge run stays judged:false (deterministic subset, 4 dims)', async () => {
    const report = await runDraco(corpus, { transport: richTransport, transportKind: 'mock', checkUrl: allOk });
    expect(report.judged).toBe(false);
    expect(report.perQuestion[0].faithfulness).toBeUndefined();
    expect(report.perQuestion[0].mean).toBeCloseTo(1, 5); // 4 perfect dims
  });

  it('a judge sharing the harness family is rejected BEFORE any call', async () => {
    const judge: OpenRouterTransport = async () => ({ text: 'FAITHFULNESS: 1', tokens: 1 });
    await expect(
      runDraco(corpus, { transport: richTransport, transportKind: 'live', checkUrl: allOk, judgeTransport: judge, judgeModel: 'anthropic/x' }),
    ).rejects.toThrow(/DIFFERENT family/);
  });
});
