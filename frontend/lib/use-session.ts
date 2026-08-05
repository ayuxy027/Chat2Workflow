"use client";

/**
 * Session state for one canvas.
 *
 * The browser holds a *replica* of the graph the Temporal workflow owns (PRD §7.1).
 * Everything that changes the replica — an optimistic local edit, a frame off the
 * SSE stream, a repair snapshot — is expressed as a `GraphEvent` and folded in by
 * `applyEvent`. There is deliberately no second write path.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: the canvas never shows graph state the
 * workflow has not accepted. An optimistic edit is a *prediction*, and a
 * prediction that turns out wrong has to be withdrawn. Three mechanisms enforce
 * it, because in a legal tool a canvas that disagrees with the audit trail is a
 * correctness failure, not a cosmetic one:
 *
 *   1. Optimistic events carry a NEGATIVE `seq` and never advance the cursor, so
 *      the authoritative event that follows is not mistaken for a replay.
 *   2. An optimistic edit only invents an id when the authoritative event can be
 *      matched back to it (`applyEvent` swaps the id in). Where it cannot —
 *      `addNode` — there is no optimistic event at all.
 *   3. A signal the server did not ACCEPT (network failure, or any non-2xx —
 *      `fetch` does not reject on 4xx/5xx) discards the replica and re-adopts
 *      the workflow's graph, and says so.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type {
  EdgeChange,
  NodeChange,
  OnConnect,
  OnEdgesChange,
  OnNodesChange,
} from "@xyflow/react";
import { BlobRef, Graph, GraphEvent } from "@wf/shared";
import type { GraphMutation } from "@wf/shared";
import {
  applyEvent,
  isLocalId,
  mutationToEvents,
  reconcileFlowEdges,
  reconcileFlowNodes,
  type WfEdge,
  type WfNode,
} from "./graph-adapter";

export type SessionStatus = "idle" | "planning" | "running" | "error";
export type ChatMessage = Extract<GraphEvent, { t: "chat" }>;

/**
 * Whether the browser is actually hearing from the workflow.
 *
 * Separate from `SessionStatus`, which is about the *work*. Both have to be
 * visible: "the run failed" and "I have not been able to reach the server for
 * thirty seconds" are different problems with different fixes, and the second
 * one used to render as an idle canvas that simply never changed.
 */
export type TransportState =
  | "connecting"
  | "live"
  /** Connected, but the server has stopped getting answers out of Temporal. */
  | "stalled"
  | "retrying"
  | "ended";

export interface Transport {
  state: TransportState;
  /** Human-readable reason, shown next to the indicator. */
  detail?: string;
}

export interface SessionApi {
  sessionId: string;
  graph: Graph;
  nodes: WfNode[];
  edges: WfEdge[];
  chat: ChatMessage[];
  status: SessionStatus;
  error?: string;
  transport: Transport;
  sendPrompt(text: string): void;
  mutate(mutation: GraphMutation): void;
  run(): void;
  attachDocument(nodeId: string, file: File): Promise<void>;
  /** Abandon this session and start an empty one. */
  reset(): void;
  onNodesChange: OnNodesChange<WfNode>;
  onEdgesChange: OnEdgesChange<WfEdge>;
  onConnect: OnConnect;
}

/* -------------------------------------------------------------------------- */
/* Reducer                                                                    */
/* -------------------------------------------------------------------------- */

interface SessionState {
  graph: Graph;
  chat: ChatMessage[];
  status: SessionStatus;
  /** Highest authoritative `seq` applied. Sent on reconnect so nothing is missed. */
  cursor: number;
  error?: string;
}

type Action =
  /** From the authority. Advances the cursor. */
  | { kind: "remote"; event: GraphEvent }
  /**
   * Applied ahead of confirmation. Carries a negative `seq` and never advances
   * the cursor, so the authoritative event that follows is not mistaken for a
   * replay and dropped.
   */
  | { kind: "local"; event: GraphEvent }
  /**
   * The workflow's own graph, adopted wholesale. Used to repair the replica
   * after a rejected edit and to close the gap a `continueAsNew` leaves in the
   * event log. `cursor` moves only when the caller knows which `seq` the
   * snapshot corresponds to.
   */
  | { kind: "sync"; graph: Graph; cursor?: number }
  /** A message for the user that changes nothing about the graph. */
  | { kind: "notice"; error: string };

const initialState = (): SessionState => ({
  graph: { nodes: [], edges: [] },
  chat: [],
  status: "idle",
  cursor: 0,
});

