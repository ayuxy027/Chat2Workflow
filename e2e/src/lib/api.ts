/**
 * The HTTP surface under test, as a typed client.
 *
 * Deliberately thin and deliberately NOT importing anything from the app: the
 * harness must exercise the wire, not the app's own idea of the wire. Types
 * here are structural echoes of `@wf/shared`, restated so a contract change
 * shows up as a failing assertion instead of silently type-checking away.
 */

import { until, show } from "./report";

export interface BlobRef {
  sha256: string;
  mime: string;
  bytes: number;
  filename: string;
  pages?: number;
}

export interface Citation {
  blob: string;
  sourceBlob?: string;
  page: number;
  quote: string;
  verified: boolean;
}

export interface Provenance {
  model?: string;
  promptVersion?: string;
  toolVersion?: string;
  binaries?: { name: string; version: string }[];
}

export interface GraphNode {
  id: string;
  kind: "document" | "chat" | "tool" | "input" | "output";
  position: { x: number; y: number };
  label: string;
  prompt?: string;
  toolId?: string;
  params: Record<string, unknown>;
  value?: string;
  status: "idle" | "queued" | "running" | "done" | "error";
  blob?: BlobRef;
  outputs: BlobRef[];
  result?: string;
  citations: Citation[];
  error?: string;
  log?: string[];
  truncated?: boolean;
  verifiedCount?: number;
  unverifiedCount?: number;
  provenance?: Provenance;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Snapshot {
  graph: Graph;
  seq?: number;
  oldestSeq?: number;
  running?: boolean;
  closed?: boolean;
}

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  raw: string;
  headers: Headers;
}

export class Api {
  readonly base: string;
  /** Every session this client started, so teardown can close them all. */
  readonly sessions = new Set<string>();

  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  async request<T = unknown>(
    method: string,
    path: string,
    init: RequestInit = {},
  ): Promise<HttpResult<T>> {
    const res = await fetch(`${this.base}${path}`, { ...init, method });
    const raw = await res.text();
    let body: unknown = raw;
    try {
      body = raw === "" ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      /* not JSON — keep the raw text, which is what the assertion will show */
    }
    return { status: res.status, body: body as T, raw, headers: res.headers };
  }

  get<T = unknown>(path: string): Promise<HttpResult<T>> {
    return this.request<T>("GET", path);
  }

  postJson<T = unknown>(path: string, body: unknown): Promise<HttpResult<T>> {
    return this.request<T>("POST", path, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** POST with a body that is deliberately not valid JSON / not valid schema. */
  postRaw<T = unknown>(path: string, raw: string): Promise<HttpResult<T>> {
    return this.request<T>("POST", path, {
      headers: { "content-type": "application/json" },
      body: raw,
    });
  }

  /* ------------------------------------------------------------------ */

  async startSession(sessionId?: string): Promise<string> {
    const res = await this.postJson<{ sessionId?: string }>(
      "/api/sessions",
      sessionId === undefined ? {} : { sessionId },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(
        `POST /api/sessions: expected 200 or 201, saw ${res.status} — ${show(res.body)}`,
      );
    }
    const id = res.body.sessionId;
    if (typeof id !== "string" || id === "") {
      throw new Error(`POST /api/sessions returned no sessionId — body was ${show(res.body)}`);
    }
    this.sessions.add(id);
    return id;
  }

  async closeSession(id: string): Promise<void> {
    await this.request("POST", `/api/sessions/${id}/close`).catch(() => undefined);
    this.sessions.delete(id);
  }

  async closeAllSessions(): Promise<void> {
    for (const id of [...this.sessions]) await this.closeSession(id);
  }

  async snapshot(id: string): Promise<Snapshot> {
    const res = await this.get<Snapshot>(`/api/sessions/${id}/graph`);
    if (res.status !== 200) {
      throw new Error(
        `GET /api/sessions/${id}/graph: expected 200, saw ${res.status} — ${show(res.body)}`,
      );
    }
    const snap = res.body;
    if (snap === undefined || typeof snap !== "object" || !("graph" in snap)) {
      throw new Error(
        `GET /api/sessions/:id/graph: expected a body with a "graph" key ` +
          `(this is the exact shape the canvas reads) — saw ${show(res.body)}`,
      );
    }
    return snap;
  }

  async graph(id: string): Promise<Graph> {
    return (await this.snapshot(id)).graph;
  }

  prompt(id: string, text: string): Promise<HttpResult> {
    return this.postJson(`/api/sessions/${id}/prompt`, { text });
  }

  mutate(id: string, mutation: unknown): Promise<HttpResult> {
    return this.postJson(`/api/sessions/${id}/mutate`, mutation);
  }

  run(id: string): Promise<HttpResult> {
    return this.request("POST", `/api/sessions/${id}/run`);
  }

  async tools(): Promise<{ id: string; params: unknown[] }[]> {
    const res = await this.get<{ tools?: { id: string; params: unknown[] }[] }>("/api/tools");
    if (res.status !== 200) {
      throw new Error(`GET /api/tools: expected 200, saw ${res.status} — ${show(res.body)}`);
    }
    const tools = res.body.tools;
    if (!Array.isArray(tools)) {
      throw new Error(`GET /api/tools: expected { tools: [...] }, saw ${show(res.body)}`);
    }
    return tools;
  }

  async uploadBlob(bytes: Uint8Array, filename: string, mime: string): Promise<BlobRef> {
    const form = new FormData();
    form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), filename);
    const res = await this.request<BlobRef>("POST", "/api/blobs", { body: form });
    if (res.status !== 201) {
      throw new Error(`POST /api/blobs: expected 201, saw ${res.status} — ${show(res.body)}`);
    }
    return res.body;
  }

