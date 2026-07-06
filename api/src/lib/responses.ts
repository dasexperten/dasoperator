import type { Context } from 'hono';
import type { ApiError, ApiResponse } from '../types';

export function ok<T>(c: Context, result: T, messages: string[] = []) {
  const response: ApiResponse<T> = {
    success: true,
    result,
    errors: [],
    messages,
  };
  return c.json(response, 200);
}

export function fail(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502 | 503,
  errors: ApiError[],
  messages: string[] = []
) {
  const response: ApiResponse<null> = {
    success: false,
    result: null,
    errors,
    messages,
  };
  return c.json(response, status);
}

export function fromError(err: unknown): ApiError {
  if (err instanceof Error) {
    return {
      code: 'internal_error',
      message: err.message,
      details: { name: err.name },
    };
  }
  return {
    code: 'unknown_error',
    message: String(err),
  };
}
