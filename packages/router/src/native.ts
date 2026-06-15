// SPDX-License-Identifier: MIT
//
// Native routing backend (ADR-043 / ADR-041 routing stage) — the production
// FastGRNN router behind the pure-TS KRR fallback.
//
// `@ruvector/tiny-dancer` ships a native (Rust/NAPI) FastGRNN trainer + router
// across 8 platforms. It consumes the EXACT `{ embedding, scores }` DRACO row
// shape this package already uses (`Router.fromExamples` / `trainRouter`), trains
// with real gradients + Adam, persists a `.safetensors`, and routes from it with
// uncertainty estimation + a circuit breaker.
//
// This module is the thin, lazily-loaded adapter to that engine. It is OPTIONAL:
// `@ruvector/tiny-dancer` is an optional peer, never a hard dependency, so a
// generated harness that only needs the dependency-free KRR/k-NN router pulls
// nothing native. Install tiny-dancer to unlock the native path; everything here
// degrades to a clear error (or `available = false`) when it is absent.

import type { TrainedRouter } from './train.js';

/** One DRACO training row — identical to the shape `trainRouter`/`fromExamples` consume. */
export interface RouterRow {
  embedding: number[];
  scores: Record<string, number>;
}

/** Minimal surface of `@ruvector/tiny-dancer` we depend on (kept local so the
 *  published `.d.ts` carries no hard type dependency on the optional package). */
interface TinyDancerModule {
  version(): string;
  trainRouter(
    rows: RouterRow[],
    prices: Record<string, number>,
    options: { outputPath: string; inputDim: number; hiddenDim?: number; epochs?: number; learningRate?: number; tolerance?: number },
  ): Promise<{ epochsRun: number; trainLoss: number; trainAccuracy: number; valAccuracy: number; modelPath: string; modelBytes: number }>;
  Router: new (config: { modelPath: string; confidenceThreshold?: number; maxUncertainty?: number; enableCircuitBreaker?: boolean }) => {
    route(req: { queryEmbedding: number[] | Float32Array; candidates: Array<{ id: string; embedding: number[] | Float32Array; successRate?: number }> }): Promise<{
      decisions: Array<{ candidateId: string; confidence: number; useLightweight: boolean; uncertainty: number }>;
      inferenceTimeUs: number;
    }>;
    reloadModel(): Promise<void>;
    circuitBreakerStatus(): boolean | null;
  };
}

let cached: TinyDancerModule | null | undefined;

