// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { emptyManifest, sha256, fingerprintFiles, diffFingerprints } from '../src/manifest.js';

describe('emptyManifest', () => {
  it('sets schema=1, generator, template, empty vars and files', () => {
    const m = emptyManifest('minimal', '0.1.0');
    expect(m.schema).toBe(1);
    expect(m.template).toBe('minimal');
    expect(m.generator).toBe('0.1.0');
    expect(m.files).toEqual({});
    expect(m.hosts).toEqual([]);
  });

  it('emits an ISO-8601 timestamp', () => {
    const m = emptyManifest('x', '0.1.0');
    expect(m.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('sha256', () => {
  it('hashes "hello" to 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', () => {
    expect(sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('is deterministic across calls', () => {
    expect(sha256('a')).toBe(sha256('a'));
  });
});

describe('fingerprintFiles', () => {
  it('hashes each file independently', () => {
    const fp = fingerprintFiles({ 'a.txt': 'hello', 'b.txt': 'world' });
    expect(fp['a.txt']).toBe(sha256('hello'));
    expect(fp['b.txt']).toBe(sha256('world'));
  });
});

describe('diffFingerprints (drift detection)', () => {
  it('reports added/removed/changed paths', () => {
    const a = { common: 'aaa', removed: 'rrr' };
    const b = { common: 'AAA', added: 'add' };
    const d = diffFingerprints(a, b);
    expect(d.added).toEqual(['added']);
    expect(d.removed).toEqual(['removed']);
    expect(d.changed).toEqual(['common']);
  });

  it('returns empty arrays for identical inputs', () => {
    expect(diffFingerprints({ x: 'y' }, { x: 'y' })).toEqual({
      added: [], removed: [], changed: [],
    });
  });

  it('sorts paths lexicographically', () => {
    const d = diffFingerprints({}, { z: 'z', a: 'a', m: 'm' });
    expect(d.added).toEqual(['a', 'm', 'z']);
  });
});
