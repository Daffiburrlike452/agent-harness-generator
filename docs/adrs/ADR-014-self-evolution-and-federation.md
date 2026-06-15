# ADR-014: Self-Evolution + Federation (Exotic Compositions)

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-006 (Memory + learning), ADR-002 (Kernel boundary), ADR-011 (Witness)

> This ADR covers two of the user prompt's exotic-tier compositions: a harness that uses its learning loop to optimise its own routing over time, and a harness that runs as multiple federated instances. Both lean heavily on kernel mechanisms already specified in earlier ADRs; this ADR pins what changes at the harness level when those features are turned on, and where the trade-offs live.

## Context

### Self-evolution

Ruflo's intelligence pipeline (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE, per ADR-006) already trains pattern adapters from trajectories. A successful trajectory is rewarded; a failed one is downweighted. Over time, the pattern set the kernel retrieves at the start of a task is biased toward what has worked before.

This is "self-evolution at the task level." A harness gets better at writing tests because past successful tests inform the next test. The exotic-tier promise is the same loop applied **at the harness's own configuration level**:

- The harness adjusts its 3-tier routing thresholds based on observed cost/quality trade-offs.
- The harness adjusts its memory decay rates based on which patterns turn out to be reused.
- The harness adjusts its hybrid-retrieval weights (sparse vs dense) based on what produced relevant results.

This is "the harness optimises its own knobs." It is a level of indirection above pattern-level learning. The mechanisms are similar — measure outcome, reward / penalise, distill — but the subject is the harness's configuration, not the harness's tasks.

### Federation

Multiple instances of the same harness, running across different physical locations or organisational boundaries, coordinate. The exotic-tier use case: "my legal harness is on-prem (for client confidentiality); my legal harness is also in the cloud (for ad-hoc research); the two share patterns about what worked, without sharing the underlying client data." Federation is the transport that lets harnesses talk to each other.

