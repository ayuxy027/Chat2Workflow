/**
 * An UNBUFFERED SSE reader, over a raw TCP socket.
 *
 * This is not gold-plating. Measuring whether planned nodes CASCADE or arrive
 * as one BATCH is a timing measurement, and every convenient client lies about
 * it in the same direction:
 *
 *   - Python's `urllib` buffers the response body, so a 6-second cascade
 *     arrives as one read and looks exactly like a batch.
 *   - `fetch()` in Node/Bun is better but still hands you decoded chunks
 *     through a WHATWG stream with its own queuing; and any intermediary or
 *     compression layer can coalesce.
 *
 * So: open the socket, write the request line by hand, decode
 * `Transfer-Encoding: chunked` ourselves, and stamp `Date.now()` at the moment
 * the bytes land in `socket.on("data")`. There is nothing between the network
 * and the timestamp. `curl -N` is the shell equivalent and would do; this is
 * the same measurement without shelling out per event.
 */

import net from "node:net";

export interface SseFrame {
  /** ms since epoch, taken when the bytes carrying this frame arrived. */
  at: number;
  /** Named event type, or undefined for a default `data:`-only frame. */
  event?: string;
  /** Concatenated `data:` lines. */
  data: string;
  /** Parsed `data`, when it is JSON. */
  json?: unknown;
  /** Comment frames (`: ping`) are surfaced too — they prove liveness. */
  comment?: string;
}

export interface SseStream {
  frames: SseFrame[];
  /** Resolves when the socket closes. */
  closed: Promise<void>;
  close(): void;
  /** ms since epoch when the first response byte arrived. */
  firstByteAt(): number | undefined;
  /** Waits for a frame matching `pred`, or throws on timeout. */
  waitFor(label: string, pred: (f: SseFrame) => boolean, timeoutMs: number): Promise<SseFrame>;
}

