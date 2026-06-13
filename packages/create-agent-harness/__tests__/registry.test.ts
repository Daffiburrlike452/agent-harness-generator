// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { buildRegistryEntry } from '../src/registry.js';
import type { HarnessManifest } from '../src/manifest.js';

const manifest: HarnessManifest = {
  schema: 1,
  generator: '0.1.0',
  template: 'vertical:trading',
  template_version: '0.1.0',
  vars: { name: 'my-bot' },
  hosts: ['claude-code', 'codex'],
  files: { 'package.json': 'abc' },
  generated_at: '2026-06-13T00:00:00Z',
};

describe('buildRegistryEntry', () => {
  it('extracts name from manifest.vars.name', () => {
    const e = buildRegistryEntry({
      manifest,
      description: 'A trading bot',
      author: { id: 'ruv', displayName: 'rUv' },
      manifestCid: 'bafy123',
      size: 100,
      checksum: 'sha256:abc',
      witnessPublicKey: '0'.repeat(64),
      witnessSignedAt: '2026-06-13T00:00:00Z',
    });
    expect(e.name).toBe('my-bot');
    expect(e.id).toBe('harness/my-bot');
  });

  it('derives category from vertical:* template id', () => {
    const e = buildRegistryEntry({
      manifest, description: 'x',
      author: { id: 'x', displayName: 'x' },
      manifestCid: 'bafy', size: 1, checksum: 'x',
      witnessPublicKey: '0'.repeat(64),
      witnessSignedAt: '2026-06-13T00:00:00Z',
    });
    expect(e.categories).toContain('trading');
    expect(e.categories).toContain('harness');
  });

  it('includes host:<n> tags', () => {
    const e = buildRegistryEntry({
      manifest, description: 'x',
      author: { id: 'x', displayName: 'x' },
      manifestCid: 'bafy', size: 1, checksum: 'x',
      witnessPublicKey: '0'.repeat(64),
      witnessSignedAt: '2026-06-13T00:00:00Z',
    });
    expect(e.tags).toContain('host:claude-code');
    expect(e.tags).toContain('host:codex');
  });

  it('sets trustLevel to community by default', () => {
    const e = buildRegistryEntry({
      manifest, description: 'x',
      author: { id: 'x', displayName: 'x' },
      manifestCid: 'bafy', size: 1, checksum: 'x',
      witnessPublicKey: '0'.repeat(64),
      witnessSignedAt: '2026-06-13T00:00:00Z',
    });
    expect(e.trustLevel).toBe('community');
  });

  it('honors explicit trustLevel + verified author', () => {
    const e = buildRegistryEntry({
      manifest, description: 'x',
      author: { id: 'x', displayName: 'x', verified: true },
      manifestCid: 'bafy', size: 1, checksum: 'x',
      witnessPublicKey: '0'.repeat(64),
      witnessSignedAt: '2026-06-13T00:00:00Z',
      trustLevel: 'official',
    });
    expect(e.trustLevel).toBe('official');
    expect(e.verified).toBe(true);
  });

  it('uses general category for non-vertical templates', () => {
    const minimal: HarnessManifest = { ...manifest, template: 'minimal' };
    const e = buildRegistryEntry({
      manifest: minimal, description: 'x',
      author: { id: 'x', displayName: 'x' },
      manifestCid: 'bafy', size: 1, checksum: 'x',
      witnessPublicKey: '0'.repeat(64),
      witnessSignedAt: '2026-06-13T00:00:00Z',
    });
    expect(e.categories).toContain('general');
  });

  it('populates ipfs.manifestCid and witness.publicKey', () => {
    const e = buildRegistryEntry({
      manifest, description: 'x',
      author: { id: 'x', displayName: 'x' },
      manifestCid: 'bafy123', tarballCid: 'bafytarball',
      size: 100, checksum: 'sha256:abc',
      witnessPublicKey: 'a'.repeat(64),
      witnessSignedAt: '2026-06-13T00:00:00Z',
    });
    expect(e.ipfs.manifestCid).toBe('bafy123');
    expect(e.ipfs.tarballCid).toBe('bafytarball');
    expect(e.witness.publicKey).toBe('a'.repeat(64));
  });
});