function reduce(state: SessionState, action: Action): SessionState {
  if (action.kind === "sync") {
    return {
      ...state,
      graph: action.graph,
      cursor: action.cursor === undefined ? state.cursor : action.cursor,
    };
  }
  if (action.kind === "notice") return { ...state, error: action.error };

  const { event } = action;
  const authoritative = action.kind === "remote";

  // Reconnect replays everything after the cursor; anything at or before it has
  // already been folded in, and these events are not idempotent for chat.
  if (authoritative && event.seq <= state.cursor) return state;

  const base: SessionState = authoritative
    ? { ...state, cursor: event.seq }
    : { ...state };

  switch (event.t) {
    case "chat": {
      /*
       * The same message under a different `seq`.
       *
       * A prompt is echoed locally so the transcript reacts to the keystroke,
       * and the workflow logs its own `chat("user", …)` when it takes the
       * signal. Appending both puts the user's question in the panel twice
       * (verified end to end against the real planner) — and this transcript is
       * the record of what was asked, so a duplicate is a wrong record, not
       * just a cosmetic repeat. The authoritative copy replaces the optimistic
       * one, matched on role and text among the unconfirmed (negative-seq)
       * entries only.
       */
      if (authoritative) {
        const pending = state.chat.findIndex(
          (m) => m.seq < 0 && m.role === event.role && m.text === event.text,
        );
        if (pending !== -1) {
          const chat = [...state.chat];
          chat[pending] = event;
          return { ...base, chat };
        }
      }
      return { ...base, chat: [...state.chat, event] };
    }

    case "plan.started":
      return { ...base, status: "planning", error: undefined };

    case "plan.finished":
      return {
        ...base,
        status: event.ok ? "idle" : "error",
        error: event.ok ? undefined : event.error,
      };

    case "run.started":
      return { ...base, status: "running", error: undefined };

    case "run.finished":
      return {
        ...base,
        status: event.ok ? "idle" : "error",
        error: event.ok ? undefined : event.error,
      };

    default:
      return { ...base, graph: applyEvent(state.graph, event) };
  }
}

/* -------------------------------------------------------------------------- */
/* Transport helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Per-tab session id, so reload reattaches instead of orphaning a workflow. */
const SESSION_KEY = "wf.sessionId";

/** Reconnect backoff, capped. Jittered — see `backoff`. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 20_000;
/** After the pump gives up on a recoverable failure. Matches its own `retry:` hint. */
const TERMINAL_RETRY_MS = 60_000;

/**
 * How long a signal may sit unacknowledged before the canvas says so.
 *
 * Every signal this app sends makes the workflow append at least one event
 * synchronously in its handler, so the cursor should advance within a poll or
 * two. It does not advance when no worker is polling the task queue: Temporal
 * accepts the signal, records it in history, answers 202, and nothing executes
 * it — from the browser that is indistinguishable from a click that did
 * nothing. This is the only place that difference is observable.
 */
const ACK_TIMEOUT_MS = 8_000;

/** Terminal stream reasons, in words rather than in wire codes. */
const END_REASON: Record<string, string> = {
  session_not_found:
    "this session no longer exists on the server — reload to start a new one",
  session_completed: "the session was closed",
  session_terminated: "the session was terminated",
  session_canceled: "the session was cancelled",
  session_failed: "the session failed",
  session_timed_out: "the session timed out",
  query_not_registered:
    "the worker is running a different version of the workflow than this app expects",
  query_failed:
    "the worker is not responding — signals are being queued but nothing is running",
  pump_failed: "the server could not keep the stream open",
};

/**
 * Full jitter on an exponential backoff.
 *
 * Without the jitter every tab that lost the same server comes back at the same
 * instant and the first thing a recovering process sees is a synchronised
 * stampede. The `retry:` field the pump sends only governs EventSource's own
 * reconnect, which this file deliberately does not use — see `connect`.
 */
function backoff(attempt: number): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

/** What the server said went wrong, without leaking an unparsed body into the UI. */
async function describeFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message !== "") return body.message;
    if (typeof body.error === "string" && body.error !== "") return body.error;
  } catch {
    /* not JSON */
  }
  return `server returned ${response.status}`;
}

/**
 * The `/graph` snapshot: the workflow's own graph plus the retained log window.
 * `seq`/`oldestSeq` are absent when the worker does not register
 * `getSessionInfo`, so both are optional here rather than part of the contract.
 */
