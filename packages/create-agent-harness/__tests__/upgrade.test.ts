// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planUpgrade, formatPlan, inlineConflictMarkers } from '../src/upgrade.js';
import { sha256 } from '../src/manifest.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cah-upgrade-'));
  await mkdir(join(root, '.harness'), { recursive: true });
  return root;
}

describe('planUpgrade', () => {
  it('throws if .harness/manifest.json is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cah-empty-'));
    await expect(planUpgrade(root, {})).rejects.toThrow(/No \.harness/);
  });

  it('reports added/removed/clean-changed correctly', async () => {
    const root = await setup();
    await writeFile(join(root, '.harness', 'manifest.json'), JSON.stringify({
      schema: 1, generator: '0.1.0', template: 'minimal', template_version: '0.0.0',
      vars: {}, hosts: [], generated_at: '2026-06-13T00:00:00Z',
      files: {
        'a.txt': sha256('A v1'),
        'b.txt': sha256('B'),
        'removed.txt': sha256('R'),
      },
    }));
    // Local matches what manifest says was generated.
    await writeFile(join(root, 'a.txt'), 'A v1');
    await writeFile(join(root, 'b.txt'), 'B');
    await writeFile(join(root, 'removed.txt'), 'R');

    // Upstream introduced new.txt, kept b.txt, bumped a.txt, dropped removed.txt.
    const newFiles = {
      'a.txt': sha256('A v2'),
      'b.txt': sha256('B'),
      'new.txt': sha256('new!'),
    };

    const plan = await planUpgrade(root, newFiles);
    expect(plan.added).toEqual(['new.txt']);
    expect(plan.removed).toEqual(['removed.txt']);
    expect(plan.changed).toEqual([{ path: 'a.txt', kind: 'clean' }]);
  });

  it('detects a conflict when local has diverged', async () => {
    const root = await setup();
    await writeFile(join(root, '.harness', 'manifest.json'), JSON.stringify({
      schema: 1, generator: '0.1.0', template: 'minimal', template_version: '0.0.0',
      vars: {}, hosts: [], generated_at: '2026-06-13T00:00:00Z',
      files: { 'a.txt': sha256('A v1') },
    }));
    // User edited a.txt locally.
    await writeFile(join(root, 'a.txt'), 'A v1 plus local edits');
    // Upstream also changed a.txt.
    const plan = await planUpgrade(root, { 'a.txt': sha256('A v2 upstream') });
    expect(plan.changed).toEqual([{ path: 'a.txt', kind: 'conflict' }]);
  });
});

describe('formatPlan', () => {
  it('renders summary lines + lists conflicts', () => {
    const text = formatPlan({
      added: ['new.txt'],
      removed: ['old.txt'],
      changed: [
        { path: 'clean.txt', kind: 'clean' },
        { path: 'conflict.txt', kind: 'conflict' },
      ],
    });
    expect(text).toMatch(/1 added/);
    expect(text).toMatch(/1 removed/);
    expect(text).toMatch(/1 clean-overwrite/);
    expect(text).toMatch(/1 conflict/);
    expect(text).toMatch(/conflict\.txt/);
  });
});

describe('inlineConflictMarkers', () => {
  it('produces Git-style markers around current + upstream', () => {
    const out = inlineConflictMarkers('LOCAL', 'UPSTREAM');
    expect(out).toMatch(/<<<<<<< current/);
    expect(out).toMatch(/LOCAL/);
    expect(out).toMatch(/=======/);
    expect(out).toMatch(/UPSTREAM/);
    expect(out).toMatch(/>>>>>>> upstream/);
  });
});
