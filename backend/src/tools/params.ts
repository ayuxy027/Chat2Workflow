import { ToolParamError } from "./types.js";

/** Narrowing helpers for the untyped params that come off the node form. */

export function str(
  raw: Record<string, unknown>,
  name: string,
  fallback?: string,
): string {
  const v = raw[name];
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new ToolParamError(`Missing required parameter "${name}".`);
  }
  if (typeof v !== "string") throw new ToolParamError(`Parameter "${name}" must be a string.`);
  return v;
}

export function enumOf<T extends string>(
  raw: Record<string, unknown>,
  name: string,
  options: readonly T[],
  fallback: T,
): T {
  const v = raw[name];
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || !options.includes(v as T)) {
    throw new ToolParamError(
      `Parameter "${name}" must be one of: ${options.join(", ")} (received ${JSON.stringify(v)}).`,
    );
  }
  return v as T;
}

export function bool(raw: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = raw[name];
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ToolParamError(`Parameter "${name}" must be a boolean.`);
}

/**
 * Parses a 1-indexed, inclusive page-range spec: "1-3, 5, 9-" against a known
 * page count. Returns one group per comma-separated term, which is what
 * `pdf.split` turns into one output document each.
 */
export function parsePageRanges(spec: string, pageCount: number): number[][] {
  const groups: number[][] = [];
  for (const rawTerm of spec.split(",")) {
    const term = rawTerm.trim();
    if (term === "") continue;

    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(term);
    if (m === null) {
      throw new ToolParamError(
        `Cannot parse page range "${term}". Use forms like "1-3", "5", "9-", separated by commas.`,
      );
    }

    const [, aRaw, dash, bRaw] = m;
    let from: number;
    let to: number;

    if (dash === undefined) {
      if (aRaw === undefined) continue;
      from = Number.parseInt(aRaw, 10);
      to = from;
    } else {
      from = aRaw === undefined ? 1 : Number.parseInt(aRaw, 10);
      to = bRaw === undefined ? pageCount : Number.parseInt(bRaw, 10);
    }

    if (from < 1 || to < 1) throw new ToolParamError(`Page numbers are 1-indexed; got "${term}".`);
    if (from > pageCount || to > pageCount) {
      throw new ToolParamError(
        `Range "${term}" is outside the document, which has ${pageCount} page(s).`,
      );
    }
    if (from > to) throw new ToolParamError(`Range "${term}" runs backwards.`);

    const pages: number[] = [];
    for (let p = from; p <= to; p++) pages.push(p);
    groups.push(pages);
  }

  if (groups.length === 0) {
    throw new ToolParamError(`No page ranges given. Example: "1-3, 5, 9-".`);
  }
  return groups;
}

/** Replaces a filename's extension, keeping the stem. */
export function withExt(filename: string, ext: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem}${ext}`;
}

/** Strips path separators so an upstream filename can never steer a write. */
export function safeName(filename: string): string {
  const base = filename.replace(/[/\\]/g, "_").trim();
  return base === "" ? "document" : base;
}
