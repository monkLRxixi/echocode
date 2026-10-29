# echocode

> Renamed from `deepcode` (v0.3.0). On first run `~/.deepcode` is migrated into
> `~/.echocode` — the old single-file schema is split automatically
> (`tools`/`permissions`/`permissionMode` → `tools.json`, `theme` → `ui.json`).
> `DEEPCODE_*` environment variables are still read as a fallback.

A small, readable terminal coding agent in the shape of Claude Code.
**TypeScript + Ink (React)**, green/white by default, and it speaks **three** wire
formats: Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses.

```
~                                  ← transcript (scrolls, PgUp/PgDn)
❯ the tests in src/auth are failing, find out why

● Bash(bun test src/auth)
  ⎿  (exit 1)
Done. One assertion in src/auth/refresh.test.ts:42 expects a retry.
                                   ← empty space fills the window
                                   ← composer: top border / input / bottom border
 ⠙ working ──────────────────────────────────────────────────────────
 ❯ ▌
 claude-sonnet-5 · anthropic [anthropic-message] · ~/projects/api
 ready · default · in 1200 · out 96 · ~$0.0042          enter send · ctrl-c · /help
```

The TUI runs on the **alternate screen** with a fixed-height layout: the
transcript is a viewport at the top, the composer + status lines are pinned to
the bottom, and whatever is left over is empty space. The composer is borderless
except for a top and bottom rule; while a turn is running the spinner and the
current activity (`working`, or the tool name) sit at the left end of the top
rule. Permission prompts appear as a green rounded box just above it. The transcript is
line-buffered and wrapped by the app itself (`src/tui/lines.ts`), so the bottom
panel never drifts by a row.

| key | action |
|---|---|
| `pgup` / `ctrl-b`, **mouse wheel up** | scroll the transcript back |
| `pgdn` / `ctrl-f`, **mouse wheel down** | scroll forward, back to following the live tail |
| `↑` / `↓` | prompt history (when the slash menu is closed) |

While the alternate screen is active echocode enables mouse reporting, so the
wheel scrolls the transcript instead of being turned into arrow keys by the
terminal (which used to browse the prompt history). Text selection then needs
`shift`+drag, as in other full-screen TUIs; clicks are ignored. With
`ECHOCODE_ALT_SCREEN=0` mouse reporting stays off and the terminal keeps its
native behaviour.

