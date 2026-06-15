// SPDX-License-Identifier: MIT
//
// DRACO routing REGRESSION guard (ADR-040). Locks the headline Phase-2 finding
// into CI against the committed reference artifacts: a learned router (domain or
// embedding) must keep BEATING the best fixed model. If a future change makes
// the routers regress below the single-best model, this fails — so the README's
// "smart router makes cheap models punch like frontier" claim stays backed by a
// test, not prose. Pure + offline (reads committed JSON, no API).

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { alwaysPolicy, oracleQuality, domainRouter, embeddingKnnRouter, learningCurveEmbedding } from '../src/draco/routing.js';

const RUNS = join(dirname(fileURLToPath(import.meta.url)), '..', 'draco', 'runs');
const matrixPath = join(RUNS, 'routing-matrix-signal.json');
const embPath = join(RUNS, 'corpus-embeddings.json');

// These artifacts are committed; the guard runs only if they are present (they
// are). describe.skipIf keeps the suite green in a stripped checkout.
const have = existsSync(matrixPath) && existsSync(embPath);

describe.skipIf(!have)('DRACO routing regression — learned routers beat the best fixed model', () => {
  const art = JSON.parse(readFileSync(matrixPath, 'utf8')) as { matrix: any; pool: string[] };
  const m = art.matrix;
  const emb = (JSON.parse(readFileSync(embPath, 'utf8')) as { embeddings: Record<string, number[]> }).embeddings;

  // best FIXED model = the highest always_<model> quality.
  const bestFixed = Math.max(...art.pool.map((p) => alwaysPolicy(m, p).quality));
  const oracle = oracleQuality(m).quality;

  it('the oracle has real headroom over the best fixed model (Phase-2 premise)', () => {
    expect(oracle).toBeGreaterThan(bestFixed + 0.02); // >2% per-question-routing headroom
  });

  it('domain_router is at least as good as the best fixed model', () => {
    expect(domainRouter(m).quality).toBeGreaterThanOrEqual(bestFixed - 1e-9);
  });

  it('embedding_knn_router(k=5) is at least as good as the best fixed model', () => {
    expect(embeddingKnnRouter(m, emb, 5).quality).toBeGreaterThanOrEqual(bestFixed - 1e-9);
  });

  it('semantic embeddings route at least as well as the coarse domain label', () => {
    // embedding_knn(k=5) >= domain_router (within a small tolerance) — the
    // "semantic >= lexical/coarse" finding. Tolerance absorbs benign reshuffles.
    expect(embeddingKnnRouter(m, emb, 5).quality).toBeGreaterThanOrEqual(domainRouter(m).quality - 0.01);
  });

  it('the learning curve rises with training data (data-limited, not signal-limited)', () => {
    const curve = learningCurveEmbedding(m, emb, [3, 9, 19], 5);
    // monotone non-decreasing AND a clear net gain from small→full training set:
    expect(curve[1].quality).toBeGreaterThanOrEqual(curve[0].quality);
    expect(curve[2].quality).toBeGreaterThanOrEqual(curve[1].quality);
    expect(curve[2].quality - curve[0].quality).toBeGreaterThan(0.03); // ≥3% gain 3→19
  });
});
