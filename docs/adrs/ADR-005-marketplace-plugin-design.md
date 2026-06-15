# ADR-005: Marketplace Plugin Design

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary §5 Marketplace client), ADR-009 (Anti-slop), ADR-011 (Witness), ADR-013 (Vertical packs), ADR-015 (Naming)

## Context

The IPFS-backed plugin registry ruflo maintains (current CID per `CLAUDE.md` §Plugin Registry Maintenance, gateway `https://gateway.pinata.cloud/ipfs/{CID}`) is one of ruflo's load-bearing assets. The registry is a signed JSON document describing the catalogue of available plugins, who authored them, what they expose, and how trusted they are.

`agent-harness-generator` participates in this marketplace in three ways:

1. **As a marketplace plugin itself.** When installed inside an existing ruflo project, it exposes a `/create-agent-harness` slash command.
2. **As a generator that pre-wires marketplace consumption** in every harness it produces — every generated harness can install plugins from the IPFS registry out of the box.
3. **As a path for publishing.** A generated harness can publish its own scoped plugins back into the same registry under its own scope (`@acme/`).

This ADR pins the schema, the trust model, and the publishing flow for each of those three. The decisions here interact closely with ADR-009 (anti-slop) — the marketplace ADR specifies the schema and the lifecycle; the anti-slop ADR specifies the quality signals that decorate every entry.

## Decision

### 1. The marketplace participates via the existing IPFS registry

We do not build a new registry. The kernel's `@metaharness/kernel/marketplace` (per ADR-002 §5) consumes the same IPFS-Pinata-Ed25519 registry pattern ruflo already operates.

The CID is configuration, not a constant. A harness's `harness.config.json` carries:

```jsonc
{
  "marketplace": {
    "registryCid": "QmXbfEAaR7D2Ujm4GAkbwcGZQMHqAMpwDoje4583uNP834",  // ruflo's CID by default
    "gateway": "https://gateway.pinata.cloud/ipfs",
    "trustedAuthorIds": ["claude-flow-team", "ruvnet"]
  }
}
```

A user in independence mode (ADR-015) points `registryCid` at their own pinned registry. The kernel does not care which registry — it cares that the registry resolves, the signature verifies, and the catalogue conforms to the schema.

### 2. The plugin manifest schema

The schema below is the post-extraction version of ruflo's existing `PluginEntry` from `v3/@claude-flow/cli/src/plugins/store/types.ts`, generalised so it is harness-agnostic.

```jsonc
{
  "id": "@acme/plugin-customer-support",
  "name": "@acme/plugin-customer-support",          // npm package name (must match for publish)
  "displayName": "Acme Customer Support",
  "description": "Customer support agents and skills for Acme.",
  "version": "1.0.0",
  "kernelEngines": "^1.0.0",                        // semver range of @metaharness/kernel
  "size": 100000,                                   // bytes, approximate
  "checksum": "sha256:abc123...",                   // sha256 of the published tarball
  "provenance": {                                   // new in this ADR
    "npmProvenance": true,                          // shipped with `npm publish --provenance`
    "witnessManifestUrl": "ipfs://Qm...",           // optional, per ADR-011
    "ed25519Signature": "..."                       // signs (id|version|checksum|registryCid)
  },
  "author": {
    "id": "acme-corp",
    "displayName": "Acme Corp",
    "verified": true,
    "homepage": "https://acme.example.com"
  },
  "license": "MIT",
  "categories": ["customer-support", "vertical-pack"],
  "tags": ["support", "tickets"],
  "downloads": { "weekly": 0, "total": 0, "source": "npm" },  // populated at registry-render time
  "rating": { "stars": null, "voteCount": 0 },                // optional
  "lastUpdated": "2026-06-13T00:00:00.000Z",
  "type": "vertical-pack" | "integration" | "host-adapter" | "plugin" | "skill-pack" | "agent-pack",
  "exports": {
    "agents": ["customer-support-tier1", "escalation-router"],
    "skills": ["ticket-triage", "sla-tracker"],
    "commands": ["/triage", "/sla"],
    "mcpTools": ["acme.create_ticket", "acme.search_kb"],
    "hooks": ["pre-task:triage-router"]
  },
  "permissions": ["memory", "network:acme.example.com"],
  "hostsSupported": ["claude-code", "codex"],       // new in this ADR; intersects with adapter capabilities
  "verified": true,
  "trustLevel": "official" | "verified-author" | "community" | "experimental"
}
```

Notable additions relative to ruflo's current schema:

