import path from "node:path";
import { isPlainObject, readJsonc, writeJson } from "./jsonfile.js";
import { HOME_DIR, UI_FILE } from "./settings.js";

export { UI_FILE };

/** ui.json — presentation only. */
export interface UiConfig {
  theme?: string;
}

export interface LoadedUiConfig {
  path: string;
  exists: boolean;
  config: UiConfig;
  warnings: string[];
}

export function validateUiConfig(raw: unknown): { config: UiConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) throw new Error("ui.json must contain a JSON object");
  const config: UiConfig = {};
  for (const key of Object.keys(raw)) {
    if (key !== "theme") warnings.push(`unknown key "${key}" ignored`);
  }
  if (raw.theme !== undefined && raw.theme !== null) {
    if (typeof raw.theme !== "string") warnings.push(`"theme" must be a string — ignored`);
    else config.theme = raw.theme;
  }
  return { config, warnings };
}

export function loadUiConfig(explicitPath?: string | null): LoadedUiConfig {
  const file = explicitPath ?? UI_FILE;
  const res = readJsonc(file);
  if (!res.exists) return { path: file, exists: false, config: {}, warnings: [] };
  if (res.raw === null) return { path: file, exists: true, config: {}, warnings: res.warnings };
  try {
    const { config, warnings } = validateUiConfig(res.raw);
    return { path: file, exists: true, config, warnings: [...res.warnings, ...warnings] };
  } catch (err: any) {
    return { path: file, exists: true, config: {}, warnings: [String(err?.message ?? err)] };
  }
}

export const DEFAULT_UI_TEMPLATE: UiConfig = { theme: "green" };

export function writeUiFile(value: unknown, opts: { force?: boolean; file?: string } = {}): string {
  return writeJson(opts.file ?? path.join(HOME_DIR, "ui.json"), value, opts);
}
