import { runVerify } from '../verify/runner.js';

export async function verifyCommand(): Promise<void> {
  const summary = await runVerify();
  process.exit(summary.fail > 0 ? 1 : 0);
}
