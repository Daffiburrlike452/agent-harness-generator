// SPDX-License-Identifier: MIT
//
// End-to-end scaffold test. Runs the full pipeline against the minimal and
// vertical:devops templates in a tmp directory, then asserts the output
// has the structure we expect.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, detectRufloProject, parseArgs } from '../src/index.js';

async function tmpRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('scaffold (e2e)', () => {
  it('scaffolds the minimal template into a tmp dir', async () => {
    const root = await tmpRoot('e2e-min-');
    const target = join(root, 'my-bot');
    const r = await scaffold({
      name: 'my-bot',
      template: 'minimal',
      host: 'claude-code',
      description: 'test bot',
      targetDir: target,
      generatorVersion: '0.1.0',
    });

    expect(r.paths.length).toBeGreaterThan(0);
    expect(r.paths).toContain('package.json');
    expect(r.paths).toContain('CLAUDE.md');
    expect(r.paths).toContain('.harness/manifest.json');
    expect(r.paths).toContain('.harness/manifest.sha256');
    expect(r.unresolved).toEqual([]);

    const pkg = await readFile(join(target, 'package.json'), 'utf-8');
    expect(pkg).toContain('"name": "my-bot"');
    expect(pkg).toContain('@ruflo/host-claude-code');

    const claudeMd = await readFile(join(target, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# my-bot');
    expect(claudeMd).toContain('test bot');

    const manifest = JSON.parse(
      await readFile(join(target, '.harness', 'manifest.json'), 'utf-8'),
    );
    expect(manifest.schema).toBe(1);
    expect(manifest.template).toBe('minimal');
    expect(manifest.vars.name).toBe('my-bot');
    expect(manifest.hosts).toEqual(['claude-code']);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0);
  });

  it('scaffolds the vertical:devops template with 4 agent files', async () => {
    const root = await tmpRoot('e2e-devops-');
    const target = join(root, 'ops-bot');
    const r = await scaffold({
      name: 'ops-bot',
      template: 'vertical:devops',
      host: 'claude-code',
      targetDir: target,
      generatorVersion: '0.1.0',
    });
    expect(r.paths).toContain('src/agents/responder.ts');
    expect(r.paths).toContain('src/agents/runbook-runner.ts');
    expect(r.paths).toContain('src/agents/escalator.ts');
    expect(r.paths).toContain('src/agents/postmortem.ts');
    expect(r.paths).toContain('runbooks/README.md');

    const responder = await readFile(join(target, 'src/agents/responder.ts'), 'utf-8');
    expect(responder).toContain('on-call responder for ops-bot');

    const settings = JSON.parse(
      await readFile(join(target, '.claude/settings.json'), 'utf-8'),
    );
    expect(settings.mcpServers['ops-bot']).toBeDefined();
    expect(settings.mcpServers.alerts).toBeDefined();
    expect(settings.mcpServers.runbook_store).toBeDefined();
    // Sanity-check the deny list.
    expect(settings.permissions.deny).toContain('Bash(rm *)');
  });

  it('refuses to overwrite an existing dir without --force', async () => {
    const root = await tmpRoot('e2e-noforce-');
    const target = join(root, 'my-bot');
    await scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    });
    await expect(scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    })).rejects.toThrow(/already exists/);
  });

  it('overwrites with --force', async () => {
    const root = await tmpRoot('e2e-force-');
    const target = join(root, 'my-bot');
    await scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, generatorVersion: '0.1.0',
    });
    const r = await scaffold({
      name: 'my-bot', template: 'minimal', host: 'claude-code',
      targetDir: target, force: true, generatorVersion: '0.1.0',
    });
    expect(r.paths.length).toBeGreaterThan(0);
  });

  it('rejects an invalid harness name early', async () => {
    const root = await tmpRoot('e2e-bad-');
    await expect(scaffold({
      name: 'BadName',
      template: 'minimal',
      host: 'claude-code',
      targetDir: join(root, 'BadName'),
      generatorVersion: '0.1.0',
    })).rejects.toThrow(/invalid harness name/);
  });

  it('rejects an unknown template', async () => {
    const root = await tmpRoot('e2e-tpl-');
    await expect(scaffold({
      name: 'x',
      template: 'vertical:not-real',
      host: 'claude-code',
      targetDir: join(root, 'x'),
      generatorVersion: '0.1.0',
    })).rejects.toThrow(/unknown template/);
  });
});

describe('detectRufloProject', () => {
  it('returns found: false on an empty dir', async () => {
    const root = await tmpRoot('e2e-detect-');
    expect(detectRufloProject(root)).toEqual({ found: false, signals: [] });
  });
});

describe('parseArgs — iter 4 additions', () => {
  it('parses --force / -f', () => {
    expect(parseArgs(['x', '-f']).force).toBe(true);
    expect(parseArgs(['x', '--force']).force).toBe(true);
  });

  it('parses --description / -d', () => {
    expect(parseArgs(['x', '-d', 'thing']).description).toBe('thing');
    expect(parseArgs(['x', '--description', 'thing']).description).toBe('thing');
  });

  it('parses --from-existing with an explicit path', () => {
    expect(parseArgs(['--from-existing', '/some/path']).fromExisting).toBe('/some/path');
  });
});
