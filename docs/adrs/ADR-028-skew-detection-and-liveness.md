# ADR-028: Skew Detection and Liveness — One Probe, Many Surfaces

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-008 (drift detection), ADR-011 (witness + provenance), ADR-019 (release orchestration), ADR-021 (client-side packaging + Pages deploy), ADR-027 (CLI ↔ Web-UI integration)
**Supersedes / Superseded-by**: none

## Context

By iter 65 the project had three production surfaces:

1. **The CLI generator** (`packages/create-agent-harness/`) + 15 `harness` subcommands
2. **The Studio** deployed to GitHub Pages (`https://ruvnet.github.io/agent-harness-generator/`)
3. **The published npm packages** that downstream harnesses depend on (`@metaharness/kernel`, 6 host adapters, `create-agent-harness`, …)

Every one of those surfaces can drift independently:

| Surface | Drift mode |
|---|---|
| Downstream harness ↔ local `@metaharness/kernel` | User pulls a harness that was scaffolded against kernel `0.1.0`; their local install is `0.2.0` → manifest assertions in `harness doctor` start failing because the meta-block hash drifts |
| Downstream harness ↔ local `create-agent-harness` | User runs `harness upgrade` against a harness scaffolded with create-agent-harness `0.1.0`; their local CLI is `0.3.0` → re-renders produce surprise diffs that look like local damage |
| CLI surface ↔ web-UI surface | ADR-027 contract — both must emit byte-identical scaffolds for the same `(name, host, template)`. A version skew between the npm-installed CLI and the deployed Studio produces "same input, different output" reports |
| Pages deploy ↔ live URL | The deploy step can return 200 (Pages API said OK) while the served URL is broken or stale (CDN propagation, build cache, bundle ref mismatch). This bit the repo on iter 57's first deploys |
| Release tag ↔ live Studio | A release.mjs `--push` can tag `v0.X.Y` while the corresponding Pages deploy is degraded; the new GitHub release links to a broken site |

iter 66 started addressing this with `harness diag` (the user-facing kernel-skew check). Over iters 66-78 the system grew into a complete skew + liveness fabric:

- iter 56 / 58: `manifest.meta.surface` + `manifest.meta.kernel_version` (the *data*)
- iter 66: `harness diag` (the *standalone CLI surface*)
- iter 70: 7th Codex skill `diag-harness` (the *Codex surface*)
- iter 71: generator-version skew added to diag
- iter 72: `healthcheck --probe-pages` (the *live-URL probe*)
- iter 73: `harness diag --json` (the *machine-readable surface*)
- iter 76: validate umbrella chains diag as informational 6th check
- iter 77: release.mjs gates non-dry-run releases on `--probe-pages`
- iter 78: pages.yml self-verifies after every deploy

This ADR documents the architecture that emerged so contributors adding a new skew dimension (e.g. host-adapter version) or a new probe target (e.g. IPFS pin liveness) don't have to spelunk 12 CHANGELOG iters to do it correctly.

## Decision

### 1. Two orthogonal axes: **skew** and **liveness**

A surface can drift in two distinct ways. They have different detection mechanisms, different exit-code semantics, and different consumers:

| Axis | What it measures | Detector | Default verdict |
|---|---|---|---|
| **Skew** | "Does what I have locally match what this artefact was made against?" | Compare a recorded version (manifest field, package.json field) to the locally-resolved version | Informational — surface in output but don't block downstream work |
| **Liveness** | "Is this remote surface actually serving correct content right now?" | HTTP GET + content assertion | Blocking — if liveness fails on a release path, don't ship |

Mixing them is the bug. iter 76 surfaces kernel skew in `harness validate` as **informational** (the harness IS release-ready; kernel skew is a user-side install problem). iter 77 + 78 gate on Pages liveness as **blocking** (a broken live URL means downstream users get a broken product).

### 2. Skew is detected by comparing manifest fields to locally-resolved versions

The manifest is the source of truth for "what this artefact was made against." Every scaffolded harness records:

| Field | Set by | Compared to |
|---|---|---|
| `manifest.generator` | `emptyManifest()` (iter 4) | `resolveLocalGeneratorVersion()` reading `create-agent-harness/package.json` |
| `manifest.meta.kernel_version` | `emptyManifest()` opts (iter 58) | `resolveLocalKernelVersion()` using `createRequire` rooted at the harness's `package.json` |
| `manifest.meta.surface` | `emptyManifest()` defaults (iter 56) | (no comparison — this is the producer identity, not a skew axis) |

The comparison is **one** function: `skewVerdict(manifestVer, localVer)`. It returns five verdicts (`match`, `patch-diff`, `minor-diff`, `major-diff`, `unparseable`). Every consumer maps those five verdicts to their own action: `harness diag` maps to PASS/WARN/FAIL/SKIP for human output; `harness validate` maps them to PASS/WARN/SKIP umbrella tags; CI scripts read `verdict` from `harness diag --json` and gate on it directly.

**Rule**: when adding a new skew dimension (host adapter version, vertical pack version, template content hash), add a manifest field + a `resolveLocal<X>Version()` function + call `skewVerdict()` on the pair. Don't re-invent the comparison logic.

### 3. Liveness is one HTTP probe with three callers

The HTTP probe of the live Studio is implemented **once**, in `scripts/healthcheck.mjs`. It performs a 2-stage check:

1. `GET <STUDIO_URL>` returns 200 AND the HTML contains the canonical title
2. Parse out the Vite bundle reference (`<script src="…/assets/index-<hash>.js">`) and HEAD-check it — proves the deploy isn't a 200-but-empty-index pointing at broken bundles (the iter-57 failure mode)

Three callers delegate to it:

| Caller | Iter | Invocation | Failure semantics |
|---|---|---|---|
| Daily-driver `healthcheck` | 72 | `--probe-pages` (opt-in by default; offline-friendly) | Surface result in the 7-check report |
| `release.mjs` preflight | 77 | passes `--probe-pages` to `preflight.mjs` for non-dry-run releases | **Blocks** the tag push if the live URL fails |
| `pages.yml` post-deploy verify job | 78 | runs after `deploy` succeeds with a 30s CDN settle | **Fails the workflow** so a degraded deploy never sits silently green |

**Rule**: never write a second HTTP probe. New surfaces that need liveness verification (an IPFS pin, a federation peer, a downstream npm registry health endpoint) get their probe added to `scripts/healthcheck.mjs` as a new check, with the same opt-in / shared-impl pattern.

### 4. Exit code semantics

Different consumer contexts need different mappings of "the same underlying state." We define them explicitly:

| Context | Skew exit-code policy | Liveness exit-code policy |
|---|---|---|
| `harness diag` (standalone CLI) | 0 on `match`/`patch-diff`, 1 on `minor-diff`/`major-diff`, 2 on no manifest | — |
| `harness diag --json` | Same as above, AND emit `exitCode` field in the JSON for callers that only have the JSON | — |
| `harness validate` umbrella | Always 0 from the diag check (informational tag), unrelated to umbrella verdict | — |
| `healthcheck --probe-pages` | — | `SKIP` if not opted in, `PASS` on 200+bundle, `FAIL` otherwise |
| `release.mjs` preflight | — | Non-zero blocks the tag push |
| `pages.yml` verify | — | Non-zero fails the workflow |

The standalone subcommand fails on real skew so a downstream user gets a copy-pasteable next step. The umbrella never fails on skew so the *generator's* release pipeline doesn't get blocked by the *downstream user's* install state.

### 5. JSON output is a side-channel, not a replacement

For every text-emitting surface that has a programmatic consumer, the design pattern is:

```ts
// One source of truth: build the structured report
const report = await buildXReport(...)

// One text formatter
export function formatXReport(report): SubcommandResult { ... }

// JSON formatter delegates to text for exit-code resolution
export function formatXReportJson(report): SubcommandResult {
  const human = formatXReport(report)
  return { code: human.code, lines: [JSON.stringify({ ...report, exitCode: human.code }, null, 2)] }
}
```

Both surfaces stay in lockstep on the verdict→exit-code mapping forever; the JSON is the structured copy of what the text already says.

`harness diag --json` (iter 73) implements this. Future programmatic surfaces (`harness audit --json`, `harness validate --json`) should follow the same pattern.

## Consequences

**Good**:

