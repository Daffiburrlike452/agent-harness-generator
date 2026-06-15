# ADR-001: Goals and Non-Goals

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary), ADR-003 (Generator architecture), ADR-015 (Naming + branding)

## Context

Ruflo has reached the point where users want their own thing. Three signals are loud enough to act on:

1. **Fork pressure.** Users are forking ruflo to rebrand it and trim it down. The user-mode for this is: "I love what ruflo gives me but I do not want my customer to see `ruflo` in their terminal." A fork is a one-way door — they lose every future kernel update, every IPFS registry refresh, every drift fix.
2. **Host fragmentation.** Claude Code is no longer the only agentic CLI. OpenAI Codex CLI now has MCP support. Nous Research's Hermes-agent framework has its own thinking-block scrubbing convention (see `scrubReasoningBlocks` in `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts`, comment `#14`, and the `hermes-agent think_scrubber pattern` reference at the call site). pi.dev is emerging as a developer-platform offering. A user who wants their harness to "work in Claude Code AND Codex" today has to write the second integration by hand.
3. **Marketplace participation.** The IPFS plugin registry (`QmXbfEAaR7D2Ujm4GAkbwcGZQMHqAMpwDoje4583uNP834`, see ruflo `CLAUDE.md` "Plugin Registry Operations") needs more publishers, not just consumers. The path "publish your own scoped plugin" is currently a ruflo-insider workflow. The marketplace is one of the load-bearing assets ruflo has built; it should be a competitive moat against vibe-coded forks, not a private trail.

The proposal is `agent-harness-generator`: a CLI tool that scaffolds a brand-new, self-contained, npm-publishable agent harness for the user. Like `create-vite` for web apps, like `cookiecutter` for Python projects, like `create-next-app` for Next.js — but for vertical agent systems.

The scope question this ADR answers: **what are we building, and what are we explicitly not building?**

## Decision

### What `agent-harness-generator` IS

It is two artefacts, shipped as one project:

1. **A standalone CLI**: `npx create-agent-harness <name>`. Generates a new harness directory ready to `npm publish`. Works offline against a vendored template; works online against the latest kernel.
2. **A marketplace plugin**: ships to the ruflo IPFS registry under `@claude-flow/plugin-harness-generator` (final name in ADR-015). When installed inside an existing ruflo project, exposes the same scaffolding as a slash command.

Both artefacts share the same source. The marketplace plugin is a thin wrapper that delegates to the CLI logic.

### Primary use cases

A generated harness must support, in increasing order of exoticism:

| Tier | Example user story | Defining ADRs |
|---|---|---|
| **Trivial** | "I need a 3-agent customer-support harness branded `@acme/acme-support` that runs in Claude Code." | ADR-003, ADR-004 |
| **Standard** | "I need a 6-agent legal-contracts harness branded `@lexcorp/contract-bench` that runs in Claude Code AND Codex, with its own MCP server and a small skill pack." | ADR-003, ADR-004, ADR-006 |
| **Curated** | "I am bundling a vertical pack — `@metaharness/vertical-trading` — that I maintain alongside ruflo and want to ship as a marketplace plugin." | ADR-013 |
| **Multi-host** | "Same harness, three hosts (Claude Code, Codex, pi.dev), shared memory, single brand." | ADR-004 |
| **Federated** | "Two instances of my legal harness coordinate over the federation transport; one is on-prem, one is cloud." | ADR-014 |
| **Self-evolving** | "My harness uses the intelligence loop to optimise its own model routing over time. Successful trajectories get rewarded; failed ones get penalised." | ADR-014 |
| **Plugin-author** | "My harness ships its own plugins back to the IPFS marketplace under my own scope." | ADR-005, ADR-013 |

The trivial and standard cases are the volume. The exotic cases are the proof — they show the system is not a one-trick scaffolder, and the kernel boundary (ADR-002) actually generalises.

### Success criteria

The project is successful if all of these hold:

