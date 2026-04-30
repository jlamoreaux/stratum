import type { ApiError } from "../types";

export function ok<T>(data: T, status = 200): Response {
  return Response.json(data, { status });
}

export function created<T>(data: T): Response {
  return ok(data, 201);
}

export function notFound(resource: string, name: string): Response {
  return error(`${resource} '${name}' not found`, 404);
}

export function badRequest(message: string): Response {
  return error(message, 400);
}

export function unauthorized(message: string): Response {
  return error(message, 401);
}

export function internalError(message: string): Response {
  return error(message, 500);
}

function error(message: string, status: number): Response {
  const body: ApiError = { error: message };
  return Response.json(body, { status });
}
