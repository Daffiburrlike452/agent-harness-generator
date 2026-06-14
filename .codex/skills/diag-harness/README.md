# diag-harness

> Codex skill: kernel-version skew check for a scaffolded harness — the ADR-027 diagnostic UX loop.

## What it does

Single-question check: **does my local `@ruflo/kernel` match what this harness was scaffolded against?** That's the cross-machine compatibility question almost every "this harness doesn't work" support ticket turns out to be.

Reads `.harness/manifest.json`:

| Field | Source | Meaning |
|---|---|---|
| `meta.surface` | iter 56 | Which surface produced the harness (`cli` or `web-ui`) |
| `meta.kernel_version` | iter 58 | The `@ruflo/kernel` version stamped at scaffold time |

Resolves the local `@ruflo/kernel` via `createRequire` rooted at the harness's own `package.json` (real Node resolution). Computes the skew verdict and prints a copy-pasteable next step.

| Verdict | Exit | Message |
|---|---|---|
| `match` | 0 | `PASS kernel versions match exactly` |
| `patch-diff` | 0 | `WARN patch-level skew (usually safe; may include bugfixes)` |
| `minor-diff` | 1 | `WARN minor-level skew (new kernel features may be missing)` + `Run: npm install @ruflo/kernel@X.Y.Z` |
| `major-diff` | 1 | `FAIL MAJOR skew — APIs may have changed; expect breakage` + `Run: npm install @ruflo/kernel@X.Y.Z` |
| no `.harness/manifest.json` at path | 2 | `FAIL no .harness/manifest.json found at this path` |

## Usage from Codex

```
/diag-harness                           # cwd
/diag-harness path=./my-harness
```

## Equivalent CLI

```bash
harness diag                            # cwd
harness diag ./my-harness
```

## Sample output

```
harness diag — checking /tmp/my-harness

  surface:              cli
  manifest kernel:      0.1.0
  installed kernel:     0.1.0

  PASS kernel versions match exactly
```

## When to run

- After cloning someone else's harness — first thing
- After bumping `@ruflo/kernel` in a harness's `package.json`
- When `harness doctor` fails with cryptic shape errors (skew is the usual cause)
- In CI before any other harness subcommand — fail fast

## Lifecycle position

```
scaffold (create-agent-harness)
    ↓
 your code lives in the harness
    ↓
 diag (this skill)           <- before anything else, check compatibility
    ↓
 doctor / validate / sign / publish
```

## Related

- ADR-027 — CLI ↔ Web-UI integration (the parity contract diag enforces)
- iter 56 — `manifest.meta.surface` added
- iter 58 — `manifest.meta.kernel_version` stamped at scaffold time
- iter 66 — `harness diag` subcommand