`ECHOCODE_ALT_SCREEN=0` falls back to inline rendering (no full-screen takeover,
transcript goes to the terminal's normal scrollback).

## Quick start

```bash
npm install
npm run build          # tsc -> dist/
node bin/echocode.js   # or: npm run dev  (tsx, no build)

# no key / no network: the mock speaks all three formats
node bin/echocode.js --mock
node bin/echocode.js --mock --format openai-chat
node bin/echocode.js --mock --format openai-response -p -y "create hello.txt"
```

Real endpoints:

```bash
# Anthropic Messages
export ANTHROPIC_API_KEY=sk-ant-...
node bin/echocode.js -m claude-sonnet-4-5

# OpenAI Chat Completions (also: vLLM / Ollama / LiteLLM / OpenRouter / Azure-like gateways)
export OPENAI_API_KEY=sk-...
node bin/echocode.js --provider openai --format openai-chat -m gpt-4.1

# OpenAI Responses
node bin/echocode.js --provider openai --format openai-response -m gpt-5

# anything else that speaks the same two formats
ECHOCODE_BASE_URL=http://127.0.0.1:8080/v1 node bin/echocode.js   # auto-detects chat format
```

`provider` is a free-form name; the **format** is what selects the wire protocol
(`anthropic-message` | `openai-chat` | `openai-response`). Known provider names
(`deepseek`, `groq`, `openrouter`, `ollama`, …) also pre-fill base URL and model.
Without an explicit format, it is detected from the base URL.

## Config: three files, all data-driven

All of them are JSON with `//` and `/* */` comments, created on first run.
Each file has one job — model/provider, tool execution, presentation.

### `~/.echocode/settings.json` — provider + model only

```jsonc
{
  "provider": "deepseek",            // ANY name: "anthropic", "my-gateway", "acme-llm"
  "format": "openai-chat",           // MUST be one of the three wire formats
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",                // or set DEEPSEEK_API_KEY / ECHOCODE_API_KEY
  "authToken": null,                 // bearer token, takes precedence over apiKey
  "headers": { "x-tenant": "acme" }, // extra request headers
  "maxTokens": 32000,
  "maxTurns": 60,
  "contextLimit": 180000,
  "systemAppend": null
}
```

`provider` is free text. `format` is the only thing that decides how messages are
encoded:

| `format` | endpoint | auth |
|---|---|---|
| `anthropic-message` | `POST /v1/messages` | `x-api-key` |
| `openai-chat` | `POST /chat/completions` | `Authorization: Bearer` |
| `openai-response` | `POST /responses` | `Authorization: Bearer` |

Known provider names also fill in `format` / `baseUrl` / `model` for you:
`anthropic`, `openai`, `openai-responses`, `deepseek`, `moonshot`, `groq`,
`openrouter`, `ollama`, `vllm`. Anything else is accepted as a custom gateway —
then `baseUrl` is required (a warning tells you if it is missing).

### `~/.echocode/tools.json` — tool execution

```jsonc
{
  "permissionMode": "default",       // default | acceptEdits | auto | plan | bypassPermissions
  "tools": {                         // false = not loaded, not callable
    "Read": true,
    "Write": true,
    "Edit": true,
    "Bash": { "enabled": true, "timeout": 120000 }
  },
  "permissions": {
    "allow": ["Bash(npm test:*)", "Read"],   // auto-approve
    "deny":  ["Bash(rm -rf:*)"]              // always refuse — wins over allow and --yes
  }
}
```

A disabled tool is also refused if the model calls it anyway
(`unknown or disabled tool: Bash (see tools.json)`), so the switch is a real
capability boundary, not just prompt hygiene.

Rule syntax: `Tool`, `Tool(pattern)`, `*`; `*` is a wildcard and `Bash(npm test:*)`
is the prefix form. Matched value is `command` for Bash, `file_path` for file tools.

### `~/.echocode/ui.json` — presentation

```jsonc
{ "theme": "green" }   // green (default) | mono
```

```bash
echocode settings            # effective config from all three files
echocode settings --json     # machine-readable
echocode settings --path     # the three paths
echocode settings --init     # write defaults (--force to overwrite)
```

**Precedence:** CLI flag → environment variable → config file → built-in default.
`--settings` / `--tools` / `--ui` point at alternative files. A legacy
`~/.echocode/config.json` is still read (with a warning) if `settings.json` is
missing. Unknown keys, wrong types and bad enums produce a warning on stderr and
are ignored, so a typo never prevents startup.

## Stack

| layer | choice |
|---|---|
| language | **TypeScript 5.9**, `strict`, ESM (`NodeNext`), no bundler |
| UI | **Ink 6 + React 19** (fixed-height layout on the alternate screen) |
| run | `tsc` → `dist/` for production; `tsx` for `npm run dev` and the no-build fallback |
| HTTP | global `fetch` + `ReadableStream`; one hand-written SSE reader shared by all providers |
| schemas | plain JSON Schema objects per tool (`input_schema`), converted to `parameters` for OpenAI |
| process | `node:child_process.spawn($SHELL, ["-lc", cmd], {detached:true})`, kills the group on timeout |
| state | one `useReducer` for the transcript; lines pre-wrapped so the viewport height is exact |
| storage | `~/.echocode/{settings,tools,ui}.json` (JSONC) + `~/.echocode/projects/<slug>/<uuid>.jsonl` |

```
src/
  cli.ts                 args, format setup, print vs TUI, `settings` command
  settings.ts            settings.json: provider+model, presets (deepseek, ollama, …)
  tools-config.ts        tools.json: tool switches, permission mode, allow/deny
  ui-config.ts           ui.json: theme
  jsonfile.ts            JSONC reader/writer shared by the three files
  agent.ts               the turn loop: stream -> tool_use -> run -> tool_result
  types.ts               provider-neutral blocks/events + Provider interface
  providers/
    anthropic.ts         /v1/messages, content_block_*  (x-api-key, anthropic-beta)
    openai-chat.ts       /chat/completions, choices[].delta (tool_calls by index)
    openai-responses.ts  /responses, response.* events  (call_id based)
    sse.ts  http.ts      shared SSE reader, retries, auth, ApiError
  tools/                 Read, Write, Edit, Bash
  tui/App.tsx            Ink app: viewport, composer, menu, footer, permission prompt
  tui/lines.ts           item -> pre-wrapped terminal rows (exact heights)
  tui/commands.ts        slash-command registry + matching
  render/plain.ts        streaming renderer for -p / non-TTY
  mock.ts                offline server for all three formats
```

## Commands

| flag | meaning |
|---|---|
| `-p, --print` | one-shot, plain output (auto when stdout is not a TTY) |
| `--provider <name>` | provider name (free text; presets fill in defaults) |
| `--format <f>` | force the wire format |
| `-m, --model` / `--base-url` / `--api-key` | endpoint + model |
| `--max-turns` / `--max-tokens` | loop cap / per-request cap |
| `--permission-mode` | `default` \| `acceptEdits` \| `auto` \| `plan` \| `bypassPermissions` |
| `-y, --yes` / `--plan` | shortcuts for the above |
| `--settings/--tools/--ui <path>` | alternative config files |
| `--mock` | offline server, all three formats |
| `--theme mono` / `--no-color` | strip colour, keep layout |
| `--verbose` | token/cost lines on stderr (print mode) |
| `ECHOCODE_DEBUG_REQUEST=<path>` | dump the exact wire request |

## Slash commands

Typing `/` opens a suggestion list above the composer — name, argument hint and a
one-line description, filtered as you type:

```
❯ /co▌
❯ /compact   Free context by summarizing older tool results
  /context   Message count and estimated token usage
  /cost      Tokens and estimated cost for this session
  /clear     Start a fresh context; the transcript on disk stays
```

| key | action |
|---|---|
| `↑` / `↓` (`ctrl-p` / `ctrl-n`) | move the selection |
| `tab` | complete the selected command |
| `enter` | run it (commands with arguments complete to `/cmd ` first) |
| `esc` | dismiss the menu, keep the text |

Matching follows the rules the Claude Code bundle uses: suggestions only while
the token before the first space looks like a command (so `/model gpt` hides the
menu, `/model ` keeps it), empty query lists everything alphabetically, and a
non-empty query ranks exact → name prefix → alias prefix → name substring →
description.

| command | description |
|---|---|
| `/help` | Show all commands |
| `/clear` | Start a fresh context; the transcript on disk stays |
| `/compact` | Free context by summarizing older tool results |
| `/model <id>` | Show or switch the model |
| `/permissions <mode>` | Show or set the permission mode |
| `/cost` | Tokens and estimated cost for this session |
| `/context` | Message count and estimated token usage |
| `/session` | Print the session id and transcript path |
| `/tools` | List enabled tools and where tools.json lives |
| `/exit` | Quit echocode |

Aliases: `?`/`h` (help), `reset` (clear), `m` (model), `perm` (permissions),
`usage` (cost), `ctx` (context), `id` (session), `quit`/`q` (exit).

TUI keys: `enter` send · `ctrl-c` interrupt (empty input: quit) · `ctrl-d` quit.
Permission prompts: `y` yes · `a` always (for that tool this session) · `n` no.

## Design notes

Written from the reverse-engineering notes in `../cc/REPORT.md`:

- **One canonical transcript, three encodings.** `types.ts` defines neutral
  blocks; each provider converts at the boundary. That is what makes
  `anthropic-message / openai-chat / openai-response` interchangeable without
  touching the agent or the UI.
- **Streaming is normalised into six events** (`text_delta`, `tool_start`,
  `tool_args_delta`, `tool_end`, `usage`, `stop`) — Anthropic's
  `input_json_delta`, OpenAI's `tool_calls[].function.arguments` fragments and
  Responses' `function_call_arguments.delta` all collapse into the same shape.
- **Tool ids matter.** Anthropic keys results by `tool_use.id`, chat by
  `tool_call_id`, Responses by `call_id` — the agent carries the provider's own
  id through so results never get mis-paired.
- **Permissions are pre-flight**, and a denial becomes a `tool_result` with
  `is_error: true` so the model can adapt instead of retrying blindly.
- **Plan mode narrows `tools[]`** rather than failing every mutating call.
- **Prompt caching hint** — the stable behaviour block carries
  `cache_control: ephemeral` (Anthropic only; ignored by the OpenAI paths).
- **Fixed-height viewport** — the composer is pinned to the bottom, so the
  transcript has to be pre-wrapped into exact rows (`tui/lines.ts`) instead of
  relying on Ink's own wrapping.

Deliberately not copied: deferred/ToolSearch tool loading, remote feature flags,
prompt hashing, and the model-side risk classifier (`auto` uses a local rule).

## Build & publish

```bash
npm ci                 # install devDependencies
npm run typecheck      # tsc --noEmit
npm run build          # tsc -> dist/  (prepack also runs this)
npm run check:pack     # == npm pack --dry-run: verify dist/ is in the tarball
node bin/echocode.js --version
```

The published artifact is `bin/` + `dist/` (`files` in package.json); `src/` is
not shipped, so the tarball never depends on `tsx`. `prepack` builds, and
`prepublishOnly` type-checks before the upload.

```bash
npm version patch -m "echocode %s"     # bumps, commits, tags
git push --follow-tags

npm login                              # or NPM_TOKEN in CI
npm publish --dry-run                  # inspect name/version/files
npm publish                            # unscoped
npm publish --access public            # if you move to @scope/echocode
```

This machine is configured against `registry.npmmirror.com`, which is a read
mirror — publishing has to go to the real registry:

```bash
npm publish --registry=https://registry.npmjs.org/
```

Installing from git (`npm i -g github:monkLRxixi/echocode`) needs a build on the
consumer side, since git trees do not contain `dist/`:

```bash
git clone https://github.com/monkLRxixi/echocode && cd echocode
npm ci && npm run build && npm i -g .
```

## Notes

- Mock mode is a real HTTP server on `127.0.0.1:0` speaking the actual SSE
  formats, so the client code paths are identical to production.
- Cost numbers are list-price estimates, for orientation only.
- `settings.json` is the single source of truth for provider behaviour; flags and
  env vars exist to override it for one run, not to replace it.
- The alternate screen means the transcript is not in your terminal scrollback;
  use `pgup`/`pgdn` inside echocode, or run with `ECHOCODE_ALT_SCREEN=0`.
