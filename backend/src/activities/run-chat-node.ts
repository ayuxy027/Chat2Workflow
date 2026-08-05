import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
  AnalysisResult,
  PAGE_MARKER,
  normalizeForMatch,
  parsePageMarked,
  quoteMatches,
  type BlobRef,
  type Citation,
} from "@wf/shared";
import { get, put } from "@wf/storage";
import {
  ANALYSIS_MAX_OUTPUT_TOKENS,
  ANALYSIS_REASONING_EFFORT,
  callStructured,
  DOC_CHAR_BUDGET,
  StructuredOutputError,
  TokenBudgetExhaustedError,
  type LlmUsage,
} from "../llm.js";
import { extractPages, type PageText } from "../tools/pdf-text.js";
import { startHeartbeat } from "./heartbeater.js";
import { ANALYSIS_PROMPT_VERSION, VERIFIER_VERSION, WORKER_BUILD_ID } from "../version.js";

/**
 * Document-grounded analysis with VERIFIED citations.
 *
 * We are on an OpenAI-compatible endpoint, so Anthropic's native `citations` /
 * `page_location` and the Files API are unavailable. The replacement is better
 * anyway, because it is verifiable rather than asserted:
 *
 *   1. Documents are numbered `[[doc N: filename]]` and text arrives page-tagged
 *      with `[[page N]]` markers.
 *   2. The model returns AnalysisResult — an answer plus {doc, page, quote}
 *      triples, the quote verbatim.
 *   3. THIS activity string-matches every quote against the extracted text of
 *      the claimed document and sets `Citation.verified` accordingly.
 *
 * A model-asserted page number is a claim; a verified one is a fact. We never
 * set `verified: true` without running the match, and we never search for a
 * quote outside the document the model named — legal boilerplate recurs
 * verbatim across agreements, so a cross-document search would eventually
 * attribute a passage to the wrong instrument, and citing the wrong contract is
 * worse than citing nothing.
 */

export interface RunChatNodeInput {
  nodeId: string;
  /** The node's label, used to name the artifact this step writes. */
  label?: string;
  prompt: string;
  /** Upstream artifacts: PDFs, or page-marked text from pdf.extract_text. */
  documents: BlobRef[];
  /**
   * Extracted-text blob -> the document it was extracted FROM.
   *
   * Verification can only match against extracted text, so `Citation.blob` is
   * the `.txt`. Linking the user there hands them a file with no pages instead
   * of the contract the claim came from. Only the workflow can supply this —
   * it is the one that knows the pipeline shape — so it travels in.
   */
  origins?: { blob: string; source: BlobRef }[];
}

export interface RunChatNodeOutput {
  nodeId: string;
  /**
   * The answer as a `text/markdown` artifact, so it can flow DOWNSTREAM.
   *
   * A chat node used to produce `result` text and nothing else, which severed
   * every pipeline at the point it mattered: summarise -> template -> output
   * ended with "No artifacts arrived at this output", because there was no
   * blob for `template.apply` to accept. The analysis is a document like any
   * other; `result` stays for on-node display, and this is the file.
   */
  outputs: BlobRef[];
  answer: string;
  citations: Citation[];
  verifiedCount: number;
  unverifiedCount: number;
  /** True when the document text exceeded the budget and was cut. */
  truncated: boolean;
  /** Exactly which pages of which document reached the model. */
  coverage: DocCoverage[];
  /** One caveat per line, for `GraphNode.log`. Shown to the user, not just logged. */
  log: string[];
  usage: LlmUsage;
  /** Which build and which prompt produced this. See ../version.ts. */
  workerBuildId: string;
  promptVersion: string;
  verifierVersion: string;
}

