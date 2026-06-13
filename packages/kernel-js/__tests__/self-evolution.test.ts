// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { computeReward, SelfEvolvingRouter, type RoutingHistoryEntry } from '../src/self-evolution.js';

describe('computeReward', () => {
  it('returns 1.0 for an ideal outcome (success, instant, free)', () => {
    const r = computeReward(
      { tier: 'codemod', success: true, latencyMs: 0, costUsd: 0 },
      { enabled: true },
    );
    expect(r).toBeCloseTo(1.0, 5);
  });

  it('returns less than 1.0 when latency is high', () => {
    const slow = computeReward(
      { tier: 'frontier', success: true, latencyMs: 5000, costUsd: 0 },
      { enabled: true },
    );
    const fast = computeReward(
      { tier: 'codemod', success: true, latencyMs: 0, costUsd: 0 },
      { enabled: true },
    );
    expect(slow).toBeLessThan(fast);
  });

  it('penalises failures', () => {
    const success = computeReward(
      { tier: 'small', success: true, latencyMs: 500, costUsd: 0.001 },
      { enabled: true },
    );
    const failure = computeReward(
      { tier: 'small', success: false, latencyMs: 500, costUsd: 0.001 },
      { enabled: true },
    );
    expect(failure).toBeLessThan(success);
  });

  it('normalises when weights do not sum to 1', () => {
    const r = computeReward(
      { tier: 'codemod', success: true, latencyMs: 0, costUsd: 0 },
      { enabled: true, rewardMix: { successWeight: 2, latencyWeight: 2, costWeight: 2 } },
    );
    expect(r).toBeCloseTo(1.0, 5);
  });
});

describe('SelfEvolvingRouter', () => {
  it('is a pass-through when disabled (no weight movement)', async () => {
    const r = new SelfEvolvingRouter({ enabled: false });
    await r.recordOutcome({ tier: 'small', success: false, latencyMs: 9999, costUsd: 1 });
    expect(r.weightFor('small')).toBe(1);
  });

  it('moves weights when enabled (fallback EMA)', async () => {
    const r = new SelfEvolvingRouter({ enabled: true });
    const initial = r.weightFor('small');
    // Mostly-failed calls should drop small's weight.
    for (let i = 0; i < 20; i++) {
      await r.recordOutcome({ tier: 'small', success: false, latencyMs: 2000, costUsd: 0.01 });
    }
    expect(r.weightFor('small')).toBeLessThan(initial);
  });

  it('rewards successful tier — its weight ends up highest', async () => {
    const r = new SelfEvolvingRouter({ enabled: true });
    // codemod keeps winning, frontier keeps losing.
    for (let i = 0; i < 20; i++) {
      await r.recordOutcome({ tier: 'codemod', success: true, latencyMs: 1, costUsd: 0 });
      await r.recordOutcome({ tier: 'frontier', success: false, latencyMs: 5000, costUsd: 0.05 });
    }
    const ranked = r.reRank(['frontier', 'small', 'codemod']);
    expect(ranked[0]).toBe('codemod');
  });

  it('honors smallTierBias', async () => {
    const r = new SelfEvolvingRouter({ enabled: true, smallTierBias: 2 });
    await r.recordOutcome({ tier: 'small', success: true, latencyMs: 500, costUsd: 0.0002 });
    expect(r.weightFor('small')).toBeGreaterThan(1.0);
  });

  it('records history regardless of enabled state', async () => {
    const r = new SelfEvolvingRouter({ enabled: false });
    await r.recordOutcome({ tier: 'codemod', success: true, latencyMs: 1, costUsd: 0 });
    expect(r.history_().length).toBe(1);
  });
});
