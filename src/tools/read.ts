import fs from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./fsutil.js";
import { fmtBytes, relPath, readTextFile, resolvePath } from "./fsutil.js";

const MAX_LINES = 2000;
const MAX_BYTES = 400_000;

export const Read: Tool = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Returns the file content with 1-based line numbers. " +
    "Use offset/limit for large files. Always read a file before editing it.",
  isReadOnly: true,
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or cwd-relative path to the file." },
      offset: { type: "number", description: "1-based line to start from." },
      limit: { type: "number", description: "Maximum number of lines to return." },
    },
    required: ["file_path"],
    additionalProperties: false,
  },

  async run(input: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolvePath(ctx, input.file_path);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200);
      const text = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
      return { ok: true, text: `(directory) ${relPath(ctx, abs)}\n${text}`, meta: `${entries.length} entries` };
    }
    if (stat.size > 8 * 1024 * 1024) {
      return { ok: false, text: `file is too large (${fmtBytes(stat.size)}); use Bash with head/tail or grep` };
    }

    const raw = readTextFile(abs);
    const all = raw.split("\n");
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.min(MAX_LINES, Number(input.limit) || MAX_LINES);
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join("\n");
    const text = numbered.length > MAX_BYTES ? `${numbered.slice(0, MAX_BYTES)}\n… (truncated)` : numbered;
    return { ok: true, text, meta: `${slice.length}/${all.length} lines` };
  },
};