- One probe implementation. Three CI/CLI surfaces (daily healthcheck, release preflight, post-deploy verify) all hit the same fetch+parse logic. Adding a new caller is one line. Fixing the probe is one change.
- Skew is informational by default; liveness is blocking by default. Aligns the failure mode with which axis you're checking.
- Manifest-field + `skewVerdict()` is a 2-line recipe for adding a new skew dimension. No re-inventing semver comparison.
- The JSON-from-text delegation pattern means a verdict change in `formatDiagReport()` automatically flows to the JSON output. Drift impossible.
- CI gates ("does the live Studio actually serve?") match user-experience gates ("does the live Studio actually serve?"). Same probe, same answer, no "looked fine on my laptop" gaps.

**Hurts**:

- New contributors hit four surfaces that all need to be updated together when a 16th harness subcommand lands: dispatcher, completions (bash + fish + zsh), help text, dev-toolkit. iter 67-69 surfaced this; the fix was to grow teeth in the corresponding tests. The cost is real but the test-driven discoverability means it can't regress silently.
- The `harness validate` umbrella now has 6 checks instead of 5; the `--skip-gcp` flag doesn't extend to diag. Worth a future flag (`--skip-diag`) if anyone has a real use case for it.
- The 30s sleep in pages.yml verify is empirical, not provably-sufficient. CDN propagation can take longer on a cold cache. We accept the false-negative risk because the deploy itself is the load-bearing artefact; the verify is a secondary signal.

## Alternatives Considered

**A) Block release on kernel skew too.** Rejected: kernel skew is a *user-side install* condition. Blocking the generator's release on it means the generator can never ship when any developer machine has a stale local kernel install. Wrong layer.

**B) Re-implement the HTTP probe in each consumer.** Rejected: three CI/CLI surfaces, three slightly-different probes, three failure modes when the upstream URL/bundle format changes. We tried this once (audit-deps vs sbom both walking the same lockfile separately in iters 61/64). The single-impl rule kept the diff small and the failure semantics consistent.

**C) Compute skew at install time (a `postinstall` hook).** Rejected: `postinstall` hooks are an anti-pattern that runs in unexpected contexts (offline installs, CI image bakes, npm ci on a fresh clone). The skew check should be one explicit command the user runs when they want to know.

**D) Keep diag out of validate.** Considered. The argument was "validate is for release-readiness, kernel skew isn't a release block." The reply (iter 76): make it *informational* in the umbrella so users see it in the same per-line report as everything else, but the umbrella verdict ignores it. Best of both — surface the state, don't block on it.

## Test Contract

The ADR-028 architecture is considered shipped when ALL of these are green:

| # | Test file | Pins |
|---|---|---|
| 1 | `__tests__/harness-diag.test.ts` | `skewVerdict` 5-state contract; `formatDiagReport`/`formatDiagReportJson` exit-code lockstep |
| 2 | `packages/create-agent-harness/__tests__/validate.test.ts` (iter 76) | Umbrella verdict ignores diag verdict; diag check emits informational tag |
| 3 | `__tests__/healthcheck.test.ts` | `--probe-pages` flag wires correctly; default is SKIP not FAIL |
| 4 | `__tests__/release.test.ts` (iter 77) | release.mjs passes `--probe-pages` to preflight on non-dry-run |
| 5 | `__tests__/workflows.test.ts` (iter 78) | pages.yml chains verify job that calls `healthcheck --probe-pages` |
| 6 | `__tests__/e2e-lifecycle.test.ts` (iter 68) | The full 11-subcommand chain works; meta block survives every other lifecycle step |

A PR that breaks any of (1)-(6) is blocked by branch protection.

## References

- ADR-027 — CLI ↔ Web-UI integration (the parity contract diag enforces)
- ADR-021 — Client-side packaging + Pages deploy (the surface liveness verifies)
- ADR-019 — Release orchestration (which release.mjs's `--probe-pages` integrates with)
- iter 66 — `harness diag` standalone subcommand
- iter 72 — `healthcheck --probe-pages` opt-in HTTP probe
- iter 73 — `harness diag --json` programmatic output
- iter 76 — `harness validate` umbrella chains diag informationally
- iter 77 — release.mjs preflight gates on `--probe-pages`
- iter 78 — pages.yml self-verifies after every deploy
