# ADR-002: Kernel Boundary

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-001 (Goals), ADR-002a (Rust crate + WASM/NAPI-RS publishing pipeline), ADR-003 (Generator architecture), ADR-004 (Host integration), ADR-005 (Marketplace), ADR-006 (Memory + learning), ADR-012 (Eject + upgrade)

> This is the load-bearing decision of the series. Every subsequent ADR depends on what is in the kernel and what is not. Spend the time here.

## Context

Ruflo today is built as one bundle. The `ruflo` npm package depends transitively on `@claude-flow/cli`, which depends on `@claude-flow/memory`, `@claude-flow/hooks`, `@claude-flow/security`, `@claude-flow/guidance`, `@claude-flow/shared`, `@claude-flow/codex`, `@claude-flow/embeddings`, and a series of integration packages (`agentic-flow`, `agentdb`, `ruvector`). Inside `@claude-flow/cli/src/` you find:

- `init/` — generates `.claude/`, `settings.json`, `.mcp.json`, `CLAUDE.md`
- `mcp-tools/` — 314 MCP tools across `agentdb-tools`, `agent-tools`, `memory-tools`, `hooks-tools`, `claims-tools`, etc.
- `memory/` — `memory-bridge.ts`, `intelligence.ts`, `rabitq-index.ts`, `bge-embedder.ts`, `cross-encoder-rerank.ts`, `sona-optimizer.ts`, `ewc-consolidation.ts`
- `services/` — `claim-service`, `worker-daemon`, `worker-queue`, `headless-worker-executor`, `agentic-flow-bridge`
- `plugins/` — `manager.ts`, `store/discovery.ts`, `store/search.ts`, `trust/`
- 60+ agent definitions in `agents/`
- 30+ skills in `skills/`
- 33 marketplace plugins in `plugins/ruflo-*/`

Plus content fused into the same tree:
- Agent prompts and personas
- Skill markdown files
- The vertical-specific commands (`/gaia`, `/trader`, `/iot-*`, `/ruview-*`)
- Brand strings (`"ruflo"`, `"@claude-flow"`, `"Claude Flow"`)
- The `verification.md` manifest and the `witness-fixes.json` that names ruflo-specific fixes

A user who wants to ship their own harness today has to (a) fork the whole tree, (b) rebrand every string, (c) decide whether to delete ruflo-specific agents/skills/plugins, (d) decide whether to keep ruflo's IPFS registry CID or run their own, and (e) accept that future upstream changes will be merge conflicts. They mix kernel and content concerns at every step because the codebase mixes them.

The kernel-boundary decision answers: **what is the smallest stable surface that every harness needs, independent of identity and content?**

## Decision

### The kernel package

`@metaharness/kernel`. **The kernel is Rust source code, compiled to two distribution targets** — a WebAssembly bundle and a per-platform native NAPI-RS binary — and shipped through a single npm package that runtime-selects between them. This is the same pattern `@ruvector/router` already uses on this project (per-platform native packages like `@ruvector/router-linux-x64-gnu` declared as `optionalDependencies`, with a wasm fallback).

> **Why "@ruflo"** — the `@ruflo` scope is the same scope ruflo's user-facing wrapper already uses (`ruflo` on npm); the kernel ships from that scope as a sibling package, signalling that the kernel is the substrate, not the product. Scope rules are pinned in ADR-015 §npm scope strategy.

> **The two-target decision is load-bearing.** ADR-002a (Rust crate + WASM/NAPI-RS publishing pipeline) is a sibling ADR that specifies the Cargo workspace layout, the publishing matrix, the size budget, and the smoke contract for both targets. Read it after this one. The split is for depth; the kernel-boundary decision and the publishing-pipeline decision are taken together.

### Why WASM-centric (and why also NAPI-RS)

We pick Rust→wasm as the primary distribution and Rust→NAPI-RS as the high-performance escape hatch for these reasons, in order:

1. **Cross-platform independence.** A generated harness must run the same kernel logic on Claude Code (Node), Codex (Node), the browser, Cloudflare Workers, Deno, Bun, and any future host that loads modules. A wasm bundle does this with one artefact; native modules do not.
2. **Single source of truth.** The kernel exists as one Rust crate. TypeScript bindings are auto-generated from `wasm-bindgen` declarations (the `.d.ts` ships with `pkg/`). There is no parallel TypeScript implementation that can drift from the Rust.
3. **Deterministic execution.** wasm execution is byte-stable across hosts. This is what makes the witness manifest (ADR-011) actually verifiable across CI runners — the same input on every platform produces the same output, which means a regenerated witness signature is genuinely deterministic, not just "deterministic on Linux x86-64."
4. **Memory safety.** Rust's borrow checker eliminates a class of kernel bugs (use-after-free, data races) that a Node/TypeScript kernel could ship. The cost of those bugs at the kernel layer would be felt by every downstream harness.
5. **Performance with a native escape hatch.** wasm SIMD covers most hot paths (HNSW search, ONNX inference, codemod AST walks). For the cases that still benefit from native code (large memory bridge writes, big ANN index builds), NAPI-RS gives us per-platform `.node` binaries at native speed. The kernel resolver picks native when present.
6. **Working precedent.** `@ruvector/emergent-time@0.1.0` is live on npm today (2026-06-13). It is a 55 KB wasm-opt'd module produced by exactly this Rust → `wasm-pack` → npm pipeline, with `tsc --strict` SDK on top, validated via `wasm-tools validate`, and loadable in browser / bundler / Node via `initSync()`. The pipeline is not theoretical; we ship one already.

### Build pipeline

The kernel is built from one Rust workspace into two artefact tracks. ADR-002a documents the workspace layout and CI matrix; the sketch:

| Target | Tooling | Output |
|---|---|---|
| **WebAssembly** | `cargo build --target wasm32-unknown-unknown` → `wasm-pack build --target bundler` → `wasm-opt -Oz` → `wasm-tools validate` | `@metaharness/kernel/pkg/` — wasm bundle + generated `.d.ts` |
| **Native (Node)** | `napi build --platform --release` per target triple | `@metaharness/kernel-{darwin-arm64,darwin-x64,linux-x64-gnu,linux-x64-musl,linux-arm64-gnu,win32-x64-msvc}` |

Tooling references:
- `wasm-bindgen` — https://rustwasm.github.io/docs/wasm-bindgen/
- `wasm-pack` — https://rustwasm.github.io/docs/wasm-pack/
- NAPI-RS — https://napi.rs/

### Distribution: one published package, optional native peers

The npm install surface is one package — `@metaharness/kernel`:

```jsonc
{
  "name": "@metaharness/kernel",
  "main": "./loader.js",
  "exports": {
    ".": { "types": "./pkg/kernel.d.ts", "default": "./loader.js" },
    "./mcp": { "types": "./pkg/mcp.d.ts",   "default": "./loader.js" },
    "./hooks": { /* ... */ },
    "./memory": { /* ... */ },
    "./routing": { /* ... */ },
    "./marketplace": { /* ... */ },
    "./witness": { /* ... */ },
    "./init": { /* ... */ },
    "./hosts": { /* ... */ }
  },
  "optionalDependencies": {
    "@metaharness/kernel-darwin-arm64":   "1.2.0",
    "@metaharness/kernel-darwin-x64":     "1.2.0",
    "@metaharness/kernel-linux-x64-gnu":  "1.2.0",
    "@metaharness/kernel-linux-x64-musl": "1.2.0",
    "@metaharness/kernel-linux-arm64-gnu":"1.2.0",
    "@metaharness/kernel-win32-x64-msvc": "1.2.0"
  }
}
```

The `loader.js` runtime resolver tries to `require` the matching `@metaharness/kernel-<platform>` first; on miss (Cloudflare Workers, browser, an unsupported platform, an air-gapped install that did not fetch the native peer), it falls back to loading the wasm bundle from `pkg/`. The wasm fallback always works; the native peer is an optimisation, not a requirement.

