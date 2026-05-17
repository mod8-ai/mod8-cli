# mod8

**The AI coding terminal that picks the best model for you.**

mod8 routes each task to Claude, GPT, Gemini, or DeepSeek — compares them side-by-side, switches mid-task, edits files, runs shells, and publishes what you build to a free URL.

One CLI. Every model. No vendor lock-in.

```bash
npm install -g mod8-cli
```

---

## What makes it different

Every other AI coding tool ties you to one provider. mod8 doesn't.

| Feature | What it does |
| --- | --- |
| 🎯 **Smart routing** | Knows which model is best for what — auto-recommends Claude for React, GPT for APIs, Gemini for huge contexts, DeepSeek for cheap iteration. |
| 🔀 **Mid-task switching** | "use gpt" / "ask claude" / `/handoff gemini` — change provider in the same conversation without losing context. |
| ⚖️ **Side-by-side compare** | Run the same prompt across every configured provider, see all answers in one screen. |
| 🧠 **Auto-handoff** | Provider hits its context limit? mod8 silently switches to a bigger-window model. |
| 📊 **Per-project tracking** | Tags every turn with `(project, topic, provider)`. Dashboard at [mod8.ai](https://mod8.ai) shows per-project spend, provider mix, topic distribution. |
| 🚀 **Publish to a URL** | `mod8 publish` ships any static site to `<slug>.apps.mod8.ai` with real HTTPS — one command. |
| 🛡️ **Anti-loop ledger** | Write-tracking ledger refuses silent overwrites. No more "agent rewrote its own files for 10 minutes". |
| 🎓 **Learns YOU** | After 2+ overrides for a topic, the comparison panel floats your preferred provider to the top with a ★ "your usual pick" badge. |

---

## Install

```bash
npm install -g mod8-cli
```

Requires Node 20+. The terminal command is `mod8`; the npm package is `mod8-cli`.

Then pick auth:

### Option A — `mod8 login` (hosted proxy)

One account, one bill, every provider.

```bash
mod8 login                  # opens mod8.ai, paste the sk-mod8-… key
```

After login, every request goes through the mod8 proxy. You see live spend on the [mod8.ai dashboard](https://mod8.ai).

### Option B — BYOK (bring your own keys)

```bash
mod8 keys set anthropic     # also: openai, google, deepseek, mistral,
                            # groq, openrouter, xai, together
mod8 add-provider           # for any other OpenAI-compatible API
```

Keys are stored at `~/.config/mod8/providers.json` (mode `0600`, never leaves your machine).

---

## Quick tour

```text
$ mod8 new

✻ mod8
  start chatting · "go" hands off to claude · "use gpt" / "use gemini" switches
  /compare runs all providers · /handoff <name> mid-stream · /publish ships sites

›  i want to build a landing page for a plumber

→ Topic shift detected: frontend / UI work
  Typical turn: ~16k tokens · ~5 turns per task

   Provider    Speed    $/turn    Code     Performance   Why
   ──────────────────────────────────────────────────────────────────
   ⭐ Claude    ★★★☆☆  $0.054   ★★★★★   ★★★★★  Best at React, Tailwind, components
      GPT       ★★★★★  $0.040   ★★★★☆   ★★★★★  Fast iteration, weaker on Tailwind
      Gemini    ★★★★☆  $0.018   ★★★☆☆   ★★★★☆  Decent UI, less precise CSS
      DeepSeek  ★★★☆☆  $0.013   ★★★☆☆   ★★★☆☆  Cheapest — expect a review pass

  Currently: Claude (already the recommendation ✓)
  "use claude" · "use gpt" · "use gemini" · "use deepseek" · or just keep going

›  go

────────────────────────────────────────────────────────────
  ◆  → switching to claude  (work mode)
────────────────────────────────────────────────────────────

◆ claude  · goal: scaffold a plumber landing page with React + Tailwind · step 1/8
│ → write_file: src/Landing.tsx
│ → write_file: src/components/Hero.tsx
│ → bash: npm run build
│ ✓ done. dist/ ready to publish.

›  /publish --confirm

→ Publishing
  project   plumber-site
  slug      plumber-site
  url       https://plumber-site.apps.mod8.ai
  files     12 · size 47 KB

✓ Published to https://plumber-site.apps.mod8.ai
```

---

## Commands

```bash
mod8 new                    # start a chat session (auto-saved)
mod8 list                   # list recent sessions
mod8 resume <id>            # pick up where you left off

mod8 "say hi"               # one-shot to your default
mod8 -c "…"                 # → claude (anthropic)
mod8 -o "…"                 # → gpt    (openai)
mod8 -g "…"                 # → gemini (google)
mod8 -d "…"                 # → deepseek
mod8 --all "…"              # fan out to every configured provider, side-by-side

mod8 publish                # dry-run: show what would ship
mod8 publish --confirm      # ship to <slug>.apps.mod8.ai
mod8 publish --domain site.com  # also bind a custom domain

mod8 keys list              # who's configured
mod8 add-provider           # add any OpenAI-compatible API
mod8 verify                 # run 252 self-tests
```

Inside chat, you can also:

```
/compare <prompt>           explicit fan-out
/handoff <provider>         switch mid-stream (preserves context)
/files                      list everything written this session
/status                     full session snapshot (zero LLM call, can't lie)
/clear                      start fresh
/exit                       quit
```

---

## Dashboard at [mod8.ai](https://mod8.ai)

If you `mod8 login`, every session is tracked per-project. Visit the dashboard to see:

- **Projects** — one card per `cwd` where you ran mod8, with totals + provider breakdown.
- **Sites** — your published `<slug>.apps.mod8.ai` URLs, file counts, last publish times.
- **Spend** — token costs, charged amounts, balance.
- **API key** — issue / rotate your `sk-mod8-…` key.

---

## Configuration

| File or env var | What it holds |
| --- | --- |
| `~/.config/mod8/auth.json` | mod8 hosted-proxy credentials (after `mod8 login`). Mode `0600`. |
| `~/.config/mod8/providers.json` | BYOK API keys + per-provider config. Mode `0600`. |
| `~/.config/mod8/config.json` | Default provider, first-run consent state. |
| `~/.config/mod8/sessions/*.json` | Saved chat sessions, auto-titled after the second turn. |
| `~/.mod8/routing-prefs.json` | Per-user routing preferences — learned from your overrides. |
| `MOD8_CONFIG_DIR` | Override the config root entirely (used by `mod8 verify`'s sandbox). |
| `MOD8_HOST_MODEL`, `MOD8_WORK_MODEL` | Override the default chat models. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY` | Override the stored key for that provider. |

---

## Privacy

**BYOK mode (Option B):** mod8 talks directly to provider APIs. Your keys live in `~/.config/mod8/providers.json` (mode 0600). No mod8 server is in the loop.

**Hosted mode (Option A — `mod8 login`):** Requests go through the mod8 proxy at mod8.ai. The proxy forwards to providers using mod8's master keys, deducts from your balance, and records the turn for the dashboard. mod8 does NOT store your prompts or responses — only metadata: project name, topic, token counts, cost.

The source is short enough to audit in an evening. `mod8 verify` runs 252 sandboxed tests covering every user-facing flow.

---

## Links

- 🌐 [mod8.ai](https://mod8.ai) — sign up, dashboard, docs
- 🐙 [GitHub](https://github.com/mod8-ai/mod8-cli) — issues, discussions, source
- 📦 [npm](https://www.npmjs.com/package/mod8-cli) — releases

---

## License

MIT — see [LICENSE](./LICENSE).
