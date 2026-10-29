import fs from "node:fs";
import type { Provider } from "./types.js";
import { detectFormat, getFormat, resolveFormatId, type FormatId } from "./providers/index.js";
import {
  HOME_DIR,
  loadSettings,
  presetFor,
  SETTINGS_FILE,
  type Settings,
} from "./settings.js";
import { loadToolsConfig, type PermissionRules, type ToolOption, type ToolsConfig } from "./tools-config.js";
import { loadUiConfig } from "./ui-config.js";
import type { PermissionMode } from "./config-types.js";
import { env } from "./env.js";

export { HOME_DIR, SETTINGS_FILE, TOOLS_FILE, UI_FILE } from "./settings.js";
export type { PermissionMode } from "./config-types.js";
export type { PermissionRules, ToolOption };

/** ~/.echocode/projects/<slug> — stable key for a working directory */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "root";
}

export interface Config {
  /** free-form provider name from settings.json, e.g. "deepseek", "my-gateway" */
  providerName: string;
  /** one of anthropic-message | openai-chat | openai-response */
  formatId: FormatId;
  /** provider implementation for that format */
  provider: Provider;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  authToken: string | null;
  headers: Record<string, string>;
  maxTokens: number;
  maxTurns: number;
  contextLimit: number;
  permissionMode: PermissionMode;
  theme: string;
  systemAppend: string | null;
  cwd: string;

  toolsConfig: Record<string, boolean | ToolOption>;
  permissionRules: PermissionRules;

  paths: { settings: string; tools: string; ui: string };
  existed: { settings: boolean; tools: boolean; ui: boolean };
  warnings: string[];
}

export interface CliOverrides {
  provider?: string;
  format?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  maxTurns?: number;
  permissionMode?: string;
  theme?: string;
  systemAppend?: string;
  settingsPath?: string;
  toolsPath?: string;
  uiPath?: string;
}

const DEFAULTS = {
  maxTokens: 32000,
  maxTurns: 60,
  contextLimit: 180_000,
  theme: "green",
  permissionMode: "default" as PermissionMode,
};

/**
 * Precedence: CLI flag > environment variable > file > built-in default.
 *
 * settings.json  provider name + format + endpoint/auth + generation limits
 * tools.json     tool switches, permission mode, allow/deny rules
 * ui.json        theme
 */
