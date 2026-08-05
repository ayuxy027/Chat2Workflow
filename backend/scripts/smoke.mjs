import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Starts the BUILT worker and waits for it to reach "polling task queue".
 *
 * This exists because `tsc` exiting 0 proved nothing: the previous build
 * produced a dist that typechecked, built, and then crashed on its first import
 * with ERR_MODULE_NOT_FOUND. A build step that never runs its own artifact
 * cannot tell you that. Requires a reachable Temporal — it is a smoke test, not
 * a unit test, and "can the built worker actually connect and poll" is exactly
 * the question that went unasked.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "main.js");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 45_000);

const child = spawn(process.execPath, [entry], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

let output = "";
let settled = false;

const done = (code, message) => {
  if (settled) return;
  settled = true;
  console.log(message);
  child.kill("SIGTERM");
  setTimeout(() => {
    child.kill("SIGKILL");
    process.exit(code);
  }, 3000).unref();
  child.on("exit", () => process.exit(code));
};

const watch = (buf) => {
  const s = String(buf);
  output += s;
  process.stdout.write(s);
  if (output.includes("polling task queue")) {
    done(0, "\n[smoke] PASS — the built worker started and is polling.");
  }
};

child.stdout.on("data", watch);
child.stderr.on("data", watch);

child.on("exit", (code) => {
  if (settled) return;
  settled = true;
  console.error(`\n[smoke] FAIL — the built worker exited with code ${code} before polling.`);
  process.exit(1);
});

setTimeout(() => {
  done(1, `\n[smoke] FAIL — no "polling task queue" within ${TIMEOUT_MS}ms.`);
}, TIMEOUT_MS).unref();
