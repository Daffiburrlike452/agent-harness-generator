# ADR-031: The Bundle JSON Pattern — Schema-1 Diagnostic Snapshots

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-010 (TDD test contracts), ADR-027 (CLI ↔ Web-UI integration), ADR-028 (Skew Detection and Liveness), ADR-030 (Discovery Loop)
**Supersedes / Superseded-by**: none

## Context

By iter 102 the project had **three subcommands** that emit a paste-friendly JSON snapshot for a different audience:

| iter | Subcommand | Audience | What it captures |
|---|---|---|---|
| 90 | `harness diag --bundle` | Maintainer triaging a support ticket | Diag report + sanitised manifest + `@metaharness/*` deps + env |
| 97 | `harness export-config` | Security reviewer auditing a policy | MCP servers + Claude permissions + Codex config (sanitised) + manifest meta |
| 102 | `harness audit --bundle` | Vuln reviewer reading npm-audit output | Per-severity counts + offenders + level + failCount + exitCode |

ADR-030 alternative D explicitly rejected building a generic Next:-block infrastructure at N=1. The same logic applies here: at N=1 (iter 90) it was too early to abstract the bundle shape; at N=2 (iter 97) we still had only two data points. At N=3 (iter 102), the pattern has emerged with enough usage data to document.

This ADR captures the shape so the next bundle-shaped subcommand follows the same template, and so future contributors can recognise "this should be a bundle" when they hit a similar use case.

## Decision

### 1. The bundle JSON shape

Every bundle-shaped subcommand MUST emit a single JSON document whose root has these fields:

```
{
  "schema": 1,                            // version of the bundle envelope
  "generatedAt": "ISO 8601 timestamp",    // when the bundle was built
  …subcommand-specific fields…
  "exitCode": <0|1|2|…>                   // resolved exit code (informational duplicate of process exit)
}
```

The three load-bearing properties:

1. **`schema: 1`** — the envelope version. If we ever break the bundle shape (rename a field, change a type), we bump to 2 and downstream parsers can handle both forms. Without an envelope version, every consumer has to feature-detect.
2. **`generatedAt`** — ISO 8601 string. Required so a paste-into-issue bundle is timestamped (the maintainer reads the issue tomorrow; knowing the bundle is from yesterday is important context).
3. **`exitCode`** — same value as `process.exit()`. Required because some consumers see only the JSON output (e.g. piped to a file then mailed); duplicating the exit code into the bundle means the consumer doesn't lose information.

Subcommand-specific fields go in between. There is no required intermediate envelope — `diag` has `surface / verdict / kernel_version`, `export-config` has `mcpServers / claudeSettings`, `audit` has `level / counts / offenders`. Forcing a `data: { … }` wrapper would not buy anything.

### 2. Sanitisation is mandatory for any field that may carry user-typed strings

The bundle is meant to be pasted into public issues. Any field whose value the user controls — manifest vars, Claude settings, Codex config, env-var-style names in any of those — MUST be sanitised:

```
const REDACT_KEY_RE = /(secret|token|key|password|passphrase)/i;
```

Three iters of evidence:

- iter 90's bundle regex was `/^(secret|token|key|password|api[-_]?key)/i` — anchored, catches `secret_token` but not `OPENAI_API_KEY`.
- iter 97's export-config relaxed to `/(secret|token|key|password|passphrase)/i` — unanchored, catches `OPENAI_API_KEY`, `GITHUB_TOKEN`, `db_password`.
- iter 102's audit `--bundle` carries no user-typed strings, so no sanitisation needed.

The iter-97 form is now the canonical regex for any new bundle-shaped subcommand that carries user-typed values. The cost of over-redaction (a key named literally `notakey` redacts) is acceptable for an audit-share artefact; cost of leaking is high.

### 3. Errors are bundle-formed too

The bundle is the contract; consumers gating on `failCount` or `verdict` shouldn't crash on a bad-input case (missing manifest, malformed JSON, unknown level). Every bundle-shaped subcommand MUST emit JSON even on error, with an `error` field naming the cause:

```json
{ "schema": 1, "error": "no-manifest", "harnessDir": "/path" }
{ "schema": 1, "error": "unknown-level", "level": "bogus", "validLevels": ["info", …] }
```

iter 102's audit `--bundle` implements this explicitly; iter 90's diag `--bundle` does it implicitly (the no-manifest case still has a parseable `diag` block with `manifestKernelVersion: undefined`). Both shapes are acceptable; the rule is: **the bundle output is ALWAYS parseable JSON, never a human-text fallback.**

### 4. Exit code follows the verdict

`harness X --bundle > b.json && [ $? -eq 0 ]` MUST work as a CI gate. The exit code from the process must follow the underlying verdict (PASS = 0, WARN = 0 or 1 per the subcommand's semantics, FAIL = 1, malformed input = 2). It MUST NOT be silently swallowed because the user passed `--bundle`.

This is the difference between the bundle being a "snapshot" (advisory output) and being a "verdict" (CI gate). The 3 existing bundles all chose verdict semantics; we standardise on that.

### 5. The text mode stays unchanged

Adding `--bundle` to an existing subcommand MUST NOT change the text mode. Existing CI scripts grepping for `PASS:` / `FAIL:` keep working. The flag is purely additive.

This is the iter-102 implementation pattern:

```ts
if (bundle) {
  return { code, lines: [JSON.stringify({ schema: 1, …}, null, 2)] };
}
// ...existing text-mode logic unchanged...
```

### 6. Should we share a `bundle.ts` helper?

**Not yet.** ADR-030 alternative D's reasoning applies: at N=3 the duplication is small (each bundle's JSON shape is essentially `JSON.stringify({ ...subcommandSpecificFields, schema: 1, generatedAt, exitCode })`), and the shape may still evolve. Lifting the JSON header into a shared helper now would require all 3 callers to pass through it, which is more work than just copying 4 lines.

