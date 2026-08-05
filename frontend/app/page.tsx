"use client";

/**
 * Rail | canvas, with the chat bar floating over the canvas and the panels
 * sliding in from the left edge (PRD §3.3).
 *
 * This component owns nothing but which rail tab is open. Session state lives in
 * `useSession`, and the domain ↔ React Flow mapping lives in `graph-adapter` —
 * so the day the SSE stream replaces the mock driver, this file does not change.
 */

import { useState } from "react";
import type { NodeKind } from "@wf/shared";
import { nextFreePosition } from "@/lib/graph-adapter";
import { useSession } from "@/lib/use-session";
import { BuildPanel } from "@/components/build-panel";
import { Canvas } from "@/components/canvas";
import { ChatBar } from "@/components/chat-bar";
import { ChatPanel } from "@/components/chat-panel";
import { Rail, type RailTab } from "@/components/rail";

export default function Home() {
  const session = useSession();
  const [tab, setTab] = useState<RailTab | null>(null);

  const addNode = (kind: NodeKind) => {
    session.mutate({
      op: "addNode",
      kind,
      position: nextFreePosition(session.graph),
    });
  };

  return (
    <main className="flex h-dvh w-full overflow-hidden bg-bg text-fg">
      <Rail
        active={tab}
        onSelect={(next) => setTab((current) => (current === next ? null : next))}
      />

      <div className="relative min-w-0 flex-1 overflow-hidden">
        <Canvas session={session} />

        <ChatPanel
          open={tab === "chat"}
          chat={session.chat}
          status={session.status}
          onClose={() => setTab(null)}
        />
        <BuildPanel open={tab === "build"} onAdd={addNode} onClose={() => setTab(null)} />

        <ChatBar onSubmit={session.sendPrompt} status={session.status} />
      </div>
    </main>
  );
}
