# ADR-018: RVM as deployment target for hardware-isolated harnesses

**Status**: Accepted (iter 12)
**Date**: 2026-06-13
**Builds on**: [ADR-004](./ADR-004-host-integration-model.md) (Host integration model), [ADR-014](./ADR-014-self-evolution-and-federation.md) (Federation)

## Context

The first five host adapters (Claude Code, Codex, pi.dev, Hermes, OpenClaw) target **OS-level isolation**. The Node process running the generated harness has whatever permissions the OS grants it. For local-dev and personal use, that's fine — the user runs `npx my-bot init` on their own laptop and trusts their own code.

For **federated harnesses across trust boundaries**, OS-level isolation is the wrong primitive. Two operators running each other's harnesses on shared infrastructure need:

1. Per-agent memory + CPU + capability isolation that the OS cannot enforce alone
2. Cryptographically verifiable audit of every privileged operation
3. A failure-class model that allows rollback without rebooting the entire host
4. A way for harness A's claims to be honored at harness B's deployment without trusting the host operator

[RVM](https://github.com/ruvnet/rvm) — the Agentic Virtual Machine — is purpose-built for exactly this. It's a bare-metal microhypervisor for AArch64 with:

- **Coherence domains** — dynamic graph-mincut partitions that merge/split based on agent communication patterns
- **Capability tokens** with 7 rights: READ, WRITE, GRANT, REVOKE, EXECUTE, PROVE, GRANT_ONCE
- **Three-tier proof verification** (P1 cheapest, P3 strongest)
- **Witness-native syscalls** — every privileged op emits a 64-byte SHA-256 hash-chained record
- **WASM guest runtime** with agent lifecycle + cross-partition migration
- **F1–F4 failure classes** with graduated rollback

## Decision

Ship `@metaharness/host-rvm` as the **6th host adapter**, positioned as the deployment target for hardware-isolated harnesses. The adapter:

1. Generates an `rvm-partition.toml` partition manifest
2. Maps the kernel's `Claim { capability, resource, expires_at }` onto RVM's 7-right capability tokens
3. Emits `wasm-guest.json` referencing the kernel WASM bundle + F1–F4 recovery actions
4. Provides an idempotent `install-rvm.sh` runbook (idempotent re-install, register partition, install caps, boot guest)

**The kernel's WASM bundle IS the RVM guest.** The same `@metaharness/kernel` wasm-pack output that loads in `@metaharness/host-claude-code` loads as an RVM-managed guest. No fork of the kernel.

### Claim → capability mapping

| Kernel claim capability | RVM rights | Default proof tier |
|---|---|---|
| `*` | all 7 | P3 |
| `*.read` | READ | P1 |
| `*.write` | WRITE | P2 |
| `*.execute` / `tool.invoke.*` | EXECUTE | P2 |
| `*.grant` / `*.revoke` / `*.prove` | GRANT / REVOKE / PROVE | P3 |
| `*.grant_once` | GRANT_ONCE | P3 |
| `memory.*` / `tool.*` (prefix) | READ + WRITE + EXECUTE | P2 |
| default | READ | P1 |

The mapping is deterministic and lossless: if your harness can express a constraint through kernel claims, RVM can enforce it.

### Tier picture

| Adapter | Isolation | Best for |
|---|---|---|
| `claude-code`, `codex`, `pi-dev`, `hermes`, `openclaw` | OS-level | Local-dev / personal use |
| **`rvm`** | **Hardware (microhypervisor + caps + hash-chained witness)** | **Multi-tenant / untrusted peers** |

For everyday local-dev, the OS-level adapters are correct. For federation across trust boundaries (ADR-014), RVM is the natural backend.

## Consequences

**Positive:**

- One harness source → six deployment targets. No fork required.
- Federation gets a real isolation backend. Until now, federation was capability-based at the kernel layer; RVM makes the same capabilities enforceable at the hypervisor layer.
- Witness-native syscalls compose with the ADR-011 Ed25519 witness manifest — the harness's release-time signature + RVM's runtime hash-chain together give end-to-end provenance.

**Negative / honest trade-offs:**

- RVM targets AArch64. Users on x86 servers either need an AArch64 host or wait for x86 support.
- `rvm-loader` is not on crates.io as of iter 12; the install runbook falls back to building from source. The adapter is shipped expecting that to change.
- The full RVM partition-manifest schema may evolve faster than our adapter; we ship a conservative subset (partition, wasm_guest, metadata) and document override points.

## Alternatives considered

- **Just use the kernel's claims subsystem** — already shipped (iter 7). Sufficient for OS-level adapters; insufficient when the OS itself is untrusted. RVM is the upgrade path.
- **Use Docker / gVisor / firejail for sandboxing** — works for "stop this Node process from `rm -rf`" but not for capability-graph dynamic partitioning or the witness-native audit. Different problem space.
- **Replace `admit_message()` with RVM internally** — would force every harness install to ship RVM, which is the wrong default. Kept the in-kernel implementation as the OS-level baseline; RVM is opt-in via `--host rvm`.

## Test contract

- 23 TS test cases pin: rights derivation per capability suffix, default proof tier per right family, capability-table build, partition TOML structure + override, wasm-guest JSON shape including F1–F4 recovery map, install runbook contents, adapter export contract.

## References

- RVM: https://github.com/ruvnet/rvm
- ADR-004 §host adapter contract
- ADR-014 §federation
- ADR-011 §witness manifest (composes with RVM witness-native syscalls)
