/**
 * A real multi-page PDF, generated here, with GROUND TRUTH attached.
 *
 * Generated rather than committed as a fixture for one reason: the most
 * important assertion in this suite is that a citation flagged `verified: true`
 * genuinely has its quote on the page it claims. To check that INDEPENDENTLY —
 * without trusting the app's flag, and without trusting the app's own text
 * extractor either — the harness has to know, byte for byte, what is on each
 * page. A fixture PDF only tells you what somebody once believed was on it.
 *
 * Every page carries a unique sentinel token, so a quote attributed to the
 * wrong page is caught rather than being accidentally satisfied by boilerplate
 * that recurs across pages (which, in real legal documents, it constantly does).
 *
 * The writer is hand-rolled and dependency-free: uncompressed content streams,
 * a standard-14 Helvetica with /WinAnsiEncoding, one `Td` per line. That is
 * squarely inside what a PDF text extractor must handle, and it keeps the
 * harness free of any package the app under test also depends on.
 */

export interface GroundTruthPage {
  page: number;
  lines: string[];
  /** The page's text as written, newline-joined. */
  text: string;
  /** Unique to this page. A quote containing it can only be from this page. */
  sentinel: string;
}

export interface GeneratedPdf {
  bytes: Uint8Array;
  filename: string;
  pages: GroundTruthPage[];
  /** The clause the harness asks the model about. */
  indemnityPage: number;
}

const FONT_SIZE = 11;
const LEADING = 15;
const LEFT = 64;
const TOP = 760;

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Content for the test document.
 *
 * Deliberately plain ASCII — no smart quotes, no ligature-prone words, no
 * hyphenation across lines. Those are all real extraction hazards, and the app
 * has explicit normalisation for them; a harness that trips over them would be
 * measuring its own PDF writer rather than the pipeline.
 */
function pageContent(): { lines: string[]; sentinel: string }[] {
  return [
    {
      sentinel: "SENTINEL-ORION-1",
      lines: [
        "MASTER SERVICES AGREEMENT",
        "",
        "This Master Services Agreement is made and entered into as of the",
        "third day of March, between Northwind Holdings Limited, a company",
        "incorporated in England and Wales, and Calder Analytics Incorporated,",
        "a Delaware corporation.",
        "",
        "The parties agree that this Agreement governs all statements of work",
        "executed under it, and that no purchase order term shall vary it.",
        "",
        "Page control token: SENTINEL-ORION-1.",
      ],
    },
    {
      sentinel: "SENTINEL-VESPER-2",
      lines: [
        "1. DEFINITIONS",
        "",
        "Confidential Information means any information disclosed by one party",
        "to the other that is designated as confidential or that a reasonable",
        "person would understand to be confidential in the circumstances.",
        "",
        "Deliverable means any report, dataset or software item identified as a",
        "deliverable in a statement of work executed under this Agreement.",
        "",
        "Page control token: SENTINEL-VESPER-2.",
      ],
    },
    {
      sentinel: "SENTINEL-HALCYON-3",
      lines: [
        "7. INDEMNIFICATION",
        "",
        "The Supplier shall indemnify, defend and hold harmless the Client and",
        "its officers from and against any and all claims, losses, liabilities",
        "and reasonable legal fees arising out of the Supplier's gross",
        "negligence or wilful misconduct in the performance of the Services.",
        "",
        "The Client shall promptly notify the Supplier in writing of any claim",
        "for which indemnity is sought, and shall not settle any such claim",
        "without the prior written consent of the Supplier.",
        "",
        "Page control token: SENTINEL-HALCYON-3.",
      ],
    },
    {
      sentinel: "SENTINEL-PEREGRINE-4",
      lines: [
        "8. LIMITATION OF LIABILITY",
        "",
        "Except for the indemnity obligations set out in clause 7, neither",
        "party shall be liable for any indirect, incidental or consequential",
        "loss, and each party's aggregate liability shall not exceed the fees",
        "paid under the relevant statement of work in the preceding twelve",
        "months.",
        "",
        "Nothing in this clause limits liability for death or personal injury",
        "caused by negligence, or for fraud.",
        "",
        "Page control token: SENTINEL-PEREGRINE-4.",
      ],
    },
    {
      sentinel: "SENTINEL-MERIDIAN-5",
      lines: [
        "12. TERM AND TERMINATION",
        "",
        "This Agreement commences on the Effective Date and continues for an",
        "initial term of three years, renewing automatically for successive",
        "periods of one year unless either party gives ninety days written",
        "notice of non renewal.",
        "",
        "Either party may terminate immediately on written notice if the other",
        "commits a material breach that is not remedied within thirty days.",
        "",
        "Page control token: SENTINEL-MERIDIAN-5.",
      ],
    },
    {
      sentinel: "SENTINEL-ZEPHYR-6",
      lines: [
        "18. GOVERNING LAW AND SIGNATURES",
        "",
        "This Agreement is governed by the laws of England and Wales, and the",
        "parties submit to the exclusive jurisdiction of the courts of England.",
        "",
        "Signed for and on behalf of Northwind Holdings Limited.",
        "Signed for and on behalf of Calder Analytics Incorporated.",
        "",
        "Page control token: SENTINEL-ZEPHYR-6.",
      ],
    },
  ];
}

