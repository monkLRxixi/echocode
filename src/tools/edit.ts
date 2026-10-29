import fs from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./fsutil.js";
import { readTextFile, relPath, resolvePath } from "./fsutil.js";

export const Edit: Tool = {
  name: "Edit",
  description:
    "Replace an exact string in a file. old_string must match exactly (including indentation) and must be " +
    "unique unless replace_all is true. Read the file first; if the edit fails, re-read and fix the string.",
  mutating: "edit",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)." },
      replace_all: { type: "boolean", description: "Replace every occurrence." },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },

  async run(input: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolvePath(ctx, input.file_path);
    if (!fs.existsSync(abs)) return { ok: false, text: `file not found: ${relPath(ctx, abs)}` };
    const src = readTextFile(abs);
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    if (oldStr === newStr) return { ok: false, text: "old_string and new_string are identical; nothing to do" };

    const count = countOccurrences(src, oldStr);
    if (count === 0) {
      return {
        ok: false,
        text:
          `old_string not found in ${relPath(ctx, abs)}. ` +
          `Re-read the file and copy the exact text, including whitespace.`,
      };
    }
    if (count > 1 && !input.replace_all) {
      return {
        ok: false,
        text:
          `old_string matches ${count} places in ${relPath(ctx, abs)}; ` +
          `add surrounding context to make it unique, or pass replace_all: true`,
      };
    }

    const next = input.replace_all ? src.split(oldStr).join(newStr) : src.replace(oldStr, () => newStr);
    fs.writeFileSync(abs, next, "utf8");
    return {
      ok: true,
      text:
        `Edited ${relPath(ctx, abs)}: replaced ${count} occurrence${count > 1 ? "s" : ""} ` +
        `(${src.split("\n").length} → ${next.split("\n").length} lines)`,
    };
  },
};

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}
