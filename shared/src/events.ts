import { z } from "zod";
import { GraphNode, GraphEdge, BlobRef } from "./graph";

/**
 * The append-only event log the workflow maintains and the SSE pump drains.
 *
 * Why a log rather than diffing graph snapshots: the pump polls a Temporal
 * query, and diffing two graphs to infer what changed is both wasteful and
 * ambiguous (did a node move, or was it deleted and re-added?). A cursor into
 * an append-only log makes reconnect trivial — the browser sends its last
 * `seq` and receives exactly what it missed.
 *
 * `seq` is monotonic across continue-as-new boundaries. Reseed it from the
 * carried-forward tail, never from zero.
 */

export const GraphEvent = z.discriminatedUnion("t", [
  z.object({ seq: z.number(), t: z.literal("node.added"), node: GraphNode }),
  z.object({
    seq: z.number(),
    t: z.literal("node.updated"),
    id: z.string(),
    patch: GraphNode.partial(),
    /**
     * Fields to DELETE, named explicitly.
     *
     * `patch: { blob: undefined }` cannot express removal: JSON serialization
     * drops undefined-valued keys, so the field never reaches the client and a
     * spread-merge leaves the old value in place. Observed: after `detachBlob`
     * the canvas still showed the document attached and its stale result while
     * the authoritative graph had neither — a replica that silently disagrees
     * with the workflow, which in a legal tool means the screen is lying about
     * what the pipeline will actually run on.
     *
     * Reducers must apply `clear` AFTER `patch`.
     */
    clear: z.array(z.string()).optional(),
  }),
  z.object({ seq: z.number(), t: z.literal("node.removed"), id: z.string() }),
  z.object({ seq: z.number(), t: z.literal("edge.added"), edge: GraphEdge }),
  z.object({ seq: z.number(), t: z.literal("edge.removed"), id: z.string() }),
  z.object({
    seq: z.number(),
    t: z.literal("chat"),
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
  }),
  z.object({ seq: z.number(), t: z.literal("run.started") }),
  z.object({
    seq: z.number(),
    t: z.literal("run.finished"),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    seq: z.number(),
    t: z.literal("plan.started"),
  }),
  z.object({
    seq: z.number(),
    t: z.literal("plan.finished"),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
]);
export type GraphEvent = z.infer<typeof GraphEvent>;

/** Mutations the browser can signal. Applied optimistically client-side. */
export const GraphMutation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("addNode"),
    kind: GraphNode.shape.kind,
    position: GraphNode.shape.position,
    label: z.string().optional(),
    toolId: z.string().optional(),
  }),
  z.object({
    op: z.literal("moveNode"),
    id: z.string(),
    position: GraphNode.shape.position,
  }),
  z.object({
    op: z.literal("updateNode"),
    id: z.string(),
    patch: z.object({
      label: z.string().optional(),
      prompt: z.string().optional(),
      // Re-pointing a node at a different tool is an ordinary edit — the
      // planner guesses the tool, and the user corrects it.
      toolId: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      /**
       * Text typed into an `input` node. Absent from this patch until now,
       * which meant the canonical write was silently stripped here by zod and
       * the canvas had to fall back to smuggling it through `params.text` —
       * the exact silent-drop failure `nodeInputText()` exists to end.
       */
      value: z.string().optional(),
    }),
  }),
  z.object({ op: z.literal("removeNode"), id: z.string() }),
  z.object({ op: z.literal("connect"), source: z.string(), target: z.string() }),
  z.object({ op: z.literal("disconnect"), id: z.string() }),
  z.object({ op: z.literal("attachBlob"), id: z.string(), blob: BlobRef }),
  z.object({ op: z.literal("detachBlob"), id: z.string() }),
]);
export type GraphMutation = z.infer<typeof GraphMutation>;
