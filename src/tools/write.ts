import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./fsutil.js";
import { fmtBytes, relPath, resolvePath } from "./fsutil.js";

export const Write: Tool = {
  name: "Write",
  description:
    "Write a file to the local filesystem, creating parent directories as needed. " +
    "Overwrites the whole file — use Edit for partial changes, and read an existing file before overwriting it.",
  mutating: "edit",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or cwd-relative path." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },

  async run(input: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolvePath(ctx, input.file_path);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const data = String(input.content ?? "");
    fs.writeFileSync(abs, data, "utf8");
    const lines = data.split("\n").length;
    return {
      ok: true,
      text: `${existed ? "Overwrote" : "Created"} ${relPath(ctx, abs)} (${fmtBytes(Buffer.byteLength(data))}, ${lines} lines)`,
    };
  },
};
