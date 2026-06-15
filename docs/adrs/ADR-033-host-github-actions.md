# ADR-033: GitHub Actions as a Harness Host

**Status**: Implemented (iter 146 — `@metaharness/host-github-actions` package shipped; HOSTS-catalog propagation tracked separately)
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-004 (host integration model), ADR-022 (MCP as gated primitive), ADR-030 (Discovery Loop propagation for new hosts), ADR-007 (CI guards)

## Context

The six existing host adapters (Claude Code, Codex, pi.dev, Hermes, OpenClaw, RVM) are all **interactive**: a human initiates a session, the agent loop runs, and the human sees the result. GitHub Actions is different in kind. It is a CI/CD runtime: no human at the keyboard; execution is triggered by a webhook (push, PR open, issue comment, schedule); the "operator" is the GitHub Actions runner; the harness must complete a task autonomously, emit structured output, and exit cleanly.

That difference is exactly the point. There is a category of agentic task that does not belong in an interactive session:

- Triaging issues filed in the last 24 hours and applying labels
- Drafting release notes from merged PRs since the last tag
- Running the harness genome against every incoming PR and posting the result as a commit status
- Nightly fleet checks that scan a repository for stale harness versions and open a report issue
- Auto-responding to `/harness` commands in issue comments with a capability summary

These tasks are repetitive, well-defined, and do not need a human to start them. They are the right shape for a CI/CD job. They are not well served by the existing hosts, which all expect an interactive terminal session or a persistent background runtime.

This ADR is a **proposal**. It documents the design for `@metaharness/host-github-actions` and registers the decision. Implementation is deferred to a future iteration. Status is `Proposed` pending acceptance and a milestone.

## Decision

### 1. Why GitHub Actions specifically?

GitHub Actions is where the harness's source code already lives (ADR-007 defines the CI guards the project itself runs there). Adding a GHA host means a team can use the same tool that governs the harness's own release pipeline to add agentic behaviour to their project's pipeline — a natural extension of the "meta" character of this project.

Concretely, the combination of `GITHUB_TOKEN` + GitHub's built-in Actions runner gives the harness:

- **Repository write access** (label issues, comment, create PRs, push branches) scoped exactly to the `permissions:` block the workflow author writes — no credential management beyond the workflow.
- **Triggered execution** — the job fires on exactly the events the author specifies; there is no polling loop in application code.
- **Reproducible environment** — `ubuntu-latest`, Node 22, consistent `npm ci`; no "works on my machine."
- **Free tier for public repos** — no marginal cost for simple triage or analysis tasks.

