"use client";

/**
 * The chat transcript, slid in from behind the rail when the Chat tab is active.
 *
 * It renders the `chat` events out of the same log that builds the graph, so the
 * conversation and the canvas can never disagree about what was asked. PRD §10.4
 * leaves open whether this belongs as canvas annotations instead — it is a panel
 * for now because a panel is trivially reversible.
 */

import { useEffect, useRef } from "react";
import type { ChatMessage, SessionStatus } from "@/lib/use-session";

const ROLE_LABEL: Record<ChatMessage["role"], string> = {
  user: "you",
  assistant: "planner",
  system: "system",
};

export function ChatPanel({
  open,
  chat,
  status,
  onClose,
}: {
  open: boolean;
  chat: ChatMessage[];
  status: SessionStatus;
  onClose(): void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [open, chat.length]);

  return (
    <aside
      aria-label="Chat"
      aria-hidden={!open}
      // The panel stays mounted and merely slides off-screen, so `aria-hidden`
      // alone leaves its close button in the tab order — focus lands on an
      // element screen readers have been told does not exist. `inert` removes
      // it from both at once.
      inert={!open}
      className={`absolute inset-y-0 left-0 z-20 flex w-[320px] max-w-[80vw] flex-col border-r border-line bg-surface shadow-float transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-faint bg-surface-2 px-4 py-2.5">
        <h2 className="flex-1 text-[10px] font-medium uppercase tracking-[0.09em]">
          Chat
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="rounded-full px-1 text-[11px] text-muted hover:text-fg"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {chat.length === 0 ? (
          <p className="text-[11px] leading-[1.6] text-muted">
            Nothing yet. Describe what you need in the bar below — the planner
            assembles a graph, and every step it plans shows up on the canvas
            rather than in here.
          </p>
        ) : (
          <ol className="space-y-3">
            {chat.map((message) => (
              <li key={message.seq}>
                <p className="mb-0.5 text-[9px] uppercase tracking-[0.09em] text-muted">
                  {ROLE_LABEL[message.role]}
                </p>
                <p
                  className={`whitespace-pre-wrap text-[11.5px] leading-[1.55] ${
                    message.role === "user"
                      ? "rounded-[6px] border border-faint bg-surface-2 px-2 py-1.5"
                      : "border-l border-line pl-2.5"
                  }`}
                >
                  {message.text}
                </p>
              </li>
            ))}
          </ol>
        )}

        {(status === "planning" || status === "running") && (
          <p className="mt-3 text-[10px] uppercase tracking-[0.09em] text-muted">
            {status === "planning" ? "planning…" : "running…"}
          </p>
        )}

        <div ref={endRef} />
      </div>

      <footer className="border-t border-faint px-4 py-2">
        <p className="text-[9px] leading-[1.5] text-muted">
          AI-generated draft — verify against source before relying on it.
        </p>
      </footer>
    </aside>
  );
}
