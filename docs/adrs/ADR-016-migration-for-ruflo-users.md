# ADR-016: Migration for Existing Ruflo Users

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-001 (Goals), ADR-002 (Kernel boundary), ADR-003 (Generator architecture, the eject mode), ADR-006 (Memory + learning)

## Context

Today's ruflo users have invested in:

- A `.claude/` directory with their accumulated memory bridge (auto-imported from Claude Code; ADR-006 §Memory bridge).
- A `data/memory/` directory with their AgentDB + HNSW index, full of distilled patterns from months of trajectories.
- Custom skills, custom slash commands, custom plugins under `.claude/plugins/`.
- A `verification.md.json` witness manifest with their attested fix list (per ruflo ADR-103).
- A `harness.config.json`-equivalent — actually `claude-flow.config.json` today — with their tuned settings.
- A history of `npm install ruflo`-based workflow that they have written documentation, CI workflows, and team conventions around.

When `agent-harness-generator` ships, every existing ruflo user has a choice:

1. **Stay on ruflo as-is.** The `ruflo` package continues to ship; existing workflows continue. (ADR-001 §Non-goal 1 commits us to this.)
2. **Refactor ruflo to use the kernel.** Internal change: ruflo becomes one harness consuming `@metaharness/kernel`, observable behaviour unchanged.
3. **Migrate to a self-generated harness.** Run `create-agent-harness <my-thing>` against the user's existing project, end up with a new package they own.

Path 1 is the no-op. Path 2 is the ruflo team's job (ADR-002 §Test Contract §6 is the gate). This ADR specifies path 3: how an existing ruflo user moves their memory, patterns, witnesses, custom skills, and CI investments into a generated harness without re-training, without breaking their current setup, and with a reversible path back to ruflo if they change their mind.

## Decision

### The `--from-existing` mode

The generator's `--from-existing <path>` flag (ADR-003 §The CLI surface) ingests an existing ruflo project and produces a generated harness that wraps it. The flow:

```bash
cd /path/to/my-ruflo-project    # an existing ruflo install with .claude/, data/memory/, etc.
npx create-agent-harness acme-research --scope @acme --from-existing .
```

What the tool does, in order:

1. **Detect.** Walk the source path. Identify:
   - `.claude/` directory and its conventions (skills, commands, agents, settings.json, hooks).
   - `data/memory/` (AgentDB + HNSW index files).
   - `claude-flow.config.json` (ruflo's existing config; gets migrated).
   - `verification.md.json` and `verification-history.jsonl` (existing witness; gets carried over).
   - `package.json` (extract `name`, `dependencies`, `bin`).
   - Any `.claude/plugins/<custom-name>/` subdirectories (treat as custom plugins).
   - `.mcp.json` (existing MCP server registrations).

2. **Survey + report.** Print a summary of what was detected and what the migration plan is. Example output:

   ```
   Detected an existing ruflo install at /path/to/my-ruflo-project:
     - 7 skills (4 from @claude-flow/plugin-*, 3 custom)
     - 5 slash commands (all custom)
     - 12 agents (10 from catalogue, 2 custom)
     - data/memory: 3,142 patterns, 8 namespaces (will be carried over)
     - verification.md.json: 23 fixes, all currently passing (will be re-signed)
     - claude-flow.config.json: 14 keys (will be migrated to harness.config.json)
     - .claude/plugins/acme-private/: custom plugin (will be carried over as packages/acme-private/)

   Proposed harness:
     - Name: @acme/acme-research
     - Kernel: @metaharness/kernel@<current>
     - Hosts: claude-code (Codex/Hermes/pi.dev disabled by default; add with --hosts)
     - Branding mode: powered-by (default; --branding=independence to change)

   Proceed? [y/N]
   ```

3. **Plan apply.** On confirmation, the tool:
   - Generates a fresh harness in a new directory (the source is untouched).
   - Copies `data/memory/` into the new harness's `data/memory/`.
   - Copies the custom skills, commands, agents into the new harness's `src/`.
   - Wraps the custom `.claude/plugins/acme-private/` directory as a separate npm workspace package.
   - Migrates `claude-flow.config.json` keys to `harness.config.json` (schema mapping documented in the next subsection).
   - Carries over `verification.md.json` + `verification-history.jsonl`, re-signs the manifest with the harness's new witness key (the old one is retired in dual-sign mode per ADR-011 §Rotation).
   - Writes the harness's `.harness/manifest.json` (ADR-003) with a `migratedFromRuflo: { sourcePath, sourceCommit }` field.

4. **Smoke test.** Runs the harness's smoke contract. If it passes, the migration is complete; the new harness is ready to use.

5. **The source is untouched.** The original ruflo project is unchanged. If the user wants to roll forward (delete the old, use the new), they do so manually. If they want to keep both for a while, they can. The migration is non-destructive by design.

### Configuration mapping

`claude-flow.config.json` (the file ruflo uses today) maps to `harness.config.json` per the table below. The mapping is deterministic; the tool produces both the new file and a `migration-report.md` documenting every key.

| Ruflo `claude-flow.config.json` key | Harness `harness.config.json` location |
|---|---|
| `swarm.topology` | `kernel.swarm.topology` |
| `swarm.maxAgents` | `kernel.swarm.maxAgents` |
| `swarm.strategy` | `kernel.swarm.strategy` |
| `memory.backend` | `memory.backend` |
| `memory.path` | `memory.path` |
| `memory.hnswEnabled` | `memory.quantization` (`"int8"` if `true`, `"none"` if `false`) |
| `neural.enabled` | `selfEvolution.enabled` |
| `hooks.*` | `hooks.*` |
| `mcp.*` | `mcp.*` |
| `marketplace.*` (if present) | `marketplace.*` |
| any key not in this table | preserved verbatim under `harness.config.json` `legacy.*`, with a warning in the migration report |

The `legacy.*` escape hatch handles user-specific or undocumented keys; the harness kernel ignores them by default but the user can write a `harness.config.json` `compat.legacyKeyHandler` to bind them to new behaviour.

### Memory carryover

`data/memory/` is the bulk of the migration. The directory carries:

- The SQLite database (`memory.sqlite`).
- The HNSW index files (`hnsw-index/`).
- The AgentDB controller files (`agentdb-controllers/`).
- The trajectory log (`trajectories.jsonl`).

These are copied byte-for-byte into the new harness. The kernel's memory layer is fully backward-compatible with the ruflo-shipped AgentDB schema (ADR-006 §Layer 1 — Kernel inherits the existing backend). The new harness boots against the existing data; existing patterns are searchable; existing trajectory history is intact.

If the new harness uses a different memory configuration (e.g. a different quantization mode), the kernel does an online migration of the index on first read. The migration is logged; if it fails, the original index is preserved and the migration is reported.

### Witness carryover

`verification.md.json` is re-signed with the harness's new keypair (ADR-011 §Key generation). Three details:

1. The previous signature (signed with ruflo's witness key) is preserved in `verification-archive.jsonl` so the historical attestation chain is auditable.
2. The new manifest's `gitCommit` is the migration commit, not the original commit.
3. `verification-history.jsonl` is carried over, with a new entry marking the migration: `{ "v": 1, "transition": "migrated-from-ruflo", "fromManifestHash": "...", "toManifestHash": "..." }`.

The user retains the ability to verify the historical signatures (the public keys are recorded in the archive). They have a clean new chain of trust going forward.

### Custom skills, commands, agents

A custom skill at `.claude/skills/my-skill/SKILL.md` is copied to `src/skills/my-skill/SKILL.md`. The new harness's package layout registers it the same way ruflo did. The skill works unchanged.

The same for custom commands and agents. The format is identical (ruflo and the kernel share the SKILL.md format intentionally; per ADR-002 §What is OUT of the kernel, the format is content, not kernel).

### Custom plugins

A `.claude/plugins/acme-private/` directory becomes a workspace package at `packages/acme-private/`. The migration tool:

1. Generates a new `package.json` for the package (name: `@acme/plugin-acme-private`, version: `0.1.0`).
2. Migrates the existing plugin's exports to the new schema (ADR-005 §2). The mapping is deterministic; common ruflo-plugin shapes (skills + hooks + MCP tools) translate to the new `exports` structure.
3. Generates a smoke test stub for the new plugin.
4. Adds the plugin as a workspace dependency of the harness.

The new harness can immediately publish this plugin to the marketplace (if the user wants), or keep it private (workspace-internal, never published).

### Host adapter selection

By default, `--from-existing` produces a Claude-Code-only harness (the only host ruflo officially supports today). The user can add hosts post-migration:

```bash
cd acme-research
npx <harness-name> host add codex
npx <harness-name> host add hermes
```

The migration does not auto-add hosts because the existing ruflo setup is Claude-Code-specific, and we do not want to scaffold integrations the user has not asked for.

### Rollback

If the migration goes wrong, the source project is unaffected. The user runs:

```bash
rm -rf acme-research
```

and continues using their original ruflo project. The migration was non-destructive.

If the user has been working with the new harness for a while and discovers the migration was wrong, the path back is:

1. Manually re-copy the new harness's `data/memory/` back into the original ruflo project's `data/memory/` (if any newer patterns were created on the new side).
2. Manually re-copy any new skills / commands / agents.
3. Continue using the original ruflo.

There is no automated `unmigrate` command. We accept this trade-off: automating the reverse is a heavy investment, and the simple "rm -rf" rollback at step 5 above covers the common case.

### Publishing the migrated harness

A migrated harness publishes to npm and to the marketplace the same way any other generated harness does (ADR-005 §9). The branding policy (ADR-015) applies: by default the migrated harness is powered-by; the user can switch to independence.

If the user wants the migrated harness to ship under the existing `ruflo` package name (replace ruflo for their own use), they can rename to `ruflo` and publish to npm with their own scope (`@acme/ruflo-internal`). The composer warns against using the bare `ruflo` name due to npm conflicts.

### What the migration tool does not handle

- **Heavy customisation of the kernel itself.** If the user has patched `node_modules/@claude-flow/cli/` (an unsupported workflow), the migration tool detects this, prints the diff, and refuses to migrate without the user explicitly accepting the loss. The intended path here is eject mode (ADR-012), where the user gets full kernel ownership.
- **Migration from a fork of ruflo.** If the source is a fork of `ruflo` rather than an installation of `ruflo`, the tool surfaces this and asks the user how to handle the divergence: treat the fork as a custom plugin set (preserve), or treat the fork as kernel-level (eject after migration).
- **Multiple linked ruflo installations across multiple repos.** Each is migrated separately. There is no batch-migration tool. Users with many installations may write their own scripted wrapper.

### The migration tool as a CI workflow

The migration tool is also invokable as a CI workflow against a hosted ruflo installation (for organisations migrating many internal harnesses at once). The CI form: `npx create-agent-harness --from-existing <git-ref> --target <new-repo-name>` clones the source ref, runs the migration in a sandbox, opens a PR on the target repo with the migrated tree.

This is for organisations migrating 50+ internal projects. The interactive flow remains the primary path.

## Consequences

### What gets easier

- **No memory loss on migration.** Months of distilled patterns survive the move.
- **No re-training.** The HNSW index is portable; the new harness has the existing patterns at boot.
- **Reversible.** The source is untouched; rollback is `rm -rf`.
- **The migration is opt-in.** Existing ruflo users who do not want to migrate are not pressured to.

### What gets harder

- **The config mapping table is forever-promised.** Every key in `claude-flow.config.json` must have a mapping. ADR-016 commits to this. New ruflo keys added before the migration tool ships must be added to the mapping.
- **Custom-plugin migration is non-trivial.** Plugins with bespoke shapes need bespoke translations. The tool handles the common cases; uncommon cases surface as TODO comments and require user review.
- **Witness chain transition.** Re-signing with a new key breaks the historical chain. Archiving the old signature mitigates the auditability concern; users who need an unbroken chain (regulated environments) must accept manually witnessing the migration transition.

### What does not change

- The original ruflo project is unaffected by the migration. Users can run the tool, look at the output, and walk away if they do not like it.
- The marketplace continues to host `@claude-flow/plugin-*` packages compatible with both ruflo and migrated harnesses (per ADR-005 §10 schema versioning).

## Alternatives Considered

### Alternative 1: No migration tool; users start fresh

Tell existing users their patterns / witnesses / customizations stay in ruflo, and a generated harness gets a clean memory. Rejected because the patterns are the most valuable accumulated asset for many users. A clean-start migration is unattractive enough that many users would never migrate.

### Alternative 2: Migration is destructive (replaces the source)

The tool deletes the original ruflo setup after migration. Rejected because (a) it removes the safety net for users who try the migration and realise they want to back out, (b) ruflo's role as the canonical reference harness means destroying it on every user's machine is a worse outcome for ruflo than gradual migration, and (c) the disk cost of keeping both for a while is small.

### Alternative 3: Automated round-trip (`migrate` and `unmigrate`)

Reject for v1.0 — the round-trip is significant engineering and the rollback by `rm -rf` is good enough. A future ADR can add `unmigrate` if real user pull emerges.

### Alternative 4: Migrate in-place (modify the source directory)

The tool refactors `node_modules`, `.claude/`, `data/memory/` into the harness layout in the same directory. Rejected because (a) it complicates rollback, (b) it touches `node_modules` (always risky), and (c) generating a new directory is simpler and easier to reason about.

### Alternative 5: Skip witness re-signing; reuse ruflo's witness key

Reject because each harness should have its own key (ADR-011 §Where the public key lives). Sharing keys breaks the attribution model. The dual-sign rotation pattern handles the transition cleanly.

## Test Contract

This ADR is satisfied when the following exist:

### Detection tests

1. **A fixture of a "typical" ruflo install** under `tests/fixtures/ruflo-install-typical/`. The migration tool detects all subsystems correctly and produces the expected migration plan.
2. **A fixture with custom plugins** under `tests/fixtures/ruflo-install-with-custom-plugins/`. The custom plugins are detected and the workspace-package translation runs.
3. **A fixture with patched kernel** under `tests/fixtures/ruflo-install-patched/`. The tool detects the patch, prints the diff, and refuses to migrate without `--accept-loss`.

### Migration end-to-end tests

4. **Trivial migration** — fixture 1; run migration; new harness builds; smoke contract passes; memory is queryable with the original patterns intact.
5. **Migration with custom plugins** — fixture 2; new harness builds; the custom plugin works; the harness can publish the custom plugin (against a mock marketplace).
6. **Migration with witnessed fixes** — a fixture with `verification.md.json` and 5 fixes; after migration, `witness verify` on the new harness reports all 5 fixes still attested with the new key.

### Configuration mapping tests

7. **Every key in the canonical config mapping table** has a corresponding test fixture that proves the mapping works.
8. **Unknown keys** fall under `legacy.*` with the expected warning.

### Reverse path tests

9. **Source untouched** — after migration, every file in the source path is byte-identical to pre-migration.
10. **Rollback by `rm -rf`** — removing the new harness, the source still works as a ruflo install.

### Performance test

11. **Migration time** — fixture 1 (small install: 1000 patterns, 5 fixes, 3 custom skills) migrates in ≤ 60 seconds on CI runners. Larger fixtures scale; the migration is bounded by `data/memory/` size.

## References

### Ruflo internals cited

- `claude-flow.config.json` schema — the source of the config mapping.
- `data/memory/` layout — the path the migration tool reads from.
- `verification.md.json` and `verification-history.jsonl` — the witness chain the tool re-signs.
- `.claude/` layout — the skill / command / agent format the tool reads.

### Ruflo ADRs cited

- ADR-001 (Goals §1 Non-goal: replacement for ruflo) — the promise this ADR keeps.
- ADR-002 (Kernel boundary) — the format compatibility this ADR depends on.
- ADR-003 (Generator architecture §`--from-existing`) — the CLI flag.
- ADR-005 (Marketplace) — the new schema custom plugins migrate to.
- ADR-006 (Memory) — the AgentDB compatibility that makes data carryover possible.
- ADR-011 (Witness) — the re-signing rules.
- ADR-012 (Eject + upgrade) — the path for users with heavy kernel patches.
- ADR-015 (Branding) — the default mode for migrated harnesses.

### External prior art

- AngularJS → Angular migration: https://angular.io/guide/upgrade — what an "incremental migration with a coexistence period" looks like. The "source untouched" property here mirrors AngularJS's `ngUpgrade` design.
- React class-to-hooks codemods: https://github.com/reactjs/react-codemod — the precedent for "tool that rewrites an existing shape into a new shape, deterministically."
- `git filter-repo`: https://github.com/newren/git-filter-repo — referenced for the design of non-destructive history rewrites; the migration tool's source-untouched property follows the same posture.
