/**
 * `mod8 logout` — drop the saved mod8 credentials.  The CLI falls back to
 * local providers.json for subsequent requests.
 */

import chalk from 'chalk';
import { deleteAuth, AUTH_FILE_PATH } from '../storage/auth.js';

export async function logoutCommand(): Promise<void> {
  const removed = await deleteAuth();
  if (removed) {
    process.stdout.write(
      `${chalk.green('✓')} Logged out — ${chalk.dim(AUTH_FILE_PATH)} removed.\n` +
        chalk.dim('Falling back to local providers.json.\n')
    );
  } else {
    process.stdout.write(
      chalk.dim('Not logged in.\n') +
        chalk.dim(`No file at ${AUTH_FILE_PATH}.\n`)
    );
  }
}
