#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// examples/host-tour/host-tour.mjs
//
// Tour: scaffold + validate + summarise file shape for each of the
// 4 frameworks the user asked for examples on (hermes, codex, pi-dev,
// openclaw) plus claude-code + rvm for completeness — all 6 hosts.
//
// Output for each host:
//   - what files the per-host adapter emitted
//   - whether `harness validate --skip-gcp` reports HEALTHY
//   - per-host wall-clock
//
// Demonstrates the iter-2/4/11/12 multi-host parity story:
// the SAME scaffolder produces 6 byte-correct shapes, one per host.

import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { scaffold } from '../../packages/create-agent-harness/dist/index.js';
import { validate } from '../../packages/create-agent-harness/dist/validate.js';

const HOSTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex',       label: 'OpenAI Codex' },
  { id: 'pi-dev',      label: 'pi.dev (badlogic/pi-mono)' },
  { id: 'hermes',      label: 'Hermes Agent (NousResearch)' },
  { id: 'openclaw',    label: 'OpenClaw (Personal AI Assistant)' },
  { id: 'rvm',         label: 'RVM (microhypervisor)' },
];

async function listFiles(dir, prefix = '') {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...await listFiles(p, rel));
    } else {
      const st = await stat(p);
      out.push({ path: rel, size: st.size });
    }
  }
  return out;
}

function fmt(n) { return `${(n).toString().padStart(4)}`; }
function bytes(n) {
  if (n < 1024) return `${n}B`;
  return `${(n/1024).toFixed(1)}K`;
}

async function tour(host) {
  const dir = await mkdtemp(join(tmpdir(), `ahg-tour-${host.id}-`));
  const t0 = Date.now();
  try {
    const r = await scaffold({
      name: `${host.id}-bot`,
      template: 'minimal',
      host: host.id,
      description: `host-tour example for ${host.label}`,
      targetDir: dir,
      force: true,
      generatorVersion: '0.1.0',
    });

    const files = await listFiles(dir);
    const totalBytes = files.reduce((s, f) => s + f.size, 0);

    const v = await validate([dir, '--skip-gcp']);
    const healthy = v.lines.join('\n').includes('Result: HEALTHY');
    const dt = Date.now() - t0;

    return {
      host,
      files,
      totalBytes,
      healthy,
      unresolved: r.unresolved.length,
      pathCount: r.paths.length,
      dt,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function summary(report) {
  const { host, files, totalBytes, healthy, pathCount, dt } = report;
  const lines = [];
  lines.push('');
  lines.push(`### ${host.label} (host=${host.id})`);
  lines.push('');
  lines.push(`  ${healthy ? 'HEALTHY' : 'FAIL'}   ${fmt(pathCount)} files written   ${bytes(totalBytes).padStart(6)}   ${dt}ms`);
  lines.push('');
  lines.push(`  File tree:`);
  // Sort & group by depth for readability
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    lines.push(`    ${f.path.padEnd(50)} ${bytes(f.size).padStart(7)}`);
  }
  return lines.join('\n');
}

async function main() {
  process.stderr.write('agent-harness-generator — host tour\n');
  process.stderr.write(`scaffolding ${HOSTS.length} hosts (template=minimal)\n`);

  const t0 = Date.now();
  const reports = [];
  for (const host of HOSTS) {
    reports.push(await tour(host));
  }
  const total = Date.now() - t0;

  // Print summary table
  process.stdout.write('# Host Tour — output\n\n');
  process.stdout.write('| Host | id | files | bytes | wall | validate |\n');
  process.stdout.write('|------|----|-------|-------|------|----------|\n');
  for (const r of reports) {
    process.stdout.write(`| ${r.host.label} | \`${r.host.id}\` | ${r.pathCount} | ${bytes(r.totalBytes)} | ${r.dt}ms | ${r.healthy ? 'HEALTHY' : 'FAIL'} |\n`);
  }
  process.stdout.write(`\nTotal wall time across ${HOSTS.length} hosts: **${total}ms**\n`);

  // Detail blocks
  for (const r of reports) {
    process.stdout.write(summary(r) + '\n');
  }

  // Exit non-zero if any failed
  const failed = reports.filter(r => !r.healthy);
  if (failed.length > 0) {
    process.stderr.write(`\n[host-tour] FAIL: ${failed.length} host(s) failed validate\n`);
    process.exit(1);
  }
  process.stderr.write(`\n[host-tour] DONE — ${reports.length}/6 hosts HEALTHY in ${total}ms\n`);
}

main().catch(err => {
  process.stderr.write(`[host-tour] FAIL: ${err?.stack ?? err}\n`);
  process.exit(1);
});
