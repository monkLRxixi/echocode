// Canonical, provider-neutral shapes. Everything on the wire is converted to
// these at the provider boundary, so the agent loop and the UI never care which
// API is behind them.

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export interface WireMessage {
  role: Role;
  content: Block[];
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; scope?: "global" };
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cost?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_args_delta"; id: string; json: string }
  | { type: "tool_end"; id: string; input: Record<string, unknown> }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: StopReason };

export interface ProviderRequest {
  model: string;
  maxTokens: number;
  system: SystemBlock[];
  messages: WireMessage[];
  tools: ToolSpec[];
}

export interface ProviderOptions {
  signal?: AbortSignal;
  baseUrl: string;
  apiKey?: string | null;
  authToken?: string | null;
  /** extra headers from settings.json */
  headers?: Record<string, string>;
}

export interface Provider {
  /** stable id, e.g. "anthropic" | "openai-chat" | "openai-responses" */
  id: string;
  /** shown in the TUI header */
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** where the API key normally comes from, used in error messages */
  keyEnv: string[];
  stream(req: ProviderRequest, opts: ProviderOptions): AsyncGenerator<StreamEvent>;
}
