# ADR-013: Vertical Packs Publishing Model

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-005 (Marketplace), ADR-009 (Anti-slop), ADR-006 (Memory + learning, JUDGE/DISTILL plug points)

## Context

A vertical pack bundles multiple agents, skills, commands, MCP tools, intelligence-pipeline overrides, and sensible memory-decay defaults focused on one domain. The user prompt names several candidates: `@metaharness/vertical-legal`, `@metaharness/vertical-trading`, healthcare clinical workflows, financial risk, customer support.

Ruflo already ships vertical-shaped plugins today (e.g. `@claude-flow/plugin-healthcare-clinical`, `@claude-flow/plugin-financial-risk`, `@claude-flow/plugin-legal-contracts` from the registry list in `CLAUDE.md`). These were each authored individually, with no shared structure. We want to formalise the model so:

- A vertical pack is recognisable as such (the marketplace renders it differently).
- Vertical packs have predictable shape (a user can move between packs without re-learning the layout).
- Vertical packs can ship custom JUDGE / DISTILL providers (the ADR-006 §Layer 6 plug points).
- Ownership and maintenance are tractable — who maintains the trading pack? Who reviews changes to the legal pack?
- Publishing a new vertical pack is documented enough that a maintainer can stand one up without insider knowledge.

This ADR pins all of that down.

## Decision

### Pack structure

A vertical pack is an npm package shaped like:

```
@metaharness/vertical-<domain>/
  package.json
  pack.json                     # the pack manifest (this ADR)
  src/
    index.ts                    # exports {agents, skills, commands, mcpTools, intelligence, defaults}
    agents/                     # one .md per agent
    skills/                     # one directory per skill (SKILL.md + helpers)
    commands/                   # one .md per slash command
    mcpTools/                   # one .ts per tool
    intelligence/
      judge.ts                  # optional: custom JudgeProvider
      distill.ts                # optional: custom DistillProvider
    defaults.ts                 # decay rates, namespace defaults, plugin pre-selects
  test/
    smoke/
    scenario/                   # the end-to-end scenarios anti-slop ADR-009 requires
  README.md
  CHANGELOG.md
```

The `pack.json` manifest is the new structured part:

```jsonc
{
  "packSchemaVersion": 1,
  "id": "@metaharness/vertical-trading",
  "displayName": "Vertical: Trading",
  "version": "1.0.0",
  "kernelEngines": "^1.0.0",
  "domain": "finance.trading",
  "summary": "Algorithmic trading harness pack: signals, backtesting, risk, portfolio.",
  "contributors": [
    { "id": "ruflo-vertical-trading", "displayName": "ruflo vertical-trading team", "verified": true }
  ],
  "exports": {
    "agents":   ["market-analyst","risk-analyst","trading-strategist","backtest-engineer"],
    "skills":   ["candlestick-pattern-detect","portfolio-optimize"],
    "commands": ["/trader","/trader-backtest","/trader-signal"],
    "mcpTools": ["trader.ingest","trader.signal","trader.risk"],
    "intelligence": {
      "judge":   "src/intelligence/judge.ts",
      "distill": "src/intelligence/distill.ts"
    }
  },
  "defaults": {
    "memory": {
      "decay": {
        "patterns": { "halfLifeHours": 168, "reinforceMultiplier": 1.0 },
        "market":   { "halfLifeHours": 24,  "reinforceMultiplier": 1.0 },
        "feedback": { "halfLifeHours": null, "reinforceMultiplier": 1.0 }
      }
    },
    "routing": {
      "tier1ReadyIntents": ["var-to-const"],
      "haikuPreference": ["technical-indicator-calc","portfolio-rebalance"]
    },
    "namespaces": ["market","patterns","tasks","feedback"]
  },
  "recommendedPlugins": [
    "@claude-flow/plugin-financial-risk",
    "@claude-flow/plugin-neural-trader"
  ],
  "scenarios": [
    { "id": "backtest-spy-2024", "description": "Backtest a 60/40 strategy against SPY 2024." },
    { "id": "regime-detect-current", "description": "Detect current market regime." }
  ]
}
```

