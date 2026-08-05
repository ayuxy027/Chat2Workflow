import type { ToolManifest } from "./tools";

/**
 * The tool registry's SERIALIZABLE half, owned in one place.
 *
 * These lived inside the worker next to each tool's `run`. That put the only
 * copy behind a package the browser cannot import — and the canvas renders a
 * tool node's parameter form from `ParamSpec` (PRD §5.3). The choice was to
 * copy them into the web app or to move them here, and copying is how you get a
 * form whose `quality` enum has four options while the tool that validates it
 * has three: the param looks set and silently isn't. This session has already
 * produced four bugs of exactly that shape.
 *
 * Pure data. No `fs`, no child processes, no AI SDK — so this is safe in the
 * browser bundle and safe inside the deterministic workflow bundle.
 *
 * The EXECUTABLE half (`run`, `parseParams`, `requiresBinaries`, binary
 * probing) stays in the worker, which is the only process that executes
 * anything. A tool is still one file plus one entry here.
 */

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TXT = "text/plain";
const MD = "text/markdown";

export const TOOL_MANIFESTS: readonly ToolManifest[] = [
  {
    id: "pdf.extract_text",
    label: "Extract Text",
    glyph: "⚙",
    description:
      "Extracts a PDF's text with [[page N]] markers. This is the provenance backbone: " +
      "everything a chat node claims about the document is verified back against these pages.",
    accepts: [PDF],
    produces: [TXT],
    minInputs: 1,
    maxInputs: 1,
    params: [],
  },
  {
    id: "pdf.split",
    label: "Split PDF",
    glyph: "⚙",
    description:
      "Splits a PDF into one document per page range. Ranges are 1-indexed and inclusive, " +
      'comma separated, e.g. "1-3, 5, 9-".',
    accepts: [PDF],
    produces: [PDF],
    minInputs: 1,
    maxInputs: 1,
    params: [
      {
        type: "text",
        name: "ranges",
        label: "Page ranges",
        default: "1-",
        placeholder: "1-3, 5, 9-",
      },
    ],
  },
  {
    id: "pdf.merge",
    label: "Merge PDFs",
    glyph: "⚙",
    description: "Concatenates several PDFs into one, in the order their edges were connected.",
    accepts: [PDF],
    produces: [PDF],
    minInputs: 2,
    maxInputs: null,
    params: [{ type: "text", name: "filename", label: "Output filename", default: "merged.pdf" }],
  },
  {
    id: "pdf.compress",
    label: "Compress PDF",
    glyph: "⚙",
    description:
      "Reduces PDF size. qpdf is lossless and preserves the text layer exactly. Ghostscript " +
      "downsamples images and is smaller but lossy — it can degrade a scan past readability.",
    accepts: [PDF],
    produces: [PDF],
    minInputs: 1,
    maxInputs: 1,
    params: [
      {
        type: "enum",
        name: "engine",
        label: "Engine",
        default: "qpdf",
        options: [
          { value: "qpdf", label: "qpdf (lossless)" },
          { value: "ghostscript", label: "Ghostscript (lossy)" },
        ],
      },
      {
        type: "enum",
        name: "quality",
        label: "Ghostscript preset",
        default: "ebook",
        options: [
          { value: "screen", label: "screen (72 dpi)" },
          { value: "ebook", label: "ebook (150 dpi)" },
          { value: "printer", label: "printer (300 dpi)" },
          { value: "prepress", label: "prepress (300 dpi, colour preserving)" },
        ],
      },
    ],
  },
  {
    id: "pdf.to_docx",
    label: "PDF to Word",
    glyph: "⚙",
    description:
      "Converts a PDF to .docx via LibreOffice. Layout fidelity is approximate — this is for " +
      "editing, not for producing an execution copy.",
    accepts: [PDF],
    produces: [DOCX],
    minInputs: 1,
    maxInputs: 1,
    params: [],
  },
  {
    id: "docx.to_pdf",
    label: "Word to PDF",
    glyph: "⚙",
    description: "Converts a .docx to PDF via LibreOffice.",
    accepts: [DOCX, "application/msword"],
    produces: [PDF],
    minInputs: 1,
    maxInputs: 1,
    params: [],
  },
  {
    id: "template.apply",
    label: "Apply Template",
    glyph: "▦",
    description:
      "Lays analysis text out in a firm-standard markdown skeleton — client memo, contract " +
      "review, or deal summary. It only arranges what it is given under headings; it writes " +
      "no content of its own and adds no conclusion the upstream analysis did not state.",
    accepts: [TXT, MD],
    produces: [MD],
    minInputs: 1,
    maxInputs: null,
    params: [
      {
        type: "enum",
        name: "template",
        label: "Template",
        default: "memo",
        options: [
          { value: "memo", label: "Client Memo" },
          { value: "review", label: "Contract Review" },
          { value: "summary", label: "Deal Summary" },
        ],
      },
    ],
  },
];

const BY_ID = new Map(TOOL_MANIFESTS.map((m) => [m.id, m]));

export class UnknownManifestError extends Error {
  readonly name = "UnknownManifestError";
  constructor(id: string) {
    super(
      `No tool manifest with id "${id}". Known ids: ${[...BY_ID.keys()].join(", ")}. ` +
        `A manifest and its implementation are registered together — adding one without the ` +
        `other is the drift this module exists to prevent.`,
    );
  }
}

/**
 * Throws rather than returning undefined: a `ToolDef` composed from a missing
 * manifest is a programming error that should fail at worker startup, not
 * produce a tool node with no label the first time somebody opens the canvas.
 */
export function manifestById(id: string): ToolManifest {
  const m = BY_ID.get(id);
  if (m === undefined) throw new UnknownManifestError(id);
  return m;
}

export function hasManifest(id: string): boolean {
  return BY_ID.has(id);
}

export const TOOL_MANIFEST_IDS: readonly string[] = TOOL_MANIFESTS.map((m) => m.id);
