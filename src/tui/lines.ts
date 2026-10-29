/**
 * Line-oriented transcript rendering.
 *
 * The TUI owns a fixed-height viewport (alternate screen), so it has to know how
 * many terminal rows every item occupies. Ink does not expose that, therefore we
 * wrap text ourselves and render `<Text wrap="truncate">` — one array entry = one
 * row, exactly.
 */
import { p } from "./theme.js";
import { summarise } from "../render/plain.js";

export type Span = { text: string; color?: string; bold?: boolean };
export type Line = Span[];

export type Item =
  | { key: string; kind: "banner"; cwd: string; label?: string | null }
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string }
  | { key: string; kind: "tool"; name: string; input: Record<string, unknown>; ok: boolean; text: string; meta?: string }
  | { key: string; kind: "notice"; text: string };

const TOOL_OUTPUT_LINES = 6;

/** Greedy word wrap that keeps explicit newlines and breaks very long tokens. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const token of para.split(/( +)/)) {
      if (token === "") continue;
      const isSpace = /^ +$/.test(token);
      if (isSpace) {
        if (!line) {
          line = token.slice(0, w);
        } else if (line.length + token.length <= w) {
          line += token;
        } else {
          out.push(line.trimEnd());
          line = "";
        }
        continue;
      }
      if (line.length + token.length <= w) {
        line += token;
        continue;
      }
      if (line) {
        out.push(line.trimEnd());
        line = "";
      }
      let rest = token;
      while (rest.length > w) {
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      line = rest;
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [""];
}

/** One item -> rows. No leading blank line; the caller inserts separators. */
export function itemLines(item: Item, width: number): Line[] {
  switch (item.kind) {
    case "banner": {
      const short = item.cwd.replace(process.env.HOME ?? "", "~");
      const rows: Line[] = [[{ text: short, color: p.dim }]];
      if (item.label) rows.push([{ text: item.label, color: p.warn }]);
      return rows;
    }

    case "user": {
      const body = wrap(item.text, width - 2);
      return body.map((text, i) =>
        i === 0
          ? [
              { text: "❯ ", color: p.accent },
              { text, color: p.text },
            ]
          : [
              { text: "  ", color: p.accent },
              { text, color: p.text },
            ],
      );
    }

    case "assistant":
      return wrap(item.text, width).map((text) => [{ text, color: p.text }]);

    case "notice": {
      const body = wrap(item.text, width - 2);
      return body.map((text, i) =>
        i === 0
          ? [
              { text: "! ", color: p.warn },
              { text, color: p.warn },
            ]
          : [
              { text: "  " },
              { text, color: p.warn },
            ],
      );
    }

    case "tool": {
      const args = summarise(item.name, item.input);
      const head = ` ● ${item.name}${args ? `(${args})` : ""}`;
      const rows: Line[] = [
        wrap(head, width)[0]
          ? [
              { text: " ● ", color: item.ok ? p.accent : p.error },
              { text: `${item.name}`, color: p.accent, bold: true },
              ...(args ? [{ text: `(${args})`, color: p.dim }] : []),
            ]
          : [],
      ];

      const out = item.text.split("\n").filter((l) => l !== "");
      const shown = out.slice(0, TOOL_OUTPUT_LINES);
      shown.forEach((line, i) => {
        const prefix = i === 0 ? "   ⎿ " : "     ";
        const body = wrap(line, width - prefix.length);
        body.forEach((text, j) => {
          rows.push([
            { text: j === 0 ? prefix : " ".repeat(prefix.length), color: p.dim },
            { text, color: p.dim },
          ]);
        });
      });
      if (out.length > shown.length) {
        rows.push([{ text: `     … +${out.length - shown.length} more lines`, color: p.faint }]);
      }
      if (item.meta) rows.push([{ text: `     ${item.meta}`, color: p.faint }]);
      return rows;
    }

    default:
      return [];
  }
}

/** Flatten the transcript into rows, with one blank line between items. */
export function transcriptLines(items: Item[], width: number): Line[] {
  const rows: Line[] = [];
  items.forEach((item, i) => {
    if (i > 0) rows.push([]);
    rows.push(...itemLines(item, width));
  });
  return rows;
}
