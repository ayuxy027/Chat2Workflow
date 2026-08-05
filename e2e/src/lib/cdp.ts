/**
 * A minimal headless-Chrome driver over the DevTools Protocol.
 *
 * This is the check that would have caught the wrong-JSON-key bug: the API was
 * green, the SSE stream was green, the build was green, and the canvas was
 * empty with zero console errors because the client read `body.nodes` from a
 * body shaped `{ graph: { nodes } }`. Nothing short of loading the page and
 * counting rendered nodes sees that.
 *
 * No Playwright/Puppeteer dependency — the browser binary is already on disk
 * and CDP over a WebSocket is a hundred lines.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { freePort, onTeardown } from "./proc";
import { sleep, until } from "./report";

export const CHROME =
  `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1228/` +
  `chrome-headless-shell-mac-arm64/chrome-headless-shell`;

export interface PageError {
  kind: "console.error" | "exception" | "request.failed";
  text: string;
}

export interface Browser {
  /** Evaluates an expression in the page and returns its value. */
  eval<T = unknown>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  errors: PageError[];
  /** Non-fatal diagnostics: console.warn, failed subresources, log entries. */
  warnings: string[];
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}

export async function launchBrowser(startUrl: string): Promise<Browser> {
  const port = await freePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "wf-e2e-chrome-"));

  const child: ChildProcess = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--window-size=1440,900",
      startUrl,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => {
    stderr += String(b);
  });

  const cleanup = async (): Promise<void> => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  };
  onTeardown(cleanup);

  // Wait for the debugging endpoint, then for a page target to exist.
  const wsUrl = await until(
    `chrome-headless-shell to expose a page target on :${port}`,
    20_000,
    200,
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => undefined);
      if (res === undefined || !res.ok) return undefined;
      const targets = (await res.json()) as { type: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl !== undefined);
      return page?.webSocketDebuggerUrl;
    },
  ).catch(async (err: Error) => {
    await cleanup();
    throw new Error(`${err.message}\n      chrome stderr: ${stderr.slice(-500)}`);
  });

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP websocket did not open within 10s")), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP websocket errored while connecting"));
    };
  });

  let nextId = 0;
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const errors: PageError[] = [];
  const warnings: string[] = [];

  const argText = (args: { value?: unknown; description?: string }[] | undefined): string =>
    (args ?? [])
      .map((a) => (a.value === undefined ? (a.description ?? "") : String(a.value)))
      .join(" ")
      .trim();

  ws.onmessage = (ev: MessageEvent) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = m["id"];
    if (typeof id === "number" && pending.has(id)) {
      pending.get(id)?.(m);
      pending.delete(id);
      return;
    }
    const method = m["method"];
    const params = (m["params"] ?? {}) as Record<string, unknown>;

    if (method === "Runtime.consoleAPICalled") {
      const type = params["type"];
      const text = argText(params["args"] as { value?: unknown; description?: string }[]);
      if (type === "error") errors.push({ kind: "console.error", text });
      else if (type === "warning") warnings.push(`console.warn: ${text}`);
    } else if (method === "Runtime.exceptionThrown") {
      const d = (params["exceptionDetails"] ?? {}) as Record<string, unknown>;
      const exc = (d["exception"] ?? {}) as Record<string, unknown>;
      errors.push({
        kind: "exception",
        text: String(exc["description"] ?? d["text"] ?? "uncaught exception"),
      });
    } else if (method === "Log.entryAdded") {
      const e = (params["entry"] ?? {}) as Record<string, unknown>;
      const line = `${String(e["source"])}/${String(e["level"])}: ${String(e["text"])}`;
      // Network noise (a missing favicon) is a warning, not a page error.
      if (e["level"] === "error" && e["source"] !== "network") {
        errors.push({ kind: "console.error", text: line });
      } else if (e["level"] === "error") {
        warnings.push(line);
      }
    }
  };

  const send = <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} did not answer within 30s`));
      }, 30_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        const err = m["error"] as { message?: string } | undefined;
        if (err !== undefined) {
          reject(new Error(`CDP ${method} failed: ${err.message ?? JSON.stringify(err)}`));
          return;
        }
        resolve(m["result"] as T);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");

  const browser: Browser = {
    errors,
    warnings,
    async navigate(url) {
      await send("Page.navigate", { url });
    },
    async eval<T>(expression: string): Promise<T> {
      const r = await send<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails !== undefined) {
        throw new Error(
          `page evaluate threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "unknown"}`,
        );
      }
      return r.result?.value as T;
    },
    async screenshot(file) {
      const r = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(r.data, "base64"));
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      await cleanup();
      await sleep(50);
    },
  };

  return browser;
}
