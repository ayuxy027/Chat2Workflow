# Workflows — PRD

**A chat-driven document workflow canvas for legal work.** You describe what you need in plain language; an LLM assembles a node graph on an infinite canvas. Nodes are documents, model steps, and deterministic file tools. Edges are data flow. Temporal executes the graph durably and its history doubles as the audit trail.

Status: **v0 — scaffold complete, implementation underway.** Next.js 16 + React Flow + Temporal + AI SDK wired and building. Canvas, worker, and transport layers in progress.

---

## 1. Product

### 1.1 The pitch

A paralegal drops in a 200-page contract and types *"summarise the indemnity clauses, compress this, and give me a Word version."* The canvas builds itself: document → extract → summarise → convert → output. They rewire a node, hit Run, and get three artifacts plus a page-cited summary.

### 1.2 Why a canvas, not a chat transcript

A chat transcript is linear and disposable. Legal document work is a **graph** that gets re-run: same pipeline, new contract, next week. The canvas is the durable, inspectable, re-runnable artifact. The chat is just the fastest way to author it.

It's also the reviewable one. When a partner asks "how did you get that summary," a graph answers the question; a chat log doesn't.

### 1.3 Primary loop

```
type into chat bar
  → LLM plans a graph
    → nodes cascade onto canvas, connected
      → user attaches documents, edits prompts, rewires
        → Run
          → Temporal executes, node borders animate as each completes
            → artifacts download; every step is in the audit trail
```

### 1.4 Domain constraints (legal)

These are requirements, not nice-to-haves:

- **Provenance.** Any model-generated claim about a document must be traceable to a page. Summaries without citations are not shippable.
- **Custody.** Document bytes stay on infrastructure the firm controls. The only thing that leaves is what's deliberately sent to the model, and that's a visible, per-node decision.
- **Auditability.** Every run answers: which document, which version, which tool, which model, what came out, when.
- **Determinism where it's possible.** Compression, conversion, splitting, and text extraction are deterministic file operations. They run as local tools, not as model calls. The model is for judgment, not for transforming bytes.

### 1.5 Non-goals for v1

No auth or multi-tenancy, no collaborative editing, no matter/DMS integration, no e-signature, no arbitrary code nodes.

**This is a drafting and analysis aid, not legal advice.** The UI must not present model output as a conclusion. See §3.6.

---

## 2. Scope

### 2.1 In scope (v1)

| Area | What ships |
|---|---|
| Canvas | React Flow (`@xyflow/react`), pan/zoom, dot grid, drag nodes, draw edges, delete |
| Sidebar | Thin rail, two circular icon buttons: **Chat** and **Build** |
| Chat bar | Floating pill, bottom-center, submits a prompt to the planner |
| Node kinds | `document`, `chat`, `tool`, `input`, `output` |
| Tools | `pdf.extract_text`, `pdf.compress`, `pdf.split`, `pdf.merge`, `pdf.to_docx`, `docx.to_pdf` |
| LLM | Plan a graph (structured output); summarise/extract with **page citations** |
| Execution | Topological run via Temporal; per-node status on canvas |
| Streaming | SSE from API → browser; nodes and status arrive as events |
| Blob store | Content-addressed local store; documents never ride in Temporal payloads |
| Theme | Light, black and white only |

### 2.2 Out of scope (v1)

Undo/redo, subflows, saved workflow templates, node search palette, minimap, OCR, redaction.

### 2.3 Deferred with a reason

- **OCR (`pdf.ocr`)** — scanned discovery documents make this inevitable. Deferred because `ocrmypdf` + Tesseract is a heavy dependency and the tool contract (§5.3) makes it a drop-in later.
- **Redaction (`doc.redact`)** — deliberately not in v1. A redaction tool that leaves recoverable text under a black box is worse than no tool. This needs to be built carefully or not at all.
- **Anthropic-native PDF citations** — no longer available to us (§6.1), and the replacement in §6.3 is better because it is verifiable rather than asserted. Recorded here so nobody re-litigates it.

