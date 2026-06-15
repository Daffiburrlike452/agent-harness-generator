# ADR-006: Memory + Learning Integration

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary §3 Memory), ADR-014 (Self-evolution + federation)

## Context

A harness without memory is a stateless tool. A harness with the wrong kind of memory is a leaky abstraction that forgets what mattered and remembers what should have been thrown away. Ruflo's existing memory stack — AgentDB-backed unified memory, HNSW vector index, ReasoningBank trajectory tracking, the 4-step RETRIEVE / JUDGE / DISTILL / CONSOLIDATE pipeline, EWC++ for catastrophic-forgetting prevention — is the load-bearing reason ruflo gets better at tasks it has seen before.

A generated harness must inherit all of that, with one critical addition: **a memory-decay model that matches the harness's domain.** Trading data ages fast (a successful 2024 strategy is misleading in 2026). Customer-support knowledge ages slowly (an SLA policy from last year is probably still in force). The right decay model is domain-specific; the kernel must support choosing it without bloating the kernel itself.

This is where **`@ruvector/emergent-time@0.1.0`** comes in. As of 2026-06-13 this is live on npm (https://www.npmjs.com/package/@ruvector/emergent-time) — a 55 KB wasm-opt'd module exposing the Agentic Time SDK. It ships from `ruvnet/ruvector` (Rust crate `emergent-time@2.2.4` on crates.io, wasm-bundled via the pipeline ADR-002a documents). The package provides four exported APIs we consume in the kernel:

- **`AgenticClock`** — feeds six-channel state deltas, returns typed ticks, cumulative `agentictime`, the Agentic Time Index (ATI), and a 7-state health classification.
- **`WindowedDeltaClock`** — windowed delta tracking.
- **`PageHinkleyDetector`** — a change-point detector.
- **`LearnedWeights`** — inference helper for learned weights.

All four are `tsc --strict` validated and load in browser / bundler / Node via `initSync()`. This is the wired-in primitive for memory-decay weighting and several adjacent jobs.

The package ships with an honesty caveat in its README: *"diagnostic signal, no proven early-warning lead over a fair baseline."* The kernel's integration of `@ruvector/emergent-time` is therefore treated as a research-grade signal, not a guaranteed performance win, and the more speculative paths (e.g. `LearnedWeights` for self-evolving harnesses) are gated behind feature flags by default. See §Layer 2 below for which API powers which kernel job.

This ADR pins down: which memory primitives ship in the kernel; how a generated harness configures them; how the intelligence pipeline is parameterised per domain; how cross-host shared memory works; and how the learning loop applies at the harness level (with the deeper exotic-mode wiring deferred to ADR-014).

## Decision

### The memory stack in the kernel

`@metaharness/kernel/memory` ships seven layers. Each is independently configurable; together they form the default unified memory.

```
            ┌──────────────────────────────────────────┐
   Layer 7  │  ReasoningBank trajectory tracking       │  Self-learning loop
            │  trajectory.start / step / end           │
            └──────────────────────────────────────────┘
                            │
            ┌──────────────────────────────────────────┐
   Layer 6  │  Intelligence pipeline (4 steps)         │  Per-domain pluggable
            │  RETRIEVE → JUDGE → DISTILL → CONSOLIDATE │
            └──────────────────────────────────────────┘
                            │
            ┌──────────────────────────────────────────┐
   Layer 5  │  Hybrid retrieval                        │  Sparse + dense
            │  BM25 + HNSW + cross-encoder rerank      │
            └──────────────────────────────────────────┘
                            │
            ┌──────────────────────────────────────────┐
   Layer 4  │  HNSW vector index (ruvector NAPI)       │  Pluggable backend
            └──────────────────────────────────────────┘
                            │
            ┌──────────────────────────────────────────┐
   Layer 3  │  Quantization (RaBitQ + int8 fallback)   │  Configurable
            └──────────────────────────────────────────┘
                            │
            ┌──────────────────────────────────────────┐
   Layer 2  │  Emergent-time decay weighting           │  Per-namespace policy
            └──────────────────────────────────────────┘
                            │
            ┌──────────────────────────────────────────┐
   Layer 1  │  AgentDB unified backend (SQLite + agentdb) │  Hybrid storage
            └──────────────────────────────────────────┘
```

The kernel ships all seven. The harness configures each via `harness.config.json` `memory.*`.

### Layer 1 — AgentDB unified backend

The same hybrid backend ruflo's `@claude-flow/memory` already implements (ADR-009 in the v3 ADR set referenced from ruflo, the "Hybrid Memory Backend" decision). SQLite for transactional metadata + AgentDB for vector storage + an optional better-sqlite3 native binding for performance.

The kernel's contract on Layer 1:

- `store(namespace, key, value, tags?, ttl?)` — persist with optional metadata.
- `retrieve(namespace, key)` — fetch by key.
- `search(query, namespaces, limit)` — semantic search across namespaces.
- `delete(namespace, key)` — purge.
- `list(namespace, limit)` — enumerate.

The harness's existing memory CLI surface (`npx <harness> memory store/search/retrieve/list`) is generated against this contract. Every harness gets the same CLI verbs.

### Layer 2 — Emergent-time decay

`@ruvector/emergent-time@0.1.0` (https://www.npmjs.com/package/@ruvector/emergent-time) provides decay weighting based on three signals:

1. **Recency** — how long ago the memory was stored.
2. **Reinforcement frequency** — how often it has been retrieved-and-used since.
3. **Emergent half-life** — a computed half-life that adapts based on the access pattern (frequently-reused memories decay more slowly).

The kernel consumes the SDK directly as a JS dependency (wasm-loaded via `initSync()`). On Node hosts that have a matching NAPI peer available, the loader can fall back to that path; but the wasm primary is the canonical integration. The kernel exposes `decayedWeight(memoryId): number` that returns the current weight of any stored memory, where weight modulates retrieval ranking.

**Which exported API powers which kernel job:**

| Kernel job | `@ruvector/emergent-time` API | Notes |
|---|---|---|
| Memory-decay weighting for HNSW retrieval scoring (the canonical use case) | `AgenticClock` | The Agentic Time Index (ATI) becomes the per-memory decay multiplier. |
| Trajectory step weighting in `recordTrajectory` (ReasoningBank, Layer 7) | `WindowedDeltaClock` | Each step in a trajectory is weighted by its windowed delta — fresher steps carry more signal into DISTILL. |
| DISTILL phase firing trigger | `PageHinkleyDetector` | The change-point detector decides when accumulated trajectory evidence has shifted enough to warrant re-distillation, rather than running DISTILL on a fixed cadence. |
| Self-evolving harness mode (feature-flagged; see ADR-014) | `LearnedWeights` | Reserved for harnesses with `--features self-evolution`; the learned-weights inference helper feeds the self-evolution loop's decay-rate optimisation. |

The first three are wired in the kernel by default. `LearnedWeights` is gated behind `selfEvolution.enabled: true` (ADR-014) — the README's honesty caveat (no proven early-warning lead) applies most strongly to that path.

A harness configures decay per memory namespace in `harness.config.json`:

```jsonc
{
  "memory": {
    "decay": {
      "patterns": { "halfLifeHours": 720, "reinforceMultiplier": 1.5 },     // Default: 30-day decay, reinforcement extends
      "tasks":    { "halfLifeHours": 168, "reinforceMultiplier": 1.2 },     // Tasks fade in a week
      "feedback": { "halfLifeHours": null, "reinforceMultiplier": 1.0 },    // Feedback never decays
      "market":   { "halfLifeHours": 24,  "reinforceMultiplier": 1.0 }      // Trading: 1-day half-life, no reinforcement bonus
    }
  }
}
```

`halfLifeHours: null` means no decay; the memory persists at full weight forever. Domain-specific defaults are shipped with vertical packs (ADR-013): the `@metaharness/vertical-trading` pack ships short half-lives by default; `@metaharness/vertical-legal` ships long ones.

The emergent-time decay model differs from a naive exponential because the `reinforceMultiplier` lets frequently-accessed memories extend their half-life adaptively. A pattern retrieved 100 times across 30 days has, in effect, an emergent half-life much longer than 30 days; one stored once and never read decays at the configured rate. This matches research on emergent / spaced-repetition memory models more than a fixed-window cache eviction.

### Layer 3 — Quantization

The kernel exposes both int8 (the ruflo-measured 3.84× compression with cosine 0.99999 reconstruction) and RaBitQ (32× compression at 0.60 ms/query in a 14,760-vector index, per ruflo's existing intelligence-system audit). The harness selects via `harness.config.json` `memory.quantization`:

- `"none"` — full-precision float32 vectors. Maximum recall, maximum memory.
- `"int8"` — default. 4× smaller, near-identical recall.
- `"rabitq"` — 32× smaller, slight recall hit. Recommended above ~100k vectors.

The composer warns when the user picks `none` for a `harness.config.json` that suggests large memory needs (e.g. `--features federated-memory`).

### Layer 4 — HNSW index

The kernel uses the ruvector NAPI-backed HNSW index, with the measured-vs-brute-force crossover documented in the ruflo CLAUDE.md: HNSW wins above N≈5k with ~3.2× to ~4.7× speedup, and at N=20k delivers ~1.9× with recall@10 ~0.99. Below crossover the kernel falls back to brute force automatically. Reference: Malkov & Yashunin, "Efficient and robust approximate nearest neighbor search using Hierarchical Navigable Small World graphs," https://arxiv.org/abs/1603.09320.

### Layer 5 — Hybrid retrieval

Sparse BM25 (Lucene-style) plus dense HNSW plus cross-encoder reranking, exactly as ruflo's `hybrid-retrieval.ts` already implements. The kernel ships this verbatim; the harness inherits.

Configurable weights:

```jsonc
{
  "memory": {
    "retrieval": {
      "sparseWeight": 0.3,
      "denseWeight": 0.7,
      "rerankTopK": 50,
      "rerankModel": "bge-reranker-base"
    }
  }
}
```

Default values come from ruflo's grid-search results (ADR-082 in the v3 ADR set).

### Layer 6 — The 4-step intelligence pipeline

```
RETRIEVE      Fetch relevant patterns via Layer 5.
                 ↓
JUDGE         Evaluate the candidate against current context.
              Verdict: success / failure / inconclusive.
              Pluggable: each harness ships its own judge for its domain.
                 ↓
DISTILL       Extract the durable learning from the trajectory.
              The default DISTILL is a LoRA-style adapter on patterns.
              Pluggable: vertical packs ship domain-specific distillers.
                 ↓
CONSOLIDATE   Update the long-term store without destroying prior learning.
              Uses EWC++ (elastic weight consolidation).
              Not pluggable: kernel's default is good enough.
```

The pluggable nodes (JUDGE, DISTILL) are the path to vertical-specific intelligence. A trading harness's JUDGE asks "did this strategy beat the benchmark this week?" A legal harness's JUDGE asks "did this answer hold up under attorney review?" The kernel ships interfaces; the harness ships implementations.

```ts
// @metaharness/kernel/memory/intelligence.ts (simplified)
export interface JudgeProvider {
  evaluate(trajectory: Trajectory): Promise<Verdict>;
}

export interface DistillProvider {
  extract(trajectory: Trajectory, verdict: Verdict): Promise<Pattern>;
}

// Harness wires in custom providers:
import { configureIntelligence } from '@metaharness/kernel/memory';
import { TradingJudge, TradingDistiller } from '@acme/trading-intelligence';

configureIntelligence({
  judge: new TradingJudge(),
  distill: new TradingDistiller(),
});
```

The default JudgeProvider is a verdict heuristic on the trajectory's `status` field. The default DistillProvider is a LoRA-style pattern adapter. Both are good enough for the trivial-tier harness; both are replaced for the exotic-tier.

### Layer 7 — ReasoningBank trajectory tracking

The kernel exposes the trajectory API ruflo already implements:

```ts
const trajId = await trajectory.start({ goal: '...', agent: '...' });
await trajectory.step(trajId, { action: '...', result: '...', quality: 0.85 });
await trajectory.end(trajId, { status: 'success' });
```

Every step's `action` and `result` are passed through the kernel's `scrubReasoningBlocks` (per ADR-004 §Hermes) before storage. This is non-optional: the DISTILL step embeds the trajectory text, and contamination from `<think>` blocks degrades pattern confidence.

The kernel also ships `trajectory.replay(trajId)` for retrospective analysis. Replays power the "did this strategy work last quarter?" queries that vertical-specific JUDGEs need.

### Cross-host shared memory

A generated harness's memory is **single-instance per harness installation**. The same physical AgentDB lives at `${HARNESS_DATA_PATH}/memory/` (default: `./data/memory` per ruflo's `CLAUDE_FLOW_MEMORY_PATH` env var convention). It is shared across the host invocations of that harness — a session under Claude Code and a session under Codex hit the same database.

This is the load-bearing payoff of the kernel design. The harness's intelligence pipeline is host-agnostic. The learning a user gets from one host carries into another.

A user with multiple harness installations (one per project) gets isolated memories per harness. A user who wants cross-harness sharing opts into federation (ADR-014) and shares via the federation transport.

### Memory namespaces

The kernel ships a standard namespace set:

| Namespace | Purpose | Default decay |
|---|---|---|
| `patterns` | Distilled learnings from successful trajectories. | 30-day half-life, reinforced |
| `tasks` | Recent task history. | 7-day half-life |
| `feedback` | Explicit user feedback (thumbs-up/down). | No decay |
| `claude-memories` | Bridged Claude Code auto-memory (ruflo's existing bridge). | 30-day half-life |
| `auto-memory` | Bridged automatic memory from other hosts. | 30-day half-life |
| `verifications` | Witness-verification telemetry. | No decay |
| `federation` | Federation-shared state. | Configurable; see ADR-014. |

A harness adds its own namespaces in `harness.config.json` `memory.namespaces`. The vertical packs ship their own.

### Memory bridge with Claude Code's auto-memory

Ruflo already bridges Claude Code's `~/.claude/projects/*/memory/*.md` into AgentDB (per the `CLAUDE.md` §Claude Code ↔ AgentDB Memory Bridge section, MCP tool `memory_import_claude`). The kernel ships this bridge. A generated harness that selects the Claude Code adapter (ADR-004) gets the bridge wired automatically. The MCP tool name and behaviour are unchanged.

### Pretraining and pattern transfer

The kernel exports `hooks.pretrain(history)`, which seeds the intelligence pipeline from a history corpus (the ruflo `hooks pretrain` command, generalised). A new harness installation typically does not start cold — the generator can seed it with patterns from:

- A vertical-pack corpus (each pack ships a small bootstrap pattern set; see ADR-013).
- A previous harness's export (`npx <harness> memory export | npx <other-harness> memory import`).
- An IPFS-distributed pattern bundle (the `hooks transfer` flow, generalised; cross-project pattern transfer per ruflo's existing `intelligence-transfer` skill).

The user picks none, one, or several of these at generation time. The composer surface is a multi-select on the "intelligence bootstrap" stage.

### Memory and the witness manifest

A subset of memory entries are witness-attested. By default: entries in the `verifications` namespace. A harness operator who wants strong attestation on more namespaces configures it in `harness.config.json`. The witness scripts (ADR-011) treat attested memory as part of the manifest. The same Ed25519 signature covers the whole manifest. Adversarial mutation of attested memory invalidates the signature.

## Consequences

### What gets easier

- **Domain-specific intelligence without forking the kernel.** A trading harness gets a trading JudgeProvider, the kernel is unchanged.
- **Cross-host continuity.** A user who hops between Claude Code and Codex on the same harness sees the same memory.
- **Bootstrapping from corpora.** New harnesses start non-cold via vertical-pack pattern bundles.
- **The decay knob is honest.** No "memory stays forever" lie — every namespace declares its half-life or explicitly opts out.

### What gets harder

- **`@ruvector/emergent-time` adds one more npm dependency.** Because it ships as a wasm npm package (not a native binding), it works on every platform Node, Bun, Deno, browser, and edge runtimes support, without per-platform binaries. The trade-off is wasm cold-start cost (one-time `initSync()` on first call). On unsupported platforms (extremely rare; the wasm bundle works almost everywhere), the kernel falls back to a pure-JS exponential-decay implementation (lower quality but functional).
- **Vertical packs that ship custom DISTILLers raise the test surface.** Each pack's DISTILL implementation must pass the kernel's intelligence-pipeline contract test (ADR-010).
- **Namespace explosion.** Without discipline, a harness with 30 plugins has 50 namespaces. The composer surfaces namespace count and warns when crossing thresholds.

### What does not change

- The MCP tool surface for memory is the same: `memory_store`, `memory_search_unified`, `memory_import_claude`, the trajectory tools. Existing ruflo skills work unchanged.
- The measured HNSW / quantization numbers from ruflo's intelligence-system audit apply unchanged — same backend.

## Alternatives Considered

### Alternative 1: Skip emergent-time; use a fixed exponential half-life

Simpler, fewer dependencies. Rejected because (a) the trading vs legal example is not hypothetical — the half-life axis is real and one number does not fit; (b) `@ruvector/emergent-time@0.1.0` is already shipping (live on npm as of 2026-06-13) and is the working precedent for the wasm pipeline ADR-002a documents — we are not gambling on an aspirational dependency; (c) the pure-JS fallback gives us the simple-exponential option for users who do not need the adaptive behaviour, so we keep the option without losing it.

### Alternative 2: Ship multiple memory backends (Postgres, Redis, S3) in the kernel

A more pluggable backend layer. Rejected for v1.0 because AgentDB + SQLite already covers the harness use case (single-machine, embedded storage), and supporting Postgres / Redis introduces a network dependency the trivial-tier harness should not have to think about. A future ADR can add a `MemoryBackend` interface if a real user pull emerges. For now, AgentDB is the one backend, configurable but not pluggable.

### Alternative 3: Make JUDGE and DISTILL non-pluggable

Ship one default JUDGE (trajectory-status heuristic) and one default DISTILL (LoRA adapter). Rejected because the vertical-specific intelligence use case is one of the exotic-tier promises (ADR-001 §From practical to exotic). If a vertical pack cannot replace JUDGE / DISTILL, vertical packs become brand stickers on otherwise-identical harnesses, which defeats the point.

### Alternative 4: Centralise memory in a hosted service

A cloud-hosted memory backend that every harness installation writes to. Rejected because (a) it imposes a network dependency on every install, (b) it centralises user data in a single trust domain, and (c) federation (ADR-014) gives the same multi-instance-sharing benefit without the trust concentration. Federation is opt-in; a hosted service would be opt-out.

### Alternative 5: Do not bridge Claude Code's auto-memory

Skip the existing ruflo bridge. Rejected because it is one of the few things existing ruflo users rely on daily, and removing it would break ADR-016's no-loss migration promise. The bridge stays.

## Test Contract

This ADR is satisfied when the following exist:

### Layer-isolated tests (London-school)

1. **Layer 1 round-trip** — `store / retrieve / delete / list` across namespaces, against a real AgentDB.
2. **Layer 2 decay correctness** — given a fixture of memory entries with timestamps, the decayed weight at `now+1d`, `now+30d`, `now+365d` matches expected values for each decay configuration. Both `@ruvector/emergent-time@0.1.0` (wasm) and the pure-JS exponential-decay fallback must pass. Additionally: `AgenticClock` produces the expected ATI on the canonical six-channel test fixture; `WindowedDeltaClock` produces expected windowed weights; `PageHinkleyDetector` fires a change-point on a fixture with a known regime shift.
3. **Layer 3 quantization round-trip** — int8 and RaBitQ both reconstruct vectors within the cosine thresholds ruflo's audit specifies.
4. **Layer 4 HNSW** — recall@10 ≥ 0.99 on the BEIR-like test fixture, search time below the brute-force crossover specified in the ruflo intelligence audit.
5. **Layer 5 hybrid retrieval** — sparse+dense+rerank yields the expected ordering on a labelled fixture.
6. **Layer 6 intelligence pipeline contract** — given a mock JudgeProvider and DistillProvider, the 4-step pipeline calls them in the right order with the right arguments, persists the right pattern.
7. **Layer 7 trajectory tracking** — start / step / end round-trip; `scrubReasoningBlocks` is applied at every step boundary; replay returns the original sequence.

### Cross-layer integration tests

8. **End-to-end search** — store 1000 fixtures across 5 namespaces with varying decay configs, search with a query, assert the top-K reflects both semantic relevance and decay weighting.
9. **Cross-host memory continuity** — open a session under the Claude Code adapter, store entries, close. Open a session under the Codex adapter, search — the entries are visible. (Same test as ADR-004 §Test Contract; cross-referenced here for completeness.)

### Vertical-pack contract test

10. **A vertical pack's custom JUDGE / DISTILL** passes the kernel's intelligence-pipeline contract test. The vertical packs ship their test fixtures; the kernel runs them against the pack's implementation.

### Performance gates

11. **Search latency** — at N=20k vectors, P95 ≤ 5 ms (matches ruflo's measured numbers).
12. **Pretrain latency** — pretrain from a 10,000-trajectory corpus finishes in ≤ 30 seconds on the CI runner.

## References

### Ruflo internals cited

- `v3/@claude-flow/cli/src/memory/*` — all seven kernel layers extracted from here.
- `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts` — the `scrubReasoningBlocks` function used at trajectory boundaries.
- `v3/@claude-flow/memory/*` — the AgentDB binding the kernel inherits.
- CLAUDE.md §Intelligence System (RuVector) — the measured numbers we promise to maintain.
- CLAUDE.md §Claude Code ↔ AgentDB Memory Bridge — the existing bridge the kernel ships.

### Ruflo ADRs cited

- ADR-006 (Unified Memory Service) in the v3 set.
- ADR-009 (Hybrid Memory Backend) in the v3 set.
- ADR-078 (Hybrid retrieval and outcome signal).
- ADR-080 (Cross-encoder reranker).
- ADR-082 (Grid-search retrieval defaults).
- ADR-088 (Lucene BM25 and rerank).

### External prior art

- **`@ruvector/emergent-time@0.1.0`** (live npm wasm package — the integration we ship): https://www.npmjs.com/package/@ruvector/emergent-time.
- `emergent-time` Rust crate (the source the wasm package is built from): https://crates.io/crates/emergent-time, https://docs.rs/emergent-time.
- Source repo (wasm wrapper at `crates/emergent-time-wasm`, npm at `npm/packages/emergent-time`): https://github.com/ruvnet/ruvector. PR #566 contains the wasm package source.
- HNSW paper: Malkov & Yashunin, https://arxiv.org/abs/1603.09320.
- RaBitQ paper: https://arxiv.org/abs/2405.12497 (the random-bit quantization technique).
- ReasoningBank — see the ruflo intelligence audit at `docs/reviews/intelligence-system-audit-2026-05-29.md`.
- Mem0 paper: https://arxiv.org/abs/2504.19413 — memory consolidation in agent systems, the reference for the CONSOLIDATE step.
- EWC paper (elastic weight consolidation): Kirkpatrick et al., https://arxiv.org/abs/1612.00796.
- Spaced repetition / forgetting-curve research: Ebbinghaus's original (1885), the modern SuperMemo SM-2 algorithm — context for the emergent-time approach.

### Memory / agent-memory research

- **Mem0** (https://arxiv.org/abs/2504.19413) — memory consolidation in agent systems. Reported results: **+26% LLM-as-Judge over OpenAI memory baseline; 91% lower p95 latency; >90% token-cost reduction.** The reference our CONSOLIDATE step targets.
- **ReasoningBank** (Google Research, https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/) — enables agents to learn from experience. Reported results: **+8.3pp on WebArena with k=1 retrieval per task — retrieving more memories hurts performance.** This is the load-bearing finding behind our default `retrieval.rerankTopK` and per-task retrieval cap. ADR-006 commits to k=1 as the safe default for the trivial-tier harness; vertical packs may override with measured justification.
