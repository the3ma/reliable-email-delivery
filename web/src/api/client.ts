/** Thin typed wrapper around fetch. Every console-api path lives under /api/v1. */

const API_BASE = `${(import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')}/api/v1`;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Non-2xx statuses whose JSON body is a normal response (e.g. 503 from a degraded /health). */
  acceptStatus?: readonly number[];
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  // Resolve against the page origin so a relative base ("" = same origin) works in every runtime.
  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `Request failed (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error: unknown = body.error;
      if (typeof error === 'object' && error !== null) {
        if ('code' in error && typeof error.code === 'string') code = error.code;
        if ('message' in error && typeof error.message === 'string') message = error.message;
      }
    }
  } catch {
    // Non-JSON error body (e.g. a proxy 502 page): keep the status text.
  }
  return new ApiError(res.status, code, message);
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, signal, acceptStatus = [] } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      signal: signal ?? null,
      credentials: 'same-origin',
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(0, 'network_error', 'The console API is unreachable.');
  }
  if (!res.ok && !acceptStatus.includes(res.status)) throw await readError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
