# ADR-010: TDD Test Contracts

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: every other ADR

## Context

Each prior ADR ends with a Test Contract section enumerating what tests must exist for the decision to be considered shipped. This ADR collects those into a single, coherent strategy: which tests live at which level, which testing style we use, what coverage we promise, and what makes a test contract "satisfied" vs "deferred."

The user prompt asked for "TDD-driven" and "London-school as default." This ADR pins both down concretely.

## Decision

### Three test levels, three test styles

We organise tests in three concentric levels, each with its dominant style.

```
                     ┌──────────────────────────────────────────┐
   Outer ring        │   End-to-end / real-host smoke           │
   (a few per host)  │   Style: integration, real artefacts      │
                     │   Runs: nightly + pre-release             │
                     └──────────────────────────────────────────┘
                                       │
                     ┌──────────────────────────────────────────┐
   Middle ring       │   Integration / contract tests           │
   (many per pkg)    │   Style: real package boundaries,        │
                     │           mocked external deps           │
                     │   Runs: every PR                          │
                     └──────────────────────────────────────────┘
                                       │
                     ┌──────────────────────────────────────────┐
   Inner ring        │   Unit tests                              │
   (most numerous)   │   Style: London-school (mock-driven)     │
                     │           with classicist style where    │
                     │           collaboration is incidental    │
                     │   Runs: every PR                          │
                     └──────────────────────────────────────────┘
```

The pyramid is conventional. The interesting parts are the style choices.

### Inner ring — London-school unit tests

Default for new code in the kernel and the generator. London-school (mockist) TDD pattern: tests describe collaborations between objects via mocks. A `MemoryStore` unit test mocks the `AgentDB` it uses and asserts the interaction. A `Composer` unit test mocks the `Prompt` it uses and asserts the dialogue.

The discipline:

1. **Outside-in.** A test describes the interaction at the outermost layer first (the API the caller will use). The implementation is filled in to satisfy the test.
2. **Mocks at boundaries.** Each object's collaborators are mocked. The system-under-test (SUT) is observed only via its outputs and via the mock's recorded calls.
3. **Test-doubles describe contracts.** The mock is the contract spec for the dependency. The dependency's real implementation must satisfy what the mock asserts.

When to deviate to classicist (Detroit-school) style — assertions on state rather than interactions:

- Pure data transformations (a JSON parser, a hash function).
- Algorithm implementations where the right-vs-wrong assertion is on the output, not the path.
- Memory layer 2-4 (decay math, quantization round-trip, HNSW recall) — observation-of-output is the right test.

The rule of thumb: if you want to mock the collaborator, London. If the collaborator is conceptually a value (a SHA, a vector, a boolean), classicist.

Reference: Steve Freeman & Nat Pryce, *Growing Object-Oriented Software, Guided by Tests* (Addison-Wesley 2009) — the canonical London-school text. Ruflo already names this convention in its existing `CLAUDE.md` ("TDD London School (mock-first) preferred").

### Middle ring — Integration and contract tests

Two kinds; we keep them separate.

#### Integration tests

Real package boundaries; mocked external dependencies (network, model API, filesystem outside a sandbox). Example: a test that the generator (a real instance of `create-agent-harness`) calls the renamer (a real instance), which calls the manifest writer (a real instance), and the resulting tree on a sandboxed tmpdir is correct.

