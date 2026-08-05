"use client";

/**
 * The frame every node kind shares: rounded rect, header strip, glyph, and the
 * status treatment.
 *
 * Status is encoded by BORDER WEIGHT, STROKE COUNT, and MOTION — never colour
 * (PRD §3.4):
 *
 *   idle     1px line
 *   queued   1px line, glyph at 45%
 *   running  2px border + a dark dash marching around the perimeter
 *   done     2px solid fg
 *   error    2px fg + an offset 1px outer ring (double stroke), glyph → `!`
 *
 * The marching dash is an SVG overlay because `.wf-marching` in globals.css
 * animates `stroke-dashoffset`, which only exists on SVG geometry. A CSS border
 * cannot march.
 */

import { memo, type ReactNode } from "react";
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  useNodeConnections,
  useNodesData,
  type HandleType,
} from "@xyflow/react";
import type { NodeKind, NodeStatus } from "@wf/shared";
import { KIND_GLYPH, KIND_NAME, type WfNode } from "@/lib/graph-adapter";
import { useCanvasActions } from "@/components/canvas-context";

const STATUS_WORD: Record<NodeStatus, string> = {
  idle: "",
  queued: "queued",
  running: "running",
  done: "done",
  error: "error",
};

function frameClass(status: NodeStatus, selected: boolean): string {
  switch (status) {
    case "running":
      return "border-2 border-line";
    case "done":
      return "border-2 border-fg";
    case "error":
      return "border-2 border-fg";
    default:
      return selected ? "border border-line-strong" : "border border-line";
  }
}

export interface NodeShellProps {
  id: string;
  kind: NodeKind;
  label: string;
  status: NodeStatus;
  selected: boolean;
  error?: string;
  /** Extra actions for the selection toolbar, before the shared ones. */
  toolbar?: ReactNode;
  /** Resizable kinds: a long prompt or a long answer needs the room. */
  resizable?: boolean;
  children: ReactNode;
}

/** Toolbar button. Monochrome pill, same family as the rail and the run control. */
export const TOOLBAR_BUTTON =
  "rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] leading-[1.6] text-fg shadow-node hover:border-line-strong";

