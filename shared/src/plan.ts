import { z } from "zod";
import { NodeKind } from "./graph";

/**
 * What the planner LLM is allowed to produce.
 *
 * Deliberately absent: `position`, `id`, `status`, `blob`, `result`.
 * Positions come from the deterministic layout function in the workflow; IDs
 * from a workflow-local counter; the rest is runtime state. Letting the model
 * pick coordinates produces overlapping nodes and non-replayable workflows.
 *
 * `tempId` is a plan-local handle ("a", "b", "c") that the workflow maps onto
 * real node IDs when it materialises the plan.
 */

export const PlannedNode = z.object({
  tempId: z.string().describe("Short plan-local handle, e.g. 'a', 'b', 'c'."),
  kind: NodeKind,
  label: z.string().describe("Short human label, 2-4 words."),
  prompt: z
    .string()
    .optional()
    .describe("For kind='chat': the instruction this step sends to the model."),
  toolId: z
    .string()
    .optional()
    .describe("For kind='tool': MUST be an id from the provided tool registry."),
  params: z.record(z.string(), z.unknown()).optional(),
  after: z
    .array(z.string())
    .optional()
    .describe(
      "tempIds of the nodes feeding INTO this one. Usually one; several for a " +
        "step that merges. Omit for a starting node.",
    ),
});

/**
 * Why `after` exists alongside the separate `edges` array.
 *
 * The planner is streamed, and a JSON object emits its keys in order — `nodes`
 * is fully written before `edges` begins. So an edge-only representation can
 * never arrive until every node has: the canvas fills with disconnected boxes
 * and then snaps its wiring on at the end, which reads as a glitch rather than
 * as a graph assembling itself.
 *
 * Declaring a node's inbound links ON the node lets the workflow draw each
 * connection the moment its endpoints exist. `edges` is still honoured for
 * cross-links a node cannot express about itself, so both can be supplied.
 */
export type PlannedNode = z.infer<typeof PlannedNode>;

export const PlannedEdge = z.object({
  source: z.string().describe("tempId of the upstream node"),
  target: z.string().describe("tempId of the downstream node"),
});
export type PlannedEdge = z.infer<typeof PlannedEdge>;

export const PlanResult = z.object({
  reply: z
    .string()
    .describe("One or two sentences shown in the chat panel explaining the plan."),
  nodes: z.array(PlannedNode),
  edges: z.array(PlannedEdge),
});
export type PlanResult = z.infer<typeof PlanResult>;

/**
 * Structured output for a document-grounded chat node.
 *
 * Every claim must carry at least one citation. `quote` must be copied
 * verbatim from the page so the verifier can string-match it — a paraphrase
 * fails verification and renders with an "unverified" marker.
 */
export const AnalysisResult = z.object({
  answer: z.string().describe("The analysis. Markdown allowed."),
  citations: z
    .array(
      z.object({
        doc: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "1-based index of the source document, matching the [[doc N: ...]] " +
              "marker in the prompt. Required when more than one document is supplied.",
          ),
        page: z.number().int().positive(),
        quote: z
          .string()
          .describe("Verbatim excerpt from that page, 10-300 characters."),
      }),
    )
    .describe("Every substantive claim in `answer` must be supported here."),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;

/**
 * Why `doc` exists: with two contracts feeding one chat node, `{page, quote}`
 * alone is ambiguous, and resolving it by searching every loaded document for
 * the quote can attribute a passage to the wrong instrument. Boilerplate
 * recurs verbatim across agreements, so that failure is likely rather than
 * theoretical — and in this domain citing the wrong contract is worse than
 * citing nothing. Prompts must number documents `[[doc N: filename]]` and the
 * verifier must check the quote against THAT document's page N.
 *
 * Optional for the single-document case, where the index is unambiguous.
 */
