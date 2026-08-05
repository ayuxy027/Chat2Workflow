import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Production build.
 *
 * `tsc -p tsconfig.json` emitted JS that type-checked perfectly and then died at
 * startup with ERR_MODULE_NOT_FOUND. `@wf/shared` is consumed as TypeScript
 * SOURCE — its package.json points `exports` at `./src/index.ts`, and that file
 * uses extensionless relative specifiers (`export * from "./graph"`). tsx
 * resolves those in dev; Node does not, and tsc does not rewrite them. So
 * `bun run build` exited 0, `typecheck` exited 0, and `node dist/main.js` was
 * dead — which is why `bun run smoke` exists. Run it after every build; it is
 * a separate script only because it needs a reachable Temporal server.
 *
 * Bundling is the fix that does not require changing the shared package:
 * esbuild inlines `@wf/shared` from source and resolves the specifiers itself.
 *
 * TWO entrypoints, deliberately:
 *   - main.js       the worker process.
 *   - workflows/index.js  the workflow bundle entrypoint. `Worker.create`
 *     hands this to Temporal's own webpack bundler, which must see a real file
 *     at the path main.js derives. Keeping it separate also preserves the
 *     property that matters most here: nothing reachable from the workflow
 *     entry may pull in fs, network, or the activity implementations.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outdir = path.join(root, "dist");

await rm(outdir, { recursive: true, force: true });

/** Native bindings and the SDK's own module graph must not be inlined. */
const external = [
  "@temporalio/*",
  // Optional/native deps that the SDK and AI SDK reach for at runtime.
  "node:*",
];

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(outdir, "main.js"),
  external,
  // Several transitive deps are CJS and call `require` after esbuild has
  // rewritten the module to ESM. This shim is for the WORKER process only.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

await build({
  ...common,
  entryPoints: [path.join(root, "src", "workflows", "index.ts")],
  outfile: path.join(outdir, "workflows", "index.js"),
  // The Temporal bundler injects its own deterministic @temporalio/workflow.
  external: ["@temporalio/*"],
  // NOTE: no `require` banner here, and no node: builtins. Temporal's webpack
  // pass compiles this file for the workflow sandbox, which has no module
  // system and no Node builtins — the first version of this script shared the
  // banner between both entrypoints and webpack refused `node:module`. That
  // refusal is correct: anything in this bundle that needs Node has no business
  // being in workflow code. Keep this entry free of it.
});

/**
 * Pre-bundle the workflow code.
 *
 * `Worker.create({ workflowsPath })` runs webpack at STARTUP — measured at
 * 400-800ms on every boot, repeated identically in every replica. Doing it once
 * here and shipping `workflowBundle` instead moves that off the critical path
 * and, more usefully, turns a bundling error into a build failure rather than
 * something a worker discovers in production. This session already hit exactly
 * that: a `node:module` banner that webpack rejected only when the worker
 * started.
 */
const { bundleWorkflowCode } = await import("@temporalio/worker");
const { code } = await bundleWorkflowCode({
  workflowsPath: path.join(outdir, "workflows", "index.js"),
});
await writeFile(path.join(outdir, "workflow-bundle.js"), code);
console.log(`[build] dist/main.js + dist/workflows/index.js + workflow-bundle.js (${(code.length / 1e6).toFixed(2)}MB)`);
