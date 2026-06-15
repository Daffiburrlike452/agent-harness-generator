# ADR-003: Generator Architecture

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-001 (Goals), ADR-002 (Kernel boundary), ADR-004 (Host integration), ADR-008 (Drift detection), ADR-012 (Eject + upgrade)

## Context

The user runs `npx create-agent-harness <name>`. Some seconds later, they have a directory containing a brand-new, npm-publishable agent harness with their chosen name, scope, identity, hosts, agents, skills, and plugins wired up.

This ADR pins down the architecture of the generator: where the templates come from, how the composer interface works, how renaming is done correctly (the part everyone gets wrong), and how the output is structured.

The decisions here cascade into ADR-007 (CI guards), ADR-008 (drift detection), and ADR-012 (eject + upgrade). Specifically: how the generator records what it generated determines whether future kernel upgrades and template upgrades can detect drift cleanly.

> **The generator is TypeScript; the kernel is Rust (wasm + NAPI-RS).** Per ADR-002 and ADR-002a, `@metaharness/kernel` is published from a Rust workspace as a wasm bundle plus per-platform native peers. The generator (`create-agent-harness`) is a conventional TypeScript npm package; it **embeds references to** `@metaharness/kernel` in the templates it writes, and it **depends on** the kernel itself (for `init` / scaffolding helpers it shares with generated harnesses). It does NOT re-implement kernel primitives in TypeScript. Generated harnesses likewise depend on `@metaharness/kernel`; the kernel they consume is the same Rust-source wasm/native build. The generator is the only piece of this project written purely in TypeScript.

## Decision

### Package layout

```
packages/
  kernel/                    # @metaharness/kernel (see ADR-002)
  create-agent-harness/      # the CLI users run
    src/
      cli.ts                 # entry point, arg parsing
      composer/              # interactive picker
      template/              # template runner
      renamer/               # placeholder substitution
      manifest/              # records what was generated (for drift)
      registry/              # template + plugin catalogue fetcher
      hosts/                 # host-aware wiring
      smoke/                 # post-generation smoke test
    templates/               # bundled templates
      _base/                 # always applied
      claude-code/           # host overlay
      codex/                 # host overlay
      pi-dev/                # host overlay
      hermes/                # host overlay
      _features/             # opt-in feature overlays (federation, claims, etc.)
  test-harness/              # the canary harness from ADR-002 §Test Contract
  vertical-packs/            # ADR-013
    legal/
    trading/
    ...
```

### The CLI surface

```bash
# Trivial (zero-question) — uses defaults, generates a Claude Code harness.
npx create-agent-harness <name>

# With scope
npx create-agent-harness <name> --scope @acme

# Non-interactive (CI / scripted)
npx create-agent-harness <name> --scope @acme \
  --hosts claude-code,codex \
  --agents coder,reviewer,tester \
  --skills hooks-automation,memory-search \
  --plugins @claude-flow/security \
  --features memory,routing,witness \
  --no-interactive

# Interactive composer (default)
npx create-agent-harness <name>

# From an existing project — eject ruflo into a generated harness
npx create-agent-harness <name> --from-existing ./my-ruflo-project

# Template choice (default: "standard"; others: "minimal", "vertical-trading", …)
npx create-agent-harness <name> --template minimal

# Use a non-default kernel version
npx create-agent-harness <name> --kernel ^1.2.0

# Use a custom template registry CID (independence mode)
npx create-agent-harness <name> --registry-cid <ipfs-cid>
```

### Two run modes: offline and online

**Offline mode (default)**: every template the CLI needs is bundled into the published `create-agent-harness` package. No network call required to scaffold. The bundled templates are pinned to a kernel version at publish time. Time-to-first-harness is bounded by `npm install`.

**Online mode (`--registry-cid <cid>` or `--latest`)**: the CLI fetches the template registry from IPFS (the same Pinata gateway ruflo uses today, per `CLAUDE.md` §Plugin Registry Maintenance), verifies its Ed25519 signature, and uses the registry's pointers to the latest templates. Used when the user wants bleeding-edge or a non-ruflo registry.

