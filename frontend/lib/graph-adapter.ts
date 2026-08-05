/**
 * The ONE place that maps between the domain model (`@wf/shared`) and React Flow.
 *
 * The React Flow node is a *projection*, not the domain object:
 *
 *     GraphNode { id, kind, position, ...rest }
 *   → Node      { id, type: kind, position, data: { ...rest } }
 *
 * Nothing else in the app is allowed to know that `type` means `kind` or that
 * everything else lives under `data`. If you find yourself writing `node.data.status`
 * outside a node component, the mapping has leaked.
 *
 * NOTE ON IMPORTS: this module takes `@wf/shared` as `import type` only. It needs
 * the shapes, not the schemas, and type imports are erased before bundling — so
 * the browser never pays for zod to draw a rectangle. The one place validation
 * genuinely belongs is the SSE boundary in `use-session.ts`, where bytes off the
 * wire first become a `GraphEvent`.
 */

import { MarkerType } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type {
  Graph,
  GraphEdge,
  GraphEvent,
  GraphMutation,
  GraphNode,
  NodeKind,
  NodeStatus,
  Position,
} from "@wf/shared";

/* -------------------------------------------------------------------------- */
/* Projected types                                                            */
/* -------------------------------------------------------------------------- */

/** Everything on a `GraphNode` that isn't structural to React Flow. */
export type WfNodeData = Omit<GraphNode, "id" | "kind" | "position">;

/**
 * Marks an id the BROWSER invented for an optimistic edit, before the workflow
 * has said what the thing is really called.
 *
 * The workflow allocates `n1`, `n2` … for nodes and `e1`, `e2` … for edges from
 * its own counters, so an id the browser makes up is guaranteed to be one the
 * workflow will never recognise. Sending it back in a `disconnect` or a
 * `removeNode` signal is accepted (202) and then silently ignored — the canvas
 * drops the element and the workflow keeps it. In a legal tool a canvas that
 * shows a graph the audit trail does not have is a correctness bug, not a
 * cosmetic one, so every local id is tagged, is never sent to the workflow as a
 * handle, and is replaced by the authoritative id in `applyEvent`.
 */
export const LOCAL_ID_PREFIX = "local:";

export const isLocalId = (id: string): boolean => id.startsWith(LOCAL_ID_PREFIX);

export type WfNode = Node<WfNodeData, NodeKind>;
export type WfEdge = Edge;

export const NODE_KINDS: readonly NodeKind[] = [
  "document",
  "chat",
  "tool",
  "input",
  "output",
];

/** Glyph per kind — PRD §3.4. Kind is signalled by glyph and handles, never colour. */
export const KIND_GLYPH: Record<NodeKind, string> = {
  document: "▤",
  chat: "◐",
  tool: "⚙",
  input: "▷",
  output: "◼",
};

export const KIND_NAME: Record<NodeKind, string> = {
  document: "Document",
  chat: "Model step",
  tool: "Tool",
  input: "Input",
  output: "Output",
};

/** Monochrome arrowhead — black at an opacity, never a hue. */
const MARKER_END = {
  type: MarkerType.ArrowClosed,
  width: 12,
  height: 12,
  color: "rgba(0,0,0,0.45)",
} as const;

function asKind(type: string | undefined): NodeKind {
  return type !== undefined && (NODE_KINDS as readonly string[]).includes(type)
    ? (type as NodeKind)
    : "chat";
}

/* -------------------------------------------------------------------------- */
/* Domain → React Flow                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The wrapper element belongs to React Flow, not to us, so its styling has to
 * ride along on the node object. Two things need saying there:
 *
 *  - `outline-none` kills the user-agent focus ring, which is the one piece of
 *    chrome on this page that would otherwise arrive with a hue.
 *  - the replacement is a *dashed* offset ring. It must not be a solid one:
 *    a solid offset ring already means `error` (PRD §3.4), and a keyboard-focused
 *    healthy node must not read as a failed one.
 */
