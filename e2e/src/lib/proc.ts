/**
 * Process and port plumbing.
 *
 * Everything this harness starts is registered for teardown the moment it is
 * spawned, and teardown runs from a `finally` AND from signal handlers. A suite
 * that leaves a worker behind poisons the next run — a stale worker binds to a
 * dead Temporal and silently splits work across builds — so "leaves nothing
 * behind" is itself part of the contract.
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { show, sleep } from "./report";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** stdout + stderr interleaved as written. */
  output: string;
}

const alive = new Set<ChildProcess>();
const cleanups: (() => Promise<void> | void)[] = [];

export function onTeardown(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

/** Runs a command to completion, capturing output. Never throws on exit code. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; echo?: boolean },
): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    alive.add(child);

    let stdout = "";
    let stderr = "";
    let output = "";
    let settled = false;

    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            output += `\n[harness] killed after ${opts.timeoutMs}ms\n`;
            child.kill("SIGKILL");
          }, opts.timeoutMs);

    child.stdout?.on("data", (b: Buffer) => {
      const s = String(b);
      stdout += s;
      output += s;
      if (opts.echo === true) process.stdout.write(s);
    });
    child.stderr?.on("data", (b: Buffer) => {
      const s = String(b);
      stderr += s;
      output += s;
      if (opts.echo === true) process.stderr.write(s);
    });

    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      alive.delete(child);
      resolve({ code, stdout, stderr, output, ms: Date.now() - started });
    };

    child.on("error", (err) => {
      stderr += `\nspawn failed: ${show(err)}\n`;
      done(-1);
    });
    child.on("close", done);
  });
}

export interface Service {
  readonly child: ChildProcess;
  readonly name: string;
  /** Everything the process has written so far. */
  output(): string;
  stop(): Promise<void>;
  /** Resolves when the process exits on its own. */
  exited: Promise<number | null>;
}

/**
 * Starts a long-running process and waits for a readiness marker in its output.
 *
 * The marker matters more than it looks: `tsc` exiting 0 proved nothing about
 * whether `node dist/main.js` could actually boot, which is exactly how a
 * worker that would not start shipped past a green build.
 */
export async function startService(opts: {
  name: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Resolve once this appears in stdout/stderr. */
  ready: RegExp;
  /** Reject early if this appears. */
  fatal?: RegExp;
  timeoutMs: number;
  echo?: boolean;
}): Promise<Service> {
  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  alive.add(child);

  let buf = "";
  let exitCode: number | null | undefined;

  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      exitCode = code;
      alive.delete(child);
      resolve(code);
    });
  });

  const service: Service = {
    child,
    name: opts.name,
    output: () => buf,
    exited,
    async stop() {
      if (exitCode !== undefined) return;
      child.kill("SIGTERM");
      const raced = await Promise.race([exited, sleep(4000).then(() => "timeout" as const)]);
      if (raced === "timeout") {
        child.kill("SIGKILL");
        await Promise.race([exited, sleep(2000)]);
      }
    },
  };
  onTeardown(() => service.stop());

  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(
          `${opts.name} did not print ${opts.ready} within ${opts.timeoutMs}ms.\n` +
            `      last output: ${show(buf.slice(-800), 800)}`,
        ),
      );
    }, opts.timeoutMs);

    const settleOk = (): void => {
      clearTimeout(deadline);
      resolve();
    };
    const settleErr = (e: Error): void => {
      clearTimeout(deadline);
      reject(e);
    };

    const watch = (b: Buffer): void => {
      const s = String(b);
      buf += s;
      if (opts.echo === true) process.stdout.write(s);
      if (opts.fatal !== undefined && opts.fatal.test(buf)) {
        settleErr(
          new Error(
            `${opts.name} reported a fatal error before becoming ready.\n` +
              `      output: ${show(buf.slice(-800), 800)}`,
          ),
        );
        return;
      }
      if (opts.ready.test(buf)) settleOk();
    };

    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.on("error", (err) => settleErr(new Error(`${opts.name} failed to spawn: ${show(err)}`)));
    child.on("close", (code) => {
      if (opts.ready.test(buf)) {
        settleOk();
        return;
      }
      settleErr(
        new Error(
          `${opts.name} exited with code ${code} before becoming ready.\n` +
            `      output: ${show(buf.slice(-1200), 1200)}`,
        ),
      );
    });
  });

  return service;
}

/** An OS-assigned free TCP port. Small race window; good enough for a harness. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

export async function teardown(): Promise<void> {
  const jobs = cleanups.splice(0, cleanups.length).reverse();
  for (const fn of jobs) {
    try {
      await fn();
    } catch {
      // Teardown must never mask the real result.
    }
  }
  for (const child of alive) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  alive.clear();
}

let installed = false;
export function installSignalTeardown(): void {
  if (installed) return;
  installed = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n[harness] ${sig} — tearing down`);
      void teardown().then(() => process.exit(130));
    });
  }
}
