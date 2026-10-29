import { createElement } from "react";
import { effectiveView, ensureHome, resolveConfig, type PermissionMode } from "./config.js";
import { buildSystem, VERSION } from "./prompt.js";
import { buildTools, toolSpecs } from "./tools/index.js";
import { DEFAULT_SETTINGS_TEMPLATE, HOME_DIR, migrateLegacyHome, SETTINGS_FILE, writeSettingsFile } from "./settings.js";
import { DEFAULT_TOOLS_TEMPLATE, TOOLS_FILE, writeToolsFile } from "./tools-config.js";
import { DEFAULT_UI_TEMPLATE, UI_FILE, writeUiFile } from "./ui-config.js";
import { Permissions } from "./permissions.js";
import { Session } from "./session.js";
import { Agent } from "./agent.js";
import { createPlainRenderer } from "./render/plain.js";
import { startMock, type MockHandle } from "./mock.js";
import { c } from "./theme.js";

interface Args {
  rest: string[];
  print?: boolean;
  provider?: string;
  format?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTurns?: number;
  maxTokens?: number;
  permissionMode?: string;
  systemAppend?: string;
  theme?: string;
  settingsPath?: string;
  toolsPath?: string;
  uiPath?: string;
  mock?: boolean;
  noColor?: boolean;
  verbose?: boolean;
  help?: boolean;
  version?: boolean;
}

const HELP = `
${c.greenBold("echocode")} ${c.dim(`v${VERSION}`)} — terminal coding agent. TypeScript + Ink, green/white.

${c.bold("USAGE")}
  echocode                            interactive TUI
  echocode "fix the failing test"     start with a first message
  echocode -p "summarise src/"        one-shot, plain output
  echo "explain X" | echocode -p      one-shot from stdin

${c.bold("PROVIDER + FORMAT")}
  provider is a free-form name ("anthropic", "deepseek", "my-gateway", …).
  format is the wire protocol and must be one of:

      anthropic-message    POST /v1/messages         x-api-key
      openai-chat          POST /chat/completions    Bearer
      openai-response      POST /responses           Bearer

  --provider <name>   provider name (known names also fill in baseUrl/model)
  --format <format>   force the message format
  (old --provider chat|responses|messages still works: it is read as a format)

${c.bold("OPTIONS")}
  -p, --print               non-interactive
  -m, --model <id>          model id
      --base-url <url>      API base url
      --api-key <key>       credential
      --max-turns <n>       tool-loop cap        (default 60)
      --max-tokens <n>      per-request cap      (default 32000)
      --permission-mode <m> default | acceptEdits | auto | plan | bypassPermissions
  -y, --yes                 = bypassPermissions
      --plan                = read-only explore mode
      --system-append <s>   extra system text
      --settings <path>     use another settings.json
      --mock [--format f]   offline mock for all three formats
      --verbose             token/cost lines on stderr (print mode)
      --no-color            disable ANSI
  -h, --help  -V, --version

${c.bold("SLASH COMMANDS")} ${c.dim("(TUI)")}  /help /clear /model <id> /permissions <mode> /cost /context /session /exit

${c.bold("CONFIG")} ${c.dim("all three are data-driven, JSON with // comments")}
  ${HOME_DIR}/settings.json   provider, format, model, baseUrl, apiKey, authToken,
                             headers, maxTokens, maxTurns, contextLimit
  ${HOME_DIR}/tools.json      permissionMode, per-tool on/off + options,
                             permissions.allow / permissions.deny
  ${HOME_DIR}/ui.json         theme (green | mono)

  Precedence: flag > env var > config file > default.

    echocode settings              show the effective config
    echocode settings --json       machine-readable
    echocode settings --path       print the three file paths
    echocode settings --init       write default files (--force to overwrite)

${c.bold("FILES")}  ${HOME_DIR}/settings.json · ${HOME_DIR}/projects/<slug>/*.jsonl
`;