The `defaults` object is what makes a vertical pack a vertical pack: it has opinions. A trading pack ships short market-data half-lives. A legal pack ships long ones. The composer (ADR-003) applies the pack's defaults to the harness's `harness.config.json` when the user picks the pack.

### Pack types: bundled vs curator

We recognise two kinds of vertical pack ownership:

#### Bundled vertical pack (`@metaharness/vertical-*`)

Ships from `packages/vertical-packs/<domain>/` in the `ruvnet/agent-harness-generator` repo. Code-owned by a CODEOWNERS group named per pack (e.g. `@ruflo-vertical-trading`). Reviewed inside the same repo; published via the repo's release flow.

These are the "first-party" verticals. Initially: `legal`, `trading`, `customer-support`. The bar to add one is high: there must be a maintainer team, ongoing maintenance commitment, and at least two scenario tests.

#### Curator-published vertical pack

Anyone can publish a vertical pack to the marketplace. The npm package is in the publisher's scope (`@acme/vertical-legal`). The pack manifest still conforms to the schema above. The marketplace tags it `type: "vertical-pack"`. Trust tier (ADR-009) is derived the same way as any other plugin.

This is the path for `@nephrology-ai/vertical-nephrology-rounds` or `@fintech-corp/vertical-mortgage-underwriting`. We do not gate them. The signals carry the trust assertions.

### Bundled pack governance

For bundled packs in `packages/vertical-packs/<domain>/`:

- **One CODEOWNERS group per pack.** Each pack has its own reviewer set. A PR touching `packages/vertical-packs/trading/` requires sign-off from `@ruflo-vertical-trading`.
- **One ADR per major pack change.** Substantive changes to a vertical pack (new agents, schema change in `pack.json`, removal of a featured scenario) get an ADR. Trivial changes (system-prompt tweaks, new test fixtures) do not.
- **Independent release cadence.** Each pack ships on its own version timeline. The composer reads the pack's `kernelEngines` and surfaces compatibility.
- **Maintenance covenant.** A bundled pack that stops being maintained (no maintainer responses to issues for 90 days) is candidate for archival. Archival moves the pack to `packages/vertical-packs/_archive/<domain>/`, removes it from the composer's default catalogue, and tags its marketplace entry `signals.warnings: ["abandoned"]`.

### Curator-published pack workflow

A curator follows the same flow as any plugin publisher (ADR-005 §9):

```bash
# Scaffold a vertical pack from a generated harness
npx <harness-name> pack scaffold @acme/vertical-mortgage
# Produces a packages/vertical-mortgage/ directory with the structure above.

# Develop
cd packages/vertical-mortgage
# (write agents, skills, commands, scenarios, tests, JUDGE/DISTILL if needed)

# Publish
cd ../..
npx <harness-name> plugin publish --pack @acme/vertical-mortgage
```

The publish flow is the standard one (ADR-005), with the registry entry tagged `type: "vertical-pack"`.

### Pack discoverability in the composer

The composer (ADR-003) presents vertical packs as a first-class stage, before the agents stage. The user can pick a pack; selecting a pack auto-checks the agents, skills, commands, MCP tools the pack exports, applies the pack's defaults to the harness config, and pre-selects the pack's `recommendedPlugins`. The user can then deselect anything they do not want.

If the user picks multiple packs, the composer merges defaults conservatively (more cautious wins; e.g. the longer half-life wins between two packs). Conflicting agent definitions (two packs define agents with the same id but different prompts) are flagged for the user to resolve.

The composer's pack picker pulls from:

1. **Bundled packs** in the local `@metaharness/catalogue` (always available offline).
2. **Marketplace packs** in the IPFS registry (only when in online mode).

