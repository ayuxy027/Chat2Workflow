"use client";

/**
 * The chat bar — PRD §3.3.
 *
 * Floating pill, bottom-centre, max 640px, `surface` fill, 1px `line` that
 * rises to `line-strong` on focus, `shadow-float`. This is the fastest way to
 * author the graph; it is not the artifact (§1.2), which is why it floats over
 * the canvas rather than owning a column.
 */

import { useState } from "react";
import type { SessionStatus } from "@/lib/use-session";

const HINT: Record<SessionStatus, string> = {
  idle: "",
  planning: "planning…",
  running: "running…",
  error: "last step failed — see the chat panel",
};

export function ChatBar({
  onSubmit,
  status,
}: {
  onSubmit(text: string): void;
  status: SessionStatus;
}) {
  const [text, setText] = useState("");
  const busy = status === "planning" || status === "running";
  const hint = HINT[status];

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-[640px]">
        {hint && (
          <p className="mb-1.5 text-center text-[10px] uppercase tracking-[0.09em] text-muted">
            {hint}
          </p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = text.trim();
            if (value.length === 0 || busy) return;
            onSubmit(value);
            setText("");
          }}
          className="flex items-center gap-2 rounded-full border border-line bg-surface py-2 pl-5 pr-2 shadow-float focus-within:border-line-strong"
        >
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="describe a workflow…"
            aria-label="Describe a workflow"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-muted focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={busy || text.trim().length === 0}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-fg text-[11px] text-bg transition-opacity disabled:bg-transparent disabled:text-muted disabled:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.18)]"
          >
            <span aria-hidden="true">➤</span>
          </button>
        </form>
      </div>
    </div>
  );
}
