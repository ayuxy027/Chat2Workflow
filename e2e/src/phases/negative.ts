/**
 * Phase 7 — negative cases.
 *
 * Three families, and they fail differently:
 *
 *   1. Path traversal on the blob store. It holds privileged client documents,
 *      and the id is the only thing between a request and the filesystem.
 *   2. Malformed mutations. A body that does not match the shared schema must
 *      be refused at the edge, with a status the caller can act on.
 *   3. Mutations that are well-formed but SEMANTICALLY invalid — a self-loop, a
 *      disconnect of an edge that does not exist, a document attached to a chat
 *      node. These are the `disconnect`-returned-202-and-did-nothing shape: the
 *      workflow is right to refuse them, and the caller is entitled to know it
 *      was refused rather than being told 202 and left with a canvas that
 *      disagrees with the server.
 *
 * The fabricated-citation case lives in `run.ts` next to the pipeline it needs.
 */

import { show, type Phase } from "../lib/report";
import { nodeById, type Api } from "../lib/api";

/** Ids that must never reach the filesystem. */
const TRAVERSALS: { label: string; path: string }[] = [
  { label: "encoded ../", path: "/api/blobs/..%2F..%2F..%2F..%2Fetc%2Fpasswd" },
  { label: "double-encoded ../", path: "/api/blobs/%2e%2e%2f%2e%2e%2fetc%2fpasswd" },
  { label: "absolute path", path: "/api/blobs/%2Fetc%2Fpasswd" },
  { label: "NUL byte", path: "/api/blobs/%00etc%2Fpasswd" },
  { label: "uppercase hex (not lowercase sha256)", path: `/api/blobs/${"A".repeat(64)}` },
  { label: "backslash traversal", path: "/api/blobs/..%5C..%5Cetc%5Cpasswd" },
  { label: "sha256 with a suffix", path: `/api/blobs/${"a".repeat(64)}.json` },
];

