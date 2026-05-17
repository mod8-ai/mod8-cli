/**
 * Project identity derivation for the mod8.ai Projects dashboard.
 *
 * Given a working directory, returns a stable identifier + display name
 * + auto-detected stack tags + icon.  Sent with every run-tracking call
 * to the mod8 proxy so the backend can aggregate token spend, provider
 * mix, and topic distribution PER PROJECT — turning the dashboard from
 * "how much money did I spend?" into "what did I build with mod8?".
 *
 * Order of resolution:
 *   1. If `<cwd>/.mod8/project.yaml` exists → read explicit name/desc/icon.
 *   2. Else: walk up to find a git root, use its basename as the name.
 *   3. Else: use the cwd basename directly.
 *
 * Stack detection probes well-known manifest files (package.json,
 * pyproject.toml, Gemfile, Cargo.toml, etc.) — cheap, deterministic,
 * runs in <10ms.  Falls back to "general" when nothing matches.
 *
 * All file reads are best-effort; failures degrade to defaults rather
 * than throwing — the goal is "always return SOMETHING usable" so
 * telemetry never blocks on disk hiccups.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { load as parseYaml } from 'js-yaml';

export interface ProjectInfo {
  /** Stable hash of the canonical project path — used as the Firestore
   *  document key.  SHA-256 truncated to 16 hex chars (~64 bits) is more
   *  than enough collision resistance for per-user project counts. */
  projectId: string;
  /** Human-readable name: from .mod8/project.yaml > git root basename
   *  > cwd basename.  Always non-empty. */
  projectName: string;
  /** Optional one-line description from .mod8/project.yaml.  Empty
   *  string when not set — backend treats as null. */
  description: string;
  /** Auto-detected stack tags, e.g. ['nextjs', 'react', 'supabase'].
   *  Empty array when nothing detected.  Used for the dashboard card
   *  subtitle ("Next.js · property management"). */
  stack: string[];
  /** Optional emoji icon from .mod8/project.yaml.  Defaults to '📁'. */
  icon: string;
  /** Canonical path the projectId was derived from — git root if found,
   *  else cwd.  Exposed for debugging; not sent to backend. */
  resolvedRoot: string;
}

/** Maximum walk-up depth when searching for a git root or .mod8 marker.
 *  Prevents pathological loops on weird filesystems. */
const MAX_WALK_UP = 12;

export async function getProjectInfo(cwd: string): Promise<ProjectInfo> {
  const root = await findProjectRoot(cwd);
  const explicit = await readExplicitProjectConfig(root);
  const stack = await detectStack(root);
  const fallbackName = basename(root) || 'mod8-project';
  const name = explicit?.name?.trim() || fallbackName;
  const description = explicit?.description?.trim() || '';
  const icon = explicit?.icon?.trim() || '📁';
  const projectId = hashRoot(root);
  return { projectId, projectName: name, description, stack, icon, resolvedRoot: root };
}

/** Walk up from cwd looking for a .mod8/project.yaml or a .git directory.
 *  The first marker we hit defines the project root.  If neither exists,
 *  the project root IS the cwd (fresh directory, no metadata yet). */
async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (let depth = 0; depth < MAX_WALK_UP; depth++) {
    if (
      existsSync(join(current, '.mod8', 'project.yaml')) ||
      existsSync(join(current, '.git'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break; // hit filesystem root
    current = parent;
  }
  return resolve(cwd);
}

async function readExplicitProjectConfig(
  root: string
): Promise<{ name?: string; description?: string; icon?: string } | null> {
  const path = join(root, '.mod8', 'project.yaml');
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      return {
        name: typeof o.name === 'string' ? o.name : undefined,
        description: typeof o.description === 'string' ? o.description : undefined,
        icon: typeof o.icon === 'string' ? o.icon : undefined,
      };
    }
  } catch {
    /* missing or malformed — fall through to defaults */
  }
  return null;
}

/** Best-effort stack detection from common manifest files at the root.
 *  Returns short tag strings the dashboard can render as chips. */
async function detectStack(root: string): Promise<string[]> {
  const tags: string[] = [];
  const has = (p: string) => existsSync(join(root, p));

  // Node ecosystem
  if (has('package.json')) {
    tags.push('node');
    try {
      const pkg = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'));
      const deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (deps.next) tags.push('nextjs');
      else if (deps.react) tags.push('react');
      if (deps.vue) tags.push('vue');
      if (deps.svelte) tags.push('svelte');
      if (deps['@supabase/supabase-js']) tags.push('supabase');
      if (deps.firebase || deps['firebase-admin']) tags.push('firebase');
      if (deps.express || deps.fastify) tags.push('node-api');
      if (deps.tailwindcss) tags.push('tailwind');
      if (deps.expo || deps['react-native']) tags.push('react-native');
      if (deps.typescript) tags.push('typescript');
    } catch {
      /* malformed package.json — keep just 'node' */
    }
  }

  // Python
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    tags.push('python');
  }

  // Other ecosystems
  if (has('Gemfile')) tags.push('ruby');
  if (has('Cargo.toml')) tags.push('rust');
  if (has('go.mod')) tags.push('go');
  if (has('Package.swift') || has('Podfile')) tags.push('swift');
  if (has('pom.xml') || has('build.gradle')) tags.push('java');

  // Infra
  if (has('Dockerfile')) tags.push('docker');
  if (has('supabase') && existsSync(join(root, 'supabase', 'schema.sql'))) {
    if (!tags.includes('supabase')) tags.push('supabase');
  }

  return tags;
}

/** Stable, short-ish hash of the resolved project root path.  Used as
 *  the Firestore document id so the same physical project always
 *  aggregates into the same record, even across machines (if the user
 *  cloned the same repo path twice — fine, they'd share stats). */
function hashRoot(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}
