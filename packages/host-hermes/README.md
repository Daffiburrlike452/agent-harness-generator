# @ruflo/host-hermes

[Hermes Agent (NousResearch)](https://hermes-agent.nousresearch.com/docs/) host adapter for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

Generates the host-specific files a Hermes-targeted harness needs:

- `cli-config.yaml` with the system prompt and scrubbing flags
- `optional-mcps/*.yaml` per MCP server
- `scrubHermesBlocks()` helper exported for runtime use

## Hermes-4 quirk (mandatory handling)

Hermes-4 models emit `<think>...</think>` reasoning blocks AND occasionally raw `<tool_call>` text instead of using the OpenAI-compatible function-calling channel. See [hermes-agent#741](https://github.com/NousResearch/hermes-agent/issues/741).

**This adapter scrubs both** — same pattern as ruflo's `scrubReasoningBlocks`. The `cli-config.yaml` sets both flags:

```yaml
scrub_think_blocks: true
scrub_stray_tool_calls: true
```

## Two distinct Hermes projects — do not conflate

| Project | What it is |
|---|---|
| [NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling) | OLDER function-calling reference for Hermes 2/3 |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | CURRENT long-running agent runtime with MCP support |

This adapter targets the **current** runtime.

## Usage

```js
import adapter, { scrubHermesBlocks } from '@ruflo/host-hermes';

const config = adapter.generateConfig({
  name: 'my-bot',
  systemPrompt: 'You are a helpful agent.',
  mcpServers: [{ name: 'my-bot', command: ['npx', '-y', 'my-bot', 'mcp'] }],
});
// config['cli-config.yaml'] = '<YAML>'
// config['optional-mcps/my-bot.yaml'] = '<YAML>'

// At runtime:
const safe = scrubHermesBlocks(modelResponse);
```

## License

MIT
