# MetaHarness × pi.dev AGENTS.md harness

> ⚠️ **Illustrative output.** Transcripts and validation/run output shown in this README are
> representative examples, not captured from a specific run — actual output depends on your
> environment, models, and inputs. Run the commands to see real results.


A one-shot scaffold that drops a pi.dev-ready agent harness into a new folder. It wires up the `AGENTS.md` contract that pi.dev workers read on startup, ships a minimal template (no opinionated multi-agent vertical), and leaves you with a clean working directory you can commit immediately. This is for engineers who already know they want pi.dev as their host runtime and just want the boilerplate done. It does NOT include domain-specific agents, evaluation harnesses, or pre-baked workflows — pick a vertical package if you want that.

## Quickstart

```bash
npx @metaharness/pi-dev@latest my-bot
cd my-bot
npm install
harness doctor
```

`harness doctor` verifies that your `AGENTS.md`, host config, and MCP wiring all parse and resolve. If it prints green, you can hand the directory to pi.dev and start a session.

## What you get

- `AGENTS.md` — the canonical contract pi.dev agents read on boot (rules, tools, file boundaries).
- `.pi/config.json` — host-specific config for pi.dev (model defaults, sandbox policy, working dir).
- `harness.config.json` — metaharness-level config so `harness doctor` / `harness validate` know your layout.
- `mcp.json` — empty but valid MCP server registry; add servers as you need them.
- `agents/` — one starter agent stub (`agents/main.md`) you can rename or duplicate.
- `scripts/` — `doctor.mjs` and `validate.mjs` shims that defer to the `harness` CLI.
- `.gitignore`, `package.json`, `README.md` — sane defaults, no lockfile churn.

## Advanced

Validate the AGENTS.md contract and host config without running an agent:

```bash
$ harness doctor
[doctor] AGENTS.md           OK
[doctor] .pi/config.json     OK
[doctor] mcp.json            OK (0 servers registered)
[doctor] harness.config.json OK
ready.
```

Strict-validate every referenced file path and tool name:

```bash
$ harness validate --strict
[validate] resolving 1 agent...
[validate] agents/main.md: tools=[Read, Write, Bash] all resolvable
[validate] no dangling references
ok.
```

Dry-run a pi.dev session against the local scaffold without leaving your shell:

```bash
$ pi-dev run --plugin-dir . --dry-run
[pi-dev] loaded AGENTS.md (1 agent)
[pi-dev] sandbox: workspace-write
[pi-dev] would start: agents/main.md
```

## FAQ

**Q: Do I have to use pi.dev to run this?**
A: No — the `AGENTS.md` file is portable. Other AGENTS.md-aware hosts (Codex, Cursor agents, etc.) will read the same contract. The `.pi/config.json` is the only pi.dev-specific piece, and it's ignored by other hosts.

**Q: Where do I add my own agents?**
A: Drop new markdown files into `agents/` and reference them from `AGENTS.md`. Run `harness validate` to confirm the references resolve before committing.

**Q: Why does this ship `mcp.json` with zero servers?**
A: So `harness doctor` has a real file to validate against. Add MCP servers with `harness mcp add <name>` or by editing the file directly — both are supported.

## License

MIT. Built on metaharness (https://www.npmjs.com/package/metaharness).

## Deep-dive

Full explainer gist: https://gist.github.com/ruvnet/ec3c2bb303ba99d83dc5cb36306d6380
