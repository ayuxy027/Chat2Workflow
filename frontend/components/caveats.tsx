"use client";

/**
 * The things that qualify an answer — PRD §3.6.
 *
 * An analysis that covered 40 of 200 pages renders identically to one that
 * covered all 200 unless somebody says so. Same for a page number the verifier
 * had to correct, and for a scanned exhibit with no text layer that contributed
 * nothing at all. The workflow already records every one of these; they were
 * reaching Temporal history and stopping there, which makes them available to
 * an auditor six months later and invisible to the person relying on the answer
 * right now. That is backwards.
 *
 * Monochrome throughout, so a caveat reads on a printout: a `!` glyph, a
 * double-stroked chip for the ones that change what the answer means, and plain
 * words for the rest.
 */

import type { GraphNode } from "@wf/shared";

type NodeLike = Pick<
  GraphNode,
  "log" | "truncated" | "verifiedCount" | "unverifiedCount" | "citations" | "provenance"
>;

/** Double stroke — the same "something is wrong here" encoding as an error node. */
const ALERT_CHIP =
  "inline-flex items-center gap-1 rounded-full border border-fg bg-surface px-1.5 py-px text-[9px] text-fg shadow-[0_0_0_2px_#FFFFFF,0_0_0_3px_rgba(0,0,0,0.55)]";

const QUIET_CHIP =
  "inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-px text-[9px] text-muted";

/**
 * The one-line form, for the node body. Terse by necessity — a node is 248px
 * wide — but never silent about truncation, which is the caveat that changes
 * what the answer is actually a statement about.
 */
export function CaveatChips({ node }: { node: NodeLike }) {
  const verified = node.verifiedCount;
  const unverified = node.unverifiedCount;
  const counted = verified !== undefined || unverified !== undefined;
  const total = (verified ?? 0) + (unverified ?? 0);

  // Notes that are not just the tally restated. The activity logs a summary
  // line of its own; showing it next to the chip that already says the same
  // thing is noise.
  const notes = (node.log ?? []).filter((line) => !/^citations:/i.test(line));

  if (node.truncated !== true && !counted && notes.length === 0) return null;

  return (
    <ul className="mt-1.5 flex flex-wrap items-center gap-1">
      {node.truncated === true && (
        <li>
          <span
            className={ALERT_CHIP}
            title="The document exceeded the model's input budget and was cut. This answer covers only the pages that were sent."
          >
            <span aria-hidden="true" className="font-semibold">
              !
            </span>
            partial input
          </span>
        </li>
      )}

      {counted && total > 0 && (
        <li>
          <span
            className={unverified !== undefined && unverified > 0 ? ALERT_CHIP : QUIET_CHIP}
            title={
              unverified !== undefined && unverified > 0
                ? `${unverified} of ${total} citations could not be matched against the source and are shown unverified.`
                : "Every citation was matched against the source text."
            }
          >
            {unverified !== undefined && unverified > 0 && (
              <span aria-hidden="true" className="font-semibold">
                !
              </span>
            )}
            {verified ?? 0}/{total} verified
          </span>
        </li>
      )}

      {notes.length > 0 && (
        <li>
          <span className={QUIET_CHIP} title={notes.join("\n")}>
            {notes.length} note{notes.length === 1 ? "" : "s"}
          </span>
        </li>
      )}
    </ul>
  );
}

/**
 * The full form, for the inspector, where there is room to read.
 *
 * The notes are shown in full rather than behind a tooltip: "quote is on page
 * 118, not 121; page corrected" and "no text could be extracted from
 * exhibit_c.pdf" are both sentences a lawyer needs to actually read before
 * relying on the paragraph above them.
 */
export function CaveatDetail({ node }: { node: NodeLike }) {
  const verified = node.verifiedCount ?? 0;
  const unverified = node.unverifiedCount ?? 0;
  const total = verified + unverified;
  const log = node.log ?? [];
  const provenance = node.provenance;

  if (node.truncated !== true && total === 0 && log.length === 0 && !provenance) {
    return null;
  }

  return (
    <div className="space-y-2">
      {node.truncated === true && (
        <p className="rounded-[4px] border border-fg px-2 py-1.5 text-[11px] leading-[1.5] shadow-[0_0_0_2px_#FFFFFF,0_0_0_3px_rgba(0,0,0,0.55)]">
          <span aria-hidden="true" className="mr-1 font-semibold">
            !
          </span>
          The document exceeded the model&apos;s input budget and was truncated. This
          answer is a statement about the pages that were sent, not about the whole
          document.
        </p>
      )}

      {total > 0 && (
        <p className="text-[11px] text-fg">
          <span className="text-muted">Citations </span>
          {verified} verified
          {unverified > 0 && (
            <>
              <span className="text-muted"> · </span>
              <span aria-hidden="true" className="font-semibold">
                !
              </span>{" "}
              {unverified} unverified
            </>
          )}
        </p>
      )}

      {log.length > 0 && (
        <div>
          <h4 className="mb-1 text-[9px] uppercase tracking-[0.09em] text-muted">
            Notes from this step
          </h4>
          <ul className="space-y-1">
            {log.map((line, index) => (
              <li
                key={index}
                className="border-l border-line pl-2 text-[10.5px] leading-[1.5] text-fg"
              >
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {provenance && <Provenance provenance={provenance} />}
    </div>
  );
}

/**
 * "Which model, which prompt, which binary" — the questions Temporal history
 * has to answer six months from now, shown here so the person reading the
 * output can answer them today.
 */
function Provenance({ provenance }: { provenance: NonNullable<GraphNode["provenance"]> }) {
  const rows: [string, string][] = [];
  if (provenance.model) rows.push(["model", provenance.model]);
  if (provenance.promptVersion) rows.push(["prompt", provenance.promptVersion]);
  if (provenance.toolVersion) rows.push(["tool", provenance.toolVersion]);
  for (const binary of provenance.binaries ?? []) {
    rows.push([binary.name, binary.version]);
  }
  if (rows.length === 0) return null;

  return (
    <div>
      <h4 className="mb-1 text-[9px] uppercase tracking-[0.09em] text-muted">
        Produced by
      </h4>
      <dl className="space-y-px">
        {rows.map(([key, value]) => (
          <div key={key} className="flex gap-2 text-[10px]">
            <dt className="shrink-0 text-muted">{key}</dt>
            <dd className="min-w-0 flex-1 truncate text-right font-mono text-fg">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