function parseArgs(argv: string[]): Args {
  const out: Args = { rest: [] };
  const valueFlags = new Set([
    "-m", "--model", "--base-url", "--api-key", "--max-turns", "--max-tokens",
    "--permission-mode", "--system-append", "--theme", "--provider", "--settings",
    "--format", "--tools", "--tools-file", "--ui", "--ui-file",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const val = () => inline ?? argv[++i];
    switch (flag) {
      case "-p":
      case "--print":
        out.print = true;
        break;
      case "-m":
      case "--model":
        out.model = val();
        break;
      case "--provider":
        out.provider = val();
        break;
      case "--format":
        out.format = val();
        break;
      case "--tools":
      case "--tools-file":
        out.toolsPath = val();
        break;
      case "--ui":
      case "--ui-file":
        out.uiPath = val();
        break;
      case "--base-url":
        out.baseUrl = val();
        break;
      case "--api-key":
        out.apiKey = val();
        break;
      case "--max-turns":
        out.maxTurns = Number(val());
        break;
      case "--max-tokens":
        out.maxTokens = Number(val());
        break;
      case "--permission-mode":
        out.permissionMode = val();
        break;
      case "--system-append":
        out.systemAppend = val();
        break;
      case "--theme":
        out.theme = val();
        break;
      case "--settings":
        out.settingsPath = val();
        break;
      case "-y":
      case "--yes":
        out.permissionMode = "bypassPermissions";
        break;
      case "--plan":
        out.permissionMode = "plan";
        break;
      case "--mock":
        out.mock = true;
        break;
      case "--no-color":
        out.noColor = true;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--settings-path":
        out.settingsPath = val();
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-V":
      case "--version":
        out.version = true;
        break;
      default:
        if (valueFlags.has(flag)) out.rest.push(a);
        else out.rest.push(a);
    }
  }
  return out;
}

async function settingsCommand(argv: string[], explicitPath?: string): Promise<void> {
  ensureHome();
  for (const file of migrateLegacyHome()) {
    process.stderr.write(`${c.green("config")} ${c.dim(`migrated ${file}`)}\n`);
  }
  const has = (...names: string[]) => names.some((n) => argv.includes(n));
  const force = has("--force");
  const files = {
    settings: explicitPath ?? SETTINGS_FILE,
    tools: TOOLS_FILE,
    ui: UI_FILE,
  };

  if (has("--path", "-p")) {
    for (const [name, file] of Object.entries(files)) process.stdout.write(`${name.padEnd(9)} ${file}\n`);
    return;
  }

  if (has("--init")) {
    const jobs: Array<[string, unknown]> = [
      [files.settings, DEFAULT_SETTINGS_TEMPLATE],
      [files.tools, DEFAULT_TOOLS_TEMPLATE],
      [files.ui, DEFAULT_UI_TEMPLATE],
    ];
    for (const [file, template] of jobs) {
      try {
        const written = writeSettingsFile(template, { file, force });
        process.stdout.write(`${c.green("wrote")} ${written}\n`);
      } catch (err: any) {
        process.stderr.write(`${c.red("error:")} ${err?.message ?? String(err)}\n`);
        process.exitCode = 1;
      }
    }
    return;
  }

  // allow previewing overrides: `echocode settings --provider deepseek`
  const over = parseArgs(argv);
  explicitPath = over.settingsPath ?? explicitPath;
  const cfg = resolveConfig({
    settingsPath: explicitPath,
    provider: over.provider,
    format: over.format,
    model: over.model,
    baseUrl: over.baseUrl,
    apiKey: over.apiKey,
    theme: over.theme,
    permissionMode: over.permissionMode,
    toolsPath: over.toolsPath,
    uiPath: over.uiPath,
  });

  if (has("--json")) {
    process.stdout.write(`${JSON.stringify({ ...effectiveView(cfg), warnings: cfg.warnings }, null, 2)}\n`);
    return;
  }

  const view = effectiveView(cfg);
  const settingsView = [
    "provider",
    "format",
    "model",
    "baseUrl",
    "apiKey",
    "authToken",
    "headers",
    "maxTokens",
    "maxTurns",
    "contextLimit",
    "systemAppend",
  ];
  const toolsView = ["permissionMode", "tools", "permissions"];
  const uiView = ["theme"];

  const printBlock = (title: string, file: string, exists: boolean, keys: string[]) => {
    process.stdout.write(
      `${c.greenBold(title)} ${c.dim(file)}${exists ? "" : c.dim(" (missing — defaults)")}\n`,
    );
    for (const k of keys) {
      const v = (view as Record<string, unknown>)[k];
      const shown =
        v === null || v === undefined
          ? c.faint("—")
          : typeof v === "object"
            ? c.dim(JSON.stringify(v))
            : c.white(String(v));
      process.stdout.write(`  ${c.dim(k.padEnd(14))} ${shown}\n`);
    }
    process.stdout.write("\n");
  };

  printBlock("settings", cfg.paths.settings, cfg.existed.settings, settingsView);
  printBlock("tools", cfg.paths.tools, cfg.existed.tools, toolsView);
  printBlock("ui", cfg.paths.ui, cfg.existed.ui, uiView);

  if (cfg.warnings.length) {
    process.stdout.write(`${c.yellow("warnings")}\n`);
    for (const w of cfg.warnings) process.stdout.write(`  ${c.dim(w)}\n`);
  }
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text || null;
}

export async function main(argv: string[]): Promise<void> {
  // `settings` is a subcommand: parse its own flags so --provider/--format here
  // mean "preview this override", not "run the agent".
  if (argv[0] === "settings" || argv[0] === "config") {
    if (argv.includes("-h") || argv.includes("--help")) {
      process.stdout.write(`${HELP}\n`);
      return;
    }
    await settingsCommand(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);
  if (args.noColor) process.env.NO_COLOR = "1";
  if (args.theme) process.env.ECHOCODE_THEME = args.theme;
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args.version) {
    process.stdout.write(`echocode ${VERSION}\n`);
    return;
  }

  ensureHome(); // the target dir must exist before migrating into it
  const migrated = migrateLegacyHome();
  for (const file of migrated) process.stderr.write(`${c.green("config")} ${c.dim(`migrated ${file}`)}\n`);

  const cfg = resolveConfig({
    provider: args.provider,
    format: args.format,
    model: args.model,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    maxTokens: args.maxTokens,
    maxTurns: args.maxTurns,
    permissionMode: args.permissionMode,
    theme: args.theme,
    systemAppend: args.systemAppend,
    settingsPath: args.settingsPath,
    toolsPath: args.toolsPath,
    uiPath: args.uiPath,
  });

  // the theme modules read env at first render, so publish it before importing them
  process.env.ECHOCODE_THEME = cfg.theme;

  for (const w of cfg.warnings) process.stderr.write(`${c.yellow("config")} ${c.dim(w)}\n`);
  // first run: materialise all three files so the install is data-driven from the start
  for (const [exists, file, template] of [
    [cfg.existed.settings, cfg.paths.settings, DEFAULT_SETTINGS_TEMPLATE],
    [cfg.existed.tools, cfg.paths.tools, DEFAULT_TOOLS_TEMPLATE],
    [cfg.existed.ui, cfg.paths.ui, DEFAULT_UI_TEMPLATE],
  ] as const) {
    if (exists) continue;
    try {
      writeSettingsFile(template, { file, force: true });
      process.stderr.write(`${c.green("config")} ${c.dim(`created ${file}`)}\n`);
    } catch {
      /* read-only home: keep running on defaults */
    }
  }

  let mock: MockHandle | null = null;
  let mockLabel: string | null = null;
  if (args.mock) {
    mock = await startMock();
    cfg.baseUrl = mock.baseUrl;
    cfg.apiKey = "mock";
    mockLabel = `mock ${cfg.formatId}`;
  } else if (!cfg.apiKey && !cfg.authToken) {
    process.stderr.write(
      `${c.red("no API key")}\n` +
        `  put it in ${cfg.paths.settings} ("apiKey"), set ${cfg.provider.keyEnv.join(" / ")}, pass --api-key, or run ${c.green("echocode --mock")}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const printMode = Boolean(args.print) || !isTTY;

  const session = new Session({ cwd: cfg.cwd, model: cfg.model });
  const permissions = new Permissions({
    mode: (args.permissionMode as PermissionMode) ?? cfg.permissionMode,
    isTTY: isTTY && !printMode,
    rules: cfg.permissionRules,
    rulesSource: "tools.json",
  });
  const tools = permissions.allowedTools(buildTools(cfg.toolsConfig));
  if (!tools.length) {
    process.stderr.write(`${c.red("no tools enabled")} — check the "tools" block in ${cfg.paths.tools}\n`);
    process.exitCode = 1;
    await mock?.close();
    return;
  }
  const specs = toolSpecs(tools);
  const system = () =>
    buildSystem({
      tools: specs,
      cwd: cfg.cwd,
      model: cfg.model,
      providerLabel: `${cfg.providerName} (${cfg.formatId})`,
      append: cfg.systemAppend,
    });

  const agent = new Agent({
    cfg,
    session,
    permissions,
    system,
    tools,
    specs,
    contextLimit: cfg.contextLimit,
  });

  const cleanup = async () => {
    await mock?.close();
  };

  if (printMode) {
    const prompt = args.rest.join(" ").trim() || (await readStdin());
    if (!prompt) {
      process.stderr.write("nothing to do: pass a prompt or pipe stdin\n");
      process.exitCode = 1;
      await cleanup();
      return;
    }
    const renderer = createPlainRenderer({ verbose: args.verbose });
    try {
      await agent.run(prompt, renderer);
    } finally {
      renderer.done();
      await cleanup();
    }
    return;
  }

  const { render } = await import("ink");
  const { App } = await import("./tui/App.js");

  // A fixed-height layout needs the alternate screen: the composer is pinned to
  // the bottom of the window instead of floating after the last message.
  // mouse reporting: without it the terminal turns wheel events into arrow keys
  // (tmux alternate-scroll), which would browse the prompt history instead of
  // scrolling the transcript.
  const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
  const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
  const ALT_ENTER = `\x1b[?1049h\x1b[H\x1b[2J${MOUSE_ON}`;
  const ALT_LEAVE = `${MOUSE_OFF}\x1b[?1049l`;
  const useAlt = process.env.ECHOCODE_ALT_SCREEN !== "0" && Boolean(process.stdout.isTTY);
  let alt = false;
  const restore = () => {
    if (!useAlt || !alt) return;
    alt = false;
    process.stdout.write(ALT_LEAVE);
  };
  if (useAlt) {
    process.stdout.write(ALT_ENTER);
    alt = true;
    process.on("exit", restore);
  }

  const instance = render(
    createElement(App, {
      cfg,
      agent,
      session,
      permissions,
      mockLabel,
      onExit: async () => {
        await cleanup();
      },
    }),
    { exitOnCtrlC: false, patchConsole: false },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    restore();
    await cleanup();
  }
}
