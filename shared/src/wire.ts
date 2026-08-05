import { z } from "zod";
import { Graph, GraphNode } from "./graph";
import { GraphEvent, GraphMutation } from "./events";

/**
 * The Temporal wire contract, owned in one place.
 *
 * The web app and the worker are separate packages that cannot import each
 * other, so these names used to live as hand-copied string literals on the web
 * side with a comment asking the next person to keep them in sync. That is not
 * a contract, it is a hope — and it had already drifted twice: the workflow
 * argument became an object while the caller still sent a positional string
 * (which fails silently, with `sessionId` undefined), and `getSessionInfo` was
 * added on the worker side and never wired up on the client.
 *
 * Both sides import from here instead. A renamed signal, a changed payload, or
 * a query that exists on only one side is then a `bun run typecheck` failure
 * rather than a runtime `QueryNotRegisteredError` in front of a user.
 *
 * This module is pure — no `node:fs`, no network — so it is safe inside the
 * deterministic workflow bundle.
 */

export const GRAPH_SESSION_WORKFLOW = "graphSessionWorkflow";

/**
 * Workflow argument. A SINGLE OBJECT, never a positional string: continue-as-new
 * re-invokes this signature carrying a large state blob, and a named field
 * survives additions that argument order would not.
 */
export const GraphSessionInput = z.object({
  sessionId: z.string().min(1),
  /** Opaque carried state for continue-as-new. Shape owned by the worker. */
  carried: z.unknown().optional(),
});
export type GraphSessionInput = z.infer<typeof GraphSessionInput>;

/* --- signals: mutate, never block the caller ----------------------------- */

export const SIGNALS = {
  submitPrompt: "submitPrompt",
  /**
   * @deprecated Use the `applyMutation` UPDATE. Retained so a client mid-migration
   * keeps working; it applies the same mutation but cannot report rejection, so
   * an invalid edit is silently dropped exactly as before.
   */
  mutateGraph: "mutateGraph",
  runGraph: "runGraph",
  close: "close",
} as const;
export type SignalName = (typeof SIGNALS)[keyof typeof SIGNALS];

export const SubmitPromptArg = z.object({ text: z.string().min(1) });
export type SubmitPromptArg = z.infer<typeof SubmitPromptArg>;

/** Argument tuple per signal, so both sides agree on arity as well as shape. */
export interface SignalArgs {
  submitPrompt: [SubmitPromptArg];
  mutateGraph: [GraphMutation];
  runGraph: [];
  close: [];
}

/* --- updates: mutate AND answer -------------------------------------------- */

/**
 * Canvas edits go through an UPDATE, not a signal.
 *
 * A signal is fire-and-forget: the HTTP layer returns 202 whether or not the
 * workflow will honour it, and the browser has to guess. That is not a
 * theoretical difference — it has already produced two bugs. `disconnect`
 * returned 202 while the workflow silently ignored it, leaving a canvas with no
 * edge and a server that still had one (a Run would then have executed along a
 * deleted edge); and a mutation the workflow dropped left a node on screen that
 * the server never had.
 *
 * `defineUpdate` fixes both halves at once:
 *
 *   - A VALIDATOR runs before anything enters history. An edge to a node that
 *     does not exist, a self-loop, a duplicate, a cycle, or a connection past a
 *     tool's `maxInputs` is rejected outright — it never becomes a workflow
 *     event, so there is nothing to reconcile away afterwards.
 *   - The handler RETURNS, so the caller learns the id the workflow assigned and
 *     the `seq` its events landed at, instead of inventing an id optimistically
 *     and repairing from `getGraph` when the guess was wrong.
 *
 * `submitPrompt` and `runGraph` stay signals: they are genuinely
 * fire-and-forget, and both report progress through the event log anyway.
 */
export const UPDATES = {
  applyMutation: "applyMutation",
} as const;
export type UpdateName = (typeof UPDATES)[keyof typeof UPDATES];

/** ApplicationFailure `type` on a rejected mutation. Distinguishes 4xx from 5xx. */
export const MUTATION_REJECTED = "MutationRejected";

export const MutationAccepted = z.object({
  /**
   * Highest event seq this mutation produced. The caller's replica is current
   * once the SSE pump's cursor reaches it — no guessing, no polling for a
   * change that may never come because the mutation was dropped.
   */
  seq: z.number().int().nonnegative(),
  /**
   * The id the WORKFLOW assigned, for ops that create something (`addNode`,
   * `connect`). Ids are workflow-local counters and the client must never
   * invent one; this is how it learns the real value synchronously.
   */
  id: z.string().optional(),
});
export type MutationAccepted = z.infer<typeof MutationAccepted>;

export interface UpdateArgs {
  applyMutation: [GraphMutation];
}

export interface UpdateResults {
  applyMutation: MutationAccepted;
}

/* --- queries: read-only, called at ~8 Hz by the SSE pump ----------------- */

export const QUERIES = {
  getEventsSince: "getEventsSince",
  getGraph: "getGraph",
  getSessionInfo: "getSessionInfo",
} as const;
export type QueryName = (typeof QUERIES)[keyof typeof QUERIES];

/**
 * Retention window for the event log.
 *
 * After continue-as-new only a tail of events survives. A client whose cursor
 * is below `oldestSeq - 1` has an unrecoverable gap: applying the tail alone
 * leaves its replica permanently divergent from the workflow, with no error.
 * The pump must compare against this and resync via `getGraph` instead.
 */
export const SessionInfo = z.object({
  sessionId: z.string(),
  /** Highest seq ever assigned. Never resets, including across continue-as-new. */
  seq: z.number().int().nonnegative(),
  /** Lowest seq still retained. */
  oldestSeq: z.number().int().nonnegative(),
  running: z.boolean(),
  closed: z.boolean(),
  generation: z.number().int().nonnegative(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export interface QueryResults {
  getEventsSince: GraphEvent[];
  getGraph: Graph;
  getSessionInfo: SessionInfo;
}

export interface QueryArgs {
  getEventsSince: [cursor: number];
  getGraph: [];
  getSessionInfo: [];
}

/** True when a cursor has fallen off the retained window and must resync. */
export function hasCursorGap(cursor: number, info: SessionInfo): boolean {
  return cursor < info.oldestSeq - 1;
}

/* --- tool registry over HTTP --------------------------------------------- */

/**
 * `GET /api/tools`. The canvas renders a tool node's form from `ParamSpec`,
 * so without this endpoint tool parameters are read-only and only the planner
 * can set them — PRD §5.3's "params drives the node's form UI from the same
 * definition" is unmet.
 */
export const ToolRegistryResponse = z.object({
  tools: z.array(z.unknown()),
});

/** Node fields the canvas may edit directly. Everything else is server-owned. */
export const EDITABLE_NODE_FIELDS = ["label", "prompt", "params", "toolId"] as const;
export type EditableNodeField = (typeof EDITABLE_NODE_FIELDS)[number];

export type EditableNodePatch = Partial<
  Pick<GraphNode, "label" | "prompt" | "params" | "toolId">
>;
