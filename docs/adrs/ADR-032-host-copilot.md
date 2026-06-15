# ADR-032: GitHub Copilot as a Harness Host

**Status**: Proposed
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-004 (host integration model), ADR-022 (MCP as gated primitive), ADR-030 (Discovery Loop propagation for new hosts)

## Context

The project now ships six host adapters: Claude Code, Codex, pi.dev, Hermes, OpenClaw, and RVM (ADR-018). A seventh is worth naming now: **GitHub Copilot**.

Copilot is the single highest-installed AI coding tool in the VS Code ecosystem. As of early 2026, over 30 million developers interact with it daily inside their editor. A generated harness that cannot run under Copilot is invisible to that audience. The question is whether Copilot's integration surface has matured enough to warrant a first-class host adapter in this project.

It has. Three developments crossed the threshold between 2024 and 2026:

1. **Copilot Extensions GA.** GitHub Copilot Extensions (formerly "Copilot for Your Products") became generally available in late 2024. The Extensions API gives a third party a chat participant, slash commands, and tool invocations reachable from the Copilot Chat panel.
2. **`vscode.lm.*` Language Model API.** VS Code 1.90+ ships a stable `vscode.lm.*` API that lets any VS Code extension call the language model the user has active — Copilot or otherwise. This is distinct from the Copilot Extensions protocol; it is the in-process path.
3. **MCP client inside Copilot Chat.** As of VS Code 1.99 / GitHub Copilot Chat 0.24 (April 2025), Copilot Chat can act as an MCP client: a user adds an MCP server via `.vscode/mcp.json` and the server's tools appear in Copilot Chat agent mode. This means the harness's existing `src/mcp/*` surface is directly reachable by Copilot with minimal new code.

The combination of MCP client support + the Copilot Extensions API creates two distinct integration paths, and the choice between them shapes the package materially.

This ADR is a **proposal**. It documents the design for `@metaharness/host-copilot` and registers the decision, but implementation is deferred to a future iteration. The status is `Proposed` pending acceptance and an implementation milestone.

## Decision

### 1. Why Copilot and not "just Claude Code in a different IDE"?

A user who runs the Claude Code CLI inside a VS Code terminal already has a Claude Code harness. What they do **not** have is the harness responding to the Copilot Chat panel — the `@` mention, the `/` command, the agent-mode tool invocation that their teammates reach from the editor sidebar without touching the terminal.

The Copilot host adapter gives the harness an **editor-native presence**: the harness becomes a chat participant the user talks to from the editor, not a CLI tool they switch context to reach. It also gives Copilot users access to the harness's memory, skill catalogue, and MCP policy layer — governance that vanilla Copilot Extensions do not ship.

The distinguishing capabilities vs the other hosts:

| Capability | Claude Code host | Copilot host |
|---|---|---|
| Primary interaction surface | Terminal, CLAUDE.md | Copilot Chat panel (`@participant`, `/command`) |
| IDE-native tool calls | Via MCP from terminal | Via Copilot agent-mode MCP client or extension API |
| Inline completions | No | Yes (via `vscode.lm.*` + `InlineCompletionItemProvider`) |
| Multi-turn editor context | `.claude/` context files | `#file`, `#selection`, `#codebase` variables via Copilot Chat |
| Auth surface | `ANTHROPIC_API_KEY` env var | VS Code `authentication.getSession('github', ...)` + GitHub token |

### 2. MCP under Copilot: current state

As of VS Code 1.99 / Copilot Chat 0.24 (as of April 2025 — this ADR assumes that baseline; later releases may change the UX but not the protocol):

- **`.vscode/mcp.json`** is the per-workspace MCP server declaration. It is the Copilot-side analog of `.claude/settings.json` for Claude Code. Format:

  ```json
  {
    "servers": {
      "my-harness": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "my-harness", "mcp", "start"],
        "env": { "MY_HARNESS_MEMORY_PATH": "${workspaceFolder}/.harness/memory" }
      }
    }
  }
  ```

  HTTP/SSE servers use `"type": "sse"` with a `"url"` field instead. This maps cleanly to ADR-022's `local` (stdio) and `remote` (HTTP) modes — **no changes to `src/mcp/*` are required**. The adapter generates `.vscode/mcp.json` for the `local` mode and an SSE-type entry for the `remote` mode.