  async downloadBlob(sha256: string): Promise<Uint8Array> {
    const res = await fetch(`${this.base}/api/blobs/${sha256}`);
    if (!res.ok) {
      throw new Error(
        `GET /api/blobs/${sha256}: expected 200, saw ${res.status} ${await res.text()}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async downloadText(sha256: string): Promise<string> {
    return new TextDecoder().decode(await this.downloadBlob(sha256));
  }

  /* ------------------------------------------------------------------ */
  /* Waiting on the AUTHORITATIVE graph — never on a local guess.        */
  /* ------------------------------------------------------------------ */

  /**
   * Applies a mutation and waits for the workflow's own graph to reflect it.
   *
   * This is the shape of the `disconnect` regression: the HTTP layer answers
   * 202 the instant the signal is accepted, which says nothing about whether
   * the workflow honoured it. Only `getGraph` is authoritative.
   */
  async mutateAndWait(
    id: string,
    mutation: unknown,
    settled: (g: Graph) => boolean,
    opts: { timeoutMs?: number; label?: string } = {},
  ): Promise<{ http: HttpResult; graph: Graph }> {
    const http = await this.mutate(id, mutation);
    const graph = await until(
      opts.label ?? `the authoritative graph to reflect ${show(mutation, 160)}`,
      opts.timeoutMs ?? 8000,
      60,
      async () => {
        const g = await this.graph(id);
        return settled(g) ? g : undefined;
      },
    );
    return { http, graph };
  }

  /** Applies a mutation, then confirms the graph did NOT change for a while. */
  async mutateExpectingNoChange(
    id: string,
    mutation: unknown,
    holdMs = 1200,
  ): Promise<{ http: HttpResult; before: Graph; after: Graph }> {
    const before = await this.graph(id);
    const http = await this.mutate(id, mutation);
    await new Promise((r) => setTimeout(r, holdMs));
    const after = await this.graph(id);
    return { http, before, after };
  }
}

export const nodeById = (g: Graph, id: string): GraphNode | undefined =>
  g.nodes.find((n) => n.id === id);

export const edgeBetween = (g: Graph, source: string, target: string): GraphEdge | undefined =>
  g.edges.find((e) => e.source === source && e.target === target);

/** Kahn's algorithm. Returns the ids that could not be ordered — i.e. a cycle. */
export function findCycle(g: Graph): string[] {
  const ids = g.nodes.map((n) => n.id);
  const indeg = new Map(ids.map((i) => [i, 0]));
  const succ = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of g.edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    succ.get(e.source)?.push(e.target);
  }
  const queue = ids.filter((i) => indeg.get(i) === 0);
  const seen: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    seen.push(id);
    for (const t of succ.get(id) ?? []) {
      const d = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  return ids.filter((i) => !seen.includes(i));
}