export function generatePdf(filename = "northwind-msa.pdf"): GeneratedPdf {
  const content = pageContent();
  const pages: GroundTruthPage[] = content.map((p, i) => ({
    page: i + 1,
    lines: p.lines,
    text: p.lines.join("\n"),
    sentinel: p.sentinel,
  }));

  /*
   * Object layout:
   *   1  Catalog
   *   2  Pages
   *   3  Font
   *   4 .. 4+2n-1   alternating Page / Contents
   */
  const n = pages.length;
  const pageObjNum = (i: number): number => 4 + i * 2;
  const contentObjNum = (i: number): number => 5 + i * 2;

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${n} /Kids [` +
    pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ") +
    "] >>";
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  for (let i = 0; i < n; i++) {
    const page = pages[i];
    if (page === undefined) continue;
    objects[pageObjNum(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum(i)} 0 R >>`;

    // One Td per line: the extractor breaks a line when the text-line origin
    // moves, which is exactly what this produces.
    const ops: string[] = ["BT", `/F1 ${FONT_SIZE} Tf`, `${LEFT} ${TOP} Td`];
    page.lines.forEach((line, idx) => {
      if (idx > 0) ops.push(`0 -${LEADING} Td`);
      if (line !== "") ops.push(`(${esc(line)}) Tj`);
    });
    ops.push("ET");
    const streamBody = ops.join("\n");
    objects[contentObjNum(i)] =
      `<< /Length ${Buffer.byteLength(streamBody, "latin1")} >>\nstream\n${streamBody}\nendstream`;
  }

  const chunks: Buffer[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (s: string): void => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    offset += b.length;
  };

  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const maxObj = 3 + n * 2;
  for (let num = 1; num <= maxObj; num++) {
    offsets[num] = offset;
    push(`${num} 0 obj\n${objects[num] ?? "<< >>"}\nendobj\n`);
  }

  const xrefAt = offset;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxObj; num++) {
    xref += `${String(offsets[num] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  return {
    bytes: new Uint8Array(Buffer.concat(chunks)),
    filename,
    pages,
    indemnityPage: 3,
  };
}

/* ------------------------------------------------------------------ */
/* Independent verification primitives                                 */
/* ------------------------------------------------------------------ */

/**
 * The harness's OWN normaliser, deliberately not imported from `@wf/shared`.
 *
 * Re-verifying a citation with the same function the app used to set the flag
 * proves only that the function is deterministic. This one is written from the
 * requirement — "the quote occurs on that page" — and nothing else. It is
 * intentionally strict: whitespace and case only. The generated document has no
 * smart quotes, no ligatures and no line-break hyphenation, so no leniency
 * beyond that is needed, and every rung of leniency is a chance to manufacture
 * a match that is not really there.
 */
export function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Whitespace-insensitive fallback: catches extractors that drop word gaps. */
export function squash(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

export function quoteOccursIn(haystack: string, quote: string): boolean {
  const q = norm(quote);
  if (q === "") return false;
  if (norm(haystack).includes(q)) return true;
  return squash(haystack).includes(squash(quote));
}

/**
 * Parses the `[[page N]]` wire format that `pdf.extract_text` writes into a
 * blob. Reimplemented here (it is ~10 lines) rather than imported, for the same
 * independence reason as `norm` above.
 */
export function parsePageMarked(text: string): { page: number; text: string }[] {
  const re = /^\[\[page (\d+)\]\]$/gm;
  const marks: { page: number; start: number; end: number }[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    marks.push({ page: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  return marks.map((cur, i) => {
    const next = marks[i + 1];
    return {
      page: cur.page,
      text: text.slice(cur.end, next === undefined ? text.length : next.start).trim(),
    };
  });
}
