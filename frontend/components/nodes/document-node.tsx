"use client";

/**
 * `document` — glyph ▤, source handle right (PRD §3.4).
 * Body: filename, page count, size.
 *
 * The bytes never enter the graph. Attaching a file hashes it and stores a
 * `BlobRef`; the hash is the node's link to the content-addressed store, which
 * is what keeps a six-month-old workflow history pointing at the exact document
 * that was processed.
 */

import { memo, useRef } from "react";
import { Position, type NodeProps } from "@xyflow/react";
import type { WfNode } from "@/lib/graph-adapter";
import { useCanvasActions } from "@/components/canvas-context";
import { Meta, NodeHandle, NodeShell, TOOLBAR_BUTTON, formatBytes } from "./node-shell";

export const DocumentNode = memo(function DocumentNode({
  id,
  data,
  selected,
}: NodeProps<WfNode>) {
  const { attachDocument } = useCanvasActions();
  const blob = data.blob;
  const picker = useRef<HTMLInputElement>(null);

  return (
    <NodeShell
      id={id}
      kind="document"
      label={data.label}
      status={data.status}
      selected={selected === true}
      error={data.error}
      toolbar={
        <>
          <button
            type="button"
            className={TOOLBAR_BUTTON}
            onClick={() => picker.current?.click()}
          >
            {blob === undefined ? "Attach" : "Replace"}
          </button>
          {/*
            The real file input lives on the node rather than in the toolbar:
            NodeToolbar renders into a portal, and a click on a `<label>` there
            would not reach an input mounted here. Driving it by ref keeps one
            input and one code path for both affordances.
          */}
          <input
            ref={picker}
            type="file"
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) attachDocument(id, file);
              event.target.value = "";
            }}
          />
        </>
      }
    >
      {blob ? (
        <>
          <p className="truncate font-mono text-[11px]">{blob.filename}</p>
          <Meta>
            {blob.pages !== undefined ? `${blob.pages} pages · ` : ""}
            {formatBytes(blob.bytes)}
          </Meta>
          <Meta>
            <span className="font-mono">{blob.sha256.slice(0, 12)}</span>
          </Meta>
        </>
      ) : (
        <label className="nodrag inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[10px] hover:border-line-strong">
          <span aria-hidden="true">＋</span>
          attach document
          <input
            type="file"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) attachDocument(id, file);
              event.target.value = "";
            }}
          />
        </label>
      )}

      <NodeHandle type="source" position={Position.Right} />
    </NodeShell>
  );
});
