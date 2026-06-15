# ADR-008: Drift Detection

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-003 (Generator architecture, the harness manifest), ADR-007 (CI guards), ADR-012 (Eject + upgrade)

## Context

A generated harness diverges from its origin over time. The kernel ships new versions. Templates get fixed. Catalogue entries are upgraded. The harness author edits files locally for legitimate reasons. After six months, the harness is a tree of files; we want to know which files came from which source, whether the source has updated, whether the local edits conflict with upstream changes, and whether the divergence is safe to ignore or actionable.

This is "drift detection," and the answer to "what is drifting from what?" is more than one question:

1. **Kernel drift** — the harness pins `@metaharness/kernel ^1.2.0`, the kernel has shipped `1.4.0` with a security fix. The harness has not pulled it.
2. **Template drift** — the harness was generated from template version `template@1.0.0`; templates `template@1.3.0` now exists with bug fixes the harness has not received.
3. **Catalogue drift** — the harness pulled `coder@2.1.0` agent; `coder@2.2.0` ships with a better system prompt.
4. **Local-edit drift** — the harness author hand-edited `src/index.ts`; the kernel API the file imports has changed.
5. **API surface drift** — a plugin the harness installed declared `kernelEngines: ^1.0.0`, the harness is now on `1.4.0`; should still work, but warrants a check.
6. **Witness drift** — the harness's witness manifest claims fix `F12` is present at SHA `abc...`, but the file now hashes to `def...`. Either an attack or an honest local edit.

Each kind of drift has its own detection mechanism, its own classification (safe / actionable / urgent), and its own recovery action. We cannot lump them.

This ADR specifies all six, the CLI surface that exposes them (`npx <harness-name> drift check`), the CI workflow (ADR-007 §B5) that runs the check weekly, and the auto-PR recovery path.

## Decision

### The harness manifest is the source of truth

The manifest at `.harness/manifest.json` (defined in ADR-003 §The harness manifest) is the canonical record of what was generated, from what versions, with which choices. Drift detection is fundamentally "what is the delta between the manifest's assertions and the current state of the world?"

If the manifest disappears or is invalidated, drift detection cannot run. The witness manifest (ADR-011) attests the harness manifest's checksum so silent corruption is caught.

### Six kinds of drift

For each kind, we specify: detection mechanism, classification, recovery.

#### 1. Kernel drift

- **Detection.** Compare `manifest.kernel.version` to `npm view @metaharness/kernel version`. If newer, surface the changelog excerpt from the registry.
- **Classification.** Patch-only (`1.4.0 → 1.4.1`) = safe. Minor (`1.4.0 → 1.5.0`) = actionable (probably backward-compat but read the changelog). Major (`1.4.0 → 2.0.0`) = urgent / breaking, see ADR-012 §Upgrade flow.
- **Recovery.** `npx <harness-name> upgrade kernel` runs the upgrade flow.

#### 2. Template drift

- **Detection.** Compare `manifest.generator.templateRegistryCid` to the current `templateRegistryCid` in the registry. If different, fetch the new templates and compute the diff against the files in the manifest.
- **Classification.** For each file in the manifest with `fromTemplate: "..."`:
  - **Unchanged upstream + unchanged locally** = no drift.
  - **Changed upstream + unchanged locally** = clean update; safe to apply automatically.
  - **Unchanged upstream + changed locally** = local override; informational only.
  - **Changed upstream + changed locally** = conflict; requires human review.
- **Recovery.** Auto-applied for clean updates (config knob); offered as a 3-way merge UI for conflicts. The 3-way merge inputs are: the original template version's file, the new template version's file, the harness's current file. This is the copier upgrade model.

#### 3. Catalogue drift

- **Detection.** For each agent / skill / command in `manifest.choice`, compare its declared version (`coder@2.1.0`) to the current version in `@metaharness/catalogue`. If newer, fetch the diff.
- **Classification.** Same as template drift — version semantics applied to catalogue entries. The catalogue ships per-entry semver.
- **Recovery.** Same as template drift — `npx <harness-name> upgrade catalogue --entry coder`.

#### 4. Local-edit drift

