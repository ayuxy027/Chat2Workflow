"use client";

/**
 * Destructive confirmation — PRD §3.4, and the answer to open question §10.5.
 *
 * The temptation with a delete dialog is to reach for red. We don't: the weight
 * that colour normally carries is carried here by a double stroke (the same
 * encoding an errored node uses), by naming every downstream node that dies with
 * this one, and by making the user type the word. Nothing about that is softer
 * than red — it is more specific.
 *
 * The naming matters most. "Delete this node?" is a question about the canvas.
 * "This also deletes Summarise indemnity, which holds 2 verified citations" is a
 * question about the work.
 */

import { useEffect, useRef, useState } from "react";
import type { GraphNode } from "@wf/shared";
import { KIND_GLYPH, KIND_NAME } from "@/lib/graph-adapter";

const PHRASE = "DELETE";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DeleteConfirmProps {
  node: GraphNode;
  /** Everything reachable downstream. Computed from edges by the caller. */
  downstream: GraphNode[];
  onCancel(): void;
  onConfirm(): void;
}

export function DeleteConfirm({
  node,
  downstream,
  onCancel,
  onConfirm,
}: DeleteConfirmProps) {
  const [typed, setTyped] = useState("");
  const armed = typed.trim().toUpperCase() === PHRASE;
  const dialogRef = useRef<HTMLDivElement>(null);

  /**
   * Captured during the FIRST RENDER, not in the effect.
   *
   * `autoFocus` on the confirm field runs during commit, which is before
   * effects — so reading `document.activeElement` from the effect returns this
   * dialog's own input and "restore focus" restores it to a node that is about
   * to be unmounted. A lazy `useState` initialiser runs while the opener is
   * still the focused element.
   */
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );

  /**
   * Escape closes, and Tab cannot leave.
   *
   * `aria-modal` is an announcement, not an enforcement: without a real trap,
   * Tab walks straight out of a type-to-confirm dialog and onto the canvas
   * behind it, where Backspace deletes a *different* node. A keyboard user is
   * exactly the person this confirmation is protecting. Focus is also returned
   * to whatever raised the dialog, so dismissing it does not dump the user back
   * at the top of the document.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;

      const root = dialogRef.current;
      if (!root) return;
      const stops = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (stops.length === 0) return;

      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;

      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // After the paint that removed the dialog, and only if the control that
      // opened it is still on the page — the node it belonged to may be the one
      // that was just deleted. Returning focus to nothing drops the caret at
      // the top of the document, which is where a keyboard user least expects
      // to be after dismissing a dialog.
      requestAnimationFrame(() => {
        if (opener !== null && opener.isConnected) opener.focus();
      });
    };
  }, [onCancel, opener]);

  const artifacts = downstream.reduce((sum, n) => sum + n.outputs.length, 0);
  const citations = downstream.reduce((sum, n) => sum + n.citations.length, 0);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.28)] p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="relative">
        {/* the second stroke */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[4px] rounded-[12px] border border-fg"
        />

        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-title"
          aria-describedby="delete-consequences"
          className="relative w-[440px] max-w-[calc(100vw-3rem)] rounded-node border-2 border-fg bg-surface shadow-float"
        >
          <header className="flex items-center gap-2 rounded-t-[6px] border-b border-faint bg-surface-2 px-4 py-2.5">
            <span aria-hidden="true" className="text-[13px] font-semibold">
              !
            </span>
            <h2
              id="delete-title"
              className="text-[11px] font-medium uppercase tracking-[0.09em]"
            >
              Delete node
            </h2>
          </header>

          <div className="px-4 py-3.5 text-[12px] leading-[1.55]">
            <p id="delete-consequences">
              Deleting{" "}
              <span className="font-medium">
                {KIND_GLYPH[node.kind]} {node.label}
              </span>{" "}
              <span className="text-muted">({KIND_NAME[node.kind].toLowerCase()})</span>
              {downstream.length === 0
                ? " removes it and its connections. Nothing downstream depends on it."
                : " removes it and its connections. These steps read from it and will be left without an input:"}
            </p>

            {downstream.length > 0 && (
              <>
                <ul className="mt-2.5 max-h-40 overflow-y-auto rounded-[4px] border border-faint">
                  {downstream.map((affected) => (
                    <li
                      key={affected.id}
                      className="flex items-baseline gap-2 border-b border-faint px-2.5 py-1.5 text-[11px] last:border-b-0"
                    >
                      <span aria-hidden="true" className="shrink-0">
                        {KIND_GLYPH[affected.kind]}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {affected.label}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted">
                        {KIND_NAME[affected.kind].toLowerCase()}
                      </span>
                    </li>
                  ))}
                </ul>

                {(artifacts > 0 || citations > 0) && (
                  <p className="mt-2 text-[11px] text-muted">
                    They already hold{" "}
                    {artifacts > 0 &&
                      `${artifacts} artifact${artifacts === 1 ? "" : "s"}`}
                    {artifacts > 0 && citations > 0 && " and "}
                    {citations > 0 &&
                      `${citations} citation${citations === 1 ? "" : "s"}`}
                    {" derived from this step, which this canvas will no longer be able to reproduce."}
                  </p>
                )}
              </>
            )}

            <label className="mt-3.5 block text-[11px] text-muted" htmlFor="delete-phrase">
              Type <span className="font-mono font-medium text-fg">{PHRASE}</span> to
              confirm
            </label>
            <input
              id="delete-phrase"
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && armed) onConfirm();
              }}
              spellCheck={false}
              autoComplete="off"
              className="mt-1 w-full rounded-[4px] border border-line bg-surface px-2 py-1.5 font-mono text-[12px] tracking-[0.12em] focus:border-line-strong focus:outline-none"
            />
          </div>

          <footer className="flex justify-end gap-2 border-t border-faint px-4 py-2.5">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-line px-3 py-1 text-[11px] hover:border-line-strong"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!armed}
              onClick={onConfirm}
              className="rounded-full border border-fg bg-fg px-3 py-1 text-[11px] text-bg disabled:border-line disabled:bg-transparent disabled:text-muted"
            >
              Delete
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
