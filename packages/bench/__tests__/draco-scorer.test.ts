// SPDX-License-Identifier: MIT
//
// DRACO M3 — deterministic scorer + runner tests (ADR-037 §3-4).
// Fully offline: URL checker + transport are injected mocks.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scoreAnswer, extractUrls, liveUrlChecker, type Rubric, type UrlChecker } from '../src/draco/scorer.js';
import { runDraco, type DracoCorpus } from '../src/draco/runner.js';
import type { OpenRouterTransport } from '../src/draco/fusion.js';

const allOk: UrlChecker = async () => 'ok';
const allDead: UrlChecker = async () => 'dead';

describe('liveUrlChecker — timeout-bounded (regression: grounded run froze at 5/20)', () => {
  it('returns "dead" fast when a host hangs, instead of blocking forever', async () => {
    // A fetch that never resolves unless aborted — models a hung/slow dead domain.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const check = liveUrlChecker(hangingFetch, { timeoutMs: 40 });
    const start = Date.now();
    const result = await check('https://hung.example/dead');
    expect(result).toBe('dead');
    expect(Date.now() - start).toBeLessThan(2000); // bounded, not hung
  });

  it('"ok" on 2xx, "dead" on non-2xx', async () => {
    const ok = liveUrlChecker((async () => ({ ok: true }) as Response) as typeof fetch);
    const bad = liveUrlChecker((async () => ({ ok: false }) as Response) as typeof fetch);
    expect(await ok('https://x/live')).toBe('ok');
    expect(await bad('https://x/404')).toBe('dead');
  });

  it('"dead" on a thrown network error', async () => {
    const errFetch = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    expect(await liveUrlChecker(errFetch)('https://nope.invalid')).toBe('dead');
  });
});

describe('DRACO scorer — dimensions', () => {
  it('coverage = fraction of must_contain terms present (case-insensitive)', async () => {
    const rubric: Rubric = { must_contain: ['alpha', 'Beta', 'gamma'] };
    const s = await scoreAnswer('we discuss ALPHA and beta here', rubric, 'plain', allOk);
    expect(s.coverage).toBeCloseTo(2 / 3, 5);
  });

  it('coverage = 1 when nothing is required', async () => {
    const s = await scoreAnswer('anything', {}, 'plain', allOk);
    expect(s.coverage).toBe(1);
  });

  it('grounding = fraction of cited URLs that resolve', async () => {
    const ans = 'See https://a.example/x and https://b.example/y for evidence.';
    expect((await scoreAnswer(ans, {}, 'p', allOk)).grounding).toBe(1);
    expect((await scoreAnswer(ans, {}, 'p', allDead)).grounding).toBe(0);
    // half resolve
    const half: UrlChecker = async (u) => (u.includes('a.example') ? 'ok' : 'dead');
    expect((await scoreAnswer(ans, {}, 'p', half)).grounding).toBe(0.5);
  });

  it('grounding = 0 for an unsourced answer (no URLs)', async () => {
    const s = await scoreAnswer('a confident claim with no citation', {}, 'p', allOk);
    expect(s.grounding).toBe(0);
  });

  it('cleanliness drops when a must_not anti-pattern appears', async () => {
    const rubric: Rubric = { must_not: ['unverified anecdote', 'fabricated study'] };
    const s = await scoreAnswer('this rests on an unverified anecdote', rubric, 'p', allOk);
    expect(s.cleanliness).toBe(0.5);
  });

  it('a fabrication anti-pattern HARD-ZEROES grounding even if URLs resolve', async () => {
    const rubric: Rubric = { must_not: ['fabricated study'] };
    const ans = 'per https://ok.example a fabricated study shows X';
    const s = await scoreAnswer(ans, rubric, 'p', allOk);
    expect(s.grounding).toBe(0); // fabrication flagged
  });

  it('balance: graded only when the PROMPT demands multiple positions', async () => {
    const balancePrompt = 'What is the consensus and the two strongest dissenting positions?';
    // two position markers → 1
    const two = await scoreAnswer('X is consensus. However, critics argue Y. In contrast, Z.', {}, balancePrompt, allOk);
    expect(two.balance).toBe(1);
    // one marker → 0.5
    const one = await scoreAnswer('X is consensus. However, some disagree.', {}, balancePrompt, allOk);
    expect(one.balance).toBe(0.5);
    // non-balance prompt → not penalised
    const plain = await scoreAnswer('a one-sided answer', {}, 'what is X?', allOk);
    expect(plain.balance).toBe(1);
  });

  it('mean is the mean of the four quality dimensions', async () => {
    const s = await scoreAnswer('https://ok.example shows alpha', { must_contain: ['alpha'] }, 'what is X?', allOk);
    // grounding 1, coverage 1, balance 1 (non-balance prompt), cleanliness 1
    expect(s.mean).toBe(1);
  });

  it('extractUrls dedupes', () => {
    expect(extractUrls('a https://x.io b https://x.io c https://y.io')).toEqual(['https://x.io', 'https://y.io']);
  });
});

