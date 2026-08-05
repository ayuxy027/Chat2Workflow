import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cancellationSignal, heartbeat, log } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { BlobRef } from "@wf/shared";
import { get, put } from "@wf/storage";
import { getTool, hasTool, toolIds } from "../tools/registry.js";
import { binaryProvenance, MissingBinaryError, type BinaryProvenance } from "../tools/shell.js";
import { ToolParamError, UnknownToolError, type ToolContext } from "../tools/types.js";
import { WORKER_BUILD_ID } from "../version.js";

/**
 * THE generic tool activity. Every tool in the registry runs through this one
 * function, which is what buys them retries, timeouts, heartbeat-based
 * cancellation, and a uniform audit record without each tool implementing any
 * of it.
 *
 * Blobs never ride in the payload — only BlobRefs do. The activity reads and
 * writes the content-addressed store directly.
 */

export interface RunToolInput {
  /** Carried through so the history reads as a graph, not a pile of activities. */
  nodeId: string;
  toolId: string;
  params: Record<string, unknown>;
  inputs: BlobRef[];
}

export interface RunToolOutput {
  nodeId: string;
  toolId: string;
  outputs: BlobRef[];
  log: string;
  durationMs: number;
  /**
   * What produced these bytes. Two runs of pdf.to_docx six months apart give
   * different output if LibreOffice moved underneath them, and the history has
   * to be able to say so — CLAUDE.md §Tools calls an unpinned upgrade a break
   * in the audit trail, not just in the build.
   */
  workerBuildId: string;
  binaries: BinaryProvenance[];
}

/** Failures the user must fix. Retrying them just burns the retry budget. */
const NON_RETRYABLE = "ToolValidationError";
const MISSING_BINARY = "MissingBinaryError";

function nonRetryable(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

function validateInputs(
  toolId: string,
  inputs: BlobRef[],
  min: number,
  max: number | null,
  accepts: string[],
): void {
  if (inputs.length < min) {
    throw nonRetryable(
      `${toolId} needs at least ${min} input(s) but the node has ${inputs.length}. ` +
        `Connect an upstream document or tool node.`,
      NON_RETRYABLE,
    );
  }
  if (max !== null && inputs.length > max) {
    throw nonRetryable(
      `${toolId} accepts at most ${max} input(s) but the node has ${inputs.length}.`,
      NON_RETRYABLE,
    );
  }
  if (accepts.length === 0) return;
  for (const ref of inputs) {
    if (!accepts.includes(ref.mime)) {
      throw nonRetryable(
        `${toolId} does not accept "${ref.filename}" (${ref.mime}). ` +
          `Accepted types: ${accepts.join(", ")}.`,
        NON_RETRYABLE,
      );
    }
  }
}

export async function runTool(input: RunToolInput): Promise<RunToolOutput> {
  const started = Date.now();

  if (!hasTool(input.toolId)) {
    throw nonRetryable(new UnknownToolError(input.toolId, toolIds()).message, NON_RETRYABLE);
  }
  const tool = getTool(input.toolId);
  const m = tool.manifest;

  validateInputs(m.id, input.inputs, m.minInputs, m.maxInputs, m.accepts);

  let params: never;
  try {
    params = tool.parseParams(input.params) as never;
  } catch (err) {
    throw nonRetryable(
      err instanceof Error ? err.message : String(err),
      NON_RETRYABLE,
    );
  }

  const lines: string[] = [];
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), `wf-${m.id.replace(/\W/g, "_")}-`));

  const ctx: ToolContext<never> = {
    inputs: input.inputs,
    params,
    read: (ref) => get(ref.sha256),
    write: (bytes, meta) => put(bytes, meta),
    heartbeat: (progress) => heartbeat({ nodeId: input.nodeId, toolId: m.id, progress }),
    scratchDir,
    log: (line) => {
      lines.push(line);
    },
    signal: cancellationSignal(),
  };

  try {
    heartbeat({ nodeId: input.nodeId, toolId: m.id, progress: 0 });
    const result = await tool.run(ctx);
    if (result.log !== "") lines.push(result.log);

    const durationMs = Date.now() - started;
    const binaries = await binaryProvenance(tool.requiresBinaries ?? []);
    lines.push(`${m.id} produced ${result.outputs.length} artifact(s) in ${durationMs}ms`);
    lines.push(
      `worker ${WORKER_BUILD_ID}` +
        (binaries.length === 0
          ? " (pure TypeScript — no external binary)"
          : `; ${binaries.map((b) => `${b.name} ${b.version}`).join("; ")}`),
    );

    return {
      nodeId: input.nodeId,
      toolId: m.id,
      outputs: result.outputs,
      log: lines.join("\n"),
      durationMs,
      workerBuildId: WORKER_BUILD_ID,
      binaries,
    };
  } catch (err) {
    if (err instanceof MissingBinaryError) throw nonRetryable(err.message, MISSING_BINARY);
    if (err instanceof ToolParamError || err instanceof UnknownToolError) {
      throw nonRetryable(err.message, NON_RETRYABLE);
    }
    throw err;
  } finally {
    // Scratch holds copies of client documents. Remove it whether or not the
    // tool succeeded.
    try {
      await fs.rm(scratchDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      try {
        log.warn("failed to remove tool scratch dir", { scratchDir, err: String(cleanupErr) });
      } catch {
        // Logging must never turn a cleanup miss into a failed activity.
      }
    }
  }
}