The version-pin contract is strict: `@metaharness/kernel` and every `@metaharness/kernel-<platform>` peer publish in lockstep at the exact same version. The loader refuses to mount a native binary whose version differs from the kernel's `package.json` version. ADR-002a specifies the publish pipeline that enforces this.

### When wasm is right vs when native is right

| Situation | Use wasm | Use native |
|---|---|---|
| Generated harness running under Claude Code or Codex (Node) | Either works | Native preferred (no wasm startup cost) |
| Harness running in the browser / Cloudflare Workers / Deno / Bun | Wasm | Not available |
| CI build that needs to verify witness determinism across OSes | Wasm | Wasm (native loses bit-stability across runners) |
| Heavy HNSW index build (>1M vectors) | Slower | Native preferred (SIMD + native fs) |
| Air-gapped install on a less-common platform | Wasm | Falls back to wasm |
| Performance-critical memory bridge writes | Acceptable | Native preferred |

The kernel's default is "load native if available, else wasm." The harness can override via `harness.config.json` `kernel.preferTarget: "wasm" | "native"` for cases where the choice matters (e.g. a CI job that demands the wasm path to verify cross-platform).

### What is IN the kernel

The kernel ships seven subsystems. Each is a Rust module in the kernel crate, exposed via `wasm-bindgen` to JavaScript (and via NAPI-RS to native Node). Each is a clean subpath export. Each has a stable public API surface that is part of the kernel's semver contract. The TypeScript type declarations under each subpath are auto-generated from the Rust source — there is no hand-written TS facade that can drift.

#### 1. MCP server scaffold (`@metaharness/kernel/mcp`)

- A pre-built MCP server runtime (stdio + HTTP transports), with the protocol routing already wired. Implemented as a Rust module; the wasm and native builds expose the same `McpServer` type to JavaScript.
- Tool registration API: `registerTool(name, schema, handler)`. Handlers can be JavaScript closures passed in via `wasm-bindgen` (or NAPI callbacks for the native build).
- The cross-platform spawn-shape from the existing ruflo `mcp-generator.ts` (Windows `cmd /c npx` wrap, Unix direct `npx`) is ported to Rust as a helper so generated `.mcp.json` files are correct without re-inventing the wrapper.
- NOT included: any specific tool. The 314 MCP tools in `mcp-tools/` are content (see "OUT of the kernel" below). The kernel ships the registry + transport, not the catalogue.

#### 2. Hooks runtime (`@metaharness/kernel/hooks`)

- Hook registry, executor, and lifecycle (`pre-edit`, `post-edit`, `pre-task`, `post-task`, `session-start`, `session-end`, `pre-command`, `post-command`).
- Hook discovery from the harness's `.harness/hooks/` directory (renamed from `.claude/hooks/` to be host-agnostic).
- The 12 background workers' executor framework. NOT the specific 12 workers — those are content.
- The intelligence hooks (`route`, `explain`, `pretrain`, `build-agents`, `transfer`) as APIs only — the model behind each is content. The kernel ships the interface; the harness ships (or chooses) the implementation.

#### 3. Memory bridge (`@metaharness/kernel/memory`)

