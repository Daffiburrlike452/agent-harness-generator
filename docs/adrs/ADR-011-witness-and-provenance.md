# ADR-011: Witness Manifest + Provenance

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary §6 Witness), ADR-005 (Marketplace §3 Three-layer provenance), ADR-007 (CI guards §A15, §B4), ADR-008 (Drift detection §Witness drift), ADR-009 (Anti-slop)

## Context

Ruflo ADR-103 ("Witness Temporal History + Plugin-Distributed Toolkit") established a signed Ed25519 manifest attesting that every documented fix in the codebase is still present, by SHA-256 + marker substring. It also defined an append-only JSONL temporal history that captures the manifest at every release, plus a regen / verify / history toolkit shipped as a plugin asset for portability.

That mechanism is the right one for generated harnesses. A harness that ships to npm is one signed artefact's worth of attested state — "these are the fixes I promised, these are the files I committed to, this is the kernel I built against." With it, a user can verify a downloaded harness has not been mutated, an operator can detect when a regression introduced a known bad version, and a marketplace can decorate a harness's listing with "yes, I am what I say I am."

This ADR specifies how the ruflo witness model is generalised so every generated harness has one out of the box. It covers: what gets attested in a harness, how the manifest is generated and verified, how it interacts with `npm provenance` and Sigstore, how rotation works, and what is signed by whom.

## Decision

### Two manifests per release

A generated harness, at every release, produces two signed artefacts:

1. **Witness manifest** (`witness.json`) — the ruflo ADR-103 style manifest, generalised: a signed JSON document attesting state.
2. **npm provenance attestation** (built by `npm publish --provenance`, recorded in npm's public log) — an OIDC-signed Sigstore attestation that the tarball was built from a known git commit on a known CI runner.

The two cover complementary things:

- Witness covers **behavioural state** — "fix F12 is still here," "memory namespace `verifications` has these checksums," "the harness manifest (ADR-003) is at this SHA."
- npm provenance covers **build authenticity** — "the tarball you downloaded matches the source at commit X built in workflow Y."

A user can verify either independently. The kernel and the marketplace use both. ADR-005's `signals.provenance.{npmProvenance, witnessManifestUrl, ed25519Signature}` fields point at all of these.

### The witness manifest schema

The schema is the ruflo ADR-103 schema, generalised to the harness context:

```jsonc
{
  "v": 1,
  "harness": {
    "name": "@acme/acme-support",
    "version": "1.2.0",
    "kernel": "@metaharness/kernel@1.4.0",
    "generatedFromManifest": "<sha256 of .harness/manifest.json>"
  },
  "gitCommit": "<commit at issuance>",
  "issuedAt": "2026-06-13T12:34:56Z",
  "branch": "main",
  "attestations": {
    "fixes": {                                  // ruflo-style fix attestations
      "F1":  { "file": "src/foo.ts", "sha256": "...", "marker": "..." },
      "#123": { "file": "src/bar.ts", "sha256": "...", "marker": "..." }
    },
    "files": {                                  // optional: attest specific files
      "src/index.ts":            { "sha256": "..." },
      ".harness/manifest.json":  { "sha256": "..." }
    },
    "memoryNamespaces": {                       // optional: attest memory state
      "verifications": { "merkleRoot": "..." }
    }
  },
  "publicKey": "<base64 ed25519 public key>",
  "signature": "<base64 ed25519 signature of the canonical JSON of everything above>"
}
```

The signature covers the canonical JSON form of every field except `signature` itself. The canonical form is RFC 8785 (JSON Canonicalization Scheme); we use the same implementation ruflo's witness scripts use today.

### Where the public key lives

Each harness has a key pair. The private key is held by the publisher (a CI secret); the public key is committed to the repo at `.harness/witness-pubkey.json` and pinned in the harness's `package.json` `harnessWitnessKey` field.

When the kernel verifies a witness manifest, it uses the public key in the signed manifest itself, then cross-checks against the public key embedded in the harness's published `package.json` (a separate npm fetch). If they disagree, verification fails. This is the basic countersignature pattern that prevents an attacker who swaps the manifest from swapping the key too.

For independence-mode harnesses (ADR-015), the public key is also published to the harness's documentation site or a `.well-known/` URL the marketplace fetches. The kernel checks one or more of these locations depending on `harness.config.json` `witness.keyPublishedAt[]`.

### Key generation and rotation

#### Initial generation

When the generator runs (ADR-003 §Smoke), it produces a fresh Ed25519 keypair, prints the public key, and instructs the user how to set the private key as a GitHub Actions secret (`WITNESS_SEED`).

The seed format is a 32-byte base64 string. The keypair is derived from it deterministically — important for reproducibility. The user can also supply their own seed via `--witness-seed-file` if they have an organisation-managed key.

The deterministic-seed model is shared with ruflo's existing implementation: regenerating the witness on the same commit with the same seed produces an identical signature. This is the property that makes ADR-007 §A15's "regen and compare" CI gate work.

> **Why determinism is achievable here (and why a TS-only kernel would have struggled with it).** The kernel runs as a wasm bundle (or as a NAPI-RS native binary built from the same Rust source — per ADR-002 / ADR-002a). Wasm execution is byte-stable across hosts: the same input on Linux x86-64, macOS arm64, Windows x64, and a Cloudflare Worker produces the same bytes out. That bit-stability is what makes "regenerated witness signature on a different runner is identical" a property the CI gate can rely on. A pure-JavaScript kernel would have to fight platform-specific math (Intl, regex unicode, Float64 rounding edge cases) to keep this property; the wasm path gives it to us for free. ADR-007 §A14b (wasm/native parity) is the gate that enforces it.

#### Rotation

Rotation has three steps:

1. **Generate a new keypair.** The harness operator runs `npx <harness> witness rotate-key`. The tool generates a new Ed25519 keypair and outputs both the new public key and the new seed.
2. **Dual-sign for one release.** The next release signs the witness manifest with **both** the old and new private keys; the manifest has `signatures: [{key: old, sig: ...}, {key: new, sig: ...}]`. The kernel accepts either signature during this period.
3. **Retire the old key.** A subsequent release signs only with the new key; the old key is retired. The harness's `package.json` `harnessWitnessKey` field is updated.

This is the same rotation model SSH client certificates use. The dual-sign window must be at least one release long; the manifest's `keyRotation` field records the dual-sign period so users can detect mid-rotation state.

A compromised key requires immediate rotation. The harness publishes an emergency advisory (the ADR-009 §5 abuse feed mechanism, used for keys this time) listing the compromised key and the date of compromise. Older signed manifests by the compromised key are still verifiable but are flagged as "key compromised at <date>; trust earlier signatures with that context."

### What gets attested by default

A harness that has not customised its witness manifest attests:

- **Self-checksums.** `.harness/manifest.json` and `package.json` are SHA-attested.
- **Kernel version pin.** `@metaharness/kernel@<exact-version>` is attested; downgrading the kernel after the fact invalidates the signature.
- **Host adapter version pins.** Same.
- **Plugin pin set.** Every installed plugin's name + version + tarball checksum.

A harness can additionally attest:

- **Fix list.** Same as ruflo's `witness-fixes.json` — file paths and marker substrings. Per-fix declaration.
- **Memory namespace merkle roots.** Selected namespaces' content as a merkle root. Used in regulated domains.
- **File-level checksums.** Selected files' SHAs.

The composer (ADR-003) defaults to attesting the first set. A user picking `--features witness=strict` adds the second set.

### The regen / verify / history scripts

All three are factored from ruflo ADR-103 §2 and shipped under `@metaharness/kernel/witness`. The harness exposes them as:

```bash
npx <harness-name> witness regen      # Regenerate the manifest at the current commit
npx <harness-name> witness verify     # Verify the manifest against the live tree
npx <harness-name> witness history    # Query the temporal log
npx <harness-name> witness rotate-key # Initiate key rotation
```

The implementation is the lib functions from ruflo's `plugins/ruflo-core/scripts/witness/`, generalised to take `--manifest`, `--history`, `--fixes`, `--root` arguments. The ruflo-specific path constants become harness-config-driven.

### Append-only JSONL temporal history

Same as ruflo ADR-103 §1. `verification-history.jsonl` lives at the harness root, committed with every release. Each release appends one line capturing the signed manifest's hash and a per-fix snapshot.

The `history regressions` query walks the JSONL backwards to find, for each currently-regressed fix, the most recent snapshot where it passed and the next snapshot where it regressed. The brackets give a small commit window for `git log` triage. Per ruflo ADR-103, this collapses bisect for regression triage.

### Witness ↔ npm provenance

When a harness is published with both witness and npm provenance:

1. The user runs `npx <harness> witness verify` to check the witness signature against the local tree.
2. The user runs `npm view <harness> --json | jq '.dist.attestations'` to check the npm provenance signature.
3. The kernel's `marketplace install` flow does both checks at install time, surfaces both results, and refuses to load if either fails (configurable per harness; default: fail-closed for `official` tier, fail-open for everything else, per anti-slop ADR-009 §3).

The two signatures are independent. A key compromise on the witness side does not invalidate npm provenance. A spoofed npm tarball does not invalidate witness if the witness was signed before publishing.

### Sigstore as an alternative path

For harnesses that want OIDC-based signing instead of long-lived Ed25519 keys, the witness regen accepts `--sign-with-sigstore`. The signature is produced via Sigstore's cosign, recorded in the Sigstore transparency log (Rekor), and the witness manifest carries `signature.transparencyLogUrl` instead of (or in addition to) the Ed25519 signature.

Reference: https://www.sigstore.dev/, https://docs.sigstore.dev/cosign/overview/.

This path is most useful for organisations whose security policy requires no long-lived keys. The Ed25519 path is the default because (a) it works offline and (b) it does not require an Sigstore-enabled CI provider.

### in-toto attestation format compatibility

The witness manifest is wrapped as an in-toto attestation when sent to the marketplace registry. The wrapper is:

```jsonc
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "@acme/acme-support", "digest": { "sha256": "..." } }],
  "predicateType": "https://ruflo.dev/witness/v1",
  "predicate": { /* the witness.json content */ }
}
```

This makes the witness compatible with SLSA-style supply-chain consumers (https://slsa.dev/). A future kernel can adopt SLSA Level 3 signing on top of the witness primitive.

### Per-release vs per-commit witness

The witness regenerates **per release** (when a tag is pushed) and **per commit on main** (for the temporal history). The per-PR CI does not regenerate; it verifies the committed manifest against the live tree.

Two reasons:

1. Per-PR regen would spam the temporal history with every PR's intermediate state, which is the wrong granularity for regression triage.
2. The regen requires the signing seed; we do not expose the seed to PR runs (which can be opened by external contributors).

### Cross-harness witness federation

A federation member (ADR-014) participates in cross-instance witness federation. When two instances of the same harness federate, each periodically pushes its witness manifest to the others; the other verifies it against its local copy of the kernel and surfaces drift if signatures diverge. This is "did we drift apart?" detection at the witness level — strictly stricter than the ADR-008 drift detection because witness covers more than file-level checksums.

Cross-harness federation between different harnesses is **not** in scope for this ADR. Two organisations exchanging witness signatures is a trust establishment outside the kernel's scope; if they want to do it, they sign each other's manifests in an out-of-band protocol.

## Consequences

### What gets easier

- **Verification is one command.** A user verifying an installed harness runs `witness verify` and gets a yes/no answer plus a per-attestation breakdown.
- **Regression triage is bisect-without-the-bisect.** ADR-103's temporal history query, generalised.
- **Marketplace listings have a real signal.** ADR-009's "witnessManifestPresent" flag is mechanically verifiable.
- **Key rotation has a clear path.** Not a one-off scramble when the seed is leaked.

### What gets harder

- **Key management is real work.** A harness operator who loses the seed loses the ability to issue new witness signatures (until rotation completes). The recovery is dual-sign for one release with a new key, which requires having access to the old key. If both are lost, the user must publish an advisory and start a fresh signing history.
- **Witness regeneration in CI.** The signing seed is a CI secret; the regen runs in a privileged context. We isolate it (the regen workflow has its own restricted permissions; nothing else in the harness's CI can access the seed).
- **Two signatures means two failure modes.** We commit to surfacing both clearly.

### What does not change

- The ruflo witness scripts already exist (per ADR-103). The kernel exports them; the rest is configuration and policy.
- npm provenance is unchanged; we consume it as-is.

## Alternatives Considered

### Alternative 1: npm provenance only; skip witness

Use only `npm publish --provenance`. Rejected because provenance attests the build, not the behaviour. "This tarball came from this commit" does not answer "and the fix I promised to keep is still in the commit." The witness manifest carries that semantic.

### Alternative 2: Witness only; skip npm provenance

Use only the Ed25519 witness. Rejected because npm provenance is a free additional signature (provided the CI environment supports it), it leverages Sigstore's transparency log which is independently auditable, and ADR-009's anti-slop derivation already uses it as a signal.

### Alternative 3: Sign at install time, not publish time

Have the kernel sign-on-fetch as a TOFU (trust-on-first-use) pattern. Rejected because it shifts the trust anchor to the user's first fetch, which is the most attacker-attractive moment. Publish-time signing with a long-lived key gives a stronger statement that survives compromise of the user's first fetch.

### Alternative 4: A single global witness key (ruflo-team-signed)

All harnesses are signed by a central key. Rejected because it makes the central team the single point of compromise, and conflicts with the independence-mode promise of ADR-015. Per-harness keys, with the marketplace tracking the public key per author, is the right model.

### Alternative 5: Skip the deterministic-seed model

Generate fresh signatures with a random nonce per regen. Rejected because ADR-007 §A15's "regen in CI and compare to committed manifest" gate requires determinism. Without it, every regen produces a slightly different signature and the gate has no meaning.

## Test Contract

This ADR is satisfied when the following exist:

### Generation tests

1. **Witness regen produces a stable signature** for the same commit and the same seed. Property test using `fast-check` with seed variations.
2. **Witness regen handles fix marker drift** — a fixture with a fix marker that has moved produces a regenerated manifest with the new SHA and a "diff vs previous" output. Same as ruflo ADR-103's behaviour.
3. **Witness verify on a clean tree** returns success; on a tampered tree (one file's SHA changed) returns the specific delta.

### Rotation tests

4. **Dual-sign for one release** — generate keypair A, sign with A; rotate to keypair B, sign with both A and B; verify accepts either; the next release signs only with B and old A signatures are flagged as "previous key, no longer used."
5. **Compromised-key flow** — emergency rotation publishes an advisory; the kernel marks older manifests by the compromised key as "trust with context."

### npm provenance interaction

6. **Both signatures verify on install** — fixture harness with both witness and provenance; kernel `install` reports both as `valid`.
7. **One signature fails** — fixture with broken witness; the install behaves per the harness's failure policy.

### Sigstore alternative path

8. **Sigstore-signed witness** — given an OIDC-enabled CI environment, the regen produces an Sigstore-recorded signature; verification reads from Rekor and confirms.

### in-toto wrap

9. **In-toto attestation shape** — the wrapped witness validates against the in-toto Statement schema. SLSA-compatible.

### CI integration

10. **`witness-verify` job** in the harness's `.github/workflows/ci.yml` (per ADR-007 §B1) runs and passes on every PR; fails on tampered fixtures.
11. **`witness-regen` job** on release tags (per ADR-007 §A15 / §B4) produces a signature matching the committed manifest.

## References

### Ruflo internals cited

- `v3/docs/adr/ADR-103-witness-temporal-history.md` — the model this ADR generalises.
- `verification.md.json` and `verification-history.jsonl` — the live artefacts in the ruflo repo today.
- `scripts/regen-witness.mjs` — the entrypoint the kernel inherits.
- `plugins/ruflo-core/scripts/witness/` — the lib functions.

### External prior art

- npm provenance: https://docs.npmjs.com/generating-provenance-statements.
- Sigstore: https://www.sigstore.dev/; cosign: https://docs.sigstore.dev/cosign/overview/.
- Rekor transparency log: https://docs.sigstore.dev/logging/overview/.
- in-toto attestation framework: https://in-toto.io/, https://github.com/in-toto/attestation.
- SLSA framework: https://slsa.dev/.
- RFC 8785 (JSON Canonicalization Scheme): https://www.rfc-editor.org/rfc/rfc8785.
- Ed25519 RFC: https://www.rfc-editor.org/rfc/rfc8032.

### Ruflo ADRs cited

- ADR-103 (Witness Temporal History) — the model.
- ADR-005 (Marketplace) — the consumer of the provenance signal.
- ADR-007 (CI guards) — the gates that enforce regen+compare.
- ADR-009 (Anti-slop) — the consumer of the signal at the marketplace UI layer.
