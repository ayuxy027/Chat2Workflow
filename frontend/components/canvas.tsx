"use client";

/**
 * The canvas — PRD §3.3.
 *
 * `nodeTypes` and `edgeTypes` are module-level constants. Defining them inside
 * the component would hand React Flow a new object every render and remount
 * every node, which throws away focus, selection, and any in-flight edit.
 *
 * No MiniMap: it is explicitly out of scope (§2.2) and it would be the one
 * element on screen that has to invent a colour to be legible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  reconnectEdge,
  useNodesInitialized,
  useOnSelectionChange,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type EdgeTypes,
  type IsValidConnection,
  type NodeTypes,
  type OnBeforeDelete,
} from "@xyflow/react";
import type { NodeKind } from "@wf/shared";
import { canConnect, connectionIssue } from "@/lib/connection-rules";
import { downstreamClosure, type WfEdge, type WfNode } from "@/lib/graph-adapter";
import type { SessionApi } from "@/lib/use-session";
import { useToolRegistry } from "@/lib/use-tools";
import { CanvasActionsProvider, type CanvasActions } from "@/components/canvas-context";
import { DeleteConfirm } from "@/components/delete-confirm";
import { Inspector } from "@/components/inspector";
import { WfEdge as WfEdgeComponent } from "@/components/edges/wf-edge";
import { ChatNode } from "@/components/nodes/chat-node";
import { DocumentNode } from "@/components/nodes/document-node";
import { InputNode } from "@/components/nodes/input-node";
import { OutputNode } from "@/components/nodes/output-node";
import { ToolNode } from "@/components/nodes/tool-node";

const nodeTypes: NodeTypes = {
  document: DocumentNode,
  chat: ChatNode,
  tool: ToolNode,
  input: InputNode,
  output: OutputNode,
} satisfies Record<NodeKind, unknown> & NodeTypes;

const edgeTypes: EdgeTypes = {
  wf: WfEdgeComponent,
};

const DELETE_KEYS = ["Backspace", "Delete"];

/**
 * Applies to edges React Flow creates itself. Ours arrive from the domain graph
 * through the adapter, which sets the same fields — `defaultEdgeOptions` does
 * not merge into edges passed in via the `edges` prop, so both are needed and
 * neither is redundant.
 */
const DEFAULT_EDGE_OPTIONS = {
  type: "wf",
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "rgba(0,0,0,0.45)" },
} as const;

const CONNECTION_LINE_STYLE = { stroke: "rgba(0,0,0,0.55)", strokeWidth: 1 } as const;

/**
 * Snapped to the dot grid the background already draws, so a node the user
 * places by hand lines up with what is behind it.
 *
 * REPORTED: `layout()` in `@wf/shared` uses a 320/180 pitch from an 80,80
 * origin, none of which are multiples of 24 — so planner-placed nodes sit off
 * this grid and dragged ones snap onto it. Aligning the two needs the pitch
 * changed in shared, which is not this package's to change.
 */
const SNAP_GRID: [number, number] = [24, 24];

