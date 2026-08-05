import { heartbeat } from "@temporalio/activity";

/**
 * A wall-clock heartbeat ticker for activities that spend most of their time
 * blocked on someone else's I/O.
 *
 * Heartbeating only when data arrives is not enough, and both model activities
 * were doing exactly that. Two things go wrong:
 *
 *   1. CANCELLATION NEVER ARRIVES. Temporal delivers a cancellation request in
 *      the RESPONSE to a heartbeat. An activity blocked on an endpoint that has
 *      stopped responding never heartbeats, so it never learns it was
 *      cancelled, and `cancellationSignal()` never fires. Probed against a
 *      deliberately hung endpoint: the workflow was CANCELLED in about a
 *      second and the node stopped cleanly, while the HTTP request stayed open
 *      — holding a socket and a worker slot for the rest of the 30-minute
 *      start-to-close timeout. The workflow looked fine; the worker leaked.
 *
 *   2. A SLOW FIRST TOKEN LOOKS LIKE A DEAD WORKER. Heartbeat timeouts here are
 *      2 and 3 minutes. DeepSeek-V4-Flash is a reasoning model, and time to
 *      first token on a long contract can exceed that. Temporal then kills a
 *      perfectly healthy call as unresponsive — worst on the largest documents,
 *      which is where it is least acceptable.
 *
 * Beating on a timer fixes both: liveness stops depending on the endpoint being
 * chatty. `unref` so a stray interval can never hold the worker process open,
 * and the throw is swallowed because a heartbeat that fails because the
 * activity already completed must not become the activity's failure.
 */
export interface Heartbeater {
  /** Idempotent. Call from `finally`. */
  stop(): void;
}

/** Comfortably inside the 2-minute floor across the activity proxies. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

export function startHeartbeat(
  details: () => unknown,
  everyMs: number = HEARTBEAT_INTERVAL_MS,
): Heartbeater {
  const timer = setInterval(() => {
    try {
      heartbeat(details());
    } catch {
      // Activity already finished or was cancelled; nothing to keep alive.
    }
  }, everyMs);
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
