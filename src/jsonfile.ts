import fs from "node:fs";
import path from "node:path";

/** JSON with // and /* *​/ comments — config files are meant to be hand-edited. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

export interface JsonFileResult {
  path: string;
  exists: boolean;
  raw: unknown;
  warnings: string[];
}

/** Never throws on a malformed file: returns raw=null plus a warning instead. */
export function readJsonc(file: string): JsonFileResult {
  if (!fs.existsSync(file)) return { path: file, exists: false, raw: null, warnings: [] };
  try {
    return { path: file, exists: true, raw: parseJsonc(fs.readFileSync(file, "utf8")), warnings: [] };
  } catch (err: any) {
    return {
      path: file,
      exists: true,
      raw: null,
      warnings: [`could not parse ${file}: ${err?.message ?? String(err)} — using defaults`],
    };
  }
}

export function writeJson(file: string, value: unknown, opts: { force?: boolean } = {}): string {
  if (fs.existsSync(file) && !opts.force) throw new Error(`${file} already exists (use --force to overwrite)`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
