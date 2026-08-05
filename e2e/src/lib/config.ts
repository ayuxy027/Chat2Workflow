/**
 * Suite configuration: workspace discovery, environment, ports, isolation.
 *
 * WORKSPACE PATHS ARE DISCOVERED, NOT HARDCODED. This harness was written
 * against `apps/web` + `packages/shared` and the layout was renamed to
 * `frontend` + `shared` while it was being written. A test harness that breaks
 * when a directory is renamed is a harness people stop running, so the roles —
 * "the Next app", "the Temporal worker", "the shared contract" — are resolved
 * from the root `workspaces` list and each package's own scripts.
 *
 * ISOLATION IS THE POINT of the task-queue override. A stale worker left over
 * from a previous run — or one another developer is running right now — polls
 * the same queue and silently steals half the suite's activities, which makes
 * every timing measurement meaningless and every failure irreproducible. Giving
 * each run its own queue makes that impossible instead of asking everybody to
 * remember `pkill` first.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_ROOT = path.resolve(E2E_DIR, "..");

export interface WorkspacePkg {
  name: string;
  dir: string;
  scripts: Record<string, string>;
}

export interface Workspaces {
  all: WorkspacePkg[];
  /** The Next.js app: canvas, API routes, SSE, blob store. */
  frontend: WorkspacePkg;
  /** The Temporal worker. */
  backend: WorkspacePkg;
  /** The zod contract both sides import. */
  shared: WorkspacePkg;
}

async function readPkg(dir: string): Promise<WorkspacePkg | undefined> {
  try {
    const raw = await readFile(path.join(dir, "package.json"), "utf8");
    const json = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    if (typeof json.name !== "string") return undefined;
    return { name: json.name, dir, scripts: json.scripts ?? {} };
  } catch {
    return undefined;
  }
}

/** Expands the tiny subset of glob syntax bun workspaces actually use. */
async function expand(pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) return [path.join(REPO_ROOT, pattern)];
  const base = path.join(REPO_ROOT, pattern.slice(0, pattern.indexOf("*")));
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(base, e.name));
  } catch {
    return [];
  }
}

export async function discoverWorkspaces(): Promise<Workspaces> {
  const rootRaw = await readFile(path.join(REPO_ROOT, "package.json"), "utf8");
  const root = JSON.parse(rootRaw) as { workspaces?: string[] };
  const patterns = root.workspaces ?? [];

  const dirs = (await Promise.all(patterns.map(expand))).flat();
  const all = (await Promise.all(dirs.map(readPkg))).filter(
    (p): p is WorkspacePkg => p !== undefined && p.dir !== E2E_DIR,
  );

  const byRole = (
    predicate: (p: WorkspacePkg) => boolean,
    role: string,
  ): WorkspacePkg => {
    const hit = all.find(predicate);
    if (hit === undefined) {
      throw new Error(
        `Could not identify the ${role} workspace among [${all
          .map((p) => `${p.name} @ ${path.relative(REPO_ROOT, p.dir)}`)
          .join(", ")}]. The harness resolves workspaces by role from the root ` +
          `"workspaces" list; add the package there or teach discoverWorkspaces about it.`,
      );
    }
    return hit;
  };

  const frontend = byRole(
    (p) => /(^|\/)next( |$)/.test(p.scripts["dev"] ?? "") || /web|frontend/.test(p.name),
    "Next.js app",
  );
  const backend = byRole(
    (p) => (p.scripts["start"] ?? "").includes("dist/main.js") || /backend|worker/.test(p.name),
    "Temporal worker",
  );
  const shared = byRole((p) => /shared/.test(p.name), "shared contract");

  return { all, frontend, backend, shared };
}

/** Mirrors `set -a && . ./.env && set +a` without shelling out. */
export async function loadDotEnv(
  file = path.join(REPO_ROOT, ".env"),
): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface Options {
  only: Set<string>;
  skip: Set<string>;
  fast: boolean;
  keep: boolean;
  killStale: boolean;
  webPort?: number;
}

export const ALL_PHASES = [
  "preflight",
  "plan",
  "stream",
  "edits",
  "run",
  "negative",
  "browser",
] as const;
export type PhaseName = (typeof ALL_PHASES)[number];

export const USAGE = `
bun run e2e [flags]

  --only=a,b       run only these phases   (${ALL_PHASES.join(", ")})
  --skip=a,b       skip these phases
  --fast           skip typechecks and rebuilds; reuse the existing artifacts
  --keep           leave the worker and web server running afterwards
  --port=N         serve the app on this port (default: an OS-assigned free port)
  --kill-stale-workers
                   pkill -f src/main.ts first. Not needed by default: the suite
                   runs on its own Temporal task queue, so an unrelated worker
                   cannot steal its activities.
`.trim();

export function parseArgs(argv: string[]): Options {
  const only = new Set<string>();
  const skip = new Set<string>();
  let fast = false;
  let keep = false;
  let killStale = false;
  let webPort: number | undefined;

  for (const arg of argv) {
    if (arg === "--fast") fast = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--kill-stale-workers") killStale = true;
    else if (arg.startsWith("--only=")) {
      for (const p of arg.slice(7).split(",")) if (p !== "") only.add(p.trim());
    } else if (arg.startsWith("--skip=")) {
      for (const p of arg.slice(7).split(",")) if (p !== "") skip.add(p.trim());
    } else if (arg.startsWith("--port=")) {
      webPort = Number.parseInt(arg.slice(7), 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown flag ${arg}\n${USAGE}`);
      process.exit(2);
    }
  }

  const unknown = [...only, ...skip].filter((p) => !(ALL_PHASES as readonly string[]).includes(p));
  if (unknown.length > 0) {
    console.error(`unknown phase(s): ${unknown.join(", ")}. Known: ${ALL_PHASES.join(", ")}`);
    process.exit(2);
  }

  return { only, skip, fast, keep, killStale, webPort };
}

export function wants(opts: Options, phase: PhaseName): boolean {
  if (opts.skip.has(phase)) return false;
  if (opts.only.size > 0) return opts.only.has(phase);
  return true;
}
