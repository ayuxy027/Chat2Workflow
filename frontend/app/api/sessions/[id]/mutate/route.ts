import "server-only";

import {
  GraphMutation,
  MUTATION_REJECTED,
  MutationAccepted,
  UPDATES,
} from "@wf/shared";

import { getSessionHandle } from "@/lib/temporal";

import { json, readJson, sessionIdFrom, withErrors } from "../../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Does this error chain carry the workflow's "I refused that edit" marker?
 *
 * Temporal wraps a rejected update: WorkflowUpdateFailedError -> ApplicationFailure.
 * The nesting depth is an SDK detail, so walk the `cause` chain rather than
 * reaching for a fixed level — a shape change would otherwise silently turn
 * every rejection back into a 500.
 */
function rejection(err: unknown): { message: string } | undefined {
  for (let e: unknown = err, depth = 0; e != null && depth < 6; depth++) {
    const candidate = e as { type?: unknown; message?: unknown; cause?: unknown };
    if (candidate.type === MUTATION_REJECTED) {
      return {
        message:
          typeof candidate.message === "string" && candidate.message !== ""
            ? candidate.message
            : "The workflow refused that edit.",
      };
    }
    e = candidate.cause;
  }
  return undefined;
}

/**
 * `POST /api/sessions/:id/mutate` — Temporal UPDATE `applyMutation`.
 *
 * The body is the `GraphMutation` discriminated union from `@wf/shared`, parsed
 * here so a malformed `op` fails at the edge with a useful message rather than
 * inside workflow code, where a throw costs a lot more.
 *
 * WHY AN UPDATE AND NOT A SIGNAL. A signal is fire-and-forget: it returns 202
 * whether or not the workflow accepts the edit. That is fine for a malformed
 * body, which is rejected here — but not for a mutation that parses cleanly and
 * is still impossible: deleting an edge that does not exist, connecting a node
 * to itself, attaching a document to a node that cannot hold one. The workflow
 * correctly refused all of those and the caller was told `{ok: true}` anyway.
 *
 * The client applies edits optimistically and only repairs when the response is
 * NOT ok, so a 202 on a refusal left the rejected node or edge on the canvas for
 * the life of the tab — the screen showing a graph the workflow never accepted,
 * with no error. In a tool whose output is reviewed by a lawyer, the canvas
 * quietly disagreeing with what will actually run is not a cosmetic bug.
 *
 * An update also carries a validator that runs BEFORE anything enters history,
 * so a refused edit leaves no trace in the audit trail, and it returns the id
 * the workflow assigned — no guessing, no reconciliation.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withErrors("POST /api/sessions/:id/mutate", async () => {
    const sessionId = await sessionIdFrom(ctx.params);
    const mutation = await readJson(request, GraphMutation);

    const handle = await getSessionHandle(sessionId);

    let accepted: unknown;
    try {
      accepted = await handle.executeUpdate(UPDATES.applyMutation, {
        args: [mutation],
      });
    } catch (err) {
      const refused = rejection(err);
      if (refused === undefined) throw err; // transport/session problem — let withErrors classify it
      return json(
        { error: "mutation_rejected", op: mutation.op, message: refused.message },
        { status: 400 },
      );
    }

    // Parsed rather than cast: this crosses a package boundary, and a worker
    // running an older contract should surface here, not as `undefined` seq
    // somewhere in the client's cursor logic.
    const result = MutationAccepted.safeParse(accepted);
    if (!result.success) {
      return json({ ok: true, op: mutation.op }, { status: 202 });
    }

    return json({ ok: true, op: mutation.op, ...result.data }, { status: 200 });
  });
}
