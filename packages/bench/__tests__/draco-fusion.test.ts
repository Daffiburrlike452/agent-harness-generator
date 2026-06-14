// SPDX-License-Identifier: MIT
//
// DRACO M2 — OpenRouter fusion client tests (ADR-037 §2).
// Fully OFFLINE: the OpenRouter transport is injected as a deterministic mock,
// so the 6-stage pipeline runs with zero network + no API key.
import { describe, it, expect, vi } from 'vitest';
import {
  FUSION_STAGES,
  DEFAULT_FUSION_MODELS,
  modelFamily,
  assertFusionDistinct,
  fuseResearch,
  openRouterTransport,
  type FusionModelMap,
  type OpenRouterTransport,
} from '../src/draco/fusion.js';

describe('DRACO fusion — model map invariants', () => {
  it('has exactly the six ADR-037 stages', () => {
    expect([...FUSION_STAGES]).toEqual(['decompose', 'search', 'grade', 'synthesize', 'verify', 'cite']);
  });

  it('modelFamily extracts the provider prefix', () => {
    expect(modelFamily('anthropic/claude-opus-4')).toBe('anthropic');
    expect(modelFamily('openai/gpt-5')).toBe('openai');
    expect(modelFamily('localmodel')).toBe('localmodel');
  });

  it('default models verify with a DIFFERENT family than synthesize (fusion)', () => {
    expect(modelFamily(DEFAULT_FUSION_MODELS.verify)).not.toBe(modelFamily(DEFAULT_FUSION_MODELS.synthesize));
    expect(() => assertFusionDistinct(DEFAULT_FUSION_MODELS)).not.toThrow();
  });

  it('REJECTS a config that verifies with the same family as synthesize', () => {
    const sameFamily: FusionModelMap = { ...DEFAULT_FUSION_MODELS, verify: 'anthropic/claude-sonnet-4' };
    expect(() => assertFusionDistinct(sameFamily)).toThrow(/DIFFERENT model family/);
  });
});

describe('DRACO fusion — pipeline (mocked transport)', () => {
  // A deterministic mock: echoes the stage's model id + a marker, counts tokens.
  function mockTransport(): { transport: OpenRouterTransport; calls: string[] } {
    const calls: string[] = [];
    const transport: OpenRouterTransport = async (modelId, messages) => {
      calls.push(modelId);
      const last = messages[messages.length - 1]?.content ?? '';
      return { text: `[${modelId}] handled: ${last.slice(0, 20)}`, tokens: 10 };
    };
    return { transport, calls };
  }

  it('runs all 6 stages (7 calls — synthesize runs twice for the fusion fold)', async () => {
    const { transport, calls } = mockTransport();
    const r = await fuseResearch({ id: 'sci-001', prompt: 'test prompt' }, DEFAULT_FUSION_MODELS, transport);
    // decompose, search, grade, synthesize, verify, synthesize(fold), cite = 7
    expect(calls).toHaveLength(7);
    expect(r.questionId).toBe('sci-001');
    expect(r.answer).toContain('handled');
  });

  it('records per-stage provenance with model + family + tokens', async () => {
    const { transport } = mockTransport();
    const r = await fuseResearch({ id: 'fin-001', prompt: 'p' }, DEFAULT_FUSION_MODELS, transport);
    const stages = r.provenance.map((p) => p.stage);
    expect(stages).toEqual(['decompose', 'search', 'grade', 'synthesize', 'verify', 'synthesize', 'cite']);
    // verify provenance carries a different family than synthesize
    const verify = r.provenance.find((p) => p.stage === 'verify')!;
    const synth = r.provenance.find((p) => p.stage === 'synthesize')!;
    expect(verify.family).not.toBe(synth.family);
    expect(r.totalTokens).toBe(70); // 7 calls × 10
  });

  it('throws BEFORE any network call when fusion config is invalid', async () => {
    const { transport, calls } = mockTransport();
    const sameFamily: FusionModelMap = { ...DEFAULT_FUSION_MODELS, verify: 'anthropic/x' };
    await expect(fuseResearch({ id: 'x', prompt: 'p' }, sameFamily, transport)).rejects.toThrow(/DIFFERENT model family/);
    expect(calls).toHaveLength(0); // fail fast, zero spend
  });
});

describe('DRACO fusion — live transport guards', () => {
  it('refuses to build the live transport without an API key', () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => openRouterTransport()).toThrow(/OPENROUTER_API_KEY is required/);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it('builds with an injected key + mock fetch, and POSTs to OpenRouter', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 5 } }),
    })) as unknown as typeof fetch;
    const t = openRouterTransport({ apiKey: 'test-key', fetchImpl });
    const out = await t('anthropic/claude-haiku-4', [{ role: 'user', content: 'q' }]);
    expect(out.text).toBe('hi');
    expect(out.tokens).toBe(5);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('openrouter.ai/api/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('surfaces a non-OK HTTP status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const t = openRouterTransport({ apiKey: 'k', fetchImpl });
    await expect(t('m', [{ role: 'user', content: 'q' }])).rejects.toThrow(/HTTP 429/);
  });
});
