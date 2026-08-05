import * as wf from "@temporalio/workflow";
import {
  hasManifest,
  layout,
  nodeInputText,
  manifestById,
  MUTATION_REJECTED,
  QUERIES,
  SIGNALS,
  UPDATES,
  type BlobRef,
  type Graph,
  type GraphEdge,
  type GraphEvent,
  type GraphMutation,
  type GraphNode,
  type NodeStatus,
  type QueryArgs,
  type QueryResults,
  type SessionInfo,
  type SignalArgs,
  type UpdateArgs,
  type UpdateResults,
} from "@wf/shared";
import type * as activities from "../activities/index.js";
import type {
  PlanDiscardStreamed,
  PlanEdgeStreamed,
  PlanNodeStreamed,
  PLAN_DISCARD_SIGNAL,
  PLAN_EDGE_SIGNAL,
  PLAN_NODE_SIGNAL,
} from "../activities/plan-graph.js";

/**
 * The long-running session workflow: one per canvas.
 *
 * It holds the authoritative Graph plus an append-only GraphEvent log with a
 * monotonic `seq`. The browser holds a replica and catches up by polling
 * `getEventsSince` through the SSE pump. Signals mutate; queries read; the main
 * function parks on a condition and lets handlers do the work.
 *
 * DETERMINISM (CLAUDE.md §Temporal rules). Everything in this file must replay
 * identically:
 *   - Node ids come from a workflow-local counter (n1, n2, …). Never randomUUID.
 *   - Positions come from `layout()` in @wf/shared, which is pure. Never from
 *     the model, which would produce overlapping and non-replayable graphs.
 *   - Time comes from `now()` below, which is `Date.now()` — and inside the
 *     workflow sandbox the Temporal SDK replaces the global Date with the
 *     deterministic workflow clock. (See the note on `now()`: this SDK version
 *     exports no `workflow.now()`.)
 *   - No fs, no network, no crypto. All of that lives in activities.
 *
 * Streamed planning does not weaken any of that. The planner signals this
 * workflow as each node finishes generating, and those signals are recorded in
 * history like any other, so replay sees the same sequence in the same order.
 * Ids and positions are still assigned HERE, on receipt.
 */

/* ------------------------------------------------------------------ */
/* Signals and queries                                                 */
/* ------------------------------------------------------------------ */

/**
 * Names come from `@wf/shared/wire`, which the web app imports too. They used
 * to be string literals on both sides with a comment asking the next person to
 * keep them in sync; that had already drifted twice. A rename is now a
 * typecheck failure rather than a signal that goes nowhere.
 */
export const submitPrompt = wf.defineSignal<SignalArgs["submitPrompt"]>(SIGNALS.submitPrompt);
export const mutateGraph = wf.defineSignal<SignalArgs["mutateGraph"]>(SIGNALS.mutateGraph);
export const runGraph = wf.defineSignal<SignalArgs["runGraph"]>(SIGNALS.runGraph);
export const close = wf.defineSignal<SignalArgs["close"]>(SIGNALS.close);

/**
 * Worker-internal signals: the planning activity sends these to us as the model
 * generates, so the canvas can draw itself instead of waiting for the whole
 * plan. The browser never sends them, which is why they are not in the wire
 * contract — the type-only import keeps the names in lockstep with the sender
 * without pulling the activity implementation into the workflow bundle.
 */
export const planNodeStreamed =
  wf.defineSignal<[PlanNodeStreamed]>("planNodeStreamed" satisfies typeof PLAN_NODE_SIGNAL);
export const planEdgeStreamed =
  wf.defineSignal<[PlanEdgeStreamed]>("planEdgeStreamed" satisfies typeof PLAN_EDGE_SIGNAL);
export const planDiscardStreamed = wf.defineSignal<[PlanDiscardStreamed]>(
  "planDiscardStreamed" satisfies typeof PLAN_DISCARD_SIGNAL,
);

/**
 * Canvas edits. See the note on UPDATES in `@wf/shared/wire` for why this is an
 * update and not a signal.
 */
export const applyMutation = wf.defineUpdate<
  UpdateResults["applyMutation"],
  UpdateArgs["applyMutation"]
>(UPDATES.applyMutation);

export const getEventsSince = wf.defineQuery<
  QueryResults["getEventsSince"],
  QueryArgs["getEventsSince"]
>(QUERIES.getEventsSince);
export const getGraph = wf.defineQuery<QueryResults["getGraph"], QueryArgs["getGraph"]>(
  QUERIES.getGraph,
);

/**
 * `getEventsSince` alone cannot tell a reconnecting client that its cursor fell
 * off the retained window after a continue-as-new; this exposes the window so
 * the client can notice and resync via `getGraph`. `hasCursorGap` in
 * `@wf/shared/wire` is the check the pump should make against it.
 */
export const getSessionInfo = wf.defineQuery<
  QueryResults["getSessionInfo"],
  QueryArgs["getSessionInfo"]
>(QUERIES.getSessionInfo);

/* ------------------------------------------------------------------ */
/* Input / carried state                                               */
/* ------------------------------------------------------------------ */

/**
 * What crosses a continue-as-new boundary.
 *
 * `seq` is carried so cursors stay monotonic — see the long note on
 * `continueIfNeeded`. The two counters are carried for the same reason ids must
 * never repeat: a reset counter would re-issue `n7` for a different node and
 * silently corrupt every event a client had already applied.
 */
export interface CarriedState {
  graph: Graph;
  /** Suffix of the event log, with ORIGINAL seq values preserved. */
  tailEvents: GraphEvent[];
  seq: number;
  nodeCounter: number;
  edgeCounter: number;
  /** Nodes the user has dragged; layout must not move them again. */
  pinned: string[];
  generation: number;
}