describe('DRACO runner — deterministic --no-judge run (offline)', () => {
  // A transport whose synthesize output embeds a resolving URL + the rubric
  // terms, so we can assert a non-trivial score deterministically.
  const corpus: DracoCorpus = {
    version: 1,
    questions: [
      { id: 'sci-1', domain: 'science', prompt: 'consensus and dissent on X?', rubric: { must_contain: ['alpha'] } },
      { id: 'fin-1', domain: 'finance', prompt: 'what is Y?', rubric: { must_contain: ['beta'] } },
    ],
  };

  function richTransport(): OpenRouterTransport {
    return async (modelId, messages) => {
      // synthesize/cite stages produce the "answer" — embed evidence.
      const text = 'Per https://src.example alpha and beta hold. However critics dissent; in contrast others agree.';
      return { text, tokens: 10 };
    };
  }

  it('produces a well-formed proof report with transport="mock"', async () => {
    const report = await runDraco(corpus, {
      transport: richTransport(),
      transportKind: 'mock',
      checkUrl: allOk,
    });
    expect(report.transport).toBe('mock');
    expect(report.judged).toBe(false);
    expect(report.corpusVersion).toBe(1);
    expect(report.perQuestion).toHaveLength(2);
    expect(Object.keys(report.perDomain).sort()).toEqual(['finance', 'science']);
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThanOrEqual(1);
    expect(report.efficiency.questions).toBe(2);
    expect(report.efficiency.totalTokens).toBeGreaterThan(0);
  });

  it('domain filter + limit narrow the run', async () => {
    const r = await runDraco(corpus, { transport: richTransport(), transportKind: 'mock', checkUrl: allOk, domain: 'science' });
    expect(r.perQuestion).toHaveLength(1);
    expect(r.perQuestion[0].domain).toBe('science');
  });

  it('a mock transport with empty answers yields a LOW score (not gameable)', async () => {
    const empty: OpenRouterTransport = async () => ({ text: 'nothing useful', tokens: 1 });
    const r = await runDraco(corpus, { transport: empty, transportKind: 'mock', checkUrl: allDead });
    // no URLs → grounding 0; no terms → coverage 0; → low mean
    expect(r.score).toBeLessThan(0.6);
  });
});

describe('DRACO committed baseline is an honest MACHINERY floor', () => {
  // Guards against anyone committing a real (live) score as the mock baseline,
  // or a tampered baseline. The mock CANNOT earn grounding or coverage.
  const baseline = readFileSync(new URL('../draco/runs/baseline-mock.json', import.meta.url), 'utf-8');
  const report = JSON.parse(baseline);

  it('is explicitly transport=mock + judged=false', () => {
    expect(report.transport).toBe('mock');
    expect(report.judged).toBe(false);
  });

  it('every question scores grounding=0 AND coverage=0 (mock cannot fake content)', () => {
    for (const q of report.perQuestion) {
      expect(q.grounding, `${q.id} grounding must be 0 in a mock run`).toBe(0);
      expect(q.coverage, `${q.id} coverage must be 0 in a mock run`).toBe(0);
    }
  });

  it('covers the full corpus (20 questions, 5 domains)', () => {
    expect(report.perQuestion).toHaveLength(20);
    expect(Object.keys(report.perDomain)).toHaveLength(5);
  });
});
