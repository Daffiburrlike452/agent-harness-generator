# create-agent-harness

Scaffold your own focused AI agent harness — like [ruflo](https://github.com/ruvnet/ruflo), uniquely yours.

## Quick start

```bash
npx create-agent-harness my-bot
```

You'll be prompted for template, host, description. Out comes a complete npm package ready to `npm publish`.

## Non-interactive

```bash
npx create-agent-harness my-legal-bot \
  --template vertical:legal \
  --host claude-code \
  --description "Contract redline + risk rating"
```

## Templates

| Template | Best for |
|---|---|
| `minimal` | Custom starter — kernel only |
| `vertical:devops` | Incident response, on-call workflows |
| `vertical:support` | Customer support, KB-RAG, escalation |
| `vertical:trading` | Quant trading (paper-default, circuit breakers) |
| `vertical:legal` | Contract review with citation checking |
| `vertical:research` | Multi-source dossier with evidence grading |

## Hosts

`--host` selects which host adapter ships with your harness:

| Host | What you get |
|---|---|
| `claude-code` | `.claude/settings.json` with MCP + hooks |
| `codex` | `~/.codex/config.toml` with `[mcp_servers.*]` |
| `pi-dev` | Pi extension (TypeScript, no MCP by design) |
| `hermes` | `cli-config.yaml` + `optional-mcps/*.yaml` |

Multi-host: pass `--host` multiple times.

## Also ships the `harness` CLI

```bash
harness sign      # produce/update the witness manifest
harness verify    # check signature
harness doctor    # smoke-check a scaffolded harness
harness help
```

## Eject from ruflo

If you've been using ruflo and want your own focused harness from it:

```bash
npx create-agent-harness --from-existing ./
```

Lifts agents/skills/commands, rewrites every `ruflo` / `claude-flow` reference, preserves attribution blocks marked with `<!-- ruflo-attribution-block -->`.

## Full walkthrough

See [USAGE.md](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/USAGE.md).

## License

MIT