export interface GraphSessionInput {
  sessionId: string;
  carried?: CarriedState;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* DEFERRED — Temporal APIs this workflow should use, but not yet      */
/* ------------------------------------------------------------------ */

/**
 * TODO(post-MVP): Temporal features deliberately NOT adopted yet.
 *
 * Each is correct and each was deferred on the same reasoning — it pays off
 * only after something that has not happened yet.
 *
 *   - `upsertSearchAttributes` — "which sessions touched sha256 abc…?" as a
 *     query instead of a scan. Pays off when there are many sessions. REMOVED
 *     after it wedged a session in testing: an attribute registered with the
 *     wrong type fails the workflow TASK, which retries forever with no visible
 *     error. Re-adding it requires registering the attributes AND verifying
 *     their types at worker startup, refusing to boot on a mismatch.
 *   - `proxyLocalActivities` — cheap reads without a task-queue round trip.
 *   - `CancellationScope.withTimeout` — a per-node wall-clock deadline that
 *     bounds retries too, which `startToCloseTimeout` does not.
 *   - `bundleWorkflowCode` at build time — removes 400-800ms of webpack from
 *     every worker boot.
 *   - `wf.log` / worker sinks — structured logging out of workflow code.
 *   - Client side: `signalWithStart` collapses create-then-prompt into one
 *     atomic call; `workflowIdConflictPolicy: USE_EXISTING` replaces the
 *     hand-rolled "existing session" branch.
 */

/* ------------------------------------------------------------------ */
/* Versioning                                                          */
/* ------------------------------------------------------------------ */

/**
 * PATCH IDS — how this workflow is allowed to change while sessions are live.
 *
 * A session workflow runs for as long as a canvas is open. Deploying a new
 * worker means the new code REPLAYS the histories of every session started on
 * the old one, and replay compares the commands the code issues now against
 * the commands recorded then. Any change to that command stream — adding or
 * removing a timer, an activity, a continue-as-new — makes replay fail with
 * `Nondeterminism error: No command scheduled for event …` and wedges the
 * session. Confirmed twice in this codebase, once by removing a `wf.sleep` and
 * once by changing a continue-as-new threshold.
 *
 * `wf.patched(id)` is the sanctioned escape. It records a marker on first
 * execution and returns true; replaying a history recorded BEFORE the patch
 * existed finds no marker and returns false, so old runs keep taking the old
 * branch and new runs take the new one.
 *
 * THE RULES, because getting these wrong is worse than not patching:
 *
 *   1. Any edit that adds, removes or reorders a command goes behind a patch.
 *      Emitting events, mutating state and reading queries do not — they are
 *      not commands. Timers, activities, continueAsNew and signals are.
 *   2. Call `patched()` from linear workflow code, never from inside a
 *      `wf.condition` predicate or a query handler. It writes a command, and a
 *      predicate is re-evaluated on every activation.
 *   3. Ids are permanent and never reused. Once every session predating a patch
 *      has closed, swap it for `deprecatePatch(id)` for one release, then
 *      delete both.
 */
const PATCH_NO_CASCADE_STAGGER = "plan-cascade-stagger-removed";

/**
 * Legacy pacing. Only reachable when replaying a session that started before
 * PATCH_NO_CASCADE_STAGGER — see the note at the reconciliation loop for why a
 * per-node timer was removed.
 */
const LEGACY_CASCADE_MS = 70;

/** Continue-as-new thresholds (PRD §7.4). */
const MAX_EVENTS = 2000;
const MAX_HISTORY_LENGTH = 4000;
/** How much of the log survives the boundary, for reconnecting clients. */
const TAIL_EVENTS = 250;

/* ------------------------------------------------------------------ */
/* Activity proxies                                                    */
/* ------------------------------------------------------------------ */

/**
 * Model activities: long timeout, few retries. A reasoning model can run for
 * minutes, and a prompt that fails validation twice will fail a third time.
 */
const { planGraph } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 2,
    nonRetryableErrorTypes: [
      "PlanValidationError",
      "StructuredOutputError",
      "TokenBudgetExhaustedError",
      "MissingEnvError",
    ],
  },
});

const { runChatNode } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "3 minutes",
  retry: {
    maximumAttempts: 2,
    nonRetryableErrorTypes: [
      "ChatValidationError",
      "EmptyAnalysisError",
      "StructuredOutputError",
      "TokenBudgetExhaustedError",
      "BlobNotFoundError",
      "MissingEnvError",
    ],
  },
});

/** Tool activities: retries with backoff — they fail for transient reasons too. */
const { runTool } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "1 minute",
  retry: {
    maximumAttempts: 4,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ["ToolValidationError", "MissingBinaryError", "BlobNotFoundError"],
  },
});

/**
 * Local activities: executed inside the workflow task, no task-queue round
 * trip. Correct for a stat() on the blob store, where the scheduling cost
 * exceeds the work and three history events per call would be noise in a
 * history that is also the audit trail.
 */
const { documentPresent } = wf.proxyLocalActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 2 },
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistributiveOmit<GraphEvent, "seq">;

/** Node fields that can be deleted rather than overwritten. */
type ClearableField = {
  [K in keyof GraphNode]-?: undefined extends GraphNode[K] ? K : never;
}[keyof GraphNode];

/**
 * Everything that describes a PRODUCED result, as opposed to what the user
 * authored. Cleared together whenever a node's result stops being true — on
 * re-run, and when the document it was derived from is detached. Leaving any of
 * it behind lets a stale claim, or a citation count for an answer that no
 * longer exists, sit under a node that has been reset.
 */