If a 4th bundle-shaped subcommand lands, revisit this decision. Concretely: when we ship `harness sbom --bundle` or `harness verify --bundle` (likely candidates), measure how much the duplication has grown. If we're up to ~12 duplicated lines per call site, that's the time to extract.

The cost of premature abstraction is higher than the cost of 3 nearly-identical small JSON literals.

## Consequences

**Good**:

- The next bundle-shaped subcommand has a 6-rule checklist instead of a "look at how iter 90 did it" suggestion. New contributors can implement bundle output without re-deriving the pattern.
- The schema-1 envelope means we can break the shape exactly once (bump to 2) and keep old consumers working through a transition.
- "Errors are bundle-formed too" means CI scripts gating on `--bundle` JSON output don't need a separate "did the command fail to even run?" code path.
- Sanitisation regex is documented; the iter-97 form (`/(secret|token|key|password|passphrase)/i`) is now the canonical version.

**Hurts**:

- Three subcommands now duplicate the schema-1 envelope. If we change the envelope (add a `tool: "diag" | "audit" | …` discriminator, say), we touch 3 files.
- The decision to NOT share a helper means a 4th bundle-shaped subcommand will copy 4 lines of boilerplate.
- The schema-1 envelope was implicitly chosen at iter 90; this ADR is documenting after the fact rather than designing forward. The envelope could be better.

## Alternatives Considered

**A) Skip this ADR; the 3 examples are documentation enough.** Considered. Rejected: future contributors looking for "how do I add `--bundle` to subcommand X?" need a single document, not a code-archaeology exercise across 3 subcommand sources. The cost of writing this ADR is low; the cost of every future bundle-shaped subcommand re-deriving the shape is high.

**B) Build the `bundle.ts` helper now.** Tempting. Rejected per section 6: at N=3 the duplication is small and the shape may still evolve.

**C) Drop the `exitCode` field from the JSON body.** The process exit code is already the canonical answer. Considered but rejected: a consumer reading `audit.json` from disk shouldn't have to look up the process-exit elsewhere. Duplicating is cheap; losing information when the JSON is mailed separately is not.

**D) Use a `data` wrapper:** `{ schema: 1, data: { … } }`. Considered. Rejected: forces every consumer to access `out.data.<field>` instead of `out.<field>`. The envelope fields (`schema`, `generatedAt`, `exitCode`) and the subcommand-specific fields don't collide in any of the 3 existing bundles; the unflattened shape is fine.

**E) Make the sanitisation regex configurable per call site.** Considered. Rejected: the regex tuning across iter 90 (anchored) → iter 97 (unanchored) was real engineering, and standardising on iter 97's form means future contributors don't repeat the iteration. If a future call site has a genuine reason to widen or narrow the regex, it can override locally.

## Test Contract

The architecture is shipped when ALL of these are green:

| # | Test | Pins |
|---|---|---|
| 1 | `__tests__/harness-diag.test.ts` "emits a complete SupportBundle JSON" | iter 90 bundle has schema/generatedAt/exit-code shape |
| 2 | `__tests__/harness-diag.test.ts` "sanitises secret-like keys" | iter 90 sanitisation runs |
| 3 | `__tests__/harness-export-config.test.ts` "emits a parseable JSON" | iter 97 bundle shape |
| 4 | `__tests__/harness-export-config.test.ts` "redacts secret-like keys" | iter 97 sanitisation runs with the canonical regex |
| 5 | `__tests__/harness-audit-bundle.test.ts` "emits parseable JSON on no-package-json error" | iter 102 errors-are-bundle-formed |
| 6 | `__tests__/harness-audit-bundle.test.ts` "non-bundle mode produces text output, not JSON" | iter 102 text mode unchanged |

A future PR adding a 4th bundle-shaped subcommand should add its own pin for each of the 6 rules above (or skip the irrelevant ones — audit has no sanitisation because it carries no user-typed strings).

## References

- iter 90 — `harness diag --bundle` shipped (rule 1, 2, 4)
- iter 91 — Propagation across user-facing surfaces (ADR-030 step 2)
- iter 93 — `harness doctor` recommends the bundle on FAIL (ADR-030 step 4)
- iter 97 — `harness export-config` shipped (rule 2 canonical regex; rule 5 implicit)
- iter 102 — `harness audit --bundle` shipped (rule 3 explicit errors-are-JSON; rule 5 text mode unchanged)
- ADR-030 — The Discovery Loop (5-step propagation; alt D "wait for N=3+")
- ADR-028 — Skew Detection and Liveness (parallel "one HTTP probe, many surfaces" architecture)