const SYSTEM = `You analyse legal documents for a law firm. You produce a DRAFT for a lawyer to
review, never a conclusion and never advice.

The documents below are supplied as extracted text. Each document starts with a
[[doc N: filename]] marker, and each page within it starts with a [[page N]] marker.

CITATION RULES — these are the point of the exercise, not decoration:
  1. Every substantive claim in your answer must be supported by a citation.
  2. A citation's "quote" MUST be copied VERBATIM from the page you name — character for
     character, including punctuation and casing. It is machine-checked against that page.
     A paraphrase fails the check and is shown to the user with a warning marker.
  3. Keep quotes between roughly 10 and 300 characters: long enough to be identifiable,
     short enough to be exact.
  4. Set "doc" to the number from the [[doc N: ...]] marker the text appeared under, and
     "page" to the number from the [[page N]] marker. Standard clauses read alike across
     agreements, so a citation that names the wrong document is worse than no citation:
     when more than one document is supplied, "doc" is REQUIRED and a citation without it
     will be rejected as unverified.
  5. If the documents do not answer the question, say so plainly and cite nothing.
     Never fill a gap with recalled general knowledge.
  6. Do not restate your reasoning process. Give the analysis and the citations.`;

const SHAPE_HINT = `{
  "answer": "the analysis, markdown allowed",
  "citations": [ { "doc": 1, "page": 12, "quote": "verbatim excerpt copied from doc 1, page 12" } ]
}`;

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export interface LoadedDoc {
  /** 1-based index; this is the `doc` number the model is told to cite. */
  index: number;
  ref: BlobRef;
  /** The original document this text came from, when it is a derived blob. */
  source?: BlobRef;
  pages: PageText[];
  /**
   * Page -> RAW extracted text. Matching goes through `quoteMatches`, which
   * owns normalization for both sides; pre-normalizing here would have meant a
   * second, subtly different copy of that logic living in the worker.
   */
  byPage: Map<number, string>;
}

const PDF = "application/pdf";

