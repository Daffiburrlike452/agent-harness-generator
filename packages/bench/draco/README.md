# DRACO — Cross-Domain Benchmark for Deep Research

**DRACO** (Cross-Domain Benchmark for Deep Research) is the quality gate for the
`vertical:research` harness in `agent-harness-generator`. It produces a measured,
re-runnable **DRACO score** — a number backed by a committed corpus, not a narrative.

> ADR-037 is the authoritative design document. This README is the operator reference.

---

## What DRACO measures

Five scoring dimensions per question (0–1 each), mean = DRACO score:

| Dimension | How | Offline? |
|---|---|---|
| **Grounding** | Cited URLs are re-fetched; 404 or content-mismatch = 0 | No (network) |
| **Coverage** | `must_contain` terms present (regex + embedding similarity) | Yes |
| **Balance** | Both positions present for "compare" questions | Yes |
| **Faithfulness** | Independent LLM-judge rates synthesis vs sources | No (LLM) |
| **Efficiency** | Tokens + wall-clock + USD, normalised vs baseline | Yes |

Dimensions 2, 3, 5 are **deterministic** and run offline (`--no-judge`).
Dimensions 1 and 4 require network / API access.

---

## Corpus

`corpus.json` — versioned, checksummed, never silently mutated.
A score is only comparable across runs that share the same `version`.

| Domain | Questions (v1) |
|---|---|
| science | 4 |
| finance | 4 |
| law | 4 |
| current-events | 3 |
| technical | 5 |
| **Total** | **20** |

The corpus checksum is pinned in
`packages/bench/__tests__/draco-corpus.test.ts`. Editing `corpus.json`
without updating the pin **fails CI** — this is intentional.

---

## Running

### M1 — corpus only (this milestone)

```bash
npm run bench:draco          # prints milestone status; no live score yet
```

The runner lands in **M3**. The LLM-judge lands in **M4**. Do not fake a score
before then.

### Future milestones (M3+)

```bash
# Deterministic checks only (offline CI)
npm run bench:draco -- --no-judge

# Single domain
npm run bench:draco -- --domain=science

# Subset of N questions
npm run bench:draco -- --n=5

# Full judged run (requires OPENROUTER_API_KEY in environment)
npm run bench:draco
```

---

## Proof JSON (M4 target shape)

```jsonc
{
  "corpusVersion": 1,
  "harness": { "fusionModels": { "synthesize": "...", "verify": "..." } },
  "score": 0.0,
  "perDomain": { "science": 0.0, "finance": 0.0, "law": 0.0, "current-events": 0.0, "technical": 0.0 },
  "perQuestion": [{ "id": "sci-001", "grounding": 0, "coverage": 0, "balance": 0, "faithfulness": 0 }],
  "efficiency": { "tokens": 0, "usd": 0, "wallMs": 0 },
  "judge": { "model": "...", "version": 1 }
}
```

---

## Milestone status

| Milestone | Deliverable | Status |
|---|---|---|
| M1 | Corpus v1 + schema + checksum gate | **Done** |
| M2 | OpenRouter fusion client + secret gate | Pending |
| M3 | Deterministic scorer + `--no-judge` runner + first baseline | Pending |
| M4 | LLM-judge dimension + full proof JSON | Pending |
| M5 | `harness draco` subcommand + CI job + README score row | Pending |
| M6 | Fusion-vs-single-model ablation (the proof) | Pending |

## Running DRACO (M3)

```bash
npm run bench:draco                              # --no-judge, MOCK transport (offline machinery baseline)
node dist/draco/draco-bin.js --domain=science    # one domain
node dist/draco/draco-bin.js --live --out=draco/runs/$(date +%FT%TZ).json   # REAL run (needs OPENROUTER_API_KEY)
```

**The mock baseline is a machinery floor, not a quality score.** With the mock
transport, every question scores **grounding = 0** and **coverage = 0** — a mock
cannot fabricate citations or rubric terms, so it earns nothing on the
dimensions that require real content. The committed
[`runs/baseline-mock.json`](./runs/baseline-mock.json) records `transport: "mock"`
+ `judged: false`, and a guard test (`draco-scorer.test.ts`) pins those
invariants so a real (`--live`) score can never be committed in its place.

A **real** DRACO score requires `--live` + `OPENROUTER_API_KEY` (sourced from GCP
Secret Manager via the publish-time secret gate; see
`scripts/validate-gcp-secrets.mjs`) **and** the M4 LLM-judge faithfulness
dimension. That is the proof the benchmark is built to earn — it is not faked
along the way.

### Scoring dimensions (M3, deterministic)

| Dimension | How |
|---|---|
| grounding | cited URLs are re-fetched; fraction that resolve. A `must_not` fabrication pattern present hard-zeros it. |
| coverage | fraction of the rubric's `must_contain` terms present (case-insensitive). |
| balance | for questions whose prompt demands multiple positions, are ≥2 present. |
| cleanliness | 1 − fraction of `must_not` anti-patterns present. |
| faithfulness (M4) | an INDEPENDENT LLM-judge (google/gemini-2.5-pro, pinned, a third family distinct from synthesize + verify) rates whether the synthesis is supported by its cited sources. Judged runs fold this into a 5-dimension mean; `--no-judge` omits it. |

Quality score = mean of the four deterministic dimensions on a `--no-judge`
run, or of all **five** (including faithfulness) on a judged `--live` run.
Efficiency (tokens/wall/usd) is reported separately and gated for regression,
not folded into the quality mean.
