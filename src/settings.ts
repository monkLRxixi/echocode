import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonc, writeJson, isPlainObject } from "./jsonfile.js";
import { FORMAT_IDS, resolveFormatId, type FormatId } from "./providers/index.js";

export const HOME_DIR = path.join(os.homedir(), ".echocode");
export const SETTINGS_FILE = path.join(HOME_DIR, "settings.json");
export const TOOLS_FILE = path.join(HOME_DIR, "tools.json");
export const UI_FILE = path.join(HOME_DIR, "ui.json");
/** pre-0.3 installs used config.json; still read as a fallback */
export const LEGACY_FILE = path.join(HOME_DIR, "config.json");
/** the project was called deepcode before; migrate its config once */
export const LEGACY_HOME = path.join(os.homedir(), ".deepcode");

/**
 * Known provider names. `provider` itself is free text — matching a key here
 * only means the format / base URL / default model get filled in for you.
 */
export interface ProviderPreset {
  format: FormatId;
  baseUrl?: string;
  model?: string;
  keyEnv?: string[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    format: "anthropic-message",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    keyEnv: ["ANTHROPIC_API_KEY"],
  },
  openai: {
    format: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    keyEnv: ["OPENAI_API_KEY"],
  },
  "openai-responses": {
    format: "openai-response",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    keyEnv: ["OPENAI_API_KEY"],
  },
  // a format id is also accepted as a provider name (old-style "--provider chat")
  "anthropic-message": {
    format: "anthropic-message",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    keyEnv: ["ANTHROPIC_API_KEY"],
  },
  "openai-chat": {
    format: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    keyEnv: ["OPENAI_API_KEY"],
  },
  "openai-response": {
    format: "openai-response",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    keyEnv: ["OPENAI_API_KEY"],
  },
  deepseek: {
    format: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyEnv: ["DEEPSEEK_API_KEY"],
  },
  moonshot: {
    format: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    keyEnv: ["MOONSHOT_API_KEY"],
  },
  groq: {
    format: "openai-chat",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    keyEnv: ["GROQ_API_KEY"],
  },
  openrouter: {
    format: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4.5",
    keyEnv: ["OPENROUTER_API_KEY"],
  },
  ollama: {
    format: "openai-chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder:32b",
    keyEnv: [],
  },
  vllm: {
    format: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "local-model",
    keyEnv: [],
  },
};

/** settings.json — provider/model/endpoint/auth only. Tools live in tools.json. */
export interface Settings {
  provider?: string;
  format?: FormatId;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  authToken?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  maxTurns?: number;
  contextLimit?: number;
  systemAppend?: string;
}

export interface LoadedSettings {
  path: string;
  exists: boolean;
  settings: Settings;
  warnings: string[];
}

const KNOWN_KEYS = new Set([
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
]);

export function validateSettings(raw: unknown): { settings: Settings; warnings: string[] } {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) throw new Error("settings.json must contain a JSON object");
  const s: Settings = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" ignored`);
  }

  const str = (k: keyof Settings, label = String(k)) => {
    const v = raw[k];
    if (v === undefined || v === null) return;
    if (typeof v !== "string") {
      warnings.push(`"${label}" must be a string, got ${typeof v} — ignored`);
      return;
    }
    if (v.trim()) (s as Record<string, unknown>)[k] = v.trim();
  };
  const num = (k: keyof Settings, min = 1) => {
    const v = raw[k];
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
      warnings.push(`"${String(k)}" must be a number >= ${min} — ignored`);
      return;
    }
    (s as Record<string, unknown>)[k] = v;
  };

  str("provider");
  str("model");
  str("baseUrl");
  str("apiKey");
  str("authToken");
  str("systemAppend");
  num("maxTokens");
  num("maxTurns");
  num("contextLimit", 1000);

  if (raw.format !== undefined && raw.format !== null) {
    const id = resolveFormatId(String(raw.format));
    if (id) s.format = id;
    else warnings.push(`"format" must be one of ${FORMAT_IDS.join(" | ")} — got "${String(raw.format)}"; will auto-detect`);
  }

  if (raw.headers !== undefined && raw.headers !== null) {
    if (!isPlainObject(raw.headers)) {
      warnings.push(`"headers" must be an object of string values — ignored`);
    } else {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === "string") headers[k] = v;
        else warnings.push(`headers.${k} must be a string — ignored`);
      }
      s.headers = headers;
    }
  }

  return { settings: s, warnings };
}

