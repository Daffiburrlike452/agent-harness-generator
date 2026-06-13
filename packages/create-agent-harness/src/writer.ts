// SPDX-License-Identifier: MIT
//
// Filesystem writer. Atomically writes a RenderedFile[] to disk under a
// target directory. "Atomic" here means: stage everything in a temp dir,
// then rename to the target on success. A failure mid-stream leaves the
// target untouched.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { RenderedFile } from './walker.js';

export interface WriteOptions {
  /** Overwrite an existing directory? Defaults to false (refuse to overwrite). */
  force?: boolean;
}

/**
 * Write a RenderedFile[] to `targetDir`. Stages in a temp dir first; only
 * renames into place on success.
 *
 * Returns the list of paths written (relative to targetDir).
 */
export async function writeAtomic(
  targetDir: string,
  files: RenderedFile[],
  opts: WriteOptions = {},
): Promise<string[]> {
  if (existsSync(targetDir) && !opts.force) {
    throw new Error(`${targetDir} already exists. Pass --force to overwrite.`);
  }

  const staging = join(tmpdir(), `create-agent-harness-${randomBytes(6).toString('hex')}`);
  await mkdir(staging, { recursive: true });

  try {
    for (const f of files) {
      const dst = join(staging, ...f.path.split('/'));
      await mkdir(dirname(dst), { recursive: true });
      await writeFile(dst, f.content, 'utf-8');
    }

    if (existsSync(targetDir) && opts.force) {
      await rm(targetDir, { recursive: true, force: true });
    }
    await mkdir(dirname(targetDir), { recursive: true });
    await rename(staging, targetDir);
  } catch (err) {
    // Best-effort cleanup; ignore failures in the cleanup itself.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return files.map(f => f.path);
}
