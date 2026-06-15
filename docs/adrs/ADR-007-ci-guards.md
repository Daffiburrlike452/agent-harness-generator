# ADR-007: CI Guards

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary), ADR-003 (Generator architecture), ADR-008 (Drift detection), ADR-009 (Anti-slop), ADR-010 (TDD test contracts), ADR-011 (Witness)

## Context

Two repos publish things to the world:

1. **`ruvnet/agent-harness-generator`** — publishes the kernel (`@metaharness/kernel`), the generator (`@metaharness/create-agent-harness` and its marketplace plugin), the host adapters (`@metaharness/host-*`), the catalogue (`@metaharness/catalogue`), the test harness, and the vertical packs (`@metaharness/vertical-*`).
2. **Each generated harness** — publishes its own npm package and, optionally, its own plugins to the marketplace.

Both need CI guards. They are different guards because the failure modes are different. The generator's risks are: a kernel breaking change ships before adapters are ready; a malformed template lands; a marketplace publish flow leaks credentials. A generated harness's risks are: it publishes without provenance; it ships a plugin that fails its smoke test; its kernel-engines range drifted from what it actually runs against; it forgot to regenerate the witness manifest.

This ADR pins down both gate sets. The gates are concrete enough that a CI engineer can read them and write the GitHub Actions YAML without guessing.

## Decision

### Two gate suites

