"use client";

/**
 * The node inspector — click a node, edit everything about it.
 *
 * The canvas answers "what is this pipeline"; this panel answers "what exactly
 * will this step do". Before it existed the only editable things on a node were
 * a chat prompt and an input field, and tool parameters were read-only because
 * nothing in the browser knew what parameters a tool even had. `GET /api/tools`
 * plus `ParamForm` fixes that generically: every tool, including ones added
 * later, gets a real form from its own `ParamSpec[]`.
 *
 * ONE THING IS DELIBERATELY NOT EDITABLE. A model step's citation scaffolding —
 * the instruction that quotes must be verbatim and pages must be named — is
 * system-owned and shown read-only. Handing it to the user as a free textarea
 * would let provenance be deleted by accident, and the node would go on
 * returning an answer that looks exactly like a verified one. Everything the
 * user actually wants to control (what to ask, which tool, which template,
 * which document) is theirs; the machinery that makes the answer checkable is
 * not. See PRD §3.6 and CLAUDE.md §Provenance.
 *
 * Right-hand side, so it never covers the rail or the Chat/Build panels. Not a
 * modal: the canvas stays live behind it and edits land on the node you can
 * still see.
 */

import { useEffect, useRef, useState } from "react";
import {
  citationTarget,
  nodeInputText,
  type BlobRef,
  type GraphNode,
  type NodeStatus,
} from "@wf/shared";
import { KIND_GLYPH, KIND_NAME, inputTextMutation } from "@/lib/graph-adapter";
import type { SessionApi } from "@/lib/use-session";
import { useToolRegistry } from "@/lib/use-tools";
import { CaveatDetail } from "@/components/caveats";
import { Citations, DraftNotice } from "@/components/citations";
import { ParamForm } from "@/components/param-form";
import { formatBytes } from "@/components/nodes/node-shell";

const STATUS_WORD: Record<NodeStatus, string> = {
  idle: "not run yet",
  queued: "queued",
  running: "running",
  done: "done",
  error: "error",
};

const FIELD =
  "w-full rounded-[4px] border border-line bg-surface px-2 py-1.5 text-[11px] leading-[1.5] text-fg placeholder:text-muted focus:border-line-strong focus:outline-none";

export interface InspectorProps {
  node: GraphNode;
  session: SessionApi;
  onClose(): void;
  onDelete(id: string): void;
}