- **Detection.** For each file in the manifest, compute its current SHA-256. Compare to `manifest.files[].sha256`. Any mismatch = local edit.
- **Classification.**
  - The user expected to edit this file (e.g. `src/index.ts` for new agent wiring) → informational, no action.
  - The user did not expect to edit this file (e.g. a host adapter's config the generator owns) → warning; offer "restore to generated state" or "preserve and re-record in manifest."
- **Recovery.** `npx <harness-name> drift accept-local <path>` updates the manifest's recorded SHA. `npx <harness-name> drift restore <path>` reverts to generated state.

The "expected to edit" determination is recorded in the manifest at generation time: every file has a `userEditable: boolean` flag the generator sets based on the template (e.g. `_base/src/index.ts.hbs` has `userEditable: true`, `_base/.github/workflows/ci.yml` has `userEditable: false`).

#### 5. API surface drift

- **Detection.** For each plugin in `manifest.choice.plugins`, fetch its current registry entry, read `kernelEngines`, intersect with the harness's current `@metaharness/kernel` version. If the intersection is empty, the plugin is no longer compatible.
- **Classification.** Empty intersection = blocker on the plugin (it will not load); non-empty but at the boundary (e.g. the plugin wants `^1.2.0` and we are on `1.2.0`) = informational.
- **Recovery.** Either upgrade the plugin to a version compatible with the current kernel, or downgrade the kernel (rare), or remove the plugin. The drift command surfaces each option.

#### 6. Witness drift

- **Detection.** Run the witness `verify.mjs` script (per ADR-011 / ruflo ADR-103). For each attested fix or attested memory, check whether the current SHA matches the manifest's claim.
- **Classification.** Any mismatch is **always** treated as urgent. Either the attested artefact has regressed (someone removed a fix) or an attacker mutated state. The drift command does not auto-recover; it surfaces the diff and asks for human review.
- **Recovery.** Manual. Either the change is legitimate (re-run `regen-witness.mjs` to update the manifest) or it is not (revert the offending change).

### The `drift` CLI command

The kernel exports `@metaharness/kernel/drift`. Every generated harness exposes it as `npx <harness-name> drift <subcommand>`.

Subcommands:

```bash
# Show a summary of all detected drift across all six kinds. Default verbose.
npx <harness-name> drift check

# JSON output (for CI consumption).
npx <harness-name> drift check --format json

# Restrict to one drift kind.
npx <harness-name> drift check --kind kernel
npx <harness-name> drift check --kind template
# (etc.)

# Recovery actions.
npx <harness-name> drift accept-local <path>       # User edit, manifest records new SHA
npx <harness-name> drift restore <path>            # Revert to generated state
npx <harness-name> drift apply-template <path>     # Apply the upstream template's new version
npx <harness-name> drift merge-template <path>     # Open 3-way merge for conflicts
```

The JSON output is the load-bearing format. The CI workflow (ADR-007 §B5) consumes it.

```jsonc
{
  "checkedAt": "2026-06-13T...",
  "manifestPath": ".harness/manifest.json",
  "kinds": {
    "kernel":   { "drifted": true,  "from": "1.2.0",  "to": "1.4.0",  "severity": "actionable" },
    "template": { "drifted": false, "items": [] },
    "catalogue":{ "drifted": true,  "items": [ { "entry": "coder",   "from": "2.1.0", "to": "2.2.0", "severity": "safe" } ] },
    "localEdit":{ "drifted": true,  "items": [ { "path": "src/index.ts", "expected": true } ] },
    "apiSurface":{ "drifted": false, "items": [] },
    "witness":  { "drifted": false, "items": [] }
  },
  "summary": { "totalDrifted": 3, "safe": 1, "actionable": 1, "urgent": 0 }
}
```

The exit code is `0` if all `severity` are `"safe"`, `1` if any are `"actionable"`, `2` if any are `"urgent"`. CI uses the exit code; humans read the JSON.

### The CI workflow

ADR-007 §B5 specifies `harness-drift-check.yml`, which runs weekly. Concretely:

```yaml
name: Drift check
on:
  schedule: [{ cron: '0 6 * * 1' }]      # Monday 06:00 UTC
  workflow_dispatch: {}

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - id: drift
        run: npx <harness-name> drift check --format json > drift.json
        continue-on-error: true
      - if: steps.drift.outputs.exit_code != '0'
        run: |
          gh issue create \
            --title "Drift detected: ${{ steps.drift.outputs.summary }}" \
            --body-file drift-issue-body.md \
            --label "drift"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      # If exit code is 1 (actionable, no urgent), also auto-open a PR:
      - if: steps.drift.outputs.exit_code == '1'
        run: |
          npx <harness-name> drift apply --safe-only
          # commit the result on a new branch
          gh pr create --title "chore(drift): apply safe updates" --body-file drift-pr-body.md
```

`drift apply --safe-only` applies every `severity: "safe"` action without prompting and skips the rest. The PR contains exactly the deltas the user can merge with a single approval.

### The generator's own drift handling

The generator repo (`ruvnet/agent-harness-generator`) also runs drift detection — but against its own templates. Specifically, ADR-007 §A16 (`kernel-template-coherence`) is a drift gate that fails the build if the bundled templates do not match the current kernel version.

Additionally, the generator runs a periodic compatibility-matrix check (`scripts/check-harness-compatibility.mjs`) that picks a sample of recently-published harnesses from npm under `@metaharness/*` and `@claude-flow/plugin-*` scopes, fetches their `.harness/manifest.json`, and asserts that the current kernel + catalogue versions are still compatible. Surfaces broken downstream consumers before they file a bug.

### Drift severity threshold for blocking

The harness's CI (`harness-ci.yml` from ADR-007 §B1) can optionally fail on drift. Configurable via `harness.config.json` `ci.failOnDrift`:

- `"none"` — never fail (default; the weekly check opens issues but PRs are never blocked).
- `"urgent"` — fail only if witness or API-surface drift is urgent.
- `"actionable"` — fail on any actionable drift.
- `"safe"` — fail on any drift at all (paranoid mode, useful for regulated environments).

Most harnesses run `"none"` or `"urgent"`. Vertical packs in regulated domains (legal, healthcare) typically run `"actionable"`.

### Drift detection for unmanaged files

A harness inevitably contains files the generator never wrote — the user's own modules, their own tests, their own docs. These are absent from the manifest. The drift checker leaves them alone. A user who wants to add files under generator-control runs `npx <harness-name> drift adopt <path>` which records the file in the manifest as `{ "fromUser": true }`. Adopted files participate in drift detection only for the local-edit kind (the manifest's recorded SHA becomes the canonical "user's intended version"), not for template / catalogue / kernel drift.

