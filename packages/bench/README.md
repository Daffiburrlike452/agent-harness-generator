# @metaharness/bench

Reproducible memory-retrieval benchmark for the kernel's HNSW + decay pipeline.

## Run

```bash
npm run build && npm run bench
```

Tweak corpus + query counts via env vars:

```bash
BENCH_ITEMS=5000 BENCH_QUERIES=1000 BENCH_OUT=./report.json npm run bench
```

Output is a deterministic JSON report. Reproducible across CI runners.

## What it measures

Six configurations are scored side-by-side:

| Config | k | Decay |
|---|---|---|
| 1 | 1 | off |
| 2 | 1 | on |
| 3 | 3 | off |
| 4 | 3 | on |
| 5 | 10 | off |
| 6 | 10 | on |

Per config: `recall@k`, `MRR`, `p50_latency_ms`, `p95_latency_ms`, plus per-category breakdown across `single-hop`, `temporal`, `multi-hop`, `open-domain` evals.

## Baselines we compare against (in the report header)

| Source | What they reported |
|---|---|
| [Mem0](https://arxiv.org/abs/2504.19413) | +26% LLM-as-Judge over OpenAI memory baseline; 91% lower p95 latency; >90% token cost reduction |
| [ReasoningBank](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/) | +8.3pp on WebArena with Gemini-2.5-Flash; **k=1 retrieval is optimal — more memory hurts** |

We don't run Mem0 or ReasoningBank in CI (their API keys + workloads aren't accessible from our test harness). The bench reproduces the EXPERIMENT SHAPE — same category mix, same retrieval-quality metric — so you can sanity-check the kernel's decay-vs-no-decay and k=1-vs-k=N empirically.

## What the ReasoningBank k=1 finding predicts

If `k=1 recall >= k=10 recall - epsilon` on the temporal category, the ReasoningBank result reproduces in our shape. If not, the decay path is over-eager or the corpus is too dense.

## DRACO — deep-research benchmark + the beyond-SOTA findings

`src/draco/` is a second, independent benchmark: a cross-domain deep-research
gate (science / finance / law / current-events / technical) that scores a cited
dossier on grounding, coverage, balance, cleanliness, and faithfulness, with
live OpenRouter model fusion. See ADR-037 for the design.

**The honest result (ADR-038, ADR-039 — measured, not gamed):**

- **Quality ceiling.** A single well-prompted frontier call is *unbeatable on
  score*. Across 4 frontier runs every harness/fusion/refine/select arm landed
  at or below vanilla (within its own ±0.02 between-run noise). The mechanism:
  `grounding = (live URLs)/(total URLs)` is a fraction, so transforms lose live
  URLs, selection is capped by the best draw, and union can only dilute. The
  benchmark *falsified* the harness-beats-vanilla thesis with a mechanism.
- **Cost win (the real "beyond SOTA").** A cheap model (haiku-4.5) produces a
  HIGHER-quality dossier than a frontier model (opus-4) at **~10× lower cost**
  (`+0.042` quality, `10.6×` more quality-per-dollar). The frontier *fusion*
  harness costs **≥250×** the cheap direct call and scores **worse**. For
  DRACO-style factual dossiers: route to a cheap model and ask directly.

```bash
# Offline cost-efficiency report from committed run artifacts (no API spend):
node dist/draco/draco-bin.js --cost-report

# Re-run a live arm (needs OPENROUTER_API_KEY): --threeway | --augment | --selfcon [--composite]
DRACO_CONCURRENCY=4 node --env-file=../../.env dist/draco/draco-bin.js --threeway --live
```

Run artifacts: `draco/runs/*.json`. Arms are tested + offline-mockable; CI runs
the full suite so no result regresses. Findings gist + ADR-038/039 carry the
full evidence.

## License

MIT