const NODE_WRAPPER_CLASS =
  "rounded-node outline-none focus-visible:outline-1 focus-visible:outline-dashed focus-visible:outline-offset-[3px] focus-visible:outline-line-strong";

/**
 * Default card width, set on the React Flow node rather than in the component's
 * class list — `NodeResizer` writes `style.width`/`style.height`, and a
 * Tailwind `w-[248px]` inside the node would win over it and make the resizer
 * appear to do nothing.
 */
const NODE_DEFAULT_STYLE = { width: 248 } as const;

export function toFlowNode(node: GraphNode): WfNode {
  const { id, kind, position, ...data } = node;
  return {
    id,
    type: kind,
    position,
    data,
    className: NODE_WRAPPER_CLASS,
    style: NODE_DEFAULT_STYLE,
  };
}

export function toFlowEdge(edge: GraphEdge, active = false): WfEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "wf",
    markerEnd: MARKER_END,
    // An edge the workflow has not named yet cannot be deleted, because the
    // only handle we could send is the placeholder id we invented — and
    // `disconnect` on an id the workflow does not know is accepted, ignored,
    // and leaves the canvas showing an edge that is still in the graph. The
    // window is one round trip; deletion re-enables the moment the
    // authoritative `edge.added` swaps the id in.
    deletable: !isLocalId(edge.id),
    // `.wf-edge-active` is defined in globals.css: a dash flows along the path
    // while data moves through it.
    className: active ? "wf-edge-active" : undefined,
  };
}

export function toFlow(graph: Graph): { nodes: WfNode[]; edges: WfEdge[] } {
  const statusOf = statusLookup(graph.nodes);
  return {
    nodes: graph.nodes.map(toFlowNode),
    edges: graph.edges.map((e) => toFlowEdge(e, statusOf(e.source) === "running")),
  };
}

/* -------------------------------------------------------------------------- */
/* React Flow → Domain                                                        */
/* -------------------------------------------------------------------------- */

export function fromFlowNode(node: WfNode): GraphNode {
  return {
    id: node.id,
    kind: asKind(node.type),
    position: node.position,
    ...node.data,
  };
}

export function fromFlowEdge(edge: WfEdge): GraphEdge {
  return { id: edge.id, source: edge.source, target: edge.target };
}

export function fromFlow(nodes: WfNode[], edges: WfEdge[]): Graph {
  return { nodes: nodes.map(fromFlowNode), edges: edges.map(fromFlowEdge) };
}

/* -------------------------------------------------------------------------- */
/* Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild the React Flow node list from the domain graph while preserving the
 * view-local state React Flow owns and the domain does not: selection, measured
 * size, and the in-flight position of a node the user is currently dragging.
 *
 * Without this, every inbound `node.updated` event would cancel a drag and drop
 * the user's selection.
 */
export function reconcileFlowNodes(prev: WfNode[], nodes: GraphNode[]): WfNode[] {
  const previous = new Map(prev.map((n) => [n.id, n]));
  return nodes.map((node) => {
    const next = toFlowNode(node);
    const old = previous.get(node.id);
    if (!old) return next;
    return {
      ...old,
      ...next,
      // A drag in progress outranks the authoritative position: the move signal
      // has not been sent yet, so the server copy is stale by definition.
      position: old.dragging ? old.position : next.position,
      selected: old.selected,
      dragging: old.dragging,
      measured: old.measured,
      /*
       * Size is VIEW-LOCAL and has to survive the rebuild.
       *
       * `NodeResizer` writes width and height onto the node, and the domain
       * model has no opinion about them — so without carrying them across,
       * every inbound event would snap a node the user just resized back to
       * 248px. The same argument as selection and in-flight drag position:
       * these belong to the view, and the view is the only thing that knows
       * them.
       *
       * The consequence, stated plainly: a resize is not persisted and a reload
       * restores the default. Persisting it needs a field in `@wf/shared`.
       */
      style: old.style ?? next.style,
      width: old.width,
      height: old.height,
    };
  });
}

