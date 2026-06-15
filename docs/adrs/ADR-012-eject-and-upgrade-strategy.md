# ADR-012: Eject + Upgrade Strategy

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary), ADR-003 (Generator architecture, the harness manifest), ADR-008 (Drift detection)

## Context

A generated harness has a long life. The kernel does not stand still. Six months after generation, the harness operator wants the security fixes, the performance improvements, the new MCP tools — without rewriting their harness. They want a route from "outdated" to "current" that is mechanical, reviewable, and reversible.

A different operator, for legitimate reasons (regulated environment, irreconcilable customisation, organisational policy), wants to **stop depending on upstream**. They want to vendor the kernel into their tree and own it.

These are not the same path. Most harnesses do the first; a few do the second; the system must support both without making either feel like the path of least resistance to the other. The create-react-app failure mode (eject was the only escape, eject destroyed the upgrade path) is the canonical "this went wrong" story we mitigate against.

This ADR pins down both: the upgrade flow that keeps a harness on the upstream kernel, and the eject flow for organisations that need independence — and what each gives up.

## Decision

### Default: peer-dep, upgrade via `drift apply-template`

A freshly generated harness has `@metaharness/kernel` as a peer dependency in its `package.json`:

```jsonc
{
  "name": "@acme/acme-support",
  "peerDependencies": {
    "@metaharness/kernel": "^1.2.0"
  },
  "dependencies": {
    "@metaharness/kernel": "^1.2.0"   // also pinned here for self-contained npm install
  },
  "engines": {
    "kernel": "^1.2.0"
  }
}
```

The peer + dependency dual-declaration mirrors VS Code extensions (which declare `engines.vscode` and resolve VS Code as a peer). The peer dependency advertises the harness's compatibility range to consumers (e.g. a plugin loading inside the harness). The regular dependency makes the harness self-installable for users who run it standalone.

Upgrade is the ADR-008 drift-detection command:

```bash
npx <harness-name> drift check               # any kernel drift?
npx <harness-name> drift apply kernel        # apply the kernel update
npx <harness-name> drift apply-template      # apply any consequent template updates
```

The flow:

1. `drift check` surfaces a new kernel version (per ADR-008 §1).
2. The user reads the kernel's changelog.
3. `drift apply kernel` bumps the version, runs `npm install`, runs the harness's own test suite.
4. If any template files updated alongside the kernel version (e.g. the kernel `1.4.0` shipped a new MCP wiring template), `drift apply-template` 3-way-merges the new template against the user's tree.
5. The user commits the result. The next release of the harness rolls forward to the new kernel.

This is the default path. It is the only path most harnesses ever take.

### Kernel semver rules (recap from ADR-002)

To make the default path safe:

- **Patch** (`1.4.0 → 1.4.1`) is bug fixes only. No API change. The peer range `^1.2.0` matches; `drift apply` is mechanical.
- **Minor** (`1.4.0 → 1.5.0`) is backward-compatible additions. New exports allowed; existing exports unchanged. The peer range `^1.2.0` matches.
- **Major** (`1.x → 2.0.0`) is breaking. The peer range `^1.2.0` does not match. The harness must explicitly accept the upgrade.

A major-version upgrade has its own flow, below.

### Major-version upgrade flow

When the kernel ships a major version, the kernel team ships a `codemod` alongside:

- The codemod is shipped as `@metaharness/kernel-codemod-N-to-M` (e.g. `@metaharness/kernel-codemod-1-to-2`).
- It uses AST-based transforms (the same renamer infrastructure ADR-003 §The renamer specifies) to update import paths, rename moved exports, replace removed signatures.
- The codemod is run by the user via `npx <harness-name> upgrade kernel --major --to 2.0.0`.

The codemod's deliverable:

1. The kernel version in `package.json` and `engines.kernel` is bumped.
2. Every `import` of the kernel is rewritten to the new API.
3. Configuration in `harness.config.json` is migrated to the new schema (if any).
4. A `MIGRATION-NOTES-1-to-2.md` is written at the harness root describing what changed.