- **Agent mode is required.** MCP tools only surface in Copilot Chat when the user has switched to agent mode (the `@` participant that unlocks tool calls). In basic chat mode, MCP servers are silently inactive. The harness's `.vscode/mcp.json` is correct configuration; agent-mode activation is a user-side step.

- **The MCP policy layer is unchanged.** The harness's `mcp-policy.json` default-deny posture (ADR-022) is enforced server-side, before Copilot Chat sees any response. Copilot never sees a tool result that the policy gate denied. The `harness mcp-scan` CI gate works as-is.

References for the MCP-in-Copilot state as of April 2025:
- https://code.visualstudio.com/docs/copilot/chat/mcp-servers (as of 2025-04-03)
- https://code.visualstudio.com/updates/v1_99 (MCP client shipped)

### 3. Copilot Extensions path (the chat participant)

When MCP is off (`mcp: off` in ADR-022 terms), or when the harness wants a richer editor presence than MCP alone, the Copilot Extensions path is available. A Copilot Extension is a VS Code extension that registers as a `@`-addressable chat participant:

```ts
// inside the VS Code extension activate()
const participant = vscode.chat.createChatParticipant(
  'my-harness',
  handler
);
participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
```

The handler receives a `ChatRequest`, accesses `request.command` (the `/command` name), iterates over `request.references` (the `#file`, `#selection`, etc. context variables), calls the language model, and streams a `ChatResponseStream` back.

This path gives the harness:

- **Slash commands** — `/explain`, `/refactor`, `/harness-status`, etc.
- **Editor context variables** — `#selection`, `#file`, `#codebase`, `#terminalSelection` passed directly to the agent.
- **Inline chat integration** — triggered from the editor gutter or via `Ctrl+I`.
- **Inline completions** — the extension can register a `vscode.languages.registerInlineCompletionItemProvider` that routes completions through the harness's tier-1 / tier-2 routing.

The Extensions path is more invasive than MCP: it requires publishing a VS Code extension. But it gives a far richer user experience.

### 4. Integration shape: two sub-modes

`@metaharness/host-copilot` ships **two sub-modes** that the user picks at generation time:

| Sub-mode | What ships | When to use |
|---|---|---|
| `mcp-only` | `.vscode/mcp.json` (the only new file); the existing `src/mcp/*` surface unchanged | User already has Copilot Chat in agent mode; wants to add the harness's tools with zero friction. Default. |
| `extension` | `.vscode/mcp.json` + a VS Code extension scaffold in `packages/<harness>-vscode/` | User wants `@harness` chat participant, slash commands, inline completions, and the full editor-native experience. Requires `vsce package` + install step. |

The `mcp-only` sub-mode is the recommended default because it requires no new publishing step. The `extension` sub-mode is opt-in and adds a second publishable artifact.

### 5. The new host adapter package: `@metaharness/host-copilot`

Package skeleton (mirrors `@metaharness/host-claude-code`, `@metaharness/host-codex`, `@metaharness/host-rvm`):

```
packages/host-copilot/
  package.json                  # peerDependencies: @metaharness/kernel ^1.x
  src/
    index.ts                    # exports CopilotHostAdapter : HostAdapter
    capabilities.ts             # HostCapabilities declaration
    config-generator.ts         # generateConfig() — writes .vscode/mcp.json
    mcp-registration.ts         # registerMcp() — produces RegistrationInstructions
    extension-scaffold/         # (extension sub-mode only)
      activate.ts               # VS Code extension entrypoint
      participant.ts            # chat participant + command handler
      inline-completions.ts     # InlineCompletionItemProvider
      package.json.hbs          # Handlebars template for the VS Code manifest
    post-processor.ts           # postProcessAgentOutput() — no-op (no <think> blocks)
    smoke.ts                    # smokeTest() — verifies .vscode/mcp.json is parseable
                                # and that the MCP server binary is resolvable
  __tests__/
    capabilities.test.ts
    config-generator.test.ts
    mcp-registration.test.ts
    smoke.test.ts
```

**`HostCapabilities` for `@metaharness/host-copilot`:**

