import { promises as fs } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import yaml from 'js-yaml';
import { runDrive } from '../drive/runner.js';
import type { DriveScript } from '../drive/types.js';

export interface DriveOptions {
  json?: boolean;
  quiet?: boolean;
}

function validate(raw: unknown, path: string): DriveScript {
  const s = raw as Partial<DriveScript>;
  if (!s || typeof s !== 'object') {
    throw new Error(`${path}: not a YAML object`);
  }
  if (!s.name) throw new Error(`${path}: missing "name"`);
  if (!Array.isArray(s.steps) || s.steps.length === 0) {
    throw new Error(`${path}: needs at least one entry under "steps"`);
  }
  s.steps.forEach((step, i) => {
    if (typeof step?.send !== 'string') {
      throw new Error(`${path}: steps[${i}] is missing "send"`);
    }
    // Unknown assertion keys are a silent-failure trap — a typo'd key would
    // otherwise look like a passing check.  Reject them loudly instead.
    const allowed = new Set([
      'reply_contains',
      'reply_omits',
      'reply_matches',
      'tool_used',
      'mode',
      'silent',
    ]);
    for (const key of Object.keys(step.expect ?? {})) {
      if (!allowed.has(key)) {
        throw new Error(
          `${path}: steps[${i}].expect has unknown key "${key}". ` +
            `Valid: ${[...allowed].join(', ')}`
        );
      }
    }
  });
  return s as DriveScript;
}

export async function driveCommand(
  scriptPath: string,
  opts: DriveOptions = {}
): Promise<void> {
  const path = resolve(scriptPath);
  let script: DriveScript;
  try {
    script = validate(yaml.load(await fs.readFile(path, 'utf8')), scriptPath);
  } catch (err) {
    console.error(
      chalk.red('mod8 drive: ') + (err instanceof Error ? err.message : String(err))
    );
    process.exit(1);
  }

  if (!opts.json && !opts.quiet) {
    console.log(chalk.bold(`\n${script.name}`));
    if (script.description) console.log(chalk.dim(script.description.trim()));
    console.log('');
  }

  const result = await runDrive(script);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  for (const step of result.steps) {
    const mark = step.ok ? chalk.green('✓') : chalk.red('✗');
    const secs = (step.durationMs / 1000).toFixed(1);
    console.log(
      `  ${mark} ${step.label}  ${chalk.dim(`${step.mode} · ${secs}s`)}`
    );
    if (!opts.quiet && step.reply) {
      for (const line of step.reply.split('\n').slice(0, 6)) {
        console.log(chalk.dim(`      │ ${line}`));
      }
    }
    if (step.tools.length && !opts.quiet) {
      console.log(chalk.dim(`      tools: ${step.tools.join(', ')}`));
    }
    for (const f of step.failures) {
      console.log(chalk.red(`      → ${f}`));
    }
  }

  const passed = result.steps.filter((s) => s.ok).length;
  const total = result.steps.length;
  const secs = (result.durationMs / 1000).toFixed(1);
  console.log('');
  console.log(
    result.ok
      ? chalk.green(`  ${passed}/${total} steps passed`) + chalk.dim(` · ${secs}s`)
      : chalk.red(`  ${passed}/${total} steps passed`) + chalk.dim(` · ${secs}s`)
  );
  console.log('');
  process.exit(result.ok ? 0 : 1);
}