export function openSse(opts: {
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  onFrame?: (f: SseFrame) => void;
}): Promise<SseStream> {
  return new Promise<SseStream>((resolve, reject) => {
    const frames: SseFrame[] = [];
    const waiters: { pred: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }[] = [];
    let firstByte: number | undefined;
    let headersDone = false;
    let chunked = false;
    let status = 0;
    let statusLine = "";
    let pending = Buffer.alloc(0);
    let bodyText = "";
    let settled = false;

    const socket = net.connect({ host: opts.host, port: opts.port });
    socket.setNoDelay(true);

    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((r) => {
      resolveClosed = r;
    });

    const stream: SseStream = {
      frames,
      closed,
      close: () => {
        socket.destroy();
      },
      firstByteAt: () => firstByte,
      waitFor(label, pred, timeoutMs) {
        const hit = frames.find(pred);
        if (hit !== undefined) return Promise.resolve(hit);
        return new Promise<SseFrame>((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.resolve === wrapped);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(
              new Error(
                `SSE: ${label} never arrived within ${timeoutMs}ms. ` +
                  `Saw ${frames.length} frame(s): ` +
                  frames
                    .slice(0, 12)
                    .map((f) => f.event ?? (f.comment !== undefined ? `:${f.comment}` : "data"))
                    .join(", "),
              ),
            );
          }, timeoutMs);
          const wrapped = (f: SseFrame): void => {
            clearTimeout(timer);
            res(f);
          };
          waiters.push({ pred, resolve: wrapped });
        });
      },
    };

    const emit = (frame: SseFrame): void => {
      frames.push(frame);
      opts.onFrame?.(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w !== undefined && w.pred(frame)) {
          waiters.splice(i, 1);
          w.resolve(frame);
        }
      }
    };

    /** Splits accumulated body text into complete SSE frames. */
    const drainFrames = (at: number): void => {
      for (;;) {
        const idx = bodyText.search(/\r?\n\r?\n/);
        if (idx === -1) break;
        const match = /\r?\n\r?\n/.exec(bodyText.slice(idx));
        const sepLen = match === null ? 2 : match[0].length;
        const block = bodyText.slice(0, idx);
        bodyText = bodyText.slice(idx + sepLen);
        if (block.trim() === "") continue;

        let event: string | undefined;
        const dataLines: string[] = [];
        let comment: string | undefined;
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(":")) {
            comment = line.slice(1).trim();
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
          // `retry:` and `id:` are protocol noise for our purposes.
        }
        const data = dataLines.join("\n");
        let json: unknown;
        if (data !== "") {
          try {
            json = JSON.parse(data) as unknown;
          } catch {
            /* not JSON — the raw text is still reported */
          }
        }
        emit({ at, event, data, json, comment });
      }
    };

    /** Incremental `Transfer-Encoding: chunked` decoder. */
    const decodeChunked = (): string => {
      let out = "";
      for (;;) {
        const nl = pending.indexOf("\r\n");
        if (nl === -1) break;
        const sizeLine = pending.subarray(0, nl).toString("ascii").split(";")[0] ?? "";
        const size = Number.parseInt(sizeLine.trim(), 16);
        if (!Number.isFinite(size)) break;
        if (size === 0) {
          pending = Buffer.alloc(0);
          break;
        }
        if (pending.length < nl + 2 + size + 2) break;
        out += pending.subarray(nl + 2, nl + 2 + size).toString("utf8");
        pending = pending.subarray(nl + 2 + size + 2);
      }
      return out;
    };

    socket.on("connect", () => {
      const headers = {
        Host: `${opts.host}:${opts.port}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        // No compression, no keep-alive games: nothing may coalesce our frames.
        "Accept-Encoding": "identity",
        Connection: "keep-alive",
        ...opts.headers,
      };
      const req =
        `GET ${opts.path} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
      socket.write(req);
    });

    socket.on("data", (buf: Buffer) => {
      const at = Date.now();
      if (firstByte === undefined) firstByte = at;
      pending = Buffer.concat([pending, buf]);

      if (!headersDone) {
        const sep = pending.indexOf("\r\n\r\n");
        if (sep === -1) return;
        const head = pending.subarray(0, sep).toString("utf8");
        pending = pending.subarray(sep + 4);
        headersDone = true;
        const lines = head.split("\r\n");
        statusLine = lines[0] ?? "";
        status = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
        chunked = /transfer-encoding:\s*chunked/i.test(head);

        if (status !== 200) {
          settled = true;
          reject(
            new Error(
              `SSE ${opts.path}: expected HTTP 200 text/event-stream, saw "${statusLine}"\n` +
                `      headers: ${head.replace(/\r?\n/g, " | ")}\n` +
                `      body: ${pending.toString("utf8").slice(0, 400)}`,
            ),
          );
          socket.destroy();
          return;
        }
        if (!settled) {
          settled = true;
          resolve(stream);
        }
      }

      bodyText += chunked ? decodeChunked() : (() => {
        const s = pending.toString("utf8");
        pending = Buffer.alloc(0);
        return s;
      })();
      drainFrames(at);
    });

    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSE ${opts.path}: socket error — ${err.message}`));
      }
      resolveClosed();
    });
    socket.on("close", () => {
      resolveClosed();
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`SSE ${opts.path}: no response headers within 15s`));
      }
    }, 15_000).unref?.();
  });
}

/** A `data:`-only frame carrying a GraphEvent. */
export interface GraphEventFrame extends SseFrame {
  json: { seq: number; t: string; [k: string]: unknown };
}

export function isGraphEvent(f: SseFrame): f is GraphEventFrame {
  return (
    f.event === undefined &&
    typeof f.json === "object" &&
    f.json !== null &&
    typeof (f.json as { t?: unknown }).t === "string"
  );
}

export function eventType(f: SseFrame): string | undefined {
  return isGraphEvent(f) ? f.json.t : undefined;
}
