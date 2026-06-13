# ADR-019: Release Orchestration

**Status**: Accepted
**Date**: 2026-06-13
**Related**: ADR-002a (publishing pipeline), ADR-005 (marketplace plugin), ADR-007 (CI guards), ADR-011 (witness + provenance), ADR-013 (vertical packs publishing)

## Context

The publishing pipeline now spans ~15 surfaces — 12 npm packages, the `.claude-plugin/plugin.json` manifest, the `Cargo.toml` workspace `[workspace.package].version`, and the IPFS-pinned marketplace registry entry. Each release must update them all in lockstep AND clear every gate (pre-publish validation, GCP secret check, per-package dry-run, tarball content invariants) BEFORE any registry I/O happens.

By the end of iter 33, the individual scripts exist:

| Script | What it does | Iter |
|---|---|---|
| `scripts/preflight.mjs` | Run every gate `publish.yml` would run, locally | 14 |
| `scripts/validate-gcp-secrets.mjs` | Re-verify WIF→Secret Manager→`npm whoami` chain | 18 |
| `scripts/publish-dryrun.mjs` | `npm publish --dry-run --json` on every package | 20 |
| `scripts/marketplace-entry.mjs` | Generate the IPFS-pinnable plugin JSON | 27 |
| `scripts/version-bump.mjs` | Atomic cross-pack semver bump | 29 |

What was missing: a **single command** that composes these so a release is one keystroke, not a 15-step runbook a human runs by hand.

## Decision

`scripts/release.mjs` is the canonical entrypoint for a release. It composes the existing scripts in a deterministic 5-step plan:

1. **`version-bump.mjs <target>`** — mutates the 15 version sources atomically. Forwards `patch | minor | major | <explicit>`.
2. **`preflight.mjs`** — runs every gate `publish.yml` will run, but locally. If preflight fails, the release aborts BEFORE any git mutation.
3. **`marketplace-entry.mjs`** — regenerates `dist/marketplace-entry.json` so the bumped version + any plugin.json drift is reflected.
4. **`publish-dryrun.mjs`** — confirms every package's tarball builds cleanly (catches broken `files`, missing bin paths, etc.).
5. **`git add -A && git commit -m 'chore(release): v<version>' && git tag v<version>`** — only after all gates pass. `--push` flag pushes branch + tag, which fires `publish.yml` server-side.

Constraints baked into the orchestrator:

- **Refuses dirty working trees** (unless `--dry-run`). Releases must be clean cuts.
- **No git mutation until step 5** — version-bump's file changes are staged, but commit + tag are gated on all earlier steps passing.
- **`--dry-run` is the safe default for inspection** — prints the 5-step plan and exits without touching git.
- **`--skip-preflight` / `--skip-marketplace` / `--skip-pack`** for fast iteration during release-flow development. Production releases never use these flags.

`publish.yml` (server-side, runs on tag push) re-runs the same gates with the bonus of GCP Secret Manager fetch + actual `npm publish --provenance` + Pinata pin. The server pipeline is the source of truth for what actually shipped; `release.mjs` is the pre-flight check.

## Consequences

**Good**:

- Releases are a single command: `node scripts/release.mjs patch --push`. Cuts the runbook from ~15 manual steps to one.
- The orchestrator can't reach git mutation if ANY gate fails — a class of "tagged but broken" releases is eliminated by construction.
- Every primitive script is independently testable + re-runnable, AND tested in composition via `__tests__/release.test.ts`.
- Future gates compose by adding one step + bumping the count (`6/6` instead of `5/5`).

**Hurts**:

- Five sub-processes per release means ~30s wall-clock locally even when everything passes (most time in step 4's `npm publish --dry-run` per package).
- Cross-platform process spawn complexity — `release.mjs` shells out via `cmd.exe /d /s /c <cmd>` on Windows to avoid the DEP0190 deprecation and `npm.cmd` resolution gotcha (same fix that landed in `publish-dryrun.mjs` iter 24).
- The marketplace step (3) and the actual IPFS pin step happen in different places (here locally for the file, in `publish.yml` for the pin). If Pinata is unreachable at publish time, the npm publish has already succeeded — the marketplace listing lags. This is an explicit tradeoff: npm publish is the load-bearing release; marketplace is downstream.

## Alternatives Considered

**Make every script a phase of one monolithic `release.mjs`.** Rejected: violates the layered scripts that other contexts use (preflight standalone for local quick check; publish-dryrun standalone for CI gates). Composition beats merging.

**Bash-only orchestration.** Rejected: cross-platform Windows support is a hard requirement (cf. iter 16 cross-platform CI matrix). Node.js with `cmd.exe /d /s /c` invocations handles Windows + POSIX in one codebase.

**`changesets` / `semantic-release`.** Rejected: ties the release flow to a specific commit-message convention this project doesn't enforce. Also doesn't compose cleanly with the GCP-WIF gate that's the whole point of the publish pipeline (per ADR-002a, ADR-018-implementation).

**Skip preflight in release.mjs, rely on CI to catch failures.** Rejected: by the time CI fails on tag push, the tag exists. The whole point is to validate BEFORE tagging. Untagging requires force-push, which the project's branch-protection settings reject.

## Test Contract

| Test | What it pins |
|---|---|
| `__tests__/release.test.ts` (6 cases, iter 33) | `--dry-run` does not mutate; 5-step plan prints in order; `--skip-*` flags honored; semver bump kinds forwarded; explicit version forwarded |
| `__tests__/version-bump.test.ts` (7 cases, iter 29) | Sub-step 1 contract — atomic cross-pack bump, workspace deps in lockstep, `--dry-run`, rejection of unparseable targets |
| `__tests__/marketplace-entry.test.ts` (6 cases, iter 27) | Sub-step 3 contract — well-formed entry from live plugin.json, witness/ipfs slots optional, validation catches missing fields |
| `__tests__/workflows.test.ts` (7 cases, iter 30) | `publish.yml` runs the same gates `release.mjs` ran locally, in the same order |

Any of these tests failing means the orchestration contract has drifted. CI runs them on every push to main.

## References

- ADR-002a: Rust crate + WASM/NAPI-RS publishing pipeline (the layer below this)
- ADR-005: Marketplace plugin design (step 3's output)
- ADR-007: CI guards (the gates this orchestrates)
- ADR-011: Witness + provenance (`harness sign` integrates downstream)
- `docs/RELEASE.md` — user-facing runbook documenting how to use `release.mjs`
- `.github/workflows/publish.yml` — the server-side mirror of this flow
