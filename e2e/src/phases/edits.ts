/**
 * Phase 4 — canvas edits.
 *
 * Every assertion here reads the AUTHORITATIVE graph back from the workflow
 * (`GET /api/sessions/:id/graph`, which is the `getGraph` query) rather than
 * trusting the HTTP status. That is not pedantry: `disconnect` shipped
 * returning 202 while the workflow silently ignored it, so the canvas had no
 * edge, the server still had one, and a Run would then have executed along a
 * deleted edge. A 2xx proves a signal was accepted, never that it was honoured.
 *
 * `disconnect` and `detachBlob` are therefore regression tests, not coverage.
 */

import { edgeBetween, nodeById, type Api, type BlobRef, type Graph } from "../lib/api";
import { show, until, type Phase } from "../lib/report";

export async function edits(phase: Phase, api: Api, pdfBytes: Uint8Array): Promise<void> {
  const sessionId = await api.startSession();

  try {
    /* ------------------------- addNode ------------------------- */

    const doc = await addNode(api, sessionId, {
      op: "addNode",
      kind: "document",
      position: { x: 100, y: 100 },
      label: "Contract",
    });
    phase.ok(
      "addNode.document",
      doc.node?.kind === "document",
      "addNode to put a document node in the authoritative graph",
      doc.node === undefined ? "no new node appeared" : `${doc.id}: kind=${doc.node.kind}`,
    );
    phase.ok(
      "addNode.position_honoured",
      doc.node?.position.x === 100 && doc.node?.position.y === 100,
      "the position the caller chose to be kept (a user-placed node is pinned)",
      show(doc.node?.position),
    );

    const chat = await addNode(api, sessionId, {
      op: "addNode",
      kind: "chat",
      position: { x: 460, y: 100 },
      label: "Analysis",
    });
    phase.ok(
      "addNode.chat",
      chat.node?.kind === "chat",
      "a chat node to be added",
      chat.node === undefined ? "no new node appeared" : `${chat.id}: kind=${chat.node.kind}`,
    );

    const tool = await addNode(api, sessionId, {
      op: "addNode",
      kind: "tool",
      position: { x: 820, y: 100 },
      toolId: "pdf.split",
      label: "Split",
    });
    phase.ok(
      "addNode.tool_with_toolid",
      tool.node?.toolId === "pdf.split",
      'a tool node carrying toolId "pdf.split"',
      `${tool.id}: toolId=${show(tool.node?.toolId)}`,
    );

    /* ------------------------ updateNode ----------------------- */

    const NEW_LABEL = "Indemnity Review";
    const NEW_PROMPT = "List every indemnity obligation and who bears it.";
    {
      const { graph } = await api.mutateAndWait(
        sessionId,
        { op: "updateNode", id: chat.id, patch: { label: NEW_LABEL, prompt: NEW_PROMPT } },
        (g) => nodeById(g, chat.id)?.label === NEW_LABEL,
        { label: `node ${chat.id} to carry the new label` },
      ).catch(async (err: Error) => {
        phase.caught("updateNode.label_and_prompt", err);
        return { graph: await api.graph(sessionId) };
      });
      const n = nodeById(graph, chat.id);
      phase.ok(
        "updateNode.label_and_prompt",
        n?.label === NEW_LABEL && n?.prompt === NEW_PROMPT,
        `node ${chat.id} to have label=${show(NEW_LABEL)} and prompt=${show(NEW_PROMPT)}`,
        `label=${show(n?.label)} prompt=${show(n?.prompt)}`,
      );
    }

    {
      const params = { ranges: "1-3" };
      const { graph } = await api.mutateAndWait(
        sessionId,
        { op: "updateNode", id: tool.id, patch: { params } },
        (g) => (nodeById(g, tool.id)?.params as { ranges?: string } | undefined)?.ranges === "1-3",
        { label: `node ${tool.id} to carry params.ranges="1-3"` },
      ).catch(async (err: Error) => {
        phase.caught("updateNode.params", err);
        return { graph: await api.graph(sessionId) };
      });
      phase.ok(
        "updateNode.params",
        JSON.stringify(nodeById(graph, tool.id)?.params) === JSON.stringify(params),
        `node ${tool.id} params to become ${show(params)} — the node form writes through here`,
        show(nodeById(graph, tool.id)?.params),
      );
    }

    /* -------------------------- connect ------------------------ */

    let edgeId: string | undefined;
    {
      const { graph } = await api.mutateAndWait(
        sessionId,
        { op: "connect", source: doc.id, target: chat.id },
        (g) => edgeBetween(g, doc.id, chat.id) !== undefined,
        { label: `an edge ${doc.id}->${chat.id} to appear` },
      ).catch(async (err: Error) => {
        phase.caught("connect", err);
        return { graph: await api.graph(sessionId) };
      });
      const edge = edgeBetween(graph, doc.id, chat.id);
      edgeId = edge?.id;
      phase.ok(
        "connect",
        edge !== undefined,
        `an edge ${doc.id}->${chat.id} in the authoritative graph`,
        edge === undefined ? `edges: ${show(graph.edges)}` : `${edge.id}`,
      );
    }

    /* ------------------------ disconnect ----------------------- */
    /* REGRESSION: this returned 202 and did nothing.               */

    if (edgeId === undefined) {
      phase.skip("disconnect", "connect did not produce an edge to disconnect");
    } else {
      const before = await api.graph(sessionId);
      const http = await api.mutate(sessionId, { op: "disconnect", id: edgeId });
      const after = await until(
        `edge ${edgeId} to disappear from the authoritative graph`,
        8000,
        60,
        async () => {
          const g = await api.graph(sessionId);
          return g.edges.some((e) => e.id === edgeId) ? undefined : g;
        },
      ).catch(async () => api.graph(sessionId));

      phase.ok(
        "disconnect.removes_edge",
        !after.edges.some((e) => e.id === edgeId),
        `edge ${edgeId} to be GONE from the workflow's own graph after disconnect ` +
          `(HTTP said ${http.status}; a run must never execute along a deleted edge)`,
        after.edges.some((e) => e.id === edgeId)
          ? `still present: ${show(after.edges.filter((e) => e.id === edgeId))}`
          : `removed (${before.edges.length} -> ${after.edges.length} edges)`,
      );
    }

    /* ------------------------ attachBlob ----------------------- */

    const ref: BlobRef = await api.uploadBlob(pdfBytes, "northwind-msa.pdf", "application/pdf");
    {
      const { graph } = await api.mutateAndWait(
        sessionId,
        { op: "attachBlob", id: doc.id, blob: ref },
        (g) => nodeById(g, doc.id)?.blob?.sha256 === ref.sha256,
        { label: `node ${doc.id} to carry blob ${ref.sha256.slice(0, 12)}` },
      ).catch(async (err: Error) => {
        phase.caught("attachBlob", err);
        return { graph: await api.graph(sessionId) };
      });
      const n = nodeById(graph, doc.id);
      phase.ok(
        "attachBlob",
        n?.blob?.sha256 === ref.sha256,
        `node ${doc.id} to carry BlobRef sha256=${ref.sha256.slice(0, 12)}…`,
        n?.blob === undefined ? "no blob on the node" : `sha256=${n.blob.sha256.slice(0, 12)}…`,
      );
    }

    /* ------------------------ detachBlob ----------------------- */

    {
      const { graph } = await api.mutateAndWait(
        sessionId,
        { op: "detachBlob", id: doc.id },
        (g) => nodeById(g, doc.id)?.blob === undefined,
        { label: `node ${doc.id} to lose its blob` },
      ).catch(async (err: Error) => {
        phase.caught("detachBlob", err);
        return { graph: await api.graph(sessionId) };
      });
      const n = nodeById(graph, doc.id);
      phase.ok(
        "detachBlob.clears_blob",
        n?.blob === undefined,
        `node ${doc.id} to have NO blob after detach`,
        n?.blob === undefined ? "cleared" : `still ${show(n.blob)}`,
      );
    }

    /* ------------------------ removeNode ----------------------- */

    {
      // Re-connect first, so removal has an incident edge to clean up.
      await api.mutateAndWait(
        sessionId,
        { op: "connect", source: doc.id, target: chat.id },
        (g) => edgeBetween(g, doc.id, chat.id) !== undefined,
      ).catch(() => undefined);

      const { graph } = await api.mutateAndWait(
        sessionId,
        { op: "removeNode", id: chat.id },
        (g) => nodeById(g, chat.id) === undefined,
        { label: `node ${chat.id} to disappear` },
      ).catch(async (err: Error) => {
        phase.caught("removeNode", err);
        return { graph: await api.graph(sessionId) };
      });

      phase.ok(
        "removeNode",
        nodeById(graph, chat.id) === undefined,
        `node ${chat.id} to be gone from the authoritative graph`,
        nodeById(graph, chat.id) === undefined
          ? "removed"
          : `still present: ${show(nodeById(graph, chat.id))}`,
      );
      const orphans = graph.edges.filter((e) => e.source === chat.id || e.target === chat.id);
      phase.ok(
        "removeNode.removes_incident_edges",
        orphans.length === 0,
        `no edge to reference the deleted node ${chat.id}`,
        orphans.length === 0 ? "none" : show(orphans),
      );
    }
  } finally {
    await api.closeSession(sessionId);
  }

  await disconnectSurvivesARun(phase, api, pdfBytes);
}

