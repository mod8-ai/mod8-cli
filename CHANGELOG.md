# Changelog

All notable changes to mod8 are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-07

First public release.

### Added

- One-shot prompts: `mod8 -c "…"` (Anthropic), `mod8 -o "…"` (OpenAI),
  `mod8 -g "…"` (Gemini), or just `mod8 "…"` for the configured default.
- Side-by-side comparison: `mod8 --all "…"` fans the prompt out to every
  configured provider and renders one block per provider with its own color,
  model name, token count, latency, and cost.
- Interactive chat REPL: `mod8 new` (fresh session), `mod8 list` (recent
  sessions), `mod8 resume <id>`. Two-mode flow:
    - **host** = mod8 / Anthropic Sonnet, the planning side.
    - **work** = any configured provider, the doing side.
  Switching is by natural language ("go", "let's work", "use deepseek",
  "ask grok", "switch to mistral") or slash commands (`/use <id>`,
  `/ask <id>`, `/mod8`, `@mod8`, `/clear`, `/exit`, `/providers`,
  `/compare <prompt>`).
- Provider registry: nine built-in templates with key-prefix detection —
  `anthropic`, `openai`, `google`, `deepseek`, `mistral`, `groq`, `openrouter`,
  `xai`, `together`. Anything OpenAI-compatible plugs in.
- Custom providers: `mod8 add-provider` accepts any OpenAI-compatible API by
  pasting a key and confirming id, name, base URL, and default model.
- Storage: keys live in `~/.config/mod8/providers.json` (mode 0600) with
  automatic migration from the legacy `keys.json`. Sessions live in
  `~/.config/mod8/sessions/` with auto-generated titles.
- Pricing: per-model token costs with a `<$0.001` rounded summary.
- Error UX: invalid key, rate limit, network, quota, model-not-found are all
  classified into one-line friendly messages, both in single-provider runs
  and per-block in `--all`.
- Pipe + `@file` inputs: `cat file.go | mod8 "review this"`,
  `mod8 "explain @path/to/file.py"`.
- `mod8 verify`: built-in self-test suite — 57 tests across 8 spec files,
  runs in ~35 seconds, sandbox-isolated, exercises mock and real-API paths.
  Run before every ship.

### Notes

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`
  environment variables override the stored key for the matching provider.
- `--all` consent: first run pauses for explicit confirmation (only once);
  set `MOD8_AUTO_CONFIRM=1` to skip non-interactively.
- The chat REPL needs a real TTY (it's an Ink-based UI). Piped invocations
  use the one-shot path.
