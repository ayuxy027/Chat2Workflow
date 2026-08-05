/**
 * `bun run e2e` — the end-to-end enforcement harness.
 *
 * Self-contained: it discovers the workspaces, typechecks and builds them,
 * proves the BUILT worker artifact starts, brings up its own worker and its own
 * web server on their own Temporal task queue, exercises the whole loop, and
 * tears everything down. Exit 0 or non-zero, with a report you can act on
 * without re-running anything by hand.
 *
 * WHY ITS OWN TASK QUEUE. A stale worker is the single most effective way to
 * make this suite lie: it polls the same queue, takes half the activities, runs
 * them against a different build, and every timing measurement becomes noise.
 * Rather than depend on everyone remembering `pkill -f src/main.ts`, each run
 * gets a private queue, so a worker that is not ours cannot touch our work.
 *
 * WHAT RUNS IN PARALLEL. The phases that need the model are the long pole, so
 * independent ones overlap: planning+streaming, edits and the negative cases go
 * together; execution and the fabricated-citation control go together with the
 * browser smoke. Nothing shares a session, so nothing can interfere.
 */

import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { Api } from "./lib/api";
import {
  ALL_PHASES,
  discoverWorkspaces,
  loadDotEnv,
  parseArgs,
  REPO_ROOT,
  wants,
  type Options,
  type Workspaces,
} from "./lib/config";
import { CHROME } from "./lib/cdp";
import { freePort, installSignalTeardown, run, startService, teardown } from "./lib/proc";
import { Suite, show, until, withTimeout } from "./lib/report";
import { generatePdf } from "./lib/pdf";
import { preflight } from "./phases/preflight";
import { planAndStream } from "./phases/plan-stream";
import { edits } from "./phases/edits";
import { fabricatedCitation, runPipeline } from "./phases/run";
import { negative } from "./phases/negative";
import { browserSmoke } from "./phases/browser";

