# host-tour — scaffold + validate for every supported host

> One script, six hosts, one runnable demo of the multi-host parity story.

## Run

```bash
node examples/host-tour/host-tour.mjs
```

Output (~200ms on a built checkout):

```
# Host Tour — output

| Host                          | id          | files | bytes | wall | validate |
| Claude Code                   | claude-code | 7     | 1.2K  | 16ms | HEALTHY  |
| OpenAI Codex                  | codex       | 7     | 1.0K  | 14ms | HEALTHY  |
| pi.dev (badlogic/pi-mono)     | pi-dev      | 7     | 1.4K  | 14ms | HEALTHY  |
| Hermes Agent (NousResearch)   | hermes      | 7     | 0.9K  | 13ms | HEALTHY  |
| OpenClaw                      | openclaw    | 7     | 1.8K  | 15ms | HEALTHY  |
| RVM (microhypervisor)         | rvm         | 7     | 3.2K  | 17ms | HEALTHY  |

Total wall time across 6 hosts: ~95ms

[per-host file tree blocks follow]

[host-tour] DONE — 6/6 hosts HEALTHY in 192ms
```

## What it demonstrates

| Layer | This script exercises |
|---|---|
| Scaffolder (iter 4) | `scaffold()` with each of the 6 hosts |
| Per-host adapter (iter 2/11/12) | Each adapter emits its own config shape |
| Validate umbrella (iter 20) | `harness validate --skip-gcp` HEALTHY for every host |
| Per-host parity contract (iter 23/30) | The same scaffolder produces 6 valid harnesses |

If any host returns FAIL, you've found a regression that escapes the per-host e2e + validate sweep — open an issue.

## Per-host notes

| Host | Adapter package |
|---|---|
| Claude Code | [`@ruflo/host-claude-code`](../../packages/host-claude-code/) |
| OpenAI Codex | [`@ruflo/host-codex`](../../packages/host-codex/) |
| pi.dev | [`@ruflo/host-pi-dev`](../../packages/host-pi-dev/) |
| Hermes Agent | [`@ruflo/host-hermes`](../../packages/host-hermes/) |
| OpenClaw | [`@ruflo/host-openclaw`](../../packages/host-openclaw/) |
| RVM | [`@ruflo/host-rvm`](../../packages/host-rvm/) |

The `minimal` template emits a host-agnostic file shape (`CLAUDE.md` etc.) with the chosen host tagged in `manifest.hosts`. For host-specific runtime config (e.g. `.codex/config.toml`, `.openclaw/policy.yml`, `rvm-partition.toml`), the adapter packages emit those at runtime via `adapter.generateConfig(spec)` — see [`packages/bench/src/host-bench.ts`](../../packages/bench/src/host-bench.ts) for the cross-adapter benchmark that exercises `generateConfig()` directly.

## Related examples

- [`examples/quickstart/`](../quickstart/) — minimal scaffold + validate, default host claude-code
- [`examples/federation/`](../federation/) — two harness instances cross-federation

## Test contract

A regression in either the scaffolder or any host adapter that prevents one host from producing a HEALTHY manifest will fail this script with exit 1. CI runs the equivalent integration test (`__tests__/e2e-scaffold-validate.test.ts` + `__tests__/e2e-lifecycle.test.ts`) on every push.