The two modes share the same template runner. The difference is only where the template files come from. This means CI smoke tests can run offline, and air-gapped users can still scaffold.

**Why bundled-default + IPFS-online (and not one or the other)** — we are picking a posture between two well-known anchors:

- `create-vite` bundles ~18 templates as sibling directories in the published package (one for each framework variant). Pure offline; no template registry. Maintains tight kernel/template coherence by construction at publish time.
- `create-next-app` does dual-source: a bundled default template plus a `--example <name>` flag that fetches from `vercel/next.js/examples/` at HEAD. Mixes offline fast-path with a "latest from upstream" escape hatch.

We adopt `create-next-app`'s dual-source posture (bundled offline default + IPFS-registry-driven online mode) rather than `create-vite`'s pure-offline one, because the marketplace participation story (ADR-005) needs a path for new templates to ship outside the generator's release cadence. Bundled-default keeps the trivial case fast; IPFS-online lets vertical packs ship their own templates without waiting for the next generator release.

### The composer

The composer is the interactive picker. It runs when the user did not pass `--no-interactive` and did not specify every choice on the command line.

Stages, in order:

1. **Identity.** Name (defaults to argv), scope (`@acme/`), description, license, author. One screen.
2. **Hosts.** Multi-select: Claude Code, Codex, pi.dev (badlogic Pi), Hermes. At least one required. Capability notes shown per host (e.g. "pi.dev deliberately ships without MCP — the adapter integrates as a Pi extension instead; see ADR-004 §pi.dev").
3. **Primitives.** Toggle which kernel subsystems to include: `mcp` (always on), `hooks`, `memory`, `routing`, `marketplace`, `witness`. Default: all on. A "minimal" preset toggles all but `mcp` and `hooks` off.
4. **Agents.** Multi-select from the curated catalogue (the catalogue is content; see "Catalogue" below). Search box, category filter. Defaults: `coder`, `reviewer`, `tester`.
5. **Skills.** Multi-select. Defaults: `hooks-automation`, `memory-search`, `swarm-orchestration`.
6. **Plugins.** Multi-select from the IPFS registry. Resolves real-time downloads + ratings from npm where present. Defaults: empty.
7. **Features.** Opt-in features that change the wiring: `--features federation`, `--features claims`, `--features self-evolution`, `--features federated-memory`. These add overlay templates; see "_features/" overlay below.
8. **Branding.** Independence / powered-by toggle (ADR-015). Branding strings.
9. **Confirm.** Summary screen, list of every file that will be created, the kernel version pinned, the disk size estimate. "Generate" / "Back".

Each stage is a discrete UI component. The composer's state is a single typed `HarnessChoice` object. The same object is the input to the template runner. This means the same flow works in both interactive and non-interactive modes — `--no-interactive` is just a way to construct `HarnessChoice` from command-line flags instead of TTY prompts.