1. **Time-to-first-harness ≤ 5 minutes** from `npx create-agent-harness foo` to a generated package that passes its own smoke test on `node 20+` on Mac, Linux, and Windows.
2. **Generated harnesses pass the kernel contract.** Every generated harness, regardless of choices, passes a fixed contract test suite that proves it correctly wires MCP, hooks, memory, routing. See ADR-010 §Contract tests.
3. **A generated harness can be published to npm** with `npm publish` and `npm provenance` attestation. No additional manual steps. See ADR-007 §Pre-publish gates, ADR-011 §Witness manifest.
4. **The four hosts are addressable.** A user can pick Claude Code, Codex, pi.dev, or Hermes (or any subset) at generation time, and the resulting harness has working integration for each host they picked. "Working" means the host's MCP / hook / tool surface is wired correctly and a host-specific contract test passes. See ADR-004.
5. **The kernel can be upgraded** in a generated harness without re-running the generator. `npm update @metaharness/kernel` works for peer-dep mode harnesses; an `eject` mode exists for harnesses that vendored the kernel. See ADR-012.
6. **Drift is detectable.** A generated harness whose kernel has diverged from its template can detect the drift, classify it (safe / breaking), and either auto-apply the patch or surface a clear migration. See ADR-008.
7. **Anti-slop signals are real.** The marketplace surfaces quality signals (download counts, smoke-test status, witness verification, publisher reputation) and refuses to surface harnesses that fail their smoke contract. See ADR-009.
8. **An existing ruflo user can migrate** their memory, learned patterns, and skill choices into a generated harness in one command, without re-training. See ADR-016.

If a release does not satisfy all eight, it is incomplete; this is what "complete" means for v1.0.

### What `agent-harness-generator` IS NOT

Equally important. These are explicit non-goals, deferred to later phases or out of scope entirely.

#### Non-goal 1: A replacement for ruflo

Ruflo continues to ship its current opinionated bundle as `ruflo` / `@claude-flow/cli`. The generator scaffolds **new** harnesses; it does not replace existing ones, and `ruflo` itself is one such harness (perhaps the first one to be retrofitted onto the kernel — see ADR-002 §Migration plan).

#### Non-goal 2: A multi-language scaffolder

The generated harness is a Node.js package. The kernel is TypeScript. The generator templates are TypeScript / JavaScript. We do not generate Python harnesses, Rust harnesses, or polyglot monorepos in v1.0. A user who wants a Python agent harness can publish a separate plugin that the Node-language harness consumes; that pattern is supported. The harness itself is Node.

Rationale: every ruflo primitive that the kernel ships (memory bridge, MCP server entry, hooks runtime, intelligence pipeline) is currently a Node/TypeScript codebase. Reimplementing in Python doubles the surface area of every future change, and the Node ecosystem ships the MCP SDK we depend on. Python harnesses are out of scope for v1.0, revisitable when there is a measurable user pull and the kernel surface has stabilised.

#### Non-goal 3: A hosted UI / web generator

A web-app version of the generator ("ruflo.dev/new") would shorten time-to-first-harness for non-CLI users. We are not building it in v1.0. The CLI is the contract; a web wrapper can come later in a phase not enumerated in the initial roadmap.

#### Non-goal 4: A certification body

ADR-009 (anti-slop) defines a reputation-and-signal model. It does not define a formal review board, an audit programme, or a "ruflo-certified" badge. Quality signals are derived from real measurements (smoke test pass rates, witness verification, npm provenance status, download trends), not editorial approval. This avoids reproducing the VS Code marketplace's centralised-review failure mode; see ADR-009 §Alternatives Considered.

#### Non-goal 5: A general-purpose project scaffolder

A user who wants a "blank Node project with Vitest and ESLint" should not reach for `create-agent-harness`. The generator's templates assume the user wants a harness — a thing that exposes an agentic CLI, an MCP server, and at minimum one agent. If they do not want those things, they want `create-vite` or `npm init`.

#### Non-goal 6: A model-trainer or fine-tuner

