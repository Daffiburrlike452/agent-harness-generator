# create-harness (Codex skill)

This skill scaffolds an AI agent harness from inside the OpenAI Codex CLI.

## Install

```bash
# User-global
mkdir -p ~/.codex/skills/create-harness
curl -fsSL https://raw.githubusercontent.com/ruvnet/agent-harness-generator/main/.codex/skills/create-harness/skill.toml \
  -o ~/.codex/skills/create-harness/skill.toml

# Or copy into a trusted project (.codex/skills/create-harness/skill.toml)
```

You also need the MCP server registered. Either:

```bash
codex mcp add agent-harness-generator -- npx -y create-agent-harness@latest mcp-serve
```

or paste this into `~/.codex/config.toml`:

```toml
[mcp_servers.agent-harness-generator]
command = "npx"
args = ["-y", "create-agent-harness@latest", "mcp-serve"]
```

## Use

In Codex:

```
/create-harness
```

Codex prompts for: name, description, host, template, branding. The skill calls the `create_harness` MCP tool which then runs the scaffold.

## What gets generated

Same outputs as `npx create-agent-harness` on the command line — a self-contained npm package with kernel + host adapter + your chosen template, ready to `npm publish`.

## Notes

- **Trusted-project gate**: project-scoped Codex skills are only honored after the project is marked trusted. See [codex#3441](https://github.com/openai/codex/issues/3441). If your `.codex/skills/` content isn't loading, mark the project trusted first.
- **No hooks**: Codex has no `PreToolUse`/`PostToolUse` analog. The generated harness's lifecycle is approximated through MCP tool calls and out-of-band telemetry.
- **TOML not JSON**: Codex configuration is TOML — the syntax above is intentional, not a typo.
