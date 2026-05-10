import { resolveFileRefs } from './files.js';

export interface ComposedPrompt {
  finalPrompt: string;
  warnings: string[];
}

/**
 * Build the final prompt sent to providers.
 *
 * Layout:
 *   <user prompt>
 *
 *   [file: path1]
 *   <content of path1>
 *
 *   [file: path2]
 *   <content of path2>
 *
 *   <piped stdin content>
 *
 * @file refs that fail to load become warnings (and are left in-place in the prompt).
 */
export async function composePrompt(
  prompt: string,
  stdin: string | undefined
): Promise<ComposedPrompt> {
  const warnings: string[] = [];
  const sections: string[] = [prompt.trimEnd()];

  const refs = await resolveFileRefs(prompt);
  for (const ref of refs) {
    if (ref.content !== undefined) {
      sections.push('');
      sections.push(`[file: ${ref.path}]`);
      sections.push(ref.content.trimEnd());
    } else {
      warnings.push(`@${ref.path}: ${ref.error}`);
    }
  }

  if (stdin && stdin.trim()) {
    sections.push('');
    sections.push(stdin.trimEnd());
  }

  return { finalPrompt: sections.join('\n'), warnings };
}
