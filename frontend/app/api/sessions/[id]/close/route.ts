import "server-only";

import { WorkflowNotFoundError } from "@temporalio/client";
import { SIGNALS } from "@wf/shared";

import { getSessionHandle } from "@/lib/temporal";

import { json, sessionIdFrom, withErrors } from "../../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/sessions/:id/close` — signal `close`.
 *
 * The workflow parks on `condition(() => closed)` and only this signal sets it,
 * so until now every tab that was ever opened left a session workflow Running
 * in Temporal forever. On a dev box that is clutter; with the retention this
 * application actually needs for an audit trail (PRD §10 Q1) it is a pile of
 * immortal executions that make the history that *matters* hard to find.
 *
 * Idempotent by design. The browser fires this from `pagehide` via
 * `sendBeacon`, which offers no delivery guarantee and no response — so a
 * session already closed, already completed, or never started must all be
 * successes rather than errors nobody will ever read.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withErrors("POST /api/sessions/:id/close", async () => {
    const sessionId = await sessionIdFrom(ctx.params);

    try {
      const handle = await getSessionHandle(sessionId);
      await handle.signal(SIGNALS.close);
    } catch (err) {
      // Nothing to close is the goal state, not a failure.
      if (!(err instanceof WorkflowNotFoundError)) throw err;
      return json({ ok: true, alreadyClosed: true }, { status: 202 });
    }

    return json({ ok: true }, { status: 202 });
  });
}