- AgentDB controller binding (depends on the `agentdb` npm package as a peer in Node hosts; wasm builds use the wasm-compatible AgentDB build).
- HNSW index lifecycle (BGE embedder → RaBitQ index → search pipeline) as Rust modules with a factory-function JS surface.
- The hybrid SQLite + AgentDB backend (the ADR-009 ruflo decision, generalised — pluggable backend).
- The unified memory search API (`memory_search_unified`) as the cross-namespace entry point.
- ReasoningBank trajectory tracking: `trajectory.start/step/end`, verdict judgement interface, pattern store/search.
- The emergent-time decay primitive, consumed as **`@ruvector/emergent-time@0.1.0`** (the live npm wasm package; see https://www.npmjs.com/package/@ruvector/emergent-time). Detailed in ADR-006 §Layer 2.
- NOT included: any specific embedding model. The kernel ships the wiring; the harness picks the model (default: `all-MiniLM-L6-v2`, 384-dim, the ruflo default).

#### 4. 3-tier routing (`@metaharness/kernel/routing`)

- The router from ruflo ADR-026 / ADR-143: deterministic codemod → Haiku → Sonnet/Opus.
- The Thompson-sampling Beta-Bernoulli bandit `ModelRouter` (per ADR-026 note dated 2026-06-09; see `v3/@claude-flow/cli/src/ruvector/model-router.ts`).
- The deterministic codemod set (the ADR-143 Tier-1 transforms: `var-to-const`, `remove-console`, `add-logging`). Stays in the kernel because it is the $0 / 1ms path every harness benefits from.
- NOT included: provider-specific model invocation. The kernel ships "route this task to tier N"; the harness's host adapter (ADR-004) actually calls the model.

#### 5. Marketplace client (`@metaharness/kernel/marketplace`)

- The IPFS registry consumer: fetch registry by CID via Pinata gateway, verify Ed25519 signature, walk the catalogue.
- Plugin install / uninstall / enable / disable lifecycle.
- The plugin manifest schema (the `PluginEntry` type from `v3/@claude-flow/cli/src/plugins/store/types.ts`).
- The trust model from `plugins/trust/` (verified / official / community trust levels).
- NOT included: the registry CID. The kernel ships the protocol; the harness ships its choice of registry. By default a generated harness points to ruflo's CID (powered-by mode); independence-mode harnesses run their own. See ADR-015.

#### 6. Witness / provenance (`@metaharness/kernel/witness`)

- The witness manifest format from ruflo ADR-103 (signed Ed25519 manifest + append-only JSONL temporal history), generalised.
- The `regen`, `verify`, `history` scripts as library functions (the work already started in `plugins/ruflo-core/scripts/witness/` per ADR-103 §2).
- NOT included: any specific fix list. The harness ships its own `witness-fixes.json` describing what its release attests.

#### 7. Init / scaffolding helpers (`@metaharness/kernel/init`)

- Cross-platform path helpers (the Windows/Unix branch from `init/mcp-generator.ts`).
- The `claudemd-generator.ts` logic, generalised: produce a host-instructions file (`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, `HERMES.md` for Hermes-agent, host-specific names for pi.dev).
- The settings-generator and statusline-generator factored to take host as a parameter.
- NOT included: the actual `CLAUDE.md` content for ruflo — that is content, and lives in the `ruflo` harness package.

### What is OUT of the kernel — content lives in the harness

The kernel does not ship any of the following. Everything below is "content" — it belongs to a specific harness and travels with it, not with the substrate.

| Content category | Examples | Where it lives instead |
|---|---|---|
| Agent definitions | The 60+ agents in `v3/@claude-flow/cli/src/agents/` | The harness package (e.g. `ruflo/agents/`, `@acme/support/agents/`) |
| Skills | The 30+ skills in `.claude/skills/` | The harness package |
| Vertical commands | `/gaia`, `/trader`, `/iot-*`, `/ruview-*` | Vertical pack plugins (ADR-013) or the harness's own commands directory |
| Brand strings | `"ruflo"`, `"Claude Flow"`, `"Powered by Anthropic"` | Harness's `harness.config.json` |
| The 314 MCP tools | `agentdb-tools.ts`, `memory-tools.ts`, `hooks-tools.ts`, etc. | Mostly become kernel APIs; specific tool registrations are content the harness chooses |
| Specific 12 background workers | `audit`, `optimize`, `map`, `document`, etc. | Content. Each worker is one file; the harness opts in. |
| ruflo's IPFS registry CID | `QmXbfEAaR7D2Ujm4GAkbwcGZQMHqAMpwDoje4583uNP834` | Content (harness's `marketplace.registryCid`) |
| The fix list in `witness-fixes.json` | `F1`, `F12`, `#1867` … | Content. Each harness keeps its own. |
| The default agent personas / system prompts | All `.md` under `agents/` | Content. |

### The boundary in numbers — what extraction looks like

A rough, ground-truth count from the current ruflo tree (as of branch `feat/router-phase2-scaffolding`). Note that the "Kernel" verdict in the table below means "this code belongs in the kernel" — it does **not** mean a 1:1 TypeScript copy. The kernel is Rust; the existing TS code is **ported** to Rust modules, with `wasm-bindgen` annotations exposing the JS surface. Line counts after extraction are a Rust-source estimate.

| Source path | Lines | Verdict | Goes to |
|---|---|---|---|
| `v3/@claude-flow/cli/src/init/mcp-generator.ts` | ~300 | Kernel (the cross-platform wrapper logic) + content (the ruflo-specific server registration) | Split |
| `v3/@claude-flow/cli/src/init/settings-generator.ts` | ~400 | Kernel | Kernel |
| `v3/@claude-flow/cli/src/init/claudemd-generator.ts` | ~300 | Mixed — the generator is kernel, the `CLAUDE_MD_TEMPLATES` are content | Split |
| `v3/@claude-flow/cli/src/mcp-tools/*` (~30 files) | ~12,000 | Mostly content; the registry framework is kernel | Split |
| `v3/@claude-flow/cli/src/memory/*` (~13 files) | ~6,000 | Kernel | Kernel |
| `v3/@claude-flow/cli/src/services/*` (~10 files) | ~3,000 | Mixed — worker daemon framework kernel, specific worker bodies content | Split |
| `v3/@claude-flow/cli/src/plugins/{manager,store,trust}/*` | ~3,000 | Kernel (the protocol) | Kernel |
| `v3/@claude-flow/cli/src/plugins/ruflo-*/` | ~50,000 | Content (each is a marketplace plugin) | Stays in the `ruflo` harness package, published as plugins |
| `v3/@claude-flow/hooks/src/*` | ~4,000 | Kernel | Kernel |
| `v3/@claude-flow/memory/src/*` | ~3,500 | Kernel | Kernel |

Approximate target sizes after extraction:

- `@metaharness/kernel` — ~25,000 to 35,000 lines, single package.
- `ruflo` (post-extraction) — same observable behaviour, but most logic is now an `@metaharness/kernel` import. The package is mostly content + the host adapters it preconfigures.

If `@metaharness/kernel` exceeds 40,000 lines on first cut, the extraction is wrong — content is leaking in. ADR-008's drift detection will flag that condition.

### Public API surface — what we semver-commit to

The kernel's public surface is the union of these subpath exports:

```
@metaharness/kernel              — re-exports the stable top-level facade
@metaharness/kernel/mcp          — MCP server scaffolding + tool registry
@metaharness/kernel/hooks        — hooks runtime, registry, executor, worker framework
@metaharness/kernel/memory       — AgentDB binding, HNSW, ReasoningBank, emergent-time
@metaharness/kernel/routing      — 3-tier router, codemod set, bandit
@metaharness/kernel/marketplace  — IPFS registry consumer + install lifecycle
@metaharness/kernel/witness      — manifest, history, regen, verify
@metaharness/kernel/init         — cross-platform scaffolding helpers
@metaharness/kernel/hosts        — the host-adapter base classes used by ADR-004 adapters
```

The `package.json` `exports` field lists exactly these subpaths and refuses deep imports (the `./*` glob is not exported). Internal modules are not part of the contract; consumers cannot reach them.

Every breaking change to any of these subpaths requires a major-version bump of `@metaharness/kernel`. ADR-008 (drift detection) and ADR-012 (eject + upgrade) handle how this propagates to generated harnesses.

### The microkernel pattern (and why we use it)

This is a microkernel architecture: small, stable kernel; everything else is a plug-in. The pattern is old (Liedtke's L4 papers, late 1990s) and well-understood; the canonical software-architecture treatment is the "Microkernel Pattern" chapter in Buschmann et al., *Pattern-Oriented Software Architecture, Volume 1* (1996). The pattern has three guarantees:

1. **The kernel does not know about content.** It exposes mechanism, not policy. The kernel ships "how to register an MCP tool," not "which MCP tools to register."
2. **Content does not know about other content.** Two agents in the same harness do not directly depend on each other through the kernel; they communicate via kernel APIs (memory, hooks, messaging).
3. **The kernel can be upgraded independently of content.** ADR-012 leans on this.

The closest contemporary analogues we cite as prior art:

- **VS Code's extension API** (https://code.visualstudio.com/api). The editor is the kernel, extensions are content. The API has a versioned compatibility contract (`engines.vscode`). We mirror this with `engines.kernel` in generated harness `package.json`.
- **Babel's plugin architecture** (https://babeljs.io/docs/plugins). Core is small; transforms are plugins. We mirror the "plugins can ship presets" model in vertical packs (ADR-013).
- **Vite's plugin API** (https://vitejs.dev/guide/api-plugin.html). Hooks-based, ordered, with a discriminated-union shape. Influence on the hooks runtime API.

### The thing we are explicitly NOT mirroring

We are not mirroring **create-react-app's "eject"** as the default upgrade mechanism. CRA's eject was a one-way door that destroyed the upgrade path; once ejected, the user was alone. Our default is peer-dep mode (kernel as a peer of the harness, upgradeable by `npm update`). Eject exists (ADR-012) but is explicitly named as the escape hatch, not the path of least resistance. CRA's failure here is documented widely; the immediate consequence in the React ecosystem was that the Next.js / Vite community displaced CRA entirely. We do not want to make the same trade.

## Consequences

### What gets easier

- **A clear `import` line** answers "is this in the kernel?". If the source says `import ... from "@metaharness/kernel/..."`, it is kernel. If it says `import ... from "./agents/foo"` or `from "@acme/some-pack"`, it is content. A linter rule (ADR-010 §Static checks) can enforce this.
- **A clear ownership boundary.** Kernel changes are reviewed by kernel maintainers (small group). Content changes are reviewed by harness maintainers (many groups, one per harness). This scales the contribution model.
- **The marketplace can advertise compatibility cleanly.** A plugin says "compatible with `@metaharness/kernel ^1.x`", same way a VS Code extension says "compatible with `vscode ^1.85`". Generated harnesses surface this. See ADR-005.

### What gets harder

- **Extraction cost is real.** Splitting the existing `@claude-flow/cli` tree along the boundary above is significant refactoring. It must happen behind a feature flag (`USE_KERNEL_EXTRACTION=1` environment variable), shipped incrementally, with the `ruflo` harness package being the first consumer.
- **Two release cadences.** Kernel and harness now ship on different schedules. The kernel must be conservative (semver-strict). The harness can ship faster. ADR-007 (CI guards) specifies the per-package gates.
- **Surface freezes.** Anything exported from `@metaharness/kernel` is, in practice, a forever-promise. Mistakes (an over-broad export, a leaky type) become migration tax. The semver rule for the kernel is strict: minor / patch only add to the surface, never change semantics; majors require six months of deprecation notice on the old surface. ADR-012 §Deprecation lane.

### What does not change

- The runtime cost of using the kernel is the same as using the bundled ruflo today. Subpath exports are tree-shaken; harnesses that do not use `@metaharness/kernel/witness` do not pay for it at install.
- The `ruflo` end-user CLI surface is preserved. ADR-016 specifies the migration path that lets existing `ruflo` users see no behavioural change.

## Alternatives Considered

### Alternative 1: One-package kernel + content, but with cleaner internal boundaries

Keep the kernel and content in one package; rely on directory conventions and lint rules to enforce the split. Rejected because the public-API contract is the only credible enforcement. A directory convention is broken the first time a content module reaches into a kernel-internal helper because it is convenient; once that import lands, the boundary is fictional. The npm-package boundary is the only one that is actually checked at every build.

### Alternative 2: Multiple small kernel packages (microservice-style)

Split into `@metaharness/kernel-mcp`, `@metaharness/kernel-hooks`, `@metaharness/kernel-memory`, etc. Each independently versioned. Rejected for v1.0 because (a) the seven kernel subsystems are not independently usable — they cross-call constantly (the memory bridge needs the hooks runtime to fire `post-store`; the routing system reads patterns from memory) — and (b) the version-skew matrix between seven packages would be a maintenance burden out of proportion to the benefit. Subpath exports give us the same import ergonomics without the matrix. This decision is revisitable if a real consumer pull emerges (e.g. someone wants only `@metaharness/kernel/memory` standalone). For now, one package, seven subpaths.

### Alternative 3: Put the host adapters in the kernel

The Claude Code / Codex / Hermes / pi.dev adapters could ship from `@metaharness/kernel/hosts/*` directly. Rejected because each host moves at a different cadence — Anthropic ships Claude Code releases monthly, Codex CLI releases on a different cadence, Hermes-agent is research-track. The kernel cannot afford to absorb each host's churn. Instead: the kernel ships the host-adapter **base class** (so adapters share a contract); the actual adapter implementations live in separate packages (`@metaharness/host-claude-code`, `@metaharness/host-codex`, etc.) versioned independently. See ADR-004.

### Alternative 4: Put the IPFS marketplace client in a separate package

`@metaharness/marketplace`, peer of the kernel. Rejected because every harness benefits from marketplace participation (it is one of the project's reasons for existing). Making it a separate install means the default harness either silently skips marketplace integration or fails at install time. Either is worse than carrying it. The cost is one extra dependency (the IPFS client); we accept that.

### Alternative 5: Make agents and skills "kernel content packs"

A category between kernel and content — a base set of agents that every harness gets for free. Rejected because there is no agent that every harness needs. A customer-support harness does not need `byzantine-coordinator`. A trading harness does not need `api-docs`. The kernel must not assume the domain. The composer (ADR-003 §3) presents a curated catalogue at generation time; that is the right place for "every harness probably wants `coder, reviewer, tester`," not the kernel.

### Alternative 6: Pure-TypeScript kernel (the original draft of this ADR)

The first cut of this ADR specified `@metaharness/kernel` as a TypeScript-only npm package — same TS source that ruflo ships today, factored into a separate package. Rejected because:

- **Host fragmentation.** A TS-only kernel runs in Node and the browser via bundlers, but it cannot ship to Cloudflare Workers / Deno / Bun / edge runtimes without the harness author maintaining their own polyfill matrix. A wasm bundle removes this concern.
- **Witness determinism.** The witness manifest (ADR-011) needs byte-stable kernel behaviour across CI runners. JavaScript engines on different platforms ship subtly different math (Intl, regex unicode tables, Float64 rounding edges). A wasm bundle is byte-stable; a TS implementation is "stable enough most of the time," which is not the same.
- **Memory safety.** A kernel bug at this layer is felt by every downstream harness. Rust's borrow checker eliminates a class of these bugs at compile time. TypeScript catches none of them.
- **Single source of truth.** A pure-TS kernel forks immediately if any subsystem ever needs Rust speed for a hot path (HNSW, ONNX). At that point the TS becomes a façade over native bindings, the codebases diverge, and the kernel surface area doubles. Starting in Rust avoids this.
- **Working precedent.** `@ruvector/emergent-time@0.1.0` is the same Rust → wasm-pack → npm pipeline shipped end-to-end already. We do not have to invent the publishing infrastructure; it works today.

The pure-TS path lost on cross-platform reach. ADR-002a documents the publishing pipeline we use instead.

## Test Contract

This ADR is satisfied when the following exist:

### Static checks

1. **Rust-side import-boundary check** in the kernel crate: no module under `crates/kernel/src/` may depend on a content crate; clippy's `disallowed-types` or a custom xtask enforces this. The JS-side wrapper (the wasm/NAPI loader in `pkg/`) is auto-generated and contains no hand-written content imports.
2. **Public-API freeze test**: every release runs `microsoft/api-extractor` against the auto-generated `pkg/*.d.ts` for the wasm target and against the NAPI-generated `.d.ts` for the native target. The two MUST match. A new export, removed export, or changed signature requires a corresponding semver bump and a manual override comment in the PR. Lives in `packages/kernel/test/api-surface.test.ts`.
3. **Subpath-only export check**: a runtime assertion that no deep import (e.g. `@metaharness/kernel/internal/foo`) resolves. Implemented as a `require.resolve` smoke check in CI.
4. **Wasm/native parity test**: the same fixture suite runs once against the wasm bundle and once against each native build; outputs must match bit-for-bit. This is the gate that catches accidental drift between targets. ADR-002a specifies the harness.

### Behavioural contract (London-school unit, kernel side)

For each kernel subsystem (`mcp`, `hooks`, `memory`, `routing`, `marketplace`, `witness`, `init`, `hosts`):

4. **A contract test fixture** that mocks the public dependencies and asserts the public API behaves to spec. Specifically: tool registration / discovery, hook firing order, memory store/retrieve round-trip, route-decision determinism for a known input, plugin install lifecycle, witness regen / verify round-trip, scaffold-helper cross-platform output, host-adapter base behaviour.

### Integration contract (harness side)

5. **A `@metaharness/test-harness` package**: a minimal harness that wraps the kernel with the smallest content (1 agent, 1 skill, no plugins, Claude Code adapter only). Used as the canary for every kernel release. If the test harness does not build or its smoke contract does not pass, the kernel release is blocked. Lives in `packages/test-harness/`.

### Migration contract

6. **The `ruflo` harness package re-passes its full test suite** after the kernel extraction lands. The CI job that proves this is `ruflo-kernel-migration-check`; it is the gate that proves Alternative 1 (in-place split) was correctly avoided.

## References

### Ruflo internals cited

- `v3/@claude-flow/cli/src/init/mcp-generator.ts` — the cross-platform `cmd /c` wrapper to factor into `@metaharness/kernel/init`.
- `v3/@claude-flow/cli/src/init/settings-generator.ts` and `claudemd-generator.ts` — the parameterise-by-host candidates.
- `v3/@claude-flow/cli/src/memory/*` — the seven memory modules that become `@metaharness/kernel/memory`.
- `v3/@claude-flow/cli/src/plugins/store/discovery.ts` — the IPFS registry consumer that becomes `@metaharness/kernel/marketplace`.
- `v3/@claude-flow/cli/src/plugins/store/types.ts` — the `PluginEntry` schema.
- `v3/@claude-flow/cli/src/ruvector/model-router.ts` — the heuristic + bandit `ModelRouter` for `@metaharness/kernel/routing`.
- `v3/@claude-flow/hooks/src/*` and `v3/@claude-flow/memory/src/*` — the existing packages that the kernel subsystems extract into.

### Ruflo ADRs cited

- ADR-026 (Agent Booster routing): `v3/implementation/adrs/ADR-026-agent-booster-model-routing.md`.
- ADR-103 (Witness temporal history): `v3/docs/adr/ADR-103-witness-temporal-history.md`.
- ADR-143 (Deterministic Tier-1 codemods): `v3/docs/adr/ADR-143-deterministic-tier1-codemods.md`.

### External prior art

- L4 / microkernel: Liedtke, *On µ-Kernel Construction*, SOSP 1995. https://os.inf.tu-dresden.de/pubs/sosp95/
- Microkernel pattern: Buschmann, Meunier, Rohnert, Sommerlad, Stal, *Pattern-Oriented Software Architecture, Volume 1*, Wiley 1996, "Microkernel" chapter.
- VS Code extension API: https://code.visualstudio.com/api
- Babel plugin architecture: https://babeljs.io/docs/plugins
- Vite plugin API: https://vitejs.dev/guide/api-plugin.html
- CRA eject critique: see the Vite team's reasoning in https://vitejs.dev/guide/why and the general Next.js / Vite displacement of CRA in the React ecosystem post-2022.
- `@ruvector/emergent-time@0.1.0` — the working Rust → wasm-pack → npm precedent: https://www.npmjs.com/package/@ruvector/emergent-time.
- `emergent-time` crate (Rust source): https://crates.io/crates/emergent-time, https://docs.rs/emergent-time, https://github.com/ruvnet/ruvector.
- `wasm-bindgen` — https://rustwasm.github.io/docs/wasm-bindgen/
- `wasm-pack` — https://rustwasm.github.io/docs/wasm-pack/
- NAPI-RS — https://napi.rs/
- `@ruvector/router` native-package pattern (per-platform `.node` peers as `optionalDependencies` with wasm fallback) — the same pattern this ADR adopts.
