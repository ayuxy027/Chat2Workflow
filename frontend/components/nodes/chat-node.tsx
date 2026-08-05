"use client";

/**
 * `chat` — glyph ◐, target handle left + source handle right (PRD §3.4).
 * Body: the prompt (editable), the result, and its page citations.
 *
 * This is the one node kind that sends content to the model, so it is also the
 * one that carries the provenance obligations: citations render inline, an
 * uncited result is marked unsourced, and the draft disclaimer is always
 * present when there is output (PRD §3.6).
 */

import { memo, useEffect, useState } from "react";
import { Position, type NodeProps } from "@xyflow/react";
import type { WfNode } from "@/lib/graph-adapter";
import { useCanvasActions } from "@/components/canvas-context";
import { CaveatChips } from "@/components/caveats";
import { Citations, DraftNotice } from "@/components/citations";
import { Meta, NodeHandle, NodeShell, UpstreamSummary } from "./node-shell";

export const ChatNode = memo(function ChatNode({
  id,
  data,
  selected,
}: NodeProps<WfNode>) {
  const { updateNode } = useCanvasActions();
  const [draft, setDraft] = useState(data.prompt ?? "");

  // The authoritative prompt can change under us (planner rewrite, reconnect
  // replay). Adopt it unless the field is being edited right now.
  useEffect(() => {
    setDraft(data.prompt ?? "");
  }, [data.prompt]);

  const commit = () => {
    const next = draft.trim();
    if (next !== (data.prompt ?? "")) updateNode(id, { prompt: next });
  };

  return (
    <NodeShell
      id={id}
      kind="chat"
      label={data.label}
      status={data.status}
      selected={selected === true}
      error={data.error}
      resizable
    >
      <UpstreamSummary id={id} />

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onPointerDown={(event) => event.stopPropagation()}
        rows={3}
        spellCheck={false}
        placeholder="what should this step ask the model?"
        aria-label="Prompt"
        className="nodrag nowheel w-full resize-none rounded-[4px] border border-faint bg-surface px-1.5 py-1 text-[11px] leading-[1.4] text-fg placeholder:text-muted focus:border-line-strong focus:outline-none"
      />

      {data.result !== undefined && data.result.length > 0 && (
        <div className="mt-2 border-t border-faint pt-1.5">
          <p className="line-clamp-4 text-[10px] leading-[1.5] text-fg">
            {data.result}
          </p>
          <Citations citations={data.citations} />
          {/* Truncation and unverified counts, before the disclaimer — a partial
              answer is a different claim, not a footnote to the same one. */}
          <CaveatChips node={data} />
          <DraftNotice />
        </div>
      )}

      {data.result === undefined && data.citations.length === 0 && (
        <Meta>sends to the model · citations verified on return</Meta>
      )}

      <NodeHandle type="target" position={Position.Left} />
      <NodeHandle type="source" position={Position.Right} />
    </NodeShell>
  );
});
