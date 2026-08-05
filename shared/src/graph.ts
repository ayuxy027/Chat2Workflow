import { z } from "zod";

/**
 * The graph domain model. Single source of truth for the canvas, the API,
 * and the Temporal workflow. Never redeclare these shapes elsewhere.
 *
 * Note the split between authored state and runtime state:
 *   - authored: kind, label, prompt, toolId, params, position
 *   - runtime:  status, result, citations, error, blob
 * The LLM planner only ever produces authored state (see PlanResult).
 */

export const NodeKind = z.enum(["document", "chat", "tool", "input", "output"]);
export type NodeKind = z.infer<typeof NodeKind>;

export const NodeStatus = z.enum(["idle", "queued", "running", "done", "error"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

/**
 * A pointer to bytes in the content-addressed blob store. Documents NEVER
 * travel inside Temporal payloads (2MB limit) — only this reference does.
 * Content addressing is also what makes the audit trail meaningful: a BlobRef
 * in a six-month-old workflow history still names the exact bytes processed.
 */
export const BlobRef = z.object({
  sha256: z.string().length(64),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  filename: z.string(),
  pages: z.number().int().positive().optional(),
});
export type BlobRef = z.infer<typeof BlobRef>;

/**
 * A verified page reference. `verified` is set by the citation checker, which
 * confirms `quote` actually occurs in the extracted text of `page`. An
 * unverified citation renders with a warning marker — we never present a
 * model-asserted page number as fact.
 */
export const Citation = z.object({
  /**
   * The blob the quote was actually checked against — in practice the
   * extracted-text blob, because that is what verification can match on.
   */
  blob: z.string().length(64),
  /**
   * The original document to show the user, when the checked blob is derived
   * from it. Without this the UI links a verified citation to the derived
   * `.txt` — which downloads as a file and has no pages — instead of the PDF
   * the claim actually came from, and PRD §3.6's "the source document is
   * always one click from any claim" is not met on the normal path.
   */
  sourceBlob: z.string().length(64).optional(),
  page: z.number().int().positive(),
  quote: z.string(),
  verified: z.boolean().default(false),
});
export type Citation = z.infer<typeof Citation>;

/** Where a citation should link. Never link on `blob` alone. */
export const citationTarget = (c: Citation): string => c.sourceBlob ?? c.blob;

export const Position = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof Position>;

export const GraphNode = z.object({
  id: z.string(),
  kind: NodeKind,
  position: Position,
  label: z.string(),

  // authored
  prompt: z.string().optional(),
  toolId: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),

  /**
   * Free text supplied by the user on an `input` node.
   *
   * Distinct from `prompt` (an instruction to the model) and from `params`
   * (tool configuration) because it is neither — it is data the user is
   * feeding into the graph. Read it through `nodeInputText()`, never directly:
   * the canvas and the workflow independently picked different homes for this
   * value, so a user could type into an input node and have it silently never
   * reach the model.
   */
  value: z.string().optional(),

  // runtime
  status: NodeStatus.default("idle"),
  blob: BlobRef.optional(),
  outputs: z.array(BlobRef).default([]),
  result: z.string().optional(),
  citations: z.array(Citation).default([]),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),

  /**
   * Caveats the user must see, not just the auditor: text was truncated, a
   * page number was corrected, a document had no extractable text layer.
   *
   * Tool nodes already surfaced their log; chat nodes — the ones that make
   * legal claims — were dropping theirs. An answer covering 40 of 200 pages
   * that looks identical to one covering all 200 is the failure §3.6 exists
   * to prevent, so this is a product requirement, not diagnostics.
   */
  log: z.array(z.string()).optional(),

  /**
   * Set when the model saw less than the full input. Must be visible.
   *
   * Optional rather than defaulted, deliberately: a `.default()` makes the
   * field required on the parsed type, which forces every construction site
   * across both packages to supply it. Readers use `?? []` / `?? false`.
   */
  truncated: z.boolean().optional(),

  /**
   * Verification tally, so the UI can show "8 of 11 verified" without
   * recomputing it — and so a result with zero verified citations is
   * obviously distinguishable from one that was never checked.
   */
  verifiedCount: z.number().int().nonnegative().optional(),
  unverifiedCount: z.number().int().nonnegative().optional(),

  /**
   * Audit identity for whatever produced `result`. Recorded because history
   * must answer "which tool build, which prompt" six months from now.
   */
  provenance: z
    .object({
      model: z.string().optional(),
      promptVersion: z.string().optional(),
      toolVersion: z.string().optional(),
      binaries: z
        .array(z.object({ name: z.string(), version: z.string() }))
        .optional(),
    })
    .optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const Graph = z.object({
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});
export type Graph = z.infer<typeof Graph>;

export const emptyGraph = (): Graph => ({ nodes: [], edges: [] });

/**
 * The ONE way to read the text a user typed into a node.
 *
 * There were three candidate homes for this — `value`, `params.text`, and
 * `prompt` — and the canvas and the workflow each picked a different one. The
 * result was an input node that accepted typing, looked correct, and whose
 * contents never reached the model. Silent, and invisible from either side.
 *
 * `value` is canonical; the rest are read for compatibility with anything that
 * already wrote them. Writers should set `value`.
 */
export function nodeInputText(node: Pick<GraphNode, "value" | "params" | "prompt">): string {
  if (typeof node.value === "string" && node.value !== "") return node.value;

  const fromParams = node.params?.["text"];
  if (typeof fromParams === "string" && fromParams !== "") return fromParams;

  return node.prompt ?? "";
}

