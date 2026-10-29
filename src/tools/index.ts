import type { ToolSpec } from "../types.js";
import type { ToolOption } from "../tools-config.js";
import type { Tool } from "./fsutil.js";
import { Read } from "./read.js";
import { Write } from "./write.js";
import { Edit } from "./edit.js";
import { Bash } from "./bash.js";

export const ALL_TOOLS: Tool[] = [Read, Write, Edit, Bash];

export function toolSpecs(tools: Tool[] = ALL_TOOLS): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

export function toolByName(name: string): Tool | null {
  return ALL_TOOLS.find((t) => t.name === name) ?? null;
}

/**
 * Turns the `tools` block of settings.json into the tool list for this session.
 * A tool is on unless explicitly disabled; per-tool options are applied as
 * wrappers so the tool implementations stay stateless.
 */
export function buildTools(config: Record<string, boolean | ToolOption> = {}): Tool[] {
  const out: Tool[] = [];
  for (const tool of ALL_TOOLS) {
    const entry = config[tool.name];
    const enabled = typeof entry === "boolean" ? entry : (entry?.enabled ?? true);
    if (!enabled) continue;

    if (tool === Bash) {
      const timeout = typeof entry === "object" ? entry?.timeout : undefined;
      if (timeout && timeout > 0) {
        out.push({
          ...Bash,
          run: (input, ctx) => Bash.run({ timeout, ...input }, ctx),
        });
        continue;
      }
    }
    out.push(tool);
  }
  return out;
}
