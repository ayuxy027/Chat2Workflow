import "server-only";

import { randomUUID } from "node:crypto";

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { z } from "zod";

import { getTemporalClient, taskQueue } from "@/lib/temporal";

import { GRAPH_SESSION_WORKFLOW, type GraphSessionInput } from "@wf/shared";

import { SessionId, json, readJson, withErrors } from "../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const StartSessionBody = z.object({
  /**
   * Optional. Supplying an id makes the call idempotent — handy for a browser
   * that wants to reattach to a session it already knows about after a reload.
   */
  sessionId: SessionId.optional(),
});

/**
 * `POST /api/sessions` — start a session workflow.
 *
 * The session id IS the Temporal workflow id. That is the whole reconnect
 * story: the browser keeps one string, and every later call (`/prompt`,
 * `/mutate`, `/run`, `/graph`, `/stream`) resolves a handle from it with no
 * lookup table and no database.
 */
export async function POST(request: Request): Promise<Response> {
  return withErrors("POST /api/sessions", async () => {
    const body = await readJson(request, StartSessionBody, { allowEmpty: true });
    const sessionId = body.sessionId ?? randomUUID();

    const client = await getTemporalClient();
    const args: [GraphSessionInput] = [{ sessionId }];

    try {
      await client.workflow.start(GRAPH_SESSION_WORKFLOW, {
        taskQueue: taskQueue(),
        workflowId: sessionId,
        args,
      });
    } catch (err) {
      // Same id, already running: the caller reattached rather than started
      // something new. That is a success for this endpoint, not a conflict.
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      return json({ sessionId, existing: true }, { status: 200 });
    }

    return json({ sessionId, existing: false }, { status: 201 });
  });
}