### Pack-scoped namespaces

A vertical pack can declare namespaces in `defaults.namespaces`. The kernel creates these on first install of the pack into a harness. The pack's MCP tools, JUDGE, DISTILL, and recommended plugins all operate in those namespaces.

A pack cannot reach into another pack's namespace. The kernel enforces namespace isolation at the AgentDB layer. Cross-pack queries are explicit (`memory_search_unified --namespaces market,patterns`), not implicit.

### Pack-shipped JUDGE / DISTILL

When a pack ships `intelligence.judge` and/or `intelligence.distill`, the kernel registers them as the intelligence-pipeline providers for the pack's namespaces. The trading pack's JUDGE runs on trajectories tagged `pack: trading`; the legal pack's JUDGE runs on trajectories tagged `pack: legal`. The kernel routes by tag.

A pack that does not ship custom JUDGE / DISTILL inherits the kernel defaults. Most packs only override one or the other (trading typically overrides JUDGE; legal typically overrides DISTILL because of the prose-quality signal).

The intelligence-provider contract (ADR-006 §Layer 6) is the kernel-enforced shape; the pack ships an implementation; the contract test kit (ADR-010 §Contract tests) asserts the implementation behaves to the kernel's interface. A pack that fails the kit's contract test cannot be published (anti-slop ADR-009 §1).

### Pack pretrained pattern corpora

Optional. A pack can ship a small pattern corpus at `corpora/bootstrap.jsonl` — patterns the kernel `hooks pretrain` will seed a fresh harness with on install. For the trading pack, this might be 50–200 known-good signal-detection patterns. For the legal pack, this might be 100 redline-format patterns.

