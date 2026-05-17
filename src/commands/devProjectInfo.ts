/**
 * `mod8 dev:project-info [cwd]` — exposes the pure getProjectInfo()
 * function for behavioral testing.  Prints a one-line JSON record of
 * the derived project identity so specs can assert against id, name,
 * stack tags, and the resolved root.
 *
 * Default cwd = the shell's current working directory, mirroring how
 * the live CLI consumes this function.
 */

import { getProjectInfo } from '../agent/projectInfo.js';

export async function devProjectInfo(cwd?: string): Promise<void> {
  const root = cwd ?? process.cwd();
  const info = await getProjectInfo(root);
  // One JSON line per call so specs can grep specific fields.
  process.stdout.write(
    JSON.stringify({
      projectId: info.projectId,
      projectName: info.projectName,
      description: info.description,
      stack: info.stack,
      icon: info.icon,
      resolvedRoot: info.resolvedRoot,
    }) + '\n'
  );
}