The generator does not train models. It wires up the intelligence pipeline (ADR-006) so a generated harness can learn from trajectories using the same RETRIEVE / JUDGE / DISTILL / CONSOLIDATE loop ruflo ships, but training a new SONA adapter, fine-tuning a base model, or curating a training corpus is the user's responsibility. The generated harness ships the infrastructure to learn, not a pre-trained adapter for the user's domain.

#### Non-goal 7: A pure runtime

We do not ship a "ruflo runtime" that hosts arbitrary harness packages. Each harness is its own npm package, with its own `bin`, its own CLI surface, its own MCP server. There is no central daemon that hosts them. This decision is enforced by ADR-002 (kernel boundary) — the kernel is a library, not a service.

### Defining the boundary with ruflo

To pin this concretely: today the `ruflo` package on npm ships kernel + content in one bundle. After this project lands, the picture is:

```
            ┌────────────────────────┐
            │   @metaharness/kernel      │  ← extracted from ruflo (ADR-002)
            │   primitives only      │
            └────────────────────────┘
                       ▲
       ┌───────────────┼───────────────────────────────────┐
       │               │                                   │
┌──────┴──────┐ ┌──────┴──────────────────┐ ┌──────────────┴──────────────┐
│   ruflo     │ │  generated harness #1    │ │  @metaharness/vertical-trading │
│  (opinion-  │ │  (e.g. @acme/support)    │ │  (curated vertical pack)    │
│   ated)     │ │                          │ │                             │
└─────────────┘ └─────────────────────────┘ └─────────────────────────────┘
```

Every box above is a harness in the sense of this ADR. `ruflo` is the reference harness. The generator produces the others.

### "From practical to exotic" — what this phrase commits us to

The user prompt for this ADR set used the phrase "from practical to exotic." The commitment that phrase encodes:

The same generator, with the same templates, with the same kernel, must produce both trivial harnesses and exotic ones. The exotic features are not a separate code path; they are configuration deltas over the same template. ADR-002 (kernel boundary), ADR-003 (composer), and ADR-014 (self-evolution + federation) must each show how the exotic mode lights up by toggling a flag, not by forking the generator.

Concretely: if a user picks `--federation` in the composer, the generated harness has the federation transport wired up via a kernel adapter that already exists. If they don't pick it, that import does not land. There is no "exotic-mode" branch in the template tree.

## Consequences

### What gets easier

- **New verticals ship faster.** A user with a use case ("legal contracts agent") goes from "I need to build infrastructure" to "I need to write three skills and a system prompt." The shared infrastructure is the kernel and the generated scaffold.
- **Hosts become a feature flag, not a fork.** Multi-host support is a generator option, not a parallel codebase to maintain.
- **The marketplace has a clear publishing path.** A user who wants to ship a vertical pack uses the generator + the marketplace ADR-005 publish flow, not a hand-rolled IPFS upload script.

### What gets harder

- **Kernel changes ripple.** Every change to `@metaharness/kernel` potentially breaks every generated harness. ADR-008 (drift detection) and ADR-012 (eject + upgrade) are mandatory mitigations, not nice-to-haves.
- **Two test surfaces.** We must now run the generator's own test suite AND a smoke test of generator output. ADR-010 specifies how this is structured.
- **Branding rules become a real concern.** A generated harness can choose "powered by ruflo" or "independence" mode. ADR-015 pins down what each implies (trademark, attribution, marketplace tagging).

### What does not change

- Ruflo continues to ship. Existing users see no breakage. The kernel extraction (ADR-002) is internal refactoring; the public `ruflo` CLI surface is preserved by ADR-016's migration story.
- The IPFS plugin registry (`QmXbfEAaR7D2Ujm4GAkbwcGZQMHqAMpwDoje4583uNP834`) continues to host the same plugin schema. Generated harnesses consume and (optionally) publish to the same registry. See ADR-005.

## Alternatives Considered

### Alternative 1: Ship a "ruflo-lite" instead

