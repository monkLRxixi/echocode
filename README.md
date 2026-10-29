# echocode

A terminal coding agent: it reads your files, edits them, runs commands and
reports what actually happened. Written in **TypeScript** with an **Ink (React)**
TUI, green/white by default, and it speaks **three** wire formats — Anthropic
Messages, OpenAI Chat Completions and OpenAI Responses — so it works against
Anthropic, OpenAI and any compatible gateway.

```
~
❯ the tests in src/auth are failing, find out why

● Bash(bun test src/auth)
  ⎿  (exit 1)
Done. One assertion in src/auth/refresh.test.ts:42 expects a retry.

 ⠙ working ──────────────────────────────────────────────────────────
 ❯ ▌
─────────────────────────────────────────────────────────────────────
 claude-sonnet-4-5 · anthropic [anthropic-message] · ~/projects/api
 ready · default · in 1200 · out 96 · ~$0.0042      enter send · ctrl-c · /help
```

- **Fixed-height TUI** — the composer and status lines stay pinned to the bottom;
  the transcript above it scrolls with `PgUp`/`PgDn` or the mouse wheel.
- **Four tools** — `Read`, `Write`, `Edit`, `Bash`, with per-tool switches and
  allow/deny rules.
- **Three formats, one agent** — switch by changing one field in `settings.json`.
- **Data-driven config** — three JSON files (with `//` comments) created on first
  run, overridable by flags and environment variables.
- **Offline mock** — `--mock` starts a local server speaking all three streaming
  formats, so demos and CI need no key and no network.

## Install

```bash
npm install -g echocode
echocode --version
```

From source:

```bash
git clone https://github.com/monkLRxixi/echocode
cd echocode
npm ci
npm run build          # tsc -> dist/
node bin/echocode.js --version
```

Requires Node.js 20 or newer.

## Quick start

```bash
echocode                              # interactive session in the current directory
echocode "fix the failing test"       # start with that first message
echocode -p "summarise src/"          # one-shot, plain output
echo "explain X" | echocode -p        # one-shot from stdin

echocode --mock                       # offline: no key, no network
echocode --mock -p -y "create hello.txt"
```

Point it at a real API — either through `settings.json` (see below) or flags:

```bash
# Anthropic Messages
export ANTHROPIC_API_KEY=sk-ant-...
echocode

# OpenAI
export OPENAI_API_KEY=sk-...
echocode --provider openai --format openai-chat -m gpt-4.1

# OpenAI Responses
echocode --provider openai --format openai-response -m gpt-5
```

## Providers and formats

`provider` is a free-form name; `format` decides how messages are encoded. Leave
`format` out and it is detected from the base URL.

| `format` | endpoint | auth |
|---|---|---|
| `anthropic-message` | `POST /v1/messages` | `x-api-key` |
| `openai-chat` | `POST /chat/completions` | `Authorization: Bearer` |
| `openai-response` | `POST /responses` | `Authorization: Bearer` |

Known provider names pre-fill `format`, `baseUrl` and `model`:
`anthropic`, `openai`, `openai-responses`, `deepseek`, `moonshot`, `groq`,
`openrouter`, `ollama`, `vllm`. Anything else is treated as a custom gateway and
needs an explicit `baseUrl`.

```bash
# local model server
echocode --provider ollama -m qwen2.5-coder:32b
# custom gateway
echocode --provider acme --format openai-chat --base-url https://llm.acme.internal/v1 --api-key …
```

## Configuration

Three files under `~/.echocode/`, written with defaults on first run. All of them
accept `//` and `/* */` comments, and unknown keys only produce a warning.

**Precedence:** CLI flag → environment variable → config file → built-in default.

### `settings.json` — provider and model

```jsonc
{
  "provider": "deepseek",            // any name
  "format": "openai-chat",           // anthropic-message | openai-chat | openai-response
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "authToken": null,                 // bearer token, wins over apiKey
  "headers": { "x-tenant": "acme" }, // extra request headers
  "maxTokens": 32000,                // per request
  "maxTurns": 60,                    // tool-loop cap
  "contextLimit": 180000,            // transcript budget (estimated tokens)
  "systemAppend": null               // extra text appended to the system prompt
}
```

