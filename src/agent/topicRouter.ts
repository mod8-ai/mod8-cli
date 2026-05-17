/**
 * Topic-aware provider recommendation.
 *
 * Classifies a user prompt into a coarse work-category (frontend-ui,
 * backend-api, database, devops, refactor, bug-fix, testing,
 * documentation, general) and proposes WHICH OF YOUR CONFIGURED PROVIDERS
 * to use for that category.
 *
 * When a topic shift fires, the chat layer renders a full 4-row
 * comparison table — Speed / $/turn / Code / Performance / Why — so the
 * user sees the tradeoffs across all their providers, not just a single
 * suggestion.
 *
 * NO LLM call.  Pure keyword classification + a curated rating table.
 * Updates as new model generations land.
 */

import { priceFor, formatCost } from '../providers/pricing.js';
import { preferredProviderFor, type RoutingPrefs } from './routingPrefs.js';

export type Topic =
  | 'frontend-ui'
  | 'backend-api'
  | 'database'
  | 'devops'
  | 'refactor'
  | 'bug-fix'
  | 'testing'
  | 'documentation'
  | 'general';

/** Star rating, 1-5.  Rendered as solid + empty stars. */
export type Stars = 1 | 2 | 3 | 4 | 5;

/** One row in the comparison table.  Stars are CURATED per (provider,
 *  topic) — claude's code stars for frontend-ui are not the same as
 *  claude's code stars for database work.  This is what mod8 does that
 *  OpenRouter does not. */
export interface ProviderOption {
  /** Canonical provider id used by mod8 routing (anthropic / openai / google / deepseek). */
  provider: string;
  /** Display label shown in the comparison panel. */
  label: string;
  /** Default model id mod8 would use — drives the $/turn calculation. */
  model: string;
  /** Generation speed for THIS topic (token-throughput-relative). */
  speed: Stars;
  /** Code-writing quality for THIS topic specifically. */
  code: Stars;
  /** General reasoning ability (mostly topic-agnostic, included for completeness). */
  performance: Stars;
  /** One-line "why pick this for THIS task" — max ~45 chars to fit table. */
  why: string;
}

interface TopicProfile {
  keywords: string[];
  rideAlong: boolean;
  /** Typical tokens consumed per agent turn for this topic — drives the
   *  $/turn calculation in the comparison panel.  Rough numbers based on
   *  observed agent traffic; refine over time with real telemetry. */
  typicalInputTokens: number;
  typicalOutputTokens: number;
  /** How many turns it usually takes to ship "one unit" of this kind of
   *  work (e.g. one new page, one new route).  Drives the "per task"
   *  total in the panel footer. */
  typicalTurnsPerTask: number;
  /** Ranked options for this topic — index 0 is the recommended choice.
   *  Only populated for non-ride-along topics. */
  options: ProviderOption[];
}

/** Curated topic table.  Per-(provider, topic) code stars + "why" lines
 *  are deliberately opinionated — they reflect what each model is
 *  actually best at, not just generic capability ratings.
 *
 *  Order matters: the classifier picks the FIRST topic to reach the max
 *  score, so ride-along categories (bug-fix / testing / documentation /
 *  general) are listed FIRST.  That way a tie like "write tests for the
 *  API" resolves to `testing` (ride-along, silent) instead of
 *  `backend-api` (which would wrongly trigger a provider-switch panel
 *  for what is plainly a test-writing task). */