```ts
{
  hostId: 'copilot',
  capabilities: {
    supportsMcp:              'both',       // stdio for mcp-only, HTTP/SSE for remote
    supportsHooks:            'kernel-side-only',  // no native hook event system
    supportsThinkingBlocks:   false,        // Copilot routes to GitHub-managed models
    supportsBackgroundAgents: false,        // no background agent runner; agent-mode is synchronous
    supportsToolCallApi:      'mcp-bridged',
    defaultProviderModels: {
      tier2: 'copilot-model-routing-managed',  // Copilot selects tier; vscode.lm.* hides the model
      tier3: 'copilot-model-routing-managed'
    },
    configFileFormat:     'json',
    configFileLocation:   '.vscode/mcp.json',
    hostInstructionsFile: 'COPILOT_INSTRUCTIONS.md'
                          // GitHub Copilot reads .github/copilot-instructions.md;
                          // the adapter writes both paths for coverage.
  }
}
```

**What gets stamped into `.harness/manifest.json`:**

```json
{
  "hosts": [
    {
      "hostId": "copilot",
      "subMode": "mcp-only",
      "configPath": ".vscode/mcp.json",
      "extensionPackagePath": null
    }
  ]
}
```

For the `extension` sub-mode, `extensionPackagePath` is set to `packages/<harness>-vscode/` and the manifest includes the VS Code extension manifest path.

### 6. Security model

Copilot's security context differs from the terminal-based hosts in two important ways:

**a) GitHub auth scope, not API key.** The harness does not receive `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` — Copilot's language model access is mediated by VS Code's `authentication.getSession('github', ['copilot'])`. The harness's MCP server runs as a local process with the user's OS permissions; it does not have an independent AI provider credential. This is a privilege reduction for some threat models (no credential to steal from env), a concern for others (the harness cannot independently invoke a model without VS Code's auth layer).

For the `extension` sub-mode, the extension receives a `vscode.LanguageModelChat` handle via `vscode.lm.selectChatModels()`; it never sees the raw API key. The handle is scoped to the current VS Code session.

**b) Workspace trust.** VS Code's Workspace Trust model (introduced in 1.57, stable through 2025) restricts what extensions and tasks can run in an untrusted workspace. The harness's MCP server is a local stdio process — it runs only when VS Code has granted the workspace sufficient trust to execute terminal commands. In restricted mode, `"type": "stdio"` MCP servers are silently disabled. The adapter's setup output prints the workspace-trust notice.

**c) Default-deny posture preserved.** The `mcp-policy.json` default-deny posture (ADR-022) is fully preserved: `allowShell: false`, `allowFileWrite: false`, `allowNetwork: false` remain the defaults. Copilot agent mode cannot grant the harness more capability than the policy file permits. The `harness mcp-scan` gate works without change.

**d) Telemetry posture.** GitHub Copilot collects telemetry on prompt/completion events by default. The harness's MCP tool call content travels through the Copilot protocol; users who want to ensure conversation content stays off GitHub's telemetry should use the HTTP-transport remote mode behind their own proxy, or configure Copilot's telemetry settings per their organisation policy. The adapter's generated `COPILOT_INSTRUCTIONS.md` documents this.

### 7. Distribution

The `mcp-only` sub-mode ships as part of the generated harness — no separate publishing step. The user generates their harness, the adapter writes `.vscode/mcp.json`, and that file is committed to the repo. Any team member opening the workspace and running the harness's `npm install` gets the MCP server wired.

The `extension` sub-mode requires:

1. Running `npx vsce package` inside `packages/<harness>-vscode/` to produce a `.vsix` file.
2. Installing via `code --install-extension <harness>-vscode-*.vsix` (private distribution) or publishing to the Visual Studio Marketplace (public distribution, requires a Publisher account and the `vscode:publish` CI step).

The adapter generates a `vscode:publish` npm script and documents the Azure DevOps Personal Access Token requirement for Marketplace publishing. Marketplace publication is **not** required for the harness to work; it is an optional distribution amplification step.

### 8. Open question: 7th host or sub-shape of a broader "vscode" host?