### Special case: the eject mode

A harness that has been ejected (ADR-012 §Eject) has vendored the kernel. The kernel drift kind is replaced with "vendored-kernel drift" — a comparison against the vendoring tag rather than the npm registry. The template and catalogue drift kinds behave the same. The user is on their own for security updates; the drift command warns about this prominently when run on an ejected harness.

## Consequences

### What gets easier

- **The "is my harness up to date?" question has an answer.** One command. Multi-kind.
- **Weekly auto-PRs.** A harness whose maintainer ignores it for a month gets a PR every week with safe updates applied. The harness does not silently rot.
- **Witness regression detection is the same machinery.** ADR-103 in ruflo already commits to detecting fix regressions; this ADR generalises the pattern to template / catalogue / kernel.
- **The downstream-compatibility check on the generator side** surfaces breakage before users file bugs.

### What gets harder

- **The manifest is a forever-promise.** Every file the generator writes is recorded; if the manifest schema changes, the migration must rewrite recorded entries. ADR-003 §Schema versioning handles this.
- **The 3-way merge UI is non-trivial.** Implementing it well is its own ADR-12-sized project. For v1.0 the merge is conservative: it surfaces the three files and asks the user to resolve in their editor. A proper UI is post-v1.0.
- **CI minutes for weekly drift checks across thousands of generated harnesses.** Each one is a tiny job (≤ 30 s) but it is a real volume. If the generator becomes popular, this is a real bill — the harness pays, not the generator.

### What does not change

- The kernel itself does not have to know about drift. The drift command is in `@metaharness/kernel/drift`, yes, but it operates on the manifest, not on the kernel's runtime. Removing the drift package does not affect kernel runtime behaviour.
- The marketplace registry shape is unchanged. Drift detection consumes the registry; it does not modify it.

## Alternatives Considered

### Alternative 1: No drift detection; rely on `npm outdated`