The alternative (running the harness as a persistent background agent that polls GitHub's API) requires always-on infrastructure, a separate credential, and a re-implementation of the event routing that Actions already provides. GitHub Actions is the cheaper primitive for this class of task.

### 2. Integration shape: composite action or JS/Docker action?

The harness ships as a **reusable composite action**. A JavaScript action or Docker action requires publishing to the Marketplace and maintaining a separate dist folder; a composite action is a directory in the repository and requires no publishing step:

```
.github/
  actions/
    <harness-name>/
      action.yml       # composite action manifest
  workflows/
    <harness-name>.yml # the default trigger workflow
```

The composite action wraps the harness's entry point:

```yaml
# .github/actions/<harness-name>/action.yml
name: '<harness-name>'
description: 'Run the <harness-name> agent harness'
inputs:
  task:
    description: 'The task for the agent to perform'
    required: true
  dry-run:
    description: 'If true, print proposed actions but do not execute them'
    required: false
    default: 'false'
outputs:
  result:
    description: 'The agent result as a JSON string'
    value: ${{ steps.run.outputs.result }}
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: '22'
        cache: 'npm'
    - run: npm ci
      shell: bash
      working-directory: ${{ github.action_path }}
    - id: run
      run: |
        node bin/<harness-name>.mjs "${{ inputs.task }}" \
          --gha-mode \
          --dry-run "${{ inputs.dry-run }}"
      shell: bash
      working-directory: ${{ github.action_path }}
      env:
        GITHUB_TOKEN: ${{ env.GITHUB_TOKEN }}
        HARNESS_MEMORY_PATH: ${{ runner.temp }}/harness-memory
```

The `--gha-mode` flag tells the kernel to suppress interactive prompts, write all output to stdout as JSON lines, and exit with `0` on success / `1` on agent failure / `2` on harness-level error. The `HARNESS_MEMORY_PATH` env var points to the runner's ephemeral temp directory — memory persists within a single job but not across jobs (see §6 on persistent memory).

### 3. What problem does this solve: bot-like CI behaviour

The canonical GHA harness use cases, ranked by implementation readiness:

| Use case | Trigger | What the harness does |
|---|---|---|
| Issue triage | `issues: [opened]` | Labels the issue, assigns a severity, drafts a one-line triage comment |
| PR genome report | `pull_request: [opened, synchronize]` | Runs `harness validate` against the PR's changed files, posts result as a commit status |
| Release notes draft | `push: tags: ['v*']` | Reads merged PRs since the last tag, drafts CHANGELOG entry, opens a draft release |
| Nightly harness audit | `schedule: cron: '0 3 * * *'` | Runs `harness audit` across the repo, opens an issue if HIGH findings exist |
| Issue command handler | `issue_comment: [created]` with body matching `/harness .*` | Responds to the comment with a capability summary or delegates the command to the agent loop |

All five are plausible on day one of a GHA harness implementation. The generator asks which use cases the user wants and generates the corresponding workflow trigger blocks.

### 4. MCP under GHA: default-deny equivalent

The default-deny posture (ADR-022) is conceptually preserved in the GHA context, but the enforcement mechanism shifts from the in-process `mcp-policy.json` gate to the **workflow's own permission model**:

- **`permissions:` block.** The workflow author sets the minimum required GitHub permissions:

  ```yaml
  permissions:
    issues: write         # for labelling and commenting
    pull-requests: write  # for posting PR status
    contents: read        # for reading the repository
    # contents: write only if the harness needs to push branches
  ```

  GitHub Actions' OIDC-backed `GITHUB_TOKEN` is scoped exactly to what is listed. A harness that does not declare `contents: write` cannot push, regardless of what the agent tries. The token is the enforcement boundary.

- **`mcp-policy.json` still ships** and is still enforced by the in-process policy gate. Under GHA, `allowShell` defaults to `false` (the harness should not be running arbitrary shell commands — the runner's environment is the shell). `allowNetwork` defaults to `false` except for the specific GitHub API calls the harness needs (those go through the `@octokit/rest` tool rather than a raw `fetch`). `allowFileWrite` is scoped to the runner's `$RUNNER_TEMP`.

- **Environment protection rules.** For workflows that touch production (e.g., pushing a release branch), the workflow is gated by a GitHub Environment with required reviewers. The adapter generates a comment in the workflow file pointing at this setting.

- **`harness mcp-scan` works as-is.** The same scan that flags `allowShell: true` in an interactive harness flags it here. The CI guards (ADR-007) run `mcp-scan` on every PR that touches the workflow or policy files.

The net effect: a GHA harness cannot do more than `GITHUB_TOKEN` + `mcp-policy.json` together permit, which is narrower than what an interactive harness can do. This is a privilege reduction, not a relaxation.

### 5. The host adapter package: `@metaharness/host-github-actions`

Package skeleton:

```
packages/host-github-actions/
  package.json                 # peerDependencies: @metaharness/kernel ^1.x, @octokit/rest ^21
  src/
    index.ts                   # exports GHAHostAdapter : HostAdapter
    capabilities.ts            # HostCapabilities
    config-generator.ts        # generateConfig() — writes action.yml + workflow YAML
    workflow-builder.ts        # builds the .github/workflows/<name>.yml from use-case selections
    runner-script.ts           # generates bin/<harness>-gha.mjs (the entry point inside the action)
    mcp-registration.ts        # registerMcp() — produces instructions (GHA: env var injection)
    post-processor.ts          # postProcessAgentOutput() — wraps output as GITHUB_OUTPUT lines
    smoke.ts                   # smokeTest() — dry-runs the action.yml schema parse
    tools/
      github-api.ts            # @octokit/rest wrapper as a governed MCP tool
      github-issues.ts         # issue CRUD tools
      github-prs.ts            # PR CRUD tools
      github-releases.ts       # release draft tools
  __tests__/
    capabilities.test.ts
    config-generator.test.ts
    workflow-builder.test.ts
    runner-script.test.ts
    smoke.test.ts
```

**`HostCapabilities` for `@metaharness/host-github-actions`:**

```ts
{
  hostId: 'github-actions',
  capabilities: {
    supportsMcp:              'none',    // the harness is the only process; no external MCP client
    supportsHooks:            'kernel-side-only',
    supportsThinkingBlocks:   false,     // model is chosen by the harness config, not the host
    supportsBackgroundAgents: false,     // the runner is the job; no background agent spawning
    supportsToolCallApi:      'native',  // the harness calls the model directly; no host in the loop
    defaultProviderModels: {
      tier1: undefined,
      tier2: 'claude-haiku-4-5',         // or whatever the kernel's tier-2 default is at build time
      tier3: 'claude-sonnet-4-7'
    },
    configFileFormat:     'yaml',
    configFileLocation:   '.github/workflows/<harness-name>.yml',
    hostInstructionsFile: null           // no persistent instructions file; task is passed as input
  }
}
```

Note `supportsMcp: 'none'`. In the GHA context, the harness IS the entire process. There is no external MCP client to connect to the harness's MCP server — the harness calls its own tools internally via the kernel's tool registry directly. The MCP server binary still exists (so a multi-host harness that includes `github-actions` alongside `claude-code` compiles without changes), but under GHA it is never started.

**What gets stamped into `.harness/manifest.json`:**

```json
{
  "hosts": [
    {
      "hostId": "github-actions",
      "workflowPath": ".github/workflows/<harness-name>.yml",
      "actionPath": ".github/actions/<harness-name>/action.yml",
      "defaultTriggers": ["issues", "pull_request", "schedule"]
    }
  ]
}
```

### 6. The generated workflow YAML

The adapter generates a default workflow for each selected use case. The structure for the most common trigger (issue triage):

```yaml
# .github/workflows/<harness-name>.yml
# Generated by @metaharness/host-github-actions — do not edit header.
# Schema: harness-workflow-v1
# Harness: <harness-name> | Kernel: @metaharness/kernel ^1.x
# To update this workflow, run: harness regen --host github-actions

name: '<harness-name> agent'

on:
  issues:
    types: [opened, reopened]
  workflow_dispatch:
    inputs:
      task:
        description: 'Override task for manual runs'
        required: false

permissions:
  issues: write
  contents: read

jobs:
  run-harness:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: ./.github/actions/<harness-name>
        id: harness
        with:
          task: |
            Triage the issue #${{ github.event.issue.number }}:
            Title: ${{ github.event.issue.title }}
            Body: ${{ github.event.issue.body }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Post result as comment
        if: steps.harness.outputs.result != ''
        uses: actions/github-script@v7
        with:
          script: |
            const result = JSON.parse('${{ steps.harness.outputs.result }}');
            if (result.comment) {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body: result.comment
              });
            }
```

The `workflow_dispatch` trigger is always included — it allows manual runs from the GitHub UI without needing to open a real issue. This is the primary testing path.

**Default schedule** for nightly use cases:

```yaml
on:
  schedule:
    - cron: '0 3 * * *'    # 03:00 UTC — low-traffic window
  workflow_dispatch: {}
```

The adapter generates the cron expression with a comment explaining the UTC time; the user adjusts the schedule to their timezone preference.

### 7. Generated file layout

An interactive Claude Code harness primarily emits `src/agents/*.ts`. A GHA harness emits a different file tree:

```
<harness-root>/
  .github/
    actions/
      <harness-name>/
        action.yml          # composite action manifest
    workflows/
      <harness-name>.yml    # trigger workflow (one per use case, or combined)
  bin/
    <harness-name>-gha.mjs  # headless runner entry point (node --input-type=module)
  src/
    agents/
      gha-agent.ts          # the agent loop, headless variant
    tools/
      github-issues.ts      # governed GitHub API tools
      github-prs.ts
      github-releases.ts
    mcp/                    # present for multi-host parity; not started under GHA
      server.ts
      tools.ts
      policy.ts
  .harness/
    manifest.json           # host: github-actions stamped
    mcp-policy.json         # default-deny; allowShell: false; allowNetwork: false
```

The `gha-agent.ts` is a stripped-down agent loop: no readline prompt, no spinner, output written to `$GITHUB_OUTPUT` and stdout as JSON lines. The kernel's memory bridge points to `$RUNNER_TEMP/harness-memory/` for ephemeral within-job storage.

**Persistent memory across jobs.** The runner's temp directory is wiped at job end. For use cases that need memory across runs (e.g. the nightly audit that should not re-flag issues it already flagged), the adapter offers two opt-in strategies:

1. **Commit-to-branch** — the harness writes its memory to a dedicated branch (`harness/memory`) via `git push`. Simple; auditable; creates commit history noise. Generated as a post-step in the workflow.
2. **GitHub Cache** — use `actions/cache@v4` keyed on `harness-memory-${{ hashFiles('.harness/manifest.json') }}`. Faster; not auditable as git history. Generated as a pre/post step pair.

Both are opt-in at generation time. The default is ephemeral-only (no persistence across jobs), which is safe and sufficient for stateless tasks.

### 8. Open question: standalone local execution?

Should the GHA harness also be runnable standalone — `npx <harness-name> --task "..." ` from a developer's laptop — or strictly as a CI artifact?

**Arguments for standalone:**

- Developers want to test the harness logic before pushing it to CI. A `workflow_dispatch` trigger provides this via the GitHub UI, but not locally.
- The harness's kernel already runs locally; the `gha-agent.ts` headless loop is just a different entry point. The effort to wire a `--gha-mode` flag on the existing `bin/` entry is small.
- A standalone mode lets the harness be driven from Claude Code (another host), Codex, or a script — making it composable with the other hosts in a multi-host harness.

**Arguments against:**

- A standalone mode creates a second test surface. Every CI assumption (e.g. `GITHUB_TOKEN` is present) must be mocked locally.
- The GHA harness's tools are GitHub-API-bound (`github-issues.ts`, `github-prs.ts`). Locally they need a PAT with the right scopes. This is a legitimate credential-management burden.
- Mixing CI semantics (exit 0 / 1 as CI verdict) with interactive semantics (interactive agent loop) in one binary is a surface-area risk.

**Recommendation: yes, support standalone, but as an opt-in second entry point.**

The adapter generates `bin/<harness-name>-gha.mjs` (always — the CI entry point) and optionally `bin/<harness-name>.mjs` (only when the user confirms they want local testing). The local entry point wraps the same `gha-agent.ts` but uses environment-variable injection rather than `$GITHUB_TOKEN` secrets, and prompts for missing credentials rather than exiting with an error.

This preserves the CI/CD-first character of the GHA host (the `gha.mjs` entry point is the canonical artifact) while giving developers the local test path they will want during development.

## Consequences

### What gets better

- The harness gains a CI/CD execution model. Agentic tasks that should run automatically on schedule or on events now have a first-class home.
- Teams using this project can automate issue triage, PR analysis, and release drafting from the same harness codebase they interact with in Claude Code or Codex — same kernel, same memory (if they opt into persistence), same policy layer.
- The `permissions:` block + `mcp-policy.json` combination means the GHA harness has a narrower attack surface than the interactive hosts. The host architecture (ADR-004) gives "narrower capability" as a first-class outcome.

### What gets harder

- **Model API keys in CI.** Unlike Copilot (GitHub auth) or Claude Code (local env var), the GHA harness needs `ANTHROPIC_API_KEY` (or equivalent) in GitHub Actions secrets. The adapter generates the `env:` block and documents the secret setup; the key still has to exist. This is a deployment concern, not an architecture concern, but it is a real user hurdle.
- **Cost visibility.** A harness firing on every `issues: [opened]` event at $0.003–$0.015 per invocation (tier-3 model) could accrue unexpected spend on a busy public repo. The adapter generates a `timeout-minutes: 15` budget guard and documents a recommended `concurrency:` group to prevent parallel flood. Operators should also configure a GitHub Actions spending cap in their org settings.
- **Debugging headless failures.** When a GHA job fails, the developer has CI logs rather than an interactive session. The `gha-agent.ts` loop emits structured JSON log lines so failures are parseable; the adapter generates a `harness diag --bundle` step that runs on job failure and attaches the bundle as a GitHub Actions summary artifact.
- **No hot-reload / interactive refinement.** An interactive harness can be told "try again differently." A GHA job cannot. The agent loop must be robust to single-pass failures; the adapter generates conservative retry limits (`maxRetries: 2`) and hard-exits on the agent getting stuck rather than looping.

### What does not change

- The kernel is untouched.
- The six existing host adapters are unchanged.
- `src/mcp/*` is generated as usual for multi-host harnesses; under GHA it is present but not started.
- ADR-022's `harness mcp-scan` gate works without modification.
- ADR-007's CI guards apply to the generated workflow files — the `mcp-scan` and `harness validate` steps run in CI on the generated harness.

## Alternatives Considered

### Alternative A: Ship a reusable JavaScript action (not composite)

A JS action (`action.js` + `node_modules` committed, or `dist/` with `ncc`) is the most portable GitHub Actions form — it runs on every runner OS without `actions/setup-node`. Rejected for the initial implementation because: (a) committing `node_modules` is distasteful and `ncc` adds a build step; (b) composite actions are simpler and fully functional for this use case; (c) a JS action would require a separate dist-versioning strategy that the composite action avoids. If portability to Windows runners or macOS runners becomes a priority, the adapter can generate a JS action variant — this is a backwards-compatible addition.

### Alternative B: Ship a Docker action

A Docker action packages the harness and its dependencies hermetically; no Node version management. Rejected because: (a) Docker actions are slower to start on GitHub-hosted runners; (b) maintaining a Dockerfile per harness is more surface area than a composite action; (c) Docker actions do not run on macOS runners (GitHub restriction). A Docker action could be a future `sub-mode` for GHA (like `extension` for Copilot), but is not the default.

### Alternative C: Use a generic webhook receiver instead of GHA

A persistent server that receives GitHub webhook events and triggers the harness loop. This is what existing "GitHub bots" like Probot do. Rejected because it requires always-on infrastructure, a credential with broad webhook receive scope, and a re-implementation of the trigger and scheduling logic that GitHub Actions provides for free. The GHA harness is the zero-infrastructure path to the same outcome.

### Alternative D: Reuse the existing headless Claude Code harness in CI

Run `claude -p "..." --dangerously-skip-permissions` inside a GHA job, using the existing Claude Code harness. Already possible today without this ADR. Rejected as the default path because: it gives no structured output format, no `GITHUB_OUTPUT` wiring, no tool catalogue scoped to GitHub API operations, no `mcp-policy.json` policy gate at runtime, and no manifest stamp. The GHA host adapter provides all of these in a governed, generated form. Users who specifically want the `claude -p` pattern can still do it; they just don't need this adapter.

## Test Contract

This ADR is satisfied when the following exist:

| # | Test | Pins |
|---|---|---|
| 1 | `capabilities.test.ts` — adapter's `capabilities` object satisfies the `HostCapabilities` Zod schema | Adapter contract (ADR-004) |
| 2 | `config-generator.test.ts` — `generateConfig()` emits `action.yml` with correct `runs.using: composite` and `inputs.task` defined | action.yml shape |
| 3 | `workflow-builder.test.ts` — issue-triage trigger emits `on.issues.types: [opened, reopened]` + `permissions.issues: write` | Trigger shape |
| 4 | `workflow-builder.test.ts` — schedule trigger emits a `cron:` field and a `workflow_dispatch:` block | Schedule shape |
| 5 | `workflow-builder.test.ts` — generated workflow always includes `timeout-minutes: 15` | Cost guard |
| 6 | `runner-script.test.ts` — `gha-agent.ts` writes output to `GITHUB_OUTPUT` env var format (`key=value%0A`) | Output contract |
| 7 | `runner-script.test.ts` — agent exits 0 on success, 1 on agent error, 2 on harness-level error | Exit code contract |
| 8 | `smoke.test.ts` — `smokeTest()` passes when `action.yml` is valid YAML with required fields; fails with descriptive error when `action.yml` is missing | Smoke contract |
| 9 | `harness-manifest.test.ts` (integration) — a generated harness with `host: github-actions` stamps `hostId: "github-actions"`, `workflowPath`, and `actionPath` into `.harness/manifest.json` | Manifest stamp |
| 10 | `mcp-scan.test.ts` (existing) — a GHA harness with default policy scans clean (exit 0); a GHA harness with `allowShell: true` is flagged HIGH (exit 1) | Policy gate (ADR-022 reuse) |
| 11 | `github-api-tool.test.ts` — the governed `github-issues.ts` tool is denied when `GITHUB_TOKEN` env is absent; returns a structured error object, not a thrown exception | Tool-level error surface |

## References

1. **GitHub Actions documentation (composite actions)** — https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-composite-action (as of 2026-01)
2. **GitHub Actions `permissions:` block** — https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token (as of 2026-01)
3. **GitHub Actions environment protection rules** — https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment (as of 2026-01)
4. **`GITHUB_OUTPUT` environment file protocol** — https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/passing-information-between-jobs (as of 2026-01)
5. **`actions/github-script` (Octokit in workflows)** — https://github.com/actions/github-script (as of 2026-01)
6. **GitHub Actions concurrency and cost controls** — https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs (as of 2026-01)
7. **Probot (the webhook-receiver alternative)** — https://probot.github.io/ (as of 2026-01; cited as the rejected Alternative C)
8. ADR-004 — Host integration model (the contract `@metaharness/host-github-actions` must implement)
9. ADR-007 — CI guards (the guards that run on the generated workflow files)
10. ADR-022 — MCP as a gated primitive (policy layer unchanged in GHA context)
11. ADR-030 — The Discovery Loop (propagation steps when this host ships)
