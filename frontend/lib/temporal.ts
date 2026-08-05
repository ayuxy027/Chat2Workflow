import "server-only";

import { Client, Connection, type WorkflowHandle } from "@temporalio/client";

import { temporalEnv } from "./env";

/**
 * The Temporal client singleton.
 *
 * Connections are expensive; clients are cheap. Next's dev server re-evaluates
 * module graphs on every hot reload, so a module-level `const` would open a new
 * gRPC connection per edit and leak the previous one for the life of the
 * process. Stashing the in-flight promise on `globalThis` survives reload.
 *
 * Nothing connects at import time — `getTemporalClient()` is the first thing
 * that touches the network, so `next build` never needs a running server.
 */

declare global {
  // eslint-disable-next-line no-var
  var __wfTemporalClient: Promise<Client> | undefined;
}

/** Fail fast rather than letting a route hang when Temporal is down. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Raised when the server cannot be reached at all.
 *
 * `Connection.connect` reports this as a bare `Error("Failed to connect before
 * the deadline")` — not a `ServiceError`, not a gRPC error — so without this
 * wrapper "Temporal is not running", by far the most common local failure,
 * would be indistinguishable from a genuine bug and surface as a 500.
 */
export class TemporalUnavailableError extends Error {
  constructor(address: string, cause: unknown) {
    super(`Cannot reach the Temporal service at ${address}`, { cause });
    this.name = "TemporalUnavailableError";
  }
}

async function connect(): Promise<Client> {
  const env = temporalEnv();
  let connection: Connection;
  try {
    connection = await Connection.connect({
      address: env.TEMPORAL_ADDRESS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });
  } catch (err) {
    throw new TemporalUnavailableError(env.TEMPORAL_ADDRESS, err);
  }
  return new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
}

export function getTemporalClient(): Promise<Client> {
  const existing = globalThis.__wfTemporalClient;
  if (existing !== undefined) return existing;

  const pending = connect();
  globalThis.__wfTemporalClient = pending;

  // A failed connect must not be memoised forever, or the app stays broken
  // until restart even after Temporal comes back up.
  pending.catch(() => {
    if (globalThis.__wfTemporalClient === pending) {
      globalThis.__wfTemporalClient = undefined;
    }
  });

  return pending;
}

/**
 * Handle for a session's workflow. The session id IS the workflow id, so a
 * reconnect needs nothing but the id the browser already has. No runId is
 * supplied, so the handle follows the chain across `continueAsNew`.
 */
export async function getSessionHandle(sessionId: string): Promise<WorkflowHandle> {
  const client = await getTemporalClient();
  return client.workflow.getHandle(sessionId);
}

/** The task queue the worker must poll for session workflows to run. */
export function taskQueue(): string {
  return temporalEnv().TEMPORAL_TASK_QUEUE;
}