interface SnapshotResult {
  graph: Graph;
  seq?: number;
  oldestSeq?: number;
}

/**
 * A `getGraph` query with no worker polling the queue does not fail — it blocks
 * until Temporal's own deadline, which is tens of seconds. Nothing here is
 * worth waiting that long for: the snapshot is a repair, and the stream (which
 * has its own stall watchdog) is what the user actually needs open.
 */
const SNAPSHOT_TIMEOUT_MS = 5_000;

async function fetchSnapshot(sessionId: string): Promise<SnapshotResult> {
  const response = await fetch(`/api/sessions/${sessionId}/graph`, {
    cache: "no-store",
    signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await describeFailure(response));

  const body = (await response.json()) as unknown;
  const record = (body ?? {}) as Record<string, unknown>;
  // Validated, not cast: this is the other place bytes off the wire become
  // domain state, and a shape change here would otherwise land as an empty
  // canvas with no error (the exact failure this project has already shipped).
  const parsed = Graph.safeParse(record.graph);
  if (!parsed.success) throw new Error("snapshot did not match the Graph schema");

  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return { graph: parsed.data, seq: num(record.seq), oldestSeq: num(record.oldestSeq) };
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                       */
/* -------------------------------------------------------------------------- */

export function useSession(): SessionApi {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [sessionId, setSessionId] = useState("");
  const [transport, setTransport] = useState<Transport>({ state: "connecting" });

  // Read during render on purpose: callbacks below need the *current* graph and
  // cursor, and a stale closure would produce duplicates or replay from zero.
  const stateRef = useRef(state);
  stateRef.current = state;

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  /** Negative, monotonically decreasing: the marker of an unconfirmed edit. */
  const localSeqRef = useRef(0);
  const nextLocalSeq = useCallback(() => (localSeqRef.current -= 1), []);

  /* --- "accepted, but did anything happen?" -------------------------------- */

  const ackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (ackTimer.current !== undefined) clearTimeout(ackTimer.current);
    },
    [],
  );

  /**
   * A 202 means Temporal took the signal, not that anything ran it.
   *
   * With no worker polling the queue the signal is durably recorded and then
   * sits there: the canvas does not move, no request fails, and nothing in the
   * console mentions it. Every signal here makes the workflow append an event
   * in its handler, so a cursor that has not advanced after a few seconds is
   * the observable form of "nothing is executing".
   */
  const expectProgress = useCallback((what: string) => {
    const before = stateRef.current.cursor;
    if (ackTimer.current !== undefined) clearTimeout(ackTimer.current);
    ackTimer.current = setTimeout(() => {
      if (stateRef.current.cursor > before) return;
      dispatch({
        kind: "notice",
        error: `${what} was accepted but nothing has happened since — the worker may not be running`,
      });
    }, ACK_TIMEOUT_MS);
  }, []);

  /* --- flow projection ---------------------------------------------------- */

  const [flowNodes, setFlowNodes] = useState<WfNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<WfEdge[]>([]);

  const { nodes: domainNodes, edges: domainEdges } = state.graph;

  useEffect(() => {
    setFlowNodes((prev) => reconcileFlowNodes(prev, domainNodes));
  }, [domainNodes]);

  useEffect(() => {
    setFlowEdges((prev) => reconcileFlowEdges(prev, domainEdges, domainNodes));
  }, [domainEdges, domainNodes]);

  /* --- repair ------------------------------------------------------------- */

  /**
   * Throw away the replica and adopt the workflow's graph.
   *
   * The cursor is left alone on purpose: the stream will replay anything we
   * have not seen on top of the snapshot, and `applyEvent` is convergent for
   * every graph event, so the two paths agree. Moving the cursor forward here
   * would instead swallow the chat messages in that window.
   */
  const resync = useCallback(async (id: string) => {
    try {
      const snapshot = await fetchSnapshot(id);
      dispatch({ kind: "sync", graph: snapshot.graph });
    } catch {
      // The repair itself failed. The transport indicator already reflects that
      // the server is unreachable; leaving the replica alone is the least-wrong
      // option, and the next successful poll repairs it.
    }
  }, []);

  /* --- signalling --------------------------------------------------------- */

  /**
   * POST a signal and, if it was not ACCEPTED, undo the optimism.
   *
   * `fetch` resolves for 4xx and 5xx alike, so a bare `.catch()` here — the
   * shape this file used to have — treats "Temporal is down", "no such
   * session", and "that mutation failed validation" as success. The optimistic
   * edit then stays on the canvas for the life of the tab: verified by blocking
   * `/mutate` at the network layer, after which the canvas showed a node the
   * workflow did not have, with nothing in the console.
   */
  const signal = useCallback(
    async (path: string, init: RequestInit, what: string, repair: boolean) => {
      const id = sessionIdRef.current;
      if (id === "") {
        dispatch({ kind: "notice", error: `${what} failed: no session yet` });
        return;
      }
      try {
        const response = await fetch(`/api/sessions/${id}${path}`, init);
        if (response.ok) {
          expectProgress(what);
          return;
        }
        dispatch({
          kind: "notice",
          error: `${what} was rejected: ${await describeFailure(response)}`,
        });
      } catch {
        dispatch({ kind: "notice", error: `${what} could not reach the server` });
      }
      if (repair) await resync(id);
    },
    [expectProgress, resync],
  );

  const mutate = useCallback(
    (mutation: GraphMutation) => {
      const events = mutationToEvents(stateRef.current.graph, mutation, {
        seq: nextLocalSeq,
      });
      for (const event of events) dispatch({ kind: "local", event });

      void signal(
        "/mutate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mutation),
        },
        "That edit",
        true,
      );
    },
    [nextLocalSeq, signal],
  );

  /* --- React Flow handlers ------------------------------------------------ */

  const onNodesChange = useCallback<OnNodesChange<WfNode>>(
    (changes: NodeChange<WfNode>[]) => {
      setFlowNodes((prev) => applyNodeChanges(changes, prev));
      for (const change of changes) {
        // Position is NOT signalled from here. React Flow emits a position
        // change per animation frame, and the canvas passes `onNodeDragStop`
        // instead — one signal per gesture, rather than one per frame plus an
        // audit trail with a hundred identical "moved" entries for a single
        // drag. Selection, dimension and other view-local changes stay local
        // by the same argument: the workflow does not model them.
        //
        // Deletion normally goes through the confirmation modal (onBeforeDelete
        // vetoes it), so this is a backstop for programmatic removals.
        if (change.type === "remove") {
          mutate({ op: "removeNode", id: change.id });
        }
      }
    },
    [mutate],
  );

  const onEdgesChange = useCallback<OnEdgesChange<WfEdge>>(
    (changes: EdgeChange<WfEdge>[]) => {
      setFlowEdges((prev) => applyEdgeChanges(changes, prev));
      for (const change of changes) {
        if (change.type !== "remove") continue;
        // `deletable: false` on unconfirmed edges should make this unreachable;
        // the guard stays because sending a placeholder id is worse than a
        // no-op — the workflow accepts it, ignores it, and the wire survives on
        // the server while vanishing from the canvas.
        if (isLocalId(change.id)) continue;
        mutate({ op: "disconnect", id: change.id });
      }
    },
    [mutate],
  );

  const onConnect = useCallback<OnConnect>(
    (connection) => {
      if (!connection.source || !connection.target) return;
      mutate({ op: "connect", source: connection.source, target: connection.target });
    },
    [mutate],
  );

  /* --- prompt / run ------------------------------------------------------- */

  const sendPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      dispatch({
        kind: "local",
        event: { seq: nextLocalSeq(), t: "chat", role: "user", text: trimmed },
      });
      void signal(
        "/prompt",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        },
        "That prompt",
        false,
      );
    },
    [nextLocalSeq, signal],
  );

  const run = useCallback(() => {
    void signal("/run", { method: "POST" }, "The run", false);
  }, [signal]);

  /* --- documents ---------------------------------------------------------- */

  const attachDocument = useCallback(
    async (nodeId: string, file: File) => {
      const body = new FormData();
      body.append("file", file);

      let response: Response;
      try {
        response = await fetch("/api/blobs", { method: "POST", body });
      } catch {
        dispatch({ kind: "notice", error: "Upload could not reach the server" });
        return;
      }
      if (!response.ok) {
        dispatch({
          kind: "notice",
          error: `Upload failed: ${await describeFailure(response)}`,
        });
        return;
      }

      // Parsed, not cast. The hash in this reference is what a six-month-old
      // workflow history will name; a malformed one has to fail here, loudly,
      // rather than reach the graph and the audit trail.
      const parsed = BlobRef.safeParse(await response.json());
      if (!parsed.success) {
        dispatch({
          kind: "notice",
          error: "Upload returned something that is not a BlobRef",
        });
        return;
      }

      mutate({ op: "attachBlob", id: nodeId, blob: parsed.data });
    },
    [mutate],
  );

  /* --- transport ---------------------------------------------------------- */

  useEffect(() => {
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let cancelled = false;

    const teardown = () => {
      source?.close();
      source = undefined;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    const retry = (detail: string) => {
      if (cancelled) return;
      teardown();
      setTransport({ state: "retrying", detail });
      const delay = backoff(attempt);
      attempt += 1;
      retryTimer = setTimeout(() => void open(), delay);
    };

    /**
     * Resolve the session id once per tab.
     *
     * React StrictMode invokes this effect twice in dev, and a server-minted id
     * would start a second workflow the first render can never reach — an orphan
     * left Running in Temporal on every page load. On reload, sending the same
     * id reattaches to the live workflow (the route answers `existing: true`)
     * instead of abandoning the graph the user was working on.
     */
    const ensureSession = async (): Promise<string> => {
      const stored = sessionStorage.getItem(SESSION_KEY);
      const desired = stored ?? crypto.randomUUID();
      if (!stored) sessionStorage.setItem(SESSION_KEY, desired);

      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: desired }),
      });
      if (!response.ok) throw new Error(await describeFailure(response));

      // The route returns `sessionId`, not `id`. Reading the wrong key yields
      // `undefined` and every subsequent call goes to /api/sessions/undefined,
      // which fails silently — no console error, just a canvas that never fills.
      const body = (await response.json()) as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId === "") {
        throw new Error("session start returned no sessionId");
      }
      return body.sessionId;
    };

    /**
     * Connect, or reconnect, at the cursor we actually hold.
     *
     * EventSource's built-in reconnect is deliberately NOT used: it re-requests
     * the URL it was constructed with, so every reconnect would ask for the
     * cursor this tab held at page load. That is merely wasteful in a young
     * session and wrong in an old one — after a `continueAsNew` only a tail of
     * the log survives, so replaying from an evicted cursor silently omits
     * every node added before the boundary. Instead the source is closed on
     * error and a new one is opened at the live cursor, with jittered backoff.
     */
    const open = async () => {
      if (cancelled) return;
      setTransport((prev) =>
        prev.state === "live" ? prev : { state: "connecting", detail: prev.detail },
      );

      let id: string;
      try {
        id = await ensureSession();
      } catch (err) {
        retry(err instanceof Error ? err.message : "cannot reach the server");
        return;
      }
      if (cancelled) return;
      setSessionId(id);
      sessionIdRef.current = id;

      // Close the continue-as-new gap BEFORE streaming. `oldestSeq` is the
      // lowest seq the workflow still retains; a cursor below `oldestSeq - 1`
      // can never be caught up from the log alone, so the snapshot becomes the
      // baseline and the cursor jumps to the start of the retained window.
      let cursor = stateRef.current.cursor;
      try {
        const snapshot = await fetchSnapshot(id);
        if (cancelled) return;
        if (snapshot.oldestSeq !== undefined && snapshot.oldestSeq > cursor + 1) {
          cursor = snapshot.oldestSeq - 1;
          dispatch({ kind: "sync", graph: snapshot.graph, cursor });
        }
      } catch {
        // No snapshot is survivable — the stream still replays from `cursor`.
        // Only the post-continue-as-new gap goes undetected, and the stream
        // failing would surface separately.
      }

      const stream = new EventSource(`/api/sessions/${id}/stream?cursor=${cursor}`);
      source = stream;

      stream.onopen = () => {
        attempt = 0;
        setTransport({ state: "live" });
      };

      stream.onmessage = (message: MessageEvent<string>) => {
        // THE TRUST BOUNDARY. Bytes off the wire become domain state here and
        // nowhere else, so they are validated here — a cast would let a frame
        // the workflow and the schema disagree about be folded straight into
        // the replica, which in this application means the canvas asserting
        // something the audit trail does not.
        let raw: unknown;
        try {
          raw = JSON.parse(message.data);
        } catch {
          console.warn("[wf] dropped an SSE frame that was not JSON");
          return;
        }
        const parsed = GraphEvent.safeParse(raw);
        if (!parsed.success) {
          console.warn(
            "[wf] dropped an SSE frame that does not match the GraphEvent schema",
            parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          );
          return;
        }
        dispatch({ kind: "remote", event: parsed.data });
      };

      // Named control frames. A stream that ended on purpose must not be
      // retried in a tight loop, and the user has to be told why the canvas
      // stopped moving.
      /**
       * `end` means the session is over — no amount of retrying brings it back,
       * and silently starting a new one would throw the user's canvas away
       * without telling them. `error` means the server gave up on a stream that
       * could still recover (a worker restart, say), so it is retried on the
       * long delay the pump itself nominates rather than abandoned.
       */
      const ended = (terminal: boolean) => (message: Event) => {
        const reason = reasonOf(message);
        const detail = reason === undefined ? undefined : (END_REASON[reason] ?? reason);
        teardown();
        setTransport({ state: "ended", detail });
        if (!terminal && !cancelled) {
          retryTimer = setTimeout(() => void open(), TERMINAL_RETRY_MS);
        }
      };
      stream.addEventListener("end", ended(true));
      stream.addEventListener("error", ended(false));

      // Non-terminal: the socket is healthy, the server just is not getting
      // answers back. Saying so is the difference between "the canvas is idle"
      // and "the canvas has stopped telling you the truth".
      stream.addEventListener("stalled", () => {
        setTransport({
          state: "stalled",
          detail: "the server is not getting a response — nothing is updating",
        });
      });
      stream.addEventListener("resumed", () => {
        setTransport({ state: "live" });
      });

      // Transport-level failure (server restarted, connection dropped). This
      // also fires when the browser is about to auto-reconnect, which is why
      // the source is closed first.
      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED || source !== stream) return;
        retry("connection lost");
      };
    };

    void open();

    return () => {
      cancelled = true;
      teardown();
    };
  }, []);

  /* --- ending the session -------------------------------------------------- */

  /**
   * Close the workflow when the tab goes away.
   *
   * The workflow parks on `condition(() => closed)` and only the `close` signal
   * sets it, so without this every tab ever opened leaves a session Running in
   * Temporal forever. With the retention an audit trail actually needs, that is
   * a pile of immortal executions burying the histories that matter.
   *
   * `pagehide` rather than `beforeunload`: it is the event that actually fires
   * on mobile and on bfcache eviction. `sendBeacon` rather than `fetch`,
   * because a normal request is cancelled when the document is torn down —
   * a beacon is handed to the browser to deliver afterwards. Neither is
   * guaranteed, which is why the route is idempotent and treats an
   * already-closed session as success.
   *
   * `persisted` is checked so a bfcache suspend — where the page can come back
   * live, stream and all — does not end the user's session behind their back.
   */
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      const id = sessionIdRef.current;
      if (id === "") return;
      navigator.sendBeacon?.(`/api/sessions/${id}/close`);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  /**
   * Start over with an empty canvas.
   *
   * Closes the current workflow rather than orphaning it, clears the per-tab
   * id so the next load mints a fresh one, then reloads. A reload is used
   * deliberately: session state is spread across the reducer, the React Flow
   * store, the SSE connection and the tool cache, and tearing all of those
   * down by hand is a reliable source of stale-state bugs. The workflow is the
   * source of truth and it is being replaced, so there is nothing worth
   * preserving in memory.
   */
  const reset = useCallback(() => {
    const id = sessionStorage.getItem(SESSION_KEY);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // private mode or storage disabled; the reload still starts fresh
    }
    if (id !== null && id !== "") {
      // Fire and forget. sendBeacon survives the imminent navigation, which a
      // fetch would not.
      try {
        navigator.sendBeacon(`/api/sessions/${id}/close`);
      } catch {
        // closing is best effort; the reload matters more than the tidy-up
      }
    }
    window.location.reload();
  }, []);

  /* --- api ---------------------------------------------------------------- */

  return useMemo<SessionApi>(
    () => ({
      sessionId,
      graph: state.graph,
      nodes: flowNodes,
      edges: flowEdges,
      chat: state.chat,
      status: state.status,
      error: state.error,
      transport,
      sendPrompt,
      mutate,
      run,
      attachDocument,
      reset,
      onNodesChange,
      onEdgesChange,
      onConnect,
    }),
    [
      attachDocument,
      flowEdges,
      flowNodes,
      mutate,
      onConnect,
      onEdgesChange,
      onNodesChange,
      reset,
      run,
      sendPrompt,
      sessionId,
      state.chat,
      state.error,
      state.graph,
      state.status,
      transport,
    ],
  );
}

/** Pulls `{ reason }` out of a named control frame, tolerating a missing body. */
function reasonOf(message: Event): string | undefined {
  const data = (message as MessageEvent<string>).data;
  if (typeof data !== "string") return undefined;
  try {
    const body = JSON.parse(data) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : undefined;
  } catch {
    return undefined;
  }
}