export function Canvas({ session }: { session: SessionApi }) {
  return (
    <ReactFlowProvider>
      <CanvasInner session={session} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ session }: { session: SessionApi }) {
  const { fitView } = useReactFlow<WfNode, WfEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const nodesInitialized = useNodesInitialized();
  const registry = useToolRegistry();

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const actions = useMemo<CanvasActions>(
    () => ({
      updateNode: (id, patch) => session.mutate({ op: "updateNode", id, patch }),
      requestDelete: (id) => setPendingDeleteId(id),
      inspect: (id) => setInspectedId(id),
      attachDocument: (id, file) => {
        void session.attachDocument(id, file);
      },
    }),
    [session],
  );

  /* --- connection validity ------------------------------------------------ */

  const rules = useMemo(
    () => ({ graph: session.graph, manifests: registry.byId }),
    [session.graph, registry.byId],
  );

  /**
   * React Flow asks this while the user is still dragging, so an impossible
   * wire is refused at the gesture and the target handle styles itself. The
   * alternative — which is what shipped — is a graph that looks finished and
   * fails at Run with a node error.
   */
  const isValidConnection = useCallback<IsValidConnection<WfEdge>>(
    (connection) => canConnect(connection, rules),
    [rules],
  );

  /**
   * `isValidConnection` can only say no. This says why.
   *
   * A handle that silently refuses is its own kind of dead end: the user
   * repeats the gesture, assumes the canvas is broken, and has no way to learn
   * that the tool takes PDFs. The reason is computed from the same rules, so
   * the two can never disagree.
   */
  const explainRefusal = useCallback(
    (connection: Connection) => {
      const issue = connectionIssue(connection, rules);
      if (issue !== null) setRefusal(issue);
    },
    [rules],
  );

  useEffect(() => {
    if (refusal === null) return;
    const handle = setTimeout(() => setRefusal(null), 6_000);
    return () => clearTimeout(handle);
  }, [refusal]);

  /* --- handle geometry ----------------------------------------------------- */

  /**
   * Tell React Flow when a node's handles may have moved.
   *
   * React Flow measures handle positions once and caches them. Anything that
   * changes a node's handle configuration after mount — re-pointing a tool node
   * at a different tool from the inspector is the live case — leaves the cache
   * stale, and edges keep attaching to where the handle used to be. It is
   * silent, and it looks like a rendering glitch rather than a stale
   * measurement.
   *
   * Only nodes whose handle-relevant signature actually changed are refreshed;
   * calling this for every node on every event would be a full re-measure at
   * event rate.
   */
  const handleSignatures = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = new Set<string>();
    for (const node of session.graph.nodes) {
      seen.add(node.id);
      const signature = `${node.kind}|${node.toolId ?? ""}`;
      if (handleSignatures.current.get(node.id) === signature) continue;
      const known = handleSignatures.current.has(node.id);
      handleSignatures.current.set(node.id, signature);
      if (known) updateNodeInternals(node.id);
    }
    for (const id of handleSignatures.current.keys()) {
      if (!seen.has(id)) handleSignatures.current.delete(id);
    }
  }, [session.graph.nodes, updateNodeInternals]);

  /* --- selection drives the inspector -------------------------------------- */

  /**
   * The inspector follows SELECTION, not clicks.
   *
   * Selection is the thing React Flow already maintains — through clicks, box
   * select, and keyboard navigation alike — so driving off it means the panel
   * opens by keyboard for free and closes when the user does anything that
   * clears the selection. Exactly one node is inspectable at a time: a panel of
   * editable fields cannot mean anything for a multi-selection.
   */
  useOnSelectionChange({
    onChange: useCallback(({ nodes }: { nodes: WfNode[] }) => {
      setInspectedId(nodes.length === 1 ? (nodes[0]?.id ?? null) : null);
    }, []),
  });

  /**
   * Deletion never happens on the keystroke. React Flow asks first, we veto and
   * raise the confirmation instead; the actual removal goes out as an ordinary
   * `removeNode` mutation once the user has typed the word. Edges are not
   * destructive in the same way — rewiring is the point of the canvas — so they
   * delete straight through.
   */
  const onBeforeDelete = useCallback<OnBeforeDelete<WfNode, WfEdge>>(
    async ({ nodes }) => {
      const first = nodes[0];
      if (!first) return true;
      setPendingDeleteId(first.id);
      return false;
    },
    [],
  );

  /*
   * Keep the growing graph in frame as the planner streams nodes in.
   *
   * Two things make this correct rather than approximately correct:
   *
   * `useNodesInitialized` — a node has no measured size until React Flow has
   * laid it out, and fitting before measurement computes bounds from zeroes and
   * lands the viewport in the wrong place. This gates on measurement rather
   * than on a timer that hopes measurement has happened.
   *
   * The debounce — nodes now arrive one at a time as the model generates them,
   * so re-fitting per node re-animates the viewport every few hundred
   * milliseconds and the canvas judders for the whole plan. The effect cancels
   * its own pending timer on each new node, so a burst of arrivals produces one
   * move, after the last of them.
   */
  const nodeCount = session.nodes.length;
  useEffect(() => {
    if (nodeCount === 0 || !nodesInitialized) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const handle = setTimeout(() => {
      void fitView({ padding: 0.22, maxZoom: 1, duration: reduced ? 0 : 260 });
    }, 220);
    return () => clearTimeout(handle);
  }, [fitView, nodeCount, nodesInitialized]);

  // And once more when the plan is finished, because the last arrival and the
  // final relayout the workflow emits are separate events.
  const planning = session.status === "planning";
  useEffect(() => {
    if (planning || nodeCount === 0 || !nodesInitialized) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const handle = setTimeout(() => {
      void fitView({ padding: 0.22, maxZoom: 1, duration: reduced ? 0 : 260 });
    }, 260);
    return () => clearTimeout(handle);
  }, [fitView, planning, nodeCount, nodesInitialized]);

  /* --- rewiring ------------------------------------------------------------ */

  /**
   * Drag an edge's endpoint onto a different node.
   *
   * Expressed as the two mutations it really is — the old wire goes, the new
   * one arrives — because the workflow's `disconnect`/`connect` signals are the
   * only vocabulary it has, and because an audit trail that records "this step
   * stopped reading from the extract and started reading from the raw PDF" as
   * two facts is more honest than one that records a mutation named "reconnect"
   * whose meaning has to be reconstructed.
   *
   * `reconnectEdge` is still used for the local projection so React Flow's own
   * edge bookkeeping stays consistent during the gesture.
   */
  const onReconnect = useCallback(
    (oldEdge: WfEdge, connection: Connection) => {
      const issue = connectionIssue(connection, rules);
      if (issue !== null) {
        setRefusal(issue);
        return;
      }
      // Keeps React Flow's in-flight edge state coherent; the authoritative
      // change is the two signals below.
      void reconnectEdge(oldEdge, connection, session.edges);
      session.mutate({ op: "disconnect", id: oldEdge.id });
      session.mutate({
        op: "connect",
        source: connection.source,
        target: connection.target,
      });
    },
    [rules, session],
  );

  const pendingNode =
    pendingDeleteId === null
      ? undefined
      : session.graph.nodes.find((node) => node.id === pendingDeleteId);

  // Looked up by id every render rather than held as an object, so the panel
  // shows live status, results and citations as events arrive — and closes by
  // itself if the node it is inspecting is deleted from anywhere.
  const inspectedNode =
    inspectedId === null
      ? undefined
      : session.graph.nodes.find((node) => node.id === inspectedId);

  useEffect(() => {
    if (inspectedId !== null && inspectedNode === undefined) setInspectedId(null);
  }, [inspectedId, inspectedNode]);

  const busy = session.status === "planning" || session.status === "running";

  return (
    <CanvasActionsProvider value={actions}>
      <div className="h-full w-full">
        <ReactFlow<WfNode, WfEdge>
          nodes={session.nodes}
          edges={session.edges}
          onNodesChange={session.onNodesChange}
          onEdgesChange={session.onEdgesChange}
          onConnect={session.onConnect}
          onBeforeDelete={onBeforeDelete}
          // Refuse an impossible wire during the drag rather than at Run.
          isValidConnection={isValidConnection}
          // …and say why, since a handle that just will not accept explains
          // nothing on its own.
          onConnectEnd={(_event, state) => {
            if (state.isValid === true) return;
            const from = state.fromNode?.id;
            const to = state.toNode?.id;
            if (from === undefined || to === undefined) return;
            explainRefusal({
              source: from,
              target: to,
              sourceHandle: null,
              targetHandle: null,
            });
          }}
          onReconnect={onReconnect}
          // A generous grab radius: an edge endpoint is a 1px path, and
          // rewiring is a routine gesture on this canvas rather than a rare one.
          reconnectRadius={16}
          // Signal the move ONCE, when the drag ends. React Flow emits a
          // position change per animation frame; one signal per frame would be
          // a Temporal write storm and an audit trail of a hundred identical
          // "node moved" entries for one gesture.
          onNodeDragStop={(_event, _node, nodes) => {
            for (const dragged of nodes) {
              session.mutate({
                op: "moveNode",
                id: dragged.id,
                position: dragged.position,
              });
            }
          }}
          // React Flow only binds Backspace by default; Delete is the key most
          // people actually press, and both are vetoed into the confirm modal.
          deleteKeyCode={DELETE_KEYS}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          connectionLineType={ConnectionLineType.Bezier}
          connectionLineStyle={CONNECTION_LINE_STYLE}
          snapToGrid
          snapGrid={SNAP_GRID}
          proOptions={{ hideAttribution: false }}
          attributionPosition="bottom-right"
          minZoom={0.25}
          maxZoom={1.6}
          fitView
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="rgba(0,0,0,0.13)"
            bgColor="#FFFFFF"
          />

          <Controls
            showInteractive={false}
            className="overflow-hidden rounded-node border border-line bg-surface shadow-node [&>button:hover]:bg-surface-2 [&>button:last-child]:border-b-0 [&>button]:h-7 [&>button]:w-7 [&>button]:border-b [&>button]:border-faint [&>button]:bg-surface [&>button]:text-fg [&_svg]:fill-fg"
          />

          {session.status === "planning" && <PlanningIndicator empty={nodeCount === 0} />}

          {refusal !== null && (
            <Panel position="bottom-center" className="!bottom-24">
              <span
                role="status"
                className="inline-flex max-w-[420px] items-center gap-1.5 rounded-full border border-fg bg-surface px-3 py-1 text-[10.5px] shadow-node shadow-[0_0_0_2px_#FFFFFF,0_0_0_3px_rgba(0,0,0,0.55)]"
              >
                <span aria-hidden="true" className="font-semibold">
                  !
                </span>
                {refusal}
              </span>
            </Panel>
          )}

          <Panel position="top-right" className="flex items-center gap-2">
            <TransportChip transport={session.transport} />

            {session.error && (
              <span
                role="status"
                className="max-w-[280px] truncate rounded-full border border-fg bg-surface px-2.5 py-1 text-[10px] shadow-node"
              >
                <span aria-hidden="true" className="mr-1 font-semibold">
                  !
                </span>
                {session.error}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                // Guard only when there is work to lose. An empty canvas has
                // nothing to confirm about, and a confirm on every click is
                // the fastest way to teach people to dismiss confirms.
                if (nodeCount === 0 || window.confirm(
                  "Start a new workflow? The current one will be closed.",
                )) {
                  session.reset();
                }
              }}
              disabled={busy}
              aria-label="New workflow"
              title="New workflow"
              className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface text-[13px] text-fg shadow-node hover:border-line-strong disabled:text-muted"
            >
              <span aria-hidden="true">+</span>
            </button>
            <button
              type="button"
              onClick={session.run}
              disabled={busy || nodeCount === 0}
              aria-label="Run graph"
              title="Run"
              className="grid h-9 w-9 place-items-center rounded-full bg-fg text-[12px] text-bg shadow-node disabled:bg-surface disabled:text-muted disabled:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.18)]"
            >
              <span aria-hidden="true">{busy ? "◌" : "▶"}</span>
            </button>
          </Panel>
        </ReactFlow>

        {inspectedNode && (
          <Inspector
            key={inspectedNode.id}
            node={inspectedNode}
            session={session}
            onClose={() => setInspectedId(null)}
            onDelete={(id) => setPendingDeleteId(id)}
          />
        )}

        {pendingNode && (
          <DeleteConfirm
            node={pendingNode}
            downstream={downstreamClosure(session.graph, pendingNode.id)}
            onCancel={() => setPendingDeleteId(null)}
            onConfirm={() => {
              session.mutate({ op: "removeNode", id: pendingNode.id });
              setPendingDeleteId(null);
            }}
          />
        )}
      </div>
    </CanvasActionsProvider>
  );
}

