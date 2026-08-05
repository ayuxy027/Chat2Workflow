import { z } from "zod";

/**
 * The document-tool contract. Adding a tool = writing one file that satisfies
 * ToolDef and registering it. Nothing else: the node's form UI is generated
 * from `params`, and execution goes through a single generic Temporal activity
 * that supplies retries, timeouts, and heartbeat cancellation.
 *
 * The split that matters: deterministic byte operations are local tools; the
 * model does judgment. Compressing a PDF through a model would be slower,
 * costlier, non-reproducible, and would send the document somewhere it did not
 * need to go.
 */

export const ParamSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    name: z.string(),
    label: z.string(),
    default: z.string().optional(),
    placeholder: z.string().optional(),
  }),
  z.object({
    type: z.literal("number"),
    name: z.string(),
    label: z.string(),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    type: z.literal("enum"),
    name: z.string(),
    label: z.string(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    name: z.string(),
    label: z.string(),
    default: z.boolean().optional(),
  }),
]);
export type ParamSpec = z.infer<typeof ParamSpec>;

/** Serializable half of a tool — safe to ship to the browser and to the planner. */
export const ToolManifest = z.object({
  id: z.string(),
  label: z.string(),
  glyph: z.string(),
  description: z.string(),
  accepts: z.array(z.string()),
  produces: z.array(z.string()),
  minInputs: z.number().int().nonnegative().default(1),
  maxInputs: z.number().int().positive().nullable().default(1),
  params: z.array(ParamSpec).default([]),
});
export type ToolManifest = z.infer<typeof ToolManifest>;

export const PAGE_MARKER = (n: number) => `[[page ${n}]]`;

/**
 * Page-tagged plain text, the output of pdf.extract_text.
 *
 * This is the provenance backbone. Because the model receives text with
 * explicit page markers, it can cite page numbers, and — critically — we can
 * VERIFY those citations by string-matching the quote back against the page.
 * A model-asserted page number is a claim; a verified one is a fact.
 */
export const ExtractedText = z.object({
  blob: z.string().length(64),
  pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })),
});
export type ExtractedText = z.infer<typeof ExtractedText>;

/**
 * Parse the page-marked plain text that `pdf.extract_text` writes into a blob.
 *
 * This lives in shared rather than in the worker because both sides need it and
 * neither can import the other: the worker produces the format, and the web app
 * has to resolve a citation back to its page to render the link. A blob holds
 * bytes, not a structured object, so the marker format IS the wire format —
 * which makes this function the only correct reader of it.
 */
export function parsePageMarked(text: string): { page: number; text: string }[] {
  const re = /^\[\[page (\d+)\]\]$/gm;
  const out: { page: number; text: string }[] = [];
  const marks: { page: number; start: number; end: number }[] = [];

  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    marks.push({ page: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]!;
    const next = marks[i + 1];
    out.push({
      page: cur.page,
      text: text.slice(cur.end, next ? next.start : text.length).trim(),
    });
  }
  return out;
}

/**
 * Normalize before comparing a model-supplied quote against extracted text.
 * PDF extraction introduces line breaks and runs of spaces that no model will
 * reproduce, and smart quotes/dashes differ between the PDF and the model's
 * echo. Without this, verification fails on quotes that are in fact correct —
 * and a false "unverified" is as damaging to trust as a false "verified".
 */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Also join words broken across a line by typesetting hyphenation, so that
 * extracted `"termi-\nnated"` matches a model's `"terminated"`.
 *
 * Applied only as a FALLBACK (see `quoteMatches`), never as the primary
 * normalization, because it is genuinely lossy: legal prose contains real
 * suspended hyphens — "pre- and post-closing", "third- and fourth-tier" —
 * that this would fuse into nonsense. A hyphen followed by whitespace cannot
 * be told apart from a line-break hyphen by inspection alone.
 */
export function dehyphenate(s: string): string {
  return s.replace(/-\s+/g, "");
}

/**
 * Does `quote` actually occur in `haystack`?
 *
 * Tries progressively more lenient normalizations and stops at the first hit.
 * Every rung is still an exact substring test, so leniency can only recover a
 * TRUE match that formatting obscured — it can never manufacture a false one.
 * That asymmetry is the point: a false "unverified" erodes trust in the tool,
 * but a false "verified" is a citation to something that was never said, and
 * only one of those is recoverable.
 *
 * Both sides must be normalized identically, which is why this lives here
 * rather than being reimplemented at each call site.
 */
export function quoteMatches(haystack: string, quote: string): boolean {
  const q = normalizeForMatch(quote);
  if (q === "") return false;

  const h = normalizeForMatch(haystack);
  if (h.includes(q)) return true;

  // Line-break hyphenation: applied to both sides so a quote that itself spans
  // a break still matches.
  return dehyphenate(h).includes(dehyphenate(q));
}