export function reconcileFlowEdges(
  prev: WfEdge[],
  edges: GraphEdge[],
  nodes: GraphNode[],
): WfEdge[] {
  const previous = new Map(prev.map((e) => [e.id, e]));
  const statusOf = statusLookup(nodes);
  return edges.map((edge) => {
    const next = toFlowEdge(edge, statusOf(edge.source) === "running");
    const old = previous.get(edge.id);
    return old ? { ...old, ...next, selected: old.selected } : next;
  });
}

function statusLookup(nodes: GraphNode[]): (id: string) => NodeStatus | undefined {
  const map = new Map(nodes.map((n) => [n.id, n.status]));
  return (id) => map.get(id);
}

/* -------------------------------------------------------------------------- */
/* The reducer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fold one `GraphEvent` into the local graph replica.
 *
 * Every mutation in the app — optimistic local edits and events arriving over
 * SSE alike — goes through this function. That is the whole point: there is one
 * code path from "something changed" to "the canvas shows it", so replaying the
 * log from a cursor produces exactly the state a live session would have.
 *
 * Events that carry no graph change (chat, run.*, plan.*) return the graph
 * unchanged by identity, so React can skip the re-render.
 */
/**
 * Restores the fields the `GraphNode` schema guarantees are always present.
 *
 * `citations`, `outputs`, `params` and `status` carry a zod `.default()`, so
 * the inferred type has them as REQUIRED and every component reads them without
 * a guard (`data.citations.length`, `data.outputs.map(...)`). `clear` can name
 * any of them — clearing `citations` is exactly what detaching a document
 * should do — and a plain `delete` would then hand a node with `citations:
 * undefined` to a `.length`, which is a blank canvas and a thrown TypeError.
 * Clearing means "back to empty", not "absent".
 */
function normalize(node: GraphNode): GraphNode {
  if (node.params === undefined) node.params = {};
  if (node.outputs === undefined) node.outputs = [];
  if (node.citations === undefined) node.citations = [];
  if (node.status === undefined) node.status = "idle";
  if (node.label === undefined) node.label = "";
  return node;
}

export function applyEvent(graph: Graph, event: GraphEvent): Graph {
  switch (event.t) {
    case "node.added": {
      const exists = graph.nodes.some((n) => n.id === event.node.id);
      return {
        ...graph,
        nodes: exists
          ? graph.nodes.map((n) => (n.id === event.node.id ? event.node : n))
          : [...graph.nodes, event.node],
      };
    }

    case "node.updated": {
      let hit = false;
      const nodes = graph.nodes.map((n) => {
        if (n.id !== event.id) return n;
        hit = true;
        // `id` is structural — a patch may never move a node to another identity.
        const { id: _ignored, ...patch } = event.patch;
        const next: GraphNode = { ...n, ...patch };

        /*
         * `clear` is applied AFTER `patch`, and it is the only way to remove a
         * field.
         *
         * `patch: { blob: undefined }` cannot express removal: `JSON.stringify`
         * drops undefined-valued keys, so the field never crosses the wire and
         * the spread above leaves the old value in place. That is how detaching
         * a document used to leave the canvas showing the file, its result, and
         * its citations while the authoritative graph had none of them — a
         * replica quietly claiming the pipeline will run on bytes that are no
         * longer attached.
         */
        for (const field of event.clear ?? []) {
          if (field === "id" || field === "kind" || field === "position") continue;
          delete (next as Record<string, unknown>)[field];
        }
        return normalize(next);
      });
      return hit ? { ...graph, nodes } : graph;
    }

    case "node.removed": {
      if (!graph.nodes.some((n) => n.id === event.id)) return graph;
      return {
        nodes: graph.nodes.filter((n) => n.id !== event.id),
        // Dangling edges are not a valid graph state, so they go with the node.
        edges: graph.edges.filter(
          (e) => e.source !== event.id && e.target !== event.id,
        ),
      };
    }

    case "edge.added": {
      if (graph.edges.some((e) => e.id === event.edge.id)) return graph;

      /*
       * The same wire under a different name.
       *
       * An optimistic `connect` puts an edge on the canvas under an id the
       * browser invented, because the workflow's counter is not observable from
       * here. When the authoritative `edge.added` for that same (source,target)
       * arrives it must REPLACE the placeholder, not be discarded as a
       * duplicate: discarding it leaves the canvas holding an id no signal can
       * ever address, so deleting the edge later removes it from the canvas and
       * from nothing else. (source, target) is a unique key — the workflow
       * refuses a second edge between the same pair — so this identification is
       * exact.
       */
      const twin = graph.edges.findIndex(
        (e) => e.source === event.edge.source && e.target === event.edge.target,
      );
      if (twin === -1) return { ...graph, edges: [...graph.edges, event.edge] };
      if (!isLocalId(graph.edges[twin]!.id)) return graph;

      const edges = [...graph.edges];
      edges[twin] = event.edge;
      return { ...graph, edges };
    }

    case "edge.removed": {
      if (!graph.edges.some((e) => e.id === event.id)) return graph;
      return { ...graph, edges: graph.edges.filter((e) => e.id !== event.id) };
    }

    default:
      return graph;
  }
}

