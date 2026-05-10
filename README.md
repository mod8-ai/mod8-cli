# mod8

**Talk to any LLM from your terminal — Claude, GPT, Gemini, DeepSeek, Mistral, Groq, anything OpenAI-compatible. BYOK.**

No SaaS. No telemetry. Your keys stay in `~/.config/mod8/providers.json` (mode 0600). One CLI, every model.

---

## What it feels like

Install once, then:

```text
$ mod8 keys set anthropic
Enter API key for Anthropic (Claude): ************************************
✓ Saved key for Anthropic (Claude)
  Stored at /Users/you/.config/mod8/providers.json (file is 0600, only readable by you)

$ mod8 "what's the difference between a tarball and a wheel"
A tarball (.tar.gz) is the generic compressed-archive format used across
many ecosystems — Python sdists, Ruby gems, npm packages all ship as
tarballs. A wheel (.whl) is Python-specific, a built distribution that
skips the build step on install. tl;dr: tarball = source, wheel = built.

— claude-sonnet-4-6  324 tok · 1.21s · <$0.001
```

That was a one-shot. Now go interactive:

```text
$ mod8 new

✻ mod8
  switch to claude:  ask naturally — "go", "let's work", "let me talk to claude"
  use any provider:  "use deepseek", "ask grok", "switch to mistral"
  side-by-side:      "compare all" or /compare
  list providers:    /providers      ·  back to mod8: /mod8 or @mod8
  clear history:     /clear          ·  quit: /exit · cancel: esc

›  i'm thinking about adding rate limiting to my api gateway. unsure where to put it.

✻ mod8
│ Are you protecting downstream services from a single misbehaving caller, or
│ enforcing per-user quotas across many endpoints? Those usually live in
│ different layers.
│ 246 tok · 1.40s · <$0.001

›  per-user quotas across the whole api

✻ mod8
│ Then sticking it at the gateway makes sense — you only count once instead
│ of summing across services. Edge gateway with a Redis-backed token bucket
│ is the standard pattern. Want claude to sketch the wiring?
│ 312 tok · 1.62s · <$0.001

›  yes go

────────────────────────────────────────────────────────────
  ◆  → switching to claude  (work mode)
────────────────────────────────────────────────────────────

›  yes go

◆ claude
│ Here's a minimal Express middleware that does it. Redis with a sliding
│ window over 60s, 100 requests per user…
│ 1.4k tok · 4.30s · $0.012
```

Add another provider, switch to it mid-conversation:

```text
$ mod8 add-provider
paste key: gsk_***************************
✓ Looks like Groq (groq, openai-compat).
provider id [groq]:
display name [Groq]:
api type (anthropic | openai-compat | gemini) [openai-compat]:
base URL [https://api.groq.com/openai/v1]:
default model [llama-3.3-70b-versatile]:
✓ Saved Groq (groq) — key gsk_***********6vQp, color ●
```

Back in chat:

```text
›  use groq, give me the same answer but shorter

────────────────────────────────────────────────────────────
  ◆  → switching to groq  (groq mode)
────────────────────────────────────────────────────────────

›  give me the same answer but shorter

◆ groq
│ const limiter = rateLimit({ windowMs: 60_000, max: 100, keyGenerator: r => r.user.id, store: new RedisStore({ client }) }); app.use(limiter);
│ 184 tok · 0.42s · <$0.001
```

Side-by-side, all configured providers at once:

```text
›  compare all: write a haiku about cron jobs

◆ claude
│ Midnight tick repeats —
│ silent worker in the dark,
│ logs the only sound.
│ 28 tok · 1.10s · <$0.001

◆ groq
│ Cron jobs run unseen,
│ scheduled tasks in shadow,
│ servers hum at night.
│ 24 tok · 0.31s · <$0.001

◆ deepseek
│ Five stars then asterisk,
│ time slices marching forward,
│ work without applause.
│ 26 tok · 0.88s · <$0.001
```

Out of chat, you can also do this from one shell line:

```text
$ mod8 --all "summarize this commit message in 5 words" < commit.txt
```

That's the whole product.

---

## Install

```bash
npm install -g mod8
```

Requires Node 20+.

Then add at least one key:

```bash
mod8 keys set anthropic     # or: openai, google, deepseek, mistral,
                            #     groq, openrouter, xai, together
```

For a provider mod8 doesn't know yet (any OpenAI-compatible API):

```bash
mod8 add-provider           # interactive: paste key, confirm name/baseUrl/model
```

Or set an env var if you'd rather not store on disk:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Then:

```bash
mod8 "say hi"               # one-shot to your default
mod8 -c "say hi"            # one-shot to anthropic specifically
mod8 -o "say hi"            # → openai
mod8 -g "say hi"            # → google
mod8 --all "say hi"         # fan-out, side-by-side
mod8 new                    # start a chat session
mod8 list                   # see recent sessions
mod8 resume <id>            # pick up where you left off
mod8 keys list              # who's configured
mod8 providers              # detailed provider config
mod8 verify                 # run the built-in self-test suite
```

---

## What's in the box

| Category | Detail |
| --- | --- |
| Built-in providers | anthropic, openai, google, deepseek, mistral, groq, openrouter, xai, together |
| Custom providers | any OpenAI-compatible API via `mod8 add-provider` |
| Storage | `~/.config/mod8/providers.json` (keys, mode 0600) and `~/.config/mod8/sessions/*.json` (chat history) |
| Pricing | per-model token costs in every footer |
| Streaming | yes, all providers; cancel with `esc` mid-stream |
| Pipe / `@file` | `cat x | mod8 "…"` and `mod8 "review @path/to/file"` both work |
| Self-test | `mod8 verify` runs 50+ sandboxed tests against mocked + real API paths |

---

## Configuration

| File or env var | What it holds |
| --- | --- |
| `~/.config/mod8/providers.json` | API keys + per-provider config (api type, base URL, default model, color). Mode `0600`. |
| `~/.config/mod8/config.json` | `default` (which provider answers a bare `mod8 "..."`), `allConsent` (first-run gate). |
| `~/.config/mod8/sessions/*.json` | Saved chat sessions, auto-titled after the second turn. Mode `0600`. |
| `MOD8_CONFIG_DIR` | Override the config root entirely (used by `mod8 verify`'s sandbox). |
| `MOD8_HOST_MODEL`, `MOD8_WORK_MODEL` | Override the default chat models. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY` | Override the stored key for that provider. |

---

## Privacy

Everything is local. mod8 is a thin client that talks directly to provider APIs.
There is no mod8 server. No analytics, no telemetry, no key escrow.

If you want to verify, the verify suite has a test that asserts `providers.json`
is created with mode `0600`, and the source is short enough to read in an hour.

---

## License

MIT — see [LICENSE](./LICENSE).