/**
 * One-time upgrade from ~/.deepcode (the previous name).
 *
 * The old layout kept everything in settings.json, so keys are split into the
 * new files: tools/permissions/permissionMode -> tools.json, theme -> ui.json.
 * Explicit tools.json / ui.json files win over the split, and existing target
 * files are never overwritten.
 */
export function migrateLegacyHome(): string[] {
  const made: string[] = [];
  if (!fs.existsSync(HOME_DIR) || !fs.existsSync(LEGACY_HOME)) return made;

  const read = (file: string) => {
    const res = readJsonc(file);
    return res.exists && isPlainObject(res.raw) ? res.raw : null;
  };

  const rawSettings = read(path.join(LEGACY_HOME, "settings.json"));

  // ---- tools.json
  const toolsTarget = path.join(HOME_DIR, "tools.json");
  if (!fs.existsSync(toolsTarget)) {
    const legacyTools = read(path.join(LEGACY_HOME, "tools.json"));
    if (legacyTools) {
      writeJson(toolsTarget, legacyTools);
      made.push(toolsTarget);
    } else if (rawSettings) {
      const split = {
        ...(rawSettings.permissionMode !== undefined ? { permissionMode: rawSettings.permissionMode } : {}),
        ...(rawSettings.tools !== undefined ? { tools: rawSettings.tools } : {}),
        ...(rawSettings.permissions !== undefined ? { permissions: rawSettings.permissions } : {}),
      };
      if (Object.keys(split).length) {
        writeJson(toolsTarget, split);
        made.push(toolsTarget);
      }
    }
  }

  // ---- ui.json
  const uiTarget = path.join(HOME_DIR, "ui.json");
  if (!fs.existsSync(uiTarget)) {
    const legacyUi = read(path.join(LEGACY_HOME, "ui.json"));
    if (legacyUi) {
      writeJson(uiTarget, legacyUi);
      made.push(uiTarget);
    } else if (rawSettings && typeof rawSettings.theme === "string") {
      writeJson(uiTarget, { theme: rawSettings.theme });
      made.push(uiTarget);
    }
  }

  // ---- settings.json (provider/model only)
  if (!fs.existsSync(SETTINGS_FILE) && rawSettings) {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawSettings)) {
      if (KNOWN_KEYS.has(k)) clean[k] = v;
    }
    if (clean.format === undefined) {
      const preset = presetFor(typeof clean.provider === "string" ? clean.provider : null);
      if (preset) clean.format = preset.format;
    }
    if (Object.keys(clean).length) {
      writeJson(SETTINGS_FILE, clean);
      made.push(SETTINGS_FILE);
    }
  }

  return made;
}

export function loadSettings(explicitPath?: string | null): LoadedSettings {
  const candidates = explicitPath
    ? [explicitPath]
    : [SETTINGS_FILE, LEGACY_FILE, path.join(LEGACY_HOME, "config.json")];

  for (const file of candidates) {
    const res = readJsonc(file);
    if (!res.exists) continue;
    if (res.raw === null) return { path: file, exists: true, settings: {}, warnings: res.warnings };
    try {
      const { settings, warnings } = validateSettings(res.raw);
      const all = [...res.warnings, ...warnings];
      if (file !== SETTINGS_FILE && !explicitPath) all.push(`using legacy ${file}; rename it to settings.json`);
      return { path: file, exists: true, settings, warnings: all };
    } catch (err: any) {
      return { path: file, exists: true, settings: {}, warnings: [String(err?.message ?? err)] };
    }
  }

  return { path: explicitPath ?? SETTINGS_FILE, exists: false, settings: {}, warnings: [] };
}

export const DEFAULT_SETTINGS_TEMPLATE: Settings & Record<string, unknown> = {
  provider: "anthropic",
  format: "anthropic-message",
  model: "claude-sonnet-4-5",
  baseUrl: "https://api.anthropic.com",
  apiKey: "",
  maxTokens: 32000,
  maxTurns: 60,
  contextLimit: 180000,
};

export function writeSettingsFile(value: unknown, opts: { force?: boolean; file?: string } = {}): string {
  return writeJson(opts.file ?? SETTINGS_FILE, value, opts);
}

/** Case-insensitive lookup so `"provider": "DeepSeek"` still finds the preset. */
export function presetFor(provider: string | undefined | null): ProviderPreset | null {
  if (!provider) return null;
  return PROVIDER_PRESETS[provider.trim().toLowerCase()] ?? null;
}
