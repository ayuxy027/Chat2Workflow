import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { optionalEnv, optionalIntEnv } from "../env.js";
import type { BinaryName } from "./types.js";

/**
 * Shelling out to qpdf / Ghostscript / LibreOffice.
 *
 * These parse untrusted files from outside the firm and are large C++ surfaces
 * with a parser-CVE history (PRD §5.3), so every invocation gets a wall-clock
 * timeout, a bounded output buffer, a scratch cwd, and a cancellation signal.
 * Full sandboxing (unprivileged user, read-only root) is a deployment concern
 * and belongs in the worker image; what we can enforce in-process, we do.
 *
 * None of these binaries is guaranteed to exist on a dev machine. A missing one
 * produces a clear, actionable MissingBinaryError rather than an ENOENT stack.
 */

export const BINARY_TIMEOUT_MS = optionalIntEnv("TOOL_TIMEOUT_MS", 120_000);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

interface BinarySpec {
  /** Candidate executables, in preference order. */
  candidates: readonly string[];
  /** Env var that overrides the search entirely. */
  envVar: string;
  install: string;
  purpose: string;
}

const BINARIES: Readonly<Record<BinaryName, BinarySpec>> = {
  qpdf: {
    candidates: ["qpdf", "/opt/homebrew/bin/qpdf", "/usr/local/bin/qpdf", "/usr/bin/qpdf"],
    envVar: "QPDF_BIN",
    install: "macOS: `brew install qpdf`  ·  Debian/Ubuntu: `apt-get install -y qpdf`",
    purpose: "lossless PDF compression (pdf.compress)",
  },
  gs: {
    candidates: ["gs", "/opt/homebrew/bin/gs", "/usr/local/bin/gs", "/usr/bin/gs"],
    envVar: "GS_BIN",
    install: "macOS: `brew install ghostscript`  ·  Debian/Ubuntu: `apt-get install -y ghostscript`",
    purpose: "lossy PDF compression presets (pdf.compress with engine=ghostscript)",
  },
  soffice: {
    candidates: [
      "soffice",
      "libreoffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "/opt/homebrew/bin/soffice",
      "/usr/local/bin/soffice",
      "/usr/bin/soffice",
      "/usr/bin/libreoffice",
    ],
    envVar: "SOFFICE_BIN",
    install:
      "macOS: `brew install --cask libreoffice`  ·  Debian/Ubuntu: `apt-get install -y libreoffice`",
    purpose: "document conversion (pdf.to_docx, docx.to_pdf)",
  },
};

export class MissingBinaryError extends Error {
  readonly name = "MissingBinaryError";
  constructor(bin: BinaryName) {
    const spec = BINARIES[bin];
    super(
      `Required binary "${bin}" was not found on PATH, and it is needed for ${spec.purpose}.\n` +
        `  Install it — ${spec.install}\n` +
        `  Or point the worker at an existing copy: ${spec.envVar}=/path/to/${bin}\n` +
        `Pin the version in the worker image: an unpinned upgrade that changes conversion ` +
        `behaviour breaks the audit trail, not just the build.`,
    );
  }
}

/**
 * Absolute paths must not survive into this message: it becomes `node.error`,
 * travels over SSE to the browser, and is recorded in the workflow history. The
 * arguments are mostly scratch-directory paths, which say nothing useful to a
 * lawyer and everything useful to an attacker, so they are reduced to basenames
 * and the resolved executable is reported by its logical name.
 */
