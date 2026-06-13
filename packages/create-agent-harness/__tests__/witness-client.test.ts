// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyWitness, readAndVerify, findWitness } from '../src/witness-client.js';

describe('verifyWitness — shape gate', () => {
  it('rejects non-objects', async () => {
    expect((await verifyWitness(null)).valid).toBe(false);
    expect((await verifyWitness('string')).valid).toBe(false);
    expect((await verifyWitness(42)).valid).toBe(false);
  });

  it('rejects wrong schema version', async () => {
    const r = await verifyWitness({
      schema: 999, harness: 'x', version: '0.1.0', entries: [],
      public_key: 'a'.repeat(64), signature: 'b'.repeat(128),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/schema/);
  });

  it('rejects short public_key', async () => {
    const r = await verifyWitness({
      schema: 1, harness: 'x', version: '0.1.0', entries: [],
      public_key: 'short', signature: 'b'.repeat(128),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/public_key/);
  });

  it('rejects short signature', async () => {
    const r = await verifyWitness({
      schema: 1, harness: 'x', version: '0.1.0', entries: [],
      public_key: 'a'.repeat(64), signature: 'short',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/signature/);
  });

  it('rejects missing required fields', async () => {
    const r = await verifyWitness({
      schema: 1, version: '0.1.0', entries: [],
      public_key: 'a'.repeat(64), signature: 'b'.repeat(128),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/harness/);
  });

  it('accepts a shape-valid manifest in degraded mode (no kernel)', async () => {
    // No @ruflo/kernel install in the test runner -> falls through to
    // shape-only verification. Confirms the degraded mode is graceful.
    const r = await verifyWitness({
      schema: 1, harness: 'x', version: '0.1.0', entries: [],
      public_key: 'a'.repeat(64), signature: 'b'.repeat(128),
    });
    expect(r.valid).toBe(true);
  });
});

describe('findWitness', () => {
  it('returns null when no witness.json exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wc-find-'));
    expect(findWitness(root)).toBeNull();
  });

  it('finds witness.json at the harness root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wc-find-root-'));
    await writeFile(join(root, 'witness.json'), '{}');
    expect(findWitness(root)).toBe(join(root, 'witness.json'));
  });
});

describe('readAndVerify', () => {
  it('throws on missing file', async () => {
    await expect(readAndVerify('/no/such/path.json')).rejects.toThrow(/no witness/);
  });

  it('throws on invalid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wc-bad-'));
    const p = join(root, 'witness.json');
    await writeFile(p, 'not valid json');
    await expect(readAndVerify(p)).rejects.toThrow(/not valid JSON/);
  });

  it('returns the result with the parsed manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wc-ok-'));
    const p = join(root, 'witness.json');
    const m = {
      schema: 1, harness: 'x', version: '0.1.0', entries: [],
      public_key: 'a'.repeat(64), signature: 'b'.repeat(128),
    };
    await writeFile(p, JSON.stringify(m));
    const r = await readAndVerify(p);
    expect(r.manifest.harness).toBe('x');
    expect(r.result.valid).toBe(true);
  });
});
