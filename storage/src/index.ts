import type { BlobRef } from "@wf/shared";

import { describeConfig, readBlobStoreConfig, type BlobStoreConfig } from "./config";
import { createFilesystemStore } from "./filesystem";
import { createS3Store } from "./s3";
import type { BlobMeta, BlobStore, BlobStoreDriver } from "./types";

/**
 * THE content-addressed document store. One interface, two drivers, chosen by
 * environment.
 *
 * There used to be two independent implementations of this — one in the web app
 * and one in the worker, both `node:fs` against a shared `BLOB_DIR` — and they
 * had already drifted: different sidecar-write policies, different file modes,
 * one sanitised filenames and one did not, one validated metadata on read and
 * one cast it. They also cannot work at all once the two processes are on
 * different hosts, which is the shape of the deployment (Vercel + Render).
 *
 * Documents never ride inside Temporal payloads (2MB limit; a 200-page PDF
 * blows straight through it). The graph, the workflow, and every activity pass
 * a `BlobRef` — metadata only — and read the bytes from here directly. Content
 * addressing gives dedup and immutability for free, and immutability is what
 * makes the audit trail meaningful: a `BlobRef` in a six-month-old workflow
 * history still names the exact bytes that were processed.
 *
 * Usage is the same in both apps:
 *
 *     import { put, get, stat, exists } from "@wf/storage";
 *
 * The store is built on FIRST USE, never at import time — `next build`
 * evaluates route modules with an empty environment, and a missing variable
 * must fail the one endpoint that needs it, not the build.
 */

export { BlobNotFoundError, BlobStoreConfigError, InvalidBlobIdError } from "./errors";
export {
  SHA256_RE,
  isSha256,
  sanitizeFilename,
  sanitizeMime,
  sha256Of,
} from "./sanitize";
export type { BlobMeta, BlobStore, BlobStoreDriver } from "./types";
export type { BlobStoreConfig } from "./config";
export { readBlobStoreConfig } from "./config";
export { createFilesystemStore } from "./filesystem";
export { createS3Store } from "./s3";

/** Builds a store from an explicit configuration. Reads no environment. */
export function createBlobStore(config: BlobStoreConfig): BlobStore {
  return config.driver === "filesystem"
    ? createFilesystemStore(config.dir)
    : createS3Store(config);
}

let cached: BlobStore | undefined;

/**
 * The process-wide store, built on first use.
 *
 * A configuration failure is thrown on every call rather than retried — the
 * environment does not change under a running process — and is never degraded
 * into a fallback. See `readBlobStoreConfig`.
 */
export function blobStore(): BlobStore {
  if (cached === undefined) cached = createBlobStore(readBlobStoreConfig());
  return cached;
}

/**
 * Which driver, and where it points. Safe to log: no credential appears in it.
 * The worker prints this at boot so "where did that document go?" is answerable
 * from the log rather than by inspecting the environment of a running dyno.
 */
export function describeBlobStore(): { driver: BlobStoreDriver; location: string } {
  const config = readBlobStoreConfig();
  return { driver: config.driver, location: describeConfig(config) };
}

/** Stores bytes and returns their reference. Idempotent on identical bytes. */
export function put(bytes: Uint8Array, meta: BlobMeta): Promise<BlobRef> {
  return blobStore().put(bytes, meta);
}

/** Raw bytes for a blob. Throws `BlobNotFoundError` if it is not in the store. */
export function get(sha256: string): Promise<Buffer> {
  return blobStore().get(sha256);
}

/** Metadata for a blob. Throws `BlobNotFoundError` if it is not in the store. */
export function stat(sha256: string): Promise<BlobRef> {
  return blobStore().stat(sha256);
}

/** Does the store still hold these bytes? */
export function exists(sha256: string): Promise<boolean> {
  return blobStore().exists(sha256);
}
