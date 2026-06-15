# ADR-036: OpenCode as a harness host (proposed 8th host)

**Status**: Proposed
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-004 (host integration model), ADR-022 (MCP primitive), ADR-030 (Discovery Loop), ADR-032 (host-copilot)
**Supersedes / Superseded-by**: none

---

## Context

### What is OpenCode?

[OpenCode](https://opencode.ai) (repo: [sst/opencode](https://github.com/sst/opencode)) is an open-source terminal-based AI coding agent published by the SST organisation. Per the project's own positioning, it is intended as a vendor-neutral alternative to Claude Code — same TUI surface, same agentic-coding loop, but provider-agnostic at the model layer (Anthropic, OpenAI, local models, custom routers).

The 2026-current OpenCode shape:

- **TUI runtime** distributed as a single binary (`opencode`).
- **First-class MCP support** — config under `~/.opencode/opencode.json` (user-scoped) or `.opencode/opencode.json` (project-scoped) with an `mcp.servers` map, schema-compatible with Claude Code's `mcpServers`.
- **Plugin model** for slash commands and custom agents, defined in `.opencode/agents/` (markdown frontmatter), close to Claude Code's `.claude/commands/` shape.
- **Permissions** modelled as an allow/deny list under `mcp.permissions`, analogous to Claude Code's `permissions.allow` / `permissions.deny`.
- **Hooks** — limited; event surface is narrower than Claude Code (`pre-tool`, `post-tool`, `session-start`).

These are the integration shapes the harness has to target. The user's iter-127 directive — `add new /adr for opencode` — turns this from a possible-future-host into a Proposed ADR matching the same template as ADR-032 (Copilot) and ADR-033 (GHA).

### Why OpenCode is the right 8th host

OpenCode is the strongest near-term host candidate for three reasons:

1. **MCP-native by design.** The existing `src/mcp/{server,tools,resources,prompts,policy,audit}.ts` surface from ADR-022 maps 1:1 — no protocol bridge, no schema translation. The adapter is a config-emitter, not a runtime shim.
2. **Permissions model matches the kernel's default-deny posture.** ADR-022's `mcp-policy.json` translates directly to OpenCode's `mcp.permissions.allow` / `.deny` arrays.
3. **Open-weights / open-source friendliness.** OpenCode users self-host their model layer; the harness composes cleanly with whatever provider they bring. This is the same target audience as Hermes (ADR-004) and OpenClaw (ADR-011) — the user base that the existing hosts already serve.

### Adjacent specs and where they fit

- **MCP** (ADR-022) — fully reused; no translation required.
- **A2A / ACP / Agent Protocol** — OpenCode does not implement these at v1.x (verified via repo search, 2026). If OpenCode adopts them later, the OIA manifest (ADR-034) declares those at the cross-cutting layer; no host change needed.
- **Claims-based authorization** (ADR-010) — OpenCode's MCP gate is the enforcement point. Claims survive the per-host config emission.

## Decision

**Add `@metaharness/host-opencode` as the 8th host adapter, following the ADR-032 (Copilot) pattern: an additive config-emitter package that mirrors the existing six adapters in shape, size, and test surface.**

Status: **Proposed**. Implementation deferred to a future iteration; this ADR documents the contract.

### Package shape

```
packages/host-opencode/
├── package.json          # name: @metaharness/host-opencode, version: 0.1.0
├── tsconfig.json         # mirrors host-codex
├── LICENSE
├── README.md             # what it does, schema sample, install runbook reference
├── src/
│   └── index.ts          # HOST_NAME, serverToOpencode, opencodeJson,
│                         # installRunbook, adapter, default export
└── __tests__/
    └── index.test.ts     # ≥8 cases per the host-copilot/host-codex pattern
```

### Files emitted

Per `adapter.generateConfig(spec)`:

| Path | Purpose |
|---|---|
| `.opencode/opencode.json` | MCP server registration + permissions block; OpenCode's project-scoped config file |
| `install.md` | Runbook walking the user through `opencode auth login`, model-provider selection, and the first `opencode` boot |

### Manifest fields (additive to `.harness/manifest.json`)

```jsonc
{
  "host": "opencode",
  "meta": {
    "kernel_version": "X.Y.Z",
    "surface": "cli",
    "host_specific": {
      "opencode_min_version": "1.0.0"
    }
  }
}
```

`opencode_min_version` is an advisory floor — if OpenCode renames the config keys in a future minor (analogous to the Claude Code config-path migration that happened in 2025), `harness diag` (ADR-027) gains a new warning surface.

### `.opencode/opencode.json` schema (compatible with OpenCode 1.x)

```jsonc
{
  "$schema": "https://opencode.ai/schema/opencode.json",
  "mcp": {
    "servers": {
      "code_index": {
        "command": "node",
        "args": ["./dist/mcp-server.js"],
        "env": { "LOG_LEVEL": "info" }
      },
      "remote": {
        "url": "https://example.com/mcp"
      }
    },
    "permissions": {
      "allow": ["mcp__code_index__*"],
      "deny": ["Bash(rm:*)", "Bash(git push:*)"]
    }
  },
  "agents": [
    { "id": "architect", "path": ".opencode/agents/architect.md" }
  ]
}
```

The `mcp.servers` map is a direct re-export of the harness's `src/mcp/server.ts` registration table — no per-host transformation beyond the JSON wrapping. The `permissions` block is a copy of `.harness/mcp-policy.json` projected to OpenCode's key naming.

### Default-deny composition

OpenCode evaluates `mcp.permissions.deny` BEFORE `mcp.permissions.allow`. The adapter MUST emit the deny rules from `.harness/mcp-policy.json` verbatim — the harness's default-deny posture (ADR-022) wins by being copied into OpenCode's own enforcement gate, not by trusting OpenCode to enforce a separate default.

### Open question for the implementation iter

OpenCode is moving fast (the project shipped its 1.0 in 2026 Q1 per its release notes). The `$schema` URL above MAY drift before this ADR is implemented. The implementation MUST:

1. Pin against a snapshot of the OpenCode schema at implementation time.
2. Ship a `harness diag --opencode-version-check` flag that surfaces the schema-drift case explicitly (mirrors the kernel-version-skew pattern from iter 66).

## Consequences

| Surface | Change |
|---|---|
| `packages/host-opencode/` | New package, mirrors host-copilot in size (~100 LoC + test) |
| `packages/create-agent-harness/src/index.ts` | `HOSTS` array gains `'opencode'` (7 → 8 entries) |
| `apps/web-ui/src/generator/catalog.ts` | `HOSTS` array gains a `{ id: 'opencode', ... }` entry |
| `__tests__/integration/host-functional.test.ts` | New describe block: `host functional: opencode` |
| `__tests__/integration/multi-host.test.ts` | The host-iteration loop picks it up automatically |
| `README.md` | Hosts table gains a row |
| `docs/USAGE.md` | "Pick host(s)" table gains a row |
| `apps/web-ui` Studio gallery | Host picker UI gains a button (auto-derived from the HOSTS catalog) |
| `ADR-030` Discovery Loop | Codex skill + marketplace plugin.json + dev-toolkit propagation in the same iter |

### Risk

- **OpenCode schema drift.** Lowest risk of the 8 hosts because the project is actively maintained and ships changelogs. Mitigated by the version-check flag.
- **MCP compatibility skew.** Both projects track the MCP spec; if Anthropic/Google move the spec mid-iter, both adapters need a coordinated bump. Same risk as Claude Code; same mitigation (the kernel is the integration point, not the adapters).
- **Dual codex/opencode footprint.** Users may scaffold for both because they look similar. Acceptable — the harness output is the same npm package, just the per-host config files differ.

### Benefit

- **8th host completes the "vendor-neutral coverage" matrix.** Claude Code (Anthropic-direct), Codex (OpenAI), Copilot (Microsoft / VSCode), Hermes (Nous Research open weights), pi.dev (open dev tool), OpenClaw (personal-AI fork), RVM (hardware-isolated), OpenCode (vendor-neutral TUI). Every major AI-coding-agent surface a user might run is covered.
- **No new schema invention.** Reuses ADR-022 MCP + ADR-010 claims directly.

## Alternatives Considered

1. **Ship OpenCode as a Codex sub-mode.** Rejected: Codex emits TOML; OpenCode emits JSON. Folding them into one adapter duplicates the schema translation that ADR-004 explicitly factored out into per-host packages.

2. **Wait for OpenCode 2.0 before adding the host.** Rejected: the project's 1.x stream is API-stable per the maintainer's signalling, and the adapter is small (~100 LoC). Waiting for a hypothetical 2.0 has unbounded latency for no clear benefit.

3. **Make OpenCode the default host and demote Claude Code.** Rejected: the existing 6-host catalog has documented per-host counts in README / USAGE / tests; flipping the default would cascade across 30+ surfaces. The ADR-035 brand decision lives one layer above default-host choice — defaults stay where they are until a separate ADR addresses them.

## Test Contract

| # | File | Assertion |
|---|---|---|
| 1 | `packages/host-opencode/__tests__/index.test.ts` | `serverToOpencode()` emits valid JSON for stdio + HTTP servers |
| 2 | same | `opencodeJson(spec)` produces parseable JSON with `mcp.servers` + `mcp.permissions` blocks |
| 3 | same | `installRunbook(spec)` mentions `opencode auth login` + every MCP server by name |
| 4 | same | `adapter.generateConfig` emits `.opencode/opencode.json` and `install.md` |
| 5 | same | Byte-determinism: same spec twice → identical JSON (witness-stable) |
| 6 | `__tests__/integration/host-functional.test.ts` | `host functional: opencode` — `.opencode/opencode.json` parses + `mcp.servers` entries have valid `command`-or-`url` shape |
| 7 | `__tests__/integration/multi-host.test.ts` | `cross-host: minimal template scaffolds for every host` includes opencode automatically |
| 8 | `.github/workflows/published-smoke.yml` | The CI guard scaffolds `--host opencode` and runs `harness doctor` against it |

## References

- [OpenCode project](https://opencode.ai) — homepage, as of 2026-06-14
- [sst/opencode](https://github.com/sst/opencode) — source repo
- [ADR-004 — Host integration model](./ADR-004-host-integration-model.md)
- [ADR-022 — MCP as a gated primitive](./ADR-022-mcp-primitive.md)
- [ADR-030 — Discovery Loop propagation](./ADR-030-discovery-loop.md)
- [ADR-032 — Host: GitHub Copilot](./ADR-032-host-copilot.md) — template this ADR follows verbatim
- [ADR-033 — Host: GitHub Actions](./ADR-033-host-github-actions.md)
- [ADR-035 — Product naming (MetaHarness)](./ADR-035-product-naming.md) — Status: Accepted
