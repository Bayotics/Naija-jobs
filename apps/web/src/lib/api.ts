import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type output } from 'zod';
import { ConfigurationError } from '@job-intel/config';
import { NotFoundError, ValidationError } from '@job-intel/core';

/**
 * Route-handler plumbing.
 *
 * One place that turns thrown domain errors into HTTP status codes, so handlers
 * express intent and never construct error responses by hand — which is how
 * inconsistent error shapes creep into an API.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; issues?: Array<{ path: string; message: string }> };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  issues?: Array<{ path: string; message: string }>,
): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    { error: { code, message, ...(issues ? { issues } : {}) } },
    { status },
  );
}

export function zodIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

/**
 * Wraps a handler with uniform error translation.
 *
 * Note the deliberate asymmetry: validation problems return their detail to the
 * caller, but an unexpected exception returns a generic message and logs the
 * real one server-side. Internal messages can carry connection strings and
 * table names, which must never reach a client.
 */
export function handler(
  fn: () => Promise<NextResponse<unknown>>,
): Promise<NextResponse<unknown>> {
  return fn().catch((error: unknown) => {
    if (error instanceof ZodError) {
      return apiError(400, 'VALIDATION_ERROR', 'Request failed validation', zodIssues(error));
    }
    if (error instanceof ValidationError) {
      return apiError(400, error.code, error.message, [...error.issues]);
    }
    if (error instanceof NotFoundError) {
      return apiError(404, error.code, error.message);
    }
    if (error instanceof ConfigurationError) {
      console.error('[api] configuration error:', error.format());
      return apiError(500, 'CONFIGURATION_ERROR', 'Server is misconfigured');
    }
    // Log the stack server-side; the client gets a generic message only.
    console.error('[api] unhandled error:', error instanceof Error ? error.stack : error);
    return apiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  });
}

/**
 * Parses and validates a JSON body, or throws for the wrapper to translate.
 *
 * Generic over the schema rather than over a value type: a schema with defaults
 * has a different *input* type from its *output* type, and collapsing the two
 * would hand callers optional fields that Zod has in fact already filled in.
 */
export async function parseBody<S extends ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<output<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  return schema.parse(raw) as output<S>;
}

/** Parses query-string parameters against a schema. */
export function parseQuery<S extends ZodTypeAny>(request: Request, schema: S): output<S> {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  return schema.parse(params) as output<S>;
}
