# @ruflo/host-opencode

> [OpenCode](https://opencode.ai) (sst/opencode) host adapter for
> [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator).
> The 8th host adapter, per [ADR-036](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-036-host-opencode.md).

## What it does

Generates the config files a harness needs to run inside **OpenCode**, the
open-source terminal AI coding agent by SST.

Emits per `adapter.generateConfig(spec)`:

- `.opencode/opencode.json` — the OpenCode 1.x project-scoped config:
  `$schema` anchor, `mcp.servers` registration table, `mcp.permissions`
  allow/deny block
- `install.md` — runbook for `opencode auth login`, model-provider
  selection, and the first-boot smoke

## Schema (OpenCode 1.x)

```json
{
  "$schema": "https://opencode.ai/schema/opencode.json",
  "mcp": {
    "servers": {
      "codeindex": {
        "command": "node",
        "args": ["./dist/mcp-server.js"],
        "env": { "LOG_LEVEL": "info" }
      },
      "remote": {
        "url": "https://example.com/mcp"
      }
    },
    "permissions": {
      "allow": ["mcp__codeindex__*"],
      "deny": ["Bash(rm:*)", "Bash(git push:*)"]
    }
  }
}
```

## Default-deny composition

OpenCode evaluates `mcp.permissions.deny` **before** `allow`. This adapter
copies the harness's `.harness/mcp-policy.json` deny rules verbatim, so the
default-deny posture from [ADR-022](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-022-mcp-primitive.md)
wins through OpenCode's own enforcement gate — no second source of truth.

## Constraints

- **OpenCode 1.0+** — earlier 0.x versions had a different config layout
- A model provider configured (`opencode auth login`)
- `.opencode/opencode.json` is re-read on `:reload`, not hot-edit

## Programmatic use

This adapter is normally consumed via `npx metaharness <name> --host opencode`.
Direct programmatic use:

```ts
import { adapter } from '@ruflo/host-opencode';
const files = adapter.generateConfig!(harnessSpec);
// files === { '.opencode/opencode.json': '...', 'install.md': '...' }
```

## License

MIT — see [LICENSE](LICENSE).
