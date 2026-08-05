import { TOOL_MANIFEST_IDS, type ToolManifest } from "@wf/shared";
import {
  docxToPdf,
  pdfCompress,
  pdfExtractText,
  pdfMerge,
  pdfSplit,
  pdfToDocx,
} from "./pdf-tools.js";
import { checkBinaries, type BinaryStatus } from "./shell.js";
import { templateApply } from "./template-tool.js";
import { UnknownToolError, type ToolDef } from "./types.js";

/**
 * The registry. Adding a tool means writing one file and adding it to this
 * array — the node form UI is generated from `manifest.params`, the planner is
 * constrained by `toolManifests()`, and execution goes through the single
 * generic `runTool` activity that supplies retries, timeouts, and heartbeat
 * cancellation.
 */

// The `unknown` param type is the erased view; each tool narrows its own params
// through `parseParams` before `run` ever sees them.
const TOOLS: readonly ToolDef<never>[] = [
  pdfExtractText,
  pdfSplit,
  pdfMerge,
  pdfCompress,
  pdfToDocx,
  docxToPdf,
  templateApply,
] as unknown as readonly ToolDef<never>[];

const BY_ID = new Map<string, ToolDef<never>>(TOOLS.map((t) => [t.manifest.id, t]));

export function toolIds(): string[] {
  return [...BY_ID.keys()];
}

export function getTool(id: string): ToolDef<never> {
  const t = BY_ID.get(id);
  if (t === undefined) throw new UnknownToolError(id, toolIds());
  return t;
}

export function hasTool(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * The serializable half — safe to ship to the browser and into the planner
 * prompt. Derived from the REGISTERED tools rather than re-exporting
 * `TOOL_MANIFESTS` wholesale, so a manifest that exists in `@wf/shared` with no
 * implementation here is never advertised to the planner as a tool it may use.
 */
export function toolManifests(): ToolManifest[] {
  return TOOLS.map((t) => t.manifest);
}

/**
 * Manifests declared in `@wf/shared` that no registered tool implements.
 *
 * The canvas builds a node's parameter form from the shared manifests, so one
 * without an implementation renders as a fully working tool node that fails the
 * moment it runs. Reported at startup rather than discovered by a user.
 */
export function orphanManifests(): string[] {
  const implemented = new Set(TOOLS.map((t) => t.manifest.id));
  return TOOL_MANIFEST_IDS.filter((id) => !implemented.has(id));
}

export interface RegistryReport {
  binaries: BinaryStatus[];
  /** Tool ids that cannot run right now, with the reason. */
  unavailable: { toolId: string; missing: string[] }[];
}

/**
 * Startup probe. Reports which tools are usable rather than crashing on a
 * machine without Ghostscript — three of the six tools are pure TypeScript and
 * work everywhere.
 */
export async function inspectRegistry(): Promise<RegistryReport> {
  const binaries = await checkBinaries();
  const missing = new Set(binaries.filter((b) => b.path === null).map((b) => b.name));

  const unavailable: { toolId: string; missing: string[] }[] = [];
  for (const tool of TOOLS) {
    const required = tool.requiresBinaries ?? [];
    if (required.length === 0) continue;
    // pdf.compress needs EITHER qpdf or gs; a tool is only unavailable when
    // every binary it could use is missing.
    const absent = required.filter((b) => missing.has(b));
    if (absent.length === required.length) {
      unavailable.push({ toolId: tool.manifest.id, missing: absent });
    }
  }

  return { binaries, unavailable };
}
