"use client";

/**
 * `input` — glyph ▷, source handle right (PRD §3.4).
 * Body: a text field. Free text that feeds downstream steps — a matter
 * reference, a counterparty name, a clause number to look for.
 *
 * The value lives in `params.text`, so it travels to the workflow through the
 * ordinary `updateNode` mutation with no special-casing anywhere.
 */

import { memo, useEffect, useState } from "react";
import { Position, type NodeProps } from "@xyflow/react";
import { nodeInputText } from "@wf/shared";
import type { WfNode } from "@/lib/graph-adapter";
import { useCanvasActions } from "@/components/canvas-context";
import { NodeHandle, NodeShell } from "./node-shell";

export const InputNode = memo(function InputNode({
  id,
  data,
  selected,
}: NodeProps<WfNode>) {
  const { updateNode } = useCanvasActions();

  /*
   * `nodeInputText` from `@wf/shared`, never a local reader.
   *
   * There were three plausible homes for this string — `value`, `params.text`,
   * `prompt` — and the canvas and the workflow independently picked different
   * ones. The node accepted typing, looked entirely correct, and its contents
   * never reached the model: no error on either side, because neither side was
   * wrong on its own. One accessor, imported by both, is the only thing that
   * makes that failure impossible rather than merely fixed.
   */
  const authoritative = nodeInputText(data);
  const [draft, setDraft] = useState(authoritative);

  useEffect(() => {
    setDraft(authoritative);
  }, [authoritative]);

  const commit = () => {
    if (draft !== authoritative) {
      updateNode(id, { params: { ...data.params, text: draft } });
    }
  };

  return (
    <NodeShell
      id={id}
      kind="input"
      label={data.label}
      status={data.status}
      selected={selected === true}
      error={data.error}
    >
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        spellCheck={false}
        placeholder="value…"
        aria-label={data.label}
        className="nodrag w-full rounded-[4px] border border-faint bg-surface px-1.5 py-1 text-[11px] text-fg placeholder:text-muted focus:border-line-strong focus:outline-none"
      />

      <NodeHandle type="source" position={Position.Right} />
    </NodeShell>
  );
});