export const NodeShell = memo(function NodeShell({
  id,
  kind,
  label,
  status,
  selected,
  error,
  toolbar,
  resizable,
  children,
}: NodeShellProps) {
  const { requestDelete, inspect } = useCanvasActions();
  const word = STATUS_WORD[status];

  return (
    <div
      role="group"
      aria-label={`${KIND_NAME[kind]}: ${label}${word ? `, ${word}` : ""}`}
      // `wf-arrive` plays once on mount. Because the planner streams nodes as
      // it generates them, mount IS arrival — there is nothing to coordinate.
      // `h-full` so a resized wrapper actually resizes the card inside it.
      className={`group wf-arrive relative h-full min-w-[200px] rounded-node bg-surface text-fg shadow-node ${frameClass(
        status,
        selected,
      )}`}
    >
      {resizable === true && (
        // React Flow's own resizer: correct through zoom and pan, and it emits
        // the dimension changes the store needs. Hand-rolling a drag handle
        // here would get both wrong. Monochrome, and only while selected.
        <NodeResizer
          isVisible={selected}
          minWidth={220}
          minHeight={120}
          lineClassName="!border-line-strong"
          handleClassName="!h-2 !w-2 !rounded-full !border !border-fg !bg-bg"
        />
      )}

      {/*
        Quick actions, anchored to the node and held at a constant size through
        zoom — which is exactly why this is `NodeToolbar` and not a positioned
        div. Visible on selection, so it is reachable by keyboard: React Flow
        makes nodes focusable and selectable, and the toolbar's buttons then
        enter the tab order.
      */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
        <div className="flex items-center gap-1">
          {toolbar}
          <button type="button" className={TOOLBAR_BUTTON} onClick={() => inspect(id)}>
            Edit
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON}
            onClick={() => requestDelete(id)}
          >
            Delete
          </button>
        </div>
      </NodeToolbar>
      {/* error: the second, offset stroke */}
      {status === "error" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[3px] rounded-[11px] border border-fg"
        />
      )}

      {/* running: a dash marches the perimeter */}
      {status === "running" && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-visible"
          width="100%"
          height="100%"
        >
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            rx="8"
            ry="8"
            fill="none"
            stroke="#0A0A0A"
            strokeWidth="2"
            strokeDasharray="8 8"
            className="wf-marching"
          />
        </svg>
      )}

      <header className="flex items-center gap-2 rounded-t-[7px] border-b border-faint bg-surface-2 px-2.5 py-1.5">
        <span
          aria-hidden="true"
          className={`text-[12px] leading-none ${
            status === "queued" ? "opacity-45" : ""
          }`}
        >
          {status === "error" ? "!" : KIND_GLYPH[kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-[0.09em]">
          {label}
        </span>
        {word && (
          <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-muted">
            {word}
          </span>
        )}
        {/*
          A keyboard route to the inspector. Clicking the node body opens it via
          React Flow's `onNodeClick`, but a pointer event is not a tab stop —
          without this, every editable field on a node (tool parameters, the
          task prompt, the document picker) would be reachable by mouse only.
        */}
        <button
          type="button"
          aria-label={`Edit ${label}`}
          title="Edit this step"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => inspect(id)}
          className="nodrag shrink-0 rounded-full px-1 text-[11px] leading-none text-muted opacity-0 transition-opacity hover:text-fg focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
        >
          ⋯
        </button>
        {/*
          Delete lives in the selection toolbar, not here. Two delete controls
          on one node is one too many, and the toolbar is the one that scales —
          it holds the per-kind actions too. Keyboard users still reach it: a
          node is focusable and selectable, and selecting reveals the toolbar.
        */}
      </header>

      <div className="px-2.5 py-2 text-[11px] leading-[1.45]">
        {children}
        {error && (
          <p className="mt-1.5 border-t border-faint pt-1.5 text-[10px] text-fg">
            <span aria-hidden="true" className="mr-1 font-semibold">
              !
            </span>
            {error}
          </p>
        )}
      </div>
    </div>
  );
});

/** Circular handle — part of the motif shared with the rail buttons (PRD §3.5). */
export function NodeHandle({
  type,
  position,
}: {
  type: HandleType;
  position: Position.Left | Position.Right;
}) {
  return <Handle type={type} position={position} className="border-solid border-fg" />;
}

/** A dim key / value line. Used by every kind's body for secondary detail. */
export function Meta({ children }: { children: ReactNode }) {
  return <p className="truncate text-[10px] text-muted">{children}</p>;
}

/**
 * What is actually going to arrive at this node, read from its upstream
 * neighbours.
 *
 * `useNodeConnections` + `useNodesData` subscribe to just those neighbours, so
 * this re-renders when an upstream document is attached and at no other time —
 * where walking the graph by hand would recompute on every event for every
 * node. The value is in what it prevents: a chat step with nothing wired in
 * fails at Run with "this node has no document input", and that is a long way
 * to travel to learn something the canvas could have said up front.
 */
export function UpstreamSummary({ id }: { id: string }) {
  const connections = useNodeConnections({ id, handleType: "target" });
  const upstream = useNodesData<WfNode>(connections.map((c) => c.source));

  if (connections.length === 0) {
    return (
      <p className="mt-1.5 text-[10px] text-fg">
        <span aria-hidden="true" className="mr-1 font-semibold">
          !
        </span>
        nothing connected — this step has no input to work on
      </p>
    );
  }

  const parts = upstream.map((node) => {
    const data = node?.data;
    if (data === undefined) return "a step";
    if (data.blob !== undefined) {
      return data.blob.pages !== undefined
        ? `${data.blob.filename} (${data.blob.pages}p)`
        : data.blob.filename;
    }
    if (data.outputs.length > 0) {
      return data.outputs.map((output) => output.filename).join(", ");
    }
    return `${data.label} — not run yet`;
  });

  return <Meta>in: {parts.join(" · ")}</Meta>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
