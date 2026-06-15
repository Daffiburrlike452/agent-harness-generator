# Multi-host example

> Updated in iter 128.2 to use the published CLI name `metaharness` (https://www.npmjs.com/package/metaharness).

Shows a single harness targeting both Claude Code AND Codex with the same kernel + content.

## What you'll see

```bash
npx metaharness ops-demo \
  --template vertical:devops \
  --host claude-code \
  --host codex
```

The generated `ops-demo/` directory contains:

```
ops-demo/
├── package.json
├── CLAUDE.md
├── src/
│   └── agents/                # same agents for both hosts
├── .claude/
│   └── settings.json          # claude-code adapter output
├── .codex/
│   └── config.toml            # codex adapter output (TOML)
└── .harness/
    ├── manifest.json          # records hosts: [claude-code, codex]
    └── manifest.sha256
```

Your users do EITHER:

```bash
# Claude Code path
claude mcp add ops-demo -- npx -y ops-demo mcp start
```

OR:

```bash
# Codex path — same harness, different config file
codex mcp add ops-demo -- npx -y ops-demo mcp start
```

The kernel + agents + skills don't know which host they're running under. The host adapter at scaffold time emits the host-specific glue.

## Why this matters

Most harness generators force you to pick one host. This generator factors the kernel + content out of the host glue, so a single npm-publishable harness ships everywhere the kernel runs.

## Self-evolution add-on

If you want this multi-host harness to share learned weights across hosts (per-host stats stay separate; learned tier-preference is global):

```js
// In your harness's init.ts:
import { SelfEvolvingRouter } from '@metaharness/kernel/self-evolution';

const router = new SelfEvolvingRouter({
  enabled: process.env.OPS_DEMO_LEARN === 'true',
  smallTierBias: 1.0,
});

// Hook the host adapter's per-call telemetry into recordOutcome():
hostAdapter.onCall(async (event) => {
  await router.recordOutcome({
    tier: event.tier,
    success: event.exitCode === 0,
    latencyMs: event.elapsedMs,
    costUsd: event.cost,
  });
});
```

After enough calls (typically dozens), the router rebalances its tier weights. Use `router.weightFor('codemod')` etc. to inspect.

## License

MIT
