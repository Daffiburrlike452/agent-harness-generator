# ADR-015: Naming + Branding Policy

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-001 (Goals), ADR-002 (Kernel boundary), ADR-005 (Marketplace), ADR-012 (Eject + upgrade)

## Context

Two stakeholders care a lot about naming and branding here:

- **The ruflo team.** Open-source license already permits forks; reputation does not. If a generated harness uses "powered by ruflo" while shipping low-quality output, the marketplace's perception of ruflo suffers.
- **The harness author.** Wants their own brand. Does not want their customer to think they are using ruflo specifically; wants a clean visual identity.

We have two clean ways to satisfy both, and one messy middle. The clean ways are powered-by (acknowledged origin) and independence (vendored, no upstream mention). The messy middle — pretending to be original while shipping the ruflo logo in the README — is the failure mode we want to prevent.

This ADR pins down: the two modes, what each requires, the npm scope strategy, marketplace tag rules, the trademark posture, and what the composer enforces at generation time.

## Decision

### Two modes: powered-by and independence

The composer (ADR-003 §Identity stage) asks the user to pick one of two modes at generation time. The choice is recorded in `harness.config.json` `branding.mode` and enforced by both the composer and the publish workflow.

#### Powered-by mode (default)

The harness:

- May reference "powered by ruflo," link to the ruflo project, and use the ruflo logo per the trademark policy below.
- Ships under the harness's chosen scope (`@acme/foo`); the package's `package.json` `keywords` includes `"ruflo-harness"` and `"ruflo-marketplace"`.
- Uses ruflo's default IPFS marketplace registry (`marketplace.registryCid` defaults to ruflo's current CID).
- Inherits ruflo's plugin-trust signal set; trust tier derivation (ADR-009 §3) places the harness in the ruflo trust namespace.

In return:

- The kernel is a peer dep, upgradeable via `drift apply kernel` (ADR-012 §Default).
- The harness is eligible for inclusion in the bundled catalogue's "harnesses we know about" list (curated; not automatic).

Most generated harnesses run in this mode. It is the default for a reason: the kernel update path, the marketplace participation, the trust signals all work without configuration.

#### Independence mode

The harness:

- **May not** use the ruflo name, logo, or "powered by" attribution in its public surfaces (CLI banners, README, marketplace listing). The kernel still exists as a dependency in `package.json`, which is visible to anyone who looks — but no marketing-surface attribution.
- Ships under the harness's chosen scope, and `package.json` `keywords` does **not** include `"ruflo-harness"` (this is enforced at publish time; see §Publish-time enforcement below).
- May point at its own IPFS registry (`marketplace.registryCid` is set to the harness operator's own CID) or remain on ruflo's. The composer prompts.
- Operates its own plugin-trust signal namespace.

In return:

- The harness is a peer-dep consumer of the kernel by default (so kernel upgrades still work), with `eject` available if the operator wants to vendor.
- The harness's marketplace listing carries no `"ruflo-marketplace"` tag and does not appear in any "powered by ruflo" curation surfaces.
- Trust signals are entirely the operator's responsibility.

Independence mode is for organisations that need a clean identity for legitimate reasons — regulated brand restrictions, partnership exclusivity agreements, white-label deployments. It is a deliberately heavier path, with the trade-off named clearly: you do not get the brand-association benefit, and you are not in ruflo's curation surfaces.

#### What about the messy middle?

A harness that uses ruflo's name informally ("Acme — built on the ruflo framework") in a context where the user has chosen independence mode is a policy violation. The publish-time gate (below) blocks it. A harness that fails to acknowledge the kernel dependency at all while in powered-by mode is also a violation (the powered-by tag is required, not optional).

There is no third mode "soft-acknowledge." Pick one.

### npm scope strategy

#### Reserved scopes

The ruflo project reserves these npm scopes:

- `@metaharness/*` — the kernel, generator, host adapters, catalogue, bundled vertical packs, marketplace tooling.
- `@claude-flow/*` — historical, in use; reserved for ruflo first-party packages (existing usage continues).

Generated harnesses do **not** publish into reserved scopes. The composer refuses `--scope @ruflo` or `--scope @claude-flow` at generation time, with the error: "This scope is reserved. Use your own scope, e.g. `@acme`."

#### Scope choice for generated harnesses

The harness author picks any non-reserved npm scope:

- An organisation scope (`@acme`) — common case for company-internal or company-published harnesses.
- A personal scope (`@alice`) — common case for personal projects.
- An unscoped package name — discouraged but supported; the composer warns. Unscoped names are first-come-first-served on npm and conflict-prone.

A vertical pack (ADR-013) follows the same rule. The bundled packs live under `@metaharness/vertical-*`; curator-published packs live under the curator's scope (`@acme/vertical-mortgage`).

#### Marketplace plugin scope strategy

A plugin's npm name and its marketplace `id` (ADR-005 §2 schema) match exactly. A plugin's IPFS registry entry's `author.id` is the maintainer's identifier (free-form), typically corresponding to a verified GitHub user or org. Plugins from unverified authors land in the `community` or `experimental` trust tier (ADR-009 §3); plugins from authors in the registry's `officialAuthors[]` list can reach `verified-author` or `official`.

The ruflo project's official scope (`@ruflo`) is the only one whose authors land in `officialAuthors[]` by default. Other organisations can apply (an out-of-band PR against the registry's `authors.json`) to be added; the PR requires signed verification of scope ownership. This avoids someone publishing `@acme/plugin-foo` and claiming to be Acme Corp without actually being Acme Corp.

