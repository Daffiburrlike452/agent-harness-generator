# @ruflo/host-codex

[OpenAI Codex CLI](https://developers.openai.com/codex) host adapter for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

Generates the host-specific config a Codex-targeted harness needs:

- `~/.codex/config.toml` with `[mcp_servers.<name>]` tables (note: **TOML, not JSON**)
- `codex mcp add` command lines

## Usage

```js
import adapter from '@ruflo/host-codex';

const config = adapter.generateConfig({
  name: 'my-bot',
  mcpServers: [{ name: 'my-bot', command: ['npx', '-y', 'my-bot', 'mcp'] }],
});
// config['.codex/config.toml'] = '<TOML>'
// config['install-mcp.sh'] = '<shell commands>'
```

## Quirks vs Claude Code (call these out for your users)

1. **TOML not JSON.** Codex config is TOML.
2. **Trusted-project gate.** Project-scoped `.codex/config.toml` is only honored after the project is marked trusted — known footgun ([codex#3441](https://github.com/openai/codex/issues/3441)).
3. **No first-class hooks system.** Codex has no `PreToolUse`/`PostToolUse` analog. Generated harnesses approximate lifecycle events via MCP tool calls.

## License

MIT
