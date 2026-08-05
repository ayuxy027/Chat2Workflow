import { cancellationSignal, Context, heartbeat, log } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { NodeKind, PlannedEdge, PlannedNode, PlanResult } from "@wf/shared";
import {
  callStructured,
  PLAN_MAX_OUTPUT_TOKENS,
  PLAN_REASONING_EFFORT,
  StructuredOutputError,
  TokenBudgetExhaustedError,
  type LlmUsage,
} from "../llm.js";
import { trySignal } from "../temporal-client.js";
import { hasTool, toolIds, toolManifests } from "../tools/registry.js";
import { PLAN_PROMPT_VERSION, WORKER_BUILD_ID } from "../version.js";
import { startHeartbeat } from "./heartbeater.js";

/**
 * The planning activity: prompt -> node graph, STREAMED.
 *
 * Two invariants make this safe to replay and safe to trust:
 *
 *   1. The model never returns `position`, `id`, `status`, or `blob`. Positions
 *      are computed by the workflow's pure layout function; IDs come from a
 *      workflow-local counter. Letting the model pick coordinates produces
 *      overlapping nodes and non-replayable workflows.
 *   2. The tool registry is injected into the prompt so the planner can only
 *      reference tools that exist, AND every `toolId` is re-validated against
 *      the registry. A hallucinated tool becomes a validation error surfaced in
 *      chat — never a broken node on the canvas.
 *
 * WHY THIS ACTIVITY SIGNALS ITS OWN WORKFLOW
 *
 * An activity returns once, at the end. Awaiting the whole plan and then
 * emitting it made the pause the experience: `plan.started`, several seconds of
 * dead canvas, then the entire graph at once. The model generates the plan
 * node by node, so the canvas can too — but only if each node leaves the
 * activity before the activity finishes. Signalling the parent workflow is the
 * standard Temporal way to do that.
 *
 * Two properties are preserved exactly:
 *
 *   - VALIDATION STILL PRECEDES THE CANVAS. `PlanValidator` is incremental, and
 *     every check it makes is local to one node or one edge, so a streamed node
 *     is validated to the same standard as a batched one. A hallucinated toolId
 *     is still rejected before it can reach the canvas, not deleted afterwards.
 *   - THE WORKFLOW STILL OWNS IDS AND POSITIONS. The signal carries the planned
 *     node, never an id or a coordinate.
 *
 * Signals are best-effort. The activity's return value remains the source of
 * truth and the workflow reconciles anything that did not stream, so a dropped
 * signal costs the animation and never the graph.
 */

export interface PlanGraphNodeSummary {
  id: string;
  kind: NodeKind;
  label: string;
  toolId?: string;
  hasDocument: boolean;
}

export interface PlanGraphInput {
  prompt: string;
  /**
   * Which planning round this is. Echoed back in every streamed signal so the
   * workflow can ignore signals from a superseded plan, and so a retry of this
   * activity cannot double-create nodes: tempIds are plan-local and "a" means
   * something different in the next plan.
   */
  planId: number;
  /** Compact view of what is already on the canvas, so the plan extends it. */
  existing: {
    nodes: PlanGraphNodeSummary[];
    edges: { source: string; target: string }[];
  };
}

export interface PlanGraphOutput {
  reply: string;
  nodes: PlannedNode[];
  edges: PlannedEdge[];
  /** Validation problems that were corrected. The workflow shows these in chat. */
  warnings: string[];
  usage: LlmUsage;
  /** Which build and which prompt produced this plan. See ../version.ts. */
  workerBuildId: string;
  promptVersion: string;
  /** How many nodes/edges reached the canvas before the plan was complete. */
  streamed: { nodes: number; edges: number };
}

/* ------------------------------------------------------------------ */
/* Streamed signals — worker-internal                                  */
/* ------------------------------------------------------------------ */

/**
 * These are NOT part of the web/worker wire contract in `@wf/shared`, because
 * the browser neither sends nor receives them: they travel from this activity
 * to the workflow that started it, inside the worker. If the web app ever needs
 * to send one, they belong in `wire.ts` like every other signal name.
 */
export const PLAN_NODE_SIGNAL = "planNodeStreamed";
export const PLAN_EDGE_SIGNAL = "planEdgeStreamed";
export const PLAN_DISCARD_SIGNAL = "planDiscardStreamed";