Ruflo already has federation infrastructure (per the v3 ADRs ADR-101 federated claims, ADR-104 wire transport, ADR-105 v1 state snapshot, ADR-107 federation TLS, ADR-108 native QUIC binding, ADR-111 WG mesh — referenced by number in ruflo's v3 ADR set). The kernel inherits this.

This ADR specifies what changes at the harness level when self-evolution and federation are enabled; the kernel-level mechanisms are already in place.

## Decision

### Part A — Self-evolution

#### Trigger and disable

`--features self-evolution` at generation time enables it. The flag toggles two configuration entries in `harness.config.json`:

```jsonc
{
  "selfEvolution": {
    "enabled": true,
    "targets": ["routing","memory.decay","retrieval"],
    "explorationRate": 0.05,
    "evaluationWindowHours": 168,
    "minSampleSize": 50,
    "rollbackOnRegression": true
  }
}
```

`targets[]` specifies which configuration domains the loop optimises. Default: all three. The harness operator can scope it down (only routing, or only memory decay) to limit the surface.

#### The optimisation loop

For each target:

1. **Measure baseline.** The harness records the current setting and the observed outcome rate (cost, latency, quality) over `evaluationWindowHours`.
2. **Explore.** With probability `explorationRate`, perturb the setting (e.g. nudge a half-life from 168h to 120h or 240h). The perturbation is recorded as an experiment.
3. **Evaluate.** Continue measuring with the perturbed setting for the window.
4. **Compare.** At window end, compare outcomes. If perturbed is better by a configurable threshold, adopt as new baseline. If worse, revert.

This is a basic multi-armed-bandit loop, the same Thompson-sampling Beta-Bernoulli structure ADR-026 uses for model routing, applied at one level of indirection.

The kernel exports `@metaharness/kernel/self-evolution` which provides the loop runner. The harness's `harness.config.json` `selfEvolution.targets` selects which loops to run.

#### Cost/quality trade-offs

Each target has a cost and quality signal:

- **Routing.** Cost is API spend; quality is the trajectory's judged outcome.
- **Memory decay.** Cost is search latency (longer half-lives mean more candidates); quality is retrieval relevance.
- **Retrieval weights.** Cost is rerank latency; quality is the ranking accuracy on a held-out fixture.

The optimisation is multi-objective. The default Pareto-style trade-off treats cost increases above 20% as inadmissible regardless of quality. The harness operator can configure the trade-off in `selfEvolution.tradeOff`.

#### Safety rails

`rollbackOnRegression: true` is the default. The loop runner records every change with a timestamp; if a subsequent metric crosses a regression threshold (e.g. trajectory quality drops more than 5% in 24 hours), the most-recent change is reverted automatically.

Additionally:

- **Change rate cap.** No more than one configuration change per target per evaluation window.
- **Witness invariance.** Configuration changes do not invalidate witness signatures (the witness manifest does not attest the routing thresholds; it attests the kernel version and behavioural state). A self-evolution change does not require re-witnessing.
- **Audit log.** Every change is recorded in `data/self-evolution-history.jsonl` (the same JSONL pattern as the witness temporal history). The harness operator can review what changed, when, and why.
- **Manual override.** The harness operator can set a target to "frozen" via `harness.config.json` `selfEvolution.frozen: ["routing"]`. Frozen targets do not get explored.

#### When self-evolution is the wrong answer

Self-evolution is opt-in for a reason. It is wrong when:

- **The harness is in a regulated environment** where every configuration change must have a paper trail outside the harness. Self-evolution can still run with `rollbackOnRegression: false`, change rate cap `0`, and `frozen: ['*']` — effectively just recording experiment proposals for human review.
- **Sample size is small.** A harness used twice a week will not reach `minSampleSize: 50` in any reasonable window. The loop runner refuses to commit changes under-sampled and just records experiment proposals.
- **The cost of regression is high.** A trading harness that misroutes a strategy for a week. The harness operator caps the exploration rate or freezes the trading-related targets.

### Part B — Federation

#### Trigger

`--features federation` at generation time enables it. Adds the federation overlay to the template (per ADR-003 §template overlays). The harness inherits:

- `@metaharness/host-federation` (the transport adapter from ruflo's v3 ADR-104 / ADR-108 — the QUIC + WG mesh code).
- `harness.config.json` `federation.*` schema for declaring peers and trust relationships.
- A federated memory layer (per ADR-006 §federated-memory feature) that shares specific namespaces across peers.

#### Peer declaration

A federation member declares its peers in `harness.config.json`:

```jsonc
{
  "federation": {
    "enabled": true,
    "memberId": "acme-legal-onprem",
    "publicKey": "...",
    "peers": [
      {
        "memberId": "acme-legal-cloud",
        "publicKey": "...",
        "trustLevel": "full",
        "sharedNamespaces": ["patterns","feedback"]
      }
    ],
    "transport": "quic",
    "encryption": "required"
  }
}
```

Each peer is identified by member id + public key. Trust level governs what can be shared (`full` = all declared namespaces; `read-only` = receive only; `bootstrap-only` = only the initial pattern corpus).

#### What gets shared

Namespaces are shared per peer per direction:

- `patterns` — distilled learnings. Default: yes, full bidirectional. The whole point of federation.
- `feedback` — explicit user feedback. Default: yes, full bidirectional.
- `tasks` — recent task history. Default: no, contains potentially sensitive task content.
- `verifications` — witness telemetry. Default: yes, read-only outbound.
- `market`, `legal-cases`, etc. — vertical-pack-specific, configured by the pack's defaults.

The `sharedNamespaces[]` config is the actual contract; the defaults are a starting point. The harness operator decides what crosses the boundary.

#### Sync protocol

Patterns are sync'd via the v3 federation wire transport (QUIC + Ed25519, mTLS via WG mesh). The protocol is:

1. Each member periodically (default: hourly) publishes a vector of its namespaces' merkle roots to peers.
2. A peer comparing roots detects divergence; requests the differing pattern set.
3. Patterns are exchanged with their signatures intact.
4. Receiver applies the patterns to its local memory if they pass validation.

Validation includes: signature verifies; pattern's witness manifest signature verifies; the pattern's `kernelEngines` matches the receiver's kernel; the trust-level threshold is met.

> **Host-agnostic execution removes a class of federation portability bugs.** Because the kernel runs as a wasm bundle (or as a NAPI-RS native binary built from the same Rust source — per ADR-002 / ADR-002a), a pattern distilled on one federation member runs identically on every other member, regardless of OS, architecture, or whether the receiver is on Node, Bun, Deno, or an edge runtime. A pure-TS kernel would have made this property dependent on every member shipping the same Node version and the same V8 patch level; the wasm path makes "the same pattern means the same thing on every peer" a built-in invariant.

#### Self-evolution + federation interaction

When both features are on, self-evolution observes outcomes across the federation. A pattern that succeeds in member A and is replicated to member B contributes to B's success metrics too. Aggregating signals across peers raises sample size faster, which is good. But it also means a poorly-performing peer drags down the aggregate; the loop runner weights signals by peer trust level.

A federation member can opt out of cross-peer aggregation: `selfEvolution.federationAggregation: "local-only"` evaluates the loop on this member's signals only.

#### Trust establishment

How do two members establish that the public keys are real? Out-of-band. The kernel does not specify a trust establishment protocol; the human operators exchange keys directly (a vault, an in-person meeting, a signed email). This is intentional: federation is a high-trust feature; the kernel does not invent a trust hierarchy where there is none.

For organisations that want a key management system, the kernel exports `@metaharness/kernel/federation/key-store` with hooks to integrate Vault / GCP KMS / AWS KMS. None are required.

#### Network failure modes

A peer is offline. The local harness continues operating in standalone mode; federation operations queue and retry. After a configurable timeout (default: 7 days), queued operations are dropped. The harness's `federation.queueDepth` metric surfaces queue health.

A peer is compromised. The witness layer catches it: a peer publishing a signature with an unknown key, or a signature that doesn't verify, is rejected. The peer is marked `untrusted` locally and the harness operator is notified.

A peer is hostile. The trust model caps damage: a `read-only` peer cannot inject patterns; a `bootstrap-only` peer can only seed initial state, not ongoing updates. A `full` peer's bad patterns can land — the harness's CI smoke tests (ADR-007 §B1) run on the merged state regularly and catch quality regressions; the self-evolution rollback (Part A) reverts the local effect; the operator manually downgrades or removes the peer.

#### Cost circuit-breaker

Federation traffic uses bandwidth and storage. The kernel's federation budget circuit-breaker (ruflo v3 ADR-097) caps daily traffic per peer; over the cap, sync pauses. The harness operator configures the cap in `harness.config.json` `federation.bandwidth.maxDailyMB`.

### Part C — Combined exotic example

Putting Parts A and B together, the ADR-001 §From-practical-to-exotic claim becomes concrete. A user runs:

```bash
npx create-agent-harness acme-legal-onprem \
  --scope @acme \
  --hosts claude-code,codex \
  --features federation,self-evolution,witness=strict \
  --packs @metaharness/vertical-legal \
  --catalogue @metaharness/catalogue \
  --no-interactive
```

The output: a harness with two host adapters, a federation transport configured (the peer config is added post-generation by the user), a self-evolution loop watching the routing and decay targets, a legal vertical pack with custom JUDGE / DISTILL, and a strict witness manifest. None of this required the user to write code beyond their domain skills. The composer + flags drove the whole thing.

A second instance (`acme-legal-cloud`) is generated with the same command. The two operators exchange public keys; each adds the other to `harness.config.json` `federation.peers[]`; they sync.

Over time, the on-prem instance learns from cloud-instance patterns (general legal-research strategies) and the cloud-instance learns from on-prem patterns (client-confidential-data-aware retrieval) — the sharing is namespace-scoped so client content stays on-prem.

## Consequences

### What gets easier

- **Federated harnesses do not require custom code.** A flag at generation time + peer-key exchange post-generation. The transport, encryption, key store, conflict resolution come from the kernel.
- **Self-evolution does not require ML expertise.** The bandit loop is configured, not implemented per harness. The defaults are sensible.
- **The exotic-tier promise of ADR-001 is mechanically validated.** Combined exotic example above is the test case.

### What gets harder

- **Self-evolution audit is non-trivial.** A harness that has been changing its own routing for six months is harder to debug than one that hasn't. The audit log + rollback help; they do not eliminate the cost.
- **Federation requires real key management.** We do not invent a trust hierarchy. Operators do; if they do it badly, federation fails badly.
- **Cross-peer abuse is possible.** A `full`-trust peer can poison the pattern set. The mitigations (CI smoke catching regressions, self-evolution rollback, manual downgrade) are real but reactive, not preventative. We are honest about this trade-off in the §Network failure modes commentary.

### What does not change

- The kernel's runtime is the same with or without these features. The features are configuration on top of mechanisms that always exist.
- The witness model continues to apply. A federated harness publishes its own witness manifest independently of the federation.

## Alternatives Considered

### Alternative 1: Self-evolution always on

Make it the default. Rejected because in a low-volume harness it produces noise; in a regulated environment it produces audit pain; the value-add is concentrated in high-volume long-lived deployments where the operator has opted in.

### Alternative 2: Federation via a central broker

A cloud service that all members talk to. Rejected because (a) it is a single point of trust and failure, (b) it is incompatible with on-prem use cases (regulated environments) where data cannot leave the boundary, and (c) the existing v3 federation transport already supports peer-to-peer. We do not need a broker.

### Alternative 3: A "shared global pattern pool" all harnesses use

Cross-harness federation. Every harness contributes to and reads from a common pool. Rejected because (a) pattern quality varies wildly across domains — a customer-support pattern poisons a trading pattern set, (b) trust establishment across organisations is intractable without a third-party authority, and (c) the marketplace plus the pack-shipped bootstrap corpora already give a more controlled "import patterns from elsewhere" mechanism.

### Alternative 4: A reinforcement-learning agent that picks all config

Use a real RL policy network instead of bandits. Rejected because (a) the value-add over Thompson-sampling bandits is small at the sample sizes harnesses see, (b) it introduces a model dependency the harness has to train and ship, and (c) interpretability suffers — operators cannot inspect why the RL agent moved a threshold.

### Alternative 5: Skip self-evolution entirely; let users tune knobs manually

The simplest alternative. Rejected because tuning the routing threshold or the half-life by hand requires repeated measurements that the kernel already collects. Automating the loop is mostly a matter of plumbing what is measured into a decision rule. The complexity is not zero, but it is bounded.

## Test Contract

This ADR is satisfied when the following exist:

### Self-evolution tests

1. **Loop runner unit tests** (London-school) — the bandit math, the rollback trigger, the change-rate cap.
2. **Integration: routing optimisation** — fixture harness with synthetic trajectories; loop converges to better-cost setting; convergence asserted at a fixed sample size.
3. **Integration: memory-decay optimisation** — fixture with controlled reuse patterns; loop adjusts half-life appropriately.
4. **Rollback trigger** — synthetic regression injected; the loop rolls back the most-recent change automatically.
5. **Audit log format** — every change is written; the log is replayable to reconstruct the configuration timeline.

### Federation tests

6. **Two-member sync** — two harnesses; key exchange; pattern published on A appears on B within one sync cycle.
7. **Trust-level enforcement** — a `read-only` peer cannot push patterns to the receiver; the receiver rejects with a clear error.
8. **Witness in federation** — a pattern's witness signature is preserved across the transport; verifier matches at both ends.
9. **Network partition** — one peer offline for the test duration; the other queues operations; reconnect causes catch-up; integrity preserved.
10. **Hostile peer** — a peer pushing a signature with an unknown key is detected; the peer is marked untrusted; an alert fires.

### Combined exotic test

11. **The ADR-001 §Test Contract exotic canary** — federation + multi-host + custom DISTILL + self-evolution — is the same fixture both ADR-001 and this ADR depend on. The canary's pass on every CI run is the binding gate.

## References

### Ruflo internals cited

- `v3/@claude-flow/cli/src/ruvector/model-router.ts` — the Thompson-sampling bandit the self-evolution loop reuses.
- `v3/@claude-flow/cli/src/services/agentic-flow-bridge.ts` — the transport infrastructure.

### Ruflo ADRs cited

- ADR-026 (Agent Booster routing) — the bandit pattern.
- ADR-097 (Federation budget circuit-breaker).
- ADR-101 (Federated claims).
- ADR-104 (Federation wire transport).
- ADR-105 (Federation v1 state snapshot).
- ADR-107 (Federation TLS).
- ADR-108 (Native QUIC binding).
- ADR-111 (Federation WG mesh).

### External prior art

- Thompson sampling: https://en.wikipedia.org/wiki/Thompson_sampling — the bandit method the loop uses.
- Multi-armed bandits surveys: Lattimore & Szepesvári, *Bandit Algorithms* (Cambridge 2020).
- Federated learning landscape (for the architecture-style influence, not the specific algorithms): McMahan et al., "Communication-Efficient Learning of Deep Networks from Decentralized Data," https://arxiv.org/abs/1602.05629.
- QUIC: RFC 9000, https://www.rfc-editor.org/rfc/rfc9000.
- WireGuard mesh: https://www.wireguard.com/papers/wireguard.pdf.
