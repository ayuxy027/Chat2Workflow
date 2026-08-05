import "server-only";

import { SIGNALS, SubmitPromptArg } from "@wf/shared";

import { getSessionHandle } from "@/lib/temporal";

import { json, readJson, sessionIdFrom, withErrors } from "../../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signal's own argument schema, from `@wf/shared`, plus the one thing that
 * is genuinely transport rather than contract: an upper bound, so a runaway
 * paste is refused at the edge instead of inside workflow code where a throw
 * costs a task failure and a retry.
 */
const PromptBody = SubmitPromptArg.extend({
  text: SubmitPromptArg.shape.text.trim().min(1, "Prompt is empty").max(20_000),
});

/**
 * `POST /api/sessions/:id/prompt` — signal `submitPrompt`.
 *
 * Returns as soon as the signal is accepted. The reply, and any nodes the
 * planner produces, arrive over the SSE stream; the browser never blocks here.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withErrors("POST /api/sessions/:id/prompt", async () => {
    const sessionId = await sessionIdFrom(ctx.params);
    const { text } = await readJson(request, PromptBody);

    const handle = await getSessionHandle(sessionId);
    await handle.signal(SIGNALS.submitPrompt, { text });

    return json({ ok: true }, { status: 202 });
  });
}