The corpus is content-addressed and witness-signed (the pack's own witness manifest covers it). A user installing the pack into a harness gets `hooks pretrain --pack <id>` automatically run, which seeds the harness's `patterns` namespace with the pack's corpus.

### Pack-level marketplace listing decoration

A pack's marketplace listing surfaces:

- The pack's `domain` tag (`finance.trading`, `legal.contracts`).
- The pack's `scenarios[]` as "What can I do with this pack?" demos.
- The pack's `recommendedPlugins[]` as "Plays well with."
- The pack's `defaults` summary ("Memory half-life: 7 days. JUDGE: custom.").

This is the editorial sheen that distinguishes a vertical pack from a generic plugin. The decoration is mechanical (rendered from `pack.json`); the marketplace UI is unchanged otherwise.

### Versioning packs against the kernel

Same rules as any plugin (ADR-005 §schema). The pack declares `kernelEngines`. The kernel rejects loading a pack whose range does not match. ADR-012's drift detection surfaces the compatibility status.

A pack that wants to support multiple major kernel versions ships separate npm versions (`@metaharness/vertical-trading@1.x` for kernel `1.x`; `@metaharness/vertical-trading@2.x` for kernel `2.x`). The marketplace surfaces both; the composer picks the matching one for the harness's kernel.

## Consequences

### What gets easier

- **A new vertical is a shape, not a special case.** Any curator can build one. The schema is published.
- **Verticals carry opinions.** A user adopting a vertical does not have to learn that "trading wants short half-lives" — the pack ships it.
- **Pack discoverability is uniform.** Whether bundled or curator-published, packs show up in the same composer stage with the same UI.
- **Custom intelligence per domain.** Vertical-specific JUDGE / DISTILL are a first-class plug point, not a hack.

### What gets harder

- **Pack maintenance is real work.** Each bundled pack has a CODEOWNERS team that must respond to issues. ADR-013 §Maintenance covenant explicitly mentions archival; we will use it.
- **Cross-pack composition is non-trivial.** Two packs with conflicting defaults need a resolution UI. The composer must handle this gracefully — see §Pack discoverability above.
- **Namespace count grows fast.** A harness with three vertical packs has 12+ namespaces. ADR-006 §Namespace explosion mentions composer warnings; we enforce them here.

### What does not change

- The marketplace schema (ADR-005) is unchanged; vertical packs are a `type` value.
- The kernel does not know which pack a trajectory belongs to except by tag; the routing is per-tag.

## Alternatives Considered

### Alternative 1: No vertical pack distinction; all are just plugins

A pack is a plugin tagged `category: vertical`. Rejected because a pack's pre-selects, default config, and intelligence-pipeline plug points are structurally different from a single-purpose plugin. Without first-class `type: "vertical-pack"` handling, the composer cannot apply pack defaults automatically.

### Alternative 2: All packs are bundled (no curator path)

Reject all third-party verticals; only first-party `@metaharness/vertical-*` exist. Rejected because the marketplace's reason for existing is to let domain experts publish their own. A nephrology vertical the ruflo team does not have the domain knowledge to build should still be possible to publish.

### Alternative 3: All packs are curator (no bundled path)

The ruflo team does not ship any verticals. Rejected because the existence of well-maintained reference packs (`legal`, `trading`, `customer-support`) seeds the ecosystem. Without them, curator-published packs have no exemplars.

### Alternative 4: Packs are mandatory (the composer requires picking one)

Make the user pick a vertical at generation time. Rejected because the trivial-tier use case ("3-agent customer-support harness with no pack") is the volume case. Vertical packs are an opt-in.

### Alternative 5: Allow packs to override kernel internals

Let a pack reach into kernel-internal modules to customise behaviour. Rejected per ADR-002 — the kernel's public surface is the contract. Packs customise via plug points (JUDGE / DISTILL, custom MCP tools, custom agents). Anything beyond that, the user wants a kernel feature; file an issue.

## Test Contract

This ADR is satisfied when the following exist:

### Pack schema tests

1. **JSON Schema for `pack.json`** at `packages/kernel/marketplace/schema/pack-manifest.schema.json`. Every bundled pack's `pack.json` validates against it.
2. **Pack export resolution** — each declared export in `pack.json` `exports.*` actually exists in the pack's `src/`.
3. **Pack default merging** — given two packs with overlapping defaults, the composer's merge produces the expected output.

### Bundled pack tests

4. **Each bundled pack** (`legal`, `trading`, `customer-support`) passes its own smoke + scenario tests.
5. **Each bundled pack's custom JUDGE / DISTILL** (where present) passes the kernel's intelligence-pipeline contract test kit.
6. **Each bundled pack's scenarios** run to completion in CI on a sandboxed test harness.

### Curator pack tests

7. **`pack scaffold` produces a valid pack** — `npx <harness> pack scaffold @test/vertical-x` produces a tree whose `pack.json` schema-validates and whose stubs build.
8. **Publishing a curator pack** end-to-end (against a mock Pinata + mock npm) produces a registry entry of `type: "vertical-pack"`.

### Composer integration tests

9. **Picking a pack auto-checks its exports.** UI snapshot test.
10. **Conflicting packs surface a resolution prompt.** UI snapshot test with two packs declaring the same agent id.

### Maintenance covenant test

11. **A pack with 90 days of no maintainer activity** is flagged as archival candidate in the CI's weekly maintenance report.

## References

### Ruflo internals cited

- The existing `@claude-flow/plugin-healthcare-clinical`, `@claude-flow/plugin-financial-risk`, `@claude-flow/plugin-legal-contracts` registry entries — informal precursors of the formal vertical pack model.
- The `@claude-flow/plugin-neural-trader` plugin — the prior art for shipping a domain-specific intelligence backend.

### Ruflo ADRs cited

- ADR-005 (Marketplace) — the schema this builds on.
- ADR-006 (Memory + learning) — the JUDGE/DISTILL plug points packs override.
- ADR-009 (Anti-slop) — the trust-tier model that applies equally to packs.
- ADR-012 (Eject + upgrade) — pack compatibility tracking.
