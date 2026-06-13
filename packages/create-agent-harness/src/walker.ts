// SPDX-License-Identifier: MIT
//
// Recursive template walker. Walks a templates/<id>/ directory, renders
// every .tmpl file through the Mustache engine, and emits a flat
// path -> content map keyed by the destination paths.
//
// Convention (per templates/minimal/manifest.json files[].src/dst):
//   - <file>.tmpl  -> render through Mustache, drop the .tmpl suffix
//   - <file>      -> copy verbatim (binary-safe via Uint8Array)
//
// The walker does NOT touch the filesystem of the destination — it returns
// an in-memory map. The CLI commits to disk in a single batch so failures
// can roll back atomically (ADR-008 §atomic-generation).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import { render, type TemplateVars } from './renderer.js';

export interface RenderedFile {
  /** Posix-style relative path inside the destination directory. */
  path: string;
  /** Final UTF-8 content. */
  content: string;
  /** Did this file go through the Mustache renderer? */
  rendered: boolean;
  /** Variables that were referenced but had no value. Empty = clean render. */
  unresolved: string[];
}

/** Normalise OS-specific separators to posix for stable manifest keys. */
function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

/**
 * Walk a template directory and return one RenderedFile per file found.
 * Throws on any file with unresolved vars when `strict` is true.
 */
export async function walkTemplate(
  templateDir: string,
  vars: TemplateVars,
  opts: { strict?: boolean } = {},
): Promise<RenderedFile[]> {
  const out: RenderedFile[] = [];
  await walk(templateDir, templateDir, vars, out);
  if (opts.strict) {
    const offenders = out.filter(f => f.unresolved.length > 0);
    if (offenders.length > 0) {
      const list = offenders.map(o => `  ${o.path}: ${o.unresolved.join(', ')}`).join('\n');
      throw new Error(`Template has unresolved variables (strict mode):\n${list}`);
    }
  }
  return out;
}

async function walk(
  root: string,
  current: string,
  vars: TemplateVars,
  out: RenderedFile[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const e of entries) {
    const full = join(current, e.name);
    if (e.isDirectory()) {
      await walk(root, full, vars, out);
      continue;
    }
    if (!e.isFile()) continue;
    const rel = toPosix(relative(root, full));
    if (rel.endsWith('/manifest.json') || rel === 'manifest.json') continue;
    if (rel.endsWith('.tmpl')) {
      const raw = await readFile(full, 'utf-8');
      const { output, unresolved } = render(raw, vars);
      out.push({
        path: rel.slice(0, -'.tmpl'.length),
        content: output,
        rendered: true,
        unresolved,
      });
    } else {
      const raw = await readFile(full, 'utf-8');
      out.push({ path: rel, content: raw, rendered: false, unresolved: [] });
    }
  }
}

/**
 * Convert a RenderedFile[] to the flat path -> content map that
 * fingerprintFiles() in manifest.ts expects.
 */
export function asFileMap(files: RenderedFile[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f.path] = f.content;
  return out;
}
