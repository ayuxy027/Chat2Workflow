"use client";

/**
 * `tool` — glyph ⚙, target handle left + source handle right (PRD §3.4).
 * Body: tool id and params.
 *
 * Params are shown read-only for now. The real form is generated from the
 * `ParamSpec[]` on the tool's `ToolManifest` (`@wf/shared`, PRD §5.3) — one
 * definition drives both the worker's execution and this node's controls, so
 * there is nothing to register on the frontend when a tool is added. Wiring
 * that up needs the registry endpoint the API agent owns.
 */

import { memo } from "react";
import { Position, type NodeProps } from "@xyflow/react";
import type { WfNode } from "@/lib/graph-adapter";
import { CaveatChips } from "@/components/caveats";
import { Meta, NodeHandle, NodeShell, UpstreamSummary, formatBytes } from "./node-shell";

export const ToolNode = memo(function ToolNode({
  id,
  data,
  selected,
}: NodeProps<WfNode>) {
  const params = Object.entries(data.params);

  return (
    <NodeShell
      id={id}
      kind="tool"
      label={data.label}
      status={data.status}
      selected={selected === true}
      error={data.error}
    >
      <p className="truncate font-mono text-[11px]">{data.toolId ?? "unassigned"}</p>

      <UpstreamSummary id={id} />

      {params.length > 0 ? (
        <dl className="mt-1 space-y-px">
          {params.map(([key, value]) => (
            <div key={key} className="flex gap-2 text-[10px]">
              <dt className="shrink-0 text-muted">{key}</dt>
              <dd className="min-w-0 flex-1 truncate text-right font-mono">
                {formatParam(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <Meta>no parameters</Meta>
      )}

      {data.result !== undefined && data.result.length > 0 && (
        <p className="mt-1.5 border-t border-faint pt-1.5 text-[10px] text-muted">
          {data.result}
        </p>
      )}

      {data.outputs.length > 0 && (
        <ul className="mt-1.5 space-y-px">
          {data.outputs.map((output) => (
            <li key={output.sha256} className="truncate text-[10px] text-muted">
              <span className="font-mono text-fg">{output.filename}</span>{" "}
              {formatBytes(output.bytes)}
            </li>
          ))}
        </ul>
      )}

      <CaveatChips node={data} />

      <NodeHandle type="target" position={Position.Left} />
      <NodeHandle type="source" position={Position.Right} />
    </NodeShell>
  );
});

function formatParam(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}
