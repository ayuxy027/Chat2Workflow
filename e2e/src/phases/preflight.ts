/**
 * Phase 1 — preflight.
 *
 * The premise: `typecheck` and `build` exiting 0 have already, in this project,
 * been simultaneously true and worthless. `tsc` emitted a `dist` that compiled
 * perfectly and died on its first import with ERR_MODULE_NOT_FOUND, because
 * `@wf/shared` is consumed as TypeScript source with extensionless specifiers
 * that Node will not resolve. So this phase does not stop at "it compiled" — it
 * STARTS the artifact and waits for it to say it is polling.
 *
 * The same logic applies to `BLOB_DIR`: a relative path type-checks, builds,
 * uploads, and only fails much later as an activity that cannot find bytes
 * whose hash the graph is already carrying. It is checked here, by resolving it
 * the way each process would.
 */

import { access, stat } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT, type Workspaces } from "../lib/config";
import { run, startService } from "../lib/proc";
import { show, type Phase } from "../lib/report";

export interface PreflightResult {
  /** True when the built worker artifact exists and starts. */
  workerArtifactOk: boolean;
  /** True when the app built and can be served. */
  webBuildOk: boolean;
  blobDir: string;
}

const BUILD_TIMEOUT_MS = 420_000;
const WORKER_START_TIMEOUT_MS = 60_000;