export function resolveConfig(cli: CliOverrides = {}): Config {
  const loaded = loadSettings(cli.settingsPath);
  const s: Settings = loaded.settings;
  const penv = process.env;
  const warnings: string[] = [...loaded.warnings];

  // ---- provider name (free text) -----------------------------------------
  const cliProvider = cli.provider?.trim();
  const envProvider = env("PROVIDER")?.trim();
  const explicitProvider = cliProvider || envProvider || null; // higher priority than the file
  const rawProvider = explicitProvider ?? s.provider?.trim() ?? "";
  // A known provider name keeps its name. Only unknown strings get read as a
  // format, so old scripts that passed --provider chat still work.
  const rawPreset = presetFor(rawProvider);
  const providerAsFormat = rawPreset ? null : resolveFormatId(rawProvider || null);
  const providerName = rawProvider || providerAsFormat || "anthropic";
  const preset = rawPreset ?? presetFor(providerName);
  const fromCli = Boolean(explicitProvider);

  // ---- format (the only three allowed values) ----------------------------
  if (cli.format && !resolveFormatId(cli.format)) {
    throw new Error(
      `unknown --format "${cli.format}" — use one of anthropic-message | openai-chat | openai-response`,
    );
  }
  const formatId: FormatId =
    providerAsFormat ??
    resolveFormatId(cli.format) ??
    resolveFormatId(env("FORMAT")) ??
    (fromCli ? preset?.format : undefined) ?? // an explicit provider overrides the file
    s.format ??
    preset?.format ??
    detectFormat(
      cli.baseUrl ?? env("BASE_URL") ?? penv.ANTHROPIC_BASE_URL ?? penv.OPENAI_BASE_URL ?? s.baseUrl ?? null,
    );
  const provider = getFormat(formatId);

  if (cliProvider && !providerAsFormat && !preset) {
    const url = cli.baseUrl ?? env("BASE_URL") ?? s.baseUrl;
    if (!url) {
      throw new Error(
        `provider "${cliProvider}" is not a known preset, so it needs a baseUrl (--base-url, env("BASE_URL"), or "${"baseUrl"}" in ${loaded.path})`,
      );
    }
  }

  // ---- endpoint ----------------------------------------------------------
  const flagBase = cli.baseUrl ?? env("BASE_URL") ?? penv.ANTHROPIC_BASE_URL ?? penv.OPENAI_BASE_URL ?? null;
  const baseUrlRaw = flagBase ?? (fromCli ? preset?.baseUrl : undefined) ?? s.baseUrl ?? preset?.baseUrl ?? provider.defaultBaseUrl;

  if (!flagBase && !s.baseUrl && !preset) {
    warnings.push(
      `provider "${providerName}" is not a known preset and no baseUrl is set — falling back to ${provider.defaultBaseUrl}`,
    );
  }

  // ---- credential --------------------------------------------------------
  // preset.keyEnv holds env *names* — look the values up, do not use the names
  const envKey = [
    env("API_KEY"),
    ...(preset?.keyEnv ?? []).map((name) => process.env[name]),
    formatId === "anthropic-message" ? penv.ANTHROPIC_API_KEY : penv.OPENAI_API_KEY,
    penv.ANTHROPIC_API_KEY,
    penv.OPENAI_API_KEY,
  ].find((v): v is string => Boolean(v));

  // ---- tools.json / ui.json ---------------------------------------------
  const tools = loadToolsConfig(cli.toolsPath);
  const ui = loadUiConfig(cli.uiPath);
  const toolsCfg: ToolsConfig = tools.config;
  warnings.push(...tools.warnings, ...ui.warnings);

  return {
    providerName,
    formatId,
    provider,
    model:
      cli.model ?? env("MODEL") ?? (fromCli ? preset?.model : undefined) ?? s.model ?? preset?.model ?? provider.defaultModel,
    baseUrl: baseUrlRaw.replace(/\/+$/, ""),
    apiKey: cli.apiKey ?? envKey ?? (s.apiKey?.trim() ? s.apiKey : null),
    authToken: env("AUTH_TOKEN") ?? penv.ANTHROPIC_AUTH_TOKEN ?? s.authToken ?? null,
    headers: s.headers ?? {},
    maxTokens: Number(cli.maxTokens ?? env("MAX_TOKENS") ?? s.maxTokens ?? DEFAULTS.maxTokens),
    maxTurns: Number(cli.maxTurns ?? s.maxTurns ?? DEFAULTS.maxTurns),
    contextLimit: Number(s.contextLimit ?? DEFAULTS.contextLimit),
    permissionMode: (cli.permissionMode ?? toolsCfg.permissionMode ?? DEFAULTS.permissionMode) as PermissionMode,
    theme: cli.theme ?? env("THEME") ?? ui.config.theme ?? DEFAULTS.theme,
    systemAppend: cli.systemAppend ?? s.systemAppend ?? null,
    cwd: process.cwd(),
    toolsConfig: toolsCfg.tools ?? {},
    permissionRules: toolsCfg.permissions ?? {},
    paths: { settings: loaded.path, tools: tools.path, ui: ui.path },
    existed: { settings: loaded.exists, tools: tools.exists, ui: ui.exists },
    warnings,
  };
}

export function ensureHome(): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
}

/** Redacted view used by `echocode settings` and the TUI. */
export function effectiveView(cfg: Config): Record<string, unknown> {
  const redact = (v: string | null) => (v ? `${v.slice(0, 6)}…${v.slice(-4)}` : null);
  return {
    settings: cfg.paths.settings,
    provider: cfg.providerName,
    format: cfg.formatId,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey: redact(cfg.apiKey),
    authToken: redact(cfg.authToken),
    headers: Object.keys(cfg.headers).length ? cfg.headers : null,
    maxTokens: cfg.maxTokens,
    maxTurns: cfg.maxTurns,
    contextLimit: cfg.contextLimit,
    systemAppend: cfg.systemAppend ? "(set)" : null,
    "tools.json": cfg.paths.tools,
    permissionMode: cfg.permissionMode,
    tools: cfg.toolsConfig,
    permissions: cfg.permissionRules,
    "ui.json": cfg.paths.ui,
    theme: cfg.theme,
    cwd: cfg.cwd,
  };
}
