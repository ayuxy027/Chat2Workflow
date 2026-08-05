"use client";

/**
 * `output` — glyph ◼, target handle left (PRD §3.4).
 * Body: the artifact list, each one downloadable from the content-addressed
 * store by hash.
 *
 * Where a run's model-generated text lands, so it carries the same provenance
 * furniture as a chat node: citations inline, an unsourced marker when there are
 * none, and the draft disclaimer (PRD §3.6).
 */

import { memo } from "react";
import { Position, type NodeProps } from "@xyflow/react";
import type { WfNode } from "@/lib/graph-adapter";
import { CaveatChips } from "@/components/caveats";
import { Citations, DraftNotice } from "@/components/citations";
import { Meta, NodeHandle, NodeShell, UpstreamSummary, formatBytes } from "./node-shell";

export const OutputNode = memo(function OutputNode({
  id,
  data,
  selected,
}: NodeProps<WfNode>) {
  const hasResult = data.result !== undefined && data.result.length > 0;

  return (
    <NodeShell
      id={id}
      kind="output"
      label={data.label}
      status={data.status}
      selected={selected === true}
      error={data.error}
      resizable
    >
      {data.outputs.length === 0 && <UpstreamSummary id={id} />}

      {data.outputs.length > 0 ? (
        <ul className="space-y-0.5">
          {data.outputs.map((output) => (
            <li key={output.sha256} className="flex items-baseline gap-2">
              <a
                href={`/api/blobs/${output.sha256}`}
                download={output.filename}
                onPointerDown={(event) => event.stopPropagation()}
                className="nodrag min-w-0 flex-1 truncate font-mono text-[11px] underline decoration-line underline-offset-2 hover:decoration-fg"
              >
                {output.filename}
              </a>
              <span className="shrink-0 text-[10px] text-muted">
                {formatBytes(output.bytes)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Meta>no artifacts yet</Meta>
      )}

      {hasResult && (
        <div className="mt-2 border-t border-faint pt-1.5">
          <p className="line-clamp-4 text-[10px] leading-[1.5]">{data.result}</p>
        </div>
      )}

      {(hasResult || data.citations.length > 0) && (
        <>
          <Citations citations={data.citations} />
          <CaveatChips node={data} />
          <DraftNotice />
        </>
      )}

      <NodeHandle type="target" position={Position.Left} />
    </NodeShell>
  );
});
