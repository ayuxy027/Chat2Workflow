/**
 * The assertion + reporting core.
 *
 * One rule governs every helper here: a failing check must name WHAT WAS
 * EXPECTED and WHAT WAS SEEN, in the message itself. The whole point of this
 * harness is that a red run is diagnosable from its output — if you have to
 * re-run it by hand with curl to find out what broke, the check was written
 * wrong.
 */

export type CheckStatus = "pass" | "fail" | "skip";

export interface Check {
  phase: string;
  name: string;
  status: CheckStatus;
  /** For a failure: "expected X, saw Y". For a skip: why. */
  message: string;
  ms: number;
}

const GLYPH: Record<CheckStatus, string> = { pass: "✓", fail: "✗", skip: "·" };

let liveOutput = true;
export function setLiveOutput(on: boolean): void {
  liveOutput = on;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Truncates a value for a message without hiding the part that matters. */
export function show(value: unknown, max = 400): string {
  let s: string;
  if (typeof value === "string") s = value;
  else if (value instanceof Error) s = `${value.name}: ${value.message}`;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s*\n\s*/g, " ⏎ ");
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

export class Phase {
  readonly name: string;
  readonly checks: Check[] = [];
  readonly notes: string[] = [];
  private readonly startedAt = Date.now();
  private lastMark = Date.now();
  /** Set when the phase could not run at all (e.g. a dependency failed). */
  aborted: string | undefined;

  constructor(name: string) {
    this.name = name;
  }

  private record(name: string, status: CheckStatus, message: string): void {
    const now = Date.now();
    const check: Check = { phase: this.name, name, status, message, ms: now - this.lastMark };
    this.lastMark = now;
    this.checks.push(check);
    if (liveOutput) {
      const head = `  ${GLYPH[status]} [${this.name}] ${name}`;
      if (status === "pass") {
        console.log(`${head}  ${fmtMs(check.ms)}`);
      } else {
        console.log(`${head}\n      ${message}`);
      }
    }
  }

  pass(name: string, detail?: string): void {
    this.record(name, "pass", detail ?? "");
  }

  fail(name: string, message: string): void {
    this.record(name, "fail", message);
  }

  skip(name: string, why: string): void {
    this.record(name, "skip", why);
  }

  /** `ok(name, condition, expected, seen)` — the primary assertion. */
  ok(name: string, condition: boolean, expected: string, seen: string): boolean {
    if (condition) {
      this.pass(name, `expected ${expected}; saw ${seen}`);
      return true;
    }
    this.fail(name, `expected ${expected}\n      saw      ${seen}`);
    return false;
  }

  eq<T>(name: string, actual: T, expected: T, context?: string): boolean {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    return this.ok(
      name,
      same,
      `${show(expected)}${context === undefined ? "" : ` (${context})`}`,
      show(actual),
    );
  }

  /** Records an unexpected throw as a failure rather than losing the phase. */
  caught(name: string, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.fail(name, `expected no exception\n      saw      ${e.name}: ${e.message}`);
  }

  note(text: string): void {
    this.notes.push(text);
    if (liveOutput) console.log(`  · [${this.name}] ${text}`);
  }

  get failed(): number {
    return this.checks.filter((c) => c.status === "fail").length;
  }
  get elapsed(): number {
    return Date.now() - this.startedAt;
  }
}

export class Suite {
  readonly phases: Phase[] = [];
  private readonly startedAt = Date.now();

  phase(name: string): Phase {
    const p = new Phase(name);
    this.phases.push(p);
    if (liveOutput) console.log(`\n━━ ${name.toUpperCase()} ━━`);
    return p;
  }

  get checks(): Check[] {
    return this.phases.flatMap((p) => p.checks);
  }

  get failed(): Check[] {
    return this.checks.filter((c) => c.status === "fail");
  }
  get skipped(): Check[] {
    return this.checks.filter((c) => c.status === "skip");
  }
  get passed(): Check[] {
    return this.checks.filter((c) => c.status === "pass");
  }

  report(): number {
    const total = Date.now() - this.startedAt;
    const lines: string[] = [];
    lines.push("");
    lines.push("═".repeat(72));
    lines.push("  E2E ENFORCEMENT HARNESS — RESULT");
    lines.push("═".repeat(72));

    for (const p of this.phases) {
      const f = p.checks.filter((c) => c.status === "fail").length;
      const s = p.checks.filter((c) => c.status === "skip").length;
      const ok = p.checks.filter((c) => c.status === "pass").length;
      const verdict = f > 0 ? "FAIL" : p.aborted !== undefined ? "ABORTED" : "ok";
      lines.push(
        `  ${p.name.padEnd(14)} ${String(ok).padStart(3)} passed  ${String(f).padStart(2)} failed  ` +
          `${String(s).padStart(2)} skipped  ${fmtMs(p.elapsed).padStart(7)}  ${verdict}`,
      );
      if (p.aborted !== undefined) lines.push(`      aborted: ${p.aborted}`);
    }

    const failed = this.failed;
    const skipped = this.skipped;

    if (failed.length > 0) {
      lines.push("");
      lines.push("  FAILED");
      lines.push("  " + "-".repeat(70));
      for (const c of failed) {
        lines.push(`  ✗ [${c.phase}] ${c.name}`);
        for (const l of c.message.split("\n")) lines.push(`      ${l.trim()}`);
      }
    }

    if (skipped.length > 0) {
      lines.push("");
      lines.push("  SKIPPED (and why)");
      lines.push("  " + "-".repeat(70));
      for (const c of skipped) lines.push(`  · [${c.phase}] ${c.name} — ${c.message}`);
    }

    const notes = this.phases.flatMap((p) => p.notes.map((n) => `[${p.name}] ${n}`));
    if (notes.length > 0) {
      lines.push("");
      lines.push("  NOTES");
      lines.push("  " + "-".repeat(70));
      for (const n of notes) lines.push(`  · ${n}`);
    }

    lines.push("");
    lines.push(
      `  ${this.passed.length} passed   ${failed.length} failed   ${skipped.length} skipped` +
        `   in ${fmtMs(total)}`,
    );
    lines.push(failed.length === 0 ? "  RESULT: PASS" : "  RESULT: FAIL");
    lines.push("═".repeat(72));
    console.log(lines.join("\n"));
    return failed.length === 0 ? 0 : 1;
  }
}

/** Rejects with a named timeout rather than hanging the suite forever. */
export function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not finish within ${fmtMs(ms)}`));
    }, ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Polls `probe` until it returns a value, or throws with the last seen state. */
export async function until<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      const tail =
        lastErr === undefined ? "" : ` (last error: ${show(lastErr, 200)})`;
      throw new Error(`${label} was still not true after ${fmtMs(timeoutMs)}${tail}`);
    }
    await sleep(intervalMs);
  }
}