function scrubPaths(s: string): string {
  return s.replace(/(?:\/[^\s/:"']+){2,}/g, (m) => `…/${m.slice(m.lastIndexOf("/") + 1)}`);
}

export class BinaryFailedError extends Error {
  readonly name = "BinaryFailedError";
  constructor(bin: string, args: string[], code: number | null, stderr: string) {
    super(
      `${bin} exited with code ${code ?? "null"}.\n` +
        `  args: ${scrubPaths(args.join(" "))}\n` +
        `  stderr: ${scrubPaths(stderr.trim()).slice(0, 2000) || "(empty)"}`,
    );
  }
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolution AND version, cached together.
 *
 * The version is not diagnostics — it is provenance. CLAUDE.md §Tools: "an
 * unpinned upgrade that changes conversion behaviour breaks the audit trail,
 * not just the build." A `pdf.to_docx` run in March and one in September
 * produce different bytes from the same input if LibreOffice moved underneath
 * them, and history that records neither version cannot tell anyone that.
 * `--version` is already executed to probe for existence; throwing the stdout
 * away was the only thing standing between the worker and an answerable
 * audit trail.
 */
export interface ResolvedBinary {
  path: string;
  /** First line of `--version` output, trimmed. "unknown" if it said nothing. */
  version: string;
}

const resolveCache = new Map<BinaryName, ResolvedBinary | null>();

/** Resolves a logical binary to a concrete path + version, or null if unavailable. */
export async function resolveBinary(bin: BinaryName): Promise<ResolvedBinary | null> {
  const cached = resolveCache.get(bin);
  if (cached !== undefined) return cached;

  const spec = BINARIES[bin];
  const override = optionalEnv(spec.envVar, "");
  const candidates = override !== "" ? [override] : spec.candidates;

  let found: ResolvedBinary | null = null;
  for (const c of candidates) {
    // An explicit path still gets probed, so it is versioned like any other.
    if (c.includes(path.sep) && !(await isExecutable(c))) continue;
    const probed = await probe(c);
    if (probed !== null) {
      found = { path: c, version: probed };
      break;
    }
  }

  resolveCache.set(bin, found);
  return found;
}

/** Resolves a logical binary to a concrete path, or null if unavailable. */
export async function findBinary(bin: BinaryName): Promise<string | null> {
  return (await resolveBinary(bin))?.path ?? null;
}

/**
 * Runs `--version`. Returns the version string, or null if the binary does not
 * exist. A non-zero exit still proves it exists (several of these report their
 * version on stderr and exit 1), so only a spawn failure counts as absent.
 */
function probe(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err !== null && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve(null);
        return;
      }
      const first = `${String(stdout)}\n${String(stderr)}`
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l !== "");
      resolve((first ?? "unknown").slice(0, 200));
    });
  });
}

export async function requireBinary(bin: BinaryName): Promise<ResolvedBinary> {
  const r = await resolveBinary(bin);
  if (r === null) throw new MissingBinaryError(bin);
  return r;
}

/**
 * Which external binaries an invocation actually used, for the activity result.
 * Only records ones that resolved — a tool that never shelled out reports none.
 */
export interface BinaryProvenance {
  name: BinaryName;
  version: string;
}

export async function binaryProvenance(bins: readonly BinaryName[]): Promise<BinaryProvenance[]> {
  const out: BinaryProvenance[] = [];
  for (const name of bins) {
    const r = await resolveBinary(name);
    if (r !== null) out.push({ name, version: r.version });
  }
  return out;
}

export interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunOutput {
  stdout: string;
  stderr: string;
  /** The exact build that produced the bytes. Belongs in the audit record. */
  version: string;
}

export async function runBinary(
  bin: BinaryName,
  args: string[],
  opts: RunOptions,
): Promise<RunOutput> {
  const { path: exe, version } = await requireBinary(bin);
  return new Promise<RunOutput>((resolve, reject) => {
    execFile(
      exe,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? BINARY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: opts.signal,
        windowsHide: true,
        // Deterministic, locale-independent output; HOME must be writable for
        // LibreOffice's per-user profile.
        env: { ...process.env, LC_ALL: "C", HOME: opts.cwd },
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout: String(stdout), stderr: String(stderr), version });
          return;
        }
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        if (code === "ENOENT") {
          reject(new MissingBinaryError(bin));
          return;
        }
        if ((err as { killed?: boolean }).killed === true) {
          reject(
            new Error(
              `${bin} exceeded its ${opts.timeoutMs ?? BINARY_TIMEOUT_MS}ms wall-clock limit and was killed. ` +
                `Raise TOOL_TIMEOUT_MS if this document is legitimately large.`,
            ),
          );
          return;
        }
        reject(
          new BinaryFailedError(bin, args, typeof code === "number" ? code : null, String(stderr)),
        );
      },
    );
  });
}

export interface BinaryStatus {
  name: BinaryName;
  path: string | null;
  /** null when the binary is absent. Logged at startup so the pin is visible. */
  version: string | null;
  purpose: string;
  install: string;
}

/**
 * Startup probe. Reports what is missing so the operator learns at boot rather
 * than when a partner runs a conversion. Never throws — a worker with no
 * LibreOffice is still a useful worker.
 */
export async function checkBinaries(): Promise<BinaryStatus[]> {
  const names = Object.keys(BINARIES) as BinaryName[];
  return Promise.all(
    names.map(async (name) => {
      const r = await resolveBinary(name);
      return {
        name,
        path: r?.path ?? null,
        version: r?.version ?? null,
        purpose: BINARIES[name].purpose,
        install: BINARIES[name].install,
      };
    }),
  );
}
