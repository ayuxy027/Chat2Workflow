import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index.js";
import { describeBlobStore } from "@wf/storage";
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE } from "./env.js";
import { GRAPH_SESSION_WORKFLOW } from "@wf/shared";
import { inspectRegistry, orphanManifests, toolIds } from "./tools/registry.js";
import {
  ANALYSIS_PROMPT_VERSION,
  PLAN_PROMPT_VERSION,
  VERIFIER_VERSION,
  WORKER_BUILD_ID,
} from "./version.js";

/**
 * Worker bootstrap: connect, register workflows + activities, poll a task
 * queue, shut down cleanly.
 *
 * The worker does not need a live LLM endpoint to start — model credentials are
 * read lazily, at call time, so a missing key fails one activity with an
 * actionable message instead of preventing the worker from booting.
 */

/**
 * The workflow TYPE NAME the client starts is the exported function's name, and
 * the client only ever knows it as a string. This asserts that a function
 * called exactly `GRAPH_SESSION_WORKFLOW` is exported from the bundle, so
 * renaming the workflow becomes a typecheck failure instead of a
 * `WorkflowNotFound` the first time somebody opens a canvas. Type-only import:
 * nothing from the workflow module is loaded here.
 */
type ExportedWorkflows = keyof typeof import("./workflows/index.js");
const _workflowNameMatchesWire: typeof GRAPH_SESSION_WORKFLOW extends ExportedWorkflows
  ? true
  : never = true;
void _workflowNameMatchesWire;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The workflow bundle entrypoint, resolved for whichever form of the worker is
 * running: `.ts` under tsx in dev, `.js` from dist after a build. Deriving it
 * from THIS module's own extension keeps the two in lockstep — a hardcoded
 * ".js" typechecks perfectly and then dies at startup in dev, because the file
 * it names does not exist there. The Temporal bundler compiles a .ts
 * entrypoint, so pointing at the source in dev is supported.
 */
const workflowsPath = path.join(
  here,
  "workflows",
  import.meta.url.endsWith(".ts") ? "index.ts" : "index.js",
);

/**
 * Prefer a bundle built at BUILD time.
 *
 * `workflowsPath` makes the worker run webpack during startup — 400-800ms on
 * every boot of every replica, and a bundling error that only appears in
 * production. `bun run build` now emits `dist/workflow-bundle.js`; when it is
 * present the worker loads it and skips bundling entirely. Dev still points at
 * the `.ts` source, because rebundling on each restart is the point there.
 */
async function workflowSource(): Promise<
  { workflowBundle: { code: string } } | { workflowsPath: string }
> {
  const bundlePath = path.join(here, "workflow-bundle.js");
  try {
    const code = await readFile(bundlePath, "utf8");
    console.log(`[worker] using prebuilt workflow bundle (${(code.length / 1e6).toFixed(2)}MB)`);
    return { workflowBundle: { code } };
  } catch {
    console.log("[worker] no prebuilt bundle; bundling workflows at startup");
    return { workflowsPath };
  }
}

/**
 * Reports which tools are usable on this machine. Three of the six are pure
 * TypeScript and always work; the rest shell out to binaries the worker image
 * is supposed to pin. Missing binaries are logged, never fatal.
 */
async function reportTools(): Promise<void> {
  const { binaries, unavailable } = await inspectRegistry();

  console.log(`[worker] tools registered: ${toolIds().join(", ")}`);
  for (const b of binaries) {
    console.log(
      b.path === null
        ? `[worker]   ✗ ${b.name} — NOT FOUND. Needed for ${b.purpose}. ${b.install}`
        : `[worker]   ✓ ${b.name} → ${b.path}  [${b.version ?? "unknown version"}]`,
    );
  }
  for (const u of unavailable) {
    console.warn(
      `[worker]   ! ${u.toolId} is UNAVAILABLE (missing: ${u.missing.join(", ")}). ` +
        `Nodes using it will fail with an install hint rather than a stack trace.`,
    );
  }
  if (unavailable.length === 0) {
    console.log("[worker]   all registered tools are runnable");
  }

  // A manifest with no implementation still renders a working-looking node form
  // in the browser, which then fails on Run. Say so at boot instead.
  const orphans = orphanManifests();
  if (orphans.length > 0) {
    console.warn(
      `[worker]   ! manifest(s) with no implementation: ${orphans.join(", ")}. ` +
        `The canvas will offer these as tool nodes and they will fail when run.`,
    );
  }
}