- **`kernelEngines`** — the semver range of `@metaharness/kernel` the plugin requires. Mirrors VS Code's `engines.vscode`. The kernel rejects loading a plugin whose range does not match.
- **`provenance.*`** — see §3 below.
- **`hostsSupported`** — declares which hosts the plugin works in. The composer (ADR-003) intersects this with the harness's selected hosts and warns or excludes accordingly.
- **`type` is richer** — distinguishes vertical packs, integrations, host adapters, plain plugins, skill-only packs, and agent-only packs. Helps the composer's UI filter by purpose.
- **`exports` is structured** — instead of separate `hooks`, `commands`, `permissions` arrays, exports are one object that enumerates everything the plugin contributes. The kernel's plugin loader uses this to wire the contributions without scanning the package.

### 3. Three-layer provenance

Every plugin in the marketplace carries up to three independent signals of authenticity:

1. **npm provenance attestation** (https://docs.npmjs.com/generating-provenance-statements). When the publish flow runs in GitHub Actions with the right OIDC flow, npm records a signed attestation that ties the published tarball to a specific commit and workflow. The kernel reads this via npm's registry metadata.
2. **Ed25519 signature on the registry entry.** The plugin's author signs `(id | version | checksum | registryCid)` with their key. Public keys live in the registry's `authors[]` array. The kernel verifies the signature when fetching the entry.
3. **Witness manifest URL.** Optional. Plugins that adopt the witness pattern (ADR-011, mirroring ruflo ADR-103) publish a signed manifest of attested files / behaviours. The kernel can request and verify it on install.

A plugin can have any subset of these. Anti-slop (ADR-009) uses presence/absence as a quality signal. A plugin with all three is "official"-tier eligible; one with none is "experimental." See ADR-009 §Trust-tier derivation.

### 4. The generator's marketplace participation

`@metaharness/create-agent-harness` ships **as a marketplace plugin** in addition to its standalone CLI:

- npm package: `@claude-flow/plugin-harness-generator` (final name per ADR-015).
- Registry entry: `type: "integration"`, `categories: ["meta", "official"]`, `trustLevel: "official"`.
- Exports: one command `/create-agent-harness` (the slash-command thin wrapper) and one skill `harness-generator-walkthrough`.

When a user has the plugin installed in their ruflo project, `/create-agent-harness <name>` runs the same composer flow as the standalone CLI. The two share the same source under `packages/create-agent-harness/src/`; the plugin is a thin bin-wrapper that calls into it.

### 5. Generated harnesses as marketplace publishers

Every harness the generator produces can publish its own plugins to the marketplace. The generator scaffolds the publish-side flow:

- `.github/workflows/publish-plugin.yml` — the workflow that builds, signs, and publishes a plugin.
- `scripts/publish-plugin.mjs` — the script the workflow invokes. Reads `PINATA_API_JWT`, builds the plugin tarball, computes the checksum, signs the registry entry, uploads the updated registry to Pinata, and updates the harness's pinned registry CID.

The flow is identical to the steps in `CLAUDE.local.md` §Plugin Registry Maintenance, factored into a reusable script. Generated harnesses are the script's primary consumer.

An independence-mode harness (ADR-015) maintains its own registry; the publish flow updates the harness's own CID. A powered-by-mode harness (the default) publishes to ruflo's registry under the harness's scope, with the harness's author signing.

### 6. The vertical pack as a first-class plugin type

A "vertical pack" (ADR-013) is a plugin of `type: "vertical-pack"`. It bundles multiple agents, skills, commands, and (optionally) MCP tools focused on one domain (legal, trading, healthcare, customer-support). The composer (ADR-003) shows vertical packs prominently and pre-checks the corresponding agents/skills when the user picks the pack.

A vertical pack is published the same way as any other plugin. The distinction is editorial: the registry tags it as a vertical pack and the composer treats it as a curated bundle rather than a single contribution. ADR-013 specifies the maintenance model (who owns each vertical, how it stays in sync).

### 7. Registry consumption protocol

When a harness boots:

1. Read `harness.config.json` `marketplace.registryCid`.
2. Resolve the CID via the gateway, fetch the registry JSON.
3. Verify the registry's Ed25519 signature against the trusted-publisher set (`marketplace.trustedAuthorIds`).
4. For each installed plugin in `package.json` `dependencies`, locate its registry entry, verify the entry's signature, verify the plugin's tarball checksum matches.
5. Load the plugin's `exports`. Register its `mcpTools`, `hooks`, `commands`, `agents` with the kernel's respective registries.

Steps 3 and 4 are independent. A registry that fails its signature check is rejected (no plugins load). A specific plugin that fails its signature check is logged and skipped; other plugins still load.

The harness boots in degraded mode (no marketplace plugins) if the registry cannot be fetched. This is critical for air-gapped or offline use; the kernel does not depend on the registry being reachable.

### 8. Registry caching

The fetched registry is cached at `.harness/cache/registry.json` with a 24-hour TTL. The CID is content-addressed, so a registry that has not changed re-uses the cache. A new CID (the harness operator has updated their registry pointer) busts the cache.

### 9. Publishing a plugin: the user flow

```bash
# Inside a generated harness
npx <harness-name> plugin scaffold @acme/plugin-foo
# scaffolds a new plugin package in packages/plugin-foo

# Build and test locally
cd packages/plugin-foo
npm install && npm test

# Publish to npm + register on IPFS
npx <harness-name> plugin publish @acme/plugin-foo
# This script: builds the tarball, computes checksum, runs `npm publish --provenance`,
# signs the registry entry, fetches the current registry, adds the entry, uploads to Pinata,
# updates harness.config.json `marketplace.registryCid`, commits the change.
```

A CI version of the same flow runs from a GitHub Actions workflow scaffolded into the harness.

### 10. Schema versioning

The plugin manifest schema is versioned. The registry JSON has a `schemaVersion` field. The kernel's marketplace client supports the current and the previous major schema version. When schema version `N+1` ships, the registry can publish entries in `N+1` format; clients on the older kernel keep working against entries in `N` format (the registry can publish both, dual-stack, during the transition).

This is the npm-registry pattern (npm has supported old `package.json` shapes through major changes for two decades). It is the only model we have seen that survives a long-running marketplace.

## Consequences

### What gets easier

- **A clean publishing path.** A user can ship a plugin without understanding IPFS internals; the scaffolded scripts handle the Pinata upload, the signing, the registry mutation.
- **Provenance is layered.** A consumer can pick their trust threshold: "I will only install plugins with npm provenance AND a witness manifest" is a one-line composer toggle.
- **Vertical packs work like everything else.** No special path. They are plugins with a `type` tag.
- **Independent registries are first-class.** Independence-mode harnesses run their own registry without the kernel knowing.

### What gets harder

- **Schema migrations are forever.** Every field we add to the schema is a forever-promise to support the previous shape. ADR-009 §Schema migrations gives the deprecation lane rules.
- **Trust-tier derivation is non-trivial.** Mapping "provenance signals" to a single `trustLevel` label is partly editorial. We document the algorithm in ADR-009 to keep it transparent.
- **Pinata is a dependency.** If Pinata goes down, our default registry is unreachable. The kernel's degraded-mode bootstrap mitigates the immediate user impact; the longer-term mitigation is supporting multiple gateways (Cloudflare's IPFS gateway, w3s.link) and treating any successful fetch as authoritative.

