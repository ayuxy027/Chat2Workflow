import "server-only";

import {
  QueryNotRegisteredError,
  WorkflowNotFoundError,
  type WorkflowExecutionStatusName,
  type WorkflowHandle,
} from "@temporalio/client";
import { GraphEvent, QUERIES } from "@wf/shared";
import { z } from "zod";

import { getSessionHandle } from "@/lib/temporal";

import { sessionIdFrom, toErrorResponse, withErrors } from "../../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE is a long-lived response, and Vercel kills a function at its duration
 * cap. 300s is the Fluid-compute ceiling; the platform clamps this down if the
 * plan allows less. Nothing is lost when it fires: the client reconnects with
 * its cursor and the pump replays from there, so a cut connection costs a
 * reconnect rather than events.
 */
export const maxDuration = 300;

/**
 * `GET /api/sessions/:id/stream?cursor=N` — the SSE pump.
 *
 * Temporal has no server-push to an external client, so this polls the
 * `getEventsSince` query and relays whatever is new. A 120ms poll is cheap
 * (queries write no history) and invisible at human timescales. If it ever is
 * not, the fix is a side-channel signal to this process, not a faster poll.
 *
 * FRAME PROTOCOL — the browser side depends on this:
 *
 *   data: {...}            one `GraphEvent` from @wf/shared. Unnamed, so plain
 *                          `EventSource.onmessage` receives exactly these and
 *                          nothing else.
 *   event: end             the stream is over on purpose (session finished,
 *   data: {"reason":...}   or no such session). Terminal.
 *   event: error           something went wrong server-side. Terminal.
 *   data: {"reason":...}
 *   event: stalled         the connection is fine but the query has not come
 *   data: {"reason":...}   back for a while. NOT terminal — see the watchdog.
 *   event: resumed         a stalled stream started answering again.
 *   data: {}
 *   : ping                 heartbeat comment, ignored by every client.
 *
 * Keeping graph events unnamed and control frames named means a client that
 * only wires up `onmessage` still behaves correctly — it simply never learns
 * why the stream ended, and reconnects.
 *
 * Reconnect: send back the last `seq` you saw as `?cursor=`. The log is
 * append-only and `seq` is monotonic across `continueAsNew`, so a dropped
 * connection loses nothing.
 */

/** ~8 Hz, per PRD §8.1. */
const POLL_MS = 120;
/** Comment frame cadence. Proxies and load balancers idle-close well before 60s. */
const HEARTBEAT_MS = 15_000;
/** How often to re-check whether the workflow is still running. */
const STATUS_CHECK_MS = 5_000;
/** Transient query failures are expected; a sustained run of them is not. */
const MAX_CONSECUTIVE_ERRORS = 5;
/**
 * How long a drain may go without succeeding before the browser is told.
 *
 * `MAX_CONSECUTIVE_ERRORS` only counts queries that came BACK. A query against
 * an unreachable Temporal does not fail fast — the client's RPC layer retries
 * UNAVAILABLE internally for minutes — and a query against a workflow no worker
 * is polling simply blocks. Either way the poll loop is parked inside a single
 * `await`, no error is ever counted, the heartbeat keeps the socket healthy,
 * and the browser sees a live stream that has silently stopped carrying events.
 * Verified: with Temporal stopped, the stream said nothing at all for 35s.
 *
 * The watchdog runs on its own timer for exactly that reason — it has to fire
 * while the poll loop is stuck.
 */
const STALL_AFTER_MS = 15_000;
const WATCHDOG_MS = 5_000;
/** EventSource reconnect hints, in ms. */
const RETRY_NORMAL_MS = 2_000;
const RETRY_AFTER_TERMINAL_MS = 60_000;

const ALIVE_STATUSES: ReadonlySet<WorkflowExecutionStatusName> = new Set([
  "RUNNING",
  "PAUSED",
  "CONTINUED_AS_NEW",
  "UNSPECIFIED",
  "UNKNOWN",
]);

const CursorParam = z.coerce.number().int().nonnegative();

/** Pulls a usable `seq` out of an event even if it failed schema validation. */
function seqOf(event: unknown): number | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const seq = (event as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withErrors("GET /api/sessions/:id/stream", async () => {
    const sessionId = await sessionIdFrom(ctx.params);

    const cursorRaw = new URL(request.url).searchParams.get("cursor");
    const cursorParsed = CursorParam.safeParse(cursorRaw ?? 0);
    if (!cursorParsed.success) {
      return toErrorResponse(cursorParsed.error, "GET /api/sessions/:id/stream");
    }

    // Resolving the handle only touches the network if the client singleton has
    // not connected yet. Letting a connect failure surface as a normal JSON 503
    // is better than opening a stream that immediately dies.
    const handle = await getSessionHandle(sessionId);

    return sseResponse(pump(handle, cursorParsed.data, request.signal));
  });
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx and friends buffer proxied responses by default, which turns a
      // live stream into one long silence followed by a burst.
      "x-accel-buffering": "no",
    },
  });
}

