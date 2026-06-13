# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Iter 7 (2026-06-13)

- **Real Hooks subsystem in Rust** (`crates/kernel/src/hooks.rs`):
  - `HandlerSpec` + `HandlerKind` (5 types per Claude Code: Command, Http,
    McpTool, Prompt, Agent)
  - `matcher_matches()` with pseudo-DSL support (`*`, `Bash(rm *)`)
  - `merge_decisions()` with defer-cascade rule + per-event default
    (PreToolUse / SubagentStart default to Ask, others to Allow)
  - 10 new Rust tests pinning matcher + merge invariants
- **Real Claims subsystem in Rust** (`crates/kernel/src/claims.rs`):
  - `check()` with wildcard + prefix-with-dot + glob resource matching
  - Expired claims skipped; first matching unexpired wins
  - 9 new Rust tests
- **Self-evolving routing TS layer**
  (`packages/kernel-js/src/self-evolution.ts`):
  - `SelfEvolvingRouter` wraps `@ruvector/emergent-time`'s
    `LearnedWeights` over the kernel router
  - `computeReward()` from success + latency + cost components
  - Graceful EMA fallback when emergent-time isn't installed
  - 8 new TS tests pinning reward computation, learning behaviour, bias
- **End-user walkthrough doc** (`docs/USAGE.md`):
  - 11-section walkthrough from install to publish to self-evolution
  - Troubleshooting table covering the 5 most likely failure modes

### Added — Iter 6 (2026-06-13)

- 3 vertical templates: trading, legal, research (5 total templates)
- Witness verification client wired into publish gate
- Marketplace registry entry generator (matches ruflo plugin registry shape)

### Added — Iter 5 (2026-06-13)

- Memory subsystem with `@ruvector/emergent-time@0.1.0` integration
- Full ruflo-eject pipeline (`--from-existing`)
- Real 3-tier routing heuristics in Rust kernel
- `vertical:support` template
- `harness publish` IPFS subcommand (Pinata)

### Added — Iter 4 (2026-06-13)

- End-to-end scaffold pipeline (template walker + atomic writer)
- `vertical:devops` template
- `harness upgrade` drift detection
- `--from-existing` ruflo-eject detection

### Added — Iter 3 (2026-06-13)

- **Real Ed25519 witness signing in Rust** (`crates/kernel/src/witness.rs`)
  - `sign_manifest()` + `verify_manifest()` using `ed25519-dalek` 2.1
  - Canonicaliser (`canonical_payload`) that sorts entries by id ascending
    for deterministic signatures across CI runners (load-bearing for ADR-011)
  - `sha256_hex()` helper for marker fingerprinting
  - 8 new tests pinning sign/verify, sort-invariance, tamper detection
  - Criterion bench (`benches/witness_sign.rs`): sign-10, sign-100, verify-50
- **Codex skills** (`.codex/skills/`):
  - `create-harness/skill.toml` + `README.md` — invoked as `/create-harness` in Codex
  - `publish-harness/skill.toml` — smoke-test + witness-sign + publish gate
  - `config.toml.example` — drop-in for `~/.codex/config.toml` MCP registration
- **GCP Workload Identity Federation setup** (`docs/setup/gcp-secrets.md`)
  - 6-step gcloud walkthrough + Terraform equivalent
  - Variable wiring (`GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_WIF_SERVICE_ACCOUNT`)
  - Rotation instructions
- **Template engine** (`packages/create-agent-harness/src/renderer.ts`)
  - Mustache-style `{{var}}` interpolation with unresolved-var reporting
  - `extractVarReferences()` for template lint
  - `validateHarnessName()` mirroring npm's rules
- **`.harness/manifest.json` schema** (`packages/create-agent-harness/src/manifest.ts`)
  - Mirrors copier's `.copier-answers.yml` for drift detection (ADR-008)
  - sha256-based file fingerprinting
  - `diffFingerprints()` returns added/removed/changed paths
- 25 new tests across renderer + manifest (29 → 54 total TS test cases)

### Added — Iter 2 (2026-06-13)

- 4 host adapter packages: `@ruflo/host-{claude-code,codex,pi-dev,hermes}`
- First template (`templates/minimal/`)
- Claude marketplace plugin manifest (`.claude-plugin/plugin.json`) + 2 skills
- Vitest config + 29 TypeScript test cases
- Rust criterion benches (`mcp_validate`, `witness_canon`)

### Added — Iter 1 (2026-06-13)

- Cargo workspace + npm workspace scaffold
- 7-subsystem Rust kernel stubs with serde round-trip tests
- WASM bindings (wasm-bindgen) + NAPI-RS bindings
- `@ruflo/kernel` runtime resolver (native → wasm fallback)
- `create-agent-harness` CLI entry point
- CI matrix (Rust × 3 platforms, wasm validate + 500 KB budget, Node 20/22 × 3 platforms)
- Publish workflow (GCP Workload Identity Federation → Secret Manager → npm provenance)
- Security workflow (cargo-audit, cargo-deny, npm-audit, CodeQL, weekly cron)
- Smoke test contract (`scripts/smoke.mjs`)

### Designed — Pre-iter (2026-06-13)

- 17 ADRs in `docs/adrs/` covering kernel boundary, generator architecture, host integration, marketplace, memory/learning, CI guards, drift detection, anti-slop, TDD, witness, eject/upgrade, vertical packs, self-evolution, naming, migration

## How releases work

This project versions to semver. Publishes are tag-driven and gated on:
1. CI matrix green
2. WASM bundle within size budget
3. Witness manifest signed
4. GCP Secret Manager NPM_TOKEN fetched via Workload Identity Federation
5. `npm publish --provenance` (SLSA L2)

No long-lived NPM token exists in any GitHub secret. See [`docs/setup/gcp-secrets.md`](docs/setup/gcp-secrets.md).