This pattern is borrowed from `create-vite` (https://github.com/vitejs/vite/tree/main/packages/create-vite) — the bundled `prompts` script populates a config that drives template selection. We extend it with a layered overlay model (see "Template structure" below) so feature toggles compose without forking the template tree.

### Template structure — base + overlays

Templates live under `packages/create-agent-harness/templates/`. The structure:

```
_base/                       Always applied first. Universal harness scaffold.
  package.json.hbs           Handlebars-templated package manifest
  README.md.hbs              Templated README
  bin/<name>.mjs.hbs         Entry point wrapper
  src/index.ts.hbs           Kernel wiring
  src/config.ts.hbs          Generated config
  .gitignore
  tsconfig.json
  vitest.config.ts

claude-code/                 Host overlay
  files merge over _base when "claude-code" is selected
  CLAUDE.md.hbs              Host instructions
  .claude/settings.json.hbs  Claude Code settings
  .mcp.json.hbs              MCP registration

codex/                       Host overlay
  AGENTS.md.hbs              Codex's agent instructions file
  .codex/config.toml.hbs     Codex MCP config (see ADR-004 §Codex)

pi-dev/                      Host overlay (final shape per ADR-004 §pi.dev)
  pi-dev.config.json.hbs
  ...

hermes/                      Host overlay
  HERMES.md.hbs              Hermes-agent instructions
  .hermes/tools.json.hbs     Hermes tool definitions
  ...

_features/                   Opt-in feature overlays. Applied on top of host overlays.
  federation/                Adds federation transport wiring
  claims/                    Adds claims-based authorization
  self-evolution/            Adds the learning loop applied at harness level
  federated-memory/          Adds federated memory layer
  witness/                   Adds witness manifest scaffolding
```

The merge order is: `_base` → each selected host overlay → each selected feature overlay. Later wins. A file in `claude-code/` overrides the same file in `_base/`. A file in `_features/federation/` overrides whatever the host overlay laid down.

This overlay model is borrowed from `create-vite`'s `template-vue`, `template-react`, etc. siblings; we generalise it to support multi-axis composition (host × feature). The conflict resolution rule (last overlay wins) keeps the model simple. Conflicts that span axes are caught at composer-confirm time: if `_features/federated-memory/` would overwrite a critical `_base/` file in a way that breaks Claude Code, the composer warns before generating.

### The renamer

This is the part everyone gets wrong. Naive `sed` substitution corrupts code — it renames things that should not be renamed (a variable named `claudeFlow` inside an unrelated dependency), and misses things that should be (a string in a YAML hook).

Our approach: parse, do not string-replace.

- **Source code (`.ts`, `.tsx`, `.js`, `.mjs`)** — parse with the TypeScript compiler, walk the AST. Rename only identifiers and string literals that match a known placeholder set. The placeholder set is small (`__HARNESS_NAME__`, `__HARNESS_SCOPE__`, `__HARNESS_DESCRIPTION__`, `__KERNEL_VERSION__`, `__BRAND_DISPLAY__`, `__BRAND_TAGLINE__`, `__IPFS_REGISTRY_CID__`, `__HOST_NAME__`, `__MCP_SERVER_KEY__`, `__AUTHOR__`, `__LICENSE__`). Anything else is left alone.
- **JSON / YAML / TOML** — parse with the appropriate format-aware parser, walk the tree, substitute placeholders only at known keys (`name`, `description`, `author`, `bin`, `engines.kernel`, MCP server keys). The schema for known keys is declared in `packages/create-agent-harness/src/renamer/schemas/`.
- **Markdown** — Handlebars-template the markdown. The `.md.hbs` files are explicitly templated, so the renamer's job there is just running `Handlebars.compile`.
- **Binary** — copied verbatim. If a binary asset needs renaming (e.g. a logo with the brand burned in), the harness author must replace it post-generation; the generator does not paint logos.

This three-track approach (AST for code, schema-driven for structured config, templated for prose) is the only way to keep renaming correct at scale. Cookiecutter (https://github.com/cookiecutter/cookiecutter) uses Jinja2 across all file types, which is fine for Python but produces invalid TypeScript when a placeholder lands mid-expression. Copier (https://github.com/copier-org/copier) uses Jinja2 with an `_exclude` glob for binaries, but still string-substitutes inside code. We pay the parser cost in exchange for output we can trust.

### What the generated harness looks like

The output of `npx create-agent-harness acme-support --scope @acme --hosts claude-code` is approximately:

```
acme-support/
  package.json              { "name": "@acme/acme-support", "bin": { "acme-support": "bin/acme-support.mjs" }, ... }
  bin/
    acme-support.mjs        Thin shim; loads dist/cli.js
  src/
    index.ts                Imports from @metaharness/kernel; wires the host adapter
    config.ts               Harness config (hosts, features, kernel version, ...)
    agents/                 Selected agents (copied from catalogue)
    skills/                 Selected skills (copied)
    commands/               Selected commands
  .claude/
    settings.json           Claude Code hooks wiring (points at this harness's hooks)
    skills/                 Symlinked / copied skill markdowns
    agents/                 Symlinked / copied agent definitions
  .mcp.json                 Claude Code MCP registration for @acme/acme-support
  CLAUDE.md                 Host instructions for Claude Code (templated)
  README.md                 User-facing readme
  .github/
    workflows/
      ci.yml                Pre-publish CI gate (ADR-007)
      release.yml           npm publish + provenance + witness regen
  .harness/
    manifest.json           Records what was generated (see "The harness manifest" below)
    witness/                Empty witness scaffolding (per ADR-011)
  tsconfig.json
  vitest.config.ts
  tests/
    smoke/                  Smoke test that proves wiring works (ADR-010)
    contract/               Host-contract tests (ADR-010)
```

If the user picked Codex too, the same tree has `AGENTS.md`, `.codex/config.toml`, and the Codex host adapter wired in. If they picked `--features federation`, `src/index.ts` imports `@metaharness/kernel/hosts/federation` and the federation transport is configured in `src/config.ts`.

### The harness manifest

A new file the generator writes: `.harness/manifest.json`. This is the single canonical record of "what we generated, against what versions, with what choices." It is the source-of-truth for drift detection (ADR-008) and the upgrade story (ADR-012).

Schema (simplified):

```jsonc
{
  "harnessManifestVersion": 1,
  "generatedAt": "2026-06-13T12:34:56Z",
  "generator": {
    "name": "create-agent-harness",
    "version": "1.0.0",
    "templateRegistryCid": "Qm..." // null for offline mode
  },
  "kernel": {
    "name": "@metaharness/kernel",
    "version": "1.2.0",
    "subsystemsIncluded": ["mcp","hooks","memory","routing","marketplace"]
  },
  "choice": {
    "identity": { "name": "acme-support", "scope": "@acme", "branding": "powered-by" },
    "hosts": ["claude-code","codex"],
    "agents": ["coder","reviewer","tester"],
    "skills": ["hooks-automation"],
    "plugins": [ { "name": "@claude-flow/security", "version": "3.0.0" } ],
    "features": ["witness"]
  },
  "files": [
    { "path": "src/index.ts", "sha256": "...", "fromTemplate": "_base/src/index.ts.hbs" },
    { "path": "src/agents/coder.md", "sha256": "...", "fromCatalogue": "coder@2.1.0" },
    ...
  ]
}
```

The manifest answers three questions:

1. **"What did I get?"** — every file in the harness is enumerated with its template-of-origin or catalogue-of-origin, and a SHA-256 of the generated content.
2. **"What kernel version was I built against?"** — `kernel.version` is canonical.
3. **"What choices did I make?"** — `choice` reproduces the composer state. Re-running the generator with the same `choice` produces a bit-identical harness (up to timestamp fields).

ADR-008 uses the manifest's `files[].sha256` to detect drift between the live tree and what was generated. ADR-012 uses `kernel.version` and `choice` to compute the upgrade delta. ADR-011 uses the manifest as input to the witness signing.

This pattern is borrowed from `copier` (https://github.com/copier-org/copier), which keeps a `.copier-answers.yml` of the same shape and uses it to re-apply template updates. Copier is the most interesting prior-art reference in this ADR; the manifest concept is the load-bearing one that makes drift detection feasible.

### Catalogue: where agents / skills / plugins are picked from

The composer offers a curated catalogue. The catalogue is content, not kernel — it lives in its own package, `@metaharness/catalogue`, which the generator depends on. The package contains:

- `agents/<id>.md` — agent definition (system prompt, model preferences, tool allowlist, metadata)
- `skills/<id>/SKILL.md` — skill (the format ruflo already uses, see `plugins/ruflo-core/skills/*`)
- `commands/<id>.md` — slash commands
- `catalogue.json` — index, categories, tags, versions

The catalogue is versioned independently of the kernel and the generator. A new catalogue version (more agents, updated skills) does not require regenerating harnesses; harnesses pull catalogue entries at install time via the manifest's `agents` and `skills` lists. ADR-008 detects when a catalogue entry the harness depends on has been updated, and surfaces the diff.

A user who wants to ship their own private catalogue points the composer at it via `--catalogue <package>`. This is the path for organisations that have internal-only agents.

### Smoke check on generation

Right after generation, before the CLI exits, it runs an in-process smoke test:

1. `npm install` in the generated directory (or `pnpm install` / `yarn install` if detected; default: `npm`).
2. `npm run build` — succeeds.
3. `npm run test -- --run` — passes the bundled `tests/smoke/` suite.
4. Invoke `npx <harness-name> --help` — exits 0.
5. Print the harness's `.harness/manifest.json` digest.

If any of these fails, the CLI surfaces the error verbatim and offers `--keep-failed` (do not delete the directory) and `--rollback` (delete it). Default: print, exit nonzero, keep the directory.

This is the canary that catches a kernel-template-version mismatch before the user is left holding a broken scaffold. It also serves as the input contract for ADR-009 (anti-slop): a harness that does not pass its own smoke test cannot be published.

### Performance budget

- **Time from `npx create-agent-harness foo` to a generated, smoke-passing harness on a warm npm cache**: ≤ 90 seconds.
- **Time from `npx ...` to the composer first paint**: ≤ 5 seconds (this is mostly `npm` resolving the package).
- **Disk size of a default harness**: ≤ 10 MB before `npm install`, ≤ 200 MB after.

These budgets are enforced by ADR-007 §Perf gates.

## Consequences

### What gets easier

- **Re-runnable scaffolding.** Because the manifest records the exact choices, a user can re-run the generator with the same inputs and get a deterministic output. Useful for CI, useful for regenerating after a template fix.
- **Drift detection is cheap.** ADR-008 hashes the live tree's files and compares against the manifest. No magic required.
- **Upgrade path is clear.** ADR-012 walks the manifest, computes the diff against the new kernel/template version, applies the patch.
- **Test surface is small.** The renamer's AST-based approach means we only have to fuzz a small placeholder set, not the universe of strings.

### What gets harder

- **The template runner is non-trivial.** A `cookiecutter`-style runner would be ~200 lines; ours, with three rename tracks plus overlay merging plus manifest writing, will be closer to ~3000. ADR-010 mandates a heavy unit-test suite for the renamer.
- **Catalogue maintenance is real work.** Curating `@metaharness/catalogue` is its own project. It is owned by the ruflo maintainers initially; ADR-013 covers how vertical-pack owners contribute.
- **Two install paths to support.** Offline (bundled) and online (IPFS) templates means two test suites. We mitigate by keeping the same template runner across both paths — the difference is just where files come from.

### What does not change

- The kernel does not know about the generator. The generator is content tooling that consumes the kernel like any other harness would.
- The marketplace plugin model is unchanged. The generator participates as a plugin (ADR-005) but does not reshape the plugin schema.

## Alternatives Considered

### Alternative 1: Use Yeoman

Yeoman (https://yeoman.io/) is the canonical Node generator framework. Its sub-generator composition model is genuinely good. Rejected because (a) Yeoman has not had a major release in years and the ecosystem has moved on (create-vite, create-next-app, create-cra deliberately do not use it), (b) Yeoman's prompt system is more elaborate than we need and brings in a transitive-dependency tail we want to avoid on the publish path, and (c) we want zero generator-framework dependencies — every supply-chain risk on `npx create-agent-harness` is a risk on every user's first install.

### Alternative 2: Use Cookiecutter / Copier (Python tooling under the hood)

`cookiecutter` and `copier` are both excellent. Rejected because shipping a Node CLI that depends on a Python tool means every user needs a working Python install, and Windows users have an even worse time. We re-implement copier's manifest-and-update model in Node (see "The harness manifest" above) but do not shell out to copier.

### Alternative 3: Naive string-replace renaming

`sed -i` over every file with a placeholder map. Rejected because it produces invalid output the moment a placeholder collides with an identifier in an unrelated file (e.g. a dependency that happens to have `claudeFlow` in its source). The AST-based approach is more work but the output is correct by construction.

### Alternative 4: Template-as-data (declarative templates)

A JSON or YAML file that declares the harness shape, parsed and rendered by the runner with no actual template files. Rejected because the templates are most maintainable when they look like real code (TypeScript syntax-highlighted, lintable, runnable as a smoke test in isolation). The `_base/src/index.ts.hbs` file is a real TypeScript file with Handlebars markers; an editor can syntax-check most of it. A declarative template loses that.

### Alternative 5: Online-only mode (no bundled templates)

Always fetch templates from IPFS. Rejected because (a) air-gapped CI environments are a real user — we have them inside ruflo today, (b) IPFS gateway latency adds 10–30 seconds to time-to-first-harness, and (c) offline mode is the canary for "does the bundled template still match the kernel?" — if it does not, we have a release-process bug.

### Alternative 6: No composer; flags only

Skip the interactive UI entirely. The user must specify every choice on the command line. Rejected because the trivial-tier use case ("3-agent customer-support harness") is the volume case, and forcing a new user to read documentation before they can scaffold is a bad first experience. The composer's stages are the documentation, rendered as a UI. (The `--no-interactive` mode still exists for CI.)

## Test Contract

This ADR is satisfied when the following exist:

### Generator unit tests (London-school)

1. **Composer state-machine tests** — each stage is a pure function from `(state, input) → newState`. Each transition is covered. The composer is tested without a TTY.
2. **Renamer round-trip tests** — for each file type (TypeScript, JSON, YAML, TOML, Markdown), assert that a known placeholder set is correctly substituted and a known set of accidental-collision strings is NOT substituted. The test suite includes adversarial inputs (a TypeScript variable named `__HARNESS_NAME__` — the renamer's substitution should be aware of identifier scope and rename only the placeholder).
3. **Overlay merge tests** — for a fixed set of overlays, assert the final tree matches the expected merge. Conflict-detection tests use overlays designed to collide.
4. **Manifest write tests** — given a `HarnessChoice` and a generated tree, the manifest is correct: every file is enumerated, every SHA matches, `choice` round-trips.

### Generator integration tests

5. **Trivial-harness end-to-end** — `npx create-agent-harness test-trivial --hosts claude-code --no-interactive` produces a directory that passes `npm install && npm run build && npm test`.
6. **Exotic-harness end-to-end** — the ADR-001 §Test Contract "exotic" canary: federation + multi-host + custom DISTILL — built via the same CLI, passes the same gates.
7. **Re-runnable determinism** — same `HarnessChoice` produces bit-identical output (up to the `generatedAt` timestamp).
8. **`--from-existing` migration** — given a vendored fixture of a ruflo project, the eject mode produces a harness that passes its smoke test. The fixture is committed alongside the test.

### Performance tests

9. **Time-to-first-harness budget** — CI measures the trivial-harness end-to-end run time. Hard ceiling: 120 seconds on the CI runners (warm cache).
10. **Disk-size budget** — generated directory size before `npm install` ≤ 10 MB.

## References

### Ruflo internals cited

- `v3/@claude-flow/cli/src/init/mcp-generator.ts` — the cross-platform spawn wrapper feeds the `_base/.mcp.json.hbs` template.
- `v3/@claude-flow/cli/src/plugins/store/discovery.ts` — the IPFS registry consumer the online mode delegates to via `@metaharness/kernel/marketplace`.
- `plugins/ruflo-core/skills/*` — the SKILL.md format the catalogue inherits.

### Generator prior art

- `create-vite` (https://github.com/vitejs/vite/tree/main/packages/create-vite) — the prompts + template-overlay model we directly borrow from.
- `create-next-app` (https://github.com/vercel/next.js/tree/canary/packages/create-next-app) — the template-registry concept we generalise.
- `cookiecutter` (https://github.com/cookiecutter/cookiecutter) — the placeholder model (with critique: too coarse for TypeScript).
- `copier` (https://github.com/copier-org/copier) — the `_copier-answers.yml` manifest, the source of our `.harness/manifest.json` idea. The most directly influential prior-art.
- Yeoman (https://yeoman.io/) — rejected, cited in §Alternative 1.

### Other prior art

- The TypeScript Compiler API (https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) — what the renamer uses for AST-aware substitution.
- Handlebars (https://handlebarsjs.com/) — for prose templating.

### Ruflo ADRs cited

- ADR-002 (Kernel boundary) — this ADR's gating decision.
- ADR-007 (CI guards) — where the perf budgets become CI gates.
- ADR-008 (Drift detection) — where the manifest becomes a load-bearing artefact.
- ADR-011 (Witness) — where the manifest becomes an input to provenance signing.
- ADR-013 (Vertical packs) — the catalogue + vertical-pack composition story.
