/** fetch wrapper for the Mission Control server: same-origin, JSON both ways. */

export class ApiError extends Error {
  readonly status: number;
  /** The parsed JSON body of the failed response, when it had one. */
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The `note` a failed response carried beside its `error`, when it is a non-empty string. */
export function errorNote(error: Error): string | null {
  if (!(error instanceof ApiError)) return null;
  const note = (error.body as { note?: unknown } | null | undefined)?.note;
  return typeof note === "string" && note !== "" ? note : null;
}

async function errorOf(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return new ApiError(res.status, body.error, body);
  } catch {
    // not JSON
  }
  return new ApiError(res.status, `HTTP ${res.status}`);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string): Promise<T> =>
  request<T>(path, { headers: { accept: "application/json" } });

/** POSTs always send a JSON body (`{}` when there is nothing to say): the server requires both. */
export const apiPost = <T>(path: string, body: unknown = {}): Promise<T> =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
