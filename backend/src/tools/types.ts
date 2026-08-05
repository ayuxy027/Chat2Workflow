import type { BlobRef, ToolManifest } from "@wf/shared";

/**
 * The RUNTIME half of the tool contract.
 *
 * `@wf/shared` owns `ToolManifest` — the serializable half that ships to the
 * browser (to generate the node form) and to the planner (so it can only
 * reference tools that exist). It deliberately carries no `run`, because a
 * function cannot cross a zod schema or a network boundary.
 *
 * `ToolDef` is that manifest plus the executable half, and it lives in the
 * worker because the worker is the only process that executes anything.
 * Adding a tool is still one file: define a manifest, implement `run`, register.
 */

export interface ToolContext<P> {
  /** Upstream artifacts, in graph order. */
  inputs: BlobRef[];
  params: P;
  read(ref: BlobRef): Promise<Buffer>;
  write(bytes: Uint8Array, meta: { filename: string; mime: string; pages?: number }): Promise<BlobRef>;
  /** 0..1. Drives Temporal heartbeats, which is what makes cancellation work. */
  heartbeat(progress: number): void;
  /** Per-invocation scratch directory; removed when the activity returns. */
  scratchDir: string;
  /** Appended to the tool's log, which lands in the node result and the history. */
  log(line: string): void;
  /** Aborted when Temporal cancels the activity. Pass to child processes. */
  signal: AbortSignal;
}

export interface ToolRunResult {
  outputs: BlobRef[];
  log: string;
}

export interface ToolDef<P = Record<string, unknown>> {
  manifest: ToolManifest;
  /**
   * External binaries this tool shells out to, by logical name. Used by the
   * startup probe to report what is unavailable instead of discovering it
   * mid-run.
   */
  requiresBinaries?: readonly BinaryName[];
  /** Narrows the untyped params from the node form. Throws ToolParamError on bad input. */
  parseParams(raw: Record<string, unknown>): P;
  run(ctx: ToolContext<P>): Promise<ToolRunResult>;
}

export type BinaryName = "qpdf" | "gs" | "soffice";

/** Bad params or bad inputs — the user's problem, so never retried. */
export class ToolParamError extends Error {
  readonly name = "ToolParamError";
}

/** The tool id is not in the registry (typically a hallucinated toolId). */
export class UnknownToolError extends Error {
  readonly name = "UnknownToolError";
  constructor(toolId: string, known: string[]) {
    super(
      `Unknown tool "${toolId}". Registered tools: ${known.join(", ")}. ` +
        `A tool id that is not in the registry is a planning error, not a runtime one.`,
    );
  }
}
