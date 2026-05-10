import { promises as fs } from 'fs';
import { resolve, isAbsolute } from 'path';
import { homedir } from 'os';

const MAX_FILE_BYTES = 100_000;

export interface FileRef {
  path: string;
  content?: string;
  error?: string;
}

/**
 * Find @<path> references in a prompt and load the matching files.
 * - Strips trailing punctuation (.,;:!?)
 * - Expands ~ and resolves relative paths against cwd
 * - Refuses files larger than 100KB
 * - Returns one entry per reference (with content or error message)
 */
export async function resolveFileRefs(prompt: string): Promise<FileRef[]> {
  const matches = [...prompt.matchAll(/@([^\s]+)/g)];
  const seen = new Set<string>();
  const results: FileRef[] = [];

  for (const m of matches) {
    let pathSpec = m[1]!.replace(/[.,;:!?]+$/, '');
    if (!pathSpec || seen.has(pathSpec)) continue;
    seen.add(pathSpec);

    let resolved = pathSpec;
    if (resolved.startsWith('~/')) {
      resolved = homedir() + resolved.slice(1);
    } else if (!isAbsolute(resolved)) {
      resolved = resolve(process.cwd(), resolved);
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        results.push({ path: pathSpec, error: 'not a regular file' });
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        results.push({
          path: pathSpec,
          error: `too large (${stat.size} bytes; limit ${MAX_FILE_BYTES})`,
        });
        continue;
      }
      const content = await fs.readFile(resolved, 'utf8');
      results.push({ path: pathSpec, content });
    } catch {
      results.push({ path: pathSpec, error: 'not found' });
    }
  }

  return results;
}