async function load(
  ref: BlobRef,
  index: number,
  source: BlobRef | undefined,
): Promise<LoadedDoc> {
  const bytes = await get(ref.sha256);
  let pages: PageText[];

  if (ref.mime === PDF) {
    pages = (await extractPages(bytes)).pages;
  } else {
    const text = bytes.toString("utf8");
    // `parsePageMarked` comes from @wf/shared — the same reader the web app uses
    // to resolve a citation back to its page, so producer and reader can't drift.
    const marked = parsePageMarked(text);
    // Output of pdf.extract_text keeps its page structure; anything else is one page.
    pages = marked.length > 0 ? marked : [{ page: 1, text }];
  }

  const byPage = new Map<number, string>();
  for (const p of pages) byPage.set(p.page, p.text);
  return { index, ref, pages, byPage, ...(source === undefined ? {} : { source }) };
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/** Shortest quote we will accept. Below this, a match proves nothing. */
const MIN_QUOTE_CHARS = 12;

interface VerifyOutcome {
  citation: Citation;
  note?: string;
}

/**
 * Verify one citation.
 *
 * The source document is decided by the model's `doc` index and is NEVER
 * inferred from the quote's content. Everything follows from that: we look only
 * inside the named document, and when we cannot tell which document was meant,
 * the citation is unverified. Guessing would eventually produce a confident
 * link to the wrong contract, which is the exact failure this whole mechanism
 * exists to prevent.
 *
 * Both sides of every comparison go through `normalizeForMatch` from @wf/shared.
 * PDF extraction guarantees whitespace and quote-glyph noise that no model will
 * reproduce, and a false "unverified" damages trust as much as a false
 * "verified".
 */
export function verifyOne(
  claim: { doc?: number; page: number; quote: string },
  docs: LoadedDoc[],
): VerifyOutcome {
  // The schema requires a 64-hex blob even on an unverified citation, so an
  // unattributable one still has to name something. `verified: false` is what
  // stops the UI presenting it as a source.
  const fallbackBlob = docs[0]?.ref.sha256 ?? "";
  const nq = normalizeForMatch(claim.quote);
  const where = `doc ${claim.doc ?? "?"} page ${claim.page}`;

  const sourceOf = (d: LoadedDoc | undefined): { sourceBlob?: string } =>
    d?.source === undefined || d.source.sha256 === d.ref.sha256
      ? {}
      : { sourceBlob: d.source.sha256 };

  const unverified = (d: LoadedDoc | undefined, blob: string, note: string): VerifyOutcome => ({
    citation: { blob, page: claim.page, quote: claim.quote, verified: false, ...sourceOf(d) },
    note,
  });

  // 1. Resolve the document. A single document makes the index unambiguous.
  let doc: LoadedDoc | undefined;
  if (claim.doc === undefined) {
    if (docs.length !== 1) {
      return unverified(
        undefined,
        fallbackBlob,
        `${where}: no document index given and ${docs.length} documents were supplied — ` +
          `cannot attribute this quote, shown as UNVERIFIED`,
      );
    }
    doc = docs[0];
  } else {
    doc = docs.find((d) => d.index === claim.doc);
    if (doc === undefined) {
      return unverified(
        undefined,
        fallbackBlob,
        `${where}: document ${claim.doc} does not exist (${docs.length} supplied) — UNVERIFIED`,
      );
    }
  }

  if (nq.length < MIN_QUOTE_CHARS) {
    return unverified(
      doc,
      doc.ref.sha256,
      `${where}: quote is only ${nq.length} chars — too short to verify meaningfully`,
    );
  }

  // 2. The claim as made: this quote, on this page, of THIS document.
  //
  // `quoteMatches` from @wf/shared owns the comparison. It tries progressively
  // more lenient normalizations — including folding line-break hyphenation, so
  // extracted "termi-\nnated" matches a model's "terminated" — but every rung
  // is still an exact substring test, so leniency can only recover a TRUE match
  // that formatting obscured. It cannot manufacture a false one.
  const pageText = doc.byPage.get(claim.page);
  if (pageText !== undefined && quoteMatches(pageText, claim.quote)) {
    return {
      citation: {
        blob: doc.ref.sha256,
        page: claim.page,
        quote: claim.quote,
        verified: true,
        ...sourceOf(doc),
      },
    };
  }

  // 3. Right document, wrong page. Searching the rest of THIS document never
  //    risks the wrong instrument, and `verified` still means exactly what it
  //    says: we checked that this text is on this page. The correction is
  //    recorded, because a model that misnumbers pages is worth knowing about.
  for (const [page, text] of doc.byPage) {
    if (page !== claim.page && quoteMatches(text, claim.quote)) {
      return {
        citation: {
          blob: doc.ref.sha256,
          page,
          quote: claim.quote,
          verified: true,
          ...sourceOf(doc),
        },
        note: `${where}: quote is on page ${page} of ${doc.ref.filename}, not ${claim.page}; page corrected`,
      };
    }
  }

  // 4. Not in the named document at all. Paraphrased or invented.
  return unverified(
    doc,
    doc.ref.sha256,
    `${where}: quote does not appear anywhere in ${doc.ref.filename} — shown as UNVERIFIED`,
  );
}

/* ------------------------------------------------------------------ */

/** What actually reached the model, per document. Surfaced in the result log. */
export interface DocCoverage {
  index: number;
  filename: string;
  pagesSent: number;
  pagesTotal: number;
  /** Page numbers that did not fit and were NOT sent. */
  omitted: number[];
}

interface Context {
  text: string;
  truncated: boolean;
  /**
   * Characters of actual PAGE text that reached the model, excluding the
   * `[[doc N: …]]` headers. The headers are always present, so the assembled
   * string is never empty — counting them would make "did any document text
   * survive?" unanswerable, and the refusal below depends on that answer.
   */
  pageChars: number;
  coverage: DocCoverage[];
}

/**
 * Split the character budget across documents, giving each what it needs and
 * sharing out what the small ones do not use.
 *
 * A single running total consumed first-come-first-served, which is the obvious
 * implementation, is silently wrong for the case this tool exists to serve.
 * Feed it two contracts to compare and a long first document eats the whole
 * budget; the second is never mentioned, so the model is not told it exists,
 * cannot cite it, and answers the comparison as though it had read both. That
 * is an unsourced assertion about a document nobody sent it — the exact failure
 * the citation machinery is built to prevent, arriving through the back door.
 *
 * Water-filling, cheapest first: each document is offered an equal share of
 * what is left, takes only what it needs, and releases the remainder to the
 * rest. Two equal documents get half each; a 10-page and a 500-page document
 * do not starve each other. Ordering by cost then index keeps it reproducible.
 */
function allocate(docs: LoadedDoc[], total: number): Map<number, number> {
  const cost = new Map<number, number>();
  for (const d of docs) {
    cost.set(
      d.index,
      d.pages.reduce((n, p) => n + PAGE_MARKER(p.page).length + 1 + p.text.length, 0),
    );
  }

  const out = new Map<number, number>();
  const order = [...docs].sort(
    (a, b) => cost.get(a.index)! - cost.get(b.index)! || a.index - b.index,
  );
  let remaining = total;
  let left = order.length;
  for (const d of order) {
    const share = Math.floor(remaining / left);
    const give = Math.min(cost.get(d.index)!, share);
    out.set(d.index, give);
    remaining -= give;
    left--;
  }
  return out;
}

function buildContext(docs: LoadedDoc[]): Context {
  const budgets = allocate(docs, DOC_CHAR_BUDGET);
  const blocks: string[] = [];
  const coverage: DocCoverage[] = [];
  let pageChars = 0;
  let truncated = false;

  for (const doc of docs) {
    // The `[[doc N: ...]]` marker is the handle the model cites back with, and
    // the verifier resolves `citation.doc` through it. Format and index must
    // match AnalysisResult's contract exactly. EVERY supplied document gets one,
    // even if not a single page of it fits — a document the model is never told
    // about is one it will answer around instead of declining to answer.
    const header = `[[doc ${doc.index}: ${doc.ref.filename}]] (sha256 ${doc.ref.sha256.slice(0, 12)}…)`;
    const parts: string[] = [header];
    const budget = budgets.get(doc.index) ?? 0;
    const omitted: number[] = [];
    let used = 0;

    for (const p of doc.pages) {
      const chunk = `${PAGE_MARKER(p.page)}\n${p.text}`;
      // Once a page has been dropped, drop the rest: pages stay a contiguous
      // run from the front, so "pages 1-40 of 200" is a statement the model and
      // the user can both act on.
      if (omitted.length > 0 || used + chunk.length > budget) {
        omitted.push(p.page);
        continue;
      }
      used += chunk.length;
      pageChars += p.text.trim().length;
      parts.push(chunk);
    }

    if (omitted.length > 0) {
      truncated = true;
      parts.push(
        `[[TRUNCATED]] ${omitted.length} of this document's ${doc.pages.length} page(s) — ` +
          `${pageRanges(omitted)} — exceeded this document's share of the ` +
          `${DOC_CHAR_BUDGET}-character budget and were NOT sent. You have not seen them. ` +
          `Do not cite them, and state plainly in your answer that they were not reviewed.`,
      );
    }

    blocks.push(parts.join("\n\n"));
    coverage.push({
      index: doc.index,
      filename: doc.ref.filename,
      pagesSent: doc.pages.length - omitted.length,
      pagesTotal: doc.pages.length,
      omitted,
    });
  }

  return { text: blocks.join("\n\n"), truncated, pageChars, coverage };
}

/** "1-3, 7, 10-12" — compact enough to put in a message a user will read. */
function pageRanges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** A filename fragment that survives every filesystem we care about. */
function slug(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base === "" ? "analysis" : base;
}

/**
 * The handover document.
 *
 * Citations travel WITH the answer, and unverified ones are marked as such in
 * the file itself. A markdown export that quietly drops provenance is worse
 * than one that never had it: the text reads as authoritative, the reader has
 * no way to tell which sentences were checked against a page and which were
 * asserted, and the file will outlive the canvas that could have told them.
 * The caveat log rides along for the same reason — "40 of 200 pages were read"
 * has to survive the export.
 */
function renderAnswer(
  label: string,
  answer: string,
  citations: Citation[],
  docs: LoadedDoc[],
  logLines: string[],
): string {
  const nameOf = new Map(docs.map((d) => [d.ref.sha256, d.ref.filename]));
  const out: string[] = [`# ${label}`, "", answer.trim(), ""];

  out.push("## Citations", "");
  if (citations.length === 0) {
    out.push(
      "**None. This answer is unsourced and must be treated as such.**",
      "",
    );
  } else {
    citations.forEach((c, i) => {
      const where = `${nameOf.get(c.blob) ?? "document"} p.${c.page}`;
      const mark = c.verified
        ? "VERIFIED"
        : "UNVERIFIED — this quote was NOT found on that page; do not rely on it";
      out.push(`${i + 1}. **[${mark}]** ${where}`, "", `   > ${c.quote.replace(/\n/g, " ")}`, "");
    });
  }

  if (logLines.length > 0) {
    out.push("## Processing notes", "");
    for (const line of logLines) out.push(`- ${line}`);
    out.push("");
  }

  out.push(
    "---",
    "",
    "_Draft produced by an automated pipeline for review by a qualified lawyer. Not advice._",
  );
  return `${out.join("\n").trimEnd()}\n`;
}

export async function runChatNode(input: RunChatNodeInput): Promise<RunChatNodeOutput> {
  if (input.prompt.trim() === "") {
    throw ApplicationFailure.nonRetryable(
      "This chat node has no prompt. Type what it should ask about the document.",
      "ChatValidationError",
    );
  }
  if (input.documents.length === 0) {
    throw ApplicationFailure.nonRetryable(
      "This chat node has no document input. Connect a document node, or a pdf.extract_text " +
        "node, upstream of it — an uncited answer is not shippable in a legal context.",
      "ChatValidationError",
    );
  }

  const logLines: string[] = [];
  const docs: LoadedDoc[] = [];
  const originOf = new Map((input.origins ?? []).map((o) => [o.blob, o.source]));
  for (const ref of input.documents) {
    // 1-based index, in edge order — this is the `doc` number the model cites.
    docs.push(await load(ref, docs.length + 1, originOf.get(ref.sha256)));
    heartbeat({ nodeId: input.nodeId, stage: "extracting", loaded: docs.length });
  }

  const empty = docs.filter((d) => d.pages.every((p) => p.text.trim() === ""));
  for (const d of empty) {
    logLines.push(
      `WARNING: no text could be extracted from ${d.ref.filename}. It is most likely a scan ` +
        `with no text layer; OCR is not available in v1, so nothing can be cited from it.`,
    );
  }

  const { text, truncated, pageChars, coverage } = buildContext(docs);
  // Gate on PAGE text, not on the assembled string. Every document contributes
  // a `[[doc N: …]]` header, so `text` is non-empty even when all we have is a
  // stack of scans with no text layer — testing it left this refusal
  // unreachable, and a scanned PDF sailed through to the model, which then
  // answered the question from general knowledge with no citable source. That
  // is the exact outcome CLAUDE.md §Legal-domain rules forbids.
  if (pageChars === 0) {
    throw ApplicationFailure.nonRetryable(
      `None of the ${docs.length} supplied document(s) yielded any extractable text, so no ` +
        `claim could be sourced. This is refused rather than answered from general knowledge. ` +
        `The most likely cause is a scan with no text layer; OCR is not available in v1.`,
      "ChatValidationError",
    );
  }
  if (truncated) {
    logLines.push(
      `TRUNCATED: the documents exceeded the ${DOC_CHAR_BUDGET}-character budget. The answer ` +
        `covers ONLY the pages listed as sent below; anything on an omitted page was not read.`,
    );
    for (const c of coverage) {
      if (c.omitted.length === 0) continue;
      logLines.push(
        `  doc ${c.index} (${c.filename}): sent ${c.pagesSent}/${c.pagesTotal} page(s); ` +
          `NOT sent: ${pageRanges(c.omitted)}`,
      );
    }
  }

  heartbeat({ nodeId: input.nodeId, stage: "analysing" });

  let partials = 0;
  let result;
  // Beat on a timer for the whole model call, not only when partials arrive.
  // A hung endpoint produces no partials, and without a heartbeat the
  // cancellation request Temporal is holding is never delivered.
  const ticker = startHeartbeat(() => ({ nodeId: input.nodeId, stage: "analysing", partials }));
  try {
    result = await callStructured({
      schema: AnalysisResult,
      name: "analysis_result",
      description: "document analysis with page citations",
      shapeHint: SHAPE_HINT,
      system: SYSTEM,
      prompt: `${text}\n\n=== TASK ===\n${input.prompt}`,
      maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      reasoningEffort: ANALYSIS_REASONING_EFFORT,
      // Cancel the HTTP call when Temporal cancels the activity. Without it a
      // cancelled run kept generating for the rest of the 30-minute
      // start-to-close timeout, against a document the user had already
      // withdrawn.
      abortSignal: cancellationSignal(),
      // Stream, and heartbeat off the partials.
      //
      // This is the same protection planGraph already had, and this activity
      // needed it more: its heartbeat timeout is 3 minutes and the only
      // heartbeat was emitted BEFORE the call, so a reasoning pass over a long
      // contract that took longer than three minutes was killed by Temporal as
      // unresponsive — mid-answer, on the largest documents, which is exactly
      // where it is least acceptable. Partials never leave this activity; the
      // object is still parsed and verified in full below.
      onPartial: () => {
        partials++;
        if (partials % 8 === 0) heartbeat({ nodeId: input.nodeId, stage: "analysing", partials });
      },
    });
  } catch (err) {
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

  const answer = result.object.answer.trim();
  if (answer === "") {
    throw ApplicationFailure.nonRetryable(
      "The model returned an empty answer. Treated as a failure, not as a blank result.",
      "EmptyAnalysisError",
    );
  }

  // Verify. Deduped by (blob, page, quote) so a repeated citation is one link.
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let verifiedCount = 0;

  for (const claim of result.object.citations) {
    const { citation, note } = verifyOne(claim, docs);
    if (note !== undefined) logLines.push(note);
    const key = `${citation.blob}|${citation.page}|${normalizeForMatch(citation.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (citation.verified) verifiedCount++;
    citations.push(citation);
  }

  const unverifiedCount = citations.length - verifiedCount;
  logLines.push(
    `read ${coverage.map((c) => `doc ${c.index} ${c.pagesSent}/${c.pagesTotal}p`).join(", ")} · ` +
      `${ANALYSIS_PROMPT_VERSION} · ${VERIFIER_VERSION} · worker ${WORKER_BUILD_ID}`,
  );
  logLines.push(
    citations.length === 0
      ? `NO CITATIONS: this answer is unsourced and must be treated as such.`
      : `citations: ${verifiedCount} verified, ${unverifiedCount} unverified (of ${citations.length}).`,
  );

  const artifact = await put(
    new TextEncoder().encode(renderAnswer(input.label ?? "Analysis", answer, citations, docs, logLines)),
    { filename: `${slug(input.label ?? "analysis")}.md`, mime: "text/markdown" },
  );

  return {
    nodeId: input.nodeId,
    outputs: [artifact],
    answer,
    citations,
    verifiedCount,
    unverifiedCount,
    truncated,
    coverage,
    log: logLines,
    // Reasoning TEXT is deliberately absent: it is not a citation-backed claim
    // and has no place in a legal audit trail. Token counts are recorded.
    usage: result.usage,
    workerBuildId: WORKER_BUILD_ID,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    verifierVersion: VERIFIER_VERSION,
  };
}