const WEB_START_TIMEOUT_MS = 120_000;
const WORKER_START_TIMEOUT_MS = 90_000;

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  installSignalTeardown();

  const suite = new Suite();
  const startedAt = Date.now();

  console.log("═".repeat(72));
  console.log("  E2E ENFORCEMENT HARNESS");
  console.log("═".repeat(72));

  /* --------------------------- environment --------------------------- */

  const ws: Workspaces = await discoverWorkspaces();
  const dotenv = await loadDotEnv();

  // A private queue per run. See the header.
  const taskQueue = `e2e-${randomBytes(4).toString("hex")}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...dotenv,
    TEMPORAL_TASK_QUEUE: taskQueue,
    // Stamps the audit trail with something better than "dev-unpinned" and
    // proves the buildId plumbing is reachable.
    WORKER_BUILD_ID: dotenv["WORKER_BUILD_ID"] ?? `e2e-${taskQueue}`,
    NODE_ENV: "production",
  };

  console.log(`  repo        ${REPO_ROOT}`);
  console.log(
    `  workspaces  ${ws.all
      .map((p) => `${p.name} → ${path.relative(REPO_ROOT, p.dir)}`)
      .join("\n              ")}`,
  );
  console.log(`  task queue  ${taskQueue}  (private to this run)`);
  console.log(`  blob dir    ${env["BLOB_DIR"] ?? "<unset>"}`);
  console.log(
    `  phases      ${ALL_PHASES.filter((p) => wants(opts, p)).join(", ") || "(none)"}`,
  );

  if (opts.killStale) {
    const res = await run("pkill", ["-f", "src/main.ts"], { cwd: REPO_ROOT, env });
    console.log(`  killed stale workers (pkill exit ${String(res.code)})`);
  }

  /* ---------------------------- preflight ---------------------------- */

  let blobDir = path.resolve(env["BLOB_DIR"] ?? path.join(REPO_ROOT, ".data", "blobs"));

  if (wants(opts, "preflight")) {
    const phase = suite.phase("preflight");
    try {
      const res = await preflight(phase, ws, env, { fast: opts.fast });
      blobDir = res.blobDir;
    } catch (err) {
      phase.caught("preflight", err);
    }
  } else {
    suite.phase("preflight").skip("preflight", "not selected");
  }

  const needsStack = ALL_PHASES.some((p) => p !== "preflight" && wants(opts, p));
  if (!needsStack) {
    await teardown();
    return suite.report();
  }

  /* --------------------------- bring it up --------------------------- */

  const bring = suite.phase("bringup");
  const webPort = opts.webPort ?? (await freePort());
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const api = new Api(baseUrl);

  try {
    // The worker runs from dist/ — the artifact preflight just proved starts.
    // Running the same bytes the suite validated is the point: a harness that
    // validates `dist` and then exercises `tsx watch src` is testing two
    // different programs.
    await startService({
      name: "worker",
      cmd: process.execPath,
      args: [path.join(ws.backend.dir, "dist", "main.js")],
      cwd: ws.backend.dir,
      env,
      ready: /polling task queue/,
      timeoutMs: WORKER_START_TIMEOUT_MS,
    });
    bring.pass("worker.up");
  } catch (err) {
    bring.fail(
      "worker.up",
      `expected the built worker to start and poll "${taskQueue}"\n      saw      ${show(err, 900)}`,
    );
    bring.aborted = "the worker did not start, so nothing downstream can run";
    await finish(opts, suite, startedAt);
    return suite.report();
  }

  try {
    const nextBin = path.join(ws.frontend.dir, "node_modules", ".bin", "next");
    await startService({
      name: "web",
      cmd: nextBin,
      args: ["start", "-p", String(webPort)],
      cwd: ws.frontend.dir,
      env: { ...env, PORT: String(webPort) },
      ready: /Ready in|started server|Local:/i,
      timeoutMs: WEB_START_TIMEOUT_MS,
    });
    // "Ready" is printed before the first request is served in some versions;
    // the only honest readiness signal is a route answering.
    await until(`${baseUrl}/api/tools to answer 200`, 60_000, 250, async () => {
      const res = await fetch(`${baseUrl}/api/tools`).catch(() => undefined);
      return res?.ok === true ? true : undefined;
    });
    bring.pass("web.up");
    bring.note(`serving ${ws.frontend.name} (production build) on ${baseUrl}`);
  } catch (err) {
    bring.fail(
      "web.up",
      `expected \`next start -p ${webPort}\` to serve ${baseUrl}/api/tools\n      saw      ${show(err, 900)}`,
    );
    bring.aborted = "the web server did not start, so nothing downstream can run";
    await finish(opts, suite, startedAt);
    return suite.report();
  }

  // The tool registry, fetched once and asserted here so every later phase can
  // trust it.
  try {
    const tools = await api.tools();
    bring.ok(
      "tools.registry_served",
      tools.length > 0 && tools.every((t) => typeof t.id === "string"),
      "GET /api/tools to serve a non-empty registry of manifests with ids",
      `${tools.length} tool(s): ${tools.map((t) => t.id).join(", ")}`,
    );
  } catch (err) {
    bring.caught("tools.registry_served", err);
  }

  const pdf = generatePdf();
  bring.note(
    `generated a ${pdf.pages.length}-page PDF (${pdf.bytes.length} bytes) with per-page ` +
      `ground truth; the indemnity clause is on page ${pdf.indemnityPage}`,
  );

  /* ------------------------------ phases ------------------------------ */

  const jobs: Promise<void>[] = [];

  // Group A — planning/streaming (model), edits (no model), negatives (no model).
  const planPhase = wants(opts, "plan") ? suite.phase("plan") : undefined;
  const streamPhase = wants(opts, "stream") ? suite.phase("stream") : undefined;
  if (planPhase !== undefined || streamPhase !== undefined) {
    const p = planPhase ?? suite.phase("plan");
    const s = streamPhase ?? suite.phase("stream");
    jobs.push(
      guard(p, "plan+stream", 300_000, planAndStream(p, s, api, "127.0.0.1", webPort)),
    );
  }

  if (wants(opts, "edits")) {
    const phase = suite.phase("edits");
    jobs.push(guard(phase, "edits", 180_000, edits(phase, api, pdf.bytes)));
  }

  if (wants(opts, "negative")) {
    const phase = suite.phase("negative");
    jobs.push(guard(phase, "negative", 180_000, negative(phase, api)));
  }

  await Promise.all(jobs);
  jobs.length = 0;

  // Group B — execution (model), the fabricated-citation control (model), and
  // the browser smoke (model, via the planner).
  if (wants(opts, "run")) {
    const phase = suite.phase("run");
    const provPhase = suite.phase("provenance");
    jobs.push(
      guard(
        phase,
        "run",
        600_000,
        runPipeline(phase, provPhase, api, pdf, blobDir, "127.0.0.1", webPort),
      ),
    );
    if (wants(opts, "negative")) {
      const control = suite.phase("verifier");
      jobs.push(
        guard(
          control,
          "fabricated citation",
          600_000,
          fabricatedCitation(control, api, pdf, "127.0.0.1", webPort),
        ),
      );
    }
  }

  if (wants(opts, "browser")) {
    const phase = suite.phase("browser");
    const hasChrome = await access(CHROME)
      .then(() => true)
      .catch(() => false);
    if (!hasChrome) {
      phase.skip(
        "browser.*",
        `no headless chrome at ${CHROME} — install it with ` +
          `\`bunx playwright install chromium\``,
      );
    } else {
      jobs.push(
        guard(
          phase,
          "browser",
          420_000,
          browserSmoke(
            phase,
            baseUrl,
            path.join(REPO_ROOT, "e2e", ".artifacts", "canvas.png"),
          ),
        ),
      );
    }
  }

  await Promise.all(jobs);

  /* ------------------------------ teardown ---------------------------- */

  await api.closeAllSessions().catch(() => undefined);
  await finish(opts, suite, startedAt);
  return suite.report();
}

/** Runs a phase so a throw becomes a recorded failure, never a lost suite. */
async function guard(
  phase: { caught(name: string, err: unknown): void; aborted?: string },
  label: string,
  timeoutMs: number,
  work: Promise<void>,
): Promise<void> {
  try {
    await withTimeout(label, timeoutMs, work);
  } catch (err) {
    phase.caught(`${label}.completed`, err);
    phase.aborted = show(err, 300);
  }
}

async function finish(opts: Options, suite: Suite, startedAt: number): Promise<void> {
  if (opts.keep) {
    console.log("\n[harness] --keep: leaving the worker and web server running.");
    return;
  }
  await teardown();
  void suite;
  void startedAt;
}

main()
  .then(async (code) => {
    await teardown();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error("\n[harness] the suite itself failed:", err);
    await teardown();
    process.exit(1);
  });
