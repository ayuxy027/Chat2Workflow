import type { BlobRef } from "@wf/shared";

/** Everything a caller may say about bytes it is storing. */
export interface BlobMeta {
  filename: string;
  mime: string;
  pages?: number;
}

export type BlobStoreDriver = "filesystem" | "s3";

/**
 * THE document store interface. One implementation per driver, one interface
 * for both apps.
 *
 * Content addressing is a correctness property here, not an optimisation. A
 * `BlobRef` recorded in a six-month-old workflow history must still name the
 * exact bytes that were processed, so:
 *
 *   - `put` is idempotent and never overwrites an object that already exists;
 *   - metadata is written once, on first store, and never rewritten;
 *   - there is no `delete`, no `move`, and no `update`. Nothing in this
 *     interface can mutate a stored object.
 *
 * OBJECT LAYOUT — identical under both drivers, so the two are conceptually one
 * store and a migration is a copy:
 *
 *     <sha256>        the raw bytes
 *     <sha256>.json   the BlobRef, JSON
 */
export interface BlobStore {
  readonly driver: BlobStoreDriver;
  /** Human-readable location, for the worker's startup log. Carries no secret. */
  readonly location: string;

  /** Stores bytes and returns their reference. Idempotent on identical bytes. */
  put(bytes: Uint8Array, meta: BlobMeta): Promise<BlobRef>;
  /** Raw bytes. Throws `BlobNotFoundError` if the store does not hold them. */
  get(sha256: string): Promise<Buffer>;
  /** Metadata. Throws `BlobNotFoundError` if the store does not hold it. */
  stat(sha256: string): Promise<BlobRef>;
  /** Does the store hold these bytes? Never throws for a merely absent blob. */
  exists(sha256: string): Promise<boolean>;
}