If the codemod cannot resolve something (a custom usage of a removed API), it leaves a `// TODO(kernel-2-migration): ...` comment and surfaces a list at the end of the run.

The kernel team commits to shipping a codemod with every major release. This is the load-bearing promise — without the codemod, every major release would strand existing harnesses.

### Deprecation lane for kernel API changes

When a kernel API is going to be removed in the next major, it gets deprecated one full major version before:

1. **Major N-1 minor M** — API marked `@deprecated` in TypeScript. Documentation updated. Codemod cannot exist yet (no removal date).
2. **Major N first release** — API removed. Codemod `(N-1)-to-N` rewrites usages to the new API.

A deprecated API works for at least one major version. This gives downstream consumers a release cycle of warning before forced migration. The TypeScript `@deprecated` JSDoc tag surfaces in IDE tooltips during that window.

### The eject flow

A user who needs to stop depending on upstream runs:

```bash
npx <harness-name> eject
```

The eject flow:

1. **Confirm.** Display the consequences (no more `drift apply kernel`; no more codemod migrations; security fixes are now manual). Require typed confirmation.
2. **Vendor the kernel.** Copy `node_modules/@metaharness/kernel/` into `vendor/kernel/` in the harness tree.
3. **Rewrite imports.** Every `import ... from '@metaharness/kernel/*'` becomes `import ... from '../vendor/kernel/dist/...'`. AST-based rewrite via the same renamer.
4. **Drop the kernel from `package.json` `dependencies`.** The `peerDependencies` declaration is also dropped; the eject mode publishes the harness as kernel-free.
5. **Add an eject marker.** `.harness/ejected.json` records the eject metadata: the kernel version vendored, the date, the reason (if supplied).
6. **Update `.harness/manifest.json`.** The kernel section becomes `{ "vendored": true, "originalVersion": "1.4.0", "vendoredAt": "..." }`.
7. **Drift detection switches modes.** ADR-008 §Special case: the eject mode — the kernel-drift check now compares against the vendoring tag rather than the npm registry, and "kernel updates" become a manual `git diff` against a future ruflo release.

The eject is one-way in the sense that there is no `unesect` command. The harness can manually re-adopt the kernel by undoing the vendoring (essentially regenerating from the current template), but the route is "regenerate," not "unsetect." We do not pretend otherwise.

#### What eject does NOT do

- It does not remove host adapters, the catalogue, vertical packs, or the marketplace client. These remain peer dependencies; ejecting only vendors the kernel itself.
- It does not change the harness's marketplace participation. The harness is still a marketplace publisher / consumer.
- It does not destroy the witness manifest or its key.

The user who needs to also vendor the host adapters (because their compliance posture requires it) runs `eject --include-adapters`. Each adapter is vendored the same way the kernel was. There is no `eject --include-everything` flag — vendoring the catalogue, the vertical packs, etc. is a request-by-request choice.

### Eject mode upgrade

An ejected harness is on its own for security and feature updates. The kernel team has zero obligation. We do, however, document a recipe for a manual upgrade:

1. Generate a new harness from the current generator (`npx create-agent-harness fresh-copy --hosts ...`).
2. Diff the fresh-copy's `vendor/kernel/` against the ejected harness's `vendor/kernel/`.
3. Apply the diff manually.

This is intentionally tedious. The eject mode promised the operator full ownership; the cost is they own the upgrade work.

### Eject mode in CI

The harness's CI (ADR-007 §B) still runs on an ejected harness. The differences:

- `B5 drift-check` runs but operates in the ejected manner described in ADR-008.
- `B1 ci.yml` runs against the vendored kernel; the smoke contract is unchanged.
- The `kernel-template-coherence` gate (the generator-side §A16) does not apply — ejected harnesses do not have a template-to-kernel pin to coherence-check.

### Choosing the path

