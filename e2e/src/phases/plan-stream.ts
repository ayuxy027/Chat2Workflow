/**
 * Phases 2 and 3 — planning, and the SSE cascade.
 *
 * These share one session on purpose: the streaming measurement is only
 * meaningful for the plan that produced it, and starting a second session to
 * measure timing would double the LLM cost for no extra coverage.
 *
 * Because the planner is a language model, nothing here asserts CONTENT. What
 * it asserts are the invariants that must hold whatever the model says: valid
 * shape, every `toolId` real, acyclic, every edge endpoint resolving. Those are
 * the properties the rest of the system is entitled to assume, and they are the
 * ones a hallucinated tool or a self-referential edge would break.
 */

import { findCycle, type Api, type Graph } from "../lib/api";
import { eventType, isGraphEvent, openSse, type SseFrame } from "../lib/sse";
import { show, until, type Phase } from "../lib/report";

const PROMPT =
  "Summarise the indemnity clauses in this contract, compress it, " +
  "and give me a Word version.";

const PLAN_TIMEOUT_MS = 240_000;

/** Frames within this of each other came off the same poll of the event log. */
const BATCH_WINDOW_MS = 80;

export async function planAndStream(
  planPhase: Phase,
  streamPhase: Phase,
  api: Api,
  host: string,
  port: number,
): Promise<void> {
  const sessionId = await api.startSession();

  const frames: SseFrame[] = [];
  const sse = await openSse({
    host,
    port,
    path: `/api/sessions/${sessionId}/stream?cursor=0`,
    onFrame: (f) => frames.push(f),
  });

  try {
    // The stream is live before the prompt is sent, so first-node latency is
    // measured from the request that caused it and not from a race.
    const promptAt = Date.now();
    const res = await api.prompt(sessionId, PROMPT);
    planPhase.ok(
      "prompt.accepted",
      res.status === 202,
      "POST /api/sessions/:id/prompt to answer 202",
      `${res.status} ${show(res.body, 200)}`,
    );

    let finished: SseFrame | undefined;
    try {
      finished = await sse.waitFor(
        "plan.finished",
        (f) => eventType(f) === "plan.finished",
        PLAN_TIMEOUT_MS,
      );
    } catch (err) {
      planPhase.fail(
        "plan.finished",
        `expected a plan.finished event within ${PLAN_TIMEOUT_MS}ms\n      saw      ${show(err, 700)}`,
      );
    }

    if (finished !== undefined) {
      const ok = (finished.json as { ok?: boolean } | undefined)?.ok;
      planPhase.ok(
        "plan.finished_ok",
        ok === true,
        "plan.finished to report ok:true",
        show(finished.json, 400),
      );
    }

    /* ---------------- streaming: measured on arrival ---------------- */

    const added = frames.filter((f) => eventType(f) === "node.added");
    const t0 = added[0]?.at;

    streamPhase.ok(
      "sse.transport_unbuffered",
      sse.firstByteAt() !== undefined,
      "the SSE socket to deliver bytes before the stream ends (raw socket, no client buffering)",
      sse.firstByteAt() === undefined
        ? "no bytes at all"
        : `first byte ${sse.firstByteAt()! - promptAt}ms after the prompt`,
    );

    streamPhase.ok(
      "sse.node_added_count",
      added.length >= 3,
      "at least 3 node.added events on the stream",
      `${added.length} (event types seen: ${summarise(frames)})`,
    );

    if (t0 !== undefined) {
      const firstLatency = t0 - promptAt;
      streamPhase.note(
        `first node rendered ${firstLatency}ms after the prompt was accepted`,
      );
      streamPhase.ok(
        "sse.first_node_latency",
        firstLatency > 0 && firstLatency < PLAN_TIMEOUT_MS,
        `the first node to arrive within ${PLAN_TIMEOUT_MS}ms of the prompt`,
        `${firstLatency}ms`,
      );

      // The cascade check. Frames that land in the same TCP read came off the
      // same poll of the workflow's event log — if EVERY node lands in one,
      // the canvas snaps into existence instead of assembling, which is the
      // regression this measurement exists to catch.
      const offsets = added.map((f) => f.at - t0);
      const batches: number[][] = [];
      for (const o of offsets) {
        const last = batches[batches.length - 1];
        if (last === undefined || o - (last[last.length - 1] ?? 0) > BATCH_WINDOW_MS) {
          batches.push([o]);
        } else {
          last.push(o);
        }
      }
      const span = (offsets[offsets.length - 1] ?? 0) - (offsets[0] ?? 0);

      streamPhase.note(
        `node.added arrival offsets (ms from first): ${offsets.join(", ")} — ` +
          `${batches.length} delivery batch(es), span ${span}ms`,
      );

      streamPhase.ok(
        "sse.nodes_cascade_not_batch",
        batches.length >= 2 && span >= BATCH_WINDOW_MS,
        `node.added events to arrive spread over time — at least 2 delivery batches ` +
          `more than ${BATCH_WINDOW_MS}ms apart (a cascade, PRD §6.2), not one burst`,
        `${batches.length} batch(es) spanning ${span}ms; offsets [${offsets.join(", ")}]`,
      );
    } else {
      streamPhase.fail(
        "sse.first_node_latency",
        `expected at least one node.added event on the stream\n` +
          `      saw      none. Frames: ${summarise(frames)}`,
      );
      streamPhase.fail(
        "sse.nodes_cascade_not_batch",
        "expected node.added events to measure\n      saw      none",
      );
    }

    // Monotonic seq is what makes reconnect lossless (PRD §8.1).
    const seqs = frames.filter(isGraphEvent).map((f) => f.json.seq);
    const monotonic = seqs.every((s, i) => i === 0 || s > (seqs[i - 1] ?? -1));
    streamPhase.ok(
      "sse.seq_monotonic",
      monotonic,
      "every event's seq to be strictly greater than the previous one",
      monotonic ? `${seqs.length} events, seq ${seqs[0]}..${seqs[seqs.length - 1]}` : show(seqs, 300),
    );

    /* ---------------- plan: assert the AUTHORITATIVE graph ---------- */

    const graph = await until(
      "the authoritative graph to contain the planned nodes",
      15_000,
      200,
      async () => {
        const g = await api.graph(sessionId);
        return g.nodes.length >= 3 ? g : undefined;
      },
    ).catch(async () => api.graph(sessionId));

    assertGraphInvariants(planPhase, graph, await toolIds(api));

    planPhase.note(
      `planned: ${graph.nodes.map((n) => `${n.id}:${n.kind}${n.toolId === undefined ? "" : `(${n.toolId})`}`).join(", ")}`,
    );
  } finally {
    sse.close();
    await api.closeSession(sessionId);
  }
}

