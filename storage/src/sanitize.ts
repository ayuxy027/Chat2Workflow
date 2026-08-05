import { createHash } from "node:crypto";
import path from "node:path";

import { BlobRef } from "@wf/shared";

import { InvalidBlobIdError } from "./errors";
import type { BlobMeta } from "./types";

/**
 * Input hardening, shared by every driver.
 *
 * This all used to live in the web app's copy of the store and nowhere in the
 * worker's, which is how the two drifted: the worker cast metadata on read
 * instead of validating it, and never sanitised a filename. Both apps now go
 * through this module, so there is exactly one answer to "what is a legal blob
 * id" and "what is a safe filename".
 */

/** The only shape a blob id may take. Anything else never reaches a driver. */
export const SHA256_RE = /^[a-f0-9]{64}$/;

export function isSha256(value: string): boolean {
  return SHA256_RE.test(value);
}

/**
 * The path/key-traversal boundary.
 *
 * Checking against lowercase hex before the id is concatenated onto a path or
 * an object key already makes `..`, `/`, `\`, and NUL unrepresentable. The
 * filesystem driver re-checks the resolved path afterwards; this store holds
 * privileged client documents and deserves two locks on the same door.
 */
export function assertSha256(sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new InvalidBlobIdError();
  return sha256;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * `text/html` uploaded and echoed back with its own Content-Type is stored XSS,
 * so unrecognisable media types collapse to octet-stream. Parameters are
 * dropped: nothing downstream needs them and they widen the header surface.
 */
const MIME_RE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;

export function sanitizeMime(input: string): string {
  const base = input.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_RE.test(base) ? base : "application/octet-stream";
}

/**
 * Filenames arrive from a browser file picker and end up in a
 * `Content-Disposition` header, so strip directory components (both
 * separators — a Windows client sends backslashes), control characters, and
 * quotes. Written as a code-point filter rather than a regex so the control
 * range stays readable.
 */
export function sanitizeFilename(input: string): string {
  const flattened = input.replace(/\\/g, "/");
  const base = Array.from(path.posix.basename(flattened))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f && ch !== '"';
    })
    .join("")
    .trim();

  if (base === "" || base === "." || base === "..") return "upload.bin";
  return base.slice(0, 255);
}

/** A `Buffer` view over the caller's bytes, without copying when avoidable. */
export function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The reference for these exact bytes. Every driver builds its ref here, so
 * "same bytes, same object" holds across drivers as well as within one.
 */
export function buildRef(buffer: Buffer, meta: BlobMeta): BlobRef {
  return BlobRef.parse({
    sha256: sha256Of(buffer),
    mime: sanitizeMime(meta.mime),
    bytes: buffer.byteLength,
    filename: sanitizeFilename(meta.filename),
    ...(meta.pages === undefined ? {} : { pages: meta.pages }),
  });
}

/**
 * Parses a stored sidecar. VALIDATED, not cast — the worker's old copy of this
 * did `JSON.parse(raw) as BlobRef`, which hands a caller an object whose
 * `filename` and `mime` are whatever is on disk. Those two fields go straight
 * into a `Content-Disposition` and a `Content-Type` header.
 */
export function parseMeta(raw: string): BlobRef | undefined {
  try {
    const parsed = BlobRef.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Object key / filename for a blob's bytes and for its metadata sidecar. */
export function keysFor(sha256: string): { bytes: string; meta: string } {
  const id = assertSha256(sha256);
  return { bytes: id, meta: `${id}.json` };
}