Tooling: `vitest`. Real filesystem via `node:fs/promises` against a `os.tmpdir()` directory. Network mocks via MSW (https://mswjs.io/) for HTTP and a stub stdio MCP server for MCP.

#### Contract tests

A test that the public API of a package satisfies a contract another package expects. Example: the `HostAdapter` interface from ADR-004 has six methods; a contract test for each implementation (`@metaharness/host-claude-code`, `@metaharness/host-codex`, etc.) asserts each method behaves to the contract.

The contract test fixture lives once, in the kernel. Each adapter package imports and runs it. The pattern is the standard "shared contract tests" pattern (https://martinfowler.com/bliki/ContractTest.html, Fowler 2011).

```ts
// In @metaharness/kernel/hosts/contract.test-kit.ts (shipped, not just for tests)
export function runHostAdapterContractTests(adapter: HostAdapter, ctx: TestContext) {
  describe(`HostAdapter contract — ${adapter.hostId}`, () => {
    it('declares valid capabilities', () => { ... });
    it('generateConfig produces schema-valid output', () => { ... });
    // ... 12 more contract tests ...
  });
}

// In @metaharness/host-claude-code/test/contract.test.ts
import { runHostAdapterContractTests } from '@metaharness/kernel/hosts/contract.test-kit';
import { ClaudeCodeAdapter } from '../src';
runHostAdapterContractTests(new ClaudeCodeAdapter(), defaultContext);
```

This is the same kit pattern Babel uses for plugins; it is the only mechanism we have seen that keeps contract tests in sync across many implementations.

### Outer ring — End-to-end / real-host smoke

A small number of tests that run against real artefacts: real Claude Code CLI installed, real Codex CLI installed, real npm publish dry-run with real OIDC token, real IPFS gateway fetch.

These are expensive. We run them nightly and pre-release, not on every PR. PR-time smoke tests use stubs of the same shape (so the failure mode is the same; the only difference is whether the gate is hit).

Tooling: `vitest` invoking the real CLIs via `execa`. Reference fixtures in `tests/e2e/fixtures/`.

The outer ring includes ADR-001 §Test Contract canaries:

- The trivial harness ("3 agents, Claude Code, no plugins").
- The exotic harness ("federation + multi-host + custom DISTILL").

Both run on the outer ring nightly.

### Per-phase test contract (cross-reference)

Each phase from ADR-001 has its own contract. Quick cross-reference:

| Phase | Test surface introduced | Lives in |
|---|---|---|
| Phase 0 — Kernel extraction | Static checks (import-boundary, API-surface freeze); London-school units for every kernel subsystem; the test harness as integration canary | `packages/kernel/test/`, `packages/test-harness/` |
| Phase 1 — Generator MVP | Composer state machine units; renamer round-trips; trivial-harness end-to-end; smoke contract | `packages/create-agent-harness/test/`, `tests/e2e/trivial-harness/` |
| Phase 2 — Multi-host | Per-host contract test kit; real-host smoke nightly; capability-gating UI snapshot | `packages/host-*/test/`, `tests/e2e/multi-host/` |
| Phase 3 — Composer | Catalogue-picker integration; `--from-existing` end-to-end | `packages/create-agent-harness/test/composer/`, `tests/e2e/from-existing/` |
| Phase 4 — Marketplace | Plugin scaffold/publish end-to-end; signature verification; signal refresh | `packages/kernel/test/marketplace/`, `tests/e2e/publish-flow/` |
| Phase 5 — Self-evolution + federation | Cross-host memory continuity; federated multi-instance; learning-loop convergence on a fixed corpus | `tests/e2e/federation/`, `tests/e2e/self-evolution/` |
| Phase 6 — Vertical packs | Vertical pack contract test (every pack passes the kernel's intelligence-pipeline contract test); pack scenario tests | `packages/vertical-packs/*/test/`, `tests/e2e/verticals/` |

### TDD discipline rules

We follow the canonical red-green-refactor TDD cycle for new code:

1. **Red.** Write the failing test first.
2. **Green.** Write the minimum code that makes it pass.
3. **Refactor.** Improve the code with the tests as a safety net.

The rule for exceptions:

- **Spike code** is allowed without tests (a quick exploration to understand a problem). Spike code is deleted before merge; the real code is written test-first.
- **Bug fixes** must start with a failing test that reproduces the bug. The test stays as a regression guard.
- **Performance work** must start with a measurement that demonstrates the regression or improvement, kept as a perf-test.

These rules are enforced by review, not by CI (a CI gate that "did you TDD" is impossible to write well). Code review checklist (ADR-007 §A1 lint pass; CODEOWNERS review) calls out the discipline. The cost of skipping it is paid in the next refactor.

### Coverage targets

The coverage targets are minimums:

| Package | Statement coverage | Branch coverage |
|---|---|---|
| `@metaharness/kernel/*` | 85% | 80% |
| `@metaharness/create-agent-harness` | 80% | 75% |
| `@metaharness/host-*` | 75% | 70% |
| `@metaharness/catalogue` | 70% (content-heavy) | 65% |
| `@metaharness/vertical-packs/*` | 70% | 65% |

CI enforces these (ADR-007 §A4). PRs that drop below the floor are blocked.

Coverage is not the goal — confidence is the goal. Coverage is the proxy we measure because it is the only proxy we can. The classic warning: "100% coverage with zero asserts is worse than 60% coverage with crisp asserts." Code review enforces the asserts; CI enforces the floor.

### What we do NOT promise

- **No mutation testing** in v1.0. Mutation testing (Stryker, https://stryker-mutator.io/) catches the "100% coverage with zero asserts" failure mode at scale. We have not adopted it because the perf cost on a large test suite is significant. A later ADR can add it if we measure that it would have caught real bugs.
- **No property-based testing as default.** A few specific packages (the renamer, the quantization layer, the HNSW index) get property-based tests via `fast-check` (https://github.com/dubzzz/fast-check) because the input space is well-formed. Everywhere else, example-based tests are the default.
- **No fuzzing as part of the standard PR gate.** We run fuzzers on the renamer and the registry parser, but those run on a slower cadence (weekly, with results triaged).

### When London-school is wrong

London-school is the default, not the law. We have seen test suites where the mock layer became the design — tests describe an architecture the code does not have. Smells to watch for:

- A test that mocks five collaborators and asserts the order of calls between them. The unit is too coarse; split.
- A test that mocks a value type. Wrong style; use classicist.
- A test that exists only to assert "this mock was called." No outcome being verified; deletable.

Code review flags these. They are the symptoms ADR-010 enforcement watches for.

### TDD for the ADR set itself

This ADR set is, in itself, the test contract for the project. Every ADR's §Test Contract section is a checklist; satisfying each is the definition of "the ADR is shipped." When implementers begin coding against the ADR set, they write the contracts from each §Test Contract first, then implement.

This is the meta-claim of the TDD discipline: the ADRs are red; the implementation will be green; the marketplace and self-evolution and federation are the refactors.

## Consequences

### What gets easier

- **The "should I write this test?" question has a default answer.** London-school for collaboration-driven code, classicist for value-driven code. The pyramid level depends on what is being tested.
- **Cross-package contract drift is caught early.** A host adapter that breaks the kernel's contract test kit fails its own CI before the kernel notices.
- **Code reviewers have a common vocabulary.** "This should be a London-school unit" / "This is the classicist case" / "This is contract, not unit."

### What gets harder

- **Discipline has a cost.** TDD-as-default costs time on green code that does not exist yet. The payoff is in the refactor and in the test-as-documentation. We accept the cost.
- **The contract test kit pattern adds a layer.** A new kernel subsystem needs both its own tests and a kit that adapters use. We commit to keeping the kit pattern small (one file, ~200 lines per subsystem).
- **Coverage floors push back against quick PRs.** A trivial change that drops coverage by 0.5% blocks the PR. We tolerate this; the alternative is suite rot.

### What does not change

- The ruflo team already uses London-school for new code (per existing `CLAUDE.md`). This ADR formalises the practice; it does not introduce a new convention.

## Alternatives Considered

### Alternative 1: Classicist-only

All tests are state-based assertions; no mocks. Rejected because (a) it does not scale to systems with significant collaboration (the kernel's hooks runtime, the routing system), (b) it tends to test integration rather than unit (every test exercises real collaborators), and (c) ruflo's existing convention is London-school.

### Alternative 2: London-school-only

Reject all classicist style. Rejected because pure data transformations (a renamer's identifier substitution, a quantization round-trip) are over-mocked under London style. The hybrid rule above is the right rule.

### Alternative 3: 100% coverage requirement

Reject because it incentivises the worst kind of tests (assertion-less coverage padding). 85%/80% floors with reviewer discretion to insist on the meaningful tests is a better trade.

### Alternative 4: Property-based as default

Rejected because the cost of writing good shrinkers and generators is real, and the productivity payoff is concentrated in the data-transformation layers (renamer, quantization, HNSW). Specific packages get property-based tests; everywhere else, example-based is the default.

### Alternative 5: No contract test kit; each adapter writes its own tests

Rejected because the host-adapter contract is precisely the kind of cross-implementation invariant a kit captures best. Without it, adapters drift; with it, the kernel maintainers can change the contract once and every adapter's CI tells them what broke.

## Test Contract

This ADR is satisfied when the following exist:

### Tooling

1. **A `vitest` configuration** for each package, all sharing `vitest.workspace.ts` so a single `npm test` runs the union.
2. **`fast-check` available** in the packages that use property-based tests (kernel/memory, create-agent-harness/renamer).
3. **MSW configured** for HTTP mocking; a stub stdio MCP server fixture for MCP mocking; a stub Claude Code CLI / Codex CLI fixtures for host smoke tests.

### Coverage gates

4. **`vitest --coverage`** runs in CI and enforces the targets above.
5. **A coverage trendline dashboard** in the repo (markdown + auto-updated badges) so coverage regressions are visible across releases.

### Contract test kits

6. **`@metaharness/kernel/hosts/contract.test-kit`** — shipped, imported by every host adapter's test.
7. **`@metaharness/kernel/marketplace/contract.test-kit`** — shipped, imported by every plugin's test scaffold.
8. **`@metaharness/kernel/memory/intelligence-contract.test-kit`** — shipped, imported by every vertical pack's intelligence-provider test.

### Outer-ring infrastructure

9. **A `tests/e2e/` directory** with real-host fixtures, runnable via `npm run test:e2e`. Skipped on PRs by default; required on nightly.

### Documentation

10. **A `docs/testing-guide.md`** that captures the London/classicist guidance and the smell list above. Linked from every package's contributing notes.

## References

### Ruflo internals cited

- `CLAUDE.md` §TDD London School — the existing convention this ADR formalises.

### External prior art

- Steve Freeman & Nat Pryce, *Growing Object-Oriented Software, Guided by Tests*, Addison-Wesley 2009 — the canonical London-school text.
- Martin Fowler, "Contract Test" pattern, https://martinfowler.com/bliki/ContractTest.html.
- Martin Fowler, "Mocks Aren't Stubs," https://martinfowler.com/articles/mocksArentStubs.html — the original London-vs-classicist articulation.
- Vitest: https://vitest.dev/.
- fast-check (property-based testing): https://github.com/dubzzz/fast-check.
- MSW (HTTP mocking): https://mswjs.io/.
- Stryker (mutation testing, deferred): https://stryker-mutator.io/.

### Ruflo ADRs cited

- Every other ADR in this set — each has a §Test Contract this ADR aggregates.