const TOPIC_TABLE: Record<Topic, TopicProfile> = {
  // ── Ride-along categories listed FIRST so they win ties ───────────
  'bug-fix': {
    keywords: [
      'fix this', 'fix the', 'bug', 'debug', 'broken', 'crash', 'failing',
      'error:', 'errored', 'not working', "doesn't work", "doesn't run",
      'stack trace', 'undefined is not',
    ],
    rideAlong: true,
    typicalInputTokens: 0, typicalOutputTokens: 0, typicalTurnsPerTask: 0,
    options: [],
  },
  testing: {
    keywords: [
      ' test ', 'tests ', 'spec.', 'spec ', 'jest', 'pytest', 'vitest',
      'mocha', 'unit test', 'integration test', 'e2e test', 'tdd',
    ],
    rideAlong: true,
    typicalInputTokens: 0, typicalOutputTokens: 0, typicalTurnsPerTask: 0,
    options: [],
  },
  documentation: {
    keywords: [
      'readme', 'docs:', 'documentation', 'jsdoc', 'docstring', 'comments',
      'add a comment',
    ],
    rideAlong: true,
    typicalInputTokens: 0, typicalOutputTokens: 0, typicalTurnsPerTask: 0,
    options: [],
  },
  general: {
    keywords: [],
    rideAlong: true,
    typicalInputTokens: 0, typicalOutputTokens: 0, typicalTurnsPerTask: 0,
    options: [],
  },
  // ── Real topics — these trigger the comparison panel ──────────────
  'frontend-ui': {
    keywords: [
      'react', 'reactjs', 'react.js', 'next.js', 'nextjs', 'vue', 'svelte',
      'css', 'tailwind', 'shadcn', 'button', 'form', 'layout', 'component',
      'page', 'dashboard', 'sidebar', 'modal', 'navbar', 'frontend', 'html',
      'styling', 'design system', 'tsx', 'jsx', 'ui ', 'landing page',
    ],
    rideAlong: false,
    typicalInputTokens: 16_000,
    typicalOutputTokens: 4_000,
    typicalTurnsPerTask: 5,
    options: [
      { provider: 'anthropic', label: 'Claude', model: 'claude-sonnet-4-6',
        speed: 3, code: 5, performance: 5,
        why: 'Best at React, Tailwind, component architecture' },
      { provider: 'openai', label: 'GPT', model: 'gpt-4.1',
        speed: 5, code: 4, performance: 5,
        why: 'Fast iteration, solid React, weaker on Tailwind' },
      { provider: 'google', label: 'Gemini', model: 'gemini-2.5-pro',
        speed: 4, code: 3, performance: 4,
        why: 'Decent UI, less precise CSS' },
      { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat',
        speed: 3, code: 3, performance: 3,
        why: 'Cheapest — expect a review pass' },
    ],
  },
  'backend-api': {
    keywords: [
      'api ', 'endpoint', 'route handler', 'rest api', 'graphql', 'webhook',
      'express', 'fastapi', 'flask', 'middleware', 'jwt', 'oauth', 'rest ',
      'http request', 'http response', 'cors', 'rate limit', 'serverless',
      'cloud function', 'lambda', 'backend',
    ],
    rideAlong: false,
    typicalInputTokens: 12_000,
    typicalOutputTokens: 3_000,
    typicalTurnsPerTask: 3,
    options: [
      { provider: 'openai', label: 'GPT', model: 'gpt-4.1',
        speed: 5, code: 4, performance: 5,
        why: 'Fast + strong on REST / serverless patterns' },
      { provider: 'anthropic', label: 'Claude', model: 'claude-sonnet-4-6',
        speed: 3, code: 5, performance: 5,
        why: 'Higher quality but ~2× slower' },
      { provider: 'google', label: 'Gemini', model: 'gemini-2.5-pro',
        speed: 4, code: 4, performance: 4,
        why: 'Solid for APIs with large context' },
      { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat',
        speed: 3, code: 3, performance: 3,
        why: 'Cheapest — fine for simple routes' },
    ],
  },
  database: {
    keywords: [
      'sql', 'schema', 'postgres', 'mysql', 'mongodb', 'mongo ', 'sqlite',
      'database', 'migration', 'foreign key', 'query plan', 'index',
      'supabase', 'firestore', 'firebase rules', 'prisma', 'orm',
      'rls policy', 'rls ', 'row level security',
    ],
    rideAlong: false,
    typicalInputTokens: 8_000,
    typicalOutputTokens: 2_000,
    typicalTurnsPerTask: 2,
    options: [
      { provider: 'google', label: 'Gemini', model: 'gemini-2.5-pro',
        speed: 4, code: 4, performance: 4,
        why: 'Huge context fits whole schema dumps' },
      { provider: 'anthropic', label: 'Claude', model: 'claude-sonnet-4-6',
        speed: 3, code: 4, performance: 5,
        why: 'Strong on SQL + migrations' },
      { provider: 'openai', label: 'GPT', model: 'gpt-4.1',
        speed: 5, code: 4, performance: 5,
        why: 'Fast queries, weaker on complex joins' },
      { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat',
        speed: 3, code: 3, performance: 3,
        why: 'Cheapest — OK for simple migrations' },
    ],
  },
  devops: {
    keywords: [
      'deploy', 'docker', 'dockerfile', 'kubernetes', 'k8s', 'github actions',
      'gitlab ci', 'circleci', 'env var', 'environment variable',
      'production', 'staging', 'vercel', 'netlify', 'firebase deploy',
      'aws ', 'gcp ', 'azure ', 'terraform', 'ansible', 'helm chart',
      'ci pipeline', 'cd pipeline',
    ],
    rideAlong: false,
    typicalInputTokens: 6_000,
    typicalOutputTokens: 2_000,
    typicalTurnsPerTask: 3,
    options: [
      { provider: 'openai', label: 'GPT', model: 'gpt-4.1',
        speed: 5, code: 4, performance: 5,
        why: 'Best on Bash / CI configs / Docker' },
      { provider: 'anthropic', label: 'Claude', model: 'claude-sonnet-4-6',
        speed: 3, code: 4, performance: 5,
        why: 'Solid but more verbose' },
      { provider: 'google', label: 'Gemini', model: 'gemini-2.5-pro',
        speed: 4, code: 3, performance: 4,
        why: 'OK for GCP / Cloud Run configs' },
      { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat',
        speed: 3, code: 3, performance: 3,
        why: 'Cheap, fine for simple shell scripts' },
    ],
  },
  refactor: {
    keywords: [
      'refactor', 'rename', 'restructure', 'reorganize', 'cleanup',
      'clean up', 'simplify', 'optimize', 'consolidate', 'extract function',
      'extract method', 'rewrite this',
    ],
    rideAlong: false,
    typicalInputTokens: 10_000,
    typicalOutputTokens: 3_000,
    typicalTurnsPerTask: 2,
    options: [
      { provider: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat',
        speed: 3, code: 4, performance: 3,
        why: 'Cheapest — ideal for iterative cleanup' },
      { provider: 'anthropic', label: 'Claude', model: 'claude-sonnet-4-6',
        speed: 3, code: 5, performance: 5,
        why: 'Best at complex restructure' },
      { provider: 'openai', label: 'GPT', model: 'gpt-4.1',
        speed: 5, code: 4, performance: 5,
        why: 'Fast, solid for renames + extracts' },
      { provider: 'google', label: 'Gemini', model: 'gemini-2.5-pro',
        speed: 4, code: 3, performance: 4,
        why: 'OK — big context helps for spread-out edits' },
    ],
  },
};

