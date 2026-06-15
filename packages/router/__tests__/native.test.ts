// SPDX-License-Identifier: MIT
// Native FastGRNN backend (ADR-043) — exercises the real train→persist→route arc
// when @ruvector/tiny-dancer is installed, and the graceful-degradation contract
// when it is not. The native assertions are gated on availability so CI passes on
// any platform; on a platform with the binary they run the genuine pipeline.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isNativeRouterAvailable,
  nativeRouterVersion,
  trainNativeRouter,
  NativeRouter,
  resolveRouterBackend,
  __resetNativeCache,
  type RouterRow,
} from '../src/native.js';

// tiny-dancer 0.1.21's route pipeline engineers a fixed 5-feature vector, so an
// end-to-end native route requires a model trained at inputDim=5 (training itself
// accepts any dim). We build separable 5-dim rows for the route arc.
const ROUTE_FEATURE_DIM = 5;

// A tiny separable routing dataset: a "cheap-friendly" cluster (cheap is good
// enough) and a "needs-strong" cluster (only the expensive model scores well).
function makeRows(dim = ROUTE_FEATURE_DIM): RouterRow[] {
  const rows: RouterRow[] = [];
  for (let i = 0; i < 24; i++) {
    const cheapZone = i % 2 === 0;
    const e = Array.from({ length: dim }, (_, j) =>
      j === 0 ? (cheapZone ? 1 : 0) : j === 1 ? (cheapZone ? 0 : 1) : ((i * 7 + j) % 5) / 50,
    );
    rows.push({ embedding: e, scores: cheapZone ? { haiku: 0.9, opus: 0.92 } : { haiku: 0.45, opus: 0.95 } });
  }
  return rows;
}

const PRICES = { haiku: 1, opus: 15 };

let available = false;
let dir: string;

beforeAll(async () => {
  __resetNativeCache();
  available = await isNativeRouterAvailable();
  dir = mkdtempSync(join(tmpdir(), 'native-router-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('availability contract', () => {
  it('isNativeRouterAvailable resolves a boolean', async () => {
    expect(typeof (await isNativeRouterAvailable())).toBe('boolean');
  });

  it('resolveRouterBackend("js") always returns js (zero-dep path)', async () => {
    expect(await resolveRouterBackend('js')).toBe('js');
  });

  it('resolveRouterBackend("auto") returns native iff available', async () => {
    expect(await resolveRouterBackend('auto')).toBe(available ? 'native' : 'js');
  });

  it('nativeRouterVersion is a version string when available, else null', async () => {
    const v = await nativeRouterVersion();
    if (available) expect(v).toMatch(/\d+\.\d+\.\d+/);
    else expect(v).toBeNull();
  });
});

describe('graceful degradation when absent', () => {
  it('train/load/resolve("native") throw a clear, actionable error when unavailable', async () => {
    if (available) return; // contract only applies when the dep is missing
    await expect(trainNativeRouter(makeRows(), PRICES, { outputPath: join(dir, 'x.safetensors') })).rejects.toThrow(
      /tiny-dancer is not installed/,
    );
    await expect(NativeRouter.load({ modelPath: join(dir, 'x.safetensors') })).rejects.toThrow(/not installed/);
    await expect(resolveRouterBackend('native')).rejects.toThrow(/not installed/);
  });
});

describe('native train → persist → route (gated on availability)', () => {
  it('trains a FastGRNN, writes a .safetensors, and routes from it', async () => {
    if (!available) return;
    const out = join(dir, 'router.safetensors');
    const res = await trainNativeRouter(makeRows(), PRICES, { outputPath: out, epochs: 30 });
    // real training happened and a model file landed
    expect(res.modelPath).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(res.modelBytes).toBeGreaterThan(0);
    expect(res.epochsRun).toBeGreaterThan(0);
    expect(res.trainAccuracy).toBeGreaterThan(0.5); // learns the separable signal

    const router = await NativeRouter.load({ modelPath: out });
    const z = (k: number) => Array.from({ length: ROUTE_FEATURE_DIM }, (_, j) => (j === k ? 1 : 0));
    const candidates = [
      { id: 'haiku', embedding: z(0), costPerMTok: PRICES.haiku },
      { id: 'opus', embedding: z(1), costPerMTok: PRICES.opus },
    ];
    const decision = await router.route(z(0), candidates);
    expect(['haiku', 'opus']).toContain(decision.id);
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(typeof decision.useLightweight).toBe('boolean');
    expect(decision.inferenceTimeUs).toBeGreaterThanOrEqual(0);
  });

  it('infers inputDim from the first row when not given', async () => {
    if (!available) return;
    const out = join(dir, 'router2.safetensors');
    const res = await trainNativeRouter(makeRows(), PRICES, { outputPath: out, epochs: 10 });
    expect(existsSync(res.modelPath)).toBe(true);
  });

  it('a model trained at a non-route dim yields a clear, actionable error (not the cryptic native one)', async () => {
    if (!available) return;
    const out = join(dir, 'router-bad-dim.safetensors');
    await trainNativeRouter(makeRows(8), PRICES, { outputPath: out, epochs: 5 }); // train at dim 8 — fine
    const router = await NativeRouter.load({ modelPath: out });
    const e8 = (k: number) => Array.from({ length: 8 }, (_, j) => (j === k ? 1 : 0));
    await expect(
      router.route(e8(0), [{ id: 'haiku', embedding: e8(0) }, { id: 'opus', embedding: e8(1) }]),
    ).rejects.toThrow(/dimension mismatch|fixed feature vector/);
  });
});

describe('input validation (no native dep required)', () => {
  it('trainNativeRouter rejects empty rows before touching the engine', async () => {
    // when available this throws "needs at least one row"; when absent it throws
    // the not-installed error first — either way it rejects, never silently no-ops.
    await expect(trainNativeRouter([], PRICES, { outputPath: join(dir, 'e.safetensors') })).rejects.toThrow();
  });
});