The most significant open question for implementors: should `@metaharness/host-copilot` be the 7th peer adapter (alongside `claude-code`, `codex`, `pi-dev`, `hermes`, `openclaw`, `rvm`), or should it become `@metaharness/host-vscode` — a broader adapter that also covers Cursor, Cline, Continue, and other Copilot-adjacent VS Code agents?

Arguments for **7th host (Copilot-specific)**:
- Copilot's auth model (GitHub OAuth, `vscode.lm.*`) is meaningfully different from Cursor's (Anthropic API key in VS Code settings) and Cline's (tool-call-over-chat model).
- Copilot Extensions have an explicit review process for Marketplace publication; a "vscode" host that lumps Cursor in would need to distinguish at publish time anyway.
- Copilot's `.github/copilot-instructions.md` convention is Copilot-specific; Cursor reads `.cursorrules` and Cline reads `.clinerules`.
- Each adapter tracks a different vendor's release cadence. A mega-adapter absorbs all their churn.

Arguments for **broader "vscode" host**:
- The `mcp-only` sub-mode is identical across Copilot, Cursor, and Cline — all three read `.vscode/mcp.json`. The adapter would be identical for all three in that sub-mode.
- Users often have multiple of these agents installed in the same workspace. A single `@metaharness/host-vscode` could generate the union of config files (`.vscode/mcp.json`, `.cursorrules`, `.clinerules`) in one step.
- Future agents will emerge; "vscode" is a stable namespace; "copilot" carries a vendor name that may change scope.

**Recommendation**: ship `@metaharness/host-copilot` as the 7th standalone adapter for now. The `mcp-only` sub-mode already provides the widest reach (Copilot, Cursor, Cline, Continue all read `.vscode/mcp.json`). Once there is a concrete need to support Cursor's `.cursorrules` conventions or Cline's approval-gate model as first-class concerns, refactor into `@metaharness/host-vscode` via a superseding ADR. Do not abstract ahead of the data.

## Consequences

### What gets better

- Copilot Chat in agent mode becomes a first-class surface for the harness's tool catalogue, with no new infrastructure beyond `.vscode/mcp.json`.
- The harness reaches the 30M+ Copilot user base inside VS Code without requiring a terminal context switch.
- The `mcp-only` sub-mode requires zero changes to `src/mcp/*` — the adapter is almost entirely a new file writer. The cost of the 7th host, measured in kernel changes, is near zero.
- The `extension` sub-mode gives product teams a publishable VS Code extension backed by the same kernel, memory, and routing the other hosts use.

### What gets harder