export function Inspector({ node, session, onClose, onDelete }: InspectorProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Only when focus is inside the panel — Escape on the canvas belongs to
      // the canvas, and stealing it would make the key mean two things.
      if (event.key !== "Escape") return;
      if (panelRef.current?.contains(document.activeElement) !== true) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch: Patch = (fields) =>
    session.mutate({ op: "updateNode", id: node.id, patch: fields });

  const busy = node.status === "running" || node.status === "queued";
  const hasResult = node.result !== undefined && node.result.length > 0;
  const showsModelOutput = node.kind === "chat" || node.kind === "output";

  return (
    <aside
      ref={panelRef}
      aria-label={`Inspector: ${node.label}`}
      className="absolute inset-y-0 right-0 z-30 flex w-[360px] max-w-[85vw] flex-col border-l border-line bg-surface shadow-float"
    >
      <header className="flex items-center gap-2 border-b border-faint bg-surface-2 px-3 py-2.5">
        <span aria-hidden="true" className="text-[13px] leading-none">
          {node.status === "error" ? "!" : KIND_GLYPH[node.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.09em] text-muted">
            {KIND_NAME[node.kind]} · {node.id}
          </p>
        </div>
        <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-muted">
          {STATUS_WORD[node.status]}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="shrink-0 rounded-full px-1 text-[11px] text-muted hover:text-fg"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <Section label="Name">
          <DeferredText
            value={node.label}
            ariaLabel="Node name"
            onCommit={(next) => {
              if (next.trim() !== "") patch({ label: next.trim() });
            }}
          />
        </Section>

        {node.error !== undefined && (
          <p className="rounded-[4px] border border-fg px-2 py-1.5 text-[11px] leading-[1.5] shadow-[0_0_0_2px_#FFFFFF,0_0_0_3px_rgba(0,0,0,0.55)]">
            <span aria-hidden="true" className="mr-1 font-semibold">
              !
            </span>
            {node.error}
          </p>
        )}

        {node.kind === "tool" && <ToolEditor node={node} busy={busy} patch={patch} />}
        {node.kind === "chat" && <ChatEditor node={node} patch={patch} />}
        {node.kind === "input" && <InputEditor node={node} session={session} />}
        {node.kind === "document" && <DocumentEditor node={node} session={session} />}
        {(node.kind === "output" || node.outputs.length > 0) && (
          <ArtifactList outputs={node.outputs} />
        )}

        {hasResult && (
          <Section label={showsModelOutput ? "Result (draft)" : "Log"}>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-[4px] border border-faint bg-surface-2 px-2 py-1.5 text-[11px] leading-[1.55]">
              {node.result}
            </p>
            {showsModelOutput && <DraftNotice />}
          </Section>
        )}

        {showsModelOutput && (hasResult || node.citations.length > 0) && (
          <Section label="Provenance">
            <Citations citations={node.citations} />
            <CitationDetail citations={node.citations} />
          </Section>
        )}

        <CaveatDetail node={node} />

        <div className="border-t border-faint pt-3">
          <button
            type="button"
            onClick={() => onDelete(node.id)}
            className="rounded-full border border-line px-3 py-1 text-[11px] hover:border-line-strong"
          >
            Delete this step
          </button>
        </div>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-kind editors                                                           */
/* -------------------------------------------------------------------------- */

type Patch = (fields: {
  label?: string;
  prompt?: string;
  toolId?: string;
  params?: Record<string, unknown>;
}) => void;

/**
 * Tool node: pick the tool, then fill in its own form.
 *
 * The tool list and every field below it come from the registry — nothing here
 * names a tool or a parameter, so `template.apply`'s three-option picker and
 * `pdf.compress`'s quality enum are the same code path.
 */
function ToolEditor({ node, busy, patch }: { node: GraphNode; busy: boolean; patch: Patch }) {
  const registry = useToolRegistry();
  const manifest = node.toolId === undefined ? undefined : registry.byId.get(node.toolId);

  return (
    <>
      <Section label="Tool">
        {registry.loading ? (
          <p className="text-[11px] text-muted">loading the registry…</p>
        ) : registry.error !== undefined ? (
          <p className="text-[11px] text-fg">
            <span aria-hidden="true" className="mr-1 font-semibold">
              !
            </span>
            {registry.error} — parameters cannot be edited until it loads.
          </p>
        ) : (
          <select
            aria-label="Tool"
            value={node.toolId ?? ""}
            onChange={(event) => patch({ toolId: event.target.value })}
            className={FIELD}
          >
            <option value="" disabled>
              choose a tool…
            </option>
            {registry.tools.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.label} · {tool.id}
              </option>
            ))}
          </select>
        )}

        {manifest !== undefined && (
          <p className="mt-1.5 text-[10px] leading-[1.5] text-muted">
            {manifest.description}
          </p>
        )}

        {node.toolId !== undefined && manifest === undefined && !registry.loading && (
          <p className="mt-1.5 text-[10px] leading-[1.5] text-fg">
            <span aria-hidden="true" className="mr-1 font-semibold">
              !
            </span>
            No tool with id <span className="font-mono">{node.toolId}</span> is
            registered. This step cannot run until you pick one that is.
          </p>
        )}
      </Section>

      {manifest !== undefined && (
        <Section label="Parameters">
          <ParamForm
            specs={manifest.params}
            params={node.params}
            disabled={busy}
            onChange={(name, value) => {
              const next = { ...node.params };
              // `undefined` means "cleared", and JSON would drop the key on the
              // way out — so remove it rather than sending a key that vanishes.
              if (value === undefined) delete next[name];
              else next[name] = value;
              patch({ params: next });
            }}
          />
          {busy && (
            <p className="mt-1.5 text-[10px] text-muted">
              Parameters are locked while this step is running.
            </p>
          )}
        </Section>
      )}
    </>
  );
}

/**
 * Chat node: the task is the user's, the citation contract is not.
 *
 * The read-only block is a description of the mechanism rather than a copy of
 * the worker's system prompt — copying it here would drift the moment the
 * worker's wording changed, and a stale claim about how provenance works is
 * worse than a general one.
 */
function ChatEditor({ node, patch }: { node: GraphNode; patch: Patch }) {
  return (
    <>
      <Section label="What this step asks the model">
        <DeferredText
          value={node.prompt ?? ""}
          ariaLabel="Task prompt"
          multiline
          placeholder="e.g. Summarise every indemnity clause and quote the operative language."
          onCommit={(next) => patch({ prompt: next.trim() })}
        />
      </Section>

      <Section label="Citation contract · system-owned">
        <div className="rounded-[4px] border border-dashed border-line bg-surface-2 px-2 py-1.5">
          <p className="text-[10.5px] leading-[1.55] text-muted">
            Every model step is wrapped in a system instruction requiring each claim
            to carry a verbatim quote and the page it came from. A verifier then
            string-matches every quote against that document&apos;s extracted text and
            marks the citation verified or not.
          </p>
          <p className="mt-1.5 text-[10.5px] leading-[1.55] text-muted">
            This part is not editable. Removing it would not make the model refuse —
            it would keep answering, just as confidently, with nothing checkable
            behind it, and the result would look identical to a verified one.
          </p>
        </div>
      </Section>
    </>
  );
}

/**
 * Input node: free text that feeds downstream steps.
 *
 * Routed through `inputTextMutation` rather than written inline, because where
 * this value lives is a question both packages have already answered
 * differently once — with the result that typed input never reached the model.
 */
function InputEditor({ node, session }: { node: GraphNode; session: SessionApi }) {
  return (
    <Section label="Value">
      <DeferredText
        value={nodeInputText(node)}
        ariaLabel="Input value"
        multiline
        placeholder="a matter reference, a counterparty name, a clause number…"
        onCommit={(next) => session.mutate(inputTextMutation(node, next))}
      />
      <p className="mt-1.5 text-[10px] leading-[1.5] text-muted">
        Passed to every step wired downstream of this one, labelled with this
        node&apos;s name.
      </p>
    </Section>
  );
}

