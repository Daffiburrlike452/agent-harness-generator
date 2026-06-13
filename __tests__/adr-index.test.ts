// SPDX-License-Identifier: MIT
//
// Pins the ADR index against the actual files in docs/adrs/.
// Catches the regression where an ADR ships but isn't indexed (or
// the index claims an ADR that doesn't exist).

import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ADR_DIR = join(process.cwd(), 'docs', 'adrs');

describe('docs/adrs/INDEX.md', () => {
  it('every ADR-*.md file in the directory is listed in INDEX.md', async () => {
    const entries = await readdir(ADR_DIR);
    const adrFiles = entries.filter(f => /^ADR-[\d.a-z]+-.+\.md$/.test(f));
    const index = await readFile(join(ADR_DIR, 'INDEX.md'), 'utf-8');
    const missing: string[] = [];
    for (const f of adrFiles) {
      // INDEX references look like [ADR-019](./ADR-019-release-orchestration.md)
      if (!index.includes(`(./${f})`)) missing.push(f);
    }
    expect(missing, `unlisted ADRs: ${missing.join(', ')}`).toEqual([]);
  });

  it('every ADR file referenced in INDEX.md actually exists', async () => {
    const index = await readFile(join(ADR_DIR, 'INDEX.md'), 'utf-8');
    const refs = [...index.matchAll(/\.\/(ADR-[\d.a-z]+-[\w-]+\.md)/g)].map(m => m[1]);
    const dangling: string[] = [];
    for (const r of new Set(refs)) {
      const { existsSync } = await import('node:fs');
      if (!existsSync(join(ADR_DIR, r))) dangling.push(r);
    }
    expect(dangling, `dangling ADR refs in INDEX: ${dangling.join(', ')}`).toEqual([]);
  });

  it('every ADR has the canonical sections (Status, Context, Decision, Consequences)', async () => {
    const entries = await readdir(ADR_DIR);
    const adrFiles = entries.filter(f => /^ADR-[\d.a-z]+-.+\.md$/.test(f));
    for (const f of adrFiles) {
      const content = await readFile(join(ADR_DIR, f), 'utf-8');
      expect(content, `${f} missing Status`).toMatch(/\*\*Status\*\*/);
      expect(content, `${f} missing Context section`).toMatch(/## Context/);
      expect(content, `${f} missing Decision section`).toMatch(/## Decision/);
      expect(content, `${f} missing Consequences section`).toMatch(/## Consequences/);
    }
  });
});
