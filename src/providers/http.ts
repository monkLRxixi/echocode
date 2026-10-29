export interface HttpOptions {
  baseUrl: string;
  apiKey?: string | null;
  authToken?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** true for SSE: asks for text/event-stream and retries only before reading */
  wantStream?: boolean;
  maxAttempts?: number;
  userAgent?: string;
}

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    let detail = body;
    try {
      const j = JSON.parse(body);
      detail = j.error?.message ?? j.error?.type ?? j.message ?? body;
    } catch {
      /* keep raw body */
    }
    super(`HTTP ${status}: ${String(detail).slice(0, 500)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function authHeaders(o: HttpOptions): Record<string, string> {
  const h: Record<string, string> = {};
  if (o.authToken) h.authorization = `Bearer ${o.authToken}`;
  else if (o.apiKey) h.authorization = `Bearer ${o.apiKey}`;
  return h;
}

export async function postJson(
  path: string,
  body: unknown,
  o: HttpOptions,
): Promise<Response> {
  const url = `${o.baseUrl.replace(/\/+$/, "")}${path}`;
  const maxAttempts = o.maxAttempts ?? 3;
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": o.userAgent ?? "echocode/0.3.0",
    ...(o.wantStream ? { accept: "text/event-stream" } : { accept: "application/json" }),
    ...authHeaders(o),
    ...(o.headers ?? {}),
  };

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify(body),
        signal: o.signal,
      });
    } catch (err: any) {
      if (o.signal?.aborted) throw err;
      if (attempt >= maxAttempts) {
        const why = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
        throw new Error(`cannot reach ${o.baseUrl} (${why}). Check the base URL / proxy, or run with --mock.`);
      }
      await sleep(400 * attempt);
      continue;
    }

    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
      await sleep(retryDelay(res, attempt));
      continue;
    }
    throw new ApiError(res.status, text);
  }
}

function retryDelay(res: Response, attempt: number): number {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 20_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}