The composer (ADR-003) does **not** offer eject at generation time. Eject is a downstream choice. A user who knows they want independence from day one can run `create-agent-harness foo` then `npx foo eject` as their first commit, but the default path is peer-dep.

This is deliberate: the create-react-app failure was making eject too easy to opt into. We want eject available but recognised as the heavier path.

### Upgrade vs eject decision matrix

For the user wondering which path to take:

| Constraint | Path |
|---|---|
| Default, you want the easiest life | Peer-dep (default). |
| You want bleeding-edge kernel | Peer-dep with `^1.0.0` range, frequent drift-apply. |
| You want predictable kernel, controlled upgrades | Peer-dep with exact-pin (`1.2.0` not `^1.2.0`), drift-apply on review. |
| You ship to regulated environment requiring all dependencies vendored | Eject + `--include-adapters`. |
| You forked because you needed to modify a kernel internal | Stop. Open an issue on the kernel. If the change is upstreamable, upstream it. If not, eject and document the patch. |
| You want to ship a kernel-incompatible variant ("acme-flavoured kernel") | Eject + maintain a fork. You are now responsible for your own upgrade story. |

### The pinning recommendation

For peer-dep mode, the recommended range depends on use case:

- **`^1.0.0`** — get all backward-compatible updates automatically. Best for harnesses that follow upstream closely.
- **`~1.2.0`** — patch-only auto-upgrades; minor versions require explicit `drift apply`. Conservative default.
- **`1.2.0`** — exact pin. Every kernel update requires an explicit version bump. Most conservative; recommended for production-critical harnesses.

The generator defaults to `^1.x.0` for new harnesses; the composer allows the user to choose. Vertical packs in regulated domains default to `~1.x.0` or exact pins.

### Plugin compatibility across kernel upgrades

Plugins declare `kernelEngines` (ADR-005 §2). When the kernel upgrades, the harness checks every installed plugin's range against the new version. Three outcomes:

- **Plugin's range matches.** Plugin works unchanged.
- **Plugin's range does not match, plugin has a newer version that matches.** The drift detection surfaces "upgrade plugin to <newer version>."
- **Plugin's range does not match, no newer version exists.** The drift detection surfaces "plugin incompatible with kernel <new>." The user chooses: stay on old kernel, drop the plugin, or fork it.

These outcomes are the ADR-008 §5 API surface drift.

## Consequences

### What gets easier

- **The default upgrade story is one command.** `drift apply kernel`. Reversible.
- **Eject exists but is opt-in.** Independence is supported; it does not pollute the default path.
- **Major upgrades have codemods.** The kernel team's responsibility for migration is concrete.
- **Plugin compatibility is visible.** Drift surfaces incompatibilities before the user discovers them at runtime.

### What gets harder

- **The kernel team ships codemods every major.** A real ongoing commitment. We mitigate by keeping major releases rare (the kernel is intentionally conservative) and by writing codemods incrementally (every deprecated API gets a codemod entry during the deprecation window).
- **The deprecation discipline must be real.** A major release that removes APIs without a one-major deprecation window is an upgrade contract break. ADR-007 §A2 (API surface freeze) enforces the discipline.
- **Eject mode increases support surface.** Ejected harnesses exist; users will file bugs about them. Triage is "are you ejected? if so, here is the documented manual upgrade recipe."

### What does not change

- The kernel's semver discipline applies regardless of consumer mode.
- Peer-dep mode harnesses continue to participate in the marketplace and the witness model unchanged.

## Alternatives Considered

### Alternative 1: No eject; peer-dep always

Force every harness to stay on upstream. Rejected because the regulated-environment case is real, and forcing organisations to fork the entire generator to escape upstream is worse than offering eject.

### Alternative 2: Vendor by default (no peer-dep mode)

The opposite extreme: every generated harness vendors the kernel. Rejected because it makes the upgrade path worse for the 95% case and explicitly throws away the marketplace's "you can install plugins compatible with kernel X" promise.

