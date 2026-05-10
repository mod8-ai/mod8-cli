import { createInterface } from 'readline';
import { Writable } from 'stream';

/**
 * Read a line from stdin without echoing characters (password-style).
 *
 * - Non-TTY (piped input): plain readline.
 * - TTY: readline in terminal mode with a muted output stream so typed/pasted
 *   characters don't echo, but the line is still reassembled correctly when
 *   the terminal delivers a long paste in multiple chunks.
 *
 * The earlier hand-rolled raw-mode reader had three bugs that combined to
 * truncate pasted input: stdin.resume() called before the data listener was
 * attached (first chunk could be dropped), setEncoding after resume, and no
 * cross-chunk reassembly. readline handles all of that internally.
 */
/**
 * Read a single line from stdin (echoed). Optional default returned if user
 * presses Enter without typing.
 */
export async function readLine(promptText: string, fallback = ''): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });
  return new Promise((resolve) => {
    rl.question(promptText, (line) => {
      rl.close();
      const value = line.trim();
      resolve(value === '' ? fallback : value);
    });
  });
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '*'.repeat(Math.max(key.length, 4));
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    stdout.write(promptText);
    return new Promise((resolve) => {
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
    });
  }

  // Muted writable so readline's terminal mode doesn't echo characters.
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const rl = createInterface({
    input: stdin,
    output: muted,
    terminal: true,
  });

  stdout.write(promptText);

  return new Promise((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      stdout.write('\n');
      resolve(line);
    });
    rl.once('SIGINT', () => {
      rl.close();
      stdout.write('\n');
      process.exit(130);
    });
  });
}

/**
 * Yes/no prompt. Returns true only if the answer starts with 'y' or 'Y'.
 * Uses readline for both TTY and non-TTY so paste/edit behavior is identical.
 */
export async function confirm(promptText: string): Promise<boolean> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    stdout.write(promptText);
    return new Promise((resolve) => {
      rl.once('line', (line) => {
        rl.close();
        resolve(/^y/i.test(line.trim()));
      });
    });
  }

  // TTY path: readline in terminal mode (chars echo so the user can see y/n)
  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(/^y/i.test(answer.trim()));
    });
    rl.once('SIGINT', () => {
      rl.close();
      stdout.write('\n');
      process.exit(130);
    });
  });
}