---

## 3. Design

### 3.1 Theme

**Light, black and white only.** White page, dark ink, no hue anywhere — not in accents, not in status, not in errors.

Two reasons this is the right call here and not just an aesthetic preference:

1. Legal documents are black text on white paper. A tool that sits next to them should not fight them.
2. It prints and screenshots into a memo without translation.

Everything communicates through value, weight, opacity, motion, and shape.

### 3.2 Tokens

```css
--bg:          #FFFFFF;                 /* canvas + app background */
--fg:          #0A0A0A;                 /* primary text, strong borders */
--dot:         rgba(0,0,0,0.13);        /* canvas dot grid */
--surface:     #FFFFFF;                 /* node body */
--surface-2:   #F4F4F4;                 /* node header, rail, chat bar */
--line:        rgba(0,0,0,0.18);        /* default borders, edges */
--line-strong: rgba(0,0,0,0.55);        /* hover / selected */
--muted:       rgba(0,0,0,0.52);        /* secondary text */
--faint:       rgba(0,0,0,0.06);        /* dividers */
--shadow:      0 1px 2px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
```

Only two literal colors exist: `#FFFFFF` and `#0A0A0A`. Everything else is black at an opacity. On a light theme, elevation carries some of the load that borders carry on dark — hence `--shadow` on nodes and the chat bar.

### 3.3 Layout

```
┌────┬────────────────────────────────────────────────────┐
│    │                                                    │
│ ◉  │   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·   ·       │
│chat│      ┌────────────┐      ┌────────────┐            │
│    │   ·  │ ▤ DOCUMENT │──○──▶│ ◐ SUMMARISE│──○──┐  ·  │
│    │      │ msa_v3.pdf │      │ indemnity… │     │      │
│ ○  │      └────────────┘      └────────────┘     ▼      │
│bld │   ·         │                        ┌───────────┐ │
│    │             └──○──▶┌────────────┐    │ ◼ OUTPUT  │ │
│    │   ·   ·   ·        │ ⚙ TO DOCX  │───▶└───────────┘ │
│    │                    └────────────┘        ·   ·     │
└────┴────────────────────────────────────────────────────┘
            ┌────────────────────────────────────┐
            │  describe a workflow…          ➤   │
            └────────────────────────────────────┘
```

- **Rail** — 56px, `--surface-2`, full height, 1px right border in `--faint`. Two 36px circular buttons. Active = filled `--fg` with white glyph; inactive = 1px `--line` ring with `--fg` glyph.
- **Canvas** — fills the rest. `BackgroundVariant.Dots`, `gap={24}`, `size={1}`, `color={--dot}`, `bgColor={--bg}`.
- **Chat bar** — fixed, bottom-center, `max-width: 640px`, `border-radius: 9999px`, `--surface` fill, 1px `--line`, `--shadow`. Focus raises the border to `--line-strong`.

### 3.4 Node visual language

Rounded rect (`8px`), `--surface` fill, 1px `--line` border, `--shadow`, header strip in `--surface-2`. Kind is signalled by glyph and handle placement — never by color.

| Kind | Glyph | Handles | Body shows |
|---|---|---|---|
| `document` | `▤` | source right | filename, page count, size |
| `chat` | `◐` | target left, source right | prompt (editable), citation count |
| `tool` | `⚙` | target left, source right | tool id, params |
| `input` | `▷` | source right | text field |
| `output` | `◼` | target left | artifact list, download |

**Status without color:**

| State | Treatment |
|---|---|
| idle | 1px `--line` border |
| queued | 1px `--line`, glyph at 45% opacity |
| running | 2px border, animated dark dash marching around the perimeter |
| done | 2px solid `--fg` border |
| error | 2px border + offset 1px outer ring (double stroke), glyph replaced with `!` |

Edges: 1px `--line`, bezier, arrowhead at target. A moving dash animates along an edge while data flows.

