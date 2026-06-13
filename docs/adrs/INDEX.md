# agent-harness-generator — ADR Index

> Read top-to-bottom. The series is structured so that earlier ADRs ground the later ones; if you jump in the middle you will hit forward references that have not yet been justified.

## How to read this set

Each ADR is independently reviewable. None of them ships code; the whole series is documentation that the repo `ruvnet/agent-harness-generator` will eventually be built against. The naming convention is `ADR-NNN-kebab-case-slug.md` with three-digit padding.

Every ADR follows the same shape:

1. **Title / Status / Date / Related**
2. **Context** — what problem we are solving and why now
3. **Decision** — what we are doing about it
4. **Consequences** — what changes, what does not, what hurts
5. **Alternatives Considered** — what we rejected and why
6. **Test Contract** — what tests must exist for this decision to be considered shipped (London-school for kernel units; integration for generator output; contract tests for host adapters)
7. **References** — citations to prior art, papers, ruflo ADRs

## The phases

| Phase | What ships | ADRs that define it |
|---|---|---|
| **0 — Kernel extraction** | `@ruflo/kernel` package (Rust → wasm + NAPI-RS); refactor strategy from ruflo | ADR-001, ADR-002, ADR-002a |
| **1 — Generator MVP** | `npx create-agent-harness <name>` works for Claude Code | ADR-003, ADR-007, ADR-010, ADR-011 |
| **2 — Multi-host** | Codex, pi.dev, Hermes adapters | ADR-004 |
| **3 — Composer** | Interactive agent / skill / plugin picker; `--from-existing` eject mode | ADR-003 §3, ADR-012 |
| **4 — Marketplace publication** | Generator is itself a marketplace plugin; generated harnesses can publish | ADR-005, ADR-009 |
| **5 — Self-evolving + federation** | Learning loop applied to harness-level optimisation; multi-instance federation | ADR-014 |
| **6 — Vertical packs** | Curated bundles (`@ruflo/vertical-legal`, `@ruflo/vertical-trading`, …) | ADR-013 |

ADR-006 (memory + learning) and ADR-008 (drift detection) cut across all phases. ADR-015 (naming) and ADR-016 (migration) are phase-independent.

## The ADRs

| # | Title | Status | One-line summary |
|---|---|---|---|
| [ADR-001](./ADR-001-goals-and-non-goals.md) | Goals and non-goals | Proposed | What the project is, is not, and what success looks like. |
| [ADR-002](./ADR-002-kernel-boundary.md) | Kernel boundary | Proposed | What goes in `@ruflo/kernel`, what is content. The load-bearing decision of the series. Kernel is Rust → wasm + NAPI-RS. |
| [ADR-002a](./ADR-002a-rust-wasm-napi-publishing-pipeline.md) | Rust crate + WASM/NAPI-RS publishing pipeline | Proposed | Cargo workspace layout, multi-target CI matrix, lockstep version contract. Read after ADR-002. |
| [ADR-003](./ADR-003-generator-architecture.md) | Generator architecture | Proposed | How `create-agent-harness` works: templates, renaming, composition. |
| [ADR-004](./ADR-004-host-integration-model.md) | Host integration model | Proposed | Adapter abstraction across Claude Code, Codex, pi.dev, Hermes. |
| [ADR-005](./ADR-005-marketplace-plugin-design.md) | Marketplace plugin design | Proposed | How the generator and its outputs participate in the IPFS plugin registry. |
| [ADR-006](./ADR-006-memory-and-learning-integration.md) | Memory + learning integration | Proposed | How generated harnesses inherit AgentDB + HNSW + ReasoningBank + emergent-time decay. |
| [ADR-007](./ADR-007-ci-guards.md) | CI guards | Proposed | What GitHub Actions gates must pass before generator/harnesses can publish. |
| [ADR-008](./ADR-008-drift-detection.md) | Drift detection | Proposed | Detecting and recovering kernel/template/generated-harness drift. |
| [ADR-009](./ADR-009-anti-slop.md) | Anti-slop | Proposed | Marketplace quality model: smoke tests, signals, reputation, gates. |
| [ADR-010](./ADR-010-tdd-test-contracts.md) | TDD test contracts | Proposed | Test strategy per phase: London-school unit, integration, contract. |
| [ADR-011](./ADR-011-witness-and-provenance.md) | Witness + provenance | Proposed | Ed25519 manifests for generated harnesses (mirrors ruflo ADR-103). |
| [ADR-012](./ADR-012-eject-and-upgrade-strategy.md) | Eject + upgrade strategy | Proposed | How generated harnesses receive kernel updates. Vendored vs peer-dep. Eject mode. |
| [ADR-013](./ADR-013-vertical-packs-publishing.md) | Vertical packs publishing | Proposed | How curated bundles get published, owned, maintained. |
| [ADR-014](./ADR-014-self-evolution-and-federation.md) | Self-evolution + federation (exotic) | Proposed | Learning loop applied at harness level; federated multi-instance harnesses. |
| [ADR-015](./ADR-015-naming-and-branding-policy.md) | Naming + branding policy | Proposed | Independence mode vs powered-by; scope strategy; marketplace tags. |
| [ADR-016](./ADR-016-migration-for-ruflo-users.md) | Migration for existing ruflo users | Proposed | Moving from ruflo to a generated harness without losing memory / patterns / skills. |
| [ADR-018](./ADR-018-rvm-as-deployment-target.md) | RVM as deployment target | Accepted | Use the RVM microhypervisor as the hardware-isolation tier for federation + multi-tenant deployments. |
| [ADR-019](./ADR-019-release-orchestration.md) | Release orchestration | Accepted | `scripts/release.mjs` composes version-bump + preflight + marketplace + dry-run + tag into one command; refuses dirty tree; per-step PASS/SKIP/FAIL gating. |

## Conventions used across the series

- **"Kernel"** = `@ruflo/kernel`, the package extracted from ruflo that contains primitives a harness needs regardless of identity or content (MCP wiring, hooks runtime, memory bridge, routing). Defined in ADR-002.
- **"Harness"** = a generated, npm-publishable package that wraps the kernel with chosen content (agents, skills, plugins) and identity (name, brand, scope). Defined in ADR-001.
- **"Content"** = agents, skills, prompts, plugins, vertical-specific code. Lives in the harness, not the kernel. Defined in ADR-002.
- **"Host"** = the agentic CLI or platform that runs the harness (Claude Code, Codex, pi.dev, Hermes). Defined in ADR-004.
- **"Composer"** = the interactive picker in `create-agent-harness` that lets a user choose agents, skills, plugins, primitives. Defined in ADR-003.
- **Powered-by**: a generated harness that ships kernel as a peer dep and links back to ruflo branding. Default mode.
- **Independence**: a generated harness that vendors the kernel (or hard-forks it) and ships under its own brand. Alternative mode. Defined in ADR-015.

## How to amend this series

- Edits to a Proposed ADR happen in PRs that reference the ADR number.
- A ratified ADR (`Status: Accepted`) is amended by a follow-on ADR (`Status: Supersedes ADR-NNN`) and never edited in place.
- New ADRs append to the series — they do not renumber.
- Cross-references between ADRs use the ADR number, not the slug, so renames do not break links.

## What to do next

If you are reading this with intent to start implementation, the gating ADR is **ADR-002 (Kernel boundary)**. Until that is accepted, every subsequent phase is blocked. ADR-002 is the highest-priority review.