/**
 * What fills the gap between "I pressed send" and the first node.
 *
 * The planner is a reasoning model against a document; that gap is seconds, and
 * it used to be an unchanged canvas — indistinguishable from a prompt that
 * silently failed. Once nodes start streaming they say plainly enough that
 * something is happening, so the placeholder shrinks to a top-centre line
 * rather than sitting over the graph it is describing.
 *
 * A dashed ghost frame, deliberately: dashed is the "not real yet" stroke in
 * this language, and it cannot be mistaken for the solid `done` or the
 * double-stroked `error` treatment.
 */
function PlanningIndicator({ empty }: { empty: boolean }) {
  if (!empty) {
    return (
      <Panel position="top-center">
        <span
          role="status"
          className="rounded-full border border-line bg-surface px-2.5 py-1 text-[10px] uppercase tracking-[0.09em] text-muted shadow-node"
        >
          <span aria-hidden="true" className="wf-pulse mr-1.5 inline-block">
            ◌
          </span>
          planning — steps appear as they are decided
        </span>
      </Panel>
    );
  }

  return (
    <Panel position="top-center" className="!left-1/2 !top-1/2 -translate-x-1/2 -translate-y-1/2">
      <div
        role="status"
        className="w-[248px] rounded-node border border-dashed border-line bg-surface px-3 py-3 text-center shadow-node"
      >
        <p className="wf-pulse text-[15px] leading-none" aria-hidden="true">
          ◌
        </p>
        <p className="mt-2 text-[10px] uppercase tracking-[0.09em] text-muted">
          planning
        </p>
        <p className="mt-1 text-[10.5px] leading-[1.5] text-muted">
          Reading your request and assembling the pipeline. Steps appear here one
          at a time as the planner decides them.
        </p>
      </div>
    </Panel>
  );
}

