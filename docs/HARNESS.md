# mod8 Harness

**mod8 Harness is the layer that lets software build, improve, market, operate, and learn from itself.**

Most AI coding tools wrap one model. mod8 already wraps four (Claude, GPT, Gemini, DeepSeek) and picks the right one per task. The Harness goes one step further: instead of waiting for you to type a prompt, it continuously **understands the product, ingests signals, proposes improvements, builds safe patches, stages them for your approval, and learns from outcomes** — all while you sleep.

First product it operates on is mod8 itself. The same layer can be pointed at any product via `mod8 connect <slug>`.

---

## Table of contents

1. [Vision](#vision)
2. [The loop in one picture](#the-loop-in-one-picture)
3. [What the Harness improves](#what-the-harness-improves)
4. [How it understands a product](#how-it-understands-a-product)
5. [The 7 phases](#the-7-phases)
6. [Approval Center](#approval-center)
7. [Permission system + autonomy levels](#permission-system--autonomy-levels)
8. [Adapters](#adapters)
9. [Safety — what cannot happen without your approval](#safety--what-cannot-happen-without-your-approval)
10. [Commands](#commands)
11. [Storage layout](#storage-layout)
12. [Connecting other products](#connecting-other-products)
13. [Internals — for contributors](#internals--for-contributors)
14. [Environment variable overrides](#environment-variable-overrides)

---

## Vision

mod8 already saves you money by picking the cheapest model that's good enough. The Harness saves you **time**: it watches what your users say, what your repo does, what your competitors ship, and proposes the next change — with reasons, signals, a diff, tests, and a rollback recipe.

You stay in control. Nothing impactful happens without your explicit approval (until you tell mod8 it can). Every decision is hash-chain audit-logged. The kill switch is one keystroke.

The pitch line:

> *Every other coding tool is the same on day 100 as day 1.*
> *mod8 improves your product every day, because it watched you.*

---

## The loop in one picture

```
                         ┌──────────── ~/.config/mod8/products/<slug>/ ─────────────┐
                         │                                                          │
   external signals ─→ SENSE ──→ memory/* ─→ IDEATE ──→ proposals/ ──→ PRIORITIZE   │
   (GitHub, Stripe,      │      (product +         (LLM, schema-          │         │
    Plausible, support,  │       codebase +         validated, 1-5)       │         │
    inbox-folder, etc)   │       feedback +                               ↓         │
                         │       priors)                              BUILD ←───────│
                         │                                       (git worktree,     │
                         │                                        edit_file/bash    │
                         │                                        tools, tests)     │
                         │                                                          │
                         │                                            ↓             │
                         │     ┌──── approval Panel ←── approvals/pending/ ←─ STAGE │
                         │     │                                                    │
                         │     ↓                                                    │
                         │   ACT  ──→  adapter.apply() (with mandatory rollback)    │
                         │     │                                                    │
                         │     ↓                                                    │
                         │   (wait `policy.cadence.measure_wait_hours`)             │
                         │     ↓                                                    │
                         │   MEASURE ──→ snapshot vs live metric deltas             │
                         │     ↓                                                    │
                         │   LEARN  ──→ Beta-Binomial update on priors.json         │
                         │                                                          │
                         └──────────────────────────────────────────────────────────┘

  Every phase entry checks the kill switch.  Every decision is audit-logged.
  Worktrees live at <repo-root>/.mod8-worktrees/<proposal-id>/ (gitignored).
```

---

## What the Harness improves

**The whole product, not just code.** Each of these is a first-class proposal kind that flows through the same loop:

| Concern | Proposal kind |
|---|---|
| Architecture, bugs, deps, refactors | `refactor` `bug-fix` `feature-add` `dep-bump` `comment-update` |
| Documentation | `doc-update` `readme-update` |
| Terminal UI/UX (Ink panels, status line, transcript) | `ui-ux` |
| Slash command discoverability, intent routing, recovery from typos | `command-ux` |
| First-run, login, key-paste, post-install confusion | `onboarding-ux` |
| Error messages anywhere — clarity, actionability, blame-free framing | `error-copy` |
| Flaky tests, crash recovery, edge cases | `reliability-fix` |
| Website + marketing copy | `website-copy` `marketing-post` `growth-copy` |
| Customer reply drafts | `user-reply` |
| Feature flags, A/B variants | `experiment` |
| Paid growth | `paid-campaign` |
| Positioning, pricing tier shape, what-to-cut | `product-strategy` `roadmap-change` |

If sense surfaces *"users keep hitting a confusing error"* or *"the approval panel is hard to scan"* or *"first-run takes too long"*, those are valid proposals with reasons + signals + previews — exactly like a bug fix.

The split exists so the **learn** phase can track acceptance rates **per category**. Doc updates that always get approved float to the top of the prior; experimental positioning changes that always get rejected get pushed down.

---

## How it understands a product

Product memory is the foundation. Without it, every phase hallucinates. The Harness builds it from these sources:

- **`product.md`** — the only file *you* write by hand. Two pages max. What the product IS, who it's for, what it WON'T do, brand voice, the one metric. **The loop refuses to run if it's missing.** This is intentional: AI shouldn't propose changes to a product it doesn't have a charter for.
- **Codebase scans** — auto-generated each tick:
  - `architecture.md` — directory layout + LOC per area + top dependencies
  - `hotpaths.json` — files most-touched in the last 90 days of git
  - `deps.json` — package.json + lockfile hash snapshot
  - `owners.md` — CODEOWNERS + 90-day contributor map
- **Feedback corpora** — one JSONL per source, dedupe by digest:
  - `inbox-folder.jsonl` — drop any file into `~/.config/mod8/products/<slug>/inbox/` and sense ingests it
  - `github.jsonl` — issues + PRs since last poll
  - `git-local.jsonl` — commits (filters out loop-authored commits via `mod8-loop:` trailer)
  - `intercom.jsonl` / `crisp.jsonl` / `front.jsonl` — support inbox
  - `twitter.jsonl` / `bluesky.jsonl` / `hn.jsonl` / `reddit.jsonl` — mentions
- **Metrics snapshots** — `daily.jsonl` per source (plausible / posthog / ga4 / stripe). Measure phase compares snapshots at act-time vs live.
- **Competitor snapshots** — per-host markdown captures of competitor pages; latest vs previous diff = signal.
- **Priors** — `priors.json` learned per (proposal-kind, signal-source) via Beta-Binomial conjugate updates. Drives ideate calibration ("this kind has 92% acceptance — propose more") and prioritize scoring.

All of this lives in `~/.config/mod8/products/<slug>/memory/`, isolated per product by a `productPath()` runtime assertion that prevents one product's code from accidentally writing to another's directory.

---

## The 7 phases

10 conceptual phases in the mental model (sense → understand → compare → ideate → prioritize → build → stage → wait → act → measure → learn) collapse into 7 code files where they share an output type and a single agent turn:

| Phase | File | What it does | Model? | Output |
|---|---|---|---|---|
| **sense** | `loop/phases/sense.ts` | Polls every source adapter; refreshes codebase memory; drains inbox-folder | none (deterministic) | `SignalBundle` |
| **ideate** | `loop/phases/ideate.ts` | Reads product.md + architecture.md + recent signals + priors; proposes 1-5 improvements | strong reasoner (Sonnet by default) | `Proposal[]` |
| **prioritize** | `loop/phases/prioritize.ts` | Scores each proposal `(impact × confidence × prior) / (risk × effort)`; picks top-1 if ≥1.0 | none (deterministic) | one `Proposal` or null |
| **build** | `loop/phases/build.ts` | Creates `.mod8-worktrees/<id>/`, runs an LLM agent with edit/write/bash tools scoped to the worktree, runs tests + secret scan, captures diff, stages `ApprovalItem` | coder model (Sonnet) | `ApprovalItem` in pending/ |
| **act** | `loop/phases/act.ts` | Triggered out-of-band by Panel approval. Dispatches to adapter.apply(); captures rollback recipe; sets `state.waitUntilTs` | none (deterministic) | `ActionResult` |
| **measure** | `loop/phases/measure.ts` | When `waitUntilTs` elapsed, compare snapshot vs live metrics; judge `intended_outcome_met` from success_criteria grammar | none (deterministic) | `Measurement` |
| **learn** | `loop/phases/learn.ts` | Beta-Binomial update on `priors.json` per kind + per signal source | none (deterministic) | mutated priors.json |

All phases share `loop/runPhase.ts` (kill check + start/complete events + audit + error catch). LLM-using phases also enforce per-phase token budget via a custom `stopWhen` predicate alongside `stepCountIs`.

`act` is intentionally **not** scheduled by the scheduler. It only fires after you (or the daemon, at higher autonomy levels) explicitly approves an item.

---

## Approval Center

Surfaced two ways, same data:

- **`/approvals`** in the REPL — inline panel
- **`mod8 approvals`** — full-screen one-shot

Terminal layout:

```
mod8 approvals — 4 pending  (autonomy: L2 / patch-only)

  ▶ #1  CODE   refactor proxy.ts error path to use explainError consistently
              risk: low · impact: low · 1 file · tests passing
              why: 6 support tickets in the last week confused
                   "proxy: 502" with "no credits"
              preview: edit_file proxy.ts (+12 / −8)
              rollback: git revert <sha>  (recipe pre-computed; mandatory)
              [a]pprove  [r]eject  [e]dit  [w]hy  [s]kip

    #2  DOC    README BYOK section omits the Gemini step
              ...

    #3  COPY   landing-page hero rewrite — current copy buries routing
              risk: medium · impact: high
              ...

    #4  GROWTH HN launch post draft + 3 reply templates
              risk: high · impact: high · affects: external comms
              requires: founder approval (autonomy < L4)
              ...

  filter: all | code | doc | copy | growth | reply | campaign
  ↑↓ navigate  enter expand  q/esc quit
```

**`[w]hy`** expands the reasoning trail: signals consulted, prior acceptance rate for this kind, alternatives the loop considered, why this one won, budget consumed.

**`[e]dit`** moves the item to `pending-revalidation`, lets you tweak structured fields, then re-runs tests + secret scan in the worktree. Item returns to `pending-approval` on green, `revalidation-failed` on red.

**`[a]pprove`** writes the decision to `audit.jsonl`, fires `act` (which dispatches to the relevant adapter and captures a rollback recipe), and archives the item to `approvals/archive/YYYY-MM.jsonl`.

**`[r]eject`** marks rejected, disposes the worktree (`git worktree remove --force` + `git branch -D loop/<id>`), and updates priors (β += 1 for that kind).

---

## Permission system + autonomy levels

One YAML file per product at `~/.config/mod8/products/<slug>/policy.yaml`. Loaded at the top of every tick. Hot-reloads on change.

```yaml
schemaVersion: 1
autonomy: 2                                 # L1-L5 — see table below

budget:
  monthly_usd: 50
  per_tick_usd: 0.50
  per_phase_usd: 0.15
  per_proposal_usd: 5
  per_campaign_usd: 100

repos:
  allowed: [github.com/your-org/your-repo]
  branches:
    protected: [main, release/*]            # auto-merge forbidden, suggest only
    auto_pr_allowed: true
    auto_merge_allowed: false

files:
  protected:                                # change requires explicit approval
    - LICENSE
    - package.json:version
    - src/storage/auth.ts
  off_limits:                               # never proposed
    - .env*
    - "**/*.pem"
    - "**/secrets/*"

social:
  channels:
    twitter: { handle: '@you', post: 'with-approval' }
    linkedin: { post: 'never' }
  rate_limit:
    twitter: { per_day: 3 }

voice:
  banned_phrases: [revolutionary, best-in-class, synergies]
  legal_claims: forbidden
  pricing_claims: approval-required

tests:
  cmd: 'npm test'
  secret_scan_cmd: 'node scripts/scan-secrets.mjs'

cadence:
  sense_every_minutes: 60
  ideate_every_hours: 6
  measure_wait_hours: 168                   # 1 week wait before measure runs

concurrent_worktrees: 3
inherit_from: _defaults                     # org-wide baseline
```

**Autonomy levels (cumulative — `files.protected` + `files.off_limits` ALWAYS override every level):**

| Level | Loop can do without approval | Always requires approval |
|---|---|---|
| **L1 — Suggest only** | Nothing. Every proposal queues. | Everything |
| **L2 — Patch only** | Open branches, write patches, run tests, generate docs | Any merge / push / publish / external post |
| **L3 — Safe autopilot** | L2 + auto-merge docs PRs touching only `/docs/**` or `README.md` with passing tests | Code merges, website outside `/docs`, any external post |
| **L4 — Growth autopilot** | L3 + approved-template social posts within rate limit, SEO publishes to `/blog/`, experiment toggles within budget | Pricing changes, paid ads, legal claims, anything protected |
| **L5 — Full operating** | L4 + paid ads within `daily_cap_usd`, roadmap shuffles, user replies in `auto-reply-low-risk` mode | Pricing changes, performance claims, protected files, legal text |

**Vacation mode:** `mod8 loop pause --until 2026-08-15` writes `paused_until` into the policy; effective autonomy drops to L1 until that date passes.

---

## Adapters

Adapter pattern — one TypeScript module per external system. The loop only knows about the interface; adapters do the auth, marshaling, and rollback.

| Adapter | Kind | What it polls in | What it does out | Rollback API |
|---|---|---|---|---|
| `git-local` | source | local commits (filters loop-authored) | — | — |
| `github` | both | issues + PRs since last poll | open branch + PR (Phase 4) | — |
| `vercel` | source | deploy status | — | — |
| `plausible` | source | daily traffic snapshot | — | — |
| `posthog` | source | DAU + event totals | — | — |
| `ga4` | source | sessions + bounce-rate snapshot | — | — |
| `stripe` | source | MRR + refunds + disputes (read-only) | — | — |
| `hn` | source | Algolia search for watch terms | — (HN has no write API) | — |
| `slack` | sink | — | webhook post | manual |
| `discord` | sink | — | webhook post | **✓ DELETE** |
| `email-imap` | sink | (via inbox-folder) | draft `.eml` or SMTP relay | — |
| `npm` | sink | — | `npm publish` with dry-run preflight | `npm unpublish` (72h window) |
| `intercom` | both | conversations | reply | **✓ DELETE part** |
| `crisp` | both | conversations | reply | manual |
| `front` | both | conversations | reply | manual |
| `twitter` | both | mentions | tweet (with optional reply) | **✓ DELETE** |
| `bluesky` | both | mentions + replies | post record | **✓ deleteRecord** |
| `reddit` | both | subreddit search | comment or submit | **✓ api/del** |

18 adapters total: 14 sources, 10 sinks, 6 with automatic rollback. Every sink that *can* rollback automatically does; the rest declare a manual recipe so the human knows what to undo.

**Auth strategy:** per-product, per-adapter files at `~/.config/mod8/products/<slug>/connectors/<adapter>.json` (mode 0o600). Tokens never centralize — filesystem isolation enforces product-scope by physics, not by code. Use `mod8 connect add-adapter <slug> <adapter>` to paste credentials interactively.

---

## Safety — what cannot happen without your approval

Every rule below is enforced by **code**, not by trusting the LLM.

1. **No auto-merge to protected branches.** Period — even at L5.
2. **All patches in `git worktree` only.** The live working tree is never touched. Approval triggers a controlled merge.
3. **Tests + secret-scan must pass pre-stage.** `policy.tests.cmd` runs in the worktree before staging an `ApprovalItem`. Failure = reject + worktree disposed.
4. **3-layer budget caps** — per-phase / per-tick / per-day — enforced offline + pre-flight + during-stream via custom `stopWhen` predicate. Refuses to proceed within 10% of monthly cap.
5. **Secret scan via `util/secrets.ts::findApiKey`** on every proposed diff. Secret detected = proposal auto-rejected and audit-logged.
6. **Brand-voice filter** on any text destined for external publication. Banned phrases from `policy.voice.banned_phrases` are a hard block at every autonomy level.
7. **Rate limits per channel**, enforced before send, not after.
8. **Kill switch (`~/.config/mod8/STOP` or `MOD8_LOOP_KILL=1`)** honored synchronously at every phase entry + every adapter sink call. `mod8 loop halt` writes it; `mod8 loop resume` clears it.
9. **Audit log is append-only + hash-chained.** Each entry includes prev-digest; tampering visible. `mod8 loop audit verify` re-walks the chain.
10. **Mandatory rollback recipe.** Every `ActionResult` must declare a rollback before execution. Adapters that can't produce one downgrade the action to needs-approval at L+1.
11. **Self-loop guard.** Every loop-authored commit carries a `mod8-loop: <slug>/<proposal-id>` trailer. `git-local.poll` filters these by default so the loop doesn't react to its own work and oscillate.
12. **Approval queue hard cap (50 pending).** Over-cap stage attempts coalesce with similar pending items or auto-reject the lowest-risk pending.
13. **Schema versioning.** Every persisted type carries `schemaVersion`. `approval/migrate.ts` chains pure migrations on read; archive items are never deleted.
14. **Concurrency locks.** `proper-lockfile` on `~/.config/mod8/loop.tick.lock` + per-product `queue.lock` + PID file for daemon. Two `mod8 loop tick` invocations cannot race.
15. **Per-product filesystem isolation.** Every write under `products/<slug>/` goes through `memory/paths.ts::productPath()`, which throws on path-escape attempts. One product can't accidentally write to another's directory.
16. **`npm publish` always requires explicit human approval.** Regardless of autonomy level, even L5.

The single principle: **anything the loop does that affects the world outside your filesystem requires either (a) your explicit approval or (b) a policy you wrote that says it's pre-approved.** Read the policy. Then read it again.

---

## Commands

```bash
# Loop lifecycle
mod8 loop tick                            # run one pass now (cron entry)
mod8 loop start [--foreground]            # daemon (PID file, SIGTERM-handled)
mod8 loop stop                            # SIGTERM the daemon
mod8 loop status                          # last tick, per-phase, signals, spend
mod8 loop logs [--tail 50]                # tail events.jsonl (color-coded)
mod8 loop audit verify                    # re-walk hash chain, report first breach
mod8 loop halt                            # write STOP file (one-key freeze)
mod8 loop resume                          # remove STOP file
mod8 loop pause --until 2026-08-15        # vacation mode (effective autonomy → L1)

# Approvals
mod8 approvals [--kind=code|doc|...]      # full-screen Ink panel

# Multi-product
mod8 connect add <slug>                   # onboarding wizard
mod8 connect list                         # connected products + policy/charter status
mod8 connect remove <slug>                # delete ~/.config/mod8/products/<slug>/
mod8 connect add-adapter <slug> <adapter> # paste credentials interactively

# Marketing role + Friday receipt
mod8 marketing plan [--slug X] [--provider ID]   # draft this week's posts → cards
mod8 marketing status [--slug X]                 # plan age, channels, posts waiting, open questions
mod8 marketing answer [--slug X] <n> <text…>     # answer open question #n (a fact for the next plan)
mod8 connect add-adapter <slug> meta             # paste the Page token + Page id (+ IG account id)
mod8 receipt [-d 7] [-s X] [--raw] [--provider]  # what the Harness did this week

# Web bridge
mod8 sync [--slug X] [--dry-run] [--json]        # push projects + cards to the dashboard, apply web decisions

# In-chat slash commands
/approvals                                # opens the panel without leaving the REPL
/halt                                     # same as `mod8 loop halt`
/projects · /rule <slug>: <text>          # company brain (see below)
/marketing [<slug>] · /marketing plan [<slug>] · /marketing answer <slug> <n> <text> · /receipt
/sync [<slug>]                            # same as `mod8 sync`
```

### Marketing role

The Marketing role is the Harness's first non-code arm.  It never posts on
its own — every post is a card you approve with `[a]`.

```
mod8 marketing plan --slug <slug>     # or /marketing plan [<slug>] in the REPL
mod8 marketing status --slug <slug>   # or /marketing [<slug>]
mod8 approvals --slug <slug>          # the panel; or /approve <apr_id> in the REPL
```

`--slug` (and the REPL slug) default to the connected product whose charter
points at the current folder.

`plan` reads the charter (`products/<slug>/product.md` — voice rules, the one
metric), the connected channels (`connectors/meta.json` ⇒ Facebook +
Instagram), the previous plan and your last decisions (rejected posts become
"do not repeat"), then runs the `marketing` phase (structured LLM output; with
`MOD8_MOCK=1` a deterministic fixture) and writes:

| File | What |
|------|------|
| `products/<slug>/marketing/plan.md` (0600) | positioning, week plan, the posts, open questions |
| `products/<slug>/marketing/questions.jsonl` | append-only `{ts, question, answered}` / `{…, answered:true, answer}` — latest entry per question wins |
| `products/<slug>/approvals/…` | one **card** per post: kind `marketing`, action `social-post` (channel + text); rollback is manual (delete the post on the Page) — re-planning reuses an identical pending card instead of duplicating it |
| `products/<slug>/proposals/…` | the matching `marketing-post` proposal (staged) |

Approving a card dispatches the act phase → the `meta` adapter.  Connect Meta
first with `mod8 connect add-adapter <slug> meta` (Page access token, Page id,
optional Instagram business account id → `connectors/meta.json`, 0600).
Without it the plan still runs — the cards say **BLOCKED: Meta not connected**
in their reason — and approving one fails with `Meta creds missing`, marking
the card `failed`; nothing is ever published silently.  Instagram additionally
needs `igUserId` and a public media URL.

**Answers are facts; rules are bans.**  When the plan asks something
("What is the launch date?"), answer it by number — `status` lists the open
questions as `1.`, `2.`, …:

```
mod8 marketing answer --slug <slug> 1 September 15      # or /marketing answer <slug> 1 September 15
```

The answer is filed in `questions.jsonl` (`answered:true`), the question
leaves "Needs you", and the next `plan` reads it under **Founder answers** —
facts the model must use.  A *prohibition* is different: `mod8 rule <slug>
never mention pricing in social posts` (or `/rule <slug>: …`) lands in the
charter's `## Non-goals`, which the role treats as banned.  Do not answer a
factual question with `mod8 rule` — it would become something the role must
avoid mentioning.

### Friday receipt

```
mod8 receipt [--days 7] [--slug X] [--raw] [--provider ID]   # or /receipt in the REPL
```

The weekly proof of work, per project: ticks, proposals, cards
created/approved/rejected/applied/failed, hit rate (approved ÷ decided),
merges (sha7 + title), posts, spend, measurements, open marketing questions —
then **Needs you**: pending cards (`[a]`, flagged stale after 3 days) and
unanswered questions (`[q]`), each with the exact line to run
(`→ /approve <id>` / `→ mod8 marketing answer --slug <slug> <n> …`).
`--slug <unknown>` says `no such project` and exits 1.  Data comes from the hash-chained `audit.jsonl`
(`tick.start`, `measure.complete`), the approval index, `spend.jsonl` and
`marketing/questions.jsonl` — no model is needed.  `--raw` (or `MOD8_MOCK=1`)
prints the deterministic markdown; otherwise a short narrative is generated
first (provider: `--provider` → `MOD8_RECEIPT_PROVIDER` → `MOD8_STANDUP_PROVIDER`
→ local Anthropic key → any local key → proxy).  Every run is saved to
`~/.config/mod8/receipts/<YYYY-MM-DD>.md` (0600).

### Web bridge — `mod8 sync`

```
mod8 sync [--slug X] [--dry-run] [--json]     # or /sync [<slug>] in the REPL
```

The truth stays on disk; the mod8 dashboard shows a mirror.  Each run:

1. builds one document per connected project — slug, name (charter heading),
   full charter, last tick `{id, at, phase, status}`, 7-day spend (micros),
   the marketing line, pending count — plus its cards (pending, and anything
   decided in the last 7 days).  A card carries title, summary (the why, ≤ 2000
   chars), risk/impact, tests, diff stats, and `post {channel, text}` for
   social posts;
2. `POST /syncCompany` with the `mod8 login` key (`Authorization: Bearer
   sk-mod8-…`).  The backend upserts `users/{uid}/company/{slug}` +
   `…/cards/{id}` and never overwrites a card the web already decided but the
   CLI has not yet applied — those come back as `decisions`;
3. applies every web decision through the **same path as `/approve` /
   `/reject`** (`store.decide → act`).  Approving a post without Meta
   connected fails at act exactly like it does in the panel;
4. `POST /ackCompanyDecisions` with `applied` / `failed (+ error)` per card;
5. prints a table: cards up, cards waiting, decisions applied per project.
   Exit 1 when a decision failed, 2 when not logged in.

`--dry-run` builds the payload and sends nothing (`--json` prints it).
`MOD8_API_BASE` overrides the Cloud Functions host (specs point it at a mock).
Nothing runs automatically — the web only records the decision; the CLI is
the only thing that ever merges or publishes.

---

## Storage layout

Per product under `~/.config/mod8/products/<slug>/` (override the root with `MOD8_CONFIG_DIR`):

```
~/.config/mod8/
├── loop.pid                              # daemon PID file (Phase 2)
├── loop.tick.lock                        # mutex for `mod8 loop tick`
├── STOP                                  # presence = kill switch ACTIVE
└── products/
    ├── _defaults/policy.yaml             # org-wide policy parents inherit from
    └── <slug>/
        ├── policy.yaml                   # autonomy, budget, files, channels, voice
        ├── product.md                    # founder-authored charter (REQUIRED)
        ├── connectors/<adapter>.json     # per-adapter creds (0o600)
        ├── memory/
        │   ├── codebase/{architecture.md, hotpaths.json, deps.json, owners.md}
        │   ├── feedback/<source>.jsonl   # dedupe-appended signals
        │   ├── metrics/<source>.jsonl    # daily snapshots
        │   ├── competitors/<host>.md     # latest snapshot per host
        │   ├── research/<topic>-<date>.md
        │   ├── snapshots/<proposal-id>.json  # metric snapshot at act-time
        │   └── priors.json               # Beta-Binomial state per kind + source
        ├── state.json                    # FSM: lastTickId, waitUntilTs, …
        ├── events.jsonl                  # phase events (operational stream)
        ├── audit.jsonl                   # hash-chained (compliance stream)
        ├── spend.jsonl                   # per-call cost ledger
        ├── queue.lock                    # mutex for approval queue mutations
        ├── worktrees.jsonl               # registry of created worktrees
        ├── inbox/                        # drop files here → sense ingests
        ├── drafts/                       # email-imap draft .eml files
        ├── approvals/
        │   ├── index.jsonl               # quick listing
        │   ├── pending/apr_<id>.json     # one file per pending item
        │   └── archive/YYYY-MM.jsonl     # monthly-rotated archive
        └── proposals/                    # pre-build proposals from ideate
            └── prop_<id>.json
```

Worktrees live at **`<repo-root>/.mod8-worktrees/<proposal-id>/`** — required for git's path resolution. Auto-appended to `.gitignore` on first use.

---

## Connecting other products

The Harness is multi-product from day one. Onboard with:

```bash
$ mod8 connect add my-product
  scaffolded ~/.config/mod8/products/_defaults/policy.yaml (org-wide defaults)
✓ connected product "my-product"
  ~/.config/mod8/products/my-product

next steps:
  1. Edit ~/.config/mod8/products/my-product/product.md.tmpl
     and rename to product.md (the loop refuses to run without it).
  2. Edit ~/.config/mod8/products/my-product/policy.yaml
     — set autonomy, allowed repos, file protections.
  3. Add adapter credentials:  mod8 connect add-adapter my-product <adapter>
  4. Run a tick:               mod8 loop tick --slug my-product
```

Per-product **policy inheritance** via `inherit_from:` — child overrides merge over `_defaults`. Top-level keys override; nested objects (budget, files, etc.) deep-merge one level so a child can override individual sub-keys without redeclaring the entire block.

Adapter credentials always live under the product's own `connectors/` dir. There is no global credential store — isolation is by filesystem, not by application logic.

---

## Internals — for contributors

### Module map

```
src/loop/                                  # the engine
├── types.ts                               # shared types (ProductContext, PhaseEvent, …)
├── runPhase.ts                            # runDeterministicPhase + runStructuredPhase + runLlmToolsPhase
├── scheduler.ts                           # pure: decidePhases(state, policy, now)
├── tick.ts                                # single re-entrant entry (cron + daemon)
├── daemon.ts                              # long-running process, PID, SIGTERM, crash recovery
├── state.ts                               # per-product FSM (atomic rename-on-write)
├── events.ts                              # events.jsonl writer (async + sync variants)
├── audit.ts                               # append-only hash-chained log + verifyChain
├── budget.ts                              # 3-layer spend caps + spend.jsonl
├── kill.ts                                # STOP file / env check
├── policy.ts                              # YAML loader, Zod validator, deterministic check()
├── proposal.ts                            # Proposal type + JSONL store + PROPOSAL_KINDS
├── worktree.ts                            # git worktree lifecycle
├── modelPicker.ts                         # per-phase model selection + MOD8_MOCK
├── promptLoader.ts                        # per-phase system prompts (TS constants)
├── phases/{sense,ideate,prioritize,build,act,measure,learn}.ts
├── prompts/{...}.md                       # human-readable copies (TS constants are source of truth)
└── adapters/
    ├── types.ts                           # Adapter interface
    ├── registry.ts                        # central registry + loadAllAdapters
    ├── _stub.ts                           # registerStub helper
    └── <18 adapter files>

src/memory/                                # per-product memory
├── paths.ts                               # productPath() + runtime isolation
├── product.ts                             # product.md reader (throws if missing)
├── feedback.ts                            # per-source JSONL + inbox-folder drain
├── metrics.ts                             # daily metric snapshots + computeDelta
├── competitors.ts                         # URL snapshots + line-level diff
├── research.ts                            # one-shot research outputs
├── snapshots.ts                           # per-proposal metric snapshot for measure
└── codebase/{architecture,hotpaths,deps,owners}.ts

src/approval/
├── types.ts                               # Zod ApprovalItem + ProposedAction union
├── store.ts                               # JSONL index + pending/ + monthly archive
├── migrate.ts                             # schema-version migration chain
├── Panel.tsx                              # Ink UI
├── EditPanel.tsx                          # (lives in Panel.tsx; structured-field edit)
└── command.ts                             # `mod8 approvals` subcommand body

src/commands/
├── loop.ts                                # `mod8 loop ...` subcommand group
├── connect.ts                             # `mod8 connect ...` subcommand group
└── chat.tsx                               # /approvals + /halt slash handlers (existing file)
```

### Extending the system

**Add a new proposal kind:**
1. Append to `PROPOSAL_KINDS` in `src/loop/proposal.ts`.
2. Add an entry in `src/loop/phases/build.ts::kindMap` mapping to an `ApprovalItem['kind']`.
3. (Optional) Update the `ideate` prompt in `src/loop/promptLoader.ts` to call out the new concern.
4. Priors learn automatically from acceptance rates — no code change needed.

**Add a new adapter:**
1. Create `src/loop/adapters/<id>.ts`. Implement the `Adapter` interface from `./types.ts`. Call `register()` on import.
2. Add the import to the appropriate `loadPhaseNAdapters()` group in `src/loop/adapters/registry.ts`.
3. If the adapter has sink methods, ensure every `apply()` returns an `ActionResult` with a populated `rollbackRecipe`. If you can't produce one, throw — the loop will downgrade the action's autonomy.

**Add a new policy action:**
1. Extend the `PolicyAction` union in `src/loop/types.ts`.
2. Add a branch in `src/loop/policy.ts::check()`. The exhaustiveness sentinel (`const _exhaustive: never = action`) will catch you if you forget.
3. Call `policy.check()` at the relevant decision site (typically the phase that initiates the action).

### Storage conventions

- Config dir: `process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8')` — env-overridable.
- File modes: `0o600` for files, `0o700` for directories. Universal.
- Append-only JSONL with rotate-at-byte-cap: pattern from `src/storage/routingLog.ts` and `src/storage/crashLog.ts`. Used by `events.jsonl`, `audit.jsonl` (without rotation — it's compliance), `spend.jsonl`, and every feedback corpus.
- Per-product writes always go through `memory/paths.ts::productPath()` for the runtime isolation assertion.

### Phase orchestration

Phases use a thin wrapper from `runPhase.ts`:

- **`runDeterministicPhase`** — for phases with no LLM call (sense, act, measure, learn, prioritize). Handles kill check + start/complete events + audit + error catch.
- **`runStructuredPhase`** — for schema-validated LLM phases (ideate). Uses Vercel AI SDK's `generateObject` with a Zod schema. Handles model selection + budget pre-flight + cost tracking + MOD8_MOCK short-circuit.
- **`runLlmToolsPhase`** — for tool-using LLM phases (build). Uses `streamText` with a tool allowlist scoped to the worktree. Same lifecycle as `runStructuredPhase`.

All three return a `PhaseResult<TOutput>` — they never throw past their boundary. `tick.ts` reads the result and decides whether to continue.

### Testing

`MOD8_MOCK=1` short-circuits the model picker — `runStructuredPhase` returns `null` output, `runLlmToolsPhase` runs the body without a real call. The loop completes a full tick (sense → ideate → prioritize → build) without burning tokens or hitting any external API. Use this for CI and for local smoke testing.

For real-LLM tests, fund a provider (Anthropic / OpenAI / Gemini / DeepSeek), run `mod8 keys set <id> <key>` (BYOK) or `mod8 login` (proxy), and `mod8 loop tick`. Keep autonomy at L1 until you trust what the loop proposes.

---

## Environment variable overrides

Everything in `policy.yaml` is the recommended mechanism, but a few `MOD8_*` env variables override runtime behavior without touching config. They are load-bearing for operators running custom harnesses, so they are documented here as the source of truth.

| Variable | Default | Effect |
|---|---|---|
| `MOD8_CONFIG_DIR` | `~/.config/mod8` | Override the config root (all product state, policy, memory). |
| `MOD8_LOOP_MODEL` | per-phase default | Routes **every** LLM-using phase to one model (e.g. `deepseek-chat` when the Anthropic proxy is out of credits). |
| `MOD8_LOOP_MODEL_<PHASE>` | — | Per-phase model override. **Wins over `MOD8_LOOP_MODEL`.** `<PHASE>` is uppercase, e.g. `MOD8_LOOP_MODEL_IDEATE`. |
| `MOD8_LOOP_IDLE_MS` | `120000` | Build-phase idle timeout in ms: max time without a stream event before the loop aborts. Raise for slow providers (DeepSeek ≈30s per tool call). |
| `MOD8_LOOP_HARD_MS` | `720000` (12 min) | Build-phase hard wall-clock cap in ms for the whole tool loop, regardless of per-step activity. |
| `MOD8_MOCK` | `1` | Short-circuits the model picker to a mock — runs a full tick without tokens or external APIs. Used by CI and smoke tests. |
| `MOD8_LOOP_KILL` | — | Equivalent to the `STOP` file: setting it to `1` triggers the kill switch at every phase entry and adapter sink call. |

### Examples

```bash
# Point a custom harness at a scratch config tree (don't touch the real one)
export MOD8_CONFIG_DIR=$HOME/.config/mod8-test
mod8 loop tick --slug staging

# Force every phase onto cheap DeepSeek during a credit outage
MOD8_LOOP_MODEL=deepseek-chat mod8 loop start --foreground

# Pin just the ideate phase to a strong reasoner
MOD8_LOOP_MODEL_IDEATE=claude-sonnet-4-6 mod8 loop tick

# Give the build phase more time on a slow provider
MOD8_LOOP_IDLE_MS=300000 MOD8_LOOP_HARD_MS=900000 mod8 loop tick

# CI smoke test — full tick, no LLM, no tokens, no network
MOD8_MOCK=1 npm test
```

When both `MOD8_MOCK=1` and a real provider are configured, mock wins — the loop never burns tokens in test mode. `MOD8_MOCK` takes precedence over every other model override.

These variables are read live from `process.env` at each phase — setting them between ticks takes effect on the next phase entry. No restart of the daemon is required, but any *currently running* phase will finish with the values it started with.

### Worktree tests

The build phase creates each patch in an isolated `git worktree` at `<repo-root>/.mod8-worktrees/<proposal-id>/`. The acceptance gate for any proposal is `npm test` run from that worktree's root (the runtime runs `npm run build` first); tests must import from the worktree, never from a temp dir. Passing tests + a clean secret scan are mandatory before an item can be staged for approval. See [Safety](#safety--what-cannot-happen-without-your-approval) for the full rule set.

---

## Status as of 2026-05-25

Built and committed at `85051f0` (0.5.30). Verified end-to-end via the 10-step walkthrough at steps 1-7 (diff review, static, dry run, kill switch, lock/overlap, approval flow, policy/safety). Steps 8-10 (adapter matrix, worktree lifecycle, real-provider test) resume once a provider has been funded.

Not yet pushed to the remote. Daemon mode (`mod8 loop start/stop`) is implemented but not yet stress-tested in long-running production conditions — start in foreground (`mod8 loop start --foreground`) the first few times to surface any startup issues directly.