### 3.5 Circular motif

Rail buttons, node handles, and the Run button are all circles — a deliberate through-line. `frontend/example/src/CircleNode.jsx` (React Flow's `border-radius: 50%` node) is the handle-styling reference; the example node itself does not ship.

### 3.6 Presenting model output responsibly

Non-negotiable in the UI:

- Every `chat` node result renders its **page citations inline**, each clickable to the source page. Citations that fail machine verification (§6.3) render with a visible "unverified" marker; a result with zero citations renders "unsourced".
- Node results are labelled as **drafts**. The output panel carries a persistent, unobtrusive line: *"AI-generated draft — verify against source before relying on it."*
- The source document is always one click from any claim made about it.

This is a product requirement because the alternative — a confident, uncited paragraph in a clean interface — is exactly the failure mode that gets someone in trouble.

---

## 4. Architecture

### 4.1 Processes

```
frontend  (Next.js 16, App Router)
   │
   ├── app/                              canvas UI (client)
   └── app/api/                          route handlers (server)
        ├── POST /api/sessions           start Temporal workflow
        ├── POST /api/sessions/:id/prompt   signal: user prompt
        ├── POST /api/sessions/:id/mutate   signal: manual edit
        ├── POST /api/sessions/:id/run      signal: execute graph
        ├── GET  /api/sessions/:id/graph    query: snapshot (cold load)
        ├── GET  /api/sessions/:id/stream   SSE ← event log
        ├── POST /api/blobs                 multipart upload → BlobRef
        └── GET  /api/blobs/:sha256         download artifact
   │
   └── lib/  temporal client · blob store · llm provider
   │
   ▼
                                    Temporal Server
                                             │
backend (Temporal Worker) ───────────────┘
   ├── workflows/graph-session.ts
   ├── activities/plan-graph.ts       → LLM, streamObject(PlanResult)
   ├── activities/run-chat-node.ts    → LLM, generateObject + citation verify
   └── tools/                         → local file ops (pdf-lib, qpdf, soffice)
```

The web app owns the transport and the blob store; the worker owns durable execution and anything that touches document bytes or the model. Both read the same `BLOB_DIR`.

**One process, not two.** An earlier draft split out a Hono API because the frontend was Vite and had no server runtime. Moving to Next.js collapses that — route handlers give us SSE, the Temporal client, and multipart upload in the same app.

### 4.2 Repo layout

```
Workflows/
├── apps/
│   ├── web/               # Next.js 16 — canvas, API routes, SSE, blob store
│   └── worker/            # Temporal worker — workflows, activities, tools
├── packages/
│   └── shared/            # zod schemas + inferred types, imported by both apps
├── reference/
│   └── react-flow/        # READ-ONLY React Flow demo — never built, never imported
├── docs/                  # user-authored
├── docker-compose.yml     # Temporal dev server + UI
├── .env.example
├── PRD.md
└── CLAUDE.md
```

Bun workspace at root: `["apps/*", "packages/*"]`. Bun 1.3 uses isolated per-workspace `node_modules`; the root holds only `typescript`.

### 4.3 The shared contract

`shared` is the single source of truth for graph shape. Zod schemas; types inferred from them. If the canvas and the workflow disagree about what a node is, that's one bug, not two.

```ts
export const NodeKind = z.enum(["document", "chat", "tool", "input", "output"]);

export const BlobRef = z.object({
  sha256: z.string(),
  mime: z.string(),
  bytes: z.number(),
  filename: z.string(),
  pages: z.number().optional(),
});

export const Citation = z.object({
  blob: z.string(),          // sha256 of the cited document
  page: z.number(),
  quote: z.string(),
});

export const GraphNode = z.object({
  id: z.string(),
  kind: NodeKind,
  position: z.object({ x: z.number(), y: z.number() }),
  label: z.string(),
  prompt: z.string().optional(),        // chat
  toolId: z.string().optional(),        // tool
  params: z.record(z.unknown()).default({}),
  blob: BlobRef.optional(),             // document / produced artifact
  status: z.enum(["idle","queued","running","done","error"]).default("idle"),
  result: z.string().optional(),
  citations: z.array(Citation).default([]),
  error: z.string().optional(),
});
```

The React Flow node is a *projection*, not the same object: `{ id, type: kind, position, data: { ...rest } }`. That mapping lives in exactly one adapter module.

### 4.4 Blob store — documents never ride in Temporal payloads

Temporal's default payload limit is 2MB (4MB hard). A 200-page PDF blows straight through it. So:

- Uploads go to `POST /api/blobs`, stored content-addressed on disk at `blobs/<sha256>`.
- The graph, the workflow, and every activity pass **`BlobRef`** — metadata only, tens of bytes.
- Activities read and write bytes directly from the store; the worker mounts the same volume.

Content addressing gives deduplication and immutability for free, and immutability is what makes the audit trail meaningful: a `BlobRef` in a six-month-old workflow history still names the exact bytes that were processed.

### 4.5 Audit trail

Temporal's workflow history already records every signal, every activity input and output, and every result, durably and immutably. That is the audit log — no second system.

**As configured today this claim is FALSE, and that is the single most important
gap in the project.** Measured against the running stack:

| An auditor asks | Answerable? |
|---|---|
| Which document, by content hash | ✅ `BlobRef.sha256` in the activity input |
| When, which prompt, which model, tokens | ✅ in history |
| Which tool / binary version | ❌ never recorded — the `--version` probe runs and the output is discarded |
| Which worker build, which prompt version | ❌ no `buildId`, prompts are unversioned constants |
| Whether each citation was verified | ⚠️ in history, but dropped before it reaches the graph or the user |
| **Does the record still exist?** | ❌ **retention is 24h and archival is disabled** |

The last row voids the rest. `temporal server start-dev` defaults to a 24-hour
retention window with `HistoryArchivalState: Disabled`, and nothing in the repo
changes it. A trail that evaporates in a day is not an audit trail.

What has to be true before this claim can be made honestly:

- Activity inputs carry `BlobRef` (immutable content hash), never mutable paths. *(holds today)*
- Model calls record model id, effort, and token usage. *(holds today)*
- Tool invocations record the resolved binary version. *(missing)*
- The worker records a `buildId`, and prompts/verifiers carry a version. *(missing)*
- Retention exceeds the firm's obligation, **or** history is projected into durable
  storage at terminal state. *(missing — see §10 Q1)*

The projection is the realistic answer: Temporal is an execution store, not an
archive, and stretching retention to years is fighting the tool. One activity
writing an immutable record on run completion — session, graph, node executions,
artifact hashes, citations and their `verified` flags — gives a durable trail
without dual-writing live state.

---

## 5. Tools

### 5.1 The split

**Deterministic byte operations run locally. The model does judgment.**

Compressing a PDF is not a language task. Running it through a model would be slower, more expensive, non-reproducible, and would send the document somewhere it doesn't need to go. Local tools are the default; a model call is a deliberate escalation.

### 5.2 v1 registry

| Tool id | Implementation | In → Out |
|---|---|---|
| `pdf.extract_text` | `pypdf` / `pdfplumber` | pdf → text |
| `pdf.compress` | `qpdf` (lossless) or Ghostscript (`screen`/`ebook`/`printer`) | pdf → pdf |
| `pdf.split` | `pypdf`, page ranges | pdf → pdf[] |
| `pdf.merge` | `pypdf` | pdf[] → pdf |
| `pdf.to_docx` | LibreOffice headless | pdf → docx |
| `docx.to_pdf` | LibreOffice headless | docx → pdf |

Summarising, clause extraction, comparison, and Q&A are **`chat` nodes**, not tools — they take a document input and go to the model.

### 5.3 The tool contract

This is the extension point. Adding a tool should mean writing one file and registering it — nothing else.

```ts
export interface ToolDef<P = Record<string, unknown>> {
  id: string;                     // "pdf.compress"
  label: string;                  // "Compress PDF"
  glyph: string;                  // "⚙"
  accepts: string[];              // mime types, e.g. ["application/pdf"]
  produces: string[];             // mime types
  params: ParamSpec[];            // rendered as node form controls
  run(ctx: {
    inputs: BlobRef[];
    params: P;
    read(ref: BlobRef): Promise<Buffer>;
    write(buf: Buffer, meta: { filename: string; mime: string }): Promise<BlobRef>;
    heartbeat(progress: number): void;
  }): Promise<{ outputs: BlobRef[]; log: string }>;
}
```

Every tool executes as a **Temporal activity**, so it gets retries, timeouts, and heartbeat-based cancellation for free. `params` drives the node's form UI from the same definition — no separate frontend registration.

Tools shell out to binaries the worker owns (`qpdf`, `gs`, `soffice`). Those go in the worker's container image, pinned by version — a conversion that behaves differently after an unpinned upgrade is an audit-trail problem, not just a bug.

**Sandboxing:** tools process untrusted files from outside the firm. Run the worker unprivileged, with a read-only root filesystem apart from a scratch dir, and give LibreOffice and Ghostscript a wall-clock timeout and a memory cap. Both are large C++ surfaces with a history of parser CVEs.

---

## 6. LLM integration

### 6.1 Provider

**Makora** (`https://inference.makora.com/v1`) serving **`deepseek-ai/DeepSeek-V4-Flash`** — an OpenAI-compatible endpoint consumed through the **Vercel AI SDK** (`ai` + `@ai-sdk/openai-compatible`). Config: `MAKORA_BASE_URL` / `MAKORA_API_KEY` / `MAKORA_MODEL`.

One module owns the provider (`lib/llm.ts` in each app) so swapping it is a one-file change.

What this costs us, stated plainly:

Verified against the live endpoint, not assumed:

| Works | Does not work / absent |
|---|---|
| Chat completion, streaming | `response_format: json_schema` — **accepted but not enforced**, returns malformed JSON |
| `response_format: json_object` | PDF or image input |
| Tool / function calling | Provider-native citations |
| `reasoning_effort` | Upload-once file references |

Everything the design depends on is in the left column. §6.3 is how we get legal-grade provenance without the right one.

**It is a reasoning model, which has two sharp consequences.** Reasoning draws on the same `max_tokens` budget as the answer, so an under-budgeted call returns `content: null` with `finish_reason: "length"` — a silent blank, not an error. And `reasoning_effort` dominates cost: on an identical structured task the default burned 11,308 completion tokens and produced malformed output, while `low` used **118** and produced valid JSON. `low` is the default for structured work, and a null completion is treated as a hard error.

### 6.2 Planning — `streamObject`

`planGraph(prompt, currentGraph, toolManifests)` calls `streamObject` against the `PlanResult` zod schema from `@wf/shared`. No hand-rolled JSON parsing, no "output only JSON" prompting.

The model returns `{ reply, nodes, edges }` and nothing else. Deliberately absent: `position`, `id`, `status`, `blob`. Positions come from the deterministic layout function; IDs from a workflow-local counter; the rest is runtime state. Letting the model choose coordinates produces overlapping nodes and non-replayable workflows.

The tool registry is injected into the prompt so the planner can only name tools that exist, and `toolId` is validated against the registry after parsing. A hallucinated tool becomes a validation error surfaced in chat — not a broken node.

**`streamObject` emits partial objects**, so nodes materialise onto the canvas as the model produces them. This is the real version of the effect an earlier draft faked with a paced emission loop; that workaround is gone.

**This gateway does not implement native structured outputs**, so the AI SDK's `supportsStructuredOutputs` flag stays `false` and object generation goes through JSON mode. That is the configuration that works — enabling schema mode breaks it. Never silently degrade to freeform text and hope the parse succeeds.

### 6.3 Provenance — verified citations

This is the most important design decision in the project, and it is *better* than what we lost.

1. `pdf.extract_text` produces page-tagged text — `ExtractedText { pages: [{ page, text }] }`.
2. A `chat` node sends that text to the model with explicit `[[page N]]` markers.
3. The model returns `AnalysisResult`: an answer plus `citations: [{ page, quote }]`, each quote **verbatim**.
4. A verifier string-matches every quote against the extracted text of the page it claims, and sets `Citation.verified`.
5. The UI renders verified citations as page links and unverified ones with a warning marker.

A model-asserted page number is a claim. A verified one is a fact. `verified: true` is never set without a real match, and the match normalises whitespace before comparing.

The pleasant consequence: this is provider-agnostic. It works on any endpoint that can return structured output, and it would keep working — unchanged — if we later moved to a provider with native citations.

### 6.4 Layout

A pure function in the workflow (`layout()` in `@wf/shared`): layered left-to-right by topological depth, 320px column pitch, 180px row pitch, vertically centred per column. Deterministic, so replay produces identical coordinates. User drags emit `node.updated` and take precedence.

### 6.5 Token budget

Long documents are the norm here, not the exception. Keep `maxOutputTokens` generous — a truncated extraction fails quietly and looks like a bad answer rather than an error. Chunk by page ranges when a document exceeds the context window, and carry page numbers through the chunking so citations survive it.

## 7. Temporal design

### 7.1 One workflow per canvas session

`graphSessionWorkflow({ sessionId })` is long-running and holds the authoritative graph. The browser holds a replica.

The argument is a **single object, not a positional string** — continue-as-new re-invokes the same signature carrying a large state blob, and a named field survives additions that argument order would not. Passing a bare string fails silently: `input.sessionId` is `undefined` and the workflow runs against a session that does not exist.

### 7.2 Message passing

| Kind | Name | Payload | Purpose |
|---|---|---|---|
| Signal | `submitPrompt` | `{ text }` | user typed in the chat bar |
| Signal | `mutateGraph` | `{ op, payload }` | add / move / delete / connect / attach blob |
| Signal | `runGraph` | `{}` | execute the graph |
| Signal | `close` | `{}` | end the session |
| Query | `getEventsSince` | `cursor: number` | SSE pump reads the event log |
| Query | `getGraph` | — | full snapshot for reconnect |

Signals rather than updates: the browser doesn't block on results, it watches the stream. `getEventsSince` is a query because it must be side-effect free and cheap at ~10 Hz.

### 7.3 The event log

Append-only, in workflow memory:

```ts
type GraphEvent =
  | { seq: number; t: "node.added";   node: GraphNode }
  | { seq: number; t: "node.updated"; id: string; patch: Partial<GraphNode> }
  | { seq: number; t: "node.removed"; id: string }
  | { seq: number; t: "edge.added";   edge: GraphEdge }
  | { seq: number; t: "edge.removed"; id: string }
  | { seq: number; t: "chat";         role: "user"|"assistant"; text: string }
  | { seq: number; t: "run.started" }
  | { seq: number; t: "run.finished"; ok: boolean };
```

**Why a log rather than diffing snapshots:** the SSE pump polls a query, and diffing two graphs to infer what changed is wasteful and ambiguous (did a node move, or was it deleted and re-added?). A cursor into an append-only log makes reconnect trivial — the browser sends its last `seq` and receives exactly what it missed.

### 7.4 Lifecycle

- Main function parks on `await condition(() => closed)`; handlers do the work.
- `continueAsNew` when `events.length > 2000` or `historyLength > 4000`, carrying `{ graph, tailEvents }` forward. Reseed `seq` so cursors stay monotonic.
- `await condition(allHandlersFinished)` before returning.

### 7.5 Determinism rules

Anything touching the network, the filesystem, or randomness lives in an **activity**. Node IDs come from a workflow-local counter (`n1`, `n2`, …), never `crypto.randomUUID()`. Positions come from §6.4's pure layout function, never from the model.

The clock is the exception: `Date.now()` is replay-safe *inside* workflow code because the Temporal sandbox swaps the global `Date` for a deterministic one. (There is no `workflow.now()` in the TS SDK — an earlier draft of this document said otherwise and was wrong.)

### 7.6 Execution

Topological sort in the workflow. Independent nodes run as concurrent activities via `Promise.all`. Tool activities get retries with backoff; model activities get fewer retries and a longer timeout. A failed node marks downstream nodes `error` without running them.

---

## 8. Transport

### 8.1 SSE pump

`GET /api/sessions/:id/stream?cursor=N`:

```
handle = client.workflow.getHandle(sessionId)
loop every 120ms:
  events = await handle.query(getEventsSince, cursor)
  for e of events: write `data: ${JSON.stringify(e)}\n\n`
  cursor = last.seq
  every 15s: write `: ping\n\n`     // keep intermediaries from closing it
```

The browser reconnects with its last `seq`, so a dropped connection loses nothing.

**Why poll a query instead of pushing:** Temporal has no server-push to an external client. A 120ms query poll is cheap — queries write no history — and invisible at human timescales. If it ever isn't, the fix is a side-channel signal to the API, not a faster poll.

### 8.2 Mutations

Plain `POST`, one per signal. Optimistic on the client: apply locally, send the signal, let the returning event confirm. The workflow is authoritative, so a conflicting event simply overwrites — correct for a single-user canvas.

---

## 9. Milestones

| # | Milestone | Done when |
|---|---|---|
| 1 | Canvas shell | White canvas, dark dots, rail with two circular buttons, chat bar. Hardcoded nodes. |
| 2 | Node kinds | All five kinds render with correct glyphs, handles, and status treatments. Edges connect by drag. |
| 3 | Shared package | `shared` exports the zod schemas; frontend imports them. |
| 4 | Temporal skeleton | `docker-compose up`, worker connects, workflow starts, `getGraph` returns an empty graph. |
| 5 | **SSE loop** | Manual node add via POST → signal → event log → SSE → node appears. No LLM, no files. |
| 6 | Blob store + first tool | Upload a PDF, `pdf.compress` runs as an activity, artifact downloads. |
| 7 | Planning | Chat prompt → `planGraph` → nodes cascade onto canvas, connected, tools validated. |
| 8 | Document chat + citations | Summarise a PDF; citations render inline and link to pages. |
| 9 | Execution | Run → topological execution → statuses animate → artifacts collect at output nodes. |
| 10 | Hardening | Reconnect, continue-as-new, tool sandboxing, error states, retention policy. |

**Milestone 5 is the integration risk.** Get the full loop working end-to-end with a dumb payload before adding either Claude or file handling.

---

## 10. Open questions

1. **Retention.** How long must workflow history be kept for the audit trail to satisfy the firm's obligations, and does that exceed what Temporal retention gives us? If yes, we need an export path to real storage before v1 ships, not after.
2. **Whose endpoint is `LLM_BASE_URL`?** A self-hosted model, a firm-controlled proxy, and a third-party API have very different disclosure profiles, and for a legal application that difference is the whole ballgame. The code doesn't care; the risk assessment does. (The provider choice already settles the narrower question of *what* is sent: extracted text only — no document ever leaves as a file.)
3. **Build mode.** Node palette on right-click, or drag-from-rail? Unresolved.
4. **Chat history placement.** Currently `chat` events in the log rendered in a side panel. May belong as canvas annotations instead.
5. ~~The no-color constraint vs. destructive confirmations.~~ **Resolved:** stays monochrome. Destructive confirmation is a modal with a double-stroke border, the affected downstream nodes listed by name, and type-to-confirm. The friction does the work colour would have.