export function classifyTopic(prompt: string): Topic {
  const text = ` ${prompt.toLowerCase()} `;
  const scores = new Map<Topic, number>();
  for (const [topic, profile] of Object.entries(TOPIC_TABLE) as [Topic, TopicProfile][]) {
    let score = 0;
    for (const kw of profile.keywords) {
      if (text.includes(kw.toLowerCase())) score++;
    }
    if (score > 0) scores.set(topic, score);
  }
  if (scores.size === 0) return 'general';
  let best: Topic = 'general';
  let bestScore = 0;
  for (const [topic, score] of scores) {
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  return best;
}

export function isRideAlong(topic: Topic): boolean {
  return TOPIC_TABLE[topic].rideAlong;
}

/** Returns the full ranked-options comparison for a topic, FILTERED to
 *  the user's configured providers and AUGMENTED with computed $/turn
 *  and $/task numbers.  Returns null for ride-along topics.
 *
 *  When `prefs` is supplied AND the user has a clear preferred provider
 *  for this topic (≥ minPicks), that provider is floated to row 0 — so
 *  the table reflects YOUR routing habits, not just the static
 *  curation.  `staticRecommendedProvider` remembers the curated pick so
 *  the renderer can label the personalized row as "your usual pick" and
 *  the curated row as "mod8 default" when they disagree. */
export function comparisonFor(
  topic: Topic,
  configuredProviderIds: string[],
  prefs?: RoutingPrefs
): {
  topic: Topic;
  topicLabel: string;
  typicalInputTokens: number;
  typicalOutputTokens: number;
  typicalTurnsPerTask: number;
  rows: Array<ProviderOption & { costPerTurnUSD: number; costPerTaskUSD: number }>;
  /** The provider in row 0 — what we are recommending to the user RIGHT NOW. */
  recommendedProvider: string;
  /** The static curated pick (row 0 of the unsorted options).  Equals
   *  recommendedProvider unless personalization re-ranked. */
  staticRecommendedProvider: string;
  /** True when personalization moved a different provider into row 0. */
  isPersonalized: boolean;
} | null {
  const profile = TOPIC_TABLE[topic];
  if (profile.rideAlong || profile.options.length === 0) return null;
  const configured = new Set(configuredProviderIds);
  const visible = profile.options.filter((o) => configured.has(o.provider));
  if (visible.length === 0) return null;
  let rows = visible.map((o) => {
    const costPerTurnUSD = priceFor(
      o.model,
      profile.typicalInputTokens,
      profile.typicalOutputTokens
    );
    return {
      ...o,
      costPerTurnUSD,
      costPerTaskUSD: costPerTurnUSD * profile.typicalTurnsPerTask,
    };
  });
  const staticRecommendedProvider = rows[0]!.provider;
  let isPersonalized = false;
  if (prefs) {
    const preferred = preferredProviderFor(prefs, topic);
    if (preferred && preferred !== staticRecommendedProvider) {
      const idx = rows.findIndex((r) => r.provider === preferred);
      if (idx > 0) {
        const [pick] = rows.splice(idx, 1);
        rows = [pick!, ...rows];
        isPersonalized = true;
      }
    }
  }
  return {
    topic,
    topicLabel: topicDisplayLabel(topic),
    typicalInputTokens: profile.typicalInputTokens,
    typicalOutputTokens: profile.typicalOutputTokens,
    typicalTurnsPerTask: profile.typicalTurnsPerTask,
    rows,
    recommendedProvider: rows[0]!.provider,
    staticRecommendedProvider,
    isPersonalized,
  };
}

function topicDisplayLabel(t: Topic): string {
  switch (t) {
    case 'frontend-ui': return 'frontend / UI work';
    case 'backend-api': return 'backend API work';
    case 'database': return 'database / schema work';
    case 'devops': return 'devops / deployment work';
    case 'refactor': return 'refactor / cleanup work';
    default: return t;
  }
}

/** Render the comparison as a multi-line ASCII table for the chat info
 *  item.  Kept here so the layout logic is co-located with the data
 *  source — chat.tsx just appends the resulting string. */
export function renderComparison(
  c: NonNullable<ReturnType<typeof comparisonFor>>,
  currentProviderId: string
): string {
  const stars = (n: Stars): string => '★'.repeat(n) + '☆'.repeat(5 - n);
  const recommended = c.rows[0]!;
  const staticRow = c.rows.find((r) => r.provider === c.staticRecommendedProvider);
  const lines: string[] = [];
  lines.push(`→ Topic shift detected: ${c.topicLabel}`);
  lines.push(
    `  Typical turn: ~${(c.typicalInputTokens / 1000).toFixed(0)}k tokens · ` +
    `~${c.typicalTurnsPerTask} turns per task`
  );
  if (c.isPersonalized && staticRow) {
    lines.push(
      `  ★ personalized — you usually pick ${recommended.label} for this ` +
      `(mod8's default would be ${staticRow.label})`
    );
  }
  lines.push('');
  // Header
  lines.push(
    '   Provider    Speed    $/turn    Code     Performance   Why'
  );
  lines.push(
    '   ──────────────────────────────────────────────────────────────────'
  );
  for (const r of c.rows) {
    // Marker rules:
    //   ★  → row 0 when personalized (the user's usual pick)
    //   ⭐ → row 0 when not personalized (mod8's static recommendation)
    //   ·  → the static recommendation when it lost its row-0 slot to
    //         personalization (so the user sees both side-by-side)
    let marker = '  ';
    if (r.provider === recommended.provider) {
      marker = c.isPersonalized ? ' ★' : ' ⭐';
    } else if (c.isPersonalized && r.provider === c.staticRecommendedProvider) {
      marker = ' ·';
    }
    const label = r.label.padEnd(9, ' ');
    const speed = stars(r.speed);
    const cost = formatCost(r.costPerTurnUSD).padEnd(8, ' ');
    const code = stars(r.code);
    const perf = stars(r.performance);
    lines.push(`  ${marker} ${label} ${speed}  ${cost} ${code}   ${perf}   ${r.why}`);
  }
  lines.push('');
  // Footer: currently using + savings nudge
  const current = c.rows.find((r) => r.provider === currentProviderId);
  if (current) {
    if (current.provider === recommended.provider) {
      lines.push(`  Currently: ${current.label} (already the recommendation ✓)`);
    } else {
      const saving = current.costPerTaskUSD - recommended.costPerTaskUSD;
      const cheaperLine =
        saving > 0
          ? ` · save ~${formatCost(saving)} per task by switching`
          : '';
      lines.push(`  Currently: ${current.label}${cheaperLine}`);
    }
  }
  const switchTo = c.rows
    .map((r) => `"use ${r.label.toLowerCase()}"`)
    .join(' · ');
  lines.push(`  ${switchTo} · or just keep going`);
  return lines.join('\n');
}