/* -------------------------------------------------------------------------- */
/* Mutations → events                                                         */
/* -------------------------------------------------------------------------- */

export interface MutationContext {
  /** Monotonic sequence allocator for the events this mutation produces. */
  seq: () => number;
}

/** Placeholder id for an edge the workflow has not named yet. See `LOCAL_ID_PREFIX`. */
export const localEdgeId = (source: string, target: string): string =>
  `${LOCAL_ID_PREFIX}${source}->${target}`;

/**
 * The ONE place the browser writes the text a user typed into an `input` node.
 *
 * `@wf/shared` makes `node.value` canonical and `nodeInputText()` the only
 * correct reader — but `GraphMutation.updateNode.patch` does not carry `value`
 * yet, and zod strips unknown keys, so sending it would be dropped in silence
 * at the API boundary. That is precisely the failure mode this whole accessor
 * exists to end, so the write goes to `params.text` instead, which the schema
 * does carry and which `nodeInputText()` reads as its documented compatibility
 * path. Verified end to end rather than assumed.
 *
 * When `value` lands in the mutation schema this function is the only edit:
 * change the returned patch and every call site follows.
 *
 * REPORTED UPSTREAM: `updateNode.patch` needs `value: z.string().optional()`.
 */
export function inputTextMutation(node: GraphNode, text: string): GraphMutation {
  return {
    op: "updateNode",
    id: node.id,
    patch: { params: { ...node.params, text } },
  };
}

/**
 * Translate a `GraphMutation` (what the browser asks for) into the `GraphEvent`s
 * it implies (what the log records), so an optimistic local edit and the server's
 * eventual confirmation flow through the identical reducer. PRD §8.2: the
 * workflow is authoritative, and a conflicting event simply overwrites.
 *
 * A mutation only gets an optimistic event when the browser can name the thing
 * it is changing with an id the workflow will accept back. That is true of every
 * op except `addNode`, which asks the workflow to invent an identity — see below.
 */