export interface PlanNodeStreamed {
  planId: number;
  node: PlannedNode;
  /**
   * Inbound edges declared by the node's own `after`, already validated.
   *
   * They travel WITH the node so the workflow can draw them in the same
   * activation it creates it. Sending them as separate edge signals would put
   * a workflow-task round trip between the box appearing and its wire
   * appearing, which is the flicker `after` exists to remove.
   */
  edges: PlannedEdge[];
}

export interface PlanEdgeStreamed {
  planId: number;
  edge: PlannedEdge;
}

/**
 * Retract everything streamed for this plan.
 *
 * Only the `json_object` rung streams. If it streams part of a plan and then
 * fails its final parse, `callStructured` falls through to a rung that returns
 * a DIFFERENT object in one piece — and the half-plan already on the canvas is
 * from an attempt that was thrown away. Left alone, reconciliation would layer
 * the real plan on top of it and the user would keep whatever the failed
 * attempt happened to emit. Retracting costs a flicker in a rare fallback;
 * not retracting means the canvas can show nodes that are in no plan at all.
 */
export interface PlanDiscardStreamed {
  planId: number;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

/**
 * Field order is load-bearing, not cosmetic.
 *
 * `nodes` comes FIRST because JSON is generated in order and the canvas draws
 * from the stream. With `reply` first the model wrote a whole sentence of prose
 * before the first node existed, and that sentence was pure dead canvas —
 * measured at ~2.2s to first node against ~1.3s once it moved. The reply is
 * chat-panel text; the graph is the thing the user is waiting to see.
 *
 * `toolId` is described as omitted-unless-tool rather than "REQUIRED when
 * kind is 'tool'": the latter read as part of the template and the model filled
 * it in as "" on every node, which the validator then had to strip and warn
 * about three times on a perfectly good plan.
 */
const SHAPE_HINT = `{
  "nodes": [
    {
      "tempId": "a",
      "kind": "document" | "chat" | "tool" | "input" | "output",
      "label": "short human label, 2-4 words",
      "prompt": "chat nodes ONLY — the instruction sent to the model. Omit the key otherwise.",
      "toolId": "tool nodes ONLY — an id copied from the registry. Omit the key otherwise.",
      "params": { },
      "after": ["tempIds of the node(s) feeding INTO this one; omit for a starting node"]
    }
  ],
  "edges": [ { "source": "a", "target": "b" } ],
  "reply": "one or two sentences shown in the chat panel"
}`;

function registryBlock(): string {
  return toolManifests()
    .map((m) => {
      const params =
        m.params.length === 0
          ? "none"
          : m.params
              .map((p) => `${p.name}:${p.type}${"default" in p && p.default !== undefined ? `=${String(p.default)}` : ""}`)
              .join(", ");
      const arity = m.maxInputs === null ? `${m.minInputs}+` : `${m.minInputs}-${m.maxInputs}`;
      return [
        `- id: ${m.id}`,
        `  label: ${m.label}`,
        `  does: ${m.description}`,
        `  accepts: ${m.accepts.join(", ")} -> produces: ${m.produces.join(", ")}`,
        `  inputs: ${arity}   params: ${params}`,
      ].join("\n");
    })
    .join("\n");
}

/**
 * Worked patterns.
 *
 * Short asks are the common case — "summarise a pdf for me" is what people
 * actually type — and without examples the planner answered them with a stub:
 * one node, or a chat node reading a PDF it cannot see. These four cover the
 * legal asks the tool exists for, and each one is a COMPLETE runnable pipeline
 * ending in an output node, because a graph the user has to finish building
 * themselves has not answered their request.
 */
const PATTERNS = `WORKED PATTERNS — follow these shapes. Always produce a COMPLETE, runnable pipeline,
never a single stub node. The user attaches files to the document nodes afterwards. Note how
every downstream node names its inputs in "after".

  "summarise a pdf" / "what does this say" / "give me the key points"
    {"tempId":"a","kind":"document","label":"Contract"}
    {"tempId":"b","kind":"tool","label":"Extract Text","toolId":"pdf.extract_text","after":["a"]}
    {"tempId":"c","kind":"chat","label":"Summarise","after":["b"],
     "prompt":"Summarise this agreement: parties, term, key obligations, termination rights and
     governing law. Cite every point."}
    {"tempId":"d","kind":"output","label":"Summary","after":["c"]}

  "compare these two contracts" / "what changed"
    {"tempId":"a","kind":"document","label":"Contract A"}
    {"tempId":"b","kind":"tool","label":"Extract A","toolId":"pdf.extract_text","after":["a"]}
    {"tempId":"c","kind":"document","label":"Contract B"}
    {"tempId":"d","kind":"tool","label":"Extract B","toolId":"pdf.extract_text","after":["c"]}
    {"tempId":"e","kind":"chat","label":"Compare","after":["b","d"],
     "prompt":"Compare these two agreements clause by clause. State the differences that carry
     legal or commercial consequence, and cite both documents for every difference."}
    {"tempId":"f","kind":"output","label":"Comparison","after":["e"]}

  "find/extract the <X> clauses" / "pull out the indemnities"
    document "Contract" -> pdf.extract_text -> chat "Extract Clauses" -> output, each with
    "after". The chat prompt names X explicitly and asks for verbatim quotes with pages.

  "convert this to word" / "compress this pdf"   (deterministic — no chat node at all)
    {"tempId":"a","kind":"document","label":"Source"}
    {"tempId":"b","kind":"tool","label":"To Word","toolId":"pdf.to_docx","after":["a"]}
    {"tempId":"c","kind":"output","label":"Converted","after":["b"]}

  "lay that out as a client memo"  (arrange an existing analysis — never a chat node)
    {"tempId":"a","kind":"tool","label":"Client Memo","toolId":"template.apply",
     "params":{"template":"memo"},"after":["<id of the chat node already on the canvas>"]}
    {"tempId":"b","kind":"output","label":"Memo","after":["a"]}

  A bare greeting or an unclear ask is NOT a pipeline. Return zero nodes and ask what they
  want done, in "reply".`;

const SYSTEM = `You plan document workflows for a legal team. You turn a plain-language request
into a directed graph of nodes on a canvas. You do not perform the work; you lay out the pipeline
that will perform it.

NODE KINDS
  document  a source file the user will attach. No prompt, no toolId.
  input     a short free-text value the user types (e.g. a party name).
  tool      a deterministic file operation. REQUIRES a toolId from the registry below.
  chat      a model step that reads document text and answers with page citations.
            REQUIRES a prompt. Use this for summarising, clause extraction, comparison, Q&A.
  output    a terminal node that collects artifacts for download.

RULES
  1. toolId MUST be copied exactly from the registry. Never invent one. If no tool fits,
     use a chat node or say so in "reply".
  2. Deterministic byte work (compress, split, merge, convert, extract text) is a TOOL.
     Judgment (summarise, compare, find risks) is a CHAT node. Never use a chat node to
     transform bytes and never use a tool for judgment.
  3. A chat node that reasons about a PDF must be fed by a pdf.extract_text tool node —
     the model only ever sees extracted text, never the file itself.
  4. Every branch ends in an output node.
  5. Do NOT emit position, id, status, or blob. Those are assigned by the system.
  6. tempIds are short, unique, plan-local handles: "a", "b", "c".
  7. Edges flow upstream -> downstream and must reference tempIds you defined, or the id
     of a node already on the canvas. The graph must be ACYCLIC.
  8. Write a chat node's "prompt" as a full instruction the model can act on alone — it is
     what actually gets sent. "Summarise" is not an instruction; the pattern below is.
  9. Emit nodes in pipeline order, sources first. They appear on the canvas as you write
     them, so the order you choose is the order the user watches it build.
 10. Give every non-starting node an "after" listing the tempIds that feed INTO it. This is
     what lets each connection be drawn the instant its two nodes exist, instead of the whole
     graph snapping its wiring on at the end. Use "edges" only for a link a node cannot state
     about itself; a link declared in both places is fine and is de-duplicated.

${PATTERNS}

TOOL REGISTRY (the only tools that exist)
${registryBlock()}`;

function existingBlock(input: PlanGraphInput): string {
  if (input.existing.nodes.length === 0) return "The canvas is empty.";
  const nodes = input.existing.nodes
    .map(
      (n) =>
        `  ${n.id}: ${n.kind}${n.toolId === undefined ? "" : ` (${n.toolId})`} "${n.label}"` +
        `${n.hasDocument ? " [document attached]" : ""}`,
    )
    .join("\n");
  const edges =
    input.existing.edges.length === 0
      ? "  (none)"
      : input.existing.edges.map((e) => `  ${e.source} -> ${e.target}`).join("\n");
  return `Already on the canvas — extend it rather than duplicating it.\nNodes:\n${nodes}\nEdges:\n${edges}`;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Incremental plan validation.
 *
 * Every rule here is local to a single node, or to a single edge against the
 * nodes accepted so far — which is what makes streaming safe. Feeding nodes in
 * one at a time as the model writes them reaches exactly the same verdict as
 * feeding the finished plan in at the end, so a node that appears on the canvas
 * early has passed the same checks as one that appears at the end.
 *
 * Accept order therefore matters and is the model's: nodes before the edges
 * that reference them, which is also the order the prompt asks for.
 */
class PlanValidator {
  readonly warnings: string[] = [];
  readonly nodes: PlannedNode[] = [];
  readonly edges: PlannedEdge[] = [];

  private readonly seen = new Set<string>();
  private readonly edgeKeys = new Set<string>();
  /** Adjacency over existing + accepted edges, for the acyclicity check. */
  private readonly out = new Map<string, string[]>();

  constructor(
    private readonly existingIds: Set<string>,
    existingEdges: { source: string; target: string }[],
  ) {
    for (const e of existingEdges) this.link(e.source, e.target);
  }

  private link(s: string, t: string): void {
    const list = this.out.get(s);
    if (list === undefined) this.out.set(s, [t]);
    else list.push(t);
  }

  /** Is `to` already reachable from `from`? Then from -> to closes a cycle. */
  private reaches(from: string, to: string): boolean {
    const stack = [from];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (v === to) return true;
      if (visited.has(v)) continue;
      visited.add(v);
      for (const w of this.out.get(v) ?? []) stack.push(w);
    }
    return false;
  }

  private addressable(id: string): boolean {
    return this.seen.has(id) || this.existingIds.has(id);
  }

  /** Already accepted? Used to skip nodes that were streamed earlier. */
  has(tempId: string): boolean {
    return this.seen.has(tempId);
  }

  /** Returns the node if it was accepted, or undefined if it was dropped. */
  addNode(n: PlannedNode): PlannedNode | undefined {
    if (n.tempId.trim() === "") {
      this.warnings.push(`Dropped a node with an empty tempId.`);
      return undefined;
    }
    if (this.seen.has(n.tempId) || this.existingIds.has(n.tempId)) {
      this.warnings.push(`Dropped duplicate node "${n.tempId}" (${n.label}).`);
      return undefined;
    }

    if (n.kind === "tool") {
      if (n.toolId === undefined || n.toolId.trim() === "") {
        this.warnings.push(`Dropped tool node "${n.label}": no toolId was given.`);
        return undefined;
      }
      if (!hasTool(n.toolId)) {
        this.warnings.push(
          `Dropped tool node "${n.label}": "${n.toolId}" is not a registered tool. ` +
            `Available tools are ${toolIds().join(", ")}.`,
        );
        return undefined;
      }
    } else if (n.toolId !== undefined) {
      // Only worth telling the user about if the model named an actual tool on
      // a node that cannot run one. An empty string is the model echoing the
      // shape template, and warning about it three times on a good plan buries
      // the warnings that matter.
      if (n.toolId.trim() !== "") {
        this.warnings.push(
          `Ignored toolId "${n.toolId}" on ${n.kind} node "${n.label}" — only tool nodes have one.`,
        );
      }
      n.toolId = undefined;
    }

    if (n.kind === "chat" && (n.prompt === undefined || n.prompt.trim() === "")) {
      this.warnings.push(`Dropped chat node "${n.label}": a chat node needs a prompt.`);
      return undefined;
    }

    this.seen.add(n.tempId);
    this.nodes.push(n);
    return n;
  }

  /** True once both endpoints exist, so the edge can be judged at all. */
  edgeIsReady(e: PlannedEdge): boolean {
    return this.addressable(e.source) && this.addressable(e.target);
  }

  /**
   * `after`-derived edges. Identical rules, but an unresolvable endpoint is not
   * reported: `after` is a convenience on the node, and a stale handle in it
   * says nothing the user can act on — whereas the same mistake in the explicit
   * `edges` array is a plan the model got wrong and worth surfacing.
   */
  addEdgeQuietly(e: PlannedEdge): PlannedEdge | undefined {
    if (!this.edgeIsReady(e)) return undefined;
    return this.addEdge(e);
  }

  /**
   * Returns the edge if it was accepted, or undefined if it was dropped.
   *
   * Only ever called once the plan is complete, or once both endpoints exist.
   * Calling it speculatively mid-stream produced warnings that were simply
   * wrong: an edge whose target had not been generated YET is early, not
   * invalid, and telling the user "it references a node that was not created"
   * about an edge that is about to work is worse than saying nothing.
   */
  addEdge(e: PlannedEdge): PlannedEdge | undefined {
    if (!this.addressable(e.source) || !this.addressable(e.target)) {
      this.warnings.push(
        `Dropped edge ${e.source} -> ${e.target}: it references a node that was not created.`,
      );
      return undefined;
    }
    if (e.source === e.target) {
      this.warnings.push(`Dropped self-edge on ${e.source}.`);
      return undefined;
    }
    const key = `${e.source} ${e.target}`;
    if (this.edgeKeys.has(key)) return undefined;
    // Data flow must be acyclic. Rejected here, one edge is dropped and the
    // user is told which; accepted here, the whole graph is unrunnable and they
    // only discover it when they press Run, because `executeGraph` refuses a
    // cyclic graph outright and marks every node in the cycle `error`. Probed
    // with a scripted cyclic plan, that is exactly what happened. Existing
    // edges are included because a plan that extends the canvas can close a
    // loop through nodes it never mentions.
    if (this.reaches(e.target, e.source)) {
      this.warnings.push(
        `Dropped edge ${e.source} -> ${e.target}: it would create a cycle, and data flow must ` +
          `be acyclic. The rest of the plan was kept.`,
      );
      return undefined;
    }
    this.edgeKeys.add(key);
    this.link(e.source, e.target);
    this.edges.push(e);
    return e;
  }
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

/**
 * Pull COMPLETE array elements out of a half-written JSON document.
 *
 * `streamObject`'s own partial parser cannot be used here — see the note on
 * `onPartial` in llm.ts — so rung 1 streams raw text and this reads progress
 * out of it. The rule is deliberately conservative: an element counts only once
 * its closing brace has arrived at depth 1, so a node is never emitted with a
 * label the model is still halfway through typing.
 *
 * String state is tracked properly, because a brace inside a chat node's prompt
 * ("...respond with {answer}") would otherwise desynchronise the depth count
 * and start emitting nonsense.
 */
export function completeElements(text: string, key: string): unknown[] {
  const marker = `"${key}"`;
  const at = text.indexOf(marker);
  if (at === -1) return [];
  const open = text.indexOf("[", at + marker.length);
  if (open === -1) return [];

  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // Not yet valid on its own; the reconciliation will pick it up.
        }
        start = -1;
      }
      continue;
    }
    // The array closed: everything after belongs to a different key.
    if (c === "]" && depth === 0) break;
  }
  return out;
}

