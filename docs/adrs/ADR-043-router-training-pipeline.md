# ADR-043: Router training pipeline — kernel ridge regression over the routing dataset

**Status**: Accepted
**Date**: 2026-06-15
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-040 (cost-optimal routing), `@metaharness/router`, `@ruvector/tiny-dancer`

---

## Context

`@metaharness/router` ships a **k-NN** router: predict each candidate model's
quality on a query by averaging the k nearest labelled examples. ADR-040 measured
its ceiling — best learned router 92% of oracle on n=20, with a learning curve
still rising. The natural next step is a *trained* model that generalises better
than k-NN on small data, and a pipeline that produces it from the routing dataset
(the `(query embedding → per-model quality)` rows the DRACO benchmark emits).

Two non-starters: (1) `@ruvector/tiny-dancer` cannot train **or persist** a model
today. Confirmed in `ruvector-tiny-dancer-core` (not just the npm package): BPTT
gradients in `training.rs::train_batch` are a placeholder stub (`// simplified -
in practice would use BPTT`), `model.rs::save()` is a `// TODO` no-op (safetensors
isn't even a dependency), and napi exposes only `Router`/`version`/`hello`. So the
crate's `Trainer`/`AdamOptimizer` scaffolding doesn't actually learn, and an
in-memory model can't be saved. Three gaps (real gradients, real persistence,
exposed training), not one. (2) A plain linear/MLP on raw 1536-dim embeddings with
n≈20 is hopelessly underdetermined (1536 weights, 20 samples) — overfit or collapse
to the mean.

This pipeline therefore does NOT depend on tiny-dancer's trainer. It trains a real
router **in pure TS, today**. tiny-dancer remains the native production upgrade
once its crate gaps are closed (ordered: safetensors save/load → napi `train`+`save`
export → real BPTT → a DRACO→`TrainingDataset` adapter); A+B alone would let
tiny-dancer load an externally-trained FastGRNN (e.g. from this dataset via a
Python/RuvLTRA trainer) before in-stack training lands.

## Decision

Train with **kernel ridge regression (KRR) using a cosine kernel** — the
principled, regularised generalisation of k-NN:

- Per candidate model M, features for a query are its cosine similarities to the
  training queries (the kernel trick); k-NN is the unregularised, hard-windowed
  special case. KRR replaces the hard k-window with a soft, λ-regularised fit.
- Closed form: dual coefficients `α = (K + λI)⁻¹ y`, where `K_ij = cos(x_i, x_j)`
  (n×n Gram matrix) and `y` is M's qualities. Prediction for a new query `x*`:
  `ŷ_M(x*) = Σ_i α_i · cos(x*, x_i)`. For n≈20 the solve is a trivial Gaussian
  elimination — pure TS, no native deps, runs anywhere `@metaharness/router` does.
- The router then routes cost-optimally: cheapest candidate whose predicted
  quality clears the bar (or best-predicted).

**Why KRR is the right call on small data:** λ directly controls the
bias–variance trade-off that sank the raw TF k-NN (ADR-040). At λ→0 KRR ≈ k-NN
(low bias, high variance); larger λ regularises toward the mean (lower variance).
The pipeline **optimises λ by leave-one-out cross-validation** on the dataset, so
the regularisation is fit, not guessed.

## Pipeline

```
dataset (rows of {embedding, scores: {model: quality}})
  → for each candidate model: KRR fit (sweep λ, pick best by LOO routing quality)
  → TrainedRouter (per-candidate α + training embeddings + cost) — serialisable JSON
  → route(queryEmbedding): cost-optimal pick from predicted qualities
```

The trained model serialises to JSON (the α coefficients + reference embeddings),
so it is portable and reproducible. The same dataset is also the training set for
a future tiny-dancer FastGRNN model — this pipeline does not block on it.

## Consequences

- A *trained*, regularised router that should match or beat k-NN toward the
  oracle, with λ fit to the data — and the honest expectation, on n≈20, that the
  win is bounded by the same data ceiling (the learning curve), so the value
  compounds as the corpus grows.