/**
 * Whether the canvas is actually hearing from the workflow.
 *
 * A disconnected stream used to be indistinguishable from a quiet one: the
 * canvas simply stopped changing. With Temporal or the worker down, every
 * signal is still accepted (Temporal queues them) and nothing executes, so the
 * only honest signal to the user is this. Rendered only when something is
 * wrong — a permanently-lit "connected" badge is noise, and the whole point of
 * the indicator is that its appearance means something.
 *
 * Monochrome, per PRD §3.1: the state is carried by the word and by the stroke
 * (single while retrying, doubled once the stream has ended for good), never by
 * a colour.
 */
function TransportChip({ transport }: { transport: SessionApi["transport"] }) {
  if (transport.state === "live") return null;

  const terminal = transport.state === "ended" || transport.state === "stalled";
  const word =
    transport.state === "connecting"
      ? "connecting"
      : transport.state === "retrying"
        ? "reconnecting"
        : transport.state === "stalled"
          ? "not updating"
          : "disconnected";

  return (
    <span
      role="status"
      title={transport.detail ?? word}
      className={`max-w-[320px] truncate rounded-full bg-surface px-2.5 py-1 text-[10px] shadow-node ${
        terminal
          ? "border border-fg shadow-[0_0_0_2px_#FFFFFF,0_0_0_3px_rgba(0,0,0,0.55)]"
          : "border border-line"
      }`}
    >
      <span aria-hidden="true" className="mr-1 font-semibold">
        {terminal ? "!" : "◌"}
      </span>
      {word}
      {transport.detail !== undefined && (
        <span className="text-muted"> — {transport.detail}</span>
      )}
    </span>
  );
}