/**
 * The regression in its deepest form: after `disconnect`, a RUN must not carry
 * data along the edge that is gone.
 *
 * Asserting the edge left `getGraph` is necessary but not sufficient — the
 * original bug's real cost was that execution followed an edge the user had
 * already deleted. Uses only a document node and an output node, so it costs a
 * couple of seconds and no model call.
 */
async function disconnectSurvivesARun(
  phase: Phase,
  api: Api,
  pdfBytes: Uint8Array,
): Promise<void> {
  const sessionId = await api.startSession();
  try {
    const ref = await api.uploadBlob(pdfBytes, "disconnect-probe.pdf", "application/pdf");

    const src = await addNode(api, sessionId, {
      op: "addNode",
      kind: "document",
      position: { x: 80, y: 80 },
      label: "Source",
    });
    const sink = await addNode(api, sessionId, {
      op: "addNode",
      kind: "output",
      position: { x: 400, y: 80 },
      label: "Sink",
    });
    if (src.node === undefined || sink.node === undefined) {
      phase.skip(
        "disconnect.run_does_not_traverse_deleted_edge",
        "could not build the two-node probe graph",
      );
      return;
    }

    await api.mutateAndWait(
      sessionId,
      { op: "attachBlob", id: src.id, blob: ref },
      (g) => nodeById(g, src.id)?.blob?.sha256 === ref.sha256,
    );
    const { graph: connected } = await api.mutateAndWait(
      sessionId,
      { op: "connect", source: src.id, target: sink.id },
      (g) => edgeBetween(g, src.id, sink.id) !== undefined,
    );
    const edgeId = edgeBetween(connected, src.id, sink.id)?.id ?? "";

    await api.mutateAndWait(
      sessionId,
      { op: "disconnect", id: edgeId },
      (g) => !g.edges.some((e) => e.id === edgeId),
      { label: `edge ${edgeId} to be removed before the run` },
    );

    await api.run(sessionId);
    const final = await until(
      "the run to finish",
      90_000,
      200,
      async () => {
        const g = await api.graph(sessionId);
        const terminal = g.nodes.every((n) => n.status === "done" || n.status === "error");
        return terminal ? g : undefined;
      },
    ).catch(async () => api.graph(sessionId));

    const sinkNode = nodeById(final, sink.id);
    const received = sinkNode?.outputs ?? [];
    phase.ok(
      "disconnect.run_does_not_traverse_deleted_edge",
      received.length === 0,
      `the output node to receive NOTHING after its only inbound edge was disconnected — ` +
        `a run must never execute along a deleted edge`,
      received.length === 0
        ? `no artifacts arrived (result: ${show(sinkNode?.result, 80)})`
        : `it received ${received.length} artifact(s): ${received.map((b) => b.filename).join(", ")}`,
    );
  } catch (err) {
    phase.caught("disconnect.run_does_not_traverse_deleted_edge", err);
  } finally {
    await api.closeSession(sessionId);
  }
}

/** Applies an addNode and resolves the id the WORKFLOW assigned. */
async function addNode(
  api: Api,
  sessionId: string,
  mutation: Record<string, unknown>,
): Promise<{ id: string; node: Graph["nodes"][number] | undefined }> {
  const before = new Set((await api.graph(sessionId)).nodes.map((n) => n.id));
  await api.mutate(sessionId, mutation);
  try {
    const found = await until(
      `a new node from ${show(mutation, 120)}`,
      8000,
      60,
      async () => {
        const g = await api.graph(sessionId);
        const fresh = g.nodes.find((n) => !before.has(n.id));
        return fresh === undefined ? undefined : fresh;
      },
    );
    return { id: found.id, node: found };
  } catch {
    return { id: "<never-created>", node: undefined };
  }
}
