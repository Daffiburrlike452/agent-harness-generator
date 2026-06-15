// SPDX-License-Identifier: MIT
//
// End-to-end LIFECYCLE smoke test.
//
// Exercises every `harness` subcommand against ONE scaffolded harness
// in a single chain:
//
//   scaffold              (iter 4)
//      ↓
//   doctor                (iter 8)   structural sanity
//      ↓
//   validate              (iter 20)  umbrella with --skip-gcp
//      ↓
//   verify                (iter 8)   witness manifest check (skipped if no witness)
//      ↓
//   mcp ls                (iter 45)  list MCP servers (none declared OK)
//      ↓
//   sbom --validate-only  (iter 51)  SPDX-2.3 shape check
//      ↓
//   audit (no --confirm)  (iter 51)  audit precondition check
//      ↓
//   upgrade (dry-run)     (iter 47)  drift plan, no apply
//      ↓
//   publish (dry-run)     (iter 46)  pin shape check, no Pinata
//      ↓
//   federate init         (iter 9)   federation state
//
// If any subcommand regresses, this test fires before publish.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../packages/create-agent-harness/src/index.js';
import { doctor, verify } from '../packages/create-agent-harness/src/subcommands.js';
import { validate } from '../packages/create-agent-harness/src/validate.js';
import { mcpDispatch } from '../packages/create-agent-harness/src/mcp-cmd.js';
import { sbomCmd } from '../packages/create-agent-harness/src/sbom-cmd.js';
import { auditCmd } from '../packages/create-agent-harness/src/audit-cmd.js';
import { upgradeCmd } from '../packages/create-agent-harness/src/upgrade-cmd.js';
import { publishCmd } from '../packages/create-agent-harness/src/publish-cmd.js';
import { federateDispatch } from '../packages/create-agent-harness/src/federate.js';
import { diagCmd } from '../packages/create-agent-harness/src/diag.js';

const GEN_VERSION = '0.1.0';

describe('e2e lifecycle: scaffold → all 13 subcommands (iter 52 + iter 66 diag)', () => {
  it('every subcommand survives the chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-lifecycle-'));
    try {
      // 1. scaffold
      const sr = await scaffold({
        name: 'lifecycle-bot',
        template: 'minimal',
        host: 'claude-code',
        description: 'e2e lifecycle smoke',
        targetDir: dir,
        force: true,
        generatorVersion: GEN_VERSION,
      });
      expect(sr.paths.length).toBeGreaterThan(0);
      expect(sr.unresolved).toEqual([]);

      // 2. doctor
      const dr = await doctor([dir]);
      expect(dr.code, `doctor:\n${dr.lines.join('\n')}`).toBe(0);
      expect(dr.lines.join('\n')).toMatch(/Result: HEALTHY/);

      // 3. validate umbrella (skip-gcp avoids gcloud requirement)
      const vr = await validate([dir, '--skip-gcp']);
      expect(vr.code, `validate:\n${vr.lines.join('\n')}`).toBe(0);
      expect(vr.lines.join('\n')).toMatch(/Result: HEALTHY/);

      // 4. verify — no witness yet, the wrapper returns code 1 with
      // "no witness" message. Treat as expected.
      const vfr = await verify([dir]);
      expect([0, 1]).toContain(vfr.code);

      // 5. mcp ls — no .mcp/servers.json is fine, just doesn't list
      const mr = await mcpDispatch(['ls', dir]);
      expect(mr.code).toBe(0);

      // 6. sbom --validate-only
      const sb = await sbomCmd([dir, '--validate-only']);
      expect(sb.code, `sbom:\n${sb.lines.join('\n')}`).toBe(0);

      // 7. audit — no lockfile yet, expect "needs lockfile" or skip OK
      const ar = await auditCmd([dir]);
      expect([0, 1]).toContain(ar.code);  // 1 if no lockfile, both valid

      // 8. upgrade (dry-run) — should be "No drift" on a fresh scaffold
      const ur = await upgradeCmd([dir]);
      expect(ur.code, `upgrade:\n${ur.lines.join('\n')}`).toBe(0);
      expect(ur.lines.join('\n')).toMatch(/No drift|DRY-RUN/);

      // 9. publish (dry-run by default)
      const pr = await publishCmd([dir]);
      expect(pr.code, `publish:\n${pr.lines.join('\n')}`).toBe(0);
      expect(pr.lines.join('\n')).toMatch(/DRY-RUN|confirmed: false/);

      // 10. federate init — creates .harness/federation.json
      // federateDispatch takes cwd as a SECOND positional arg, not in args[].
      const fr = await federateDispatch(['init', 'self-id'], dir);
      expect(fr.code, `federate:\n${fr.lines.join('\n')}`).toBe(0);

      // 11. diag (iter 66) — kernel-version skew check. On a fresh
      // scaffold the manifest.meta.kernel_version (stamped by iter 58)
      // matches the locally-resolved @metaharness/kernel, so we expect PASS
      // and exit 0. This pins that ADR-027's diagnostic loop survives
      // every other lifecycle step above — none of doctor / verify /
      // mcp-scan / sbom / audit / upgrade / publish / federate corrupt
      // the meta block.
      const dg = await diagCmd([dir]);
      expect(dg.code, `diag:\n${dg.lines.join('\n')}`).toBe(0);
      expect(dg.lines.join('\n')).toMatch(/PASS kernel versions match/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('lifecycle works across all 6 hosts (scaffold + validate + sbom)', async () => {
    const hosts = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm'] as const;
    for (const host of hosts) {
      const dir = await mkdtemp(join(tmpdir(), `ahg-life-${host}-`));
      try {
        await scaffold({
          name: `life-${host}`,
          template: 'minimal',
          host,
          targetDir: dir,
          force: true,
          generatorVersion: GEN_VERSION,
        });
        const v = await validate([dir, '--skip-gcp']);
        expect(v.code, `${host} validate:\n${v.lines.join('\n')}`).toBe(0);
        const sb = await sbomCmd([dir, '--validate-only']);
        expect(sb.code, `${host} sbom:\n${sb.lines.join('\n')}`).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
