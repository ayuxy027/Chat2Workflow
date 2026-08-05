/**
 * Whether a wire the user is dragging can possibly work.
 *
 * `ToolManifest` already declares `accepts[]` and `produces[]` as mime types, so
 * this is derivable rather than guessable: a `text/plain` output physically
 * cannot feed a tool that only takes `application/pdf`. Until now the canvas
 * accepted any drop and the user found out at Run, as a red-flag node error on a
 * pipeline they had already finished building. React Flow calls this during the
 * gesture, refuses the drop, and styles the target handle — the mistake never
 * gets made.
 *
 * THE BIAS IS DELIBERATELY PERMISSIVE. A connection is refused only when we can
 * prove it cannot work; anything unknown (a document with no file attached yet,
 * a tool the registry has not loaded) is allowed. A false rejection is worse
 * than a late error, because the user is left dragging at a handle that will
 * never accept and nothing on screen explains why.
 *
 * Returns the REASON rather than a boolean so the same rules can both drive
 * `isValidConnection` and tell the user what went wrong when a drop is refused.
 */

import type { Connection, Edge } from "@xyflow/react";
import type { Graph, GraphNode, NodeKind, ToolManifest } from "@wf/shared";

/** Text a chat step emits, and what an `input` node contributes. */
const TEXT_MIMES = ["text/plain", "text/markdown"];

/** Kinds with no target handle at all — nothing can flow into them. */
const SINKLESS: readonly NodeKind[] = ["document", "input"];

export interface ConnectionContext {
  graph: Graph;
  manifests: Map<string, ToolManifest>;
}

/**
 * What a node offers downstream, or `null` when it cannot be known yet.
 *
 * `null` means "do not judge on mime" — an empty document node has no file, so
 * refusing to wire it up would make the obvious build order (draw the pipeline,
 * then attach the contract) impossible.
 */
function produces(node: GraphNode, manifests: Map<string, ToolManifest>): string[] | null {
  switch (node.kind) {
    case "document":
      return node.blob === undefined ? null : [node.blob.mime];
    case "input":
      return TEXT_MIMES;
    case "chat":
      // A model step answers in text. It never emits bytes.
      return TEXT_MIMES;
    case "tool": {
      if (node.toolId === undefined) return null;
      const manifest = manifests.get(node.toolId);
      return manifest === undefined ? null : manifest.produces;
    }
    case "output":
      return null;
  }
}

/** What a node will take, or `null` for "anything". */
function accepts(node: GraphNode, manifests: Map<string, ToolManifest>): string[] | null {
  switch (node.kind) {
    case "tool": {
      if (node.toolId === undefined) return null;
      const manifest = manifests.get(node.toolId);
      return manifest === undefined ? null : manifest.accepts;
    }
    // A chat step reads documents and extracted text alike, and an output node
    // collects whatever reaches it. Neither constrains its input by type.
    default:
      return null;
  }
}

/** How many inputs a node may have, or `null` for unbounded. */
function maxInputs(node: GraphNode, manifests: Map<string, ToolManifest>): number | null {
  if (node.kind !== "tool" || node.toolId === undefined) return null;
  const manifest = manifests.get(node.toolId);
  return manifest === undefined ? null : manifest.maxInputs;
}

/** Does adding source→target close a loop? Walks forward from `target`. */
function wouldCycle(graph: Graph, source: string, target: string): boolean {
  const forward = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = forward.get(edge.source);
    if (list) list.push(edge.target);
    else forward.set(edge.source, [edge.target]);
  }

  const seen = new Set<string>([target]);
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === source) return true;
    for (const next of forward.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

const shortMime = (mime: string): string => mime.split("/").pop() ?? mime;

/**
 * `null` when the connection is fine, otherwise a sentence the user can act on.
 *
 * Order matters: the structural refusals come first because they are certain,
 * and the mime check comes last because it is the one that depends on state the
 * user can still change.
 */
export function connectionIssue(
  connection: Connection | Edge,
  { graph, manifests }: ConnectionContext,
): string | null {
  const { source, target } = connection;
  if (!source || !target) return "Incomplete connection.";
  if (source === target) return "A step cannot feed itself.";

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const from = byId.get(source);
  const to = byId.get(target);
  // Unknown endpoints mean the replica is mid-update; let the workflow decide.
  if (from === undefined || to === undefined) return null;

  if (SINKLESS.includes(to.kind)) {
    return `A ${to.kind} step has no input — nothing can flow into it.`;
  }

  if (graph.edges.some((e) => e.source === source && e.target === target)) {
    return "These steps are already connected.";
  }

  if (wouldCycle(graph, source, target)) {
    return "That would make a loop. Data flow has to run one way.";
  }

  const limit = maxInputs(to, manifests);
  if (limit !== null) {
    const existing = graph.edges.filter((e) => e.target === target).length;
    if (existing >= limit) {
      return limit === 1
        ? `${to.label} takes a single input. Disconnect the current one first.`
        : `${to.label} takes at most ${limit} inputs.`;
    }
  }

  const offered = produces(from, manifests);
  const wanted = accepts(to, manifests);
  if (offered !== null && wanted !== null && wanted.length > 0) {
    const compatible = offered.some((mime) => wanted.includes(mime));
    if (!compatible) {
      return (
        `${to.label} takes ${wanted.map(shortMime).join(" or ")}, and ` +
        `${from.label} produces ${offered.map(shortMime).join(" or ")}.`
      );
    }
  }

  return null;
}

export const canConnect = (
  connection: Connection | Edge,
  context: ConnectionContext,
): boolean => connectionIssue(connection, context) === null;
