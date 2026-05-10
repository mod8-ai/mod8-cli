/**
 * Small text helpers shared across the routing matchers.
 */

/** Levenshtein edit distance.  O(|a|·|b|) time, O(min(|a|,|b|)) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const an = a.length;
  const bn = b.length;
  let prev = new Array<number>(bn + 1);
  let curr = new Array<number>(bn + 1);
  for (let j = 0; j <= bn; j++) prev[j] = j;
  for (let i = 1; i <= an; i++) {
    curr[0] = i;
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bn]!;
}

/** Variants of "key" / synonyms.  Used to fuzzy-match typo'd nouns like "kew" / "kee" / "keey". */
const KEY_NOUN_VARIANTS = [
  'key', 'keys',
  'credentials', 'credential',
  'secret', 'secrets',
  'token', 'tokens',
  'apikey', 'api-key',
];

/**
 * True when the word LOOKS like the user meant "key" (or a synonym) —
 * accepts exact matches AND single-edit typos like "kew" / "kee" / "kez".
 *
 * Used by the paste-key intent matcher: phrases like "change the google
 * kew" should still trigger the inline paste flow even though "kew" is
 * mistyped.
 */
export function looksLikeKeyNoun(word: string): boolean {
  const lower = word.toLowerCase().replace(/[!?.,]+$/, '');
  if (lower.length < 2 || lower.length > 16) return false;
  for (const v of KEY_NOUN_VARIANTS) {
    if (levenshtein(lower, v) <= 1) return true;
  }
  return false;
}