### Marketplace tags

Two reserved tag namespaces:

- `"ruflo-marketplace"` — set automatically on powered-by-mode harnesses; refused on independence-mode harnesses.
- `"ruflo-official"` — set automatically on bundled packages (`@metaharness/*`); refused on third-party publishes.

The tags are renderable in the marketplace UI and feed the search-result curation. A "ruflo-marketplace" tag is informational ("this harness participates in the ruflo ecosystem"); a "ruflo-official" tag is editorial ("this is shipped by the ruflo team"). The distinction is enforced.

Other tags are free-form (the harness author picks `"customer-support"`, `"legal"`, `"trading"`, etc. as appropriate). The reserved-namespace rule applies only to the two tags above.

### Trademark posture

The ruflo project's existing trademark posture (per the open-source license, MIT) permits use of the name to describe origin (nominative use). It does not permit use of the name as a product identifier ("Ruflo Pro," "Ruflo Trading," etc.).

The composer's powered-by mode enforces nominative use:

- The `package.json` `description` field may include "Built with ruflo" or "ruflo-compatible." It may not be of the form "Ruflo <Adjective>."
- The CLI banner may say "powered by ruflo" with a hyperlink. It may not say "ruflo <product name>."
- The marketplace listing's `displayName` field is the harness's own name; it may not begin with "Ruflo."

A regex check on `package.json` and the CLI banner generator output catches violations at generation time. Violations refuse to generate; the composer prints the rule and asks the user to revise.

For independence-mode harnesses, the rule is simpler: do not use the ruflo name at all in product-facing surfaces. The kernel dependency in `package.json` is allowed (it has to be); appearances of the ruflo name elsewhere are blocked at publish time.

### Publish-time enforcement

The publish workflow (ADR-005 §5, ADR-007 §B4) runs a `branding-policy-check` step that:

1. Loads `harness.config.json` `branding.mode`.
2. If `powered-by`:
   - Asserts `package.json` `keywords` contains `"ruflo-harness"`.
   - Asserts the CLI banner (output of `npx <harness> --version` or `--help`) contains "powered by ruflo" or "built with ruflo" or equivalent.
   - Asserts the marketplace listing's `displayName` does not begin with `"Ruflo"`.
3. If `independence`:
   - Asserts `package.json` `keywords` does **not** contain `"ruflo-harness"` or `"ruflo-marketplace"`.
   - Asserts no occurrence of the case-insensitive string "ruflo" in: `package.json` `description`, the CLI banner output, the README's first 500 chars, the marketplace listing's `displayName` or `description`.
   - The `package.json` `dependencies` may reference `@metaharness/kernel` — that is the only allowed reference.

Failure refuses to publish. The script's check lives at `scripts/branding-policy-check.mjs` in every harness and is generated by the composer.

### Display rule examples

| Scenario | Powered-by | Independence |
|---|---|---|
| CLI banner | "Acme Support v1.2 · powered by ruflo" | "Acme Support v1.2" |
| README title | "Acme Support — built with ruflo" | "Acme Support" |
| Marketplace `displayName` | "Acme Customer Support" | "Acme Customer Support" |
| Marketplace `description` opening | "An Acme harness on the ruflo framework." | "Acme's customer support agent." |
| `package.json` `keywords` | `["ruflo-harness", "support"]` | `["support"]` |

### Default to powered-by

The composer's default is powered-by. The choice is a single yes/no at the identity stage. A user clicking through accepts powered-by; an explicit choice for independence requires confirmation and a typed rationale (used purely for our analytics on why independence is being picked; not enforced or stored centrally).

The rationale prompt is the only "are you sure?" gate in the composer. It exists because the cost of unintended independence is high (lose marketplace participation, lose kernel-update path). The friction is by design.

### Migration between modes

A powered-by harness can switch to independence post-generation. Run `npx <harness> branding switch-to-independence`. The tool:

