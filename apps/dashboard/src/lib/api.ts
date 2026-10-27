import * as Schema from "effect/Schema";

/** A failed management request, with the server's stable error code when present. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const fallbackMessages: Record<number, string> = {
  401: "Your session has ended. Sign in again.",
  403: "You don't have permission to do that.",
  404: "Not found.",
  409: "That conflicts with the current state. Refresh and try again.",
  429: "Too many requests. Wait a moment and try again.",
  503: "This feature is unavailable on this instance right now.",
};

export interface RequestOptions<A> {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly schema?: Schema.Decoder<A>;
  readonly signal?: AbortSignal;
}

/**
 * Same-origin JSON request with the session cookie. Browsers attach `Origin`
 * to unsafe methods, which the management API requires. Responses are decoded
 * with the shared Effect schemas when one is supplied.
 */
export async function api<A = unknown>(path: string, options: RequestOptions<A> = {}): Promise<A> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let value: unknown;

  try {
    value = text ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }

  if (!response.ok) {
    const record = (value ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof record.code === "string" ? record.code : String(response.status);

    const message =
      typeof record.message === "string" && record.message
        ? record.message
        : (fallbackMessages[response.status] ?? `Request failed (${response.status}).`);

    throw new ApiError(response.status, code, message);
  }

  return options.schema ? Schema.decodeUnknownSync(options.schema)(value) : (value as A);
}

export const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error && error.name !== "AbortError" && error.message
      ? error.message
      : "Something went wrong. Check your connection and try again.";
