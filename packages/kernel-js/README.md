# @ruflo/kernel

Cross-platform kernel for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

## What it is

A Rust kernel compiled to two npm-shippable targets:

- **WebAssembly** (primary distribution — runs on Node, browser, Cloudflare Workers, Deno, Bun, edge)
- **NAPI-RS native** (per-platform `.node` binaries — escape hatch for Node hot paths)

At load time, `loadKernel()` prefers the per-platform native package; falls back to wasm.

## Install

```bash
npm install @ruflo/kernel
```

The native packages (`@ruflo/kernel-darwin-arm64`, `-linux-x64-gnu`, etc.) are declared as `optionalDependencies` — npm installs only the one for your platform.

## Usage

```js
import { loadKernel } from '@ruflo/kernel';

const kernel = await loadKernel();
const info = kernel.kernelInfo();
console.log(`kernel ${info.version} (${kernel.backend})`);

// Validate an MCP server spec.
const err = kernel.mcpValidate(JSON.stringify({
  name: 'demo',
  command: ['npx', '-y', 'demo'],
}));
if (err) throw new Error(err);
```

### Memory subsystem (subpath export)

```js
import { rankWithDecay } from '@ruflo/kernel/memory';

const ranked = await rankWithDecay(hits, {
  useDecay: true,
  halfLifeMs: 7 * 24 * 60 * 60 * 1000,  // 7-day half-life
});
```

Wraps `@ruvector/emergent-time` for HNSW decay scoring.

## Subsystems

| Subsystem | What it does |
|---|---|
| `mcp` | MCP server spec + tool registry |
| `hooks` | Lifecycle hook dispatch with permission-decision merge |
| `memory` | AgentDB bridge + emergent-time decay weighting |
| `routing` | 3-tier routing (codemod / Haiku / Sonnet-Opus) |
| `intel` | Intelligence pipeline phases |
| `claims` | Claims-based authorization |
| `witness` | Ed25519-signed provenance manifests |

## License

MIT