- **Generator-side gates** (run on `ruvnet/agent-harness-generator` PRs and releases) — Section A below.
- **Harness-side gates** (scaffolded into every generated harness's `.github/workflows/`) — Section B below.

Each gate has: a name, a trigger, what it asserts, the failure mode, and the recovery action.

## Section A — Generator-side CI gates

These run in `.github/workflows/` of the `ruvnet/agent-harness-generator` repo.

### A1. `build-and-lint` — every PR

- **Triggers on**: every pull request to `main`.
- **Asserts**: TypeScript compile clean, ESLint clean, Prettier clean.
- **Failure mode**: PR blocked from merge.
- **Recovery**: fix the lint, push again.

### A2. `kernel-api-surface-freeze` — every PR

- **Triggers on**: PRs touching `packages/kernel/src/`.
- **Asserts**: `microsoft/api-extractor` (or equivalent) reports zero unannounced public-API changes vs the previous release. A PR that adds an export must include an `[api]` PR label and pass a one-time CODEOWNERS approval. A PR that removes or changes the signature of an export requires a major-version bump in the same commit.
- **Failure mode**: PR blocked.
- **Recovery**: revert the change OR bump the version AND add the label.

This is the ADR-002 §Test Contract §3 gate, made executable.

### A3. `kernel-import-boundary` — every PR

- **Triggers on**: PRs touching `packages/kernel/`.
- **Asserts**: the kernel's source does not `import` from outside `@metaharness/kernel/*` or its direct dependencies. Enforced by ESLint rule `import/no-restricted-paths`. No file under `packages/kernel/src/` may resolve a path to `ruflo`, `@claude-flow/*`, or any harness package.
- **Failure mode**: PR blocked.
- **Recovery**: factor the import out of the kernel.

### A4. `unit-tests` — every PR

- **Triggers on**: every PR.
- **Asserts**: `vitest run` across all packages. Coverage on `packages/kernel/` ≥ 85%, on `packages/create-agent-harness/` ≥ 80%, on `packages/host-*/` ≥ 75%.
- **Failure mode**: PR blocked.
- **Recovery**: write the tests, fix the code.

### A5. `integration-generate-trivial` — every PR

- **Triggers on**: every PR.
- **Asserts**: a trivial-tier scaffold (`create-agent-harness ci-trivial --hosts claude-code --no-interactive`) builds, passes its bundled smoke test, and `npm pack` produces a tarball that resolves.
- **Failure mode**: PR blocked.
- **Recovery**: fix the template OR the generator.

### A6. `integration-generate-exotic` — main only

- **Triggers on**: pushes to `main`.
- **Asserts**: an exotic-tier scaffold (federation + multi-host + custom DISTILL — the ADR-001 §Test Contract canary) builds and passes its smoke contract.
- **Failure mode**: main is marked broken; the next release is blocked.
- **Recovery**: revert the offending commit; fix forward.

### A7. `host-real-host-smoke` — nightly + release

- **Triggers on**: nightly cron + pre-release.
- **Asserts**: each host adapter's "real-host smoke" (ADR-004 §Test Contract §6-9) passes against an actual installed host CLI. Claude Code, Codex, and pi.dev (badlogic Pi) use installed CLIs; Hermes uses either the `hermes-agent` runtime (if installed) or a stubbed OpenAI-compatible endpoint.
- **Failure mode**: nightly: alert; release: block.
- **Recovery**: fix the adapter or pin the affected adapter as `experimental` and document.

### A8. `npm-provenance-dry-run` — every PR

- **Triggers on**: every PR.
- **Asserts**: `npm publish --provenance --dry-run` succeeds against each publishable package. Verifies the OIDC token shape, the package.json `repository` field, and the `publishConfig.access`. Does not actually publish.
- **Failure mode**: PR blocked.
- **Recovery**: fix package.json.

### A9. `kernel-version-drift-check` — main only

- **Triggers on**: pushes to `main` and pre-release.
- **Asserts**: every host adapter's `peerDependencies.@metaharness/kernel` includes the current kernel version. The catalogue's `engines.kernel` includes the current kernel version. The test harness's `dependencies.@metaharness/kernel` is the exact current kernel version.
- **Failure mode**: pre-release blocked.
- **Recovery**: bump the offending package's peer range; commit.

### A10. `marketplace-registry-validate` — every PR touching registry

- **Triggers on**: PRs touching `scripts/registry/` or `packages/catalogue/registry/`.
- **Asserts**: the proposed registry JSON validates against the schema (ADR-005 §1 schema). Every entry's checksum hash is the actual hash of its referenced tarball (where tarball is available). Every Ed25519 signature verifies. No duplicate `id`s. No entry's `kernelEngines` excludes the current kernel version.
- **Failure mode**: PR blocked.
- **Recovery**: fix the entry.

### A11. `release-gate` — release tags only

- **Triggers on**: pushes of tags `v*`.
- **Asserts**: ALL of A1-A10 must have passed on the tagged commit's PR; the version-bump commit message follows the format `chore(release): bump @metaharness/* to X.Y.Z`; CHANGELOG has an entry for the version; no `.env*` files committed; no unresolved `TODO(security)` markers in shipped code.
- **Failure mode**: release blocked, tag deleted, the human is paged.
- **Recovery**: fix the missing piece, re-tag.

### A12. `secret-scan` — every PR

- **Triggers on**: every PR.
- **Asserts**: `gitleaks` (or equivalent) reports zero hits across the PR's diff. Specifically blocks: any string matching `sk-ant-`, `sk-`, `npm_`, `gh[ps]_`, the Pinata JWT pattern.
- **Failure mode**: PR blocked, the offending commit must be rewritten to remove the secret AND the secret must be rotated (CI sends the rotation reminder to the security mailing list).
- **Recovery**: rewrite, rotate.

### A13. `dep-audit` — every PR

- **Triggers on**: every PR.
- **Asserts**: `npm audit --audit-level=high` returns zero high+critical advisories. **Renovate** (https://docs.renovatebot.com/) — the recommended dependency-drift bot for this generator's scale — has not raised an unaddressed advisory older than 14 days. Renovate is chosen over Dependabot (`.github/dependabot.yml`) for the generator and `@metaharness/*` packages because: (a) preset inheritance lets one config drive every repo we publish from; (b) grouped updates reduce CI churn (one PR for related kernel-version bumps rather than N); (c) configurable scheduling lets us batch updates outside business hours. Generated harnesses are scaffolded with a Renovate preset by default; harness authors can switch to Dependabot if they prefer the GitHub-native simpler model.
- **Failure mode**: PR blocked.
- **Recovery**: bump the dep, mitigate, or document a CVE override (`.audit-overrides.json` with reasoning).

### A14. `bundle-size-budget` — every PR

- **Triggers on**: every PR touching `crates/kernel/`, `crates/kernel-wasm/`, or `crates/kernel-napi/`.
- **Asserts**: per ADR-002a §Size budget — `kernel_bg.wasm` after `wasm-opt -Oz` stays under the soft budget (250 KB), the `pkg/` tarball stays under 350 KB, each native `.node` binary stays under 4 MB. Growth above soft requires a `[size-growth]` label and CODEOWNERS sign-off. Hard budget (500 KB wasm / 700 KB tarball / 8 MB per native) blocks publish unconditionally.
- **Failure mode**: PR blocked.
- **Recovery**: shrink, or add the label and justify.

This is the ADR-002 §Consequences "kernel must stay small" gate and the ADR-002a §Size budget gate, both executable.

### A14a. `kernel-multi-target-build` — every PR touching the kernel crate

- **Triggers on**: every PR touching `crates/kernel/`, `crates/kernel-wasm/`, `crates/kernel-napi/`, or any `npm/kernel*/` directory.
- **Asserts**: per ADR-002a §CI publishing matrix —
  - The wasm bundle builds clean via `wasm-pack build --target bundler --release`.
  - `wasm-opt -Oz` runs without error.
  - `wasm-tools validate` reports the bundle as valid.
  - Each of the six native triples (`darwin-arm64`, `darwin-x64`, `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `win32-x64-msvc`) builds via `napi build --platform --release --target <triple>`.
  - The generated `.d.ts` matches between the wasm and native tracks (no divergence in the exported TypeScript surface).
  - `tsc --strict` passes against the generated `.d.ts` for a stub consumer.
- **Failure mode**: PR blocked. The matrix surfaces which target broke.
- **Recovery**: fix the failing target's build configuration. If the failure is a generated-`.d.ts` divergence, fix the `wasm-bindgen` or `napi` annotations so both tracks emit the same shape.

This is the load-bearing gate that catches "the wasm side builds but the Linux musl native side does not" before it ships.

### A14b. `kernel-wasm-native-parity` — every PR touching the kernel crate

- **Triggers on**: every PR touching `crates/kernel/` or either wrapper crate.
- **Asserts**: per ADR-002a §Wasm/native parity test — the same fixture suite (HNSW search results on a fixed input set, codemod outputs on fixed source, witness signature bytes for a fixed manifest, MCP tool registration ordering, hooks-runtime firing sequence) runs against both the wasm bundle and at least one native build. Every output matches bit-for-bit.
- **Failure mode**: PR blocked.
- **Recovery**: identify which target diverged (typically the Rust feature flags or a platform-specific behaviour); align them so the kernel computes the same answer everywhere. Tests that legitimately need non-bit-stable outputs (timing, RNG) are tagged and excluded.

This is the gate ADR-011's witness-determinism story depends on. If wasm and native disagree, regenerating the witness on a different runner produces a different signature, which breaks ADR-007 §A15 (`witness-manifest-regen`).

### A15. `witness-manifest-regen` — release tags only

- **Triggers on**: release tags.
- **Asserts**: `scripts/regen-witness.mjs` runs cleanly on the tagged commit; the regenerated manifest matches the committed one (no drift); `verification-history.jsonl` has a new line for this release.
- **Failure mode**: release blocked.
- **Recovery**: regen, commit, re-tag.

This mirrors ruflo's existing witness CI gate (ADR-103 §3).

### A16. `kernel-template-coherence` — main only

- **Triggers on**: pushes to `main` and pre-release.
- **Asserts**: the bundled templates in `packages/create-agent-harness/templates/` are coherent with the current `@metaharness/kernel` version. Specifically: every `import` in the templates resolves to an exported symbol in the kernel at the version pinned in `_base/package.json.hbs`.
- **Failure mode**: pre-release blocked.
- **Recovery**: fix the template OR fix the kernel export.

This is the load-bearing gate that catches the failure mode "kernel was upgraded but templates were forgotten."

## Section B — Harness-side CI gates (scaffolded into every generated harness)

Every generated harness ships `.github/workflows/` files. These are templates the generator writes; the harness author can modify them but should not delete the required gates.

### B1. `harness-ci.yml` — every PR

Scaffolded as `.github/workflows/ci.yml` in the harness.

```yaml
name: Harness CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npx <harness-name> doctor --strict       # built-in self-check
      - run: npx <harness-name> smoke --offline       # offline smoke contract
      - run: npx <harness-name> witness verify        # ADR-011 verification
```

What this asserts:
- TypeScript compile clean.
- Unit tests pass.
- The harness's own doctor command (built from the kernel's doctor + harness-specific checks) reports green.
- The smoke contract (the same contract the kernel's test harness runs, parameterised for this harness) passes.
- The witness manifest verifies against the live tree.

### B2. `harness-multi-host-smoke.yml` — every PR

For every host the harness declares in its `harness.config.json` `hosts[]`, run that host's adapter smoke test against an installed copy of that host. Matrix job.

```yaml
jobs:
  smoke:
    strategy:
      matrix: { host: [claude-code, codex] }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run install:host-${{ matrix.host }}
      - run: npx <harness-name> smoke --host ${{ matrix.host }}
```

### B3. `harness-anti-slop.yml` — every PR

Runs the marketplace-publish smoke contract (the anti-slop gate from ADR-009). What this asserts is detailed in ADR-009 §4 Smoke contract.

### B4. `harness-publish.yml` — release tags only

Scaffolded as `.github/workflows/release.yml`. The publish flow:

1. Run all of B1, B2, B3 — every gate must be green.
2. `npm version <new-version>` if not already bumped.
3. Regenerate the witness manifest (ADR-011).
4. `npm publish --provenance`.
5. If the harness has a marketplace plugin (ADR-005 §5), run the marketplace publish flow (Pinata upload, registry update, CID commit).
6. `gh release create v<version>` with the changelog excerpt.

The publish step is gated by `if: success() && github.actor == 'release-bot' || contains(github.event.head_commit.message, '[publish]')`. Random commits do not trigger publishes.

### B5. `harness-drift-check.yml` — weekly cron

Once a week, the harness's CI runs `npx <harness-name> drift check` (the ADR-008 drift-detection command). It opens a PR if drift is detected — the PR contains the diff against the current template and a proposed migration. The human reviews and merges.

This is the load-bearing gate that catches the "kernel shipped 1.3.0 but my harness is pinned to 1.2.0 and now its template is out of date" failure mode.

### B6. `harness-secret-scan.yml` — every PR

Mirrors A12. Generated into the harness so the harness's own CI catches secret commits, not just the generator's CI.

### B7. `harness-perf-smoke.yml` — pre-release only

Asserts that the harness's measured boot time and memory-search latency are within budget. The budget is configurable in `harness.config.json` `perf.budgets.*`; the generator ships sensible defaults from ruflo's measured numbers (kernel startup ≤ 500 ms, memory-search ≤ 5 ms at N=20k).

## Branch protection rules

Both repos (the generator and every generated harness) enable GitHub branch protection on `main`:

- Require PR before merging.
- Require ≥1 reviewer (≥2 for the generator's `packages/kernel/` paths via CODEOWNERS).
- Require all required CI checks to pass (the gates above).
- Require linear history (no merge commits).
- Require signed commits (Ed25519 / GPG).
- Restrict who can push to `main` (no one; PR-only).

The generator ships scripts to apply these rules to a new harness on first push (`gh api -X PUT /repos/{owner}/{repo}/branches/main/protection` calls).

## Required external secrets

The generator's CI uses, with one repository-level secret each:

- `NPM_TOKEN` — npm publish. Scope: `@ruflo` only.
- `PINATA_API_JWT` — IPFS registry uploads. Scoped to the registry's pinning group.
- `WITNESS_SEED` — deterministic Ed25519 seed for ruflo ADR-103 compatible witness signing.

Each is a GitHub Actions secret, never a `.env` commit, never logged. ADR-011 specifies how the witness seed rotates.

Generated harnesses are scaffolded with the same secret names; the harness author provisions their own values.

## Required CODEOWNERS

`.github/CODEOWNERS` ships into both the generator repo and (templated) every generated harness:

```
# Generator repo
packages/kernel/             @ruflo-kernel-team
packages/create-agent-harness/  @ruflo-generator-team
packages/host-*/             @ruflo-host-team
packages/vertical-packs/legal/    @ruflo-vertical-legal
packages/vertical-packs/trading/  @ruflo-vertical-trading
scripts/registry/            @ruflo-marketplace-team

# Generated harness (template)
.github/workflows/release.yml    @{{ author }}
src/                          @{{ author }}
.harness/                     @{{ author }}
```

Reviewers are scoped narrowly so a PR touching kernel needs kernel team sign-off, etc.

## CI provider commitment

The default CI ships GitHub Actions YAML. The generator emits the gates as GitHub Actions workflows.

An alternative-providers path (GitLab Pipelines, CircleCI) is **out of scope for v1.0**. A user on a non-GitHub host can hand-port the equivalent jobs; the gates themselves (commands to run, exit-code expectations) are CI-agnostic and documented in this ADR for that purpose. If real user pull emerges for a second provider, a follow-on ADR adds the templates.

## Performance budget for CI itself

The full generator-side suite (A1-A16) on a single PR runs in ≤ 15 minutes wall-clock on standard GitHub-hosted runners. Each matrix shard ≤ 8 minutes. If we cross either ceiling we revisit.

The harness-side suite (B1-B3 on PR; B4 on release) runs in ≤ 10 minutes wall-clock for a default harness. Larger harnesses (more plugins, more hosts) scale linearly; the budget is enforced per-harness via `harness.config.json` `ci.budgetMinutes`.

## Consequences

### What gets easier

- **The "is it safe to merge?" answer is a button.** All required gates green = safe to merge. No human judgement required for the routine cases.
- **A new harness inherits sane CI from day one.** The author does not have to know how to wire branch protection or npm provenance.
- **The publish path is hard to misuse.** Every gate that could leak a secret, ship an unverified plugin, or skip the witness regen is automated.

### What gets harder

- **CI minutes have a real cost.** Every matrix job, every host adapter, every nightly run is billable. The 15/10-minute budgets are tight. ADR-007 §Performance budget commits us to maintaining them.
- **Gate maintenance is real work.** Sixteen generator-side gates + seven harness-side gates is a non-trivial CI codebase. Each gate has a `.github/workflows/*.yml` file + a `scripts/ci/*.mjs` it invokes. We commit to keeping them small and well-tested.
- **The first generator release will trip every gate.** Bootstrapping the gates onto a green starting point is part of phase 1 (ADR-001).

### What does not change

- The harness author still chooses what tests they write beyond the smoke contract. The gates we scaffold are the minimum; everything above that is theirs.
- The CI provider can be swapped out — only the YAML changes, not the assertions.

## Alternatives Considered

### Alternative 1: One mega-workflow

Run everything in one job. Rejected because failures become opaque ("CI failed" rather than "B2 host-codex smoke failed") and re-running one matrix shard isn't possible. Splitting into named jobs costs little and pays in debuggability.

### Alternative 2: Skip the witness regen in CI; run it manually on release

Rejected because the witness manifest is supposed to be deterministic from the commit, and the only way to prove that is to regen in CI and compare. ADR-103 in ruflo already commits to this pattern; we inherit it.

### Alternative 3: Run the real-host smoke on every PR (not nightly)

Rejected because the real-host smoke involves installing Claude Code CLI / Codex CLI / Hermes runtime in CI, which is expensive in time and credentials. Nightly is the right cadence for "the world hasn't shifted under us" — PR gates run against stubs (fast) and nightly gates run against the real thing (thorough).

### Alternative 4: Make `npm-provenance` mandatory on all harness releases

Reject any harness publish without `--provenance`. Rejected per ADR-005 §Alternative 5 — gating absolutely on provenance excludes non-GitHub CI users. Anti-slop (ADR-009) treats provenance as a quality signal, not a gate.

### Alternative 5: No anti-slop gate at PR time (run it only at publish)

Rejected because the anti-slop signal is most useful early. Catching a broken smoke contract at PR is cheap; catching it after publish is a recall.

## Test Contract

This ADR is satisfied when the following exist:

### Gate-as-code

1. **All sixteen generator-side gates** exist as `.github/workflows/*.yml` files plus their `scripts/ci/*.mjs` implementations. Each runs in isolation; each can be invoked locally via `npm run ci:<gate>`.
2. **All seven harness-side gates** are scaffolded by the generator into every produced harness. Asserted by ADR-003 §Test Contract §5 (trivial-harness end-to-end check — every generated workflow file is present and lints).

### Synthetic failure tests

3. **For each gate, a deliberately-broken PR** exists in a `tests/ci-fixtures/` directory. Pointing CI at the fixture must produce the expected failure mode. Example: a fixture that adds a kernel export without the `[api]` label must fail A2.

### Performance test

4. **CI wall-clock measurement** — a workflow-of-workflows runs the full suite against the current `main` weekly and posts to the `metrics` channel. If the wall-clock crosses 15 minutes (generator) or 10 minutes (harness, measured on a default scaffolded harness), the trend is investigated.

### Recovery procedures

5. **A `RUNBOOK.md` under `docs/`** documents the recovery action for each gate's failure mode. The recovery is single-paragraph; the gate name is the heading; the runbook is referenced from each `.github/workflows/*.yml` `description`.

## References

### Ruflo internals cited

- `.github/workflows/v3-ci.yml` — the existing ruflo CI's structure, the basis for many of the generator's gates.
- `v3/docs/adr/ADR-102-plugin-hook-cli-flag-regression-ci-guard.md` — the existing ruflo CI smoke harness for plugin flag regressions.
- `v3/docs/adr/ADR-103-witness-temporal-history.md` — the witness regen gate (A15).
- `scripts/regen-witness.mjs` — the witness regen the gate invokes.

### External prior art

- npm provenance: https://docs.npmjs.com/generating-provenance-statements.
- GitHub Actions OIDC for npm: https://docs.github.com/en/actions/security-guides/about-security-hardening-with-openid-connect.
- `gitleaks`: https://github.com/gitleaks/gitleaks.
- `size-limit`: https://github.com/ai/size-limit.
- `microsoft/api-extractor`: https://api-extractor.com/.
- Renovate: https://docs.renovatebot.com/ — the dependency-drift bot we leverage in A13.

### Ruflo ADRs cited

- ADR-002 (Kernel boundary).
- ADR-003 (Generator architecture).
- ADR-008 (Drift detection).
- ADR-009 (Anti-slop).
- ADR-010 (TDD test contracts).
- ADR-011 (Witness).
