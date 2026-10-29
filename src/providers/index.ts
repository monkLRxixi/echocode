import type { Provider } from "../types.js";
import { anthropic } from "./anthropic.js";
import { openaiChat } from "./openai-chat.js";
import { openaiResponses } from "./openai-responses.js";

/**
 * Message formats. These are the only three values the settings file may use
 * for `format` — the *provider* name next to it is free-form.
 */
export type FormatId = "anthropic-message" | "openai-chat" | "openai-response";

export const FORMATS: Record<FormatId, Provider> = {
  "anthropic-message": anthropic,
  "openai-chat": openaiChat,
  "openai-response": openaiResponses,
};

export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];

export const FORMAT_ALIASES: Record<string, FormatId> = {
  "anthropic-message": "anthropic-message",
  "anthropic-messages": "anthropic-message",
  anthropic: "anthropic-message",
  messages: "anthropic-message",
  message: "anthropic-message",
  claude: "anthropic-message",

  "openai-chat": "openai-chat",
  chat: "openai-chat",
  completions: "openai-chat",
  "chat-completions": "openai-chat",
  openai: "openai-chat",

  "openai-response": "openai-response",
  "openai-responses": "openai-response",
  responses: "openai-response",
  response: "openai-response",
};

export const FORMAT_LABELS: Record<FormatId, string> = {
  "anthropic-message": "anthropic-message",
  "openai-chat": "openai-chat",
  "openai-response": "openai-response",
};

export function resolveFormatId(raw: string | undefined | null): FormatId | null {
  if (!raw) return null;
  return FORMAT_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function getFormat(id: string): Provider {
  const p = FORMATS[id as FormatId];
  if (!p) throw new Error(`unknown format "${id}" — use one of ${FORMAT_IDS.join(", ")}`);
  return p;
}

/** Guess the format from a base URL when the settings file does not say. */
export function detectFormat(baseUrl: string | null | undefined): FormatId {
  if (!baseUrl) return "anthropic-message";
  const u = baseUrl.toLowerCase();
  if (/\/responses\/?$/.test(u)) return "openai-response";
  if (/anthropic|claude/.test(u)) return "anthropic-message";
  if (/(openai|deepseek|moonshot|groq|openrouter|together|mistral|qwen|dashscope|siliconflow|ollama|vllm|litellm|azure|localhost|127\.0\.0\.1)/.test(u)) {
    return "openai-chat";
  }
  return "anthropic-message";
}

export { anthropic, openaiChat, openaiResponses };
