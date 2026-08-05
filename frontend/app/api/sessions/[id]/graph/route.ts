import "server-only";

import { QueryNotRegisteredError } from "@temporalio/client";
import { Graph, QUERIES, SessionInfo } from "@wf/shared";

import { getSessionHandle } from "@/lib/temporal";

import { HttpError, json, sessionIdFrom, withErrors } from "../../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/sessions/:id/graph` — query `getGraph`, plus the retained log window.
 *
 * The cold-load and repair snapshot. Steady state is the event stream; this
 * exists for the two cases the stream alone cannot serve:
 *
 *   - a cursor that fell off the log after `continueAsNew` (only a tail of the
 *     event log is carried across the boundary, so replaying from an evicted
 *     cursor silently omits every earlier node);
 *   - a rejected optimistic edit, where the browser must discard its replica
 *     and re-adopt the authoritative graph rather than keep showing an edge the
 *     workflow never accepted.
 *
 * RESPONSE SHAPE — `{ graph, seq, oldestSeq, generation }`. The graph is
 * nested, not the top-level body: the window is what makes the snapshot usable
 * as a cursor repair, and returning a bare `Graph` leaves the caller guessing
 * which `seq` the snapshot corresponds to.
 *
 * `seq`/`oldestSeq` are omitted when the worker does not register
 * `getSessionInfo`; the browser then falls back to replaying from its cursor.
 *
 * The graph is validated against the shared `Graph` schema. If the workflow and
 * the canvas ever disagree about what a node is, that is one bug — and it
 * should surface here, named, rather than as an undefined field three
 * components deep.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withErrors("GET /api/sessions/:id/graph", async () => {
    const sessionId = await sessionIdFrom(ctx.params);

    const handle = await getSessionHandle(sessionId);
    const raw = await handle.query<unknown>(QUERIES.getGraph);

    const parsed = Graph.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(
        502,
        "graph_contract_mismatch",
        `getGraph returned a value that is not a Graph: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`,
      );
    }

    let info: SessionInfo | undefined;
    try {
      const raw = await handle.query<unknown>(QUERIES.getSessionInfo);
      const parsedInfo = SessionInfo.safeParse(raw);
      if (parsedInfo.success) info = parsedInfo.data;
    } catch (err) {
      // An older worker simply does not have this query. Everything else is a
      // real failure and should surface through the shared error contract.
      if (!(err instanceof QueryNotRegisteredError)) throw err;
    }

    return json({ graph: parsed.data, ...(info ?? {}) });
  });
}