export function mutationToEvents(
  graph: Graph,
  mutation: GraphMutation,
  ctx: MutationContext,
): GraphEvent[] {
  switch (mutation.op) {
    /*
     * NOT optimistic, deliberately.
     *
     * A node's id comes from the workflow's counter, and the browser cannot
     * predict it. Rendering a placeholder node means the authoritative
     * `node.added` arrives under a different id and the canvas ends up showing
     * BOTH — a phantom the workflow has never heard of sitting next to the real
     * one, with no console error and no way for the user to tell them apart.
     * (Verified: two clicks in the build panel produced `local-n1, n1,
     * local-n2, n2` on the canvas against a two-node graph.)
     *
     * A node arrives one signal round trip late instead. Unlike a drag or a
     * connect, clicking a palette entry is not a gesture whose feel depends on
     * sub-100ms feedback.
     */
    case "addNode":
      return [];

    case "moveNode":
      return [
        {
          seq: ctx.seq(),
          t: "node.updated",
          id: mutation.id,
          patch: { position: mutation.position },
        },
      ];

    case "updateNode":
      return [
        { seq: ctx.seq(), t: "node.updated", id: mutation.id, patch: mutation.patch },
      ];

    case "removeNode":
      return [{ seq: ctx.seq(), t: "node.removed", id: mutation.id }];

    case "connect": {
      if (mutation.source === mutation.target) return [];
      // The workflow refuses a duplicate wire, so the canvas must too, or the
      // optimistic edge would never be reconciled with an authoritative one.
      const duplicate = graph.edges.some(
        (e) => e.source === mutation.source && e.target === mutation.target,
      );
      if (duplicate) return [];
      return [
        {
          seq: ctx.seq(),
          t: "edge.added",
          edge: {
            id: localEdgeId(mutation.source, mutation.target),
            source: mutation.source,
            target: mutation.target,
          },
        },
      ];
    }

    case "disconnect":
      return [{ seq: ctx.seq(), t: "edge.removed", id: mutation.id }];

    case "attachBlob":
      return [
        {
          seq: ctx.seq(),
          t: "node.updated",
          id: mutation.id,
          patch: { blob: mutation.blob, label: mutation.blob.filename, status: "idle" },
          // Swapping the document invalidates everything derived from the old
          // one. Leaving a result and its citations attached to bytes that are
          // no longer there is the provenance break the audit trail exists to
          // prevent, and it is the same list the workflow clears.
          clear: [...DERIVED_FIELDS],
        },
      ];

    case "detachBlob":
      return [
        {
          seq: ctx.seq(),
          t: "node.updated",
          id: mutation.id,
          patch: { status: "idle" },
          clear: ["blob", ...DERIVED_FIELDS],
        },
      ];

    default:
      return [];
  }
}

/**
 * Everything on a node that was DERIVED from its attached document.
 *
 * Named once because both `attachBlob` and `detachBlob` have to drop exactly
 * this set, and because it has to be expressed as `clear` rather than as
 * `patch: { result: undefined }` — JSON drops undefined-valued keys, so a patch
 * cannot remove a field at all (see `applyEvent`).
 */
const DERIVED_FIELDS = [
  "outputs",
  "result",
  "citations",
  "error",
  "log",
  "truncated",
  "verifiedCount",
  "unverifiedCount",
  "provenance",
] as const satisfies readonly (keyof GraphNode)[];

/* -------------------------------------------------------------------------- */
/* Graph queries the UI needs                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every node reachable downstream of `rootId`, excluding the root.
 *
 * The delete confirmation lists these by name. A paralegal deleting the extract
 * step needs to be told, in words, that the cited summary goes with it.
 */
export function downstreamClosure(graph: Graph, rootId: string): GraphNode[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.source);
    if (list) list.push(edge.target);
    else adjacency.set(edge.source, [edge.target]);
  }

  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  const order: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      order.push(next);
      queue.push(next);
    }
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return order
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => n !== undefined);
}

/**
 * Kahn topological order. Nodes in a cycle are appended at the end rather than
 * dropped — a malformed graph should still be visible and runnable-ish, not
 * silently truncated.
 */
export function topologicalOrder(graph: Graph): string[] {
  const indegree = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const list = outgoing.get(edge.source);
    if (list) list.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }

  const ready = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  for (const node of graph.nodes) {
    if (!order.includes(node.id)) order.push(node.id);
  }
  return order;
}

/** Where a new manually-added node lands: below the current stack, out of the way. */
export function nextFreePosition(graph: Graph): Position {
  if (graph.nodes.length === 0) return { x: 80, y: 80 };
  const lowest = Math.max(...graph.nodes.map((n) => n.position.y));
  return { x: 80, y: lowest + 180 };
}
