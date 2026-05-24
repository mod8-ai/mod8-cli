/**
 * Minimal HTML → markdown stripper for the `web_fetch` tool.  Hand-rolled
 * (no turndown / readability dep) because the goal is "good enough for a
 * model to read a page", not pixel-perfect fidelity.
 *
 * Strips scripts/styles/svgs/comments, converts headings, links, lists,
 * paragraphs, line breaks, and decodes the common HTML entities.  Anything
 * else falls through as plain text.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

export function htmlToMarkdown(html: string): string {
  let s = html;
  // Drop non-content blocks wholesale.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, (block) => {
    // Keep the <title> so the model knows what page it's looking at.
    const m = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return m ? `<h1>${m[1]}</h1>` : '';
  });

  // Links: <a href="X">text</a> → [text](X)
  s = s.replace(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, text) => `[${stripTags(text).trim() || href}](${href})`
  );
  // Images: <img alt="..." src="X"> → ![alt](X)
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? '';
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ?? '';
    return src ? `![${alt}](${src})` : '';
  });

  // Headings.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const hashes = '#'.repeat(Number(level));
    return `\n\n${hashes} ${stripTags(inner).trim()}\n\n`;
  });
  // List items.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `- ${stripTags(inner).trim()}\n`);
  // Paragraphs / breaks.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<\/(div|section|article|tr|td|th|ul|ol|table|pre|blockquote)>/gi, '\n');
  // Code spans and blocks.
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${stripTags(inner)}\``);
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\`\`\`\n${stripTags(inner)}\n\`\`\`\n`);

  // Strip whatever tags are left.
  s = stripTags(s);
  s = decodeEntities(s);

  // Collapse runs of whitespace, but preserve paragraph breaks.
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}