async function main(): Promise<void> {
  const address = TEMPORAL_ADDRESS();
  const namespace = TEMPORAL_NAMESPACE();
  const taskQueue = TEMPORAL_TASK_QUEUE();

  console.log(`[worker] build ${WORKER_BUILD_ID}`);
  if (WORKER_BUILD_ID === "dev-unpinned") {
    console.warn(
      "[worker]   ! WORKER_BUILD_ID is unset. Every activity result and workflow task will " +
        "be stamped \"dev-unpinned\", so the audit trail cannot say which code ran. " +
        "Set it to the git SHA in the worker image.",
    );
  }
  console.log(
    `[worker] prompts: ${PLAN_PROMPT_VERSION}, ${ANALYSIS_PROMPT_VERSION}; ${VERIFIER_VERSION}`,
  );
  /*
   * Resolve the document store BEFORE connecting to Temporal, and let a
   * configuration error kill the boot.
   *
   * A worker that polls happily and then fails every document activity is the
   * worst outcome available: the canvas fills in, the upload succeeds, and the
   * break surfaces minutes later as a BlobNotFoundError on a file the user
   * watched arrive. @wf/storage refuses to guess — no silent fall back to local
   * disk when the S3 variables are half-set — so this throws here, at boot,
   * naming what is missing.
   *
   * The location line is load-bearing beyond the log: the e2e harness reads it
   * back out of the worker's own stdout and asserts the worker and the web app
   * resolved the SAME store.
   */
  const store = describeBlobStore();
  console.log(`[worker] blob store: ${store.location}`);
  console.log(`[worker] blob driver: ${store.driver}`);
  if (store.driver === "filesystem") {
    console.log(
      "[worker]   local disk — only correct while the web app runs on this same machine. " +
        "Split across two hosts (Vercel + Render) there is no shared filesystem: set " +
        "BLOB_READ_WRITE_TOKEN (Vercel Blob) or the BLOB_S3_* variables (S3) on BOTH " +
        "services, and check this line says the same driver in both logs.",
    );
  }
  await reportTools();

  const connection = await NativeConnection.connect({ address });
  console.log(`[worker] connected to Temporal at ${address} (namespace ${namespace})`);

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    // Points at the barrel, not at the activity implementations — the workflow
    // bundle must stay free of fs, network, and clock access.
    ...(await workflowSource()),
    activities,
    // Stamps every workflow task with the build that served it. Without it,
    // "which code produced this history?" is unanswerable from the history —
    // and the history is the audit trail. Set WORKER_BUILD_ID to the git SHA
    // in the image; `useVersioning` stays off, so this is a label, not a
    // routing rule, and rolling out a new build needs no migration.
    buildId: WORKER_BUILD_ID,
  });

  let shuttingDown = false;
  const stop = (signal: string): void => {
    if (shuttingDown) {
      console.warn(`[worker] ${signal} again — exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`[worker] ${signal} received, draining tasks…`);
    // Lets in-flight activities finish and cancels long-running ones via their
    // cancellation signal, rather than dropping them on the floor.
    worker.shutdown();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  console.log(`[worker] polling task queue "${taskQueue}"`);
  try {
    await worker.run();
    console.log("[worker] stopped cleanly");
  } finally {
    await connection.close();
  }
}

main().catch((err: unknown) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