### What does not change

- The existing ruflo registry (`QmXbfEAaR7D2Ujm4GAkbwcGZQMHqAMpwDoje4583uNP834`) continues to be the default. Existing ruflo users see no change. The schema changes are additive.

## Alternatives Considered

### Alternative 1: Build a new registry, deprecate the IPFS one

Use a centralised database registry (Postgres + REST API behind a domain). Rejected because the IPFS-Pinata model is content-addressed, signature-verified, and survives the loss of any centralised authority. A central database is a single point of failure and a regulatory target. The IPFS approach is more work to operate but the right shape for a community marketplace.

### Alternative 2: Use npm as the only registry

Skip the IPFS layer; just publish plugins to npm with conventional names (`@claude-flow/plugin-*`). The marketplace UI fetches npm directly. Rejected because (a) npm has no concept of "categories", "trust levels", "vertical packs" — we would re-build all of that in client-side metadata, (b) npm has no signed-manifest concept — we lose the provenance layer, and (c) we cannot run our own registry mirror. The IPFS registry sits **alongside** npm — packages are still published to npm — but the registry document is the catalogue layer npm cannot provide.

### Alternative 3: Adopt VS Code's marketplace verbatim

The VS Code marketplace (https://marketplace.visualstudio.com/) has a richer trust model and a polished UI. Rejected because (a) it is centralised and controlled by Microsoft, with no API-first model for independent mirroring, (b) the upload workflow assumes a single canonical publisher (you, the author) which conflicts with our vertical-pack-can-be-author-or-curator-or-both pattern, and (c) the legal terms for publishers preclude redistribution. We borrow ideas (the "verified publisher" badge, the category taxonomy) but not the infrastructure.

### Alternative 4: Skip Ed25519 signatures; rely on HTTPS + Pinata's TLS

Trust the gateway's TLS for delivery integrity. Rejected because a compromised gateway could swap plugin entries undetectably. Ed25519 signatures on the registry document give us a path to detect that even if the gateway is hostile. The signature check is on the cold path (cached for 24 hours per §8) so the latency cost is negligible.

### Alternative 5: Mandate `npm provenance` for all plugins

A plugin without `npm provenance` cannot be listed. Rejected because (a) it locks out plugins published from non-GitHub CI (BitBucket, GitLab Pipelines), (b) npm provenance is OIDC-tied to specific CI environments and is genuinely awkward to set up in some configurations, and (c) anti-slop (ADR-009) already uses provenance as a quality signal — its absence lowers a plugin's trust tier but does not exclude it. Gating absolutely on provenance reduces marketplace diversity for marginal security gain (the Ed25519 signature still verifies the entry).

## Test Contract

This ADR is satisfied when the following exist:

### Schema tests

1. **JSON Schema for the plugin manifest** lives at `packages/kernel/marketplace/schema/plugin-entry.schema.json`. Every test fixture in the repo must validate against it.
2. **Schema-version migration tests** — given a `N`-shaped entry, the kernel parses it into the `N+1`-shaped runtime model. Given a `N+1`-shaped entry on a kernel that supports only `N`, the entry is rejected gracefully.

### Registry-consumption tests

3. **Signature verification** — fixtures: (a) a registry with a valid signature, (b) a registry with a corrupted signature, (c) a registry with a signature from an untrusted author. Each must result in the correct kernel behaviour (load / reject / reject).
4. **Plugin-tarball checksum** — install a plugin whose registry-declared checksum does not match the tarball; the kernel refuses to load it and surfaces a clear error.
5. **Offline / air-gapped boot** — boot a harness with the registry unreachable. The harness starts in degraded mode; no plugins load; the kernel logs the degradation.

### Publishing tests

6. **`plugin scaffold` produces a valid package** — `npx <harness> plugin scaffold @test/plugin-foo` produces a tree that passes the harness's own smoke test.
7. **`plugin publish` end-to-end** — against a mock Pinata + mock npm, the publish flow signs, uploads, updates the registry, commits the new CID. The test fixture exercises all of this without touching the real network.
8. **`npm provenance` smoke** — the publish workflow, when run with `NPM_TOKEN` + GitHub OIDC tokens, produces a tarball whose `npm view <pkg> --json` shows `dist.attestations`. Test runs in a GitHub Actions matrix; documented in ADR-007.

### Composer integration tests

9. **Plugin-picker** — composer shows installed plugins from the registry. Trust-level filter works. Host-compatibility filter works (plugin without the harness's selected host in `hostsSupported` is greyed out).

## References

### Ruflo internals cited

- `v3/@claude-flow/cli/src/plugins/store/discovery.ts` — the IPFS registry consumer the kernel inherits.
- `v3/@claude-flow/cli/src/plugins/store/types.ts` — the `PluginEntry` type the new schema generalises.
- `v3/@claude-flow/cli/src/plugins/trust/` — the trust-tier infrastructure.
- `CLAUDE.md` §Plugin Registry Maintenance and §Plugin Registry Operations — the publish flow this ADR factors into reusable scripts.
- `CLAUDE.local.md` §Plugin Registry Maintenance — the Pinata-key handling rules.

### External prior art

- npm provenance attestation: https://docs.npmjs.com/generating-provenance-statements.
- npm scoped packages: https://docs.npmjs.com/about-scopes.
- VS Code marketplace API: https://code.visualstudio.com/api/working-with-extensions/publishing-extension.
- The Sigstore project (https://www.sigstore.dev/) and in-toto attestation spec (https://in-toto.io/) — referenced for the witness-manifest layer; ADR-011 builds on these.
- Hugging Face Hub model card spec (https://huggingface.co/docs/hub/model-cards) — influence on the structured `exports` field.

### Ruflo ADRs cited

- ADR-009 (Anti-slop) — the quality-signal layer over this schema.
- ADR-011 (Witness) — the provenance manifest format.
- ADR-013 (Vertical packs) — the curator model for `type: "vertical-pack"` entries.
- ADR-015 (Naming) — the scope strategy and the independence vs powered-by mode rules.