function pump(
  handle: WorkflowHandle,
  startCursor: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  let cursor = startCursor;
  let closed = false;
  let polling = false;
  let consecutiveErrors = 0;
  let lastStatusCheck = 0;

  let lastDrainAt = Date.now();
  let stalled = false;

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let onAbort: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The consumer went away between our check and this enqueue.
          teardown();
        }
      };

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        if (pollTimer !== undefined) clearInterval(pollTimer);
        if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
        if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
        pollTimer = undefined;
        heartbeatTimer = undefined;
        watchdogTimer = undefined;
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
        try {
          controller.close();
        } catch {
          // Already closed or errored; nothing to do.
        }
      };

      /** Ends the stream on purpose, backing the client off before it retries. */
      const terminate = (kind: "end" | "error", reason: string): void => {
        write(`retry: ${RETRY_AFTER_TERMINAL_MS}\n\n`);
        write(`event: ${kind}\ndata: ${JSON.stringify({ reason })}\n\n`);
        teardown();
      };

      if (signal.aborted) {
        teardown();
        return;
      }
      onAbort = () => teardown();
      signal.addEventListener("abort", onAbort, { once: true });

      // Flush something immediately so the connection is established end to end
      // before the first event, and set the default reconnect delay.
      write(`retry: ${RETRY_NORMAL_MS}\n\n`);
      write(`: open\n\n`);

      /** Returns false if the stream was terminated. */
      const drain = async (): Promise<boolean> => {
        let events: unknown;
        try {
          events = await handle.query<unknown, [number]>(
            QUERIES.getEventsSince,
            cursor,
          );
          consecutiveErrors = 0;
          lastDrainAt = Date.now();
          if (stalled) {
            stalled = false;
            write(`event: resumed\ndata: {}\n\n`);
          }
        } catch (err) {
          if (err instanceof WorkflowNotFoundError) {
            terminate("end", "session_not_found");
            return false;
          }
          if (err instanceof QueryNotRegisteredError) {
            // A name mismatch with the worker. Retrying at 8 Hz would just
            // hammer the service, so stop and say so.
            terminate("error", "query_not_registered");
            return false;
          }
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error(
              `[sse] ${handle.workflowId}: ${consecutiveErrors} consecutive query failures`,
              err,
            );
            terminate("error", "query_failed");
            return false;
          }
          return true;
        }

        if (!Array.isArray(events)) return true;

        for (const raw of events) {
          const seq = seqOf(raw);
          if (seq !== undefined && seq <= cursor) continue;

          const parsed = GraphEvent.safeParse(raw);
          if (parsed.success) {
            write(`data: ${JSON.stringify(parsed.data)}\n\n`);
          } else {
            // Never drop an event: the cursor has already moved past it and it
            // would be lost for good. Forward it as-is and make the drift
            // visible in the server log — no payload, this is a legal app.
            console.warn(
              `[sse] ${handle.workflowId}: event seq=${seq ?? "?"} does not match ` +
                `the @wf/shared GraphEvent schema; forwarding unvalidated`,
            );
            write(`data: ${JSON.stringify(raw)}\n\n`);
          }

          if (seq !== undefined) cursor = seq;
        }

        return true;
      };

      /**
       * A session workflow that has finished will keep answering queries with
       * an empty array forever, so completion is detected out of band — at a
       * fortieth of the poll rate, since it is only a courtesy close.
       */
      const checkStillRunning = async (): Promise<void> => {
        const now = Date.now();
        if (now - lastStatusCheck < STATUS_CHECK_MS) return;
        lastStatusCheck = now;

        let status: WorkflowExecutionStatusName;
        try {
          status = (await handle.describe()).status.name;
        } catch (err) {
          if (err instanceof WorkflowNotFoundError) {
            terminate("end", "session_not_found");
          }
          return;
        }

        if (!ALIVE_STATUSES.has(status)) {
          // Take one last pass so nothing appended just before the workflow
          // closed is lost.
          if (await drain()) terminate("end", `session_${status.toLowerCase()}`);
        }
      };

      // Armed BEFORE any Temporal call. A query against a workflow no worker is
      // polling blocks until the server gives up, and if the heartbeat were
      // started after the first drain, that whole window would be dead air —
      // exactly the silence the heartbeat exists to prevent.
      heartbeatTimer = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);

      // Independent of the poll loop on purpose: its whole job is to report a
      // poll loop that is stuck inside an await and therefore cannot report
      // itself. Non-terminal — the stream stays open and says `resumed` the
      // moment a query comes back.
      watchdogTimer = setInterval(() => {
        if (closed || stalled) return;
        const since = Date.now() - lastDrainAt;
        if (since < STALL_AFTER_MS) return;
        stalled = true;
        write(`event: stalled\ndata: ${JSON.stringify({ reason: "no_response", sinceMs: since })}\n\n`);
      }, WATCHDOG_MS);

      /** One cycle: confirm the session exists (once), drain, re-check status. */
      let checkedExistence = false;
      const tick = async (): Promise<void> => {
        if (!checkedExistence) {
          checkedExistence = true;
          lastStatusCheck = Date.now();
          try {
            const status = (await handle.describe()).status.name;
            if (!ALIVE_STATUSES.has(status)) {
              if (await drain()) terminate("end", `session_${status.toLowerCase()}`);
              return;
            }
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) {
              terminate("end", "session_not_found");
              return;
            }
            // Anything else is transient; the drain below will surface it.
          }
        }

        if (closed) return;
        if (!(await drain())) return;
        if (!closed) await checkStillRunning();
      };

      const runTick = (): void => {
        // Guard against overlap: a slow query must not stack up callbacks.
        if (closed || polling) return;
        polling = true;
        void tick()
          .catch((err: unknown) => {
            console.error(`[sse] ${handle.workflowId}: pump failed`, err);
            terminate("error", "pump_failed");
          })
          .finally(() => {
            polling = false;
          });
      };

      pollTimer = setInterval(runTick, POLL_MS);
      runTick(); // don't make the first event wait a poll interval
    },

    cancel() {
      // The consumer detached without aborting the request (e.g. the response
      // body was cancelled). Same cleanup, no leaked timers either way.
      closed = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
      pollTimer = undefined;
      heartbeatTimer = undefined;
      watchdogTimer = undefined;
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      onAbort = undefined;
    },
  });
}
