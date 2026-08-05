import "server-only";

import { TOOL_MANIFESTS } from "@wf/shared";

import { json, withErrors } from "../_http";

export const runtime = "nodejs";

/**
 * `GET /api/tools` — the tool registry, as manifests.
 *
 * PRD §5.3's promise is that adding a tool means writing one file: "`params`
 * drives the node's form UI from the same definition — no separate frontend
 * registration". That was only half true, because the canvas had no way to
 * learn what tools exist or what fields they take, so tool parameters rendered
 * read-only and only the planner could ever set them. This endpoint is the
 * missing half: one fetch and every tool — including ones added later — gets an
 * editable form for free.
 *
 * Served from `@wf/shared` rather than from the worker's registry. The worker
 * owns `ToolDef.run`; the manifest is the serializable half and lives in the
 * shared package precisely so the browser can have it without a round trip to
 * a process it cannot import. That also means this route answers correctly
 * while the worker is down — the form still renders, the signal still queues.
 *
 * NOT cached at the CDN: the registry is small, and a stale form that offers a
 * parameter the worker no longer accepts is worse than a request.
 */
export async function GET(): Promise<Response> {
  return withErrors("GET /api/tools", async () =>
    json({ tools: TOOL_MANIFESTS }, { status: 200 }),
  );
}