- Removes the powered-by strings.
- Updates `harness.config.json` `branding.mode`.
- Drops `"ruflo-harness"` from `package.json` `keywords`.
- Prompts for a new registry CID (or stay on ruflo's).

The reverse (independence → powered-by) is supported via `branding switch-to-powered-by`. The composer asks for the cost-benefit confirmation again.

### Brand assets

Powered-by harnesses may use the ruflo logo per the trademark guidelines published at `https://ruflo.dev/brand` (placeholder URL; the actual asset bundle ships with the kernel under `@metaharness/kernel/brand/`). The constraints: minimum size, clear space, color-on-color rules. The kernel's brand assets directory carries SVG + PNG; harnesses include them by reference.

Independence harnesses must not bundle these assets. The publish-time check refuses tarballs containing ruflo SVGs / PNGs in independence mode.

### The reverse trademark concern

A harness author who picks a name that conflicts with an established product (e.g. `@acme/anthropic-clone`) is out of scope for this ADR. The harness author is responsible for their own name's legal cleanliness. The composer does not run a trademark search; that is the user's job.

The reserved-scope rule is the only naming check the composer enforces.

## Consequences

### What gets easier

- **A clear choice at generation time.** Two named modes; one default. No ambiguity.
- **Publish-time enforcement.** The bad failure mode (informal misuse) is mechanically caught.
- **Marketplace curation has a tag system that actually means something.** "ruflo-marketplace" is automatically set; users searching for "ruflo-ecosystem" packages get what they expect.

### What gets harder

- **The publish-time check is one more script to maintain.** We generate it; we test it; we ship it with every harness. The cost is bounded.
- **The trademark policy has to be readable.** "Nominative use OK; product identifier no" is the rule, but the regex check enforces a specific interpretation. We document the regex; users who hit a false positive can file an issue and we adjust the rule.
- **Reserved scopes can grow.** Every time we publish a new ruflo first-party scope, we update the composer's reserved list. We commit to this list being small.

### What does not change

- The kernel itself does not care about branding mode. The branding rules are entirely in the harness layer.
- Marketplace consumers do not have to know about modes; they see the tags.

## Alternatives Considered

### Alternative 1: One mode only (powered-by required)

Reject independence; every harness must acknowledge ruflo. Rejected because the regulated-brand and white-label cases are real. Forcing acknowledgment makes generation a no-go for many organisations.

### Alternative 2: One mode only (independence by default)

The opposite extreme. Rejected because it gives up the brand-recognition feedback loop that benefits the ecosystem.

### Alternative 3: Three modes (powered-by, soft-acknowledge, independence)

The messy middle: a "we mention ruflo in the docs but not the CLI" mode. Rejected because every middle ground is a slippery slope toward "informal use" violations. Two clean modes with mechanical enforcement is simpler and harder to misuse.

### Alternative 4: No naming policy

Let users do whatever; ruflo's trademark is enforced through legal channels only. Rejected because (a) the cost of policing post-publish is high, (b) most violations are accidental and the composer can catch them before they happen, and (c) the marketplace tag system needs a normative rule for `"ruflo-marketplace"` to be meaningful.

### Alternative 5: Reserve more npm scopes

Reserve `@ruflo`, `@harness`, `@agent`, etc. Rejected because reserving names that other people might legitimately want is impolite. We reserve only what we publish.

## Test Contract

This ADR is satisfied when the following exist:

### Composer tests

1. **Reserved scope rejection** — `create-agent-harness foo --scope @ruflo` refuses with a clear error.
2. **Mode default** — interactive composer with default presses produces a powered-by harness.
3. **Independence requires confirmation** — selecting independence requires a typed rationale.

### Publish-time enforcement tests

4. **Powered-by gate** — a powered-by harness with the keyword stripped fails the gate.
5. **Independence gate** — an independence harness with "ruflo" in the README fails the gate.
6. **Banner enforcement** — generated CLI banner contains the expected attribution in powered-by; does not in independence.

### Migration tests

7. **`branding switch-to-independence`** — converts a powered-by harness to independence; subsequent publish passes the independence gate.
8. **`branding switch-to-powered-by`** — converts back; subsequent publish passes the powered-by gate.

### Tag enforcement tests

9. **Marketplace publish refuses `"ruflo-official"` tag from non-`@ruflo` scope.**
10. **Marketplace publish auto-adds `"ruflo-marketplace"` to powered-by harnesses.**

## References

### Ruflo internals cited

- The existing `CLAUDE.md` "Plugin Registry Operations" docs — the publish workflow that this ADR's branding check inserts into.
- `package.json` `keywords` convention as used by existing `@claude-flow/*` packages.

### External prior art

- npm scoped packages: https://docs.npmjs.com/about-scopes.
- Trademark nominative use doctrine: USPTO TMEP §1207.04.
- VS Code marketplace "trademarks and badges" policy: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#trademarks.
- Hugging Face Hub publisher verification: https://huggingface.co/docs/hub/organizations.

### Ruflo ADRs cited

- ADR-001 (Goals) — the use cases that motivate having two modes.
- ADR-002 (Kernel boundary) — the `@metaharness/kernel` scope choice.
- ADR-005 (Marketplace) — the schema this ADR adds branding rules on top of.
- ADR-012 (Eject + upgrade) — what changes in independence + eject combinations.