export async function negative(phase: Phase, api: Api): Promise<void> {
  /* ------------------------ path traversal ------------------------ */

  for (const t of TRAVERSALS) {
    let status = -1;
    let body = "";
    try {
      const res = await api.request<unknown>("GET", t.path);
      status = res.status;
      body = res.raw;
    } catch (err) {
      // A malformed URL the runtime itself refuses is also a rejection.
      status = 0;
      body = show(err, 120);
    }
    const leaked = /root:.*:0:0:/.test(body);
    phase.ok(
      `traversal.${t.label.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
      status !== 200 && !leaked,
      `GET ${t.path} to be refused (never 200, never file contents)`,
      `${status} ${leaked ? "LEAKED /etc/passwd CONTENT" : show(body, 160)}`,
    );
  }

  // The one path that must WORK, so the traversal checks are not passing for
  // the trivial reason that the endpoint is broken for everything.
  {
    const known = await api.uploadBlob(
      new TextEncoder().encode("blob-store liveness probe"),
      "probe.txt",
      "text/plain",
    );
    const res = await api.request<unknown>("GET", `/api/blobs/${known.sha256}`);
    phase.ok(
      "traversal.control_valid_id_still_serves",
      res.status === 200,
      "a legitimate 64-hex sha256 to still return 200 (the guard must not be a blanket deny)",
      `${res.status} ${show(res.body, 100)}`,
    );
  }

  // A 404 for a well-formed but unknown id, not a 500 and not a 200.
  {
    const res = await api.request<{ error?: string }>("GET", `/api/blobs/${"b".repeat(64)}`);
    phase.ok(
      "blobs.unknown_id_404",
      res.status === 404,
      "a well-formed but unknown sha256 to answer 404",
      `${res.status} ${show(res.body, 140)}`,
    );
  }

  /* --------------------- malformed mutations ---------------------- */

  const sessionId = await api.startSession();
  try {
    const malformed: { label: string; body: unknown | string; raw?: boolean }[] = [
      { label: "unknown op", body: { op: "teleportNode", id: "n1" } },
      { label: "missing discriminator", body: { id: "n1", position: { x: 0, y: 0 } } },
      { label: "connect without target", body: { op: "connect", source: "n1" } },
      { label: "addNode with an invalid kind", body: { op: "addNode", kind: "wormhole", position: { x: 0, y: 0 } } },
      { label: "addNode with a non-numeric position", body: { op: "addNode", kind: "chat", position: { x: "left", y: 0 } } },
      { label: "attachBlob with a short sha256", body: { op: "attachBlob", id: "n1", blob: { sha256: "abc", mime: "application/pdf", bytes: 1, filename: "x.pdf" } } },
      { label: "not JSON at all", body: "{not json", raw: true },
      { label: "empty body", body: "", raw: true },
    ];

    for (const m of malformed) {
      const res =
        m.raw === true
          ? await api.postRaw(`/api/sessions/${sessionId}/mutate`, m.body as string)
          : await api.postJson(`/api/sessions/${sessionId}/mutate`, m.body);
      phase.ok(
        `mutate.rejects_${m.label.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
        res.status === 400,
        `POST /mutate with ${m.label} to answer 400 — a body that does not match the shared ` +
          `schema must be refused at the edge, not inside workflow code`,
        `${res.status} ${show(res.body, 200)}`,
      );
    }

    /* ------------- semantically invalid but well-formed ------------- */

    // Build one real node so the invalid ops have something to aim at.
    const before = new Set((await api.graph(sessionId)).nodes.map((n) => n.id));
    await api.mutate(sessionId, {
      op: "addNode",
      kind: "chat",
      position: { x: 40, y: 40 },
      label: "Target",
    });
    let chatId = "";
    for (let i = 0; i < 100 && chatId === ""; i++) {
      const g = await api.graph(sessionId);
      chatId = g.nodes.find((n) => !before.has(n.id))?.id ?? "";
      if (chatId === "") await new Promise((r) => setTimeout(r, 60));
    }

    const semantic: { name: string; mutation: unknown; why: string }[] = [
      {
        name: "self_loop",
        mutation: { op: "connect", source: chatId, target: chatId },
        why: "a node cannot be connected to itself",
      },
      {
        name: "edge_to_missing_node",
        mutation: { op: "connect", source: chatId, target: "n999" },
        why: "an edge endpoint must name a node that exists",
      },
      {
        name: "disconnect_unknown_edge",
        mutation: { op: "disconnect", id: "e999" },
        why: "there is no such edge",
      },
      {
        name: "attach_to_non_document_node",
        mutation: {
          op: "attachBlob",
          id: chatId,
          blob: {
            sha256: "c".repeat(64),
            mime: "application/pdf",
            bytes: 10,
            filename: "nope.pdf",
          },
        },
        why: "a document can only be attached to a document node",
      },
      {
        name: "update_missing_node",
        mutation: { op: "updateNode", id: "n999", patch: { label: "ghost" } },
        why: "the node does not exist",
      },
      {
        name: "unregistered_toolid",
        mutation: { op: "updateNode", id: chatId, patch: { toolId: "pdf.telepathy" } },
        why: "the tool is not in the registry",
      },
    ];

    for (const s of semantic) {
      const { http, before: b, after } = await api.mutateExpectingNoChange(
        sessionId,
        s.mutation,
        900,
      );

      // (a) The authoritative graph must be untouched. This is the assertion
      //     that actually protects a run from executing along an edge that was
      //     never legal.
      const unchanged = JSON.stringify(b) === JSON.stringify(after);
      phase.ok(
        `mutate.${s.name}.graph_unchanged`,
        unchanged,
        `the authoritative graph to be unchanged after an invalid mutation (${s.why})`,
        unchanged
          ? `${after.nodes.length} node(s), ${after.edges.length} edge(s) — unchanged`
          : `nodes ${b.nodes.length}->${after.nodes.length}, edges ${b.edges.length}->${after.edges.length}`,
      );

      // (b) …and the caller must be TOLD. A 2xx for an edit the workflow
      //     refused is exactly the `disconnect` bug: the browser believes an
      //     edit landed, the server never took it, and the two silently
      //     disagree about what the pipeline will run on.
      phase.ok(
        `mutate.${s.name}.reported_to_caller`,
        http.status >= 400,
        `POST /mutate to report the rejection with a 4xx (${s.why}) — the shared wire ` +
          `contract routes edits through the applyMutation UPDATE precisely so a refused ` +
          `edit cannot come back as a success`,
        `${http.status} ${show(http.body, 160)}`,
      );
    }

    // And the positive control: a legal mutation on the same session still works.
    if (chatId !== "") {
      const { graph } = await api
        .mutateAndWait(
          sessionId,
          { op: "updateNode", id: chatId, patch: { label: "Still Editable" } },
          (g) => nodeById(g, chatId)?.label === "Still Editable",
        )
        .catch(async (err: Error) => {
          phase.caught("mutate.control_valid_edit_still_applies", err);
          return { graph: await api.graph(sessionId) };
        });
      phase.ok(
        "mutate.control_valid_edit_still_applies",
        nodeById(graph, chatId)?.label === "Still Editable",
        "a legal edit to still apply after a run of rejected ones",
        `label=${show(nodeById(graph, chatId)?.label)}`,
      );
    }

    /* ------------------------ upload guards ------------------------ */

    {
      const form = new FormData();
      form.append("file", new Blob([], { type: "application/pdf" }), "empty.pdf");
      const res = await api.request("POST", "/api/blobs", { body: form });
      phase.ok(
        "blobs.rejects_empty_upload",
        res.status === 400,
        "a zero-byte upload to be refused — it hashes to the well-known empty digest and " +
          "comes back as a perfectly valid BlobRef that fails much later as an empty extraction",
        `${res.status} ${show(res.body, 160)}`,
      );
    }
    {
      const res = await api.request("POST", "/api/blobs", {
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      phase.ok(
        "blobs.rejects_non_multipart",
        res.status === 415 || res.status === 400,
        "a non-multipart upload to be refused with 415 (or 400)",
        `${res.status} ${show(res.body, 160)}`,
      );
    }

    /* --------------------- session id validation -------------------- */

    {
      const res = await api.get("/api/sessions/..%2F..%2Fetc/graph");
      phase.ok(
        "sessions.rejects_bad_id",
        res.status >= 400 && res.status !== 500,
        "a session id outside [A-Za-z0-9_-] to be refused with a 4xx",
        `${res.status} ${show(res.body, 160)}`,
      );
    }
  } finally {
    await api.closeSession(sessionId);
  }
}