### `tools.json` — what the agent may do

```jsonc
{
  "permissionMode": "default",       // default | acceptEdits | auto | plan | bypassPermissions
  "tools": {
    "Read": true,
    "Write": true,
    "Edit": true,
    "Bash": { "enabled": true, "timeout": 120000 }
  },
  "permissions": {
    "allow": ["Bash(npm test:*)", "Read"],   // auto-approve
    "deny":  ["Bash(rm -rf:*)"]              // always refuse; wins over allow and --yes
  }
}
```

- A tool set to `false` is not loaded at all, and is still refused if the model
  tries to call it.
- Rule syntax: `Tool`, `Tool(pattern)`, `*`. `*` is a wildcard, `Bash(npm test:*)`
  is the prefix form; the matched value is `command` for `Bash` and `file_path`
  for file tools.
- `plan` mode narrows the tool list to read-only tools; `auto`/`acceptEdits`
  approve file edits without asking; `bypassPermissions` skips prompts entirely.

### `ui.json` — appearance

```jsonc
{ "theme": "green" }   // green (default) | mono
```

```bash
echocode settings              # effective config from all three files
echocode settings --json       # machine-readable
echocode settings --path       # the three paths
echocode settings --init       # write defaults (--force to overwrite)
echocode settings --provider deepseek   # preview an override
```

## TUI

The session takes over the terminal (alternate screen) and splits it in two: a
transcript viewport at the top, a fixed panel at the bottom.

```
 ⠙ Write ────────────────────────   ← spinner + current activity on the top rule
 ❯ ▌                                ← input
─────────────────────────────────   ← bottom rule
 claude-sonnet-4-5 · anthropic [anthropic-message] · ~/api
 ready · default · in 0 · out 0          enter send · ctrl-c · /help
```

Permission prompts appear as a green rounded box just above the composer:

```
╭──────────────────────────────────────────────╮
│ ? run Write                                  │
│ hello.txt                                    │
│ y yes · a always · n no                      │
╰──────────────────────────────────────────────╯
```

| key | action |
|---|---|
| `enter` | send |
| `↑` / `↓` | prompt history (when the slash menu is closed) |
| `pgup` / `pgdn`, wheel | scroll the transcript |
| `ctrl-c` | interrupt the turn; on empty input, quit |
| `ctrl-d` | quit |
| `y` / `a` / `n` | answer a permission prompt (yes / always / no) |

Typing `/` opens the command menu — `↑`/`↓` to move, `tab` to complete, `enter`
to run (commands that take arguments complete to `/cmd ` first), `esc` to close.

| command | description |
|---|---|
| `/help` | list every command |
| `/clear` | start a fresh context (transcript on disk is kept) |
| `/compact` | drop old tool results to free context |
| `/model [id]` | show or switch the model |
| `/permissions [mode]` | show or set the permission mode |
| `/cost` | tokens and estimated cost |
| `/context` | message count and estimated token usage |
| `/session` | session id and transcript path |
| `/tools` | enabled tools and the tools.json path |
| `/exit` | quit |

Aliases: `?`/`h`, `reset`, `m`, `perm`, `usage`, `ctx`, `id`, `quit`/`q`.

## CLI reference

| flag | meaning |
|---|---|
| `-p, --print` | one-shot, plain output (automatic when stdout is not a TTY) |
| `--provider <name>` | provider name |
| `--format <f>` | `anthropic-message` \| `openai-chat` \| `openai-response` |
| `-m, --model <id>` | model id |
| `--base-url <url>` / `--api-key <key>` | endpoint and credential |
| `--max-turns <n>` / `--max-tokens <n>` | loop cap / per-request cap |
| `--permission-mode <m>` | see `tools.json` above |
| `-y, --yes` / `--plan` | shortcuts for `bypassPermissions` / `plan` |
| `--system-append <text>` | extra system prompt text |
| `--settings/--tools/--ui <path>` | use alternative config files |
| `--mock` | offline server for all three formats |
| `--theme mono`, `--no-color` | strip colour, keep layout |
| `--verbose` | token/cost lines on stderr in print mode |
| `-h, --help` / `-V, --version` | help / version |