- **Two publishable artifacts per harness in extension sub-mode.** The release orchestration (ADR-019) must account for `vsce package` and optionally `vsce publish` as a second publishing step alongside `npm publish`. ADR-019 will need a follow-on amendment.
- **No native hook system.** Copilot Chat does not expose lifecycle events analogous to Claude Code's `PreToolUse` / `PostToolUse`. Hooks run kernel-side only. This is the same limitation as Codex and pi.dev — managed via the fallback in ADR-004 §Kernel-side hooks.
- **Model is opaque.** The harness cannot read which model Copilot is routing to. The tier-1 / tier-2 / tier-3 routing in the kernel (ADR-002's 3-tier model) cannot observe Copilot's model selection. The adapter reports `tier2` and `tier3` as `'copilot-model-routing-managed'` — a sentinel value the kernel treats as "host-managed, do not substitute."
- **Workspace trust is a footgun.** In a restricted-trust workspace, the MCP server silently does nothing. The adapter must print a clear setup notice. This is analogous to the Codex trusted-project footgun documented in ADR-004.

### What does not change

- The kernel is untouched.
- `src/mcp/*` is untouched.
- `mcp-policy.json` default-deny posture is unchanged.
- The six existing host adapters are unchanged.
- ADR-022's `harness mcp-scan` gate works without modification.

## Alternatives Considered

### Alternative A: Skip Copilot; wait for a stable `vscode.lm.*` agent API

VS Code's agent-mode tooling is moving quickly. Between VS Code 1.90 and 1.99 the MCP client shipped, moved, and changed config format twice. A "wait" strategy avoids churn. Rejected because the `.vscode/mcp.json` format has been stable since 1.99 (April 2025), and the MCP-only sub-mode's surface area is small enough that churn is tolerable — it's one JSON file. The extension sub-mode carries more risk, which is why it is opt-in rather than the default.

### Alternative B: Implement via a Copilot Extension only (no MCP)

A pure Copilot Extension, without the MCP layer, avoids the `.vscode/mcp.json` config and gives the richest possible UX (slash commands, inline completions, editor context variables). Rejected because MCP reuse is the key cost advantage: the harness's `src/mcp/*` surface already exists and already has the governance layer. A pure-extension approach would duplicate the tool catalogue in VS Code extension API terms, with no gain in capability. The `mcp-only` sub-mode provides 90% of the value at 5% of the effort.

### Alternative C: Implement a "vscode" mega-adapter now

See §8 above. Rejected at this time for the reasons stated there. The Copilot-specific adapter is the right starting point.

### Alternative D: Copilot as a harness output, not a host

Rather than making Copilot a host (something the harness runs inside), make it a target (the harness generates a standalone Copilot Extension). Rejected: it conflicts with the host adapter model (ADR-004) — hosts are platforms that execute the harness; the harness's kernel runs inside the host. If the harness only generates a Copilot Extension with no kernel, it is not a harness — it is a code generator for an unrelated product. The value is the kernel running inside the editor environment.

## Test Contract

This ADR is satisfied when the following exist:

| # | Test | Pins |
|---|---|---|
| 1 | `capabilities.test.ts` — adapter's `capabilities` object satisfies the `HostCapabilities` Zod schema | Adapter contract (ADR-004) |
| 2 | `config-generator.test.ts` — `mcp-only` mode emits `.vscode/mcp.json` with `type: "stdio"` for local and `type: "sse"` for remote | Config file shape |
| 3 | `config-generator.test.ts` — `extension` mode emits `.vscode/mcp.json` AND `packages/<harness>-vscode/package.json` with correct activation events | Extension scaffold |
| 4 | `mcp-registration.test.ts` — registration instructions include workspace-trust notice | Footgun surface |
| 5 | `smoke.test.ts` — `smokeTest()` returns `PASS` when `.vscode/mcp.json` is parseable and the MCP binary is resolvable; returns `FAIL` with a descriptive error otherwise | Smoke contract |
| 6 | `harness-manifest.test.ts` (integration) — a generated harness with `host: copilot` stamps `hosts[].hostId === "copilot"` and `hosts[].configPath === ".vscode/mcp.json"` into `.harness/manifest.json` | Manifest stamp |
| 7 | `mcp-scan.test.ts` (existing) — a Copilot harness with default policy scans clean (exit 0); a Copilot harness with `allowShell: true` is flagged HIGH (exit 1) | Policy gate (ADR-022 reuse) |
| 8 | `post-processor.test.ts` — `postProcessAgentOutput` is an identity function; no scrubbing applied | No think-block contract |

## References

1. **VS Code MCP clients** — https://code.visualstudio.com/docs/copilot/chat/mcp-servers (as of 2025-04-03)
2. **VS Code 1.99 release notes (MCP client shipped)** — https://code.visualstudio.com/updates/v1_99 (as of 2025-04-03)
3. **GitHub Copilot Extensions documentation** — https://docs.github.com/en/copilot/building-copilot-extensions (as of 2025-09)
4. **VS Code Language Model API (`vscode.lm.*`)** — https://code.visualstudio.com/api/extension-guides/language-model (as of 2026-01)
5. **VS Code Chat Participant API** — https://code.visualstudio.com/api/extension-guides/chat (as of 2026-01)
6. **`.vscode/mcp.json` schema (VS Code docs)** — https://code.visualstudio.com/docs/copilot/chat/mcp-servers#_add-an-mcp-server-to-your-workspace (as of 2025-06)
7. **VS Code Workspace Trust** — https://code.visualstudio.com/docs/editor/workspace-trust (as of 2025)
8. **VSCE publishing** — https://code.visualstudio.com/api/working-with-extensions/publishing-extension (as of 2026-01)
9. ADR-004 — Host integration model (the contract `@metaharness/host-copilot` must implement)
10. ADR-022 — MCP as a gated primitive (policy layer unchanged)
11. ADR-030 — The Discovery Loop (propagation steps when this host ships)
