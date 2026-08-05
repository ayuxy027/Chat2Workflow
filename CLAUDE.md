# CLAUDE.md

Chat-driven document workflow canvas for legal work. React Flow canvas + Temporal durable execution + an LLM behind an OpenAI-compatible endpoint. See `docs/PRD.md` for the spec — this file is the operating manual.

---

## Stack (verified installed)

| Layer | Choice | Version |
|---|---|---|
| App | Next.js App Router + Turbopack | 16.3.0 |
| React | React / React DOM | 19.2.8 |
| Styling | Tailwind | 4.3.3 |
| Canvas | `@xyflow/react` | 12.11.2 |
| Orchestration | `@temporalio/*` | 1.21.1 |
| LLM | `ai` (Vercel AI SDK) + `@ai-sdk/openai-compatible` | 5.0.226 / 1.0.47 |
| Schemas | `zod` | 3.25.76 |
| Package manager | **bun** | 1.3.14 |

---

## Layout

```
Workflows/
├── apps/
│   ├── web/            Next.js — canvas, API routes, SSE, blob store
│   │   ├── app/        App Router; app/api/* is the backend
│   │   ├── components/ canvas + node UI
│   │   └── lib/        temporal client, blob store, llm client, adapters
│   └── worker/         Temporal worker — workflows, activities, tools
├── shared/    zod schemas — THE contract, imported by both apps
├── reference/
│   └── react-flow/     READ-ONLY React Flow demo (see below)
├── docs/               user-authored
├── docker-compose.yml  Temporal server + UI
└── .env.example
```

**bun uses isolated per-workspace `node_modules`.** Root `node_modules/` has only `typescript`; real deps live in `frontend/node_modules` and `backend/node_modules`. That is correct — don't "fix" it.

### `reference/react-flow/` is read-only

The vendored React Flow "overview" demo — plain JSX, its own package.json, **not** a workspace member. **Read it to learn the API. Never import from it, never build it, never edit it.**

- `src/App.tsx` — `nodeTypes`/`edgeTypes` registration, `useNodesState`/`useEdgesState`/`addEdge`
- `src/CircleNode.jsx` — minimal custom node with a `Handle`
- `src/ButtonEdge.jsx` — custom edge with `EdgeLabelRenderer`
- `src/xy-theme.css` — every CSS variable React Flow exposes for theming

---

## Commands

```bash
bun install                 # root — installs all workspaces
docker compose up -d        # Temporal: gRPC :7233, UI http://localhost:8233

bun run dev:web             # Next.js  → http://localhost:3000
bun run dev:worker          # Temporal worker

bun run --filter @wf/shared typecheck
bun run --filter @wf/frontend build
```

Web + worker + Temporal must all be running for the app to work.

---

## Design rules

**Light theme. Black and white only. No hue, anywhere** — not in accents, not in status, not in errors. Hard constraint (`docs/PRD.md` §3.1): legal documents are black on white and this tool sits beside them.

Tokens are defined in `frontend/app/globals.css` under `@theme` and are available as Tailwind utilities:

`bg-bg` `text-fg` `bg-surface` `bg-surface-2` `border-line` `border-line-strong` `text-muted` `border-faint` `shadow-node` `shadow-float` `rounded-node`

Only `#FFFFFF` and `#0A0A0A` are literal colors; everything else is black at an opacity. Tailwind v4 has **no config file** — theme goes in `@theme { }` in CSS. Never create `tailwind.config.js`.

**Status is encoded without color** (`docs/PRD.md` §3.4):

| State | Treatment |
|---|---|
| idle | 1px `line` border |
| queued | 1px `line`, glyph at 45% opacity |
| running | 2px border + `.wf-marching` dash animation |
| done | 2px solid `fg` border |
| error | 2px border + offset 1px outer ring, glyph → `!` |

If you reach for red, stop and re-read §3.4. Destructive confirmation stays monochrome too: modal with a double stroke, affected downstream nodes listed by name, type-to-confirm.

`prefers-reduced-motion` is honored — motion only ever *reinforces* an encoding that already works statically.

---

## Legal-domain rules

Requirements, not preferences:

1. **Citations are mandatory and must be verified.** See §Provenance below.
2. **Never present output as advice.** Results are drafts; the disclaimer in the output panel is not decoration.
3. **Document bytes stay local by default.** Deterministic operations (compress, convert, split, extract) run as local tools in the worker. A model call is a deliberate escalation, visible in the UI.
4. **Temporal history is the audit trail.** Activity inputs carry immutable `BlobRef` content hashes, never mutable paths. Record model id and token usage in activity results.

### Provenance — how citations actually work here

We are on an **OpenAI-compatible endpoint**, so Anthropic's native `citations` / `page_location` and the Files API are unavailable. The replacement is better anyway, because it is *verifiable* rather than *asserted*:

1. `pdf.extract_text` produces page-tagged text → `ExtractedText { pages: [{page, text}] }`.
2. A `chat` node sends page-marked text (`[[page N]]`) to the model.
3. The model returns `AnalysisResult` — an answer plus `citations: [{page, quote}]`, quote **verbatim**.
4. A verifier string-matches each quote against that page's extracted text and sets `Citation.verified`.
5. The UI renders verified citations as links and unverified ones with a warning marker.

A model-asserted page number is a claim; a verified one is a fact. Never set `verified: true` without running the match.

---

## Temporal rules

**Determinism.** Anything touching the network, clock, filesystem, or randomness goes in an **activity**, never in workflow code:

- Node IDs — workflow-local counter (`n1`, `n2`, …). **Never `crypto.randomUUID()`.**
- Positions — `layout()` from `@wf/shared`, which is pure. **Never from the model.**
- Time — `Date.now()` is CORRECT inside workflow code. The Temporal sandbox replaces the global `Date` with a deterministic clock, so `Date.now()` is replay-safe. There is no `workflow.now()` export in the TS SDK — do not reach for one.

**Blobs never ride in payloads.** Temporal's limit is 2MB (4MB hard); a 200-page PDF exceeds it. Pass `BlobRef` and let activities read/write the content-addressed store directly.

**Signals mutate, queries read.** The workflow parks on `await wf.condition(() => closed)` and lets handlers do the work. `continueAsNew` past ~2000 events carrying `{ graph, tailEvents }`, reseeding `seq` so SSE cursors stay monotonic. `await wf.condition(wf.allHandlersFinished)` before returning.

**Queries must be side-effect free** — the SSE pump calls `getEventsSince` at ~8 Hz.

---

## LLM — Makora / DeepSeek-V4-Flash