### Alternative 3: Live patching via hot-loaded JS

Allow the kernel to be updated at runtime via a network fetch. Rejected because (a) it makes provenance verification incoherent ("which kernel did this signature attest to?") and (b) it introduces a new attack surface (a hostile registry can push a kernel update that compromises every harness).

### Alternative 4: Skip codemods; let users migrate manually

Ship breaking changes without migration scripts. Rejected because the cost of every breaking change falls on every downstream harness simultaneously; codemods compress that work into the kernel team writing it once. CRA's lack of codemods is one of several reasons users left.

### Alternative 5: A `unesect` command

Let an ejected harness return to peer-dep mode. Rejected for v1.0 because the implementation cost is large (we have to detect every customisation made while ejected, decide which to keep, which to revert) and the user pull is unclear. A user who ejected is unlikely to want to un-eject; if they do, regenerating from a fresh template is the right path.

## Test Contract

This ADR is satisfied when the following exist:

### Upgrade flow tests

1. **Patch upgrade** — fixture harness at `1.4.0`; kernel ships `1.4.1`; `drift apply kernel` bumps, installs, tests pass.
2. **Minor upgrade with template change** — fixture harness at `1.4.0`; kernel ships `1.5.0` with a new wiring template; `drift apply` bumps; `drift apply-template` 3-way-merges; tests pass.
3. **Major upgrade with codemod** — fixture harness at `1.5.0`; codemod `1-to-2` exists; user runs `upgrade kernel --major --to 2.0.0`; codemod rewrites imports, migrates config; tests pass.

### Eject flow tests

4. **Eject end-to-end** — fixture harness; run `eject`; verify imports rewritten, kernel vendored, `package.json` updated, `.harness/ejected.json` present, smoke contract still passes.
5. **Eject + ejecting includes adapters** — `eject --include-adapters` also vendors adapters; same smoke contract passes.
6. **Ejected drift check** — fixture ejected harness; drift detection runs in ejected mode (per ADR-008 §Special case).

### Deprecation discipline tests

7. **Deprecation freeze** — a kernel PR that removes an API without a `@deprecated` flag in the previous major fails the A2 surface freeze gate.
8. **Codemod for every deprecated API** — every API marked `@deprecated` in `N-1` major has a corresponding codemod entry by the time `N` ships. Asserted by a script that walks `@deprecated` markers and verifies a matching codemod.

### Plugin compatibility tests

9. **Plugin breaks on kernel upgrade** — fixture: kernel `1.x → 2.x` upgrade; plugin's `kernelEngines: ^1.0.0` no longer matches; drift surfaces the incompat; user is offered the three resolutions.

## References

### External prior art

- **create-react-app deprecation (2025-02-14)** — https://react.dev/blog/2025/02/14/sunsetting-create-react-app — the canonical anti-pattern this ADR mitigates. The React team's own post-mortem on why the unejectable bundled config + frozen `react-scripts` pin combination became unupgradable as soon as its abstractions leaked. The lesson informs every decision in this ADR.
- create-react-app eject documentation: https://create-react-app.dev/docs/available-scripts/#npm-run-eject — the surface that became the trap.
- The Vite team's reasoning for why CRA's eject was a mistake: https://vitejs.dev/guide/why.
- VS Code extension engines / activation events: https://code.visualstudio.com/api/references/extension-manifest.
- `jscodeshift` (AST codemod runner): https://github.com/facebook/jscodeshift — what kernel-codemods use under the hood.
- `next/codemod`: https://nextjs.org/docs/app/building-your-application/upgrading/codemods — exemplary kernel-codemod ergonomics.

### Ruflo ADRs cited

- ADR-002 (Kernel boundary) — the semver discipline.
- ADR-003 (Generator architecture) — the manifest, the renamer.
- ADR-007 (CI guards) — the §A2 API freeze gate.
- ADR-008 (Drift detection) — the upgrade command surface.
