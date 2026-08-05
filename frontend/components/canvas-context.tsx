"use client";

/**
 * The narrow set of actions a node is allowed to take.
 *
 * Nodes get this through context rather than through `data` so that a node's
 * props stay a pure projection of the domain object. A node never touches the
 * session hook, and it never calls `mutate` with an arbitrary op — deletion in
 * particular has to route through confirmation (PRD §3.4).
 */

import { createContext, useContext } from "react";

export interface NodePatch {
  label?: string;
  prompt?: string;
  params?: Record<string, unknown>;
}

export interface CanvasActions {
  updateNode(id: string, patch: NodePatch): void;
  /** Opens the destructive-confirmation modal. Never deletes on its own. */
  requestDelete(id: string): void;
  /** Opens the inspector on this node. The full editing surface lives there. */
  inspect(id: string): void;
  attachDocument(id: string, file: File): void;
}

const CanvasActionsContext = createContext<CanvasActions | null>(null);

export const CanvasActionsProvider = CanvasActionsContext.Provider;

export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext);
  if (!actions) {
    throw new Error("useCanvasActions must be used inside <CanvasActionsProvider>");
  }
  return actions;
}