/** Strict parse. A partial element fails this and is simply not ready yet. */
function asNode(v: unknown): PlannedNode | undefined {
  const parsed = PlannedNode.safeParse(v);
  if (!parsed.success) return undefined;
  // `kind` is an enum, so a truncated value cannot parse — but a truncated
  // LABEL can, and an empty one is never worth showing.
  if (parsed.data.label.trim() === "") return undefined;
  if (!NodeKind.safeParse(parsed.data.kind).success) return undefined;
  return parsed.data;
}

function asEdge(v: unknown): PlannedEdge | undefined {
  const parsed = PlannedEdge.safeParse(v);
  if (!parsed.success) return undefined;
  if (parsed.data.source.trim() === "" || parsed.data.target.trim() === "") return undefined;
  return parsed.data;
}

/* ------------------------------------------------------------------ */

export async function planGraph(input: PlanGraphInput): Promise<PlanGraphOutput> {
  if (input.prompt.trim() === "") {
    throw ApplicationFailure.nonRetryable("The prompt is empty.", "PlanValidationError");
  }

  const existingIds = new Set(input.existing.nodes.map((n) => n.id));
  const validator = new PlanValidator(existingIds, input.existing.edges);

  // `workflowExecution` is typed optional; without it there is nobody to signal
  // and the plan simply arrives all at once, via the return value.
  const execution = Context.current().info.workflowExecution as
    | { workflowId: string; runId: string }
    | undefined;
  const streamed = { nodes: 0, edges: 0 };
  /** Serialises the signal sends so the workflow sees them in generation order. */
  let pump: Promise<void> = Promise.resolve();
  let nodeCursor = 0;
  /** Indices of settled edges already judged, so retries do not double-count. */
  const sentEdges = new Set<number>();
  let partials = 0;

  /** Emit everything that has become complete since the last delta. */
  const drain = (text: string): void => {
    const readyNodes = completeElements(text, "nodes");
    for (; nodeCursor < readyNodes.length; nodeCursor++) {
      const node = asNode(readyNodes[nodeCursor]);
      if (node === undefined) continue;
      const accepted = validator.addNode(node);
      if (accepted === undefined) continue;
      // `after` goes through the SAME PlanValidator as the `edges` array —
      // same duplicate, self-loop and acyclicity checks. It is a more timely
      // way to state an edge, not a way to bypass the rules about one.
      const inbound: PlannedEdge[] = [];
      for (const source of accepted.after ?? []) {
        const edge = asEdge({ source, target: accepted.tempId });
        if (edge === undefined) continue;
        if (!validator.edgeIsReady(edge)) continue;
        const ok = validator.addEdge(edge);
        if (ok !== undefined) inbound.push(ok);
      }
      if (execution === undefined) continue;
      streamed.nodes++;
      streamed.edges += inbound.length;
      const arg: PlanNodeStreamed = { planId: input.planId, node: accepted, edges: inbound };
      pump = pump.then(() =>
        trySignal(execution.workflowId, execution.runId, PLAN_NODE_SIGNAL, arg).then(
          () => undefined,
        ),
      );
    }

    // Every complete edge is retried on every pass, and none is consumed until
    // it can actually be judged. An edge generated before its target node is
    // early, not invalid — re-offering it once the node arrives is what lets
    // the graph draw itself instead of nodes popping and edges snapping in
    // afterwards, and it keeps a speculative attempt from recording a warning
    // the finished plan will contradict.
    const readyEdges = completeElements(text, "edges");
    for (let i = 0; i < readyEdges.length; i++) {
      if (sentEdges.has(i)) continue;
      const edge = asEdge(readyEdges[i]);
      if (edge === undefined) continue;
      if (!validator.edgeIsReady(edge)) continue;
      sentEdges.add(i);
      const accepted = validator.addEdge(edge);
      if (accepted === undefined) continue;
      if (execution === undefined) continue;
      streamed.edges++;
      const arg: PlanEdgeStreamed = { planId: input.planId, edge: accepted };
      pump = pump.then(() =>
        trySignal(execution.workflowId, execution.runId, PLAN_EDGE_SIGNAL, arg).then(
          () => undefined,
        ),
      );
    }
  };

  const discardStreamed = async (): Promise<void> => {
    if (streamed.nodes === 0 || execution === undefined) return;
    const arg: PlanDiscardStreamed = { planId: input.planId };
    await pump.catch(() => undefined);
    await trySignal(execution.workflowId, execution.runId, PLAN_DISCARD_SIGNAL, arg);
    streamed.nodes = 0;
    streamed.edges = 0;
  };

  let lastText = "";
  let result;
  // See heartbeater.ts: partial-driven heartbeats alone leave this activity
  // undetectably wedged if the endpoint stops responding mid-stream.
  const ticker = startHeartbeat(() => ({ stage: "planning", partials, streamed }));
  try {
    result = await callStructured({
      schema: PlanResult,
      name: "plan_result",
      description: "workflow plan",
      shapeHint: SHAPE_HINT,
      system: SYSTEM,
      prompt: `${existingBlock(input)}\n\nUser request:\n${input.prompt}`,
      maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS,
      reasoningEffort: PLAN_REASONING_EFFORT,
      // Cancel the HTTP call when Temporal cancels the activity. `callStructured`
      // has always threaded this into every AI SDK call and nothing ever passed
      // one, so cancelling a run left the model generating for the rest of the
      // 10-minute start-to-close timeout: tokens spent on a plan nobody will
      // see, and a worker slot held against it.
      abortSignal: cancellationSignal(),
      onPartial: (accumulated) => {
        partials++;
        lastText = accumulated;
        if (partials % 32 === 0) heartbeat({ stage: "planning", partials, streamed });
        drain(accumulated);
      },
    });
  } catch (err) {
    // Nothing survives a plan that failed outright.
    await discardStreamed();
    if (err instanceof TokenBudgetExhaustedError) {
      throw ApplicationFailure.nonRetryable(err.message, "TokenBudgetExhaustedError");
    }
    if (err instanceof StructuredOutputError) {
      throw ApplicationFailure.nonRetryable(err.message, "StructuredOutputError");
    }
    throw err;
  } finally {
    ticker.stop();
  }

  /**
   * Streaming only happens on the `json_object` rung. Any other strategy means
   * that rung failed after possibly streaming part of a plan, and what it
   * streamed belongs to an object that was discarded — so the canvas has to
   * discard it too, and be rebuilt from the result that actually won.
   */
  if (result.usage.strategy !== "json_object" && streamed.nodes > 0) {
    await discardStreamed();
  }

  /**
   * Reconcile. The validated object is the source of truth; streaming is an
   * optimisation on top of it. Anything the stream did not reach — the last
   * element of each array, everything at all if the endpoint did not stream, or
   * a node whose signal was dropped — is validated and returned here, and the
   * workflow creates whatever it does not already have. The validator carries
   * its accept-set across both phases, so nothing is validated or counted twice.
   */
  const reconciler =
    streamed.nodes > 0 ? validator : new PlanValidator(existingIds, input.existing.edges);
  for (const n of result.object.nodes) {
    if (n.tempId.trim() !== "" && reconciler.has(n.tempId)) continue;
    reconciler.addNode(n);
  }
  // `after` first, then the explicit `edges` array. Both are de-duplicated by
  // the validator, so a link stated in both places is created once.
  for (const n of result.object.nodes) {
    for (const source of n.after ?? []) {
      reconciler.addEdgeQuietly({ source, target: n.tempId });
    }
  }
  for (const e of result.object.edges) reconciler.addEdge(e);

  // Let queued signals land before the workflow sees the return value. Without
  // this the reconciliation and a late signal can race to create the same node
  // — harmless, because the workflow ignores a tempId it already has, but this
  // keeps the common case in generation order.
  await pump;

  const { nodes, edges, warnings } = reconciler;
  const reply = result.object.reply.trim();

  /**
   * Whether progressive rendering actually happened, and why not if it did not.
   *
   * Only the `json_object` rung streams; the tool-call and text fallbacks
   * return in one piece, and this endpoint drops to them whenever it emits the
   * stray `{"{` prefix that its own JSON mode is prone to. When that happens
   * the plan is still correct and still complete — it just arrives all at once.
   * That difference is invisible from the outside and worth a line in the log.
   */
  log.info("plan complete", {
    strategy: result.usage.strategy,
    partials,
    streamedNodes: streamed.nodes,
    streamedEdges: streamed.edges,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    progressive: streamed.nodes > 0,
    streamChars: lastText.length,
  });

  /**
   * An empty plan is not automatically a failure.
   *
   * The system prompt offers "if no tool fits, use a chat node OR SAY SO in
   * 'reply'" as a legitimate outcome, and the user can perfectly well type
   * "hi" or ask what the tool can do. Treating every zero-node response as a
   * hard error made that instruction impossible to honour: the model's reply
   * was discarded and the user got "The planner produced no usable nodes.
   * (no detail)" — a failure message for something that did not fail. Probed
   * live, four of six ordinary prompts landed there, including a greeting.
   *
   * The distinction that matters is whether the plan is empty because the
   * planner CHOSE to add nothing, or because everything it proposed was thrown
   * out. Only the second is a failure, and it is still a loud one — the
   * warnings say exactly what was dropped and why.
   */
  if (nodes.length === 0 && warnings.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `Every node the planner proposed was rejected:\n${warnings.join("\n")}`,
      "PlanValidationError",
    );
  }
  if (nodes.length === 0 && reply === "") {
    throw ApplicationFailure.nonRetryable(
      "The planner returned neither nodes nor an explanation. A silently empty plan is " +
        "indistinguishable from the app ignoring you, so it is reported as a failure.",
      "PlanValidationError",
    );
  }

  return {
    reply,
    nodes,
    edges,
    warnings,
    usage: result.usage,
    workerBuildId: WORKER_BUILD_ID,
    promptVersion: PLAN_PROMPT_VERSION,
    streamed,
  };
}