Endpoint is **OpenAI-compatible**, consumed through the **Vercel AI SDK**. Env:
`MAKORA_BASE_URL` (`https://inference.makora.com/v1`), `MAKORA_API_KEY`, `MAKORA_MODEL`
(`deepseek-ai/DeepSeek-V4-Flash`). One module per app owns the provider so swapping is a
one-file change.

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const provider = createOpenAICompatible({
  name: "makora",
  baseURL: process.env.MAKORA_BASE_URL!,
  apiKey: process.env.MAKORA_API_KEY!,
  // supportsStructuredOutputs stays FALSE — see finding 1 below.
});
export const model = provider.chatModel(process.env.MAKORA_MODEL!);
```

### Verified endpoint behaviour

These come from probing the live endpoint, not from docs. Do not "fix" the code back to the
theoretical defaults.

**1. `json_schema` structured output is broken here. Never enable it.**
The API accepts `response_format: {type:"json_schema", strict:true}` but does not constrain
generation. A trivial 2-node request returned **malformed JSON** (a stray `{"{` prefix) after
burning 11,308 completion tokens. `response_format: {type:"json_object"}` works correctly and
returns valid parseable JSON.

In AI SDK v5 `generateObject` has **no `mode` parameter** — `supportsStructuredOutputs` on the
provider is the only control. Leaving it `false` (the default) selects JSON mode, which is the
path that works. Setting it `true` breaks object generation.

**2. Reasoning consumes `max_tokens`, and exhaustion is silent.**
DeepSeek-V4-Flash is a reasoning model; reasoning and content draw on the same budget. A
`max_tokens: 20` request produced 20 reasoning tokens and `content: null` with
`finish_reason: "length"` — no error, just an empty answer.

- Set `maxOutputTokens` to **at least 8000** on every call.
- Treat `content == null` or `finish_reason === "length"` as a **hard error** with an explicit
  message, never as an empty result. This is the failure mode most likely to reach a user as a
  blank summary.

**3. `reasoning_effort` is the dominant cost lever.** Same task, same output:

| effort | completion tokens | valid JSON |
|---|---:|---|
| (default) | 11,308 | ✗ malformed |
| `low` | **118** | ✓ |
| `medium` | 160 | ✗ (fenced) |

Pass it through `providerOptions` and default to **`low`** for structured work (planning,
citation extraction). Two orders of magnitude, and better output. Keep it a named constant so
it stays tunable.

**4. Be defensive about markdown fences.** The `medium` probe returned JSON wrapped in a code
fence. Strip ```` ```json ```` fences before any manual parse.

**5. The assistant message carries a `reasoning` field.** Never persist reasoning text into the
graph, node results, or the audit trail — it is not a citation-backed claim, and this is a
legal application.

### Consequences for the design

No vision, no PDF upload, no provider-native citations. Documents reach the model as extracted
text only — which is exactly why provenance is built on verified quotes (see §Provenance above)
rather than on a provider feature.

## Tools

Adding a document tool = writing one file implementing `ToolDef` and registering it. The node form UI is generated from `params`; execution goes through one generic Temporal activity that supplies retries, timeouts, and heartbeat cancellation. Contract in `shared/src/tools.ts` and `docs/PRD.md` §5.3.

Tools shell out to binaries the worker owns (`qpdf`, `gs`, `soffice`). **Pin them by version in the worker image** — a conversion that changes behavior after an unpinned upgrade breaks the audit trail, not just the build.

**Sandboxing is not optional.** These parse untrusted files from outside the firm, and LibreOffice and Ghostscript are large C++ surfaces with a CVE history. Unprivileged worker, read-only root apart from a scratch dir, wall-clock timeout and memory cap per invocation.

---

## Conventions

- **`shared` is the single source of truth for graph shape.** Zod schemas, types via `z.infer`. Never redeclare a node/edge/event type in an app.
- **The React Flow node is a projection, not the domain object.** `GraphNode` → `{ id, type: kind, position, data: {...rest} }`. That mapping lives in exactly one adapter module — don't inline it at call sites.
- **Custom nodes are `memo`'d** and `nodeTypes` is defined at module level. Defining it inside a component remounts every node on every render.
- **Programmatic canvas changes go through `useReactFlow()`** (`addNodes`, `updateNodeData`, `deleteElements`) — it doesn't subscribe to store updates, so it won't trigger re-renders.
- Server-only modules (`lib/temporal.ts`, `lib/blobs.ts`, `lib/llm.ts`) must never be imported from a client component. Mark them `import "server-only"`.
- TypeScript strict. No `any` in `shared`.

---

## Current state

All three layers are built and the full loop works against the live Makora endpoint:
prompt → Temporal signal → plan → event log → SSE → canvas. `bun run --filter @wf/frontend build`
and `--filter @wf/backend typecheck` are both green, Temporal runs via `docker compose`.

**Known blockers — read before building on this:**

1. **`BLOB_DIR` must be absolute.** The web app and worker are separate processes with
   different working directories; a relative path silently produces two stores and every
   document node fails at run time. Fixed in `.env`; the guard belongs in code.
2. **The audit trail has a 24-hour half-life.** Retention is the `start-dev` default and
   archival is disabled. See `docs/PRD.md` §4.5 — the claim there is corrected, not aspirational.
3. **Tool/binary versions and worker build id are not recorded**, so history cannot answer
   "which version of Ghostscript produced this conversion".
4. **`node dist/main.js` does not run** — `shared` uses extensionless relative
   specifiers that Node's type-stripping will not rewrite. Dev (tsx) works; the built artifact
   does not. Typecheck and build both pass anyway, so verify by *starting* things.

Next per `docs/PRD.md` §9: the chat→canvas experience — true streaming of planned nodes,
editable tool params via `GET /api/tools`, and planner recipes for short asks.
