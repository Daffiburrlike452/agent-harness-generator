# ADR-041: MetaHarness as program synthesis + search (not a template generator)

**Status**: Proposed
**Date**: 2026-06-15
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-037–040 (DRACO + cost-optimal routing), ADR-034 (OIA)

---

## Context

MetaHarness today emits a *template* scaffold from a fixed catalog. The stronger
thesis (and the one the DRACO work has been quietly proving) is that harness
generation is **program synthesis under search**: don't "write a scaffold" —
*search* over harness designs, *simulate* tasks, *score* reliability/cost/latency/
safety, *mutate* topology, and emit the best executable artifact + a scorecard.

> Most frameworks say "here is how to build agents." MetaHarness should say:
> "give me a repo — I will infer the work, generate the harness, test it, score
> it, and improve it." The killer feature is the **scorecard**, not generation.

The DRACO investigation already validated the measurement spine of this: an
objective scorer, a per-question oracle, and a cost-optimal router with a
measured oracle gap (ADR-040). That is the "score + route" core of the synthesis
loop, proven on a real task family.

## Decision

Adopt a **proven-algorithm stack** for the synthesis loop, each mapped to an
existing or named component so this is a roadmap, not vibes:

| Stage | Algorithm (proven) | Maps to | ruvector substrate |
|-------|--------------------|---------|--------------------|
| Repo intelligence | AST + dep-graph + README/test discovery | `repo-genome`, `analyze-repo` | — |
| Capability inference | GNN message-passing over the repo graph (learned label propagation) | extend `repo-genome` | **`@ruvector/gnn`** (`RuvectorLayer.forward`) |
| Candidate generation | **beam search** over harness templates | template catalog + walker | — |
| Topology optimization | **MCTS** (UCT) over {add skill/tool/memory/verifier/MCP}, GNN value net | NEW `synth/` | **`@ruvector/gnn`** (partial-topology value) |
| Meta design | **Graph of Thoughts** (nodes = design choices, edges = dep/conflict) | NEW `synth/` | **`@ruvector/gnn`** (differentiable search over the GoT) |
| Execution primitive | **ReAct** (thought → tool → observe → update) | generated harness runtime | — |
| Grounding | **Self-RAG** (retrieve only on uncertainty/novelty/dep-risk) | DRACO retrieval lessons | ruvector HNSW |
| Failure learning | **Reflexion** (structured failure → repair memory) | `@claude-flow` ReasoningBank | ruvector HNSW |
| Routing | **contextual bandits / neural router** | DRACO routing matrix + oracle (ADR-040) | **`@ruvector/tiny-dancer`** (FastGRNN + uncertainty + circuit breaker) |
| Validation | **constraint solving (SAT/CSP)** over hard requirements | NEW `synth/constraints.ts` | — |
| Scoring | deterministic evals + the scorecard | DRACO scorer + `score-harness` | — |

The ruvector family (`@ruvector/gnn` + `@ruvector/tiny-dancer` + ruvector HNSW)
is the proven Rust/NAPI substrate for the graph-intelligence, routing, and memory
stages — so those stages reuse benchmarked native primitives, not bespoke code.

### Reward (topology search) — explicit, tunable

```
R = 0.35·task_success + 0.20·reliability + 0.15·cost_efficiency
  + 0.10·latency + 0.10·security + 0.10·maintainability
```

### Routing: tiny-dancer is the production layer

`@ruvector/tiny-dancer` is a FastGRNN neural router with **uncertainty
estimation + circuit breaker** — exactly the "escalate when the cheap signal is
low" policy `router_v2` (ADR-040) implements by hand. The plan:

1. The DRACO **routing matrix** (per-question × per-model score + pre-signal) is
   tiny-dancer's **eval/training set**; the **oracle** is its upper bound.
2. Replace the hand-rolled `router_v2` (judge-rating + fixed threshold) with
   tiny-dancer's learned router: query embedding + candidate `{id, embedding,
   successRate}` → pick, with uncertainty → escalate and circuit-breaker →
   fallback. Measured as **% of oracle** on the same matrix.
3. This is the bandit/routing stage of the synthesis loop, drop-in proven.

## Consequences

- The differentiator becomes the **scorecard** (harness fit, compile confidence,
  task coverage, tool safety, est. $/run, recommended mode) + the search that
  produced it — not the templates.
- Each stage is an independently testable module with a measured contribution
  (the DRACO discipline: keep only measured wins). No stage ships on vibes.
- Routing reuses a proven library (tiny-dancer) instead of bespoke code.

## Acceptance test (the bar — "anything less is a template generator")

Given **10 unknown GitHub repos**, MetaHarness should generate runnable harnesses where:

```
≥ 8/10 install successfully
≥ 7/10 pass generated smoke tests
≥ 6/10 complete ≥ 3 repo-specific tasks
average generation cost < $0.25
all file writes auditable · all tool calls replayable
```

This ADR is the roadmap; increments land as separate ADRs/PRs, each with the
measured-win discipline.

### First increment — the scorecard: SHIPPED

`metaharness score <repo> [--json]` (`src/repo-scorecard.ts`) is live. It reuses
the no-exec repo analyzer (`inventory` → `analyzeFiles` → `recommendPlan`) and
emits the 6-line card — every dimension derived from real repo signals, not
invented:

```
Scorecard — <repo>  (best-fit archetype: …)
  Harness fit:        N/100   (recommended-archetype match confidence)
  Compile confidence: N/100   (language + build + test + CI signals)
  Task coverage:      N/100   (agents/skills/commands span × observed tokens)
  Tool safety:        N/100   (default-deny policy posture − MCP exposure)
  Memory usefulness:  N/100   (repo scale: files × languages × tokens)
  Est. cost per run:  $N      (agents × budget at the cheap tier — DRACO routing)
  Recommended mode:   CLI | CLI + MCP
```

No-exec (only reads high-signal files), deterministic, `--json` for CI. +9 tests.
Wired into `metaharness score` and the CLI help. The remaining synthesis stages
(beam/MCTS/GoT search, constraint solver) build on this measurement spine.
