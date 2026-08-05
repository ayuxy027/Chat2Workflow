"use client";

/**
 * The Build tab's panel: add a node kind by hand when the planner got it wrong.
 *
 * PRD §10.3 leaves the build affordance open (palette on right-click vs. drag
 * from the rail). This is the smallest thing that makes the second rail button
 * real: a list, one click, node lands below the stack. Swapping it for a
 * drag source later touches only this file — everything goes out as the same
 * `addNode` mutation.
 */

import type { NodeKind } from "@wf/shared";
import { KIND_GLYPH, KIND_NAME, NODE_KINDS } from "@/lib/graph-adapter";

const BLURB: Record<NodeKind, string> = {
  document: "a file from the blob store",
  chat: "a model step — escalation, cited",
  tool: "a deterministic file operation",
  input: "free text for downstream steps",
  output: "collects artifacts",
};

export function BuildPanel({
  open,
  onAdd,
  onClose,
}: {
  open: boolean;
  onAdd(kind: NodeKind): void;
  onClose(): void;
}) {
  return (
    <aside
      aria-label="Build"
      aria-hidden={!open}
      // See the note in chat-panel: off-screen is not out of the tab order.
      inert={!open}
      className={`absolute inset-y-0 left-0 z-20 flex w-[320px] max-w-[80vw] flex-col border-r border-line bg-surface shadow-float transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-faint bg-surface-2 px-4 py-2.5">
        <h2 className="flex-1 text-[10px] font-medium uppercase tracking-[0.09em]">
          Build
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close build panel"
          className="rounded-full px-1 text-[11px] text-muted hover:text-fg"
        >
          ✕
        </button>
      </header>

      <ul className="flex-1 overflow-y-auto p-3">
        {NODE_KINDS.map((kind) => (
          <li key={kind}>
            <button
              type="button"
              onClick={() => onAdd(kind)}
              disabled={!open}
              className="flex w-full items-center gap-3 rounded-node border border-transparent px-2 py-2 text-left hover:border-line hover:bg-surface-2"
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line text-[13px]"
              >
                {KIND_GLYPH[kind]}
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-medium">
                  {KIND_NAME[kind]}
                </span>
                <span className="block truncate text-[10px] text-muted">
                  {BLURB[kind]}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
