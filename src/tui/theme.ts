// Ink palette. Green accent on white text — the default theme.
// ECHOCODE_THEME=mono or NO_COLOR=1 strips colour (keeps layout/glyphs).

import { env } from "../env.js";

const mono = Boolean(process.env.NO_COLOR) || env("THEME") === "mono";
const pick = (v: string): string | undefined => (mono ? undefined : v);

export const p: Record<
  "accent" | "accentSoft" | "text" | "dim" | "faint" | "error" | "warn" | "cursor" | "barBg",
  string | undefined
> = {
  accent: pick("greenBright"),
  accentSoft: pick("green"),
  text: pick("white"),
  dim: pick("gray"),
  faint: pick("gray"),
  error: pick("red"),
  warn: pick("yellow"),
  cursor: pick("greenBright"),
  barBg: mono ? undefined : "blackBright",
};

export const glyph = {
  ok: "●",
  fail: "●",
  branch: "⎿",
  arrow: "❯",
  dot: "•",
} as const;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const isMono = mono;