async function toolIds(api: Api): Promise<Set<string>> {
  const tools = await api.tools();
  return new Set(tools.map((t) => t.id));
}

/**
 * The invariants any graph must satisfy, however the model chose to phrase it.
 * Shared with the browser phase so both hold the canvas to the same contract.
 */
export function assertGraphInvariants(
  phase: Phase,
  graph: Graph,
  registry: Set<string>,
): void {
  phase.ok(
    "plan.node_count",
    graph.nodes.length >= 3,
    "the planner to produce at least 3 nodes for a three-step request",
    `${graph.nodes.length} node(s): ${graph.nodes.map((n) => n.kind).join(", ")}`,
  );

  const dupes = graph.nodes
    .map((n) => n.id)
    .filter((id, i, all) => all.indexOf(id) !== i);
  phase.ok(
    "plan.unique_ids",
    dupes.length === 0,
    "every node id to be unique",
    dupes.length === 0 ? "all unique" : `duplicated: ${dupes.join(", ")}`,
  );

  const badPos = graph.nodes.filter(
    (n) => !Number.isFinite(n.position?.x) || !Number.isFinite(n.position?.y),
  );
  phase.ok(
    "plan.positions_numeric",
    badPos.length === 0,
    "every node to carry finite x/y from the deterministic layout",
    badPos.length === 0
      ? `${graph.nodes.length} positioned`
      : badPos.map((n) => `${n.id}=${show(n.position)}`).join(", "),
  );

  const toolNodes = graph.nodes.filter((n) => n.kind === "tool");
  const missingToolId = toolNodes.filter((n) => n.toolId === undefined || n.toolId === "");
  phase.ok(
    "plan.tool_nodes_have_toolid",
    missingToolId.length === 0,
    "every tool node to name a tool",
    missingToolId.length === 0
      ? `${toolNodes.length} tool node(s)`
      : `${missingToolId.map((n) => n.id).join(", ")} have no toolId`,
  );

  const unknownTools = toolNodes
    .map((n) => n.toolId)
    .filter((id): id is string => id !== undefined && id !== "" && !registry.has(id));
  phase.ok(
    "plan.toolids_in_registry",
    unknownTools.length === 0,
    `every toolId to exist in GET /api/tools (${[...registry].join(", ")})`,
    unknownTools.length === 0
      ? `${toolNodes.length} tool node(s), all registered`
      : `hallucinated: ${unknownTools.join(", ")}`,
  );

  const ids = new Set(graph.nodes.map((n) => n.id));
  const dangling = graph.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target));
  phase.ok(
    "plan.edges_resolve",
    dangling.length === 0,
    "every edge endpoint to name a node that exists",
    dangling.length === 0
      ? `${graph.edges.length} edge(s) resolve`
      : dangling.map((e) => `${e.id}: ${e.source}->${e.target}`).join(", "),
  );

  const selfLoops = graph.edges.filter((e) => e.source === e.target);
  phase.ok(
    "plan.no_self_loops",
    selfLoops.length === 0,
    "no edge to point at its own source",
    selfLoops.length === 0 ? "none" : selfLoops.map((e) => e.id).join(", "),
  );

  const cyclic = findCycle(graph);
  phase.ok(
    "plan.acyclic",
    cyclic.length === 0,
    "the graph to be acyclic — data flow must topologically sort",
    cyclic.length === 0 ? "acyclic" : `nodes in a cycle: ${cyclic.join(", ")}`,
  );
}

function summarise(frames: SseFrame[]): string {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const key = f.event ?? eventType(f) ?? (f.comment !== undefined ? `:${f.comment}` : "?");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, v]) => `${k}×${v}`).join(", ") || "none";
}
