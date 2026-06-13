# Using agent-harness-generator

A plain-language walkthrough from "I want my own AI agent harness" to "I just published one to npm."

## What you'll have at the end

A self-contained npm package — let's call it `my-bot` — with:

- Its own `npx my-bot` CLI
- Its own MCP server registration
- Its own memory namespace
- Its own selection of agents, skills, plugins
- Branding that's yours, not "ruflo"
- An Ed25519-signed witness manifest so users can verify what they installed

You'll be able to `npm publish` it and your users will do `npx my-bot init` in their project.

---

## 1. Install

Once `create-agent-harness` is published to npm (currently in Phase 1 development), you'll be able to run:

```bash
npx create-agent-harness my-bot
```

No global install required. The package downloads itself on use.

If you're working from the repo directly:

```bash
git clone https://github.com/ruvnet/agent-harness-generator
cd agent-harness-generator
npm install
npm run build
node packages/create-agent-harness/dist/bin.js my-bot
```

---

## 2. Pick a template

The generator ships with six templates:

| Template | Best for |
|---|---|
| `minimal` | Custom starter — kernel only |
| `vertical:devops` | Incident response, on-call workflows |
| `vertical:support` | Customer support, KB-RAG, escalation |
| `vertical:trading` | Quant trading with paper-default + circuit breakers |
| `vertical:legal` | Contract review with citation checking |
| `vertical:research` | Multi-source dossier with evidence grading |

Pick one with `--template`:

```bash
npx create-agent-harness my-bot --template vertical:devops
```

Or run interactively (no `--template` flag) to be prompted.

---

## 3. Pick host(s)

Generated harnesses run on four hosts. You can target one or more:

| Host | What it looks like in your harness |
|---|---|
| `claude-code` | `.claude/settings.json` with MCP + hooks |
| `codex` | `~/.codex/config.toml` with `[mcp_servers.*]` table |
| `pi-dev` | Pi extension (TypeScript module, no MCP) |
| `hermes` | `cli-config.yaml` + `optional-mcps/*.yaml` |

```bash
npx create-agent-harness my-bot \
  --template vertical:devops \
  --host claude-code \
  --host codex
```

---

## 4. Customise

After scaffolding, you have a complete project. Open it and customise:

```
my-bot/
├── package.json              # name + deps
├── CLAUDE.md                 # what Claude reads first
├── src/
│   ├── init.ts               # bootstraps the kernel
│   └── agents/               # your selected agents
├── .claude/
│   └── settings.json         # hooks + MCP servers
├── .harness/
│   ├── manifest.json         # drift-detection source of truth
│   └── manifest.sha256       # corruption check
└── runbooks/ or kb/ ...      # template-specific
```

Edit anything. The kernel and host adapter come from `@ruflo/kernel` and `@ruflo/host-<n>` packages — you depend on them as published npm packages, not vendored copies.

---

## 5. Test locally

```bash
cd my-bot
npm install
npm run build
npm test
```

Then try the CLI:

```bash
node ./dist/init.js
# Or after npm link:
my-bot init
```

---

## 6. Publish to npm

When you're ready to ship:

```bash
npm publish --provenance
```

That's it. Your harness is now on npm. Users do:

```bash
npx my-bot init
```

---

## 7. Get updates (drift detection)

When `@ruflo/kernel` or your template ships an update, you don't have to start over. Run:

```bash
harness upgrade
```

It does a three-way diff:

- **Clean changes** — your local file matches what was originally generated → overwrite with the new template version
- **Conflicts** — your local file diverged from the generated state AND upstream changed too → Git-style `<<<<<<<` markers inline, or `.rej` files if you prefer

You review and resolve, then commit. Same model copier uses.

---

## 8. Eject from ruflo (if you started with ruflo)

If you've been using ruflo and want to ship your own focused harness from it:

```bash
npx create-agent-harness --from-existing ./
```

This detects your ruflo install (`.claude/`, `CLAUDE.md`, `.mcp.json`), lifts the agents/skills/commands you've customised into a new harness, and renames every `ruflo` / `claude-flow` reference. **`.claude-flow/`** local state is left behind by design — eject starts with a fresh memory.

You can preserve attribution by marking specific markdown blocks:

```html
<!-- ruflo-attribution-block -->
This harness is powered by ruflo and built on @ruflo/kernel.
<!-- /ruflo-attribution-block -->
```

These blocks are left untouched during the rewrite.

---

## 9. Marketplace publish (optional)

If you want your harness in the ruflo plugin marketplace (so it's discoverable):

```bash
# 1. Sign your harness's witness manifest
harness sign

# 2. Pin to IPFS via Pinata + emit a registry entry
harness publish --confirm
```

The publish gate:

1. Verifies the witness signature (tampered = rejected)
2. Pins your manifest to IPFS via Pinata
3. Returns the CID + a registry entry JSON
4. You submit a PR to the ruflo plugin registry adding the entry

The Pinata JWT comes from environment or GCP Secret Manager — never from a file in your repo. See [`docs/setup/gcp-secrets.md`](setup/gcp-secrets.md).

---

## 10. Self-evolving routing (advanced, opt-in)

If you want your harness to ADAPT its routing decisions over time:

```typescript
import { SelfEvolvingRouter } from '@ruflo/kernel/self-evolution';

const router = new SelfEvolvingRouter({
  enabled: true,
  smallTierBias: 1.2,  // prefer Haiku-class by default
});

// After every call, feed back the outcome:
await router.recordOutcome({
  tier: 'small',
  success: true,
  latencyMs: 480,
  costUsd: 0.00018,
});

// Then use the learned weights to re-rank tier candidates:
const order = router.reRank(['frontier', 'small', 'codemod']);
// -> ['small', 'codemod', 'frontier'] if Haiku has been winning
```

Honesty caveat from the underlying `@ruvector/emergent-time` package: the SDK is a diagnostic signal, not a proven early-warning lead vs a fair baseline. Bench it for your workload before relying on it in production.

---

## 11. Troubleshooting

| Symptom | Most likely fix |
|---|---|
| `Error: target exists` | Pass `--force` or pick a new directory name |
| `invalid harness name` | Must be kebab-case, lowercase, no leading number, no consecutive hyphens, no trailing hyphen, ≤ 214 chars (npm rule) |
| `unknown template` | Check `npx create-agent-harness` (no args) for the current template list |
| `witness verification failed` on publish | Your `.harness/witness.json` was tampered with OR `harness sign` was never run |
| `npm publish: 403` | Token expired — rotate via `gcloud secrets versions add NPM_TOKEN --data-file=-` |

---

## See also

- [`docs/adrs/INDEX.md`](adrs/INDEX.md) — the design docs (17 ADRs)
- [`docs/setup/gcp-secrets.md`](setup/gcp-secrets.md) — publish-token wiring
- [`SECURITY.md`](../SECURITY.md) — vulnerability disclosure
- [`CHANGELOG.md`](../CHANGELOG.md) — what landed when
