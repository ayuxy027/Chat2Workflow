import "server-only";

import { SIGNALS } from "@wf/shared";

import { getSessionHandle } from "@/lib/temporal";

import { json, sessionIdFrom, withErrors } from "../../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/sessions/:id/run` — signal `runGraph`, no arguments.
 *
 * Execution progress is not returned here. It arrives as `run.started`,
 * `node.updated`, and `run.finished` events on the stream.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withErrors("POST /api/sessions/:id/run", async () => {
    const sessionId = await sessionIdFrom(ctx.params);

    const handle = await getSessionHandle(sessionId);
    await handle.signal(SIGNALS.runGraph);

    return json({ ok: true }, { status: 202 });
  });
}