/** Lazily load the optional native engine. Returns null (cached) when absent. */
async function loadTinyDancer(): Promise<TinyDancerModule | null> {
  if (cached !== undefined) return cached;
  try {
    // Indirect specifier so bundlers don't hard-resolve the optional dep.
    const mod = (await import('@ruvector/tiny-dancer')) as unknown as TinyDancerModule;
    cached = mod && typeof mod.trainRouter === 'function' ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Reset the load cache — test seam only. */
export function __resetNativeCache(): void {
  cached = undefined;
}

/** Whether the native FastGRNN backend is installed + loadable on this platform. */
export async function isNativeRouterAvailable(): Promise<boolean> {
  return (await loadTinyDancer()) !== null;
}

/** The installed tiny-dancer version, or null when the native backend is absent. */
export async function nativeRouterVersion(): Promise<string | null> {
  const td = await loadTinyDancer();
  return td ? td.version() : null;
}

export interface NativeTrainOptions {
  /** Where to write the trained `.safetensors` model (required). */
  outputPath: string;
  /** Input feature dim — defaults to the first row's embedding length. */
  inputDim?: number;
  hiddenDim?: number;
  epochs?: number;
  learningRate?: number;
  /** DRACO "good enough" tolerance: cheap model counts as good within this of best (default 0.05). */
  tolerance?: number;
}

export interface NativeTrainResult {
  modelPath: string;
  epochsRun: number;
  trainLoss: number;
  trainAccuracy: number;
  valAccuracy: number;
  modelBytes: number;
}

const NOT_INSTALLED =
  '@ruvector/tiny-dancer is not installed — `npm i @ruvector/tiny-dancer` to use the native router, ' +
  'or use trainRouter() (pure-TS KRR, zero native deps).';

/**
 * Train a native FastGRNN router from a DRACO routing dataset and write it to a
 * `.safetensors` file consumable by {@link loadNativeRouter}. Same `(rows, prices)`
 * inputs as the pure-TS {@link trainRouter}; the difference is a real trained
 * neural model persisted to disk. Throws a clear error when tiny-dancer is absent.
 */
export async function trainNativeRouter(
  rows: RouterRow[],
  prices: Record<string, number>,
  opts: NativeTrainOptions,
): Promise<NativeTrainResult> {
  const td = await loadTinyDancer();
  if (!td) throw new Error(NOT_INSTALLED);
  if (!rows.length) throw new Error('trainNativeRouter needs at least one row');
  const inputDim = opts.inputDim ?? rows[0].embedding.length;
  if (!inputDim) throw new Error('cannot infer inputDim from empty embeddings');
  const res = await td.trainRouter(rows, prices, {
    outputPath: opts.outputPath,
    inputDim,
    ...(opts.hiddenDim != null ? { hiddenDim: opts.hiddenDim } : {}),
    ...(opts.epochs != null ? { epochs: opts.epochs } : {}),
    ...(opts.learningRate != null ? { learningRate: opts.learningRate } : {}),
    ...(opts.tolerance != null ? { tolerance: opts.tolerance } : {}),
  });
  return {
    modelPath: res.modelPath,
    epochsRun: res.epochsRun,
    trainLoss: res.trainLoss,
    trainAccuracy: res.trainAccuracy,
    valAccuracy: res.valAccuracy,
    modelBytes: res.modelBytes,
  };
}

export interface NativeRouteCandidate {
  id: string;
  embedding: number[];
  /** Optional blended price ($/1M tokens) — lets `route` pick cost-optimal among confident picks. */
  costPerMTok?: number;
  successRate?: number;
}

export interface NativeRouteResult {
  id: string;
  confidence: number;
  uncertainty: number;
  /** The native circuit breaker / uncertainty gate says use the lightweight model. */
  useLightweight: boolean;
  costPerMTok?: number;
  inferenceTimeUs: number;
}

/** A loaded native FastGRNN router (`.safetensors` backed). */
export class NativeRouter {
  private constructor(private readonly inner: InstanceType<TinyDancerModule['Router']>) {}

  /** Load a trained model written by {@link trainNativeRouter}. Throws when tiny-dancer is absent. */
  static async load(config: {
    modelPath: string;
    confidenceThreshold?: number;
    maxUncertainty?: number;
    enableCircuitBreaker?: boolean;
  }): Promise<NativeRouter> {
    const td = await loadTinyDancer();
    if (!td) throw new Error(NOT_INSTALLED);
    return new NativeRouter(new td.Router(config));
  }

  /**
   * Route a query over candidate models. Returns the top decision, enriched with
   * the candidate's price when supplied so callers can apply a cost-optimal tie-break.
   */
  async route(queryEmbedding: number[], candidates: NativeRouteCandidate[]): Promise<NativeRouteResult> {
    if (!candidates.length) throw new Error('route needs at least one candidate');
    // The native NAPI boundary requires Float32Array (its `number[]` type union is
    // not honored at runtime) — coerce here so callers can pass plain arrays.
    const f32 = (v: number[] | Float32Array) => (v instanceof Float32Array ? v : Float32Array.from(v));
    let res;
    try {
      res = await this.inner.route({
        queryEmbedding: f32(queryEmbedding),
        candidates: candidates.map((c) => ({ id: c.id, embedding: f32(c.embedding), ...(c.successRate != null ? { successRate: c.successRate } : {}) })),
      });
    } catch (err) {
      // tiny-dancer 0.1.21's route pipeline engineers a fixed-size relational
      // feature vector, so the loaded model's inputDim must match that engineered
      // size (empirically 5) — NOT the raw embedding dim it was trained on. Surface
      // the actionable cause instead of the cryptic "Expected input dimension N,
      // got M". Native TRAINING works at any dim; high-dim native ROUTE awaits an
      // upstream fix — use the pure-TS KRR/k-NN router for arbitrary embeddings.
      const msg = err instanceof Error ? err.message : String(err);
      if (/input dimension/i.test(msg)) {
        throw new Error(
          `native route dimension mismatch (${msg}). tiny-dancer's route pipeline engineers a ` +
            `fixed feature vector, so the model must be trained at that input dimension; for ` +
            `arbitrary embedding dims use the pure-TS router (Router.fromExamples / trainRouter).`,
        );
      }
      throw err;
    }
    const top = res.decisions[0];
    const priceOf = (id: string) => candidates.find((c) => c.id === id)?.costPerMTok;
    return {
      id: top.candidateId,
      confidence: top.confidence,
      uncertainty: top.uncertainty,
      useLightweight: top.useLightweight,
      ...(priceOf(top.candidateId) != null ? { costPerMTok: priceOf(top.candidateId) } : {}),
      inferenceTimeUs: res.inferenceTimeUs,
    };
  }

  /** Circuit breaker health: true = closed (healthy), false = open, null = disabled. */
  circuitBreakerStatus(): boolean | null {
    return this.inner.circuitBreakerStatus();
  }
}

export type RouterBackend = 'native' | 'js';

/**
 * Resolve which routing backend to use. `'auto'` (default) prefers the native
 * FastGRNN when tiny-dancer is installed, else the dependency-free KRR/k-NN path
 * — so callers get the strongest available router without a hard native dep.
 */
export async function resolveRouterBackend(preferred: RouterBackend | 'auto' = 'auto'): Promise<RouterBackend> {
  if (preferred === 'js') return 'js';
  const native = await isNativeRouterAvailable();
  if (preferred === 'native' && !native) throw new Error(NOT_INSTALLED);
  return native ? 'native' : 'js';
}

/** Re-export for callers that want the JS trainer's type alongside the native one. */
export type { TrainedRouter };