`npm outdated` shows kernel drift. Catalogue and template and witness drift have no equivalent. Rejected because the load-bearing failure mode is "the user's template-derived file has fallen out of sync with the upstream template" — `npm outdated` knows nothing about templates.

### Alternative 2: Use Renovate / Dependabot for everything

Renovate is excellent for npm-package version drift. Rejected for the same reason as Alternative 1 — Renovate cannot detect template drift, catalogue drift, witness drift, or local-edit drift. We use Renovate as a complement: it handles npm-version drift (a subset of kernel drift); our `drift` command handles the rest. ADR-007 §A13 keeps Renovate in the loop.

### Alternative 3: Periodic full-regeneration (re-run the generator)

`npx create-agent-harness --regenerate` would overwrite generated files with the latest template content. Rejected because it destroys local edits, and the cases where local edits are intentional are exactly the cases where the user is most engaged with the harness. The 3-way merge approach lets local edits survive an upgrade.

### Alternative 4: One-way drift detection (read-only check, no fix)

Detect drift but do not provide recovery commands. Rejected because the response to "your harness is drifting" cannot reasonably be "go fix it yourself, here are 47 files." The recovery commands are the load-bearing payoff.

### Alternative 5: Use copier directly

Copier (https://github.com/copier-org/copier) is Python and we are Node, but its drift / upgrade model is the inspiration here. Rejected as a direct dependency for the same reasons as ADR-003 §Alternative 2 — shipping a Node CLI that depends on Python is a worse experience than re-implementing copier's manifest model in Node. We borrow the design, not the code.

## Test Contract

This ADR is satisfied when the following exist:

### Detection tests (per drift kind)

For each of the six kinds:

1. **A fixture** that exercises the drift (e.g. a harness manifest claiming `kernel@1.0.0` against a registry serving `1.4.0`).
2. **A test** asserting the drift command detects it with the right `severity` and the right human-readable summary.

### Recovery tests

3. **Restore round-trip** — apply a local edit, run `drift restore`, file matches manifest SHA.
4. **Accept-local round-trip** — apply a local edit, run `drift accept-local`, manifest's recorded SHA updates to the new content.
5. **Apply-template** — fixture with a template change; `drift apply-template` produces the expected new file content.
6. **Merge-template conflict** — fixture with local edit + template change; `drift merge-template` produces a 3-way conflict marker file in the expected form.

### CI integration tests

7. **`drift check --format json` schema** — the JSON output validates against `packages/kernel/drift/schema/drift-report.schema.json`.
8. **Weekly cron PR flow** — synthetic GitHub Actions environment runs the workflow; asserts the PR is opened, contains the expected drift summary, and the safe-only changes have been applied.

### Generator-side test

9. **`scripts/check-harness-compatibility.mjs`** — given a fixture of mock harness manifests from "downstream consumers," asserts the compatibility matrix correctly identifies breakage.

## References

### Ruflo internals cited

- `v3/docs/adr/ADR-103-witness-temporal-history.md` — the witness drift model the witness-kind here generalises.
- `scripts/regen-witness.mjs` and `plugins/ruflo-core/scripts/witness/*` — the witness recovery commands.

### External prior art

- `copier` (https://github.com/copier-org/copier) and its "regenerate-diff-merge with persisted answers" upgrade model documented at https://copier.readthedocs.io/en/stable/updating/ — the most influential prior-art reference. Copier's `.copier-answers.yml` is the single-source-of-truth pattern this ADR mirrors via `.harness/manifest.json` (per ADR-003 §The harness manifest).
- Renovate (https://docs.renovatebot.com/) and Dependabot (https://docs.github.com/en/code-security/dependabot) — npm-version drift tooling.
- `npm outdated` (https://docs.npmjs.com/cli/v10/commands/npm-outdated) — the basic version-drift baseline.
- Three-way merge: classic SCM literature (Mens, "A state-of-the-art survey on software merging," IEEE TSE 2002).

### Ruflo ADRs cited

- ADR-003 (Generator architecture) — the manifest format this ADR consumes.
- ADR-007 (CI guards) — the weekly cron and the CI integration.
- ADR-011 (Witness) — the witness drift's recovery path.
- ADR-012 (Eject + upgrade) — the upgrade flow `drift apply-template` invokes.