A stripped-down `ruflo-lite` package that users can fork. Rejected because a fork is still a one-way door — the lite user still loses every future update, and we have not solved the hosts-multiplication problem, only the size problem.

### Alternative 2: A template repo on GitHub that users `git clone`

`https://github.com/ruvnet/ruflo-template`, click "Use this template", you have a harness. Rejected because (a) it doesn't solve the host-fragmentation problem (still locked to one host's templates), (b) it doesn't solve the kernel-upgrade problem (cloned repos drift immediately), and (c) it has no composability — the user gets whatever the template author put in, take it or leave it. The generator decision is a strict superset of the template-repo decision.

### Alternative 3: An opinionated wizard inside ruflo, no separate package

`ruflo init --new-harness <name>` instead of a standalone CLI. Rejected because it couples the generator's lifecycle to ruflo's, makes the kernel extraction (ADR-002) optional rather than load-bearing, and leaks ruflo branding into the generated output by default. Keeping the generator separate forces the kernel boundary to be honest.

### Alternative 4: Adopt an existing generator framework (Yeoman, Plop)

Yeoman is the canonical Node generator framework. Plop is a smaller, more recent alternative. Both were rejected for v1.0 because (a) the generator we want has bespoke logic — composer UX, host-adapter wiring, IPFS plugin pre-fetch, witness manifest generation — that does not benefit from a framework's scaffolding-as-data abstraction, (b) Yeoman in particular has not had a major release in years and is widely considered legacy (see `create-vite` and `create-next-app` deliberately not using it), and (c) we want zero external generator-framework dependencies on the publish path to keep the supply-chain surface small. ADR-003 §Alternatives revisits this.

## Test Contract

This ADR is satisfied when the following exist:

1. **A success-criteria test suite** — eight machine-checkable assertions corresponding to the eight success criteria in §Decision. Each runs in CI on every change to `agent-harness-generator`. The suite is the canonical answer to "is v1.0 done?".
2. **A non-goals enforcement check** — a CI guard that fails the build if (a) a Python file lands in the kernel, (b) a hosted-UI dependency lands in the generator, (c) a "certification body" type or label lands in the marketplace publish flow. This is a one-time `grep` plus a smoke check; cheap to keep.
3. **One trivial harness, one exotic harness** as golden-path tests. The trivial harness is "3 agents, Claude Code only, no plugins." The exotic harness is "federation + multi-host (Claude Code + Codex) + custom DISTILL." Both must build, pass their smoke tests, and `npm pack` cleanly. These are the "from practical to exotic" canary.

(Detailed test strategy lives in ADR-010.)

## References

- Ruflo plugin registry IPFS CID and operations: `CLAUDE.md` §Plugin Registry Maintenance and §Plugin Registry Operations.
- Ruflo "hermes-agent think_scrubber" pattern: `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts`, comment `#14` and the `scrubReasoningBlocks` function.
- `@claude-flow/codex` README — orientation on the existing dual-mode pattern: `v3/@claude-flow/codex/README.md`.
- `create-vite` (https://github.com/vitejs/vite/tree/main/packages/create-vite) — reference shape for an opinionated, zero-framework scaffolder.
- `create-next-app` (https://github.com/vercel/next.js/tree/canary/packages/create-next-app) — reference for template-registry-driven scaffolders.
- `cookiecutter` (https://github.com/cookiecutter/cookiecutter) — placeholder substitution model.
- `copier` (https://github.com/copier-org/copier) — the interesting one for drift/upgrade, surfaced in ADR-008 and ADR-012.
- Yeoman (https://yeoman.io/) — rejected; cited in §Alternative 4 above.
- Ruflo ADR-103 (witness temporal history): `v3/docs/adr/ADR-103-witness-temporal-history.md` — the provenance model ADR-011 mirrors.
- Ruflo ADR-026 (Agent Booster routing): `v3/implementation/adrs/ADR-026-agent-booster-model-routing.md` — the 3-tier routing the kernel inherits.
