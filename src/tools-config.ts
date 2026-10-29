import path from "node:path";
import { isPlainObject, readJsonc, writeJson } from "./jsonfile.js";
import { HOME_DIR, TOOLS_FILE } from "./settings.js";
import { PERMISSION_MODES, type PermissionMode } from "./config-types.js";

export { TOOLS_FILE };

export interface ToolOption {
  enabled?: boolean;
  /** Bash only: default timeout in ms when the model does not pass one */
  timeout?: number;
}

export interface PermissionRules {
  /** auto-approve, e.g. "Read", "Bash(npm test:*)" */
  allow?: string[];
  /** always refuse, e.g. "Bash(rm -rf:*)" — wins over allow */
  deny?: string[];
}

/** tools.json — everything about executing tools. */
export interface ToolsConfig {
  permissionMode?: PermissionMode;
  tools?: Record<string, boolean | ToolOption>;
  permissions?: PermissionRules;
}

export interface LoadedToolsConfig {
  path: string;
  exists: boolean;
  config: ToolsConfig;
  warnings: string[];
}

const MODES: PermissionMode[] = PERMISSION_MODES;
const KNOWN_KEYS = new Set(["permissionMode", "tools", "permissions"]);

export function validateToolsConfig(raw: unknown): { config: ToolsConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) throw new Error("tools.json must contain a JSON object");
  const cfg: ToolsConfig = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" ignored`);
  }

  if (raw.permissionMode !== undefined) {
    const v = raw.permissionMode;
    if (typeof v === "string" && (MODES as string[]).includes(v)) cfg.permissionMode = v as PermissionMode;
    else warnings.push(`"permissionMode" must be one of ${MODES.join(" | ")} — ignored`);
  }

  if (raw.tools !== undefined) {
    if (!isPlainObject(raw.tools)) {
      warnings.push(`"tools" must be an object — ignored`);
    } else {
      const tools: Record<string, boolean | ToolOption> = {};
      for (const [name, value] of Object.entries(raw.tools)) {
        if (typeof value === "boolean") {
          tools[name] = value;
          continue;
        }
        if (isPlainObject(value)) {
          const opt: ToolOption = {};
          if (value.enabled !== undefined) {
            if (typeof value.enabled === "boolean") opt.enabled = value.enabled;
            else warnings.push(`tools.${name}.enabled must be a boolean — ignored`);
          }
          if (value.timeout !== undefined) {
            if (typeof value.timeout === "number" && value.timeout > 0) opt.timeout = value.timeout;
            else warnings.push(`tools.${name}.timeout must be a positive number — ignored`);
          }
          for (const k of Object.keys(value)) {
            if (k !== "enabled" && k !== "timeout") warnings.push(`tools.${name}.${k} is not a known option — ignored`);
          }
          tools[name] = opt;
          continue;
        }
        warnings.push(`tools.${name} must be a boolean or an object — ignored`);
      }
      cfg.tools = tools;
    }
  }

  if (raw.permissions !== undefined) {
    if (!isPlainObject(raw.permissions)) {
      warnings.push(`"permissions" must be an object — ignored`);
    } else {
      const rules: PermissionRules = {};
      for (const key of ["allow", "deny"] as const) {
        const v = raw.permissions[key];
        if (v === undefined) continue;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          warnings.push(`permissions.${key} must be an array of strings — ignored`);
          continue;
        }
        rules[key] = v as string[];
      }
      for (const k of Object.keys(raw.permissions)) {
        if (k !== "allow" && k !== "deny") warnings.push(`permissions.${k} is not a known key — ignored`);
      }
      cfg.permissions = rules;
    }
  }

  return { config: cfg, warnings };
}

export function loadToolsConfig(explicitPath?: string | null): LoadedToolsConfig {
  const file = explicitPath ?? TOOLS_FILE;
  const res = readJsonc(file);
  if (!res.exists) return { path: file, exists: false, config: {}, warnings: [] };
  if (res.raw === null) return { path: file, exists: true, config: {}, warnings: res.warnings };
  try {
    const { config, warnings } = validateToolsConfig(res.raw);
    return { path: file, exists: true, config, warnings: [...res.warnings, ...warnings] };
  } catch (err: any) {
    return { path: file, exists: true, config: {}, warnings: [String(err?.message ?? err)] };
  }
}

export const DEFAULT_TOOLS_TEMPLATE: ToolsConfig = {
  permissionMode: "default",
  tools: {
    Read: true,
    Write: true,
    Edit: true,
    Bash: { enabled: true, timeout: 120000 },
  },
  permissions: { allow: [], deny: [] },
};

export function writeToolsFile(value: unknown, opts: { force?: boolean; file?: string } = {}): string {
  return writeJson(opts.file ?? path.join(HOME_DIR, "tools.json"), value, opts);
}