const RESULT_FIELDS: readonly ClearableField[] = [
  "result",
  "error",
  "log",
  "truncated",
  "verifiedCount",
  "unverifiedCount",
  "provenance",
  "startedAt",
  "finishedAt",
];

/**
 * Workflow time.
 *
 * @temporalio/workflow 1.21.1 exports no `now()` (CLAUDE.md and PRD §7.5 both
 * name one — see the report). The correct equivalent is `Date.now()`: the
 * workflow sandbox replaces the global Date with the deterministic workflow
 * clock, so this replays identically. Routing every timestamp through this one
 * function keeps that decision in a single place.
 */
function now(): number {
  return Date.now();
}

function readableError(err: unknown): string {
  const cause = wf.rootCause(err);
  if (cause !== undefined && cause !== null && cause !== "") return cause;
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* The workflow                                                        */
/* ------------------------------------------------------------------ */

export async function graphSessionWorkflow(input: GraphSessionInput): Promise<void> {
  const carried = input.carried;

  const graph: Graph = carried?.graph ?? { nodes: [], edges: [] };
  const events: GraphEvent[] = carried ? [...carried.tailEvents] : [];
  const pinned = new Set<string>(carried?.pinned ?? []);
  const generation = carried?.generation ?? 0;

  /**
   * SEQ RESEEDING — the subtle part of continue-as-new.
   *
   * `seq` is never reset to zero. The new run resumes from the highest seq the
   * previous run ever assigned, and the carried tail keeps its ORIGINAL seq
   * values. Two consequences, both required:
   *
   *   - A client sitting at cursor C receives exactly the events it missed, with
   *     the same numbers it would have received had no boundary occurred.
   *   - The next emitted event is `seq + 1`, strictly greater than anything any
   *     client has ever seen. Cursors stay monotonic across the boundary, so the
   *     SSE pump never rewinds and never replays.
   *
   * The `Math.max` is belt-and-braces: `carried.seq` should already equal the
   * last tail event's seq, and if a future change to the carry logic ever broke
   * that, silently renumbering events would be far worse than the redundancy.
   */
  let seq = carried?.seq ?? 0;
  for (const e of events) if (e.seq > seq) seq = e.seq;

  let nodeCounter = carried?.nodeCounter ?? 0;
  let edgeCounter = carried?.edgeCounter ?? 0;

  let closed = false;
  let running = false;

  function emit(draft: EventDraft): void {
    seq += 1;
    events.push({ ...draft, seq } as GraphEvent);
  }

  function chat(role: "user" | "assistant" | "system", text: string): void {
    emit({ t: "chat", role, text });
  }

  function nextNodeId(): string {
    nodeCounter += 1;
    return `n${nodeCounter}`;
  }

  function nextEdgeId(): string {
    edgeCounter += 1;
    return `e${edgeCounter}`;
  }

  const nodeById = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);

  /**
   * Single write path for node state, so every mutation produces an event.
   *
   * `clear` names fields to DELETE. It exists because `patch: { blob: undefined }`
   * cannot express removal: JSON serialization drops undefined-valued keys, so
   * the field never crosses the wire and the browser's spread-merge keeps the
   * old value. Observed before this existed — after `detachBlob` the canvas
   * still showed the document attached and its stale result while the
   * authoritative graph had neither. In a legal tool that is the screen lying
   * about what the pipeline will run on.
   */
  function patchNode(
    id: string,
    patch: Partial<GraphNode>,
    clear: readonly ClearableField[] = [],
  ): void {
    const node = nodeById(id);
    if (node === undefined) return;
    Object.assign(node, patch);
    for (const k of clear) delete node[k];
    emit(
      clear.length === 0
        ? { t: "node.updated", id, patch }
        : { t: "node.updated", id, patch, clear: [...clear] },
    );
  }

  function setStatus(
    id: string,
    status: NodeStatus,
    extra: Partial<GraphNode> = {},
    clear: readonly ClearableField[] = [],
  ): void {
    patchNode(id, { status, ...extra }, clear);
  }

  /**
   * Re-runs the pure layout over the whole graph. Nodes the user has dragged
   * are pinned and win over layout — layout only ever assigns positions the
   * user has not chosen.
   */
  function relayout(skip: ReadonlySet<string>): void {
    const positions = layout(
      graph.nodes.map((n) => n.id),
      graph.edges,
    );
    for (const node of graph.nodes) {
      if (pinned.has(node.id) || skip.has(node.id)) continue;
      const p = positions[node.id];
      if (p === undefined) continue;
      if (node.position.x === p.x && node.position.y === p.y) continue;
      node.position = p;
      emit({ t: "node.updated", id: node.id, patch: { position: p } });
    }
  }

  /**
   * Delete a node and everything pointing at it. Incident edges go FIRST, so a
   * client applying events in order never holds an edge referencing a node it
   * has already deleted.
   */
  function removeNode(id: string): void {
    const idx = graph.nodes.findIndex((n) => n.id === id);
    if (idx === -1) return;
    for (const edge of graph.edges.filter((e) => e.source === id || e.target === id)) {
      graph.edges = graph.edges.filter((e) => e.id !== edge.id);
      emit({ t: "edge.removed", id: edge.id });
    }
    graph.nodes.splice(idx, 1);
    pinned.delete(id);
    emit({ t: "node.removed", id });
  }

  function newNode(fields: Partial<GraphNode> & Pick<GraphNode, "id" | "kind" | "label">): GraphNode {
    return {
      position: { x: 0, y: 0 },
      params: {},
      status: "idle",
      outputs: [],
      citations: [],
      ...fields,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Planning — progressive                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Live state for the plan currently being generated.
   *
   * The planning activity signals us as the model finishes each node, so
   * materialisation happens in the signal handler rather than after the await.
   * This holds what those handlers need: which plan is current, the tempId ->
   * real id mapping, and edges that arrived before both their endpoints did.
   */
  let planId = 0;
  const plannedIds = new Map<string, string>();
  let pendingEdges: { source: string; target: string }[] = [];

  const resolveHandle = (handle: string): string | undefined =>
    plannedIds.get(handle) ?? (nodeById(handle) !== undefined ? handle : undefined);

  /**
   * Materialise one planned node. Ids and positions are assigned HERE — the
   * signal carries neither, so the model still cannot pick a coordinate or an
   * id and replay is unaffected.
   *
   * Idempotent by tempId within a plan: a retried activity, or a late signal
   * that races the activity's return value, must not create the node twice.
   */
  function materialiseNode(pn: {
    tempId: string;
    kind: GraphNode["kind"];
    label: string;
    prompt?: string;
    toolId?: string;
    params?: Record<string, unknown>;
  }): boolean {
    if (plannedIds.has(pn.tempId)) return false;
    const id = nextNodeId();
    plannedIds.set(pn.tempId, id);
    const node = newNode({
      id,
      kind: pn.kind,
      label: pn.label,
      params: pn.params ?? {},
      ...(pn.prompt === undefined ? {} : { prompt: pn.prompt }),
      ...(pn.toolId === undefined ? {} : { toolId: pn.toolId }),
    });
    graph.nodes.push(node);
    // Place it before announcing it, so it arrives where it belongs instead of
    // appearing at the origin and jumping.
    const positions = layout(graph.nodes.map((n) => n.id), graph.edges);
    node.position = positions[node.id] ?? { x: 80, y: 80 };
    emit({ t: "node.added", node });
    // The rest of the graph may need to shift to make room for it. Only nodes
    // that actually moved emit an update.
    relayout(new Set([node.id]));
    return true;
  }

  /** Create an edge if both endpoints exist now; otherwise keep it pending. */
  function materialiseEdge(source: string, target: string): boolean {
    const s = resolveHandle(source);
    const t = resolveHandle(target);
    if (s === undefined || t === undefined || s === t) return false;
    if (graph.edges.some((e) => e.source === s && e.target === t)) return true;
    const edge: GraphEdge = { id: nextEdgeId(), source: s, target: t };
    graph.edges.push(edge);
    emit({ t: "edge.added", edge });
    relayout(new Set());
    return true;
  }

  /**
   * Drain edges whose endpoints have since arrived.
   *
   * Interleaving is the point: an edge appears the moment both its nodes exist,
   * so the graph draws itself in pipeline order rather than nodes popping in
   * and every edge snapping into place at the end.
   */
  function flushPendingEdges(): void {
    if (pendingEdges.length === 0) return;
    const still: { source: string; target: string }[] = [];
    for (const e of pendingEdges) {
      if (!materialiseEdge(e.source, e.target)) still.push(e);
    }
    pendingEdges = still;
  }

  function offerEdge(source: string, target: string): void {
    if (!materialiseEdge(source, target)) pendingEdges.push({ source, target });
  }

  async function handlePrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") return;

    chat("user", trimmed);
    emit({ t: "plan.started" });

    // A new plan invalidates any signal still in flight from the previous one,
    // and resets the tempId namespace: "a" means a different node each time.
    planId += 1;
    const thisPlan = planId;
    plannedIds.clear();
    pendingEdges = [];

    let plan: Awaited<ReturnType<typeof planGraph>>;
    try {
      plan = await planGraph({
        prompt: trimmed,
        planId: thisPlan,
        existing: {
          nodes: graph.nodes.map((n) => ({
            id: n.id,
            kind: n.kind,
            label: n.label,
            ...(n.toolId === undefined ? {} : { toolId: n.toolId }),
            hasDocument: n.blob !== undefined,
          })),
          edges: graph.edges.map((e) => ({ source: e.source, target: e.target })),
        },
      });
    } catch (err) {
      const message = readableError(err);
      chat("system", `Could not plan that: ${message}`);
      emit({ t: "plan.finished", ok: false, error: message });
      return;
    }

    if (plan.reply !== "") chat("assistant", plan.reply);
    // A hallucinated tool is a validation error surfaced in chat, not a broken
    // node — the offending node never reaches the canvas.
    for (const w of plan.warnings) chat("system", w);

    /**
     * Reconcile whatever did not stream.
     *
     * The activity's return value is the source of truth; streaming is an
     * optimisation on top of it. The last node of the plan never streams (it is
     * only settled when the stream ends), a dropped signal loses one, and an
     * endpoint that does not stream at all loses every one — all three land
     * here, and the graph is identical either way.
     *
     * There is deliberately NO artificial stagger here. `wf.sleep(70)` per node
     * looks free and is not: every timer is a workflow task round trip, and
     * measured on a six-node fallback plan it stretched emission from
     * instantaneous to roughly a second per node — five seconds of the user
     * watching a slideshow, after they had already waited for the model. When
     * streaming works the model's own pacing is the cascade; when it does not,
     * arriving at once is honest and fast, and pacing belongs to the client
     * animating its own arrivals.
     */
    // Read the patch ONCE, in linear code, before the loop: `patched` writes a
    // command, and calling it per iteration would write one per node.
    const staggerRemoved = wf.patched(PATCH_NO_CASCADE_STAGGER);
    for (const pn of plan.nodes) {
      if (!materialiseNode(pn)) continue;
      for (const source of pn.after ?? []) offerEdge(source, pn.tempId);
      flushPendingEdges();
      // Sessions that started before the stagger was removed have a
      // TimerStarted per node in their history and must keep issuing it, or
      // they fail replay the moment this build reaches them.
      if (!staggerRemoved) await wf.sleep(LEGACY_CASCADE_MS);
    }
    for (const pe of plan.edges) offerEdge(pe.source, pe.target);
    flushPendingEdges();
    // Anything still pending references a node that was never created.
    pendingEdges = [];

    emit({ t: "plan.finished", ok: true });
  }

  /* ---------------------------------------------------------------- */
  /* Mutations                                                         */
  /* ---------------------------------------------------------------- */

  /** Applies a mutation. Returns the id it assigned, for ops that create one. */
  function handleMutation(m: GraphMutation): string | undefined {
    switch (m.op) {
      case "addNode": {
        const node = newNode({
          id: nextNodeId(),
          kind: m.kind,
          label: m.label ?? m.kind,
          position: m.position,
          ...(m.toolId === undefined ? {} : { toolId: m.toolId }),
        });
        // The user chose where it goes, so layout must not move it.
        pinned.add(node.id);
        graph.nodes.push(node);
        emit({ t: "node.added", node });
        return node.id;
      }

      case "moveNode": {
        if (nodeById(m.id) === undefined) return;
        pinned.add(m.id);
        patchNode(m.id, { position: m.position });
        return undefined;
      }

      case "updateNode": {
        if (nodeById(m.id) === undefined) return;
        const patch: Partial<GraphNode> = {};
        if (m.patch.label !== undefined) patch.label = m.patch.label;
        if (m.patch.prompt !== undefined) patch.prompt = m.patch.prompt;
        if (m.patch.params !== undefined) patch.params = m.patch.params;
        // `value` is the canonical home for an input node's text.
        if (m.patch.value !== undefined) patch.value = m.patch.value;
        // Re-pointing a node at a different tool: the planner guesses, the user
        // corrects. Params belonged to the old tool's form, so drop them unless
        // this same mutation supplies replacements.
        if (m.patch.toolId !== undefined) {
          patch.toolId = m.patch.toolId;
          if (m.patch.params === undefined) patch.params = {};
        }
        if (Object.keys(patch).length === 0) return;
        patchNode(m.id, patch);
        return undefined;
      }

      case "removeNode": {
        removeNode(m.id);
        return undefined;
      }

      case "connect": {
        if (m.source === m.target) return;
        if (nodeById(m.source) === undefined || nodeById(m.target) === undefined) return;
        if (graph.edges.some((e) => e.source === m.source && e.target === m.target)) return;
        const edge: GraphEdge = { id: nextEdgeId(), source: m.source, target: m.target };
        graph.edges.push(edge);
        emit({ t: "edge.added", edge });
        return edge.id;
      }

      case "disconnect": {
        const edge = graph.edges.find((e) => e.id === m.id);
        if (edge === undefined) return;
        graph.edges = graph.edges.filter((e) => e.id !== m.id);
        emit({ t: "edge.removed", id: m.id });
        return undefined;
      }

      case "attachBlob": {
        const node = nodeById(m.id);
        if (node === undefined) return;
        const patch: Partial<GraphNode> = { blob: m.blob, status: "idle" };
        // A freshly-dropped document node is usually still called "document".
        if (node.label === "" || node.label === node.kind) patch.label = m.blob.filename;
        patchNode(m.id, patch);
        return undefined;
      }

      case "detachBlob": {
        const node = nodeById(m.id);
        if (node === undefined || node.blob === undefined) return;
        // Results downstream of this node were derived from the removed bytes,
        // so this node's own outputs go too — leaving them would let a stale
        // artifact keep flowing downstream under a document that is no longer
        // attached, which is precisely the provenance break the audit trail
        // exists to prevent. Re-running is what re-derives them.
        patchNode(
          m.id,
          { outputs: [], citations: [], status: "idle" },
          ["blob", ...RESULT_FIELDS],
        );
        return undefined;
      }
    }
  }

  /**
   * Why a mutation cannot be applied, or null if it can.
   *
   * PURE AND SIDE-EFFECT FREE. This runs as an update VALIDATOR, before
   * anything is written to history — a rejection here costs the client a 4xx
   * and costs the workflow nothing, whereas the same check inside the handler
   * would already have committed the update. It must therefore never emit,
   * never mutate, and never await.
   *
   * The rules are the same ones the canvas enforces on the gesture; this is the
   * authoritative copy, because a browser can be out of date and a determined
   * caller can skip the UI entirely.
   */
  function rejectReason(m: GraphMutation): string | null {
    switch (m.op) {
      case "addNode":
        if (m.toolId !== undefined && !hasManifest(m.toolId)) {
          return `"${m.toolId}" is not a registered tool.`;
        }
        return null;

      case "moveNode":
      case "removeNode":
        return nodeById(m.id) === undefined ? `Node ${m.id} does not exist.` : null;

      case "updateNode": {
        if (nodeById(m.id) === undefined) return `Node ${m.id} does not exist.`;
        if (m.patch.toolId !== undefined && !hasManifest(m.patch.toolId)) {
          return `"${m.patch.toolId}" is not a registered tool.`;
        }
        return null;
      }

      case "connect": {
        if (m.source === m.target) return "A node cannot be connected to itself.";
        const source = nodeById(m.source);
        const target = nodeById(m.target);
        if (source === undefined) return `Node ${m.source} does not exist.`;
        if (target === undefined) return `Node ${m.target} does not exist.`;
        if (graph.edges.some((e) => e.source === m.source && e.target === m.target)) {
          return "Those nodes are already connected.";
        }
        // Data flow must be acyclic, and catching it HERE is the difference
        // between an edge the user cannot draw and a graph that only reveals
        // itself as unrunnable when they press Run.
        if (reachable(m.target, m.source)) {
          return "That connection would create a cycle. Data flow must be acyclic.";
        }
        // A tool declares how many inputs it takes. Enforced at the edge rather
        // than at Run, so the canvas cannot be arranged into a shape the tool
        // will refuse — the manifest is shared with the browser precisely so
        // both sides can apply the same rule.
        if (target.kind === "tool" && target.toolId !== undefined && hasManifest(target.toolId)) {
          const { maxInputs, label } = manifestById(target.toolId);
          if (maxInputs !== null) {
            const incoming = graph.edges.filter((e) => e.target === m.target).length;
            if (incoming >= maxInputs) {
              return `${label} accepts at most ${maxInputs} input(s) and already has ${incoming}.`;
            }
          }
        }
        return null;
      }

      case "disconnect":
        return graph.edges.some((e) => e.id === m.id) ? null : `Edge ${m.id} does not exist.`;

      case "attachBlob": {
        const node = nodeById(m.id);
        if (node === undefined) return `Node ${m.id} does not exist.`;
        if (node.kind !== "document") {
          return `A document can only be attached to a document node, not to a ${node.kind} node.`;
        }
        return null;
      }

      case "detachBlob": {
        const node = nodeById(m.id);
        if (node === undefined) return `Node ${m.id} does not exist.`;
        return node.blob === undefined ? "That node has no document attached." : null;
      }
    }
  }

  /** Is `to` reachable from `from` along current edges? Pure. */
  function reachable(from: string, to: string): boolean {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (v === to) return true;
      if (seen.has(v)) continue;
      seen.add(v);
      for (const e of graph.edges) if (e.source === v) stack.push(e.target);
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Execution                                                         */
  /* ---------------------------------------------------------------- */

  /** Artifacts a node offers downstream: what it produced, else what it holds. */
  function outputsOf(node: GraphNode): BlobRef[] {
    if (node.outputs.length > 0) return node.outputs;
    return node.blob === undefined ? [] : [node.blob];
  }

  /**
   * The original document an artifact was derived from.
   *
   * Walks upstream from `nodeId` to the nearest attached document. A chat node
   * is normally fed extracted text, and verification can only match against
   * that text — so `Citation.blob` is the `.txt`. Linking a lawyer to a .txt
   * with no pages instead of the contract is not "one click from any claim",
   * so the graph supplies the origin the activity cannot know. Pure traversal
   * over arrays: deterministic, replay-safe.
   */
  function sourceDocumentFor(nodeId: string, artifact: BlobRef): BlobRef | undefined {
    if (artifact.mime === "application/pdf") return undefined;
    const seen = new Set<string>([nodeId]);
    let frontier = graph.edges.filter((e) => e.target === nodeId).map((e) => e.source);
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const n = nodeById(id);
        if (n?.blob !== undefined) return n.blob;
        for (const e of graph.edges) if (e.target === id) next.push(e.source);
      }
      frontier = next;
    }
    return undefined;
  }

  async function executeGraph(): Promise<void> {
    if (running) {
      chat("system", "A run is already in progress.");
      return;
    }
    if (graph.nodes.length === 0) {
      chat("system", "Nothing to run — the canvas is empty.");
      return;
    }

    running = true;
    emit({ t: "run.started" });
    // `wf.log` is the deterministic logger: it is suppressed on replay, so it
    // cannot double-log, and it carries workflow id/run id automatically.
    // Nothing inside this workflow logged at all before.
    wf.log.info("run started", { nodes: graph.nodes.length, edges: graph.edges.length });

    try {
      const ids = graph.nodes.map((n) => n.id);
      const known = new Set(ids);

      // Dedupe edges first: a duplicated edge would double-count indegree and
      // deadlock the topological sort.
      const seenEdge = new Set<string>();
      const edges: { source: string; target: string }[] = [];
      for (const e of graph.edges) {
        if (!known.has(e.source) || !known.has(e.target)) continue;
        const key = `${e.source} ${e.target}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push(e);
      }

      const preds = new Map<string, string[]>(ids.map((i) => [i, []]));
      const succs = new Map<string, string[]>(ids.map((i) => [i, []]));
      const indegree = new Map<string, number>(ids.map((i) => [i, 0]));
      for (const e of edges) {
        preds.get(e.target)!.push(e.source);
        succs.get(e.source)!.push(e.target);
        indegree.set(e.target, indegree.get(e.target)! + 1);
      }

      // Kahn's algorithm. Iterating `ids` in graph order keeps the result
      // deterministic, which keeps replay deterministic.
      const queue = ids.filter((i) => indegree.get(i) === 0);
      const order: string[] = [];
      while (queue.length > 0) {
        const id = queue.shift()!;
        order.push(id);
        for (const t of succs.get(id)!) {
          const d = indegree.get(t)! - 1;
          indegree.set(t, d);
          if (d === 0) queue.push(t);
        }
      }

      if (order.length !== ids.length) {
        const cyclic = ids.filter((i) => !order.includes(i));
        for (const id of cyclic) {
          setStatus(id, "error", {
            error: "This node is part of a cycle. Data flow must be acyclic.",
            finishedAt: now(),
          });
        }
        const message = `The graph contains a cycle (${cyclic.join(", ")}). Nothing was run.`;
        chat("system", message);
        emit({ t: "run.finished", ok: false, error: message });
        return;
      }

      for (const id of order) {
        // Clear, not overwrite: a stale error left on a node that is now queued
        // reads as a fresh failure. See patchNode on why `undefined` cannot do
        // this over the wire.
        setStatus(id, "queued", { citations: [] }, RESULT_FIELDS);
      }

      const outcome = new Map<string, "done" | "error">();

      async function execute(id: string): Promise<void> {
        const node = nodeById(id);
        if (node === undefined) return;

        setStatus(id, "running", { startedAt: now() });

        const upstream = preds.get(id)!.map((p) => nodeById(p)).filter((n): n is GraphNode => n !== undefined);
        const inputs = upstream.flatMap(outputsOf);

        try {
          switch (node.kind) {
            case "document": {
              if (node.blob === undefined) {
                throw new Error("No document is attached to this node.");
              }
              // Confirm the bytes are still there before declaring this node a
              // source. Without it a pruned or never-uploaded blob surfaces
              // three nodes downstream as an opaque tool failure, pointing at
              // the wrong step.
              if (!(await documentPresent(node.blob.sha256))) {
                throw new Error(
                  `"${node.blob.filename}" is no longer in the document store. ` +
                    `Re-attach the file and run again.`,
                );
              }
              setStatus(id, "done", {
                outputs: [node.blob],
                result: `${node.blob.filename} (${node.blob.bytes} bytes)`,
                finishedAt: now(),
              });
              break;
            }

            case "input": {
              // Through `nodeInputText`, never off one field: the canonical home
              // is `value`, but `params.text` and `prompt` have both been
              // written by different paths, and reading only one meant a user
              // could type into an input node and have it silently ignored.
              setStatus(id, "done", { result: nodeInputText(node), finishedAt: now() });
              break;
            }

            case "output": {
              setStatus(id, "done", {
                outputs: inputs,
                result:
                  inputs.length === 0
                    ? "No artifacts arrived at this output."
                    : inputs.map((b) => b.filename).join("\n"),
                finishedAt: now(),
              });
              break;
            }

            case "tool": {
              if (node.toolId === undefined) {
                throw new Error("This tool node has no toolId.");
              }
              const res = await runTool({
                nodeId: id,
                toolId: node.toolId,
                params: node.params,
                inputs,
              });
              setStatus(id, "done", {
                outputs: res.outputs,
                result: res.log,
                finishedAt: now(),
                // Which build, and which version of each binary, produced these
                // bytes. An unpinned upgrade that changes a conversion breaks
                // the audit trail, not just the build (CLAUDE.md §Tools).
                provenance: {
                  toolVersion: `${res.toolId}@${res.workerBuildId}`,
                  binaries: res.binaries,
                },
              });
              break;
            }

            case "chat": {
              // Upstream `input` nodes contribute typed context to the prompt.
              const context = upstream
                .filter((u) => u.kind === "input" && (u.result ?? nodeInputText(u)) !== "")
                .map((u) => `${u.label}: ${u.result ?? nodeInputText(u)}`)
                .join("\n");
              const prompt = context === "" ? (node.prompt ?? "") : `${context}\n\n${node.prompt ?? ""}`;

              // Where each input actually came from, so a verified citation
              // links to the CONTRACT rather than to the derived .txt that
              // verification had to match against.
              const origins = inputs
                .map((b) => ({ blob: b.sha256, source: sourceDocumentFor(id, b) }))
                .filter((o): o is { blob: string; source: BlobRef } => o.source !== undefined);

              const res = await runChatNode({
                nodeId: id,
                label: node.label,
                prompt,
                documents: inputs,
                origins,
              });
              // The evidence BEHIND the answer travels WITH the answer.
              //
              // "pages 41-200 were never sent", "the quote is on page 7, not
              // 12 — corrected", "no text could be extracted, this is probably
              // a scan" were all computed, returned by the activity, and then
              // dropped. The node making the legal claims was the only node
              // showing none of its working, and an answer covering 40 of 200
              // pages looked identical to one covering all 200.
              setStatus(id, "done", {
                // The analysis as a file, so it flows downstream into
                // template.apply / convert / an output node. `result` stays for
                // on-node display.
                outputs: res.outputs,
                result: res.answer,
                citations: res.citations,
                log: res.log,
                truncated: res.truncated,
                verifiedCount: res.verifiedCount,
                unverifiedCount: res.unverifiedCount,
                provenance: {
                  model: res.usage.modelId,
                  promptVersion: `${res.promptVersion} ${res.verifierVersion} ${res.workerBuildId}`,
                },
                finishedAt: now(),
              });
              break;
            }
          }
          outcome.set(id, "done");
        } catch (err) {
          setStatus(id, "error", { error: readableError(err), finishedAt: now() });
          outcome.set(id, "error");
        }
      }

      /**
       * Build one promise per node in topological order. Because the order is
       * topological, every predecessor's promise already exists when we reach a
       * node, so no recursion and no cycle risk. Independent nodes run
       * concurrently: a node waits only on its own predecessors.
       */
      const promises = new Map<string, Promise<void>>();
      for (const id of order) {
        const upstreamPromises = preds.get(id)!.map((p) => promises.get(p)!);
        promises.set(
          id,
          (async () => {
            await Promise.all(upstreamPromises);

            const failed = preds.get(id)!.filter((p) => outcome.get(p) !== "done");
            if (failed.length > 0) {
              // A failed node marks its downstream closure `error` WITHOUT
              // running it. Because this check happens inside each node's own
              // promise, the whole transitive closure is covered.
              const names = failed
                .map((p) => {
                  const n = nodeById(p);
                  return n === undefined ? p : `${n.label} (${p})`;
                })
                .join(", ");
              setStatus(id, "error", {
                error: `Not run: upstream ${names} did not complete.`,
                finishedAt: now(),
              });
              outcome.set(id, "error");
              return;
            }

            await execute(id);
          })(),
        );
      }

      await Promise.all([...promises.values()]);

      const failedCount = [...outcome.values()].filter((v) => v === "error").length;
      wf.log.info("run finished", { total: order.length, failed: failedCount });
      if (failedCount === 0) {
        emit({ t: "run.finished", ok: true });
      } else {
        emit({
          t: "run.finished",
          ok: false,
          error: `${failedCount} of ${order.length} node(s) did not complete.`,
        });
      }
    } catch (err) {
      const message = readableError(err);
      chat("system", `The run failed: ${message}`);
      emit({ t: "run.finished", ok: false, error: message });
    } finally {
      running = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Handlers                                                          */
  /* ---------------------------------------------------------------- */

  wf.setHandler(submitPrompt, async ({ text }) => {
    if (closed) return;
    await handlePrompt(text);
  });

  /**
   * The authoritative edit path.
   *
   * The validator rejects before anything reaches history, so an invalid edit
   * costs the caller an error and the workflow nothing — and the caller gets
   * back the id the workflow assigned plus the seq its events landed at, which
   * is what removes the need to guess an id optimistically and repair from
   * `getGraph` afterwards.
   */
  wf.setHandler(
    applyMutation,
    (m): UpdateResults["applyMutation"] => {
      const id = handleMutation(m);
      return { seq, ...(id === undefined ? {} : { id }) };
    },
    {
      validator: (m): void => {
        if (closed) {
          throw wf.ApplicationFailure.nonRetryable(
            "This session is closed and no longer accepts edits.",
            MUTATION_REJECTED,
          );
        }
        const why = rejectReason(m);
        if (why !== null) {
          throw wf.ApplicationFailure.nonRetryable(why, MUTATION_REJECTED);
        }
      },
    },
  );

  /**
   * @deprecated The signal form. Kept working while the web app migrates to the
   * update, and deliberately identical to its old behaviour: it cannot report a
   * rejection, so an invalid mutation is dropped silently — which is exactly the
   * bug the update exists to remove. Delete once nothing sends it.
   */
  wf.setHandler(mutateGraph, (m) => {
    if (closed) return;
    if (rejectReason(m) !== null) return;
    handleMutation(m);
  });

  /**
   * Progressive planning. The planner signals these as the model finishes each
   * node, seconds before the plan as a whole exists.
   *
   * `planId` is what makes them safe: a signal from a superseded plan, or a
   * replayed one from a retried activity, is ignored rather than creating a
   * node under a tempId that now means something else. Materialisation itself
   * is idempotent by tempId, so a late signal racing the activity's return
   * value is a no-op rather than a duplicate.
   */
  wf.setHandler(planNodeStreamed, ({ planId: id, node, edges }) => {
    if (closed || id !== planId) return;
    if (!materialiseNode(node)) return;
    // The node's own inbound links, drawn in the SAME activation that created
    // it — this is what `after` buys: a box and its wire appear together
    // instead of every wire snapping on after the last box.
    for (const e of edges ?? []) offerEdge(e.source, e.target);
    flushPendingEdges();
  });

  wf.setHandler(planEdgeStreamed, ({ planId: id, edge }) => {
    if (closed || id !== planId) return;
    offerEdge(edge.source, edge.target);
  });

  /**
   * The streaming rung lost. Everything it put on the canvas came from an
   * object that was then thrown away, so it comes back off before the winning
   * plan is reconciled — otherwise the canvas keeps nodes that are in no plan.
   */
  wf.setHandler(planDiscardStreamed, ({ planId: id }) => {
    if (closed || id !== planId) return;
    for (const nodeId of plannedIds.values()) removeNode(nodeId);
    plannedIds.clear();
    pendingEdges = [];
  });

  wf.setHandler(runGraph, async () => {
    if (closed) return;
    await executeGraph();
  });

  wf.setHandler(close, () => {
    closed = true;
  });

  // Queries must be side-effect free: the SSE pump calls getEventsSince at ~8Hz.
  wf.setHandler(getEventsSince, (cursor) => events.filter((e) => e.seq > cursor));
  wf.setHandler(getGraph, () => graph);
  wf.setHandler(getSessionInfo, () => ({
    sessionId: input.sessionId,
    seq,
    oldestSeq: events.length === 0 ? seq + 1 : events[0].seq,
    running,
    closed,
    generation,
  }));

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  function shouldContinue(): boolean {
    const info = wf.workflowInfo();
    return (
      events.length > MAX_EVENTS ||
      info.historyLength > MAX_HISTORY_LENGTH ||
      info.continueAsNewSuggested
    );
  }

  while (!closed) {
    // Park. Handlers do the work; we wake only to close or to roll over.
    await wf.condition(() => closed || shouldContinue());
    if (closed) break;

    // Never roll over mid-handler: a run in flight would lose its activity
    // results. allHandlersFinished covers async signal handlers, which is where
    // planning and execution actually happen.
    await wf.condition(wf.allHandlersFinished);
    if (closed) break;
    if (!shouldContinue()) continue;

    wf.log.info("continue-as-new", {
      generation: generation + 1,
      seq,
      events: events.length,
      historyLength: wf.workflowInfo().historyLength,
    });
    await wf.continueAsNew<typeof graphSessionWorkflow>({
      sessionId: input.sessionId,
      carried: {
        graph,
        // The tail keeps its original seq values; `seq` carries the high-water
        // mark. Together they make cursors monotonic across the boundary.
        tailEvents: events.slice(-TAIL_EVENTS),
        seq,
        nodeCounter,
        edgeCounter,
        pinned: [...pinned],
        generation: generation + 1,
      },
    });
  }

  // Let in-flight handlers finish before the workflow completes, or their
  // results are silently dropped.
  await wf.condition(wf.allHandlersFinished);
}
