"use client";

/**
 * Provenance UI. CLAUDE.md §Provenance, PRD §3.6.
 *
 * A model-asserted page number is a claim; a verified one is a fact, and the
 * interface has to keep them visually distinct:
 *
 *   verified   → a link to the page in the source document
 *   unverified → a double-stroked chip carrying a `!`, not a link
 *   none       → an explicit "unsourced" marker, never silence
 *
 * The distinction is carried by stroke count and glyph, not colour, so it
 * survives the monochrome constraint and a black-and-white printout alike.
 */

import { citationTarget, type Citation } from "@wf/shared";

/** PRD §3.6 — persistent and unobtrusive, on every surface showing model output. */
export function DraftNotice() {
  return (
    <p className="mt-1.5 text-[9px] leading-[1.4] text-muted">
      AI-generated draft — verify against source before relying on it.
    </p>
  );
}

export function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return <UnsourcedMarker />;

  return (
    <ul className="mt-1.5 flex flex-wrap gap-1">
      {citations.map((citation, index) => (
        <li key={`${citation.blob}-${citation.page}-${index}`}>
          <CitationChip citation={citation} />
        </li>
      ))}
    </ul>
  );
}

function CitationChip({ citation }: { citation: Citation }) {
  const label = `p. ${citation.page}`;

  if (citation.verified) {
    return (
      <a
        /*
         * `citationTarget`, never `citation.blob`.
         *
         * The quote is verified against the EXTRACTED TEXT blob, because that is
         * what a string match can run on — so `blob` names a derived `.txt` with
         * no pages, and linking it hands the user a text download instead of the
         * contract. `sourceBlob` carries the original, and PRD §3.6's "the source
         * document is always one click from any claim" is only true if the link
         * points there. The helper falls back to `blob` when there is no derived
         * chain, so a directly-analysed PDF still works.
         */
        href={`/api/blobs/${citationTarget(citation)}#page=${citation.page}`}
        target="_blank"
        rel="noreferrer"
        title={citation.quote}
        className="nodrag inline-flex items-center rounded-full border border-line px-1.5 py-px font-mono text-[9px] text-fg underline decoration-line underline-offset-2 hover:border-line-strong hover:decoration-fg"
      >
        {label}
      </a>
    );
  }

  return (
    <span
      title={`Quote not found on page ${citation.page} of the source — unverified: "${citation.quote}"`}
      // Double stroke: the same "something is wrong" encoding the error node
      // state uses, so it reads without colour.
      className="inline-flex items-center gap-1 rounded-full border border-fg px-1.5 py-px font-mono text-[9px] text-fg shadow-[0_0_0_2px_#FFFFFF,0_0_0_3px_rgba(0,0,0,0.55)]"
    >
      <span aria-hidden="true" className="font-sans font-semibold">
        !
      </span>
      {label}
      <span className="sr-only">unverified citation</span>
    </span>
  );
}

export function UnsourcedMarker() {
  return (
    <p
      title="This result cites no pages. Treat it as unsourced."
      className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-dashed border-fg px-1.5 py-px text-[9px] text-fg"
    >
      <span aria-hidden="true" className="font-semibold">
        !
      </span>
      unsourced
    </p>
  );
}
