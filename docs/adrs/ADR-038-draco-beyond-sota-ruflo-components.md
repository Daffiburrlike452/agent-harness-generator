# ADR-038: DRACO beyond-SOTA — optimizing the research harness with ruflo intelligence components

**Status**: Proposed
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Supersedes**: none
**Related**: ADR-037 (DRACO benchmark), ADR-009 (intelligence pipeline), `vertical:research` template

---

## Context

ADR-037 established DRACO: a cross-domain deep-research benchmark with a
three-way ablation — **vanilla < harness < fusion+harness** — scored on five
dimensions (grounding, coverage, balance, cleanliness, faithfulness). The
benchmark exists; the open question is **can the harness beat SOTA, and if not,
what makes it beat SOTA?**

Measured so far (honest, not gamed):

- **Cheap tier (n=20)** — haiku-4.5 / gpt-5-mini / gemini-2.5-flash: the thesis
  did **not** hold. Ordering inverted: vanilla 0.7788 > harness 0.7611 > fusion
  0.7594. The extra dossier-rewriting stages added scorer-penalised noise
  without a compensating grounding/faithfulness gain on weak models.
- **Frontier tier (n=20)** — opus-4 / gpt-5 / gemini-2.5-pro: baseline run in
  progress; recorded in `packages/bench/draco/runs/threeway-frontier-full.json`.

The directive: **keep running until the benchmark meets or beats SOTA, and use
ruflo components to get there.** "SOTA" for DRACO = the fusion+harness arm
strictly beating both vanilla and the single-model harness at frontier tier,
with margin, on the same corpus + scorer.

A single-model pipeline with extra steps is not enough — the cheap-tier result
proves structure alone can hurt. The harness needs components that add *real*
signal: independent verification that actually catches errors, memory that
reuses what worked, and routing that puts the right model on each sub-task.
That is exactly what the ruflo intelligence stack provides.

## Decision

Improve the DRACO research harness by applying **ruflo intelligence components**
(the RETRIEVE → JUDGE → DISTILL → CONSOLIDATE pipeline, HNSW/ReasoningBank
memory, MoE/SONA routing) as native, dependency-injected, offline-testable
modules in `packages/bench/src/draco/`. Each is an independent ablation arm so
its contribution is **measured**, never assumed.

### Improvement 1 — Self-consistency JUDGE selection (RETRIEVE→JUDGE)

Generate `N` candidate dossiers per question with varied decomposition
(temperature / sub-query diversity), score each with the independent judge, and
select (or fuse) the highest-faithfulness candidate. Directly targets the two
dimensions a single pass cannot self-correct: faithfulness and grounding.
Mechanism: ruflo's JUDGE step over a candidate set.

### Improvement 2 — Memory-augmented retrieval (HNSW / ReasoningBank)

Maintain a cross-question memory of high-grading sources and winning synthesis
strategies (NOT answers — questions are independent, no answer leakage). Before
synthesis, RETRIEVE the most relevant prior *strategies* via HNSW and inject
them as guidance. CONSOLIDATE after each question. Targets coverage + balance.

### Improvement 3 — MoE / SONA per-stage model routing

Learn, from per-stage scoring outcomes, which model family is strongest for each
stage and route accordingly (cheap for decompose/cite, strong+independent for
synthesize/verify). Targets cost-efficiency and grounding. Mechanism: ruflo MoE
gate + SONA adaptation over the per-stage reward signal.

### Iteration protocol (the 15m loop)

1. Run / read the latest DRACO frontier three-way.
2. If fusion does not beat vanilla AND the single-model harness with margin,
   integrate the next improvement arm, with tests, behind a flag.
3. Re-benchmark that arm vs. baseline on the same corpus. Keep only measured
   wins; discard or revert measured non-wins (honest — the cheap-tier inversion
   is the precedent).
4. Push to main, update this ADR's results table, open/update the tracking
   issue + gist, extend the CI guard.

## Consequences

- Every improvement is a **measured** ablation arm, not an assertion. A
  component that does not move the score is removed, exactly as the cheap-tier
  fusion arm would be if it never recovered.
- Offline-testability is preserved: all model + memory + judge calls go through
  injected transports, so the bench suite runs with mocks and no API key.
- **CI guard (no regression):** `.github/workflows/draco.yml` gains a
  deterministic offline assertion that each shipped improvement arm beats its
  baseline on a fixed mock fixture, plus the existing judged-run cadence for the
  live number. A merged improvement cannot silently regress.

## Results (living — updated each iteration)

| Tier | vanilla | harness | fusion+harness | thesis | notes |
|------|---------|---------|----------------|--------|-------|
| cheap n=20 | 0.7788 | 0.7611 | 0.7594 | NO | structure hurt on weak models |
| frontier n=20 (baseline) | 0.7143 | 0.6126 | 0.6472 | NO | harness DEGRADES −0.10 vs vanilla; fusion recovers +0.035 but still < vanilla. ordering: harness < fusion < vanilla |

### What the baseline tells us (the real target)

The harness loses to vanilla at BOTH tiers, and at frontier the gap is large
(−0.10). Root cause hypothesis: the decompose→search→grade→synthesize chain
forces the synthesizer to work from an intermediate "graded sources" summary
with **no real web retrieval**, so it loses the grounding (real, re-fetchable
URLs) that a single direct "write a cited dossier" call produces. Fusion's
independent verifier recovers ~0.035 by pruning unsupported claims, but cannot
restore the lost grounding.

**Revised optimization target:** the harness must AUGMENT the strong direct
dossier, not REPLACE it through lossy stages. The first arm (below) tests this
directly: keep vanilla's grounding, add an independent verify+prune pass that
only raises cleanliness/faithfulness without rebuilding (and discarding) the
dossier. Self-consistency selection (best-of-N judged) is the second lever.