Environment variables: `ECHOCODE_PROVIDER`, `ECHOCODE_FORMAT`, `ECHOCODE_MODEL`,
`ECHOCODE_BASE_URL`, `ECHOCODE_API_KEY`, `ECHOCODE_AUTH_TOKEN`,
`ECHOCODE_MAX_TOKENS`, `ECHOCODE_THEME`, `ECHOCODE_COLOR`,
`ECHOCODE_ALT_SCREEN=0` (inline rendering instead of the alternate screen),
`ECHOCODE_DEBUG_REQUEST=<file>` (dump the wire request). Standard
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_BASE_URL` /
`OPENAI_BASE_URL` and `NO_COLOR` are honoured too.

## Windows

Windows 10+ with **Windows Terminal** (it reliably enables VT escape processing).

- the `Bash` tool runs `%ComSpec%` (`cmd.exe /d /s /c`) — use Windows syntax
  (`dir`, not `ls`); on POSIX it uses `$SHELL -lc`
- a tool timeout kills the whole process tree (`taskkill /T /F` on Windows,
  process-group `SIGKILL` on POSIX)
- paths are shortened against `os.homedir()` (`C:\Users\you` → `~`),
  case-insensitively
- file reads and command output are normalised from CRLF to LF

## How it works

```
src/
  cli.ts                 argument parsing, provider setup, print vs TUI
  main.ts                entry point (also the no-build path)
  agent.ts               turn loop: stream -> tool_use -> run -> tool_result
  types.ts               provider-neutral blocks/events + Provider interface
  providers/
    anthropic.ts         /v1/messages, content_block_* events
    openai-chat.ts       /chat/completions, choices[].delta + tool_calls
    openai-responses.ts  /responses, response.* events + function_call items
    sse.ts  http.ts      shared SSE reader, retries, auth, ApiError
  tools/                 Read, Write, Edit, Bash
  tui/App.tsx            layout, keys, permission prompt, slash menu
  tui/lines.ts           item -> pre-wrapped rows (exact viewport heights)
  tui/commands.ts        slash-command registry and matching
  render/plain.ts        streaming renderer for print mode / non-TTY
  settings.ts            settings.json, provider presets
  tools-config.ts        tools.json
  ui-config.ts           ui.json
  jsonfile.ts            JSONC reader/writer
  mock.ts                offline server for all three formats
  platform.ts            Windows/POSIX differences
```

Conversation state is one canonical transcript (`text` / `tool_use` /
`tool_result` blocks); each provider converts at the boundary. Streaming is
normalised into six events — `text_delta`, `tool_start`, `tool_args_delta`,
`tool_end`, `usage`, `stop` — so the agent and the UI are provider-agnostic.
A denied tool call is returned to the model as a `tool_result` with
`is_error: true`, which lets it adapt instead of retrying.

Sessions are appended to `~/.echocode/projects/<slug>/<uuid>.jsonl`.

## Development

```bash
npm ci
npm run dev            # tsx src/main.ts (no build step)
npm run typecheck      # tsc --noEmit
npm run build          # tsc -> dist/
npm run demo           # offline mock, writes hello.txt
npm run repl           # offline interactive session
npm run pack:check     # npm pack --dry-run: verify dist/ ships
```

## Release

```bash
npm version patch -m "echocode %s"
git push --follow-tags
npm publish --registry=https://registry.npmjs.org/
```

The published tarball contains `bin/` and `dist/` (`files` in `package.json`);
`prepack` builds and `prepublishOnly` type-checks. `src/` is not shipped, so the
package has no runtime dependency on `tsx`.

## License

MIT — see [LICENSE](LICENSE).
