/** fetch wrapper for the Mission Control server: same-origin, JSON both ways. */
import { OPERATOR_BOOTSTRAP_PATH, OPERATOR_HEADER, OPERATOR_TOKEN_REQUIRED } from "@mc/core";

let operatorToken: string | undefined;
let operatorTokenLoad: Promise<void> | undefined;

/** Share the page-load bootstrap with early writes; an unavailable bootstrap is harmless. */
export function loadOperatorToken(): Promise<void> {
  if (operatorTokenLoad) return operatorTokenLoad;
  if (operatorToken !== undefined) return Promise.resolve();
  operatorTokenLoad = request<{ token?: unknown } | null>(OPERATOR_BOOTSTRAP_PATH, {})
    .then((body) => {
      if (typeof body?.token === "string") operatorToken = body.token;
    })
    .catch(() => {
      // A preview or an older hub may not provide the bootstrap route.
    })
    .finally(() => {
      operatorTokenLoad = undefined;
    });
  return operatorTokenLoad;
}

export function forgetOperatorToken(): void {
  operatorToken = undefined;
}

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
    return new ApiError(
      res.status,
      typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
      body,
    );
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
export async function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return apiWrite<T>("POST", path, body);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiWrite<T>("PUT", path, body);
}

/** DELETE has no body or content type, as required by the server's CSRF hooks. */
export async function apiDelete<T>(path: string): Promise<T> {
  return apiWrite<T>("DELETE", path);
}

async function apiWrite<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (operatorTokenLoad) await operatorTokenLoad;
  const jsonBody = method === "DELETE" ? undefined : JSON.stringify(body);
  const write = () =>
    request<T>(path, {
      method,
      headers: {
        ...(method === "DELETE" ? {} : { "content-type": "application/json" }),
        accept: "application/json",
        ...(operatorToken === undefined ? {} : { [OPERATOR_HEADER]: operatorToken }),
      },
      ...(method === "DELETE" ? {} : { body: jsonBody }),
    });
  try {
    return await write();
  } catch (error) {
    // request parsed the error body once; preserve it for callers if this is not recoverable.
    if (
      !(error instanceof ApiError) ||
      error.status !== 401 ||
      (error.body as { error?: unknown } | undefined)?.error !== OPERATOR_TOKEN_REQUIRED
    )
      throw error;
    forgetOperatorToken();
    await loadOperatorToken();
    return write(); // Only one retry, including when the bootstrap failed.
  }
}