/** Document node: attach, replace, detach. */
function DocumentEditor({ node, session }: { node: GraphNode; session: SessionApi }) {
  const blob = node.blob;

  return (
    <Section label="Document">
      {blob !== undefined ? (
        <div className="space-y-1.5">
          <p className="truncate font-mono text-[11px]">{blob.filename}</p>
          <p className="text-[10px] text-muted">
            {blob.pages !== undefined ? `${blob.pages} pages · ` : ""}
            {formatBytes(blob.bytes)} · {blob.mime}
          </p>
          <p className="truncate font-mono text-[9px] text-muted" title={blob.sha256}>
            {blob.sha256}
          </p>
          <div className="flex gap-2 pt-1">
            <FilePicker
              label="Replace"
              onPick={(file) => void session.attachDocument(node.id, file)}
            />
            <button
              type="button"
              onClick={() => session.mutate({ op: "detachBlob", id: node.id })}
              className="rounded-full border border-line px-2.5 py-0.5 text-[10px] hover:border-line-strong"
            >
              Detach
            </button>
          </div>
          <p className="text-[10px] leading-[1.5] text-muted">
            Replacing or detaching also clears this step&apos;s result and citations —
            they were derived from these bytes and would otherwise keep flowing
            downstream under a document that is no longer attached.
          </p>
        </div>
      ) : (
        <FilePicker
          label="Attach a document"
          onPick={(file) => void session.attachDocument(node.id, file)}
        />
      )}
    </Section>
  );
}

function ArtifactList({ outputs }: { outputs: BlobRef[] }) {
  return (
    <Section label="Artifacts">
      {outputs.length === 0 ? (
        <p className="text-[11px] text-muted">
          Nothing yet. Artifacts appear here after a run.
        </p>
      ) : (
        <ul className="space-y-1">
          {outputs.map((output) => (
            <li key={output.sha256} className="flex items-baseline gap-2">
              <a
                // `?download=1` forces `Content-Disposition: attachment` even for
                // the types the blob route serves inline for citation links.
                href={`/api/blobs/${output.sha256}?download=1`}
                download={output.filename}
                className="min-w-0 flex-1 truncate font-mono text-[11px] underline decoration-line underline-offset-2 hover:decoration-fg"
              >
                {output.filename}
              </a>
              <span className="shrink-0 text-[10px] text-muted">
                {formatBytes(output.bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * Every citation in full: the quote, the page, and whether the match held.
 *
 * The chips on the node are a summary; this is where someone checking the work
 * can read what was actually quoted without opening the source first.
 */
function CitationDetail({ citations }: { citations: GraphNode["citations"] }) {
  if (citations.length === 0) return null;

  return (
    <ul className="mt-2 space-y-1.5">
      {citations.map((citation, index) => (
        <li
          key={`${citation.blob}-${citation.page}-${index}`}
          className={`rounded-[4px] px-2 py-1.5 text-[10.5px] leading-[1.5] ${
            citation.verified
              ? "border border-faint bg-surface-2"
              : "border border-fg shadow-[0_0_0_2px_#FFFFFF,0_0_0_3px_rgba(0,0,0,0.55)]"
          }`}
        >
          <p className="mb-0.5 flex items-center gap-1.5 text-[9px] uppercase tracking-[0.08em] text-muted">
            {!citation.verified && (
              <span aria-hidden="true" className="font-semibold text-fg">
                !
              </span>
            )}
            <span>page {citation.page}</span>
            <span>·</span>
            <span>{citation.verified ? "verified" : "unverified"}</span>
            {citation.verified && (
              <a
                href={`/api/blobs/${citationTarget(citation)}#page=${citation.page}`}
                target="_blank"
                rel="noreferrer"
                className="ml-auto underline decoration-line underline-offset-2 hover:decoration-fg"
              >
                open source
              </a>
            )}
          </p>
          <p className="text-fg">&ldquo;{citation.quote}&rdquo;</p>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[9px] uppercase tracking-[0.09em] text-muted">{label}</h3>
      {children}
    </section>
  );
}

function FilePicker({ label, onPick }: { label: string; onPick(file: File): void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[10px] hover:border-line-strong focus-within:border-line-strong">
      <span aria-hidden="true">＋</span>
      {label}
      <input
        type="file"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
          event.target.value = "";
        }}
      />
    </label>
  );
}

/** Draft-local text that commits on blur. Same contract as `ParamForm`'s fields. */
function DeferredText({
  value,
  onCommit,
  ariaLabel,
  placeholder,
  multiline,
}: {
  value: string;
  onCommit(next: string): void;
  ariaLabel: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  if (multiline === true) {
    return (
      <textarea
        value={draft}
        aria-label={ariaLabel}
        placeholder={placeholder}
        rows={5}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className={`${FIELD} resize-y`}
      />
    );
  }

  return (
    <input
      type="text"
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      className={FIELD}
    />
  );
}