export async function preflight(
  phase: Phase,
  ws: Workspaces,
  env: NodeJS.ProcessEnv,
  opts: { fast: boolean },
): Promise<PreflightResult> {
  const rel = (dir: string): string => path.relative(REPO_ROOT, dir) || ".";

  /* ---------------------------------------------------------------- */
  /* BLOB_DIR — absolute, and the SAME resolved path for both processes */
  /* ---------------------------------------------------------------- */

  const blobDirRaw = env["BLOB_DIR"] ?? "";
  phase.ok(
    "blobdir.set",
    blobDirRaw !== "",
    "BLOB_DIR to be set (the worker refuses to boot without it)",
    blobDirRaw === "" ? "unset or empty" : blobDirRaw,
  );

  phase.ok(
    "blobdir.absolute",
    blobDirRaw !== "" && path.isAbsolute(blobDirRaw),
    "BLOB_DIR to be an ABSOLUTE path — the app and the worker resolve it from different " +
      "working directories, so a relative path silently gives them two stores",
    blobDirRaw === ""
      ? "unset"
      : `${blobDirRaw} (isAbsolute=${String(path.isAbsolute(blobDirRaw))})`,
  );

  // The real assertion behind "absolute": resolve it the way each process
  // would, from its own cwd, and require the two answers to be identical.
  const asWeb = path.resolve(ws.frontend.dir, blobDirRaw === "" ? "." : blobDirRaw);
  const asWorker = path.resolve(ws.backend.dir, blobDirRaw === "" ? "." : blobDirRaw);
  phase.ok(
    "blobdir.same_for_web_and_worker",
    asWeb === asWorker,
    "BLOB_DIR to resolve to one directory from both process cwds",
    asWeb === asWorker
      ? asWeb
      : `${ws.frontend.name} (cwd ${rel(ws.frontend.dir)}) -> ${asWeb}\n` +
        `      ${ws.backend.name} (cwd ${rel(ws.backend.dir)}) -> ${asWorker}`,
  );

  const blobDir = asWeb;

  try {
    const s = await stat(blobDir);
    phase.ok(
      "blobdir.usable",
      s.isDirectory(),
      `${blobDir} to be a directory`,
      s.isDirectory() ? "directory" : "exists but is not a directory",
    );
  } catch {
    // Not yet created is fine — both stores mkdir on first write.
    phase.note(`${blobDir} does not exist yet; both processes create it on first write`);
    phase.pass("blobdir.usable");
  }

  /* ---------------------------------------------------------------- */
  /* Typecheck + build — every workspace, in parallel                  */
  /* ---------------------------------------------------------------- */

  const roles: { role: string; pkg: (typeof ws)["shared"] }[] = [
    { role: "shared", pkg: ws.shared },
    { role: "backend", pkg: ws.backend },
    { role: "frontend", pkg: ws.frontend },
  ];

  if (opts.fast) {
    for (const { role } of roles) phase.skip(`typecheck.${role}`, "--fast: typechecks skipped");
    phase.skip("build.backend", "--fast: reusing the existing dist/");
    phase.skip("build.frontend", "--fast: reusing the existing .next/");
  } else {
    // Independent, so run them together. This is the single biggest lever on
    // whether the suite is fast enough that anyone actually runs it.
    const typechecks = await Promise.all(
      roles.map(({ pkg }) =>
        run("bun", ["run", "--filter", pkg.name, "typecheck"], {
          cwd: REPO_ROOT,
          env,
          timeoutMs: BUILD_TIMEOUT_MS,
        }),
      ),
    );
    roles.forEach(({ role, pkg }, i) => {
      const res = typechecks[i];
      phase.ok(
        `typecheck.${role}`,
        res?.code === 0,
        `\`bun run --filter ${pkg.name} typecheck\` to exit 0`,
        `exit ${String(res?.code)}${res?.code === 0 ? "" : `\n      ${tail(res?.output ?? "")}`}`,
      );
    });

    const buildable = roles.filter(({ pkg }) => pkg.scripts["build"] !== undefined);
    const builds = await Promise.all(
      buildable.map(({ pkg }) =>
        run("bun", ["run", "--filter", pkg.name, "build"], {
          cwd: REPO_ROOT,
          env,
          timeoutMs: BUILD_TIMEOUT_MS,
        }),
      ),
    );
    buildable.forEach(({ role, pkg }, i) => {
      const res = builds[i];
      phase.ok(
        `build.${role}`,
        res?.code === 0,
        `\`bun run --filter ${pkg.name} build\` to exit 0`,
        `exit ${String(res?.code)}${res?.code === 0 ? "" : `\n      ${tail(res?.output ?? "")}`}`,
      );
    });
  }

  /* ---------------------------------------------------------------- */
  /* The artifact must START, not merely compile                       */
  /* ---------------------------------------------------------------- */

  const distMain = path.join(ws.backend.dir, "dist", "main.js");
  let artifactExists = true;
  try {
    await access(distMain);
  } catch {
    artifactExists = false;
  }
  phase.ok(
    "artifact.exists",
    artifactExists,
    `${rel(distMain)} to exist after the build`,
    artifactExists ? "present" : "missing",
  );

  let workerArtifactOk = false;
  if (artifactExists) {
    try {
      const svc = await startService({
        name: "built worker (node dist/main.js)",
        cmd: process.execPath,
        args: [distMain],
        cwd: ws.backend.dir,
        env,
        ready: /polling task queue/,
        timeoutMs: WORKER_START_TIMEOUT_MS,
      });
      workerArtifactOk = true;
      phase.pass("artifact.starts");

      // The blob store the worker actually resolved, straight from its own log.
      const m = /\[worker\] blob store: (.+)/.exec(svc.output());
      if (m?.[1] !== undefined) {
        const reported = m[1].trim();
        phase.ok(
          "artifact.blobdir_matches",
          path.resolve(reported) === blobDir,
          `the built worker to report blob store ${blobDir}`,
          reported,
        );
      } else {
        phase.skip("artifact.blobdir_matches", "the worker did not log its blob store path");
      }
      await svc.stop();
    } catch (err) {
      phase.fail(
        "artifact.starts",
        `expected \`node dist/main.js\` to reach "polling task queue" within ` +
          `${WORKER_START_TIMEOUT_MS}ms\n      saw      ${show(err, 900)}`,
      );
    }
  } else {
    phase.skip("artifact.starts", "dist/main.js was not produced");
    phase.skip("artifact.blobdir_matches", "dist/main.js was not produced");
  }

  const webBuildOk = phase.checks.find((c) => c.name === "build.frontend")?.status !== "fail";

  return { workerArtifactOk, webBuildOk, blobDir };
}

function tail(s: string, n = 1400): string {
  const trimmed = s.trimEnd();
  return trimmed.length <= n ? trimmed : `…${trimmed.slice(-n)}`;
}
