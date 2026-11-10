import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorCode, ErrorResponse } from "@ramx/shared";

/** The shared error shape: {"error": {"code", "message"}}. */
export function errorResponse(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string): Response {
  const body: ErrorResponse = { error: { code, message } };
  return c.json(body, status);
}
