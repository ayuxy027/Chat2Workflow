import "server-only";

import {
  QueryNotRegisteredError,
  QueryRejectedError,
  ServiceError,
  WorkflowNotFoundError,
  isGrpcServiceError,
} from "@temporalio/client";
import { z } from "zod";

import { BlobNotFoundError, BlobStoreConfigError, InvalidBlobIdError } from "@/lib/blobs";
import { EnvError } from "@/lib/env";
import { TemporalUnavailableError } from "@/lib/temporal";

/**
 * Shared request/response plumbing for `app/api/**`.
 *
 * Two rules the routes inherit from here:
 *   - every body is parsed with a zod schema before it is looked at;
 *   - error responses carry a stable machine-readable `error` code, and never
 *     an internal message from an unrecognised throw (which can carry
 *     filesystem paths or gateway detail).
 */

/** An error whose message and status are safe to hand back to the browser. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });
}

/**
 * A session id becomes a Temporal workflow id, so it is constrained to
 * something safe to embed in a URL, a log line, and a visibility query.
 */
export const SessionId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "must be 1-128 chars of [A-Za-z0-9_-]");

export async function sessionIdFrom(
  params: Promise<{ id: string }>,
): Promise<string> {
  const { id } = await params;
  const parsed = SessionId.safeParse(id);
  if (!parsed.success) {
    throw new HttpError(400, "bad_session_id", "Invalid session id");
  }
  return parsed.data;
}

/** Parses and validates a JSON body. `allowEmpty` treats no body as `{}`. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  opts: { allowEmpty?: boolean } = {},
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await request.text();
    if (text.trim() === "") {
      if (opts.allowEmpty !== true) {
        throw new HttpError(400, "empty_body", "Expected a JSON body");
      }
      raw = {};
    } else {
      raw = JSON.parse(text) as unknown;
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

export function validationError(error: z.ZodError): HttpError {
  const err = new HttpError(400, "invalid_body", "Body failed schema validation");
  return Object.assign(err, {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

type WithIssues = { issues?: { path: string; message: string }[] };

/**
 * Maps a thrown error onto a response.
 *
 * Deliberate omissions: no request body, no blob contents, no prompt text, and
 * no message from an unclassified error ever reaches the client or the log.
 */
export function toErrorResponse(err: unknown, context: string): Response {
  if (err instanceof HttpError) {
    const issues = (err as HttpError & WithIssues).issues;
    return json(
      { error: err.code, message: err.message, ...(issues ? { issues } : {}) },
      { status: err.status },
    );
  }

  if (err instanceof z.ZodError) return toErrorResponse(validationError(err), context);

  // Safe to echo: names environment variables, never their values.
  if (err instanceof EnvError) {
    return json({ error: "not_configured", message: err.message }, { status: 500 });
  }

  /*
   * The document store cannot be configured — no BLOB_DIR, a relative one, or a
   * half-set BLOB_S3_* group. Echoed for the same reason as EnvError: it names
   * variables and never values, and the alternative is an opaque 500 on upload
   * when the fix is one environment variable on the deploy. @wf/storage refuses
   * to guess rather than falling back to local disk, so this is the message
   * that says why.
   */
  if (err instanceof BlobStoreConfigError) {
    return json({ error: "not_configured", message: err.message }, { status: 500 });
  }

  if (err instanceof InvalidBlobIdError) {
    return json({ error: "bad_blob_id", message: err.message }, { status: 400 });
  }

  if (err instanceof BlobNotFoundError) {
    return json({ error: "blob_not_found", message: "No such blob" }, { status: 404 });
  }

  if (err instanceof WorkflowNotFoundError) {
    return json(
      { error: "session_not_found", message: "No such session" },
      { status: 404 },
    );
  }

  if (err instanceof QueryNotRegisteredError) {
    return json(
      {
        error: "query_not_registered",
        message:
          "The session workflow does not implement this query — the worker is " +
          "out of date with the @wf/shared wire contract",
      },
      { status: 502 },
    );
  }

  if (err instanceof QueryRejectedError) {
    return json(
      { error: "query_rejected", message: "Session is not accepting queries" },
      { status: 409 },
    );
  }

  if (
    err instanceof TemporalUnavailableError ||
    err instanceof ServiceError ||
    isGrpcServiceError(err)
  ) {
    return json(
      {
        error: "temporal_unavailable",
        // Names the address, never a credential. "Is Temporal up?" should not
        // require reading the server log.
        message:
          err instanceof TemporalUnavailableError
            ? err.message
            : "Cannot reach the Temporal service",
      },
      { status: 503 },
    );
  }

  console.error(`[api] ${context} failed:`, err);
  return json({ error: "internal", message: "Internal error" }, { status: 500 });
}

/** Wraps a handler body so every route shares one error contract. */
export async function withErrors(
  context: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err, context);
  }
}