- Pure-TS, dependency-free, offline-testable; ships in `@metaharness/router`
  alongside the k-NN router (caller picks). Validated on the committed DRACO
  dataset (LOO vs k-NN vs oracle) and CI-guarded.
- A clean serialisable model artifact — the substrate for swapping in a native
  tiny-dancer model later without changing the routing API.

## Result (measured, validated on the committed DRACO dataset)

LOO routing quality, n=20, pool haiku-4.5 / gpt-5 / opus-4:

| router | quality | % oracle-q |
|--------|---------|-----------|
| best fixed model (opus) | 0.6960 | 91% |
| k-NN embedding router (ADR-040) | 0.7048 | 92% |
| **trained KRR router (λ=0.3, LOO)** | **0.6964** | **91%** |
| oracle | 0.7682 | 100% |

As predicted: KRR ties the best fixed model and is on par with k-NN — **the n=20
data ceiling, not a pipeline failure** (the LOO-chosen λ=0.3 is moderate
regularisation because the kernel can't learn much structure from 20 points). The
pipeline's value is that it is the regularised, *trainable, serialisable* router
that **scales**: as the corpus grows, KRR's λ-controlled bias–variance generalises
where k-NN overfits (ADR-040's learning curve). Shipped in `@metaharness/router`
(`trainRouter` / `TrainedRouter`, `toJSON`/`fromJSON`), 6 training tests + the
DRACO validation.

## Honest guardrail

KRR over n≈20 cannot manufacture signal that isn't there; the tie above is the
data ceiling (ADR-040), and the pipeline is the thing that *pays off* when the
corpus is scaled. We report the measured LOO number, win or tie — here, a tie.

---

## Native backend — SHIPPED (tiny-dancer 0.1.21)

The "substrate for swapping in a native tiny-dancer model later" is now wired.
`@ruvector/tiny-dancer@0.1.21` shipped a real native (Rust/NAPI, 8 platforms)
FastGRNN **trainer** — gradients + Adam + `.safetensors` persistence — that
consumes the **exact `{ embedding, scores }` DRACO row shape** this package
already uses. `@metaharness/router` now exposes a lazily-loaded adapter to it
(`src/native.ts`):

| export | does |
|--------|------|
| `isNativeRouterAvailable()` / `nativeRouterVersion()` | probe the optional engine |
| `trainNativeRouter(rows, prices, { outputPath, … })` | native FastGRNN train → `.safetensors` |
| `NativeRouter.load({ modelPath })` / `.route(query, candidates)` | load + route natively |
| `resolveRouterBackend('auto')` | `'native'` when installed, else `'js'` |

tiny-dancer is an **optional peer** — never a hard dependency — so a generated
harness that only needs the dependency-free KRR/k-NN router pulls nothing native;
the adapter degrades to a clear error (or `available = false`) when it is absent.
Validated by `__tests__/native.test.ts`: when the binary loads it runs the genuine
train → persist → load → route arc (train accuracy → ~1.0 on a separable set);
when absent the train/load/`resolveRouterBackend('native')` paths reject with an
actionable message. 21 router tests total.

### Honest constraint (measured, reported upstream)

Native **training, persistence, and load** are fully functional at any embedding
dimension. Native **route**, in tiny-dancer 0.1.21, is dimension-locked: the route
path engineers a **fixed 5-feature relational vector** (verified independent of
embedding dim and candidate count), while `trainRouter` trains on the raw
`inputDim`. So an end-to-end native route succeeds **only when the model is trained
at `inputDim = 5`** — on real DRACO embeddings (1536-dim) native route raises a
dimension mismatch. The adapter catches that cryptic native error and rethrows a
clear one pointing at the cause + the pure-TS fallback. **Therefore the production
router for arbitrary high-dim embeddings remains the pure-TS KRR/k-NN path**; the
native backend ships as available + validated, with high-dim native routing
tracked pending an upstream train↔route feature-dim alignment. No result is
gamed: native training is real, the route constraint is reported as found.
